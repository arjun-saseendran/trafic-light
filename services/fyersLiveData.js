/**
 * fyersLiveData.js
 *
 * Two Fyers sockets initialized together:
 *
 *  1. fyersDataSocket  — NIFTY spot price ticks → Traffic Light engine (unchanged)
 *  2. fyersOrderSocket — Order/trade push updates → resolves waitForOrderFill() instantly
 *
 * WHY TWO SOCKETS:
 *   Fyers fyersDataSocket (market data) and fyersOrderSocket (order updates) are
 *   separate WebSocket connections by design — they cannot be merged into one.
 *   But we initialize both here so the whole Fyers connection lifecycle lives
 *   in one place, and orderService.js never needs to know about sockets at all.
 */

import { fyersDataSocket, fyersOrderSocket } from "fyers-api-v3";
import { getIO } from "../config/socket.js";
import { CandleBuilder } from "../services/candleBuilderTraficLight.js";
import { handleNewCandle, handleTick } from "../Engines/traficLightEngine.js";
import { sendTelegramAlert as sendTrafficAlert } from "../services/telegramService.js";

const NIFTY_SPOT         = "NSE:NIFTY50-INDEX";
const niftyCandleBuilder = new CandleBuilder(3);

// Pending order confirmations: Map of orderId → { resolve, reject, timer }
const _pendingOrders = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: called by orderService.js — waits for Fyers to push a fill/rejection
// ─────────────────────────────────────────────────────────────────────────────
export const waitForOrderConfirmation = (orderId, timeoutMs = 30000) => {
  return new Promise((resolve, reject) => {
    const id = String(orderId);

    const timer = setTimeout(() => {
      _pendingOrders.delete(id);
      reject(new Error(`Order ${id}: No confirmation from Fyers order socket in ${timeoutMs / 1000}s`));
    }, timeoutMs);

    _pendingOrders.set(id, { resolve, reject, timer });
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: called when Fyers pushes an order update on the socket
// ─────────────────────────────────────────────────────────────────────────────
function handleOrderUpdate(msg) {
  // Fyers sends either a single object or an array
  const orders = Array.isArray(msg) ? msg : [msg];

  for (const order of orders) {
    const id     = String(order?.id ?? order?.orderId ?? "");
    const status = order?.status; // 2=Filled, 5=Rejected, 1=Cancelled

    if (!id || !_pendingOrders.has(id)) continue;

    const { resolve, reject, timer } = _pendingOrders.get(id);
    clearTimeout(timer);
    _pendingOrders.delete(id);

    if (status === 2) {
      const avgPrice = order?.tradedPrice ?? order?.avgPrice ?? 0;
      console.log(`✅ [OrderSocket] Order ${id} FILLED | avgPrice=${avgPrice}`);
      resolve({ filled: true, avgPrice });
    } else if (status === 5 || status === 1) {
      console.error(`❌ [OrderSocket] Order ${id} REJECTED/CANCELLED (status=${status})`);
      reject(new Error(`Order ${id} rejected/cancelled by broker (status=${status})`));
    }
    // Other statuses (open/pending) — Fyers will push again when final. Do nothing.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INIT — called once from server.js after token is loaded
// ─────────────────────────────────────────────────────────────────────────────
export const initFyersLiveData = async () => {
  const io          = getIO();
  const accessToken = process.env.FYERS_ACCESS_TOKEN;
  const appId       = process.env.FYERS_APP_ID;

  if (!accessToken || !appId) {
    console.error("❌ Fyers Live Data: Missing FYERS_ACCESS_TOKEN or FYERS_APP_ID in .env");
    return;
  }

  const wsAppId = appId.includes("-") ? appId : `${appId}-100`;
  const wsToken = accessToken.includes(":")
    ? accessToken
    : `${wsAppId}:${accessToken}`;

  // ── 1. Market Data Socket (price ticks) ────────────────────────────────────
  console.log("🔌 Connecting Fyers market data socket...");
  const fyersData = fyersDataSocket.getInstance(wsToken, "./logs");
  fyersData.autoreconnect();

  fyersData.on("connect", () => {
    console.log("✅ Fyers Market Data Connected — subscribing NIFTY spot");
    fyersData.subscribe([NIFTY_SPOT], false);
    sendTrafficAlert(`✅ <b>Fyers Feed Connected</b>\nNIFTY spot subscribed — Traffic Light live`);
  });

  fyersData.on("message", async (msg) => {
    const symbol = msg.symbol || msg.n;
    const price  = msg.ltp    || msg.v?.lp;
    if (!symbol || !price) return;

    if (symbol === NIFTY_SPOT) {
      await handleTick(price);
      if (io) io.emit("market_tick", { price, timestamp: Date.now() });

      const finishedCandle = niftyCandleBuilder.build(price, Date.now());
      if (finishedCandle) {
        console.log(`\n📦 New 3-Min Candle: ${finishedCandle.color.toUpperCase()} | Range: ${finishedCandle.range.toFixed(2)}`);
        handleNewCandle(finishedCandle);
      }
    }
  });

  fyersData.on("error", (err) => {
    const msg = err?.message || String(err);
    console.error("❌ Fyers Market Data Error:", msg);
    sendTrafficAlert(`❌ <b>Fyers Feed Error</b>\n<code>${msg}</code>\n⚠️ Auto-reconnecting...`);
  });

  fyersData.on("close", () => {
    console.log("⚠️ Fyers Market Data Closed — auto-reconnecting...");
    sendTrafficAlert(`⚠️ <b>Fyers Feed Disconnected</b>\nAuto-reconnecting...`);
  });

  fyersData.connect();

  // ── 2. Order Socket (order fill confirmations) ─────────────────────────────
  console.log("🔌 Connecting Fyers order socket...");
  const orderSkt = new fyersOrderSocket(wsToken, "./logs", false);

  orderSkt.on("connect", () => {
    console.log("✅ Fyers Order Socket Connected — subscribing order + trade updates");
    orderSkt.subscribe([orderSkt.orderUpdates, orderSkt.tradeUpdates]);
  });

  orderSkt.on("orders", (msg) => {
    console.log("📬 Fyers order update:", JSON.stringify(msg));
    handleOrderUpdate(msg);
  });

  orderSkt.on("trades", (msg) => {
    // Trades also carry fill info — handle as a backup
    console.log("📬 Fyers trade update:", JSON.stringify(msg));
    handleOrderUpdate(msg);
  });

  orderSkt.on("error", (err) => {
    console.error("❌ Fyers Order Socket Error:", err?.message ?? err);
  });

  orderSkt.on("close", () => {
    console.warn("⚠️ Fyers Order Socket Closed — auto-reconnecting...");
  });

  orderSkt.autoreconnect();
  orderSkt.connect();
};