import express from "express";
import jwt from "jsonwebtoken";

import pool from "../config/db.js";

const router = express.Router();
const CREATE_TRANSFER_CASES_SQL = `
  CREATE TABLE IF NOT EXISTS transfer_blockchain_cases (
    transfer_id VARCHAR(120) PRIMARY KEY,
    property_id VARCHAR(120) NOT NULL,
    channel_id VARCHAR(120) UNIQUE NOT NULL,
    transfer_hash VARCHAR(128) NOT NULL,
    agreement_snapshot JSONB NOT NULL,
    status VARCHAR(40) NOT NULL DEFAULT 'VOTING',
    submitted_by_node VARCHAR(60),
    submitted_by_uid VARCHAR(60),
    submitted_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    approval_count INTEGER NOT NULL DEFAULT 0,
    rejection_count INTEGER NOT NULL DEFAULT 0,
    lro_approved_at TIMESTAMPTZ,
    dc_approved_by VARCHAR(60),
    dc_approved_at TIMESTAMPTZ,
    fabric_tx_id VARCHAR(180),
    finalized_fabric_tx_id VARCHAR(180),
    local_block_hash VARCHAR(180),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
`;

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

function validMoney(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeDisplayPrice(row) {
  const candidates = [
    row.receipt_amount,
    row.txn_amount,
    row.agreed_amount,
    row.agreed_price,
    row.transfer_amount,
    row.paid_amount,
    row.total_amount,
  ];

  for (const candidate of candidates) {
    const money = validMoney(candidate);
    if (money !== null) return money;
  }

  return 0;
}

function computePriority(row) {
  let score = 0;

  if (
    String(row.payment_status || "").toUpperCase() === "PAID" ||
    row.challan_txn_id ||
    row.payment_transaction_id ||
    row.payment_completed_at
  ) {
    score += 500;
  }

  if (row.both_agreed_at || (row.seller_agreed && row.buyer_agreed)) score += 250;
  if (row.agreement_screenshot_url || row.agreement_text || row.agreed_price) score += 150;
  if (row.last_message_at) score += 75;
  if (String(row.channel_status || "").toUpperCase() === "PAYMENT_DONE") score += 60;

  return score;
}

function latestTimestamp(row) {
  return new Date(
    row.payment_completed_at || row.both_agreed_at || row.updated_at || row.created_at || 0
  ).getTime();
}

async function loadReviewRows() {
  await pool.query(CREATE_TRANSFER_CASES_SQL);

  const result = await pool.query(
    `SELECT
       tr.transfer_id,
       tr.property_id,
       tr.status,
       tr.payment_status,
       tr.channel_status,
       tr.agreed_price,
       tr.agreed_amount,
       tr.transfer_amount,
       tr.total_amount,
       tr.paid_amount,
       tr.receipt_amount,
       tr.challan_txn_id,
       tr.payment_transaction_id,
       tr.payment_completed_at,
       tr.agreement_screenshot_url,
       tr.agreement_text,
       tr.negotiated_terms,
       tr.seller_agreed,
       tr.buyer_agreed,
       tr.seller_agreed_at,
       tr.buyer_agreed_at,
       tr.both_agreed_at,
       tr.created_at,
       tr.updated_at,
       tr.channel_id,
       tr.approval_notes,
       tbc.status AS voting_status,
       tbc.approval_count,
       tbc.rejection_count,
       tbc.submitted_at AS voting_submitted_at,
       tbc.lro_approved_at,
       p.owner_name AS current_owner,
       p.owner_cnic AS current_owner_cnic,
       p.district,
       p.tehsil,
       p.mauza,
       p.area_marla,
       p.property_type,
       p.khasra_no,
       p.khewat_no,
       seller.name AS seller_name,
       seller.cnic AS seller_cnic,
       buyer.name AS buyer_name,
       buyer.cnic AS buyer_cnic,
       pt.txn_ref,
       pt.amount AS txn_amount,
       pt.sender_account_no,
       pt.receiver_account_no,
       (
         SELECT COUNT(*)
         FROM channel_messages cm
         WHERE cm.channel_id = tr.channel_id
       ) AS message_count,
       (
         SELECT MAX(cm.timestamp)
         FROM channel_messages cm
         WHERE cm.channel_id = tr.channel_id
       ) AS last_message_at
     FROM transfer_requests tr
     LEFT JOIN properties p ON p.property_id = tr.property_id
     LEFT JOIN users seller ON seller.user_id = tr.seller_id
     LEFT JOIN users buyer ON buyer.user_id = tr.buyer_id
     LEFT JOIN payment_transactions pt ON pt.txn_ref = tr.challan_txn_id
     LEFT JOIN transfer_blockchain_cases tbc ON tbc.transfer_id = tr.transfer_id
     WHERE COALESCE(tr.status, '') NOT IN ('REJECTED', 'CANCELLED', 'APPROVED', 'TRANSFERRED', 'EXPIRED')
       AND (
         tr.payment_status = 'PAID'
         OR tr.challan_txn_id IS NOT NULL
         OR (tr.seller_agreed = TRUE AND tr.buyer_agreed = TRUE)
         OR tr.channel_status IN ('PAYMENT_DONE', 'PAYMENT_CONFIRMED', 'AGREED', 'ACTIVE')
       )
     ORDER BY COALESCE(tr.updated_at, tr.created_at) DESC`
  );

  return result.rows;
}

function dedupePropertyWise(rows) {
  const bestByProperty = new Map();

  for (const row of rows) {
    const normalized = { ...row, display_price: normalizeDisplayPrice(row) };
    const current = bestByProperty.get(row.property_id);

    if (!current) {
      bestByProperty.set(row.property_id, normalized);
      continue;
    }

    const currentScore = computePriority(current);
    const nextScore = computePriority(normalized);

    if (nextScore > currentScore) {
      bestByProperty.set(row.property_id, normalized);
      continue;
    }

    if (nextScore === currentScore && latestTimestamp(normalized) > latestTimestamp(current)) {
      bestByProperty.set(row.property_id, normalized);
    }
  }

  return Array.from(bestByProperty.values()).sort(
    (a, b) => latestTimestamp(b) - latestTimestamp(a)
  );
}

router.get("/lro/review", authenticateToken, requireOfficer, async (req, res) => {
  try {
    const rows = await loadReviewRows();
    const search = String(req.query.search || "").trim();
    const digits = search.replace(/\D/g, "");
    let transfers = dedupePropertyWise(rows);

    if (digits) {
      transfers = transfers.filter((item) =>
        [
          item.current_owner_cnic,
          item.seller_cnic,
          item.buyer_cnic,
        ].some((cnic) => String(cnic || "").replace(/\D/g, "").includes(digits))
      );
    }

    return res.json({
      success: true,
      deduped: true,
      search,
      transfers,
      statistics: {
        total: transfers.length,
        withScreenshot: transfers.filter((item) => item.agreement_screenshot_url).length,
        approvedToday: transfers.filter(
          (item) =>
            item.approved_at &&
            new Date(item.approved_at).toDateString() === new Date().toDateString()
        ).length,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/lro/review/:propertyId", authenticateToken, requireOfficer, async (req, res) => {
  try {
    const rows = await loadReviewRows();
    const transfers = dedupePropertyWise(rows).filter(
      (item) => item.property_id === req.params.propertyId
    );

    return res.json({
      success: true,
      propertyId: req.params.propertyId,
      transfers,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
