import express from "express";
import { login, callback } from "../controllers/authControllers.js";

const router = express.Router();

router.get("/fyers/login", login);
router.get("/fyers/callback", callback);

export default router;
