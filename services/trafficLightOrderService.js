import { fyers } from "../config/fyersConfig.js";
import { sendTrafficAlert } from "../services/telegramService.js";

export const placeOrder = async ({ symbol, qty, side }) => {
  const sideLabel = side === 1 ? "BUY" : "SELL";
  const isLive = process.env.LIVE_TRADING === "true";

  if (!isLive) {
    console.log(`\n📝 [PAPER] ${sideLabel} ${qty} ${symbol}`);
    return { s: "ok", id: null };
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

    return response; // response.id is the Fyers order ID

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
 * Returns true if filled, false if timed out or failed.
 *
 * @param {string} orderId   - Fyers order ID returned by placeOrder
 * @param {number} maxWaitMs - Max time to wait in ms (default: 10 seconds)
 * @param {number} intervalMs - Poll interval in ms (default: 500ms)
 */
// Polls Fyers until order is FILLED or REJECTED — returns { filled, avgPrice }
// filled=true only when Fyers confirms status=2 (fully filled)
// avgPrice = actual tradedPrice from Fyers — used to save real entry/exit price to DB
// If rejected, cancelled, or timeout — throws so caller stops immediately
export const waitForOrderFill = async (orderId, maxWaitMs = 10000, intervalMs = 500) => {
  if (!orderId) return { filled: false, avgPrice: 0 }; // Paper mode

  const isLive = process.env.LIVE_TRADING === "true";
  if (!isLive) return { filled: false, avgPrice: 0 };

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
          throw new Error(`Order ${orderId} rejected/cancelled (status=${status})`);
        }
      }
    } catch (err) {
      throw new Error(`Order confirm failed: ${err.message}`);
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