import express from "express";
import jwt from "jsonwebtoken";

import pool from "../config/db.js";
import p2pSchemaService from "../services/p2pSchema.service.js";
import channelService from "../services/channel.service.js";
import { findNodeByUserId, findNodeFromEmail } from "../config/plraNodes.js";

const router = express.Router();

let schemaReady = false;

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

async function ensureNotificationSchema() {
  if (schemaReady) return;

  await p2pSchemaService.ensureSchema();

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

  schemaReady = true;
}

function buildNotification({
  id,
  type,
  priority = "medium",
  title,
  body,
  actionPath = null,
  actionLabel = null,
  occurredAt = null,
  meta = {},
}) {
  return {
    id,
    type,
    priority,
    title,
    body,
    actionPath,
    actionLabel,
    occurredAt,
    meta,
  };
}

function priorityRank(priority) {
  return { critical: 0, high: 1, medium: 2, low: 3 }[priority] ?? 4;
}

function sortAndTrimNotifications(notifications, limit = 8) {
  return [...notifications]
    .sort((a, b) => {
      const timeDiff = new Date(b.occurredAt || 0).getTime() - new Date(a.occurredAt || 0).getTime();
      if (timeDiff !== 0) return timeDiff;
      return priorityRank(a.priority) - priorityRank(b.priority);
    })
    .slice(0, limit);
}

async function resolveMappedNode(userId) {
  const mapped = findNodeByUserId(userId);
  if (mapped) return mapped;

  const userResult = await pool.query(
    "SELECT email FROM users WHERE user_id = $1 LIMIT 1",
    [userId]
  );

  return findNodeFromEmail(userResult.rows[0]?.email) || null;
}

async function getLedgerTableAvailability() {
  const result = await pool.query(`
    SELECT
      to_regclass('public.reg_blockchain_cases') AS reg_cases,
      to_regclass('public.reg_blockchain_votes') AS reg_votes,
      to_regclass('public.transfer_blockchain_cases') AS transfer_cases,
      to_regclass('public.transfer_blockchain_votes') AS transfer_votes
  `);

  const row = result.rows[0] || {};
  return {
    regCases: Boolean(row.reg_cases),
    regVotes: Boolean(row.reg_votes),
    transferCases: Boolean(row.transfer_cases),
    transferVotes: Boolean(row.transfer_votes),
  };
}

async function loadCitizenFeed(userId) {
  const [
    receiptPendingResult,
    sellerRequestsResult,
    approvedPropertiesResult,
    recentTransferDecisionsResult,
    channelResponse,
  ] = await Promise.all([
    pool.query(
      `
        SELECT
          transfer_id,
          property_id,
          channel_id,
          challan_txn_id,
          COALESCE(payment_completed_at, updated_at, created_at) AS occurred_at
        FROM transfer_requests
        WHERE buyer_id = $1
          AND channel_id IS NOT NULL
          AND (
            payment_status = 'PAID'
            OR challan_txn_id IS NOT NULL
          )
          AND agreement_screenshot_url IS NULL
        ORDER BY COALESCE(payment_completed_at, updated_at, created_at) DESC
        LIMIT 4
      `,
      [userId]
    ),
    pool.query(
      `
        SELECT
          r.request_id,
          r.property_id,
          r.created_at AS occurred_at,
          p.asking_price,
          buyer.name AS buyer_name
        FROM property_marketplace_requests r
        LEFT JOIN properties p ON p.property_id = r.property_id
        LEFT JOIN users buyer ON buyer.user_id = r.buyer_id
        WHERE r.seller_id = $1
          AND r.status = 'PENDING'
        ORDER BY r.created_at DESC
        LIMIT 4
      `,
      [userId]
    ),
    pool.query(
      `
        SELECT
          property_id,
          district,
          tehsil,
          mauza,
          COALESCE(listed_at, updated_at, created_at) AS occurred_at
        FROM properties
        WHERE owner_id = $1
          AND status = 'APPROVED'
          AND COALESCE(is_for_sale, FALSE) = FALSE
        ORDER BY COALESCE(updated_at, created_at) DESC
        LIMIT 3
      `,
      [userId]
    ),
    pool.query(
      `
        SELECT
          transfer_id,
          property_id,
          status,
          COALESCE(approved_at, rejected_at, updated_at, created_at) AS occurred_at
        FROM transfer_requests
        WHERE (seller_id = $1 OR buyer_id = $1)
          AND status IN ('APPROVED', 'REJECTED')
        ORDER BY COALESCE(approved_at, rejected_at, updated_at, created_at) DESC
        LIMIT 4
      `,
      [userId]
    ),
    channelService.getUserChannels(userId),
  ]);

  const notifications = [];

  for (const item of receiptPendingResult.rows) {
    notifications.push(
      buildNotification({
        id: `receipt-${item.transfer_id}`,
        type: "RECEIPT_PENDING",
        priority: "critical",
        title: "Paid transfer is waiting for receipt upload",
        body: `Transfer ${item.transfer_id} for ${item.property_id} is paid. Send the receipt to LRO so officer review can start.`,
        actionPath: `/citizen/challan-payment?transferId=${item.transfer_id}&channelId=${item.channel_id}&role=BUYER`,
        actionLabel: "Send Receipt to LRO",
        occurredAt: item.occurred_at,
        meta: { transferId: item.transfer_id, propertyId: item.property_id, channelId: item.channel_id },
      })
    );
  }

  for (const item of sellerRequestsResult.rows) {
    notifications.push(
      buildNotification({
        id: `seller-request-${item.request_id}`,
        type: "SELLER_REQUEST_PENDING",
        priority: "high",
        title: "A buyer request is waiting in Seller Portal",
        body: `${item.buyer_name || "A buyer"} is interested in ${item.property_id}. Accept or reject the request to keep the marketplace flow moving.`,
        actionPath: "/citizen/seller",
        actionLabel: "Open Seller Portal",
        occurredAt: item.occurred_at,
        meta: { requestId: item.request_id, propertyId: item.property_id, askingPrice: item.asking_price },
      })
    );
  }

  for (const item of (channelResponse.channels || [])
    .filter(
      (channel) =>
        ["ACTIVE", "NEGOTIATING", "AGREED", "PAYMENT_DONE", "PAYMENT_CONFIRMED"].includes(
          String(channel.channel_status || "").toUpperCase()
        ) && Number(channel.unread_count || 0) > 0
    )
    .slice(0, 4)) {
    notifications.push(
      buildNotification({
        id: `channel-${item.channel_id}`,
        type: "NEGOTIATION_ACTIVITY",
        priority: "medium",
        title: "New activity in negotiation chat",
        body: `${item.property_id || item.channel_id} has ${item.unread_count} unread update${Number(item.unread_count) === 1 ? "" : "s"} waiting for you.`,
        actionPath: `/citizen/negotiation?channelId=${item.channel_id}&transferId=${item.transfer_id || ""}`,
        actionLabel: "Open Chat",
        occurredAt: item.last_message_at || item.channel_created_at,
        meta: { channelId: item.channel_id, transferId: item.transfer_id, unreadCount: Number(item.unread_count || 0) },
      })
    );
  }

  for (const item of approvedPropertiesResult.rows) {
    notifications.push(
      buildNotification({
        id: `approved-property-${item.property_id}`,
        type: "PROPERTY_READY",
        priority: "low",
        title: "Approved property is ready for the next step",
        body: `${item.property_id} is approved and visible in your citizen record. You can keep it, list it for sale, or prepare future succession work later.`,
        actionPath: "/citizen/my-properties",
        actionLabel: "View Property",
        occurredAt: item.occurred_at,
        meta: { propertyId: item.property_id, district: item.district, tehsil: item.tehsil, mauza: item.mauza },
      })
    );
  }

  for (const item of recentTransferDecisionsResult.rows) {
    const approved = String(item.status || "").toUpperCase() === "APPROVED";
    notifications.push(
      buildNotification({
        id: `transfer-decision-${item.transfer_id}`,
        type: approved ? "TRANSFER_APPROVED" : "TRANSFER_REJECTED",
        priority: approved ? "medium" : "high",
        title: approved ? "Transfer finalized successfully" : "Transfer decision needs review",
        body: approved
          ? `Transfer ${item.transfer_id} for ${item.property_id} has been finalized. The ownership record should now be reflected in your property workspace.`
          : `Transfer ${item.transfer_id} for ${item.property_id} was rejected. Open the transfer inbox to review the latest status and next step.`,
        actionPath: approved ? "/citizen/my-properties" : "/citizen/transfers",
        actionLabel: approved ? "View Properties" : "Open Transfer Inbox",
        occurredAt: item.occurred_at,
        meta: { transferId: item.transfer_id, propertyId: item.property_id, status: item.status },
      })
    );
  }

  const trimmed = sortAndTrimNotifications(notifications);
  return {
    summary: {
      total: trimmed.length,
      critical: trimmed.filter((item) => item.priority === "critical").length,
      unreadChats: trimmed
        .filter((item) => item.type === "NEGOTIATION_ACTIVITY")
        .reduce((sum, item) => sum + Number(item.meta?.unreadCount || 0), 0),
      pendingSellerRequests: sellerRequestsResult.rows.length,
      receiptPending: receiptPendingResult.rows.length,
      coOwnerActionsPending: 0,
    },
    notifications: trimmed,
  };
}

async function loadLroFeed(userId) {
  const node = await resolveMappedNode(userId);
  const tables = await getLedgerTableAvailability();

  const transferIntakeQuery = tables.transferCases
    ? `
        SELECT
          tr.transfer_id,
          tr.property_id,
          tr.payment_completed_at,
          p.district,
          p.tehsil,
          seller.name AS seller_name,
          buyer.name AS buyer_name
        FROM transfer_requests tr
        LEFT JOIN properties p ON p.property_id = tr.property_id
        LEFT JOIN users seller ON seller.user_id = tr.seller_id
        LEFT JOIN users buyer ON buyer.user_id = tr.buyer_id
        LEFT JOIN transfer_blockchain_cases tbc ON tbc.transfer_id = tr.transfer_id
        WHERE (tr.payment_status = 'PAID' OR tr.challan_txn_id IS NOT NULL)
          AND COALESCE(tr.seller_agreed, FALSE) = TRUE
          AND COALESCE(tr.buyer_agreed, FALSE) = TRUE
          AND COALESCE(tr.channel_id, '') <> ''
          AND (
            tbc.transfer_id IS NULL
            OR UPPER(COALESCE(tbc.status, '')) = 'REJECTED'
          )
        ORDER BY COALESCE(tr.payment_completed_at, tr.updated_at, tr.created_at) DESC
        LIMIT 4
      `
    : `
        SELECT
          tr.transfer_id,
          tr.property_id,
          tr.payment_completed_at,
          p.district,
          p.tehsil,
          seller.name AS seller_name,
          buyer.name AS buyer_name
        FROM transfer_requests tr
        LEFT JOIN properties p ON p.property_id = tr.property_id
        LEFT JOIN users seller ON seller.user_id = tr.seller_id
        LEFT JOIN users buyer ON buyer.user_id = tr.buyer_id
        WHERE (tr.payment_status = 'PAID' OR tr.challan_txn_id IS NOT NULL)
          AND COALESCE(tr.seller_agreed, FALSE) = TRUE
          AND COALESCE(tr.buyer_agreed, FALSE) = TRUE
          AND COALESCE(tr.channel_id, '') <> ''
        ORDER BY COALESCE(tr.payment_completed_at, tr.updated_at, tr.created_at) DESC
        LIMIT 4
      `;

  const [intakeRegistrationsResult, intakeTransfersResult] = await Promise.all([
    pool.query(
      `
        SELECT property_id, owner_name, district, tehsil, mauza, created_at
        FROM properties
        WHERE UPPER(COALESCE(status, '')) = 'PENDING'
        ORDER BY COALESCE(updated_at, created_at) DESC
        LIMIT 4
      `
    ),
    pool.query(transferIntakeQuery),
  ]);

  let registrationVotesWaiting = [];
  let transferVotesWaiting = [];

  if (node && tables.regCases && tables.regVotes) {
    const result = await pool.query(
      `
        SELECT
          rbc.property_id,
          COALESCE(rbc.updated_at, rbc.submitted_at, rbc.created_at) AS occurred_at,
          p.owner_name,
          p.district,
          p.tehsil
        FROM reg_blockchain_cases rbc
        JOIN properties p ON p.property_id = rbc.property_id
        LEFT JOIN reg_blockchain_votes rv
          ON rv.property_id = rbc.property_id
         AND rv.lro_node_id = $1
        WHERE UPPER(COALESCE(rbc.status, '')) = 'VOTING'
          AND rv.property_id IS NULL
        ORDER BY COALESCE(rbc.updated_at, rbc.submitted_at, rbc.created_at) DESC
        LIMIT 4
      `,
      [node.nodeId]
    );
    registrationVotesWaiting = result.rows;
  }

  if (node && tables.transferCases && tables.transferVotes) {
    const result = await pool.query(
      `
        SELECT
          tbc.transfer_id,
          tbc.property_id,
          COALESCE(tbc.updated_at, tbc.submitted_at, tbc.created_at) AS occurred_at,
          tr.buyer_id,
          seller.name AS seller_name,
          buyer.name AS buyer_name
        FROM transfer_blockchain_cases tbc
        LEFT JOIN transfer_requests tr ON tr.transfer_id = tbc.transfer_id
        LEFT JOIN users seller ON seller.user_id = tr.seller_id
        LEFT JOIN users buyer ON buyer.user_id = tr.buyer_id
        LEFT JOIN transfer_blockchain_votes tbv
          ON tbv.transfer_id = tbc.transfer_id
         AND tbv.lro_node_id = $1
        WHERE UPPER(COALESCE(tbc.status, '')) = 'VOTING'
          AND tbv.transfer_id IS NULL
        ORDER BY COALESCE(tbc.updated_at, tbc.submitted_at, tbc.created_at) DESC
        LIMIT 4
      `,
      [node.nodeId]
    );
    transferVotesWaiting = result.rows;
  }

  const notifications = [];

  if (!node) {
    notifications.push(
      buildNotification({
        id: `lro-node-mapping-${userId}`,
        type: "NODE_MAPPING_MISSING",
        priority: "critical",
        title: "This LRO login is not mapped to a Fabric voting node",
        body: "Voting screens may not let this account submit or cast blockchain votes until the node mapping is repaired.",
        actionPath: "/lro/dashboard",
        actionLabel: "Review Dashboard",
        occurredAt: new Date().toISOString(),
        meta: { userId },
      })
    );
  }

  for (const item of intakeRegistrationsResult.rows) {
    notifications.push(
      buildNotification({
        id: `lro-reg-intake-${item.property_id}`,
        type: "REGISTRATION_INTAKE",
        priority: "high",
        title: "New registration intake is waiting",
        body: `${item.property_id} for ${item.owner_name || "the applicant"} is ready for LRO review before it enters node voting.`,
        actionPath: "/lro/pending-registrations",
        actionLabel: "Open Registration Intake",
        occurredAt: item.created_at,
        meta: { propertyId: item.property_id, district: item.district, tehsil: item.tehsil, mauza: item.mauza },
      })
    );
  }

  for (const item of intakeTransfersResult.rows) {
    notifications.push(
      buildNotification({
        id: `lro-transfer-intake-${item.transfer_id}`,
        type: "TRANSFER_INTAKE",
        priority: "high",
        title: "Paid transfer is ready for LRO submission",
        body: `${item.transfer_id} for ${item.property_id} has completed payment and agreement confirmation. Move it into the 5-node transfer voting flow.`,
        actionPath: "/lro/pending-transfers",
        actionLabel: "Open Pending Transfers",
        occurredAt: item.payment_completed_at,
        meta: { transferId: item.transfer_id, propertyId: item.property_id, sellerName: item.seller_name, buyerName: item.buyer_name },
      })
    );
  }

  for (const item of registrationVotesWaiting) {
    notifications.push(
      buildNotification({
        id: `lro-reg-vote-${item.property_id}`,
        type: "REGISTRATION_VOTE_WAITING",
        priority: "medium",
        title: "A registration case is waiting for this node vote",
        body: `${item.property_id} is still in registration voting and your mapped node has not voted yet.`,
        actionPath: "/lro/blockchain",
        actionLabel: "Cast Registration Vote",
        occurredAt: item.occurred_at,
        meta: { propertyId: item.property_id, ownerName: item.owner_name },
      })
    );
  }

  for (const item of transferVotesWaiting) {
    notifications.push(
      buildNotification({
        id: `lro-transfer-vote-${item.transfer_id}`,
        type: "TRANSFER_VOTE_WAITING",
        priority: "medium",
        title: "A transfer case is waiting for this node vote",
        body: `${item.transfer_id} for ${item.property_id} is in transfer voting and still needs this node's decision.`,
        actionPath: "/lro/transfer-voting",
        actionLabel: "Cast Transfer Vote",
        occurredAt: item.occurred_at,
        meta: { transferId: item.transfer_id, propertyId: item.property_id, sellerName: item.seller_name, buyerName: item.buyer_name },
      })
    );
  }

  const trimmed = sortAndTrimNotifications(notifications);
  return {
    summary: {
      total: trimmed.length,
      registrationIntake: intakeRegistrationsResult.rows.length,
      pendingTransferSubmissions: intakeTransfersResult.rows.length,
      registrationVotesWaiting: registrationVotesWaiting.length,
      transferVotesWaiting: transferVotesWaiting.length,
      mappedNode: node?.nodeId || null,
    },
    notifications: trimmed,
  };
}

