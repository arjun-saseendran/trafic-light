import { tradeState, pruneCandles } from "../state/traficLightTradeState.js";
import { placeOrder, waitForOrderFill, getRealizedPnL } from "../services/trafficLightOrderService.js";
import { DailyStatus } from "../models/traficLightDailyStatusModel.js";
import TrafficTradePerformance from "../models/trafficTradePerformanceModel.js";
import { sendTrafficAlert } from "../services/telegramService.js";

let _io = null;
export const setIO = (io) => { _io = io; };

const emitLog = (msg, level = "info") => {
  console.log(msg);
  if (_io) _io.emit("trade_log", { msg, level, strategy: "TRAFFIC", time: new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }) });
};

const RANGE_LIMIT = 30; // Max points allowed for the 2-candle setup
const LOT_SIZE = 65;    // Updated SEBI Lot Size

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

  const risk         = breakoutHigh - breakoutLow;
  const targetPoints = risk * 3; // 1:3 Reward
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

    // TARGET REACHED: Lock profit at 1:3 and hold for 3:21 PM
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
// ─────────────────────────────────────────────────────────────────────────────
async function enterTrade(direction, spotPrice) {
  const symbol = getOptionSymbol(direction, spotPrice);
  try {
    emitLog(`🚀 Entering ${direction} at ${spotPrice}`, "success");
    await DailyStatus.findOneAndUpdate(
      { date: getTodayString() },
      { tradeTakenToday: true },
      { upsert: true }
    );

    tradeState.tradeTakenToday = true;
    tradeState.tradeActive     = true;
    tradeState.direction       = direction;
    tradeState.entryPrice      = spotPrice;
    tradeState.optionSymbol    = symbol;
    tradeState.exitReason      = "---"; // Reset reason for new trade

    await placeOrder({ symbol, qty: LOT_SIZE, side: 1 });

    // 🔔 TELEGRAM: Notify Entry
    sendTrafficAlert(`🚀 <b>Trade Entered</b>\nSide: ${direction}\nEntry Spot: ${spotPrice}\nStrike: ${symbol}`);

  } catch (err) {
    emitLog(`❌ Execution Error: ${err.message}`, "error");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. EXIT TRADE — Uses actual Fyers position data for PnL; falls back to estimate
// ─────────────────────────────────────────────────────────────────────────────
async function exitTrade(exitSpotPrice, reason = "Manual Exit") {
  if (!tradeState.tradeActive) return;

  tradeState.exitReason = reason;

  // Place the exit (SELL) order and capture the order ID
  const exitOrder = await placeOrder({ symbol: tradeState.optionSymbol, qty: LOT_SIZE, side: -1 });

  // Poll Fyers order status every 500ms until confirmed filled (max 10s)
  // Only then fetch position PnL — avoids reading stale open position data
  const filled = await waitForOrderFill(exitOrder?.id);
  if (!filled) {
    emitLog(`⚠️ Exit order ${exitOrder?.id} fill not confirmed. PnL may fall back to estimate.`, "warn");
  }

  // ── Fetch actual PnL from Fyers ──────────────────────────────────────────
  const posData = await getRealizedPnL(tradeState.optionSymbol);

  let realizedPnL;
  let pnlSource;

  if (posData && posData.realizedPnL !== undefined) {
    // ✅ ACTUAL broker PnL: premium difference × qty, as settled by Fyers
    realizedPnL = posData.realizedPnL;
    pnlSource   = "FYERS_ACTUAL";
    emitLog(
      `💹 Actual PnL from Fyers → Buy Avg: ${posData.buyAvg} | Sell Avg: ${posData.sellAvg} | PnL: ₹${realizedPnL.toFixed(2)}`,
      "info"
    );
  } else {
    // ⚠️ FALLBACK: Spot-based estimate (paper mode or API failure)
    const points = tradeState.direction === "CE"
      ? (exitSpotPrice - tradeState.entryPrice)
      : (tradeState.entryPrice - exitSpotPrice);
    realizedPnL = points * LOT_SIZE;
    pnlSource   = "ESTIMATED_SPOT";
    emitLog(
      `⚠️ Could not fetch Fyers position. Using spot-based estimate: ₹${realizedPnL.toFixed(2)}`,
      "warn"
    );
  }

  // ── Classify exit reason ─────────────────────────────────────────────────
  let exitCategory = "MANUAL_CLOSE";
  if (reason.includes("Stoploss"))                      exitCategory = "STOP_LOSS_HIT";
  if (reason.includes("Profit") || reason.includes("3:21 PM")) exitCategory = "PROFIT_TARGET";

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
        posData ? `Buy Avg: ${posData.buyAvg} | Sell Avg: ${posData.sellAvg}` : `Entry Spot: ${tradeState.entryPrice} | Exit Spot: ${exitSpotPrice}`,
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

  tradeState.tradeActive = false;
  emitLog(`🏁 Trade Complete: ${reason}`, "success");
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. OPTION SYMBOL BUILDER
// ─────────────────────────────────────────────────────────────────────────────
function getOptionSymbol(direction, spotPrice) {
  const strike = Math.round(spotPrice / 50) * 50;
  const d = getISTDate();

  // Targeting Tuesday Expiry
  const daysToTuesday = (2 + 7 - d.getDay()) % 7;
  d.setDate(d.getDate() + daysToTuesday);

  const year     = d.getFullYear().toString().slice(-2);
  const monthNum = d.getMonth() + 1;
  // Fyers weekly format: single-digit for 1–9, O=Oct, N=Nov, D=Dec
  const month    = monthNum <= 9 ? String(monthNum)
                 : monthNum === 10 ? 'O'
                 : monthNum === 11 ? 'N'
                 : 'D';
  const day = d.getDate().toString().padStart(2, "0");

  return `NSE:NIFTY${year}${month}${day}${strike}${direction}`;
}