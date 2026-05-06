import express from "express";
import jwt from "jsonwebtoken";

import {
  getLandRecordSummary,
  listPendingLandRecords,
  listApprovedLandRecords,
  getLandRecordById,
} from "../controllers/landRecordController.js";

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

function requireOfficer(req, res, next) {
  const role = String(req.user?.role || "").toUpperCase();
  if (!["ADMIN", "DC", "LRO", "LAND RECORD OFFICER"].includes(role)) {
    return res.status(403).json({ success: false, message: "Officer access required" });
  }
  next();
}

router.get("/summary", authenticateToken, requireOfficer, getLandRecordSummary);
router.get("/pending", authenticateToken, requireOfficer, listPendingLandRecords);
router.get("/approved", authenticateToken, requireOfficer, listApprovedLandRecords);
router.get("/:propertyId", authenticateToken, requireOfficer, getLandRecordById);

export default router;
