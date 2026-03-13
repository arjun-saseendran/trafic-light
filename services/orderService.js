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

// Polls Fyers until order is FILLED or REJECTED — returns { filled, avgPrice }
// filled=true only when Fyers confirms status=2 (fully filled)
// avgPrice = actual tradedPrice from Fyers — used to save real entry/exit price to DB
//
// Phase 1 — fast poll: every 500ms for up to maxWaitMs (default 10s)
//   Covers normal fills. Transient errors warn and retry — never abort.
//   Only a confirmed broker rejection (status 5 or 1) throws immediately.
//
// Phase 2 — background retry: every 2s indefinitely
//   Order was placed on Fyers but fill not confirmed in time (slow API / volatile open).
//   We MUST keep polling — throwing would abandon a potentially filled order.
//   Caller is blocked on this promise — no second order can fire.
//   Telegram alert fires once on entry to Phase 2.
//
// @param {string} orderId    - Fyers order ID returned by placeOrder
// @param {number} maxWaitMs  - Phase 1 window in ms (default: 10 seconds)
// @param {number} intervalMs - Phase 1 poll interval in ms (default: 500ms)
export const waitForOrderFill = async (orderId, maxWaitMs = 10000, intervalMs = 500, paperPrice = 0) => {
  const isLive = process.env.LIVE_TRADING === "true";

  // Paper mode — simulate fill with the price passed in (spot or option LTP)
  if (!isLive || !orderId || orderId.startsWith("PAPER-")) {
    await new Promise(r => setTimeout(r, 200));
    console.log(`📝 [PAPER] Order ${orderId} simulated fill @ ${paperPrice ?? 0}`);
    return { filled: true, avgPrice: paperPrice ?? 0 };
  }

  // ── Phase 1: Fast polling ─────────────────────────────────────────────────
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
          // Confirmed broker rejection — hard stop, no retry
          throw new Error(`Order ${orderId} rejected/cancelled by broker (status=${status})`);
        }

        // Any other status (open, pending, transit) — keep polling
        console.log(`⏳ Order ${orderId} status=${status} — polling...`);
      } else {
        // Non-ok response or empty orderBook — transient API issue, keep polling
        console.warn(`⚠️ Order ${orderId} poll got unexpected response (s=${response?.s}) — retrying...`);
      }

    } catch (err) {
      // Only re-throw confirmed broker rejections (our own throw above).
      // All other errors (network timeout, rate limit, SDK exception) are transient —
      // log and keep polling.
      if (err.message.includes("rejected/cancelled by broker")) throw err;
      console.warn(`⚠️ Order ${orderId} poll error — retrying: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, intervalMs));
  }

  // ── Phase 2: Background retry — indefinite ───────────────────────────────
  // Order was placed on Fyers but fill not confirmed in Phase 1 window.
  // Keep polling every 2s until Fyers gives a definitive answer.
  console.warn(`⚠️ Fyers: ${orderId} not confirmed in ${maxWaitMs / 1000}s — entering background retry every 2s`);
  await sendTrafficAlert(
    `⚠️ <b>Order confirm slow</b>\n` +
    `Order ID: ${orderId}\n` +
    `Not confirmed in ${maxWaitMs / 1000}s — polling Fyers every 2s until definitive answer`
  );

  let attempt = 0;
  while (true) {
    attempt++;
    await new Promise(r => setTimeout(r, 2000));
    try {
      const response = await fyers.get_order_history({ id: orderId });

      if (response.s === "ok" && response.orderBook?.length) {
        const order  = response.orderBook[0];
        const status = order.status;

        if (status === 2) {
          const avgPrice = order.tradedPrice || 0;
          console.log(`✅ BG retry ${attempt}: Order ${orderId} FILLED | avgPrice=${avgPrice}`);
          await sendTrafficAlert(
            `✅ <b>Order confirmed (background)</b>\n` +
            `Order ID: ${orderId}\n` +
            `Avg Price: ${avgPrice}\n` +
            `Confirmed after ${attempt} background attempt(s)`
          );
          return { filled: true, avgPrice };
        }

        if (status === 5 || status === 1) {
          throw new Error(`Order ${orderId} rejected/cancelled by broker (status=${status})`);
        }

        console.warn(`⚠️ BG retry ${attempt}: Order ${orderId} status=${status} — still waiting...`);
      } else {
        console.warn(`⚠️ BG retry ${attempt}: unexpected response (s=${response?.s}) — retrying...`);
      }

    } catch (err) {
      if (err.message.includes("rejected/cancelled by broker")) throw err;
      console.warn(`⚠️ BG retry ${attempt}: poll error — retrying: ${err.message}`);
    }
  }
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