import express from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";

import pool from "../config/db.js";
import p2pSchemaService from "../services/p2pSchema.service.js";
import propertyEncumbranceService from "../services/propertyEncumbrance.service.js";
import propertyFreezeService from "../services/propertyFreeze.service.js";

const router = express.Router();

let schemaReady = false;
const TERMINAL_TRANSFER_STATUSES = [
  "APPROVED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
  "FINALIZED",
  "COMPLETED",
];

function activeTransferPredicate(alias = "tr") {
  return `UPPER(COALESCE(${alias}.status, '')) NOT IN (${TERMINAL_TRANSFER_STATUSES.map((status) => `'${status}'`).join(", ")})`;
}

function preventMarketplaceCaching(_req, res, next) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
  next();
}

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

async function ensureMarketplaceSchema() {
  if (schemaReady) return;

  await p2pSchemaService.ensureSchema();
  await propertyFreezeService.ensureSchema();
  await propertyEncumbranceService.ensureSchema();

  await pool.query(`
    ALTER TABLE properties
      ADD COLUMN IF NOT EXISTS is_for_sale BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS asking_price NUMERIC(15,2),
      ADD COLUMN IF NOT EXISTS listed_at TIMESTAMP
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS property_marketplace_requests (
      request_id VARCHAR(80) PRIMARY KEY,
      property_id VARCHAR(120) NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
      seller_id VARCHAR(60) NOT NULL,
      buyer_id VARCHAR(60) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
      buyer_message TEXT,
      seller_response_note TEXT,
      transfer_id VARCHAR(120),
      created_at TIMESTAMP DEFAULT NOW(),
      responded_at TIMESTAMP,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_marketplace_props_active
    ON properties (is_for_sale, status, district, tehsil)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_marketplace_requests_seller
    ON property_marketplace_requests (seller_id, status, created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_marketplace_requests_buyer
    ON property_marketplace_requests (buyer_id, status, created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_marketplace_requests_property
    ON property_marketplace_requests (property_id, status, created_at DESC)
  `);

  schemaReady = true;
}

function requireCitizen(req, res, next) {
  const role = String(req.user?.role || "").toUpperCase();
  if (role !== "CITIZEN") {
    return res.status(403).json({ success: false, message: "Citizen access required" });
  }
  next();
}

function buildRequestId() {
  return `MREQ-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function buildTransferId() {
  return `TR-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function buildChannelId() {
  return `CH-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

async function createTransferFromAcceptedRequest(client, requestRow) {
  const transferId = buildTransferId();
  const channelId = buildChannelId();
  const transferAmount = Number(requestRow.asking_price || 0);
  const propertyTaxBuyer = Number((transferAmount * 0.02).toFixed(2));
  const propertyTaxSeller = Number((transferAmount * 0.02).toFixed(2));
  const totalAmount = Number((transferAmount + propertyTaxBuyer).toFixed(2));

  await client.query(
    `
      INSERT INTO transfer_requests (
        transfer_id, property_id, seller_id, buyer_id, buyer_name, buyer_cnic, buyer_father_name,
        transfer_amount, property_tax_buyer, property_tax_seller, total_amount,
        status, expires_at, created_at, channel_id, channel_status, channel_created_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11,
        'PENDING', NOW() + INTERVAL '30 days', NOW(), $12, 'INACTIVE', NOW()
      )
    `,
    [
      transferId,
      requestRow.property_id,
      requestRow.seller_id,
      requestRow.buyer_id,
      requestRow.buyer_name,
      requestRow.buyer_cnic,
      requestRow.buyer_father_name || null,
      transferAmount,
      propertyTaxBuyer,
      propertyTaxSeller,
      totalAmount,
      channelId,
    ]
  );

  await client.query(
    `
      INSERT INTO channel_participants (channel_id, user_id, role, joined_at)
      VALUES
        ($1, $2, 'SELLER', NOW()),
        ($1, $3, 'BUYER', NOW())
    `,
    [channelId, requestRow.seller_id, requestRow.buyer_id]
  );

  await client.query(
    `
      INSERT INTO channel_messages (
        channel_id, transfer_id, sender_id, sender_role, message_type, message_content, is_system_message
      )
      VALUES (
        $1, $2, $3, 'SYSTEM', 'SYSTEM', $4, true
      )
    `,
    [
      channelId,
      transferId,
      requestRow.seller_id,
      `Buyer request accepted for ${requestRow.property_id}. Seller can now start the negotiation chat.`,
    ]
  );

  return { transferId, channelId, transferAmount, totalAmount };
}

router.use(preventMarketplaceCaching);
router.use(authenticateToken, requireCitizen);

router.get("/districts", async (req, res) => {
  try {
    await ensureMarketplaceSchema();

    const result = await pool.query(`
      SELECT DISTINCT district, tehsil
      FROM properties
      WHERE status = 'APPROVED'
        AND COALESCE(is_frozen, FALSE) = FALSE
        AND COALESCE(is_encumbered, FALSE) = FALSE
        AND COALESCE(is_for_sale, FALSE) = TRUE
      ORDER BY district, tehsil
    `);

    return res.json({ success: true, locations: result.rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/listings", async (req, res) => {
  try {
    await ensureMarketplaceSchema();

    const userId = req.user.userId;
    const { district = "", tehsil = "", search = "" } = req.query;
    const filters = [userId];
    const clauses = [
      "p.status = 'APPROVED'",
      "COALESCE(p.is_frozen, FALSE) = FALSE",
      "COALESCE(p.is_encumbered, FALSE) = FALSE",
      "COALESCE(p.is_for_sale, FALSE) = TRUE",
      "COALESCE(p.asking_price, 0) > 0",
      `NOT EXISTS (
        SELECT 1
        FROM transfer_requests tr_active
        WHERE tr_active.property_id = p.property_id
          AND ${activeTransferPredicate("tr_active")}
      )`,
    ];

    if (district) {
      filters.push(`%${district}%`);
      clauses.push(`p.district ILIKE $${filters.length}`);
    }

    if (tehsil) {
      filters.push(`%${tehsil}%`);
      clauses.push(`p.tehsil ILIKE $${filters.length}`);
    }

    if (search) {
      filters.push(`%${search}%`);
      const idx = filters.length;
      clauses.push(`(
        p.property_id ILIKE $${idx}
        OR p.district ILIKE $${idx}
        OR p.tehsil ILIKE $${idx}
        OR COALESCE(p.mauza, '') ILIKE $${idx}
        OR COALESCE(p.owner_name, '') ILIKE $${idx}
      )`);
    }

    const result = await pool.query(
      `
        WITH latest_request AS (
          SELECT DISTINCT ON (property_id)
                 property_id, status, created_at
          FROM property_marketplace_requests
          WHERE buyer_id = $1
          ORDER BY property_id, created_at DESC
        )
        SELECT
          p.property_id,
          p.owner_id,
          p.owner_name,
          p.property_type,
          p.district,
          p.tehsil,
          p.mauza,
          p.khasra_no,
          p.fard_no,
          p.area_marla,
          p.asking_price,
          p.listed_at,
          COALESCE(p.is_for_sale, FALSE) AS is_for_sale,
          COALESCE(p.is_frozen, FALSE) AS is_frozen,
          FALSE AS has_co_owners,
          'SOLE' AS ownership_model,
          0 AS active_co_owner_count,
          NULL::TEXT AS co_owner_summary,
          COALESCE(p.is_encumbered, FALSE) AS is_encumbered,
          COALESCE(p.active_encumbrance_count, 0) AS active_encumbrance_count,
          p.encumbrance_summary,
          p.freeze_reason_code,
          p.freeze_reason_label,
          p.freeze_reference_no,
          p.freeze_notes,
          p.freeze_started_at,
          CASE WHEN p.owner_id = $1 THEN TRUE ELSE FALSE END AS is_own,
          lr.status AS my_request_status
        FROM properties p
        LEFT JOIN latest_request lr ON lr.property_id = p.property_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY COALESCE(p.listed_at, p.created_at) DESC, p.property_id DESC
      `,
      filters
    );

    return res.json({ success: true, listings: result.rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/seller/listings", async (req, res) => {
  try {
    await ensureMarketplaceSchema();

    const result = await pool.query(
      `
        SELECT
          p.property_id,
          p.owner_id,
          p.owner_name,
          p.property_type,
          p.district,
          p.tehsil,
          p.mauza,
          p.area_marla,
          p.khasra_no,
          p.fard_no,
          COALESCE(p.is_for_sale, FALSE) AS is_for_sale,
          p.asking_price,
          p.listed_at,
          COALESCE(p.is_frozen, FALSE) AS is_frozen,
          FALSE AS has_co_owners,
          'SOLE' AS ownership_model,
          0 AS active_co_owner_count,
          NULL::TEXT AS co_owner_summary,
          COALESCE(p.is_encumbered, FALSE) AS is_encumbered,
          COALESCE(p.active_encumbrance_count, 0) AS active_encumbrance_count,
          p.encumbrance_summary,
          p.freeze_reason_code,
          p.freeze_reason_label,
          p.freeze_reference_no,
          p.freeze_notes,
          p.freeze_started_at,
          active_transfer.transfer_id AS active_transfer_id,
          active_transfer.status AS active_transfer_status,
          COALESCE(req_stats.pending_requests, 0) AS pending_requests,
          COALESCE(req_stats.accepted_requests, 0) AS accepted_requests,
          COALESCE(req_stats.rejected_requests, 0) AS rejected_requests
        FROM properties p
        LEFT JOIN LATERAL (
          SELECT tr.transfer_id, tr.status
          FROM transfer_requests tr
          WHERE tr.property_id = p.property_id
            AND ${activeTransferPredicate("tr")}
          ORDER BY tr.created_at DESC
          LIMIT 1
        ) active_transfer ON TRUE
        LEFT JOIN (
          SELECT
            property_id,
            COUNT(*) FILTER (WHERE status = 'PENDING')  AS pending_requests,
            COUNT(*) FILTER (WHERE status = 'ACCEPTED') AS accepted_requests,
            COUNT(*) FILTER (WHERE status = 'REJECTED') AS rejected_requests
          FROM property_marketplace_requests
          GROUP BY property_id
        ) req_stats ON req_stats.property_id = p.property_id
        WHERE p.owner_id = $1
          AND p.status = 'APPROVED'
        ORDER BY COALESCE(p.listed_at, p.created_at) DESC, p.property_id DESC
      `,
      [req.user.userId]
    );

    return res.json({ success: true, listings: result.rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/listings", async (req, res) => {
  try {
    await ensureMarketplaceSchema();

    const { propertyId, action = "LIST", askingPrice } = req.body;

    if (!propertyId) {
      return res.status(400).json({ success: false, message: "Property ID is required" });
    }

    const propertyResult = await pool.query(
      `
        SELECT
          property_id,
          owner_id,
          status,
          COALESCE(is_for_sale, FALSE) AS is_for_sale,
          COALESCE(is_frozen, FALSE) AS is_frozen,
          freeze_reason_label,
          FALSE AS has_co_owners,
          0 AS active_co_owner_count,
          NULL::TEXT AS co_owner_summary,
          COALESCE(is_encumbered, FALSE) AS is_encumbered,
          encumbrance_summary
        FROM properties
        WHERE property_id = $1
          AND owner_id = $2
        LIMIT 1
      `,
      [propertyId, req.user.userId]
    );

    if (propertyResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Property not found" });
    }

    if (propertyResult.rows[0].status !== "APPROVED") {
      return res.status(400).json({ success: false, message: "Only approved properties can be listed" });
    }

    if (propertyResult.rows[0].is_frozen) {
      return res.status(409).json({
        success: false,
        message: `Property is under dispute hold${propertyResult.rows[0].freeze_reason_label ? `: ${propertyResult.rows[0].freeze_reason_label}` : ""}`,
      });
    }

    if (propertyResult.rows[0].is_encumbered) {
      return res.status(409).json({
        success: false,
        message: `Property has an active encumbrance${propertyResult.rows[0].encumbrance_summary ? `: ${propertyResult.rows[0].encumbrance_summary}` : ""}`,
      });
    }

    const activeTransfer = await pool.query(
      `
        SELECT transfer_id, status
        FROM transfer_requests tr
        WHERE tr.property_id = $1
          AND ${activeTransferPredicate("tr")}
        ORDER BY tr.created_at DESC
        LIMIT 1
      `,
      [propertyId]
    );

    if (activeTransfer.rows.length > 0 && String(action).toUpperCase() !== "UNLIST") {
      const transfer = activeTransfer.rows[0];
      return res.status(409).json({
        success: false,
        message: `Property cannot be listed while transfer ${transfer.transfer_id} is ${transfer.status || "active"}. Complete or cancel that transfer first.`,
      });
    }

    if (String(action).toUpperCase() === "UNLIST") {
      await pool.query(
        `
          UPDATE properties
          SET is_for_sale = FALSE
          WHERE property_id = $1
        `,
        [propertyId]
      );

      return res.json({ success: true, message: "Property removed from marketplace" });
    }

    const price = Number(askingPrice || 0);
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ success: false, message: "Valid asking price is required" });
    }

    await pool.query(
      `
        UPDATE properties
        SET is_for_sale = TRUE,
            asking_price = $2,
            listed_at = COALESCE(listed_at, NOW())
        WHERE property_id = $1
      `,
      [propertyId, price]
    );

    return res.json({ success: true, message: "Property listed on marketplace", askingPrice: price });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/request", async (req, res) => {
  try {
    await ensureMarketplaceSchema();

    const { propertyId, message = null } = req.body;
    if (!propertyId) {
      return res.status(400).json({ success: false, message: "Property ID is required" });
    }

    const propertyResult = await pool.query(
      `
        SELECT property_id, owner_id, owner_name, asking_price,
               COALESCE(is_for_sale, FALSE) AS is_for_sale,
               COALESCE(is_frozen, FALSE) AS is_frozen,
               FALSE AS has_co_owners,
               0 AS active_co_owner_count,
               NULL::TEXT AS co_owner_summary,
               COALESCE(is_encumbered, FALSE) AS is_encumbered,
               encumbrance_summary,
               freeze_reason_label,
               status
        FROM properties
        WHERE property_id = $1
        LIMIT 1
      `,
      [propertyId]
    );

    if (propertyResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Property not found" });
    }

    const property = propertyResult.rows[0];
    if (property.owner_id === req.user.userId) {
      return res.status(400).json({ success: false, message: "You cannot request your own property" });
    }
    if (property.is_frozen) {
      return res.status(409).json({
        success: false,
        message: `Property is currently under dispute hold${property.freeze_reason_label ? `: ${property.freeze_reason_label}` : ""}`,
      });
    }
    if (property.is_encumbered) {
      return res.status(409).json({
        success: false,
        message: `Property has an active encumbrance${property.encumbrance_summary ? `: ${property.encumbrance_summary}` : ""}`,
      });
    }
    if (!property.is_for_sale || property.status !== "APPROVED") {
      return res.status(400).json({ success: false, message: "This property is not currently listed" });
    }

    const existing = await pool.query(
      `
        SELECT request_id, status
        FROM property_marketplace_requests
        WHERE property_id = $1
          AND buyer_id = $2
          AND status IN ('PENDING', 'ACCEPTED')
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [propertyId, req.user.userId]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: existing.rows[0].status === "ACCEPTED"
          ? "This request has already been accepted. Open My Transfers to continue."
          : "You already have a pending request for this property.",
      });
    }

    const requestId = buildRequestId();
    const inserted = await pool.query(
      `
        INSERT INTO property_marketplace_requests (
          request_id, property_id, seller_id, buyer_id, status, buyer_message, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, 'PENDING', $5, NOW(), NOW())
        RETURNING *
      `,
      [requestId, propertyId, property.owner_id, req.user.userId, message?.trim() || null]
    );

    return res.status(201).json({
      success: true,
      message: "Buy request sent successfully",
      request: inserted.rows[0],
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/seller/requests", async (req, res) => {
  try {
    await ensureMarketplaceSchema();

    const result = await pool.query(
      `
        SELECT
          r.request_id,
          r.property_id,
          r.status,
          r.buyer_message,
          r.seller_response_note,
          r.transfer_id,
          r.created_at,
          r.responded_at,
          p.district,
          p.tehsil,
          p.mauza,
          p.area_marla,
          p.property_type,
          p.asking_price,
          buyer.user_id AS buyer_id,
          buyer.name AS buyer_name,
          buyer.cnic AS buyer_cnic,
          buyer.email AS buyer_email,
          buyer.mobile AS buyer_mobile
        FROM property_marketplace_requests r
        JOIN properties p ON p.property_id = r.property_id
        LEFT JOIN users buyer ON buyer.user_id = r.buyer_id
        WHERE r.seller_id = $1
        ORDER BY
          CASE r.status
            WHEN 'PENDING' THEN 1
            WHEN 'ACCEPTED' THEN 2
            WHEN 'REJECTED' THEN 3
            ELSE 4
          END,
          r.created_at DESC
      `,
      [req.user.userId]
    );

    return res.json({ success: true, requests: result.rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/request/:requestId/accept", async (req, res) => {
  const client = await pool.connect();

  try {
    await ensureMarketplaceSchema();
    await client.query("BEGIN");

    const requestResult = await client.query(
      `
        SELECT
          r.*,
          p.owner_name,
          p.asking_price,
          p.is_for_sale,
          COALESCE(p.is_frozen, FALSE) AS is_frozen,
          COALESCE(p.is_encumbered, FALSE) AS is_encumbered,
          p.encumbrance_summary,
          p.freeze_reason_label,
          p.status AS property_status,
          buyer.name AS buyer_name,
          buyer.cnic AS buyer_cnic,
          buyer.father_name AS buyer_father_name
        FROM property_marketplace_requests r
        JOIN properties p ON p.property_id = r.property_id
        JOIN users buyer ON buyer.user_id = r.buyer_id
        WHERE r.request_id = $1
          AND r.seller_id = $2
        LIMIT 1
      `,
      [req.params.requestId, req.user.userId]
    );

    if (requestResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Marketplace request not found" });
    }

    const requestRow = requestResult.rows[0];
    if (requestRow.status !== "PENDING") {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "This request is already processed" });
    }

    if (requestRow.is_frozen) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: `Property is currently under dispute hold${requestRow.freeze_reason_label ? `: ${requestRow.freeze_reason_label}` : ""}`,
      });
    }

    if (requestRow.is_encumbered) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: `Property has an active encumbrance${requestRow.encumbrance_summary ? `: ${requestRow.encumbrance_summary}` : ""}`,
      });
    }

    if (!requestRow.is_for_sale || requestRow.property_status !== "APPROVED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "Property is no longer available on marketplace" });
    }

    const activeTransfer = await client.query(
      `
        SELECT transfer_id
        FROM transfer_requests tr
        WHERE tr.property_id = $1
          AND ${activeTransferPredicate("tr")}
        LIMIT 1
      `,
      [requestRow.property_id]
    );

    if (activeTransfer.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "This property already has an active transfer" });
    }

    if (!Number(requestRow.asking_price || 0)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "Set an asking price before accepting a request" });
    }

    const created = await createTransferFromAcceptedRequest(client, requestRow);

    await client.query(
      `
        UPDATE property_marketplace_requests
        SET status = 'ACCEPTED',
            transfer_id = $2,
            responded_at = NOW(),
            updated_at = NOW()
        WHERE request_id = $1
      `,
      [req.params.requestId, created.transferId]
    );

    await client.query(
      `
        UPDATE property_marketplace_requests
        SET status = 'REJECTED',
            seller_response_note = COALESCE(seller_response_note, 'Another buyer request was accepted for this property.'),
            responded_at = NOW(),
            updated_at = NOW()
        WHERE property_id = $1
          AND status = 'PENDING'
          AND request_id <> $2
      `,
      [requestRow.property_id, req.params.requestId]
    );

    await client.query(
      `
        UPDATE properties
        SET is_for_sale = FALSE
        WHERE property_id = $1
      `,
      [requestRow.property_id]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Buyer request accepted. Negotiation channel is ready.",
      transferId: created.transferId,
      channelId: created.channelId,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
});

router.post("/request/:requestId/reject", async (req, res) => {
  try {
    await ensureMarketplaceSchema();

    const { note = "" } = req.body;
    const result = await pool.query(
      `
        UPDATE property_marketplace_requests
        SET status = 'REJECTED',
            seller_response_note = NULLIF($3, ''),
            responded_at = NOW(),
            updated_at = NOW()
        WHERE request_id = $1
          AND seller_id = $2
          AND status = 'PENDING'
        RETURNING request_id
      `,
      [req.params.requestId, req.user.userId, note]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Pending request not found" });
    }

    return res.json({ success: true, message: "Buyer request rejected" });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
