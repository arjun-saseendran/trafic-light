import "dotenv/config";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import cron from "node-cron";

// ─── Config & Routes ──────────────────────────────────────────────────────────
import { connectDatabases } from "./config/db.js";

// ─── Models ───────────────────────────────────────────────────────────────────
import TradePerformance from "./models/trafficTradePerformanceModel.js";
import { DailyStatus } from "./models/traficLightDailyStatusModel.js";

// ─── Services & Strategy ──────────────────────────────────────────────────────
import { resetDailyState, tradeState } from "./state/traficLightTradeState.js";
import { setIO as setTrafficIO } from "./Engines/traficLightEngine.js";
import { sendTelegramAlert } from "./services/telegramService.js";

// ─── Live Data ────────────────────────────────────────────────────────────────
import { initFyersLiveData } from "./services/fyersLiveData.js";

// ─── Socket shared module ─────────────────────────────────────────────────────
import { setIO as setSocketIO } from "./config/socket.js";

// ─────────────────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
let lastTLLTP = 0;

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: [
      "https://mariaalgo.online",
      "https://www.mariaalgo.online",
      "https://api.mariaalgo.online",
      process.env.CLIENT_ORIGIN || "http://localhost:5173",
      "http://localhost:3000",
    ],
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json());

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: [
      "https://mariaalgo.online",
      "https://www.mariaalgo.online", 
      "https://api.mariaalgo.online",
      process.env.CLIENT_ORIGIN || "http://localhost:5173",
      "http://localhost:5000",
    ],
    methods: ["GET", "POST"],
    credentials: true,
  },
});

setSocketIO(io);
setTrafficIO(io);

io.on("connection", (socket) => {
  socket.on("market_tick", (data) => {
    if (data?.price) lastTLLTP = data.price;
  });
});

// ── Traffic Light Status ───────────────────────────────────────────────────────
app.get("/api/traffic/status", (req, res) => {
  let livePnL = 0;
  if (tradeState?.tradeActive && tradeState?.entryPrice && lastTLLTP > 0) {
    const points =
      tradeState.direction === "CE"
        ? lastTLLTP - tradeState.entryPrice
        : tradeState.entryPrice - lastTLLTP;
    livePnL = points * 65;
  }
  res.json({
    signal: tradeState?.tradeActive
      ? "ACTIVE"
      : tradeState?.tradeTakenToday
        ? "CLOSED"
        : "WAITING",
    direction: tradeState?.direction || null,
    entryPrice: tradeState?.entryPrice || 0,
    livePnL: livePnL.toFixed(2),
    stopLoss: tradeState?.trailingActive
      ? tradeState?.trailSL?.toFixed(2) || "0.00"
      : tradeState?.direction === "CE"
        ? tradeState?.breakoutLow?.toFixed(2) || "0.00"
        : tradeState?.breakoutHigh?.toFixed(2) || "0.00",
    trailingActive: tradeState?.trailingActive || false,
    breakoutHigh: tradeState?.breakoutHigh || 0,
    breakoutLow: tradeState?.breakoutLow || 0,
    exitReason: tradeState?.exitReason || null,
  });
});

// ── Trade History ──────────────────────────────────────────────────────────────
app.get("/api/history", async (req, res) => {
  try {
    const history = await TradePerformance.find({ strategy: "TRAFFIC_LIGHT" })
      .sort({ createdAt: -1 })
      .limit(20);

    const combined = history.map((h) => ({
      symbol: h.index || h.symbol,
      exitReason: h.exitReason,
      pnl: h.realizedPnL ?? h.pnl,
      strategy: "TRAFFIC_LIGHT",
      notes: h.notes,
      createdAt: h.createdAt,
    }));

    res.json(combined);
  } catch (err) {
    console.error("❌ /api/history error:", err.message);
    res.status(500).json({ error: "History fetch failed" });
  }
});

app.get("/status", (req, res) =>
  res.json({
    status: "Online",
    strategy: "Traffic Light",
    timestamp: new Date(),
  }),
);

// ─── GLOBAL ERROR HANDLERS ────────────────────────────────────────────────────
process.on("uncaughtException", async (err) => {
  console.error("💥 Uncaught Exception:", err.message);
  try {
    await sendTelegramAlert(
      `💥 <b>Traffic Light Server Crash</b>\n<code>${err.message}</code>`,
    );
  } catch (_) {}
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error("💥 Unhandled Rejection:", msg);
  try {
    await sendTelegramAlert(
      `⚠️ <b>Unhandled Rejection</b>\n<code>${msg}</code>`,
    );
  } catch (_) {}
});

// ─── STARTUP ──────────────────────────────────────────────────────────────────
const start = async () => {
  try {
    await connectDatabases();

    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
    }).format(new Date());
    const dailyRecord = await DailyStatus.findOne({ date: today });
    if (dailyRecord) {
      tradeState.tradeTakenToday = dailyRecord.tradeTakenToday || false;
      tradeState.breakoutHigh = dailyRecord.breakoutHigh;
      tradeState.breakoutLow = dailyRecord.breakoutLow;
    }

    const PORT = process.env.PORT || 3001;
    server.listen(PORT, async () => {
      console.log(`🚀 Traffic Light Server Online · port ${PORT}`);
      await sendTelegramAlert("🚦 <b>Traffic Light Server Online! ✅</b>");

      if (process.env.FYERS_ACCESS_TOKEN) {
        await initFyersLiveData();
        console.log("✅ Fyers live data started (Traffic Light)");
      } else {
        console.warn(
          "⚠️ FYERS_ACCESS_TOKEN missing — Traffic Light will not receive live data",
        );
      }
    });
  } catch (err) {
    console.error("💥 Fatal startup error:", err);
    process.exit(1);
  }
};

// ─── CRON — Reset at 9:00 AM IST every weekday ───────────────────────────────
cron.schedule(
  "0 9 * * 1-5",
  () => {
    resetDailyState();
  },
  { timezone: "Asia/Kolkata" },
);

start();
