import { tradeState, pruneCandles } from "../state/tradeState.js";
import { placeOrder, waitForOrderFill, getRealizedPnL } from "../services/orderService.js";
import { DailyStatus } from "../models/dailyStatusModel.js";
import TrafficTradePerformance from "../models/tradePerformanceModel.js";
import { sendTrafficAlert } from "../services/telegramService.js";

let _io = null;
export const setIO = (io) => { _io = io; };

const emitLog = (msg, level = "info") => {
  console.log(msg);
  if (_io) _io.emit("trade_log", { msg, level, strategy: "TRAFFIC", time: new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }) });
};

const RANGE_LIMIT = 30; // Max points allowed for the 2-candle setup
const LOT_SIZE = 65;    // SEBI Lot Size

function getISTDate() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

function getTodayString() {
  const d = getISTDate();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. PATTERN DETECTION (3-min timeframe, 2 opposite candles < 30 points)
// ─────────────────────────────────────────────────────────────────────────────
export const handleNewCandle = (candle) => {
  const candleTime = new Date(new Date(candle.startTime).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));

  // RULE: Ignore the very first 3-minute candle of the day (9:15 - 9:18 AM)
  if (candleTime.getHours() === 9 && candleTime.getMinutes() < 18) {
    emitLog("⏳ Skipping first 3-min candle...", "info");
    return;
  }

  // Stop scanning if a trade was already taken for the day
  if (tradeState.tradeTakenToday) return;

  tradeState.candles.push(candle);
  pruneCandles(10);

  // If a range is already locked, we wait for a breakout in handleTick
  if (tradeState.breakoutHigh && tradeState.breakoutLow) return;

  // Need at least 2 candles to check for "opposite color"
  if (tradeState.candles.length < 2) return;

  const c1 = tradeState.candles.at(-2);
  const c2 = tradeState.candles.at(-1);
  const color1 = c1.close >= c1.open ? "green" : "red";
  const color2 = c2.close >= c2.open ? "green" : "red";

  // RULE: Must be opposite colors (Traffic Light)
  if (color1 === color2) return;

  // RULE: Combined range of the two candles must be < 30 points
  const high = Math.max(c1.high, c2.high);
  const low  = Math.min(c1.low,  c2.low);
  const totalRange = high - low;

  if (totalRange >= RANGE_LIMIT) {
    emitLog(`ℹ️ Range ${totalRange.toFixed(2)} > 30. Skipping.`, "warn");
    return;
  }

  // Lock the Range for Entry
  tradeState.breakoutHigh = high;
  tradeState.breakoutLow  = low;
  emitLog("🎯 TRAFFIC LIGHT RANGE LOCKED!", "success");
  emitLog(`📏 High: ${high} | Low: ${low} | Range: ${totalRange.toFixed(2)}`, "info");

  // 🔔 TELEGRAM: Notify when range is locked
  sendTrafficAlert(`🎯 <b>Range Locked</b>\nHigh: ${high}\nLow: ${low}\nRange: ${totalRange.toFixed(2)}`);

  DailyStatus.findOneAndUpdate(
    { date: getTodayString() },
    { breakoutHigh: high, breakoutLow: low },
    { upsert: true }
  ).catch(err => console.error("❌ DB Update Error:", err.message));
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. LIVE TICK MONITORING (Breakout Entry & Management)
// ─────────────────────────────────────────────────────────────────────────────
export const handleTick = async (spotPrice) => {
  const now = getISTDate();

  // Safety: ensure entryInFlight exists on state (backward compat with old state objects)
  if (tradeState.entryInFlight === undefined) tradeState.entryInFlight = false;

  // RULE: Hard exit at 3:21 PM
  if (now.getHours() === 15 && now.getMinutes() >= 21) {
    if (tradeState.tradeActive) {
      emitLog("⏰ 3:21 PM — Squaring off position", "warn");
      await exitTrade(spotPrice, "3:21 PM Time Exit");
    }
    return;
  }

  // ENTRY LOGIC
  if (!tradeState.tradeTakenToday && !tradeState.tradeActive && tradeState.breakoutHigh) {
    if (spotPrice > tradeState.breakoutHigh) {
      await enterTrade("CE", spotPrice);
    } else if (spotPrice < tradeState.breakoutLow) {
      await enterTrade("PE", spotPrice);
    }
  }

  // MANAGEMENT LOGIC
  if (tradeState.tradeActive) {
    await manageTrade(spotPrice);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. RISK MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
async function manageTrade(spotPrice) {
  const { direction, entryPrice, breakoutHigh, breakoutLow, trailingActive } = tradeState;

  const risk          = breakoutHigh - breakoutLow;
  const targetPoints  = risk * 3; // 1:3 Reward
  const currentPoints = direction === "CE"
    ? (spotPrice - entryPrice)
    : (entryPrice - spotPrice);

  if (!trailingActive) {
    // INITIAL STOPLOSS: Low of 2-candles for CE, High for PE
    const sl = direction === "CE" ? breakoutLow : breakoutHigh;

    if ((direction === "CE" && spotPrice <= sl) || (direction === "PE" && spotPrice >= sl)) {
      emitLog(`❌ Stoploss Hit at ${spotPrice}`, "error");
      await exitTrade(spotPrice, "Stoploss Hit");
      return;
    }

    // TARGET REACHED: Lock profit at 1:3 and hold until 3:21 PM or trail hit
    if (currentPoints >= targetPoints) {
      tradeState.trailingActive = true;
      tradeState.trailSL = direction === "CE"
        ? (entryPrice + targetPoints)
        : (entryPrice - targetPoints);

      // 🔔 TELEGRAM: Notify Profit Locked
      sendTrafficAlert(`💰 <b>1:3 Profit Locked!</b>\nSide: ${direction}\nLocked Level: ${tradeState.trailSL.toFixed(2)}`);
      emitLog(`💰 1:3 Target Hit! Locked at ${tradeState.trailSL.toFixed(2)}`, "success");
    }
  } else {
    // TRAILING: Only exit if price reverses to hit our locked 1:3 profit level
    if (
      (direction === "CE" && spotPrice <= tradeState.trailSL) ||
      (direction === "PE" && spotPrice >= tradeState.trailSL)
    ) {
      emitLog("📈 Profit Protection Hit. Closing trade.", "success");
      await exitTrade(spotPrice, "1:3 Profit Protection Secured");
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. ENTER TRADE
// ✅ FIX (Bug 2): State is only committed AFTER placeOrder succeeds.
//    Previously tradeTakenToday/tradeActive were set before the order,
//    so a thrown error left state corrupted — no position open but
//    no new entry possible for the rest of the day.
// ✅ FIX (Bug 3): In-flight lock prevents duplicate orders fired by concurrent
//    ticks arriving during the async placeOrder gap. Without this, multiple
//    ticks all pass the !tradeTakenToday && !tradeActive check before any
//    single tick has a chance to set those flags post-await — causing 2 lots.
// ─────────────────────────────────────────────────────────────────────────────
async function enterTrade(direction, spotPrice) {
  // ✅ Guard: if an order is already in-flight, bail immediately
  if (tradeState.entryInFlight) {
    emitLog("⏳ Entry already in-flight, skipping duplicate tick", "warn");
    return;
  }
  tradeState.entryInFlight = true;   // 🔒 Lock BEFORE the await

  const symbol = getOptionSymbol(direction, spotPrice);

  emitLog(`🚀 Entering ${direction} at ${spotPrice} | Symbol: ${symbol}`, "success");

  try {
    const orderRes = await placeOrder({ symbol, qty: LOT_SIZE, side: 1 });

    // Wait for Fyers to confirm FILLED — returns actual avgPrice
    // throws if rejected, cancelled, or timeout
    const { filled, avgPrice } = await waitForOrderFill(orderRes?.id, 10000, 500, spotPrice);

    // Save actual filled price from Fyers — not spotPrice
    const actualEntryPrice = (filled && avgPrice) ? avgPrice : spotPrice;

    // Commit state only after Fyers confirms
    tradeState.tradeTakenToday = true;
    tradeState.tradeActive     = true;
    tradeState.entryInFlight   = false;
    tradeState.direction       = direction;
    tradeState.entryPrice      = actualEntryPrice;
    tradeState.optionSymbol    = symbol;
    tradeState.exitReason      = null;

    await DailyStatus.findOneAndUpdate(
      { date: getTodayString() },
      { tradeTakenToday: true },
      { upsert: true }
    );

    sendTrafficAlert(
      `🚀 <b>Trade Entered</b>\n` +
      `Side: ${direction}\n` +
      `Entry Spot: ${spotPrice}\n` +
      `Filled Price: ${actualEntryPrice}\n` +
      `Strike: ${symbol}\n` +
      `Order ID: ${orderRes?.id ?? "PAPER"}`
    );

  } catch (err) {
    // Order failed — lock tradeTakenToday, no retry ever, wait for manual intervention
    tradeState.tradeTakenToday = true;
    tradeState.entryInFlight   = false;
    emitLog(`❌ Entry Order Failed: ${err.message} — stopping for the day, manual intervention required`, "error");
    sendTrafficAlert(
      `🚨 <b>Entry Order FAILED</b>\n` +
      `Side: ${direction}\n` +
      `Symbol: ${symbol}\n` +
      `Error: ${err.message}\n` +
      `⚠️ No retry — check Fyers positions manually`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. EXIT TRADE — Uses actual Fyers position data for PnL; falls back to estimate
// ─────────────────────────────────────────────────────────────────────────────
export async function exitTrade(exitSpotPrice, reason = "Manual Exit") {
  if (!tradeState.tradeActive) return;
  // ✅ FIX: exitInFlight lock prevents duplicate exit orders when concurrent
  // ticks both pass the tradeActive check before either reaches the await below
  if (tradeState.exitInFlight) {
    emitLog("⏳ Exit already in-flight, skipping duplicate tick", "warn");
    return;
  }
  tradeState.exitInFlight = true;  // 🔒 Lock BEFORE the await

  // Mark inactive immediately to prevent re-entry on concurrent ticks
  tradeState.tradeActive     = false;
  tradeState.tradeTakenToday = true;  // ✅ FIX: prevent second entry after exit — one trade per day
  tradeState.exitReason      = reason;

  // Place exit order → wait Fyers COMPLETE → throw on failure, stop and alert
  let exitAvgPrice = 0;
  try {
    const exitOrder = await placeOrder({ symbol: tradeState.optionSymbol, qty: LOT_SIZE, side: -1 });
    const { filled, avgPrice } = await waitForOrderFill(exitOrder?.id, 10000, 500, exitSpotPrice);
    exitAvgPrice = avgPrice || 0;
    emitLog(`✅ Exit confirmed by Fyers | avgPrice=${exitAvgPrice}`, "success");
  } catch (exitErr) {
    // waitForOrderFill never times out — only throws on confirmed broker rejection.
    // Rejection means the order was NOT filled — position is still open on Fyers.
    // Restore tradeActive=true and release exitInFlight so the next tick
    // can re-trigger exitTrade and attempt the exit again.
    emitLog(`❌ Exit order REJECTED by broker: ${exitErr.message} — will retry on next tick`, "error");
    await sendTrafficAlert(
      `🚨 <b>EXIT ORDER REJECTED</b>\n` +
      `Symbol: ${tradeState.optionSymbol}\n` +
      `Error: ${exitErr.message}\n` +
      `⚠️ Position is still open on Fyers — retrying exit on next tick`
    );
    tradeState.tradeActive   = true;  // Position still open — allow next tick to re-trigger exit
    tradeState.exitInFlight  = false; // Release lock so next tick can enter exitTrade
    return; // do not write DB, do not reset state
  }

  // ── Fetch actual PnL from Fyers position data ─────────────────────────────
  const posData = await getRealizedPnL(tradeState.optionSymbol);

  let realizedPnL;
  let pnlSource;

  if (posData && posData.realizedPnL !== undefined) {
    // Actual broker PnL from Fyers — most accurate
    realizedPnL = posData.realizedPnL;
    pnlSource   = "FYERS_ACTUAL";
    emitLog(
      `💹 Actual PnL from Fyers → Buy Avg: ${posData.buyAvg} | Sell Avg: ${posData.sellAvg} | PnL: ₹${realizedPnL.toFixed(2)}`,
      "info"
    );
  } else if (exitAvgPrice && tradeState.entryPrice) {
    // Fallback: use actual fill prices from order confirmation
    const points = tradeState.direction === "CE"
      ? (exitAvgPrice - tradeState.entryPrice)
      : (tradeState.entryPrice - exitAvgPrice);
    realizedPnL = points * LOT_SIZE;
    pnlSource   = "FILL_PRICE";
    emitLog(
      `💹 PnL from fill prices → Entry: ${tradeState.entryPrice} | Exit: ${exitAvgPrice} | PnL: ₹${realizedPnL.toFixed(2)}`,
      "info"
    );
  } else {
    // Last resort — spot based estimate
    const points = tradeState.direction === "CE"
      ? (exitSpotPrice - tradeState.entryPrice)
      : (tradeState.entryPrice - exitSpotPrice);
    realizedPnL = points * LOT_SIZE;
    pnlSource   = "ESTIMATED_SPOT";
    emitLog(`⚠️ PnL estimated from spot: ₹${realizedPnL.toFixed(2)}`, "warn");
  }

  // ── Classify exit reason ─────────────────────────────────────────────────
  let exitCategory = "MANUAL_CLOSE";
  if (reason.includes("Stoploss"))                           exitCategory = "STOP_LOSS_HIT";
  if (reason.includes("Profit") || reason.includes("3:21")) exitCategory = "PROFIT_TARGET";

  // ── Save to DB ────────────────────────────────────────────────────────────
  try {
    await TrafficTradePerformance.create({
      strategy:    "TRAFFIC_LIGHT",
      index:       "NIFTY",
      exitReason:  exitCategory,
      realizedPnL: realizedPnL,
      notes: [
        `Strategy: Traffic Light`,
        `Range: ${(tradeState.breakoutHigh - tradeState.breakoutLow).toFixed(2)}`,
        `Final PnL: ₹${realizedPnL.toFixed(2)}`,
        `PnL Source: ${pnlSource}`,
        posData
          ? `Buy Avg: ${posData.buyAvg} | Sell Avg: ${posData.sellAvg}`
          : `Entry Spot: ${tradeState.entryPrice} | Exit Spot: ${exitSpotPrice}`,
      ].join(" | "),
    });
    emitLog(`💾 Trade archived to DB (${pnlSource})`, "info");
  } catch (dbErr) {
    emitLog(`❌ DB Error: ${dbErr.message}`, "error");
  }

  // 🔔 TELEGRAM: Notify Exit
  sendTrafficAlert(
    `🏁 <b>Trade Closed</b>\n` +
    `Reason: ${reason}\n` +
    `Exit Spot: ${exitSpotPrice}\n` +
    `PnL: ₹${realizedPnL.toFixed(2)}\n` +
    `Source: ${pnlSource}`
  );

  emitLog(`🏁 Trade Complete: ${reason}`, "success");
  tradeState.exitInFlight = false;  // 🔓 Unlock after exit complete
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. OPTION SYMBOL BUILDER
// ✅ FIX (Bug 1): If today is Tuesday but market is already closed (after 15:30),
//    the expired contract was being selected. Now rolls forward to next Tuesday.
// ─────────────────────────────────────────────────────────────────────────────
function getOptionSymbol(direction, spotPrice) {
  const strike = Math.round(spotPrice / 50) * 50;
  const d = getISTDate();

  // Days until next Tuesday (day=2)
  let daysToTuesday = (2 + 7 - d.getDay()) % 7;

  // ✅ FIX: If today IS Tuesday (daysToTuesday === 0) but market is closed
  //         (after 15:30 IST), this expiry is already expired — use next week
  if (daysToTuesday === 0) {
    const minsNow = d.getHours() * 60 + d.getMinutes();
    if (minsNow >= 15 * 60 + 30) {
      daysToTuesday = 7;
      emitLog("⚠️ Tuesday expiry already expired — rolling to next week", "warn");
    }
  }

  d.setDate(d.getDate() + daysToTuesday);

  const year     = d.getFullYear().toString().slice(-2);
  const monthNum = d.getMonth() + 1;
  // Fyers weekly format: single-digit 1–9, O=Oct, N=Nov, D=Dec
  const month    = monthNum <= 9  ? String(monthNum)
                 : monthNum === 10 ? "O"
                 : monthNum === 11 ? "N"
                 : "D";
  const day = d.getDate().toString().padStart(2, "0");

  const symbol = `NSE:NIFTY${year}${month}${day}${strike}${direction}`;
  emitLog(`📋 Option Symbol Built: ${symbol}`, "info");
  return symbol;
}