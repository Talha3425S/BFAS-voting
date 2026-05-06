import express from "express";
import jwt from "jsonwebtoken";

import channelRoutes from "./channel.js";
import p2pSchemaService from "../services/p2pSchema.service.js";

const router = express.Router();

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ success: false, message: "No token provided" });
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || "default-jwt-secret");
    next();
  } catch (error) {
    return res.status(403).json({ success: false, message: "Invalid token" });
  }
}

router.get("/schema-status", authenticateToken, async (req, res) => {
  try {
    const status = await p2pSchemaService.getSchemaStatus();
    return res.json({ success: true, status });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.use("/", channelRoutes);

export default router;
