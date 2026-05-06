import express from "express";
import jwt from "jsonwebtoken";

import fabricPLRAService from "../services/fabricPLRA.service.js";
import propertyRegistryIntegrityService from "../services/propertyRegistryIntegrity.service.js";

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

function requireAdminScope(req, res, next) {
  const role = String(req.user?.role || "").toUpperCase();
  if (!["ADMIN", "DC"].includes(role)) {
    return res.status(403).json({ success: false, message: "Admin or DC access required" });
  }
  next();
}

router.get("/summary", authenticateToken, requireAdminScope, async (req, res) => {
  try {
    const [summary, network] = await Promise.all([
      propertyRegistryIntegrityService.getSummary(),
      fabricPLRAService.getNetworkStatus(),
    ]);

    return res.json({ success: true, summary, network });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/properties", authenticateToken, requireAdminScope, async (req, res) => {
  try {
    const records = await propertyRegistryIntegrityService.listRecords();
    return res.json({ success: true, records: records.filter(Boolean) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/properties/:propertyId", authenticateToken, requireAdminScope, async (req, res) => {
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
