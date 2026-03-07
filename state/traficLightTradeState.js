export const tradeState = {
  tradeTakenToday: false,
  tradeActive:     false,
  direction:       null,
  entryPrice:      null,
  trailingActive:  false,
  trailSL:         null,
  breakoutHigh:    null,
  breakoutLow:     null,
  candles:         [],
  optionSymbol:    null,
  // ✅ FIX: traficLightEngine sets tradeState.exitReason on trade close, but the
  // field was never declared here. Reading an undeclared property returns undefined
  // which caused /api/traffic/status to always return exitReason: null even after exit.
  exitReason:      null,
};

// ========================
// STATE MANAGEMENT HELPERS
// ========================

export const resetDailyState = () => {
  tradeState.tradeTakenToday = false;
  tradeState.tradeActive     = false;
  tradeState.direction       = null;
  tradeState.entryPrice      = null;
  tradeState.trailingActive  = false;
  tradeState.trailSL         = null;
  tradeState.breakoutHigh    = null;
  tradeState.breakoutLow     = null;
  tradeState.candles         = [];
  tradeState.optionSymbol    = null;
  tradeState.exitReason      = null; // ✅ FIX: also clear on daily reset
  console.log("🧹 Trade state reset for the new day.");
};

export const pruneCandles = (maxCandles = 5) => {
  if (tradeState.candles.length > maxCandles) {
    tradeState.candles = tradeState.candles.slice(-maxCandles);
  }
};