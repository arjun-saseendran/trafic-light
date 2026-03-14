import { fyers, setFyersAccessToken } from "../config/fyersConfig.js";
import { Token } from "../models/tokenModel.js";
import { initFyersLiveData } from "../services/fyersLiveData.js";

export const login = (req, res) => {
  const url = fyers.generateAuthCode();
  res.redirect(url);
};

export const callback = async (req, res) => {
  try {
    const { auth_code } = req.query;
    if (!auth_code) {
      return res.status(400).send("❌ No auth code received from Fyers");
    }

    const response = await fyers.generate_access_token({
      client_id: process.env.FYERS_APP_ID,
      secret_key: process.env.FYERS_SECRET_ID,
      auth_code,
    });

    if (response.s !== "ok") {
      console.error("❌ Token generation failed:", response);
      return res.status(400).send("Token generation failed");
    }

    const accessToken = response.access_token;

    setFyersAccessToken(accessToken);

    // 🚨 CHANGED: Start the unified Master Data Feed
    const io = req.app.get("io");
    await initFyersLiveData(io);

    await Token.findOneAndUpdate(
      {},
      { accessToken },
      { upsert: true, returnDocument: "after" },
    );

    res.send(
      "<h1>✅ Fyers Connected!</h1><p>The Master Strategy feed is now live. You can close this tab.</p>",
    );
  } catch (error) {
    console.error("❌ Fyers Auth Error:", error);
    res.status(500).send("Something went wrong during Fyers authentication");
  }
};