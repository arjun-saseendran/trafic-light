import "dotenv/config";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import cron from "node-cron";
import { exec } from "child_process";

// ─── Config & Routes ──────────────────────────────────────────────────────────
import { connectDatabases } from "./config/db.js";

// Auth
import authRoutes from "./routes/authRoutes.js";

// ─── Models ───────────────────────────────────────────────────────────────────
import TradePerformance from "./models/tradePerformanceModel.js";
import { DailyStatus } from "./models/dailyStatusModel.js";
import { Token } from "./models/tokenModel.js";

// ─── Services & Strategy ──────────────────────────────────────────────────────
import { resetDailyState, tradeState } from "./state/tradeState.js";
import { setIO as setTrafficIO } from "./Engines/traficLightEngine.js";
import { sendTelegramAlert } from "./services/telegramService.js";

// ─── Live Data ────────────────────────────────────────────────────────────────
import { initFyersLiveData } from "./services/fyersLiveData.js";
import { setFyersAccessToken } from "./config/fyersConfig.js";

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
      "http://localhost:3000",
    ],
    methods: ["GET", "POST"],
    credentials: true,
  },
});

setSocketIO(io);
setTrafficIO(io);
app.set("io", io);

io.on("connection", (socket) => {
  socket.on("market_tick", (data) => {
    if (data?.price) lastTLLTP = data.price;
  });
});

// Routes
app.use("/api/auth", authRoutes);

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

// ─── Engine Stop (Kill Switch) ────────────────────────────────────────────────
// Stops the pm2 process immediately — does NOT touch open positions.
// Open positions must be handled manually in Fyers after stopping.
app.post("/api/engine/stop", async (_req, res) => {
  try {
    // Reply immediately so dashboard gets response before process dies
    res.json({
      success: true,
      message: "Exiting position then stopping engine...",
    });

    // Exit open trade first
    try {
      if (tradeState.tradeActive) {
        const { exitTrade } = await import("./Engines/traficLightEngine.js");
        await exitTrade(lastTLLTP || 0, "MANUAL_STOP");
        console.log("✅ Trade exited before engine stop");
      } else {
        console.log("ℹ️ No active trade — stopping engine directly");
      }
    } catch (e) {
      console.error("❌ Exit trade failed on stop:", e.message);
      await sendTelegramAlert(
        `⚠️ <b>Exit before stop FAILED</b>\n${e.message}\n⚠️ Check Fyers positions manually`,
      );
    }

    await sendTelegramAlert(
      "🔴 <b>Traffic Light Engine STOPPED</b>\nKill switch triggered from dashboard. Position exited.",
    );

    setTimeout(() => {
      exec("pm2 stop trafic-light", (err) => {
        if (err) console.error("❌ pm2 stop failed:", err.message);
      });
    }, 1000);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

    // ─── Check if market is currently open ────────────────────────────────────
    // Market hours: 9:15 AM – 3:30 PM IST weekdays
    // If restarting outside market hours — clear breakout range and block entry.
    // Without this, old breakout range from morning gets loaded and bot tries
    // to enter a trade at 8 PM when Fyers rejects with "MIS disallowed".
    const nowIST = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      hour: "numeric", minute: "numeric", hour12: false,
    }).format(new Date());
    const [nowH, nowM] = nowIST.split(":").map(Number);
    const nowMins = nowH * 60 + nowM;
    const isMarketOpen = nowMins >= 555 && nowMins < 930; // 9:15 AM to 3:30 PM

    if (dailyRecord) {
      tradeState.tradeTakenToday = dailyRecord.tradeTakenToday || false;
      if (isMarketOpen) {
        // Market is open — safe to restore breakout range
        tradeState.breakoutHigh = dailyRecord.breakoutHigh;
        tradeState.breakoutLow  = dailyRecord.breakoutLow;
      } else {
        // Market closed — clear breakout range and block any entry attempt
        tradeState.breakoutHigh    = null;
        tradeState.breakoutLow     = null;
        tradeState.tradeTakenToday = true; // block entry until next day reset
        console.log("⏰ Market closed — breakout range cleared, entry blocked until 9:00 AM reset");
      }
    }

    const PORT = process.env.PORT || 3001;
    server.listen(PORT, async () => {
      console.log(`🚀 Traffic Light Server Online · port ${PORT}`);
      await sendTelegramAlert("🚦 <b>Traffic Light Server Online! ✅</b>");

      // ─── Load Fyers token from DB ──────────────────────────────────────────
      const savedToken = await Token.findOne({});
      if (savedToken?.accessToken) {
        setFyersAccessToken(savedToken.accessToken);
        await initFyersLiveData(io);
        console.log("✅ Fyers live data started from saved token");
      } else {
        console.warn(
          "⚠️ No token in DB — visit /api/auth/fyers/login to authenticate",
        );
        await sendTelegramAlert(
          "⚠️ <b>Fyers token missing</b>\nVisit /api/auth/fyers/login to authenticate",
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