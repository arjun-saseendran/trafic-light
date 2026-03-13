import { fyers } from "../config/fyersConfig.js";
import { sendTrafficAlert } from "../services/telegramService.js";

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
      symbol:      symbol,
      qty:         Math.floor(qty),
      type:        2, // Market order — Fyers applies MPP automatically (no extra param needed)
      side:        side,
      productType: "INTRADAY",
      limitPrice:  0,  // ✅ Required by Fyers API for market orders (confirmed from Fyers docs)
      stopPrice:   0,  // ✅ Required by Fyers API for market orders (confirmed from Fyers docs)
      validity:    "DAY",
    });

    if (response.s === "ok") {
      console.log(`✅ Order Placed: ${response.id}`);
      await sendTrafficAlert(
        `✅ <b>Order Placed</b>\n` +
        `Side: ${sideLabel}\n` +
        `Symbol: ${symbol}\n` +
        `Qty: ${Math.floor(qty)}\n` +
        `Order ID: ${response.id}`
      );
    } else {
      // ✅ FIX: throw on rejection so enterTrade catch block fires and
      // entryInFlight is unlocked — previously returned {s:"error"} silently
      // which left entryInFlight=true forever, blocking all entries for the day
      console.error(`❌ Order Rejected: ${response.message}`);
      await sendTrafficAlert(
        `🚨 <b>Order Rejected</b>\n` +
        `Side: ${sideLabel}\n` +
        `Symbol: ${symbol}\n` +
        `Reason: ${response.message}\n` +
        `⚠️ No retry — check Fyers positions manually`
      );
      throw new Error(response.message);
    }

    // ✅ FIX: Normalize response.id to string.
    // Fyers API returns id as a JSON number (e.g. 26031300100896).
    // waitForOrderFill calls orderId.startsWith("PAPER-") which crashes
    // with TypeError if orderId is a number. String() is safe regardless
    // of whether Fyers already sends a string or a number.
    response.id = String(response.id);
    return response; // response.id is now always a string

  } catch (err) {
    console.error("❌ Execution API Error:", err.message);
    await sendTrafficAlert(
      `🚨 <b>Order Execution Failed</b>\n` +
      `Side: ${sideLabel}\n` +
      `Symbol: ${symbol}\n` +
      `Error: ${err.message}\n` +
      `⚠️ Check position immediately — no retry`
    );
    throw err; // throw so engine stops immediately — no silent failure
  }
};

/**
 * Polls Fyers order status until the order is fully filled (or times out).
 * Returns { filled, avgPrice } when Fyers confirms status=2 (fully filled).
 *
 * ✅ FIX: Transient API errors (network hiccup, rate limit, bad response) now
 * log a warning and continue polling — they do NOT abort the loop.
 * Only a confirmed broker rejection (status 5 or 1) throws immediately.
 * This prevents a single bad poll from falsely declaring an already-filled
 * order as failed (root cause of the 2026-03-13 trade loss).
 *
 * @param {string} orderId   - Fyers order ID returned by placeOrder
 * @param {number} maxWaitMs - Max time to wait in ms (default: 10 seconds)
 * @param {number} intervalMs - Poll interval in ms (default: 500ms)
 */
// Polls Fyers until order is FILLED or REJECTED — returns { filled, avgPrice }
// filled=true only when Fyers confirms status=2 (fully filled)
// avgPrice = actual tradedPrice from Fyers — used to save real entry/exit price to DB
// If rejected/cancelled by broker → throws immediately (hard stop, no retry)
// If transient API error → logs warning, continues polling until deadline
// If timeout → throws so caller stops for the day
export const waitForOrderFill = async (orderId, maxWaitMs = 10000, intervalMs = 500, paperPrice = 0) => {
  const isLive = process.env.LIVE_TRADING === "true";

  // Paper mode — simulate fill with the price passed in (spot or option LTP)
  if (!isLive || !orderId || orderId.startsWith("PAPER-")) {
    // Simulate Fyers confirm latency
    await new Promise(r => setTimeout(r, 200));
    console.log(`📝 [PAPER] Order ${orderId} simulated fill @ ${paperPrice ?? 0}`);
    return { filled: true, avgPrice: paperPrice ?? 0 };
  }

  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    try {
      const response = await fyers.get_order_history({ id: orderId });

      if (response.s === "ok" && response.orderBook?.length) {
        const order  = response.orderBook[0];
        const status = order.status; // 2=Filled, 5=Rejected, 1=Cancelled

        if (status === 2) {
          const avgPrice = order.tradedPrice || 0;
          console.log(`✅ Order ${orderId} filled | avgPrice=${avgPrice}`);
          return { filled: true, avgPrice };
        }

        if (status === 5 || status === 1) {
          // ✅ Confirmed broker rejection — hard stop, no point retrying
          throw new Error(`Order ${orderId} rejected/cancelled by broker (status=${status})`);
        }

        // Any other status (open, pending, transit) — keep polling
        console.log(`⏳ Order ${orderId} status=${status} — polling...`);
      } else {
        // ✅ Non-ok response or empty orderBook — transient API issue, keep polling
        console.warn(`⚠️ Order ${orderId} poll got unexpected response (s=${response?.s}) — retrying...`);
      }

    } catch (err) {
      // ✅ FIX: Only re-throw confirmed broker rejections (our own throw above).
      // All other errors (network timeout, rate limit, SDK exception) are transient —
      // log and keep polling. A single bad API call must NOT abort confirmation.
      if (err.message.includes("rejected/cancelled by broker")) throw err;
      console.warn(`⚠️ Order ${orderId} poll error — retrying: ${err.message}`);
    }

    await new Promise((res) => setTimeout(res, intervalMs));
  }

  throw new Error(`Order ${orderId} did not fill within ${maxWaitMs / 1000}s — timeout`);
};

/**
 * Fetches actual realized PnL from Fyers position data for a given symbol.
 * Returns null if unavailable (paper mode, API failure, position not found).
 */
export const getRealizedPnL = async (symbol) => {
  const isLive = process.env.LIVE_TRADING === "true";

  if (!isLive) {
    console.log(`📝 [PAPER] Skipping position fetch for ${symbol}`);
    return null;
  }

  try {
    const response = await fyers.get_positions();

    if (response.s !== "ok") {
      console.error(`❌ Fyers get_positions failed: ${response.message}`);
      return null;
    }

    const positions = response.netPositions || [];
    const position = positions.find((p) => p.symbol === symbol);

    if (!position) {
      console.warn(`⚠️ No position found for symbol: ${symbol}`);
      return null;
    }

    console.log(
      `📊 Fyers Position Data → Symbol: ${symbol} | Buy Avg: ${position.buyAvg} | Sell Avg: ${position.sellAvg} | Realized PnL: ${position.realized_profit}`
    );

    return {
      realizedPnL:  position.realized_profit,  // Actual broker PnL (premium difference × qty)
      buyAvg:       position.buyAvg,
      sellAvg:      position.sellAvg,
      netQty:       position.netQty,
    };

  } catch (err) {
    console.error(`❌ getRealizedPnL Error: ${err.message}`);
    return null;
  }
};