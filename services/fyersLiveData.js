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

// ─── Order confirmation ───────────────────────────────────────────────────────
// RACE CONDITION FIX:
// Fyers order socket push can arrive BEFORE placeOrder() returns the order_id.
// Solution: buffer ALL incoming order updates immediately.
// When waitForOrderConfirmation(orderId) is called after placeOrder():
//   - Check buffer first — if update already arrived, resolve immediately
//   - If not in buffer yet — register listener and wait for it
//
// After April 1 (Fyers removes webhook from new app):
//   Only Fyers Order Socket feeds the buffer — still race-condition safe.
//   REST fallback remains as final safety net.
//
// Hard timeout 60s → falls back to REST poll in orderService.js
// ─────────────────────────────────────────────────────────────────────────────

// Early arrival buffer: orderId → { isFilled, isRejected, avgPrice, timestamp }
const _earlyBuffer  = new Map();
const BUFFER_TTL_MS = 120_000; // 2 minutes

// Pending listeners: orderId → { resolve, reject, timer }
const _pendingOrders = new Map();

// ─── Internal: process any incoming order update ──────────────────────────────
function _resolveOrder(order, source) {
  // Fyers uses numeric status: 2=Filled, 5=Rejected, 1=Cancelled
  const id       = String(order?.id ?? order?.orderId ?? order?.order_id ?? "");
  const status   = order?.status;
  const avgPrice = order?.tradedPrice ?? order?.avgPrice ?? order?.traded_price ?? 0;

  if (!id) return;

  const isFilled   = status === 2 || status === "2";
  const isRejected = status === 5 || status === 1 || status === "5" || status === "1";

  if (!isFilled && !isRejected) return; // non-terminal — Fyers will push again

  console.log(`📬 [${source}] order_id=${id} status=${status} avgPrice=${avgPrice}`);

  // ── If listener already waiting — resolve immediately ─────────────────────
  if (_pendingOrders.has(id)) {
    const { resolve, reject, timer } = _pendingOrders.get(id);
    clearTimeout(timer);
    _pendingOrders.delete(id);

    if (isFilled) {
      console.log(`✅ [${source}] Order ${id} FILLED | avgPrice=${avgPrice}`);
      resolve({ filled: true, avgPrice });
    } else {
      console.error(`❌ [${source}] Order ${id} REJECTED/CANCELLED (status=${status})`);
      reject(new Error(`Order ${id} rejected/cancelled by broker (status=${status})`));
    }
    return;
  }

  // ── Listener not registered yet — buffer the update ───────────────────────
  _earlyBuffer.set(id, { isFilled, isRejected, avgPrice, status, timestamp: Date.now() });
  setTimeout(() => _earlyBuffer.delete(id), BUFFER_TTL_MS);
}

// ─── PUBLIC: called by trafic-light server.js postback route ─────────────────
// Only active until April 1 (old Fyers app webhook).
// After April 1 — only order socket feeds the buffer.
export const resolveOrderFromPostback = (order) => {
  _resolveOrder(order, "Postback");
};

// ─── PUBLIC: called by orderService.js ───────────────────────────────────────
// Checks buffer first — if update arrived during placeOrder() gap, resolves immediately.
// Hard timeout 60s → falls back to REST poll in orderService.js
export const waitForOrderConfirmation = (orderId, timeoutMs = 60000) => {
  return new Promise((resolve, reject) => {
    const id = String(orderId);

    // ── Check early arrival buffer first ─────────────────────────────────────
    if (_earlyBuffer.has(id)) {
      const buffered = _earlyBuffer.get(id);
      _earlyBuffer.delete(id);

      if (buffered.isFilled) {
        console.log(`✅ [Buffer] Order ${id} already FILLED | avgPrice=${buffered.avgPrice}`);
        resolve({ filled: true, avgPrice: buffered.avgPrice });
      } else {
        console.error(`❌ [Buffer] Order ${id} already REJECTED (status=${buffered.status})`);
        reject(new Error(`Order ${id} rejected/cancelled by broker (status=${buffered.status})`));
      }
      return;
    }

    // ── Not in buffer — register listener for future push ────────────────────
    const timer = setTimeout(() => {
      _pendingOrders.delete(id);
      reject(new Error(`Order ${id}: No confirmation from Fyers in ${timeoutMs / 1000}s (socket silent)`));
    }, timeoutMs);

    _pendingOrders.set(id, { resolve, reject, timer });
  });
};

// ─── INTERNAL: called when Fyers pushes an order update on the socket ─────────
function handleOrderUpdate(msg) {
  const orders = Array.isArray(msg) ? msg : [msg];
  for (const order of orders) {
    _resolveOrder(order, "OrderSocket");
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