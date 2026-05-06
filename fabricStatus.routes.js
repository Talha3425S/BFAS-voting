import express from "express";
import jwt from "jsonwebtoken";

import fabricPLRAService from "../services/fabricPLRA.service.js";

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

router.get("/", authenticateToken, async (req, res) => {
  try {
    const status = await fabricPLRAService.getNetworkStatus();
    return res.json({ success: true, status });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/public", async (req, res) => {
  try {
    const proof = await fabricPLRAService.getConnectivityProof();
    return res.json({ success: true, proof });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/proof", authenticateToken, async (req, res) => {
  try {
    const proof = await fabricPLRAService.getConnectivityProof();
    return res.json({ success: true, proof });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/nodes", authenticateToken, async (req, res) => {
  try {
    const nodes = await fabricPLRAService.listNodes();
    return res.json({ success: true, nodes });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/property/:propertyId", authenticateToken, async (req, res) => {
  try {
    const record = await fabricPLRAService.queryLandRecord(req.params.propertyId);
    if (!record) {
      return res.status(404).json({ success: false, message: "Property not found" });
    }

    return res.json({ success: true, record });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