async function loadDcFeed() {
  const tables = await getLedgerTableAvailability();
  const notifications = [];

  let readyRegistrationRows = [];
  let readyTransferRows = [];

  if (tables.regCases && tables.regVotes) {
    const result = await pool.query(
      `
        SELECT
          rbc.property_id,
          p.owner_name,
          p.district,
          p.tehsil,
          COALESCE(rbc.lro_approved_at, rbc.updated_at, rbc.submitted_at, rbc.created_at) AS occurred_at,
          COALESCE(rv.approvals, 0) AS approvals
        FROM reg_blockchain_cases rbc
        JOIN properties p ON p.property_id = rbc.property_id
        LEFT JOIN (
          SELECT property_id,
                 SUM(CASE WHEN UPPER(vote) = 'APPROVE' THEN 1 ELSE 0 END)::int AS approvals
          FROM reg_blockchain_votes
          GROUP BY property_id
        ) rv ON rv.property_id = rbc.property_id
        WHERE UPPER(COALESCE(rbc.status, '')) = 'READY_FOR_DC'
           OR (
             UPPER(COALESCE(rbc.status, '')) NOT IN ('FINALIZED', 'REJECTED')
             AND COALESCE(rv.approvals, 0) >= 3
           )
        ORDER BY COALESCE(rbc.updated_at, rbc.created_at, rbc.submitted_at) DESC
        LIMIT 4
      `
    );
    readyRegistrationRows = result.rows;
  }

  if (tables.transferCases && tables.transferVotes) {
    const result = await pool.query(
      `
        SELECT
          tbc.transfer_id,
          tbc.property_id,
          COALESCE(tbc.lro_approved_at, tbc.updated_at, tbc.submitted_at, tbc.created_at) AS occurred_at,
          seller.name AS seller_name,
          buyer.name AS buyer_name,
          COALESCE(tv.approvals, 0) AS approvals
        FROM transfer_blockchain_cases tbc
        LEFT JOIN transfer_requests tr ON tr.transfer_id = tbc.transfer_id
        LEFT JOIN users seller ON seller.user_id = tr.seller_id
        LEFT JOIN users buyer ON buyer.user_id = tr.buyer_id
        LEFT JOIN (
          SELECT transfer_id,
                 SUM(CASE WHEN UPPER(vote) = 'APPROVE' THEN 1 ELSE 0 END)::int AS approvals
          FROM transfer_blockchain_votes
          GROUP BY transfer_id
        ) tv ON tv.transfer_id = tbc.transfer_id
        WHERE UPPER(COALESCE(tbc.status, '')) = 'READY_FOR_DC'
           OR (
             UPPER(COALESCE(tbc.status, '')) NOT IN ('FINALIZED', 'REJECTED')
             AND COALESCE(tv.approvals, 0) >= 3
           )
        ORDER BY COALESCE(tbc.updated_at, tbc.created_at, tbc.submitted_at) DESC
        LIMIT 4
      `
    );
    readyTransferRows = result.rows;
  }

  for (const item of readyRegistrationRows) {
    notifications.push(
      buildNotification({
        id: `dc-reg-ready-${item.property_id}`,
        type: "DC_REGISTRATION_READY",
        priority: "high",
        title: "A registration case is ready for DC decision",
        body: `${item.property_id} already crossed the LRO threshold and is waiting for final registration approval or rejection.`,
        actionPath: "/dc/dashboard",
        actionLabel: "Open Registration Queue",
        occurredAt: item.occurred_at,
        meta: { propertyId: item.property_id, ownerName: item.owner_name, approvals: item.approvals },
      })
    );
  }

  for (const item of readyTransferRows) {
    notifications.push(
      buildNotification({
        id: `dc-transfer-ready-${item.transfer_id}`,
        type: "DC_TRANSFER_READY",
        priority: "high",
        title: "A transfer case is ready for DC decision",
        body: `${item.transfer_id} for ${item.property_id} is waiting for final transfer approval after the LRO voting threshold was met.`,
        actionPath: "/dc/transfers",
        actionLabel: "Open Transfer Queue",
        occurredAt: item.occurred_at,
        meta: { transferId: item.transfer_id, propertyId: item.property_id, sellerName: item.seller_name, buyerName: item.buyer_name, approvals: item.approvals },
      })
    );
  }

  const trimmed = sortAndTrimNotifications(notifications);
  return {
    summary: {
      total: trimmed.length,
      readyRegistrationDecisions: readyRegistrationRows.length,
      readyTransferDecisions: readyTransferRows.length,
    },
    notifications: trimmed,
  };
}

router.get("/feed", authenticateToken, async (req, res) => {
  try {
    await ensureNotificationSchema();

    const userId = req.user.userId;
    const role = String(req.user.role || "").toUpperCase();

    let payload = null;
    if (role === "CITIZEN") {
      payload = await loadCitizenFeed(userId);
    } else if (["LRO", "LAND RECORD OFFICER"].includes(role)) {
      payload = await loadLroFeed(userId);
    } else if (["DC", "ADMIN"].includes(role)) {
      payload = await loadDcFeed();
    } else {
      return res.status(403).json({
        success: false,
        message: "Notification feed is not available for this role",
      });
    }

    return res.json({
      success: true,
      role,
      ...payload,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Notification feed failed:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
