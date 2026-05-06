import express from "express";
import jwt from "jsonwebtoken";
import pool from "../config/db.js";
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
  } catch (err) {
    return res.status(403).json({ success: false, message: "Invalid token" });
  }
}

function requireOfficer(req, res, next) {
  const role = String(req.user?.role || "").toUpperCase();
  const allowed = ["LRO", "LAND RECORD OFFICER", "DC", "ADMIN"];

  if (!allowed.includes(role)) {
    return res.status(403).json({ success: false, message: "Officer access required" });
  }

  next();
}

async function getTableColumns(tableName) {
  const result = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [tableName]
  );
  return result.rows.map((row) => row.column_name);
}

function pickOrderColumn(columns) {
  if (columns.includes("submitted_at")) return "submitted_at";
  if (columns.includes("created_at")) return "created_at";
  if (columns.includes("updated_at")) return "updated_at";
  if (columns.includes("id")) return "id";
  return null;
}

router.get("/citizen-history", authenticateToken, requireOfficer, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const digits = search.replace(/\D/g, "");

    let query = `
      SELECT user_id, name, cnic, father_name, email, mobile, role, is_active, created_at
      FROM users
      WHERE UPPER(role) = 'CITIZEN'
    `;

    const params = [];
    if (search) {
      params.push(search, digits, `%${search}%`);
      query += `
        AND (
          user_id = $1
          OR cnic = $2
          OR email ILIKE $3
          OR name ILIKE $3
        )
      `;
    }

    query += " ORDER BY created_at DESC LIMIT 25";

    const result = await pool.query(query, params);
    return res.json({
      success: true,
      search,
      matches: result.rows,
    });
  } catch (err) {
    console.error("GET /api/officer/citizen-history error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/citizen-history/:userId", authenticateToken, requireOfficer, async (req, res) => {
  try {
    const { userId } = req.params;

    const citizenResult = await pool.query(
      `SELECT user_id, name, cnic, father_name, email, mobile, role, is_active, created_at
       FROM users
       WHERE user_id = $1 AND UPPER(role) = 'CITIZEN'
       LIMIT 1`,
      [userId]
    );

    if (citizenResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Citizen not found" });
    }

    const citizen = citizenResult.rows[0];

    const propertiesResult = await pool.query(
      `SELECT
         property_id,
         owner_name,
         owner_cnic,
         district,
         tehsil,
         mauza,
         area_marla,
         property_type,
         status,
         created_at,
         updated_at
       FROM properties
       WHERE owner_id = $1 OR owner_cnic = $2
       ORDER BY COALESCE(updated_at, created_at) DESC`,
      [userId, citizen.cnic]
    );

    const transfersResult = await pool.query(
      `SELECT
         tr.transfer_id,
         tr.property_id,
         tr.status,
         tr.payment_status,
         tr.channel_status,
         tr.agreed_price,
         tr.created_at,
         tr.updated_at,
         seller.name AS seller_name,
         buyer.name AS buyer_name,
         p.district,
         p.tehsil,
         p.mauza
       FROM transfer_requests tr
       LEFT JOIN users seller ON tr.seller_id = seller.user_id
       LEFT JOIN users buyer ON tr.buyer_id = buyer.user_id
       LEFT JOIN properties p ON tr.property_id = p.property_id
       WHERE tr.seller_id = $1 OR tr.buyer_id = $1
       ORDER BY COALESCE(tr.updated_at, tr.created_at) DESC`,
      [userId]
    );

    return res.json({
      success: true,
      citizen,
      summary: {
        totalProperties: propertiesResult.rows.length,
        totalTransfers: transfersResult.rows.length,
      },
      properties: propertiesResult.rows,
      transfers: transfersResult.rows,
    });
  } catch (err) {
    console.error("GET /api/officer/citizen-history/:userId error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/recent-activity", authenticateToken, requireOfficer, async (req, res) => {
  try {
    const [propertyEvents, transferEvents] = await Promise.all([
      pool.query(
        `SELECT
           'REGISTRATION' AS type,
           property_id AS record_id,
           status,
           created_at AS event_at,
           CONCAT(owner_name, ' - ', property_id) AS description
         FROM properties
         ORDER BY created_at DESC
         LIMIT 12`
      ),
      pool.query(
        `SELECT
           'TRANSFER' AS type,
           transfer_id::text AS record_id,
           status,
           COALESCE(updated_at, created_at) AS event_at,
           CONCAT(property_id, ' - ', COALESCE(status, 'PENDING')) AS description
         FROM transfer_requests
         ORDER BY COALESCE(updated_at, created_at) DESC
         LIMIT 12`
      ),
    ]);

    const activities = [...propertyEvents.rows, ...transferEvents.rows]
      .sort((a, b) => new Date(b.event_at) - new Date(a.event_at))
      .slice(0, 15)
      .map((item) => ({
        type: item.type,
        status: item.status,
        created_at: item.event_at,
        description: item.description,
        property_id: item.type === "REGISTRATION" ? item.record_id : null,
        transfer_id: item.type === "TRANSFER" ? item.record_id : null,
      }));

    return res.json({
      success: true,
      activities,
    });
  } catch (err) {
    console.error("GET /api/officer/recent-activity error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/integrity/summary", authenticateToken, requireOfficer, async (req, res) => {
  try {
    const integrityRecords = (await propertyRegistryIntegrityService.listRecords({ skipFabric: true })).filter(Boolean);

    const records = integrityRecords.map((entry) => {
      const property = entry.property || {};
      const minedAt =
        entry.fabricRecord?.mined_at ||
        entry.fabricRecord?.timestamp ||
        entry.chainHistory?.[0]?.mined_at ||
        null;
      const blockIndex =
        entry.fabricRecord?.block_index ??
        entry.fabricRecord?.blockIndex ??
        entry.chainHistory?.[0]?.block_index ??
        null;

      return {
        property_id: property.property_id,
        owner_name: property.owner_name,
        district: property.district,
        tehsil: property.tehsil,
        mauza: property.mauza,
        area_marla: property.area_marla,
        property_type: property.property_type,
        status: property.status,
        created_at: property.created_at,
        updated_at: property.updated_at,
        block_index: blockIndex,
        mined_at: minedAt,
        proofSource: entry.proofSource,
        integrity:
          entry.classification === "APPROVED_ON_CHAIN"
            ? "CLEAN"
            : entry.classification === "TAMPERED"
            ? "TAMPERED"
            : "NOT_ON_CHAIN",
      };
    });

    const summary = {
      scannedRecords: records.length,
      clean: records.filter((item) => item.integrity === "CLEAN").length,
      tampered: records.filter((item) => item.integrity === "TAMPERED").length,
      notOnChain: records.filter((item) => item.integrity === "NOT_ON_CHAIN").length,
    };

    return res.json({
      success: true,
      summary,
      verification: null,
      records,
    });
  } catch (err) {
    console.error("GET /api/officer/integrity/summary error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/succession/cases", authenticateToken, requireOfficer, async (req, res) => {
  try {
    const tables = ["succession_requests", "succession_heirs", "succession_events"];
    const result = [];

    for (const table of tables) {
      const columns = await getTableColumns(table);
      if (!columns.length) {
        result.push({ table, exists: false, columns: [], rows: [] });
        continue;
      }

      const orderColumn = pickOrderColumn(columns);
      const sql = orderColumn
        ? `SELECT * FROM ${table} ORDER BY ${orderColumn} DESC LIMIT 25`
        : `SELECT * FROM ${table} LIMIT 25`;

      const rows = await pool.query(sql);
      result.push({ table, exists: true, columns, rows: rows.rows });
    }

    return res.json({
      success: true,
      available: result.some((entry) => entry.exists),
      tables: result,
    });
  } catch (err) {
    console.error("GET /api/officer/succession/cases error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
