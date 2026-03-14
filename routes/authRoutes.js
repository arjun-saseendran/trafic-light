import express from "express";
import { login, callback } from "../controllers/authControllers.js";

const router = express.Router();

router.get("/trafic-light/login", login);
router.get("/trafic-light/callback", callback);

export default router;
