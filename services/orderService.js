/**
 * orderService.js
 *
 * CHANGE: waitForOrderFill now uses waitForOrderConfirmation() from fyersLiveData.js
 * which listens on the Fyers order WebSocket for instant push-based confirmation.
 * Falls back to REST polling only if the socket push times out (30s).
 */

import { fyers } from "../config/fyersConfig.js";
import { sendTrafficAlert } from "../services/telegramService.js";
import { waitForOrderConfirmation } from "../services/fyersLiveData.js";

// ─────────────────────────────────────────────────────────────────────────────
// PLACE ORDER — unchanged
// ─────────────────────────────────────────────────────────────────────────────
export const placeOrder = async ({ symbol, qty, side }) => {
  const sideLabel = side === 1 ? "BUY" : "SELL";
  const isLive = process.env.LIVE_TRADING === "true";

  if (!isLive) {
    const paperId = `PAPER-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    console.log(`📝 [PAPER] ${sideLabel} ${qty} ${symbol} → id=${paperId}`);
    return { s: "ok", id: paperId };
  }

  try {
    const response = await fyers.place_order({
      symbol,
      qty:         Math.floor(qty),
      type:        2,
      side,
      productType: "INTRADAY",
      limitPrice:  0,
      stopPrice:   0,
      validity:    "DAY",
    });

    if (response.s === "ok") {
      console.log(`✅ Order Placed: ${response.id}`);
      await sendTrafficAlert(
        `✅ <b>Order Placed</b>\nSide: ${sideLabel}\nSymbol: ${symbol}\nQty: ${Math.floor(qty)}\nOrder ID: ${response.id}`
      );
    } else {
      console.error(`❌ Order Rejected: ${response.message}`);
      await sendTrafficAlert(
        `🚨 <b>Order Rejected</b>\nSide: ${sideLabel}\nSymbol: ${symbol}\nReason: ${response.message}\n⚠️ Check Fyers manually`
      );
      throw new Error(response.message);
    }

    response.id = String(response.id);
    return response;

  } catch (err) {
    console.error("❌ Execution API Error:", err.message);
    await sendTrafficAlert(
      `🚨 <b>Order Execution Failed</b>\nSide: ${sideLabel}\nSymbol: ${symbol}\nError: ${err.message}\n⚠️ Check position immediately`
    );
    throw err;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// WAIT FOR ORDER FILL
//
// PRIMARY: Fyers order socket pushes fill/reject instantly → resolves promise
// FALLBACK: If socket push doesn't arrive in 30s → REST poll as safety net
// ─────────────────────────────────────────────────────────────────────────────
// waitForOrderFill(orderId, paperPrice)
// paperPrice — used only in paper mode to simulate a fill price
// Socket confirmation has its own 30s timeout internally (fyersLiveData.js)
export const waitForOrderFill = async (orderId, paperPrice = 0) => {
  const isLive = process.env.LIVE_TRADING === "true";

  if (!isLive || !orderId || String(orderId).startsWith("PAPER-")) {
    await new Promise(r => setTimeout(r, 200));
    console.log(`📝 [PAPER] Order ${orderId} simulated fill @ ${paperPrice}`);
    return { filled: true, avgPrice: paperPrice };
  }

  const orderIdStr = String(orderId);

  try {
    // PRIMARY: wait for Fyers postback or order socket — whichever arrives first
    // 60s timeout → falls back to REST poll below
    const result = await waitForOrderConfirmation(orderIdStr, 60000);
    return result;

  } catch (confirmErr) {
    // Both postback and socket silent for 60s — fall back to REST poll
    console.warn(`⚠️ No postback/socket confirmation for ${orderIdStr}: ${confirmErr.message}`);
    console.warn(`⚠️ Falling back to REST poll...`);
    await sendTrafficAlert(
      `⚠️ <b>Order confirmation delayed</b>\nOrder ID: ${orderIdStr}\n${confirmErr.message}\nFalling back to REST poll...`
    );

    return await restPoll(orderIdStr, 2000);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// REST FALLBACK — only runs if socket push never arrived
// Polls get_order_history 20 times × 2s = up to 40s
// Throws if still no answer — manual intervention required
// ─────────────────────────────────────────────────────────────────────────────
async function restPoll(orderId, intervalMs = 2000) {
  const MAX_ATTEMPTS = 20;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      const response = await fyers.get_order_history({ id: orderId });

      if (response.s === "ok" && response.orderBook?.length) {
        const order  = response.orderBook[0];
        const status = order.status;

        if (status === 2) {
          const avgPrice = order.tradedPrice || 0;
          console.log(`✅ [REST fallback] Order ${orderId} FILLED | avgPrice=${avgPrice} (attempt ${attempt})`);
          await sendTrafficAlert(
            `✅ <b>Order confirmed via REST</b>\nOrder ID: ${orderId}\nAvg Price: ${avgPrice}\n(attempt ${attempt}/${MAX_ATTEMPTS})`
          );
          return { filled: true, avgPrice };
        }

        if (status === 5 || status === 1) {
          throw new Error(`Order ${orderId} rejected/cancelled by broker (status=${status})`);
        }

        console.warn(`⚠️ [REST fallback] attempt ${attempt}/${MAX_ATTEMPTS}: status=${status}`);
      }
    } catch (err) {
      if (err.message.includes("rejected/cancelled by broker")) throw err;
      console.warn(`⚠️ [REST fallback] attempt ${attempt}/${MAX_ATTEMPTS} error: ${err.message}`);
    }
  }

  // Both socket and REST failed — hard stop, alert, manual intervention
  await sendTrafficAlert(
    `🚨 <b>Order UNCONFIRMED after all attempts</b>\n` +
    `Order ID: ${orderId}\n` +
    `⚠️ Socket + REST both gave no answer\n` +
    `Check Fyers app manually — do NOT let bot trade again today`
  );
  throw new Error(`Order ${orderId}: Unconfirmed after socket timeout + ${MAX_ATTEMPTS} REST attempts. Manual check required.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET REALIZED PNL — unchanged
// ─────────────────────────────────────────────────────────────────────────────
export const getRealizedPnL = async (symbol) => {
  const isLive = process.env.LIVE_TRADING === "true";
  if (!isLive) return null;

  try {
    const response = await fyers.get_positions();
    if (response.s !== "ok") {
      console.error(`❌ Fyers get_positions failed: ${response.message}`);
      return null;
    }
    const position = (response.netPositions || []).find(p => p.symbol === symbol);
    if (!position) {
      console.warn(`⚠️ No position found for: ${symbol}`);
      return null;
    }
    console.log(`📊 Fyers Position → ${symbol} | Buy: ${position.buyAvg} | Sell: ${position.sellAvg} | PnL: ${position.realized_profit}`);
    return {
      realizedPnL: position.realized_profit,
      buyAvg:      position.buyAvg,
      sellAvg:     position.sellAvg,
      netQty:      position.netQty,
    };
  } catch (err) {
    console.error(`❌ getRealizedPnL Error: ${err.message}`);
    return null;
  }
};