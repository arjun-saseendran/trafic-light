import fs from "fs";
import path from "path";
import axios from "axios";
import crypto from "crypto";
import { fyersModel as FyersAPI } from "fyers-api-v3";
import "dotenv/config";

const {
    FYERS_APP_ID,
    FYERS_SECRET_ID,
    FYERS_REDIRECT_URI,
    FYERS_FY_ID,
    FYERS_PIN,
    FYERS_TOTP_SECRET,
} = process.env;

// ─── Validate ENV ────────────────────────────────────────────────────────────
function validateEnv() {
    const required = [
        "FYERS_APP_ID",
        "FYERS_SECRET_ID",
        "FYERS_REDIRECT_URI",
        "FYERS_FY_ID",
        "FYERS_PIN",
        "FYERS_TOTP_SECRET",
    ];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length) {
        throw new Error(`Missing required env vars: ${missing.join(", ")}`);
    }
}

// ─── Native TOTP (RFC 6238) ──────────────────────────────────────────────────
function base32Decode(base32) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const clean = base32.replace(/[^A-Z2-7]/gi, "").toUpperCase();
    let bits = "";
    for (const char of clean) {
        const val = alphabet.indexOf(char);
        if (val === -1) throw new Error(`Invalid base32 character: ${char}`);
        bits += val.toString(2).padStart(5, "0");
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
        bytes.push(parseInt(bits.slice(i, i + 8), 2));
    }
    return Buffer.from(bytes);
}

function generateTotp(secret, digits = 6, period = 30) {
    const key = base32Decode(secret);
    const counter = Math.floor(Date.now() / 1000 / period);
    const counterBuf = Buffer.alloc(8);
    counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    counterBuf.writeUInt32BE(counter >>> 0, 4);
    const hmac = crypto.createHmac("sha1", key).update(counterBuf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
    return String(code % Math.pow(10, digits)).padStart(digits, "0");
}

function hashPin(pin) {
    return Buffer.from(pin.toString()).toString("base64");
}

function extractAuthCode(url) {
    try {
        const parsed = new URL(url);
        const code = parsed.searchParams.get("auth_code");
        if (code) return code;
    } catch { }
    const match = url.match(/[?&]auth_code=([^&]+)/);
    if (match) return match[1];
    throw new Error(`auth_code not found in redirect URL: ${url}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function generateFyersToken() {
    console.log("🤖 Starting Fyers V3 Headless Login...");
    validateEnv();

    const res1 = await axios.post("https://api-t2.fyers.in/vagator/v2/send_login_otp_v2", { 
        fy_id: Buffer.from(FYERS_FY_ID).toString("base64"), app_id: "2" 
    });
    if (res1.data.s !== "ok") throw new Error(`Step 1 Failed: ${JSON.stringify(res1.data)}`);
    let requestKey = res1.data.request_key;

    const currentTotp = generateTotp(FYERS_TOTP_SECRET);
    const res2 = await axios.post("https://api-t2.fyers.in/vagator/v2/verify_otp", { 
        request_key: requestKey, otp: currentTotp 
    });
    if (res2.data.s !== "ok") throw new Error(`Step 2 Failed: ${JSON.stringify(res2.data)}`);
    requestKey = res2.data.request_key;

    const res3 = await axios.post("https://api-t2.fyers.in/vagator/v2/verify_pin_v2", {
        request_key: requestKey, identity_type: "pin", identifier: hashPin(FYERS_PIN),
    });
    if (res3.data.s !== "ok") throw new Error(`Step 3 Failed: ${JSON.stringify(res3.data)}`);
    const ssoToken = res3.data.data?.access_token;

    const appIdPrefix = FYERS_APP_ID.includes("-") ? FYERS_APP_ID.split("-")[0] : FYERS_APP_ID;
    const res4 = await axios.post("https://api-t1.fyers.in/api/v3/token", {
        fyers_id: FYERS_FY_ID, app_id: appIdPrefix, redirect_uri: FYERS_REDIRECT_URI,
        appType: "100", code_challenge: "", state: "None", scope: "", nonce: "", response_type: "code", create_cookie: true,
    }, {
        headers: { Authorization: `Bearer ${ssoToken}` },
        maxRedirects: 0,
        validateStatus: (status) => status === 200 || status === 308,
    });

    if (!res4.data?.Url) throw new Error("Step 4 Failed: Redirect URL missing.");
    
    const authCode = extractAuthCode(res4.data.Url);
    const fyers = new FyersAPI();
    fyers.setAppId(FYERS_APP_ID);
    fyers.setRedirectUrl(FYERS_REDIRECT_URI);

    const tokenResponse = await fyers.generate_access_token({
        secret_key: FYERS_SECRET_ID, auth_code: authCode,
    });

    if (tokenResponse.s !== "ok") throw new Error(`Step 5 Failed: ${JSON.stringify(tokenResponse)}`);

    console.log("✅ Access token retrieved successfully!");
    updateEnvFile("FYERS_ACCESS_TOKEN", tokenResponse.access_token);
    return tokenResponse.access_token;
}

// ─── Helper to update .env ────────────────────────────────────────────────────
function updateEnvFile(key, value) {
    const envPath = path.resolve(process.cwd(), ".env");
    let envData = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    const regex = new RegExp(`^${key}=.*`, "m");
    const newLine = `${key}="${value}"`;
    envData = regex.test(envData) ? envData.replace(regex, newLine) : envData + (envData.endsWith("\n") ? "" : "\n") + newLine + "\n";
    fs.writeFileSync(envPath, envData, "utf8");
    console.log(`💾 ${key} saved to .env file.`);
}

generateFyersToken().catch((error) => {
    console.error(error.message);
    process.exit(1);
});