import crypto from "crypto";
import express from "express";
import jwt from "jsonwebtoken";

import pool from "../config/db.js";
import blockchainService from "../services/blockchain.service.js";
import channelService from "../services/channel.service.js";
import propertyEncumbranceService from "../services/propertyEncumbrance.service.js";
import fabricGatewayService from "../services/fabricGateway.service.js";
import ownershipHistoryService from "../services/ownershipHistory.service.js";
import propertyFreezeService from "../services/propertyFreeze.service.js";
import propertyRegistryIntegrityService from "../services/propertyRegistryIntegrity.service.js";
import { findNodeById, findNodeByUserId, findNodeFromEmail } from "../config/plraNodes.js";

const router = express.Router();
const VOTE_THRESHOLD = 3;
const TRANSFER_CASE_STATUSES = ["SUBMITTED", "VOTING", "READY_FOR_DC", "FINALIZED", "REJECTED"];

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

const CREATE_TRANSFER_VOTES_SQL = `
  CREATE TABLE IF NOT EXISTS transfer_blockchain_votes (
    vote_id BIGSERIAL PRIMARY KEY,
    transfer_id VARCHAR(120) NOT NULL,
    property_id VARCHAR(120) NOT NULL,
    channel_id VARCHAR(120) NOT NULL,
    lro_node_id VARCHAR(60) NOT NULL,
    lro_name VARCHAR(120),
    lro_user_id VARCHAR(60),
    vote VARCHAR(20) NOT NULL,
    reason TEXT,
    transfer_hash VARCHAR(128),
    tx_id VARCHAR(180),
    voted_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (transfer_id, lro_node_id)
  )
`;

let transferVotingSchemaReadyPromise = null;

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

function requireRole(allowed) {
  return (req, res, next) => {
    const role = String(req.user?.role || "").toUpperCase();
    if (!allowed.includes(role)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }
    next();
  };
}

async function ensureTransferVotingSchema() {
  if (!transferVotingSchemaReadyPromise) {
    transferVotingSchemaReadyPromise = (async () => {
      await pool.query(CREATE_TRANSFER_CASES_SQL);
      await pool.query(CREATE_TRANSFER_VOTES_SQL);
      await pool.query(`ALTER TABLE transfer_requests ADD COLUMN IF NOT EXISTS approved_by VARCHAR(60)`);
      await pool.query(`ALTER TABLE transfer_requests ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`);
      await pool.query(`ALTER TABLE transfer_requests ADD COLUMN IF NOT EXISTS approval_notes TEXT`);
      await pool.query(`ALTER TABLE transfer_requests ADD COLUMN IF NOT EXISTS rejection_reason TEXT`);
      await pool.query(`
        UPDATE transfer_blockchain_cases
        SET status = CASE UPPER(COALESCE(status, ''))
          WHEN 'PENDING' THEN 'VOTING'
          WHEN 'SUBMITTED_FOR_LRO_VOTING' THEN 'VOTING'
          WHEN 'READY' THEN 'READY_FOR_DC'
          WHEN 'APPROVED' THEN 'FINALIZED'
          WHEN 'DC_APPROVED' THEN 'FINALIZED'
          ELSE status
        END
      `);
      await pool.query(`
        ALTER TABLE transfer_blockchain_cases
        DROP CONSTRAINT IF EXISTS transfer_blockchain_cases_status_check
      `);
      await pool.query(`
        ALTER TABLE transfer_blockchain_cases
        ADD CONSTRAINT transfer_blockchain_cases_status_check
        CHECK (UPPER(status) = ANY (ARRAY['SUBMITTED','VOTING','READY_FOR_DC','FINALIZED','REJECTED']))
      `);
    })().catch((error) => {
      transferVotingSchemaReadyPromise = null;
      throw error;
    });
  }

  return transferVotingSchemaReadyPromise;
}

async function ensureTables() {
  await ensureTransferVotingSchema();
}

async function resolveNode(userId) {
  const mapped = findNodeByUserId(userId);
  if (mapped) return mapped;

  const userResult = await pool.query(
    "SELECT email FROM users WHERE user_id = $1 LIMIT 1",
    [userId]
  );
  const fromEmail = findNodeFromEmail(userResult.rows[0]?.email);
  return fromEmail || null;
}

function normalizeMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : 0;
}

router.use(async (_req, res, next) => {
  try {
    await ensureTransferVotingSchema();
    next();
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

function buildAgreementSnapshot(transfer) {
  return {
    transferId: transfer.transfer_id,
    propertyId: transfer.property_id,
    channelId: transfer.channel_id,
    seller: {
      userId: transfer.seller_id,
      name: transfer.seller_name,
      cnic: transfer.seller_cnic,
      fatherName: transfer.owner_father_name || transfer.seller_father_name || null,
    },
    buyer: {
      userId: transfer.buyer_id,
      name: transfer.buyer_name,
      cnic: transfer.buyer_cnic,
      fatherName: transfer.buyer_father_name || null,
    },
    property: {
      district: transfer.district,
      tehsil: transfer.tehsil,
      mauza: transfer.mauza,
      areaMarla: transfer.area_marla,
      propertyType: transfer.property_type,
      khasraNo: transfer.khasra_no,
      khewatNo: transfer.khewat_no,
      khatooniNo: transfer.khatooni_no,
    },
    payment: {
      agreedAmount: normalizeMoney(
        transfer.agreed_price ||
          transfer.agreed_amount ||
          transfer.transfer_amount ||
          transfer.paid_amount ||
          transfer.total_amount
      ),
      paidAmount: normalizeMoney(
        transfer.paid_amount ||
          transfer.transfer_amount ||
          transfer.agreed_price ||
          transfer.total_amount
      ),
      paymentStatus: transfer.payment_status || null,
      challanTxnId: transfer.challan_txn_id || null,
      paymentCompletedAt: transfer.payment_completed_at || null,
    },
    agreement: {
      sellerAgreed: Boolean(transfer.seller_agreed),
      buyerAgreed: Boolean(transfer.buyer_agreed),
      bothAgreedAt: transfer.both_agreed_at || null,
      channelStatus: transfer.channel_status || null,
      negotiatedTerms: transfer.negotiated_terms || null,
    },
  };
}

function hashSnapshot(snapshot) {
  return crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

async function getVoteTotals(client, transferId) {
  const result = await client.query(
    `SELECT
       COUNT(*)::int AS votes,
       SUM(CASE WHEN UPPER(vote) = 'APPROVE' THEN 1 ELSE 0 END)::int AS approvals,
       SUM(CASE WHEN UPPER(vote) = 'REJECT' THEN 1 ELSE 0 END)::int AS rejections
     FROM transfer_blockchain_votes
     WHERE transfer_id = $1`,
    [transferId]
  );

  const row = result.rows[0] || {};
  return {
    votes: Number(row.votes || 0),
    approvals: Number(row.approvals || 0),
    rejections: Number(row.rejections || 0),
  };
}

async function syncCaseState(client, transferId) {
  const totals = await getVoteTotals(client, transferId);
  let nextCaseStatus = "VOTING";
  const shouldStampApproval = totals.approvals >= VOTE_THRESHOLD;

  if (shouldStampApproval) nextCaseStatus = "READY_FOR_DC";
  if (totals.rejections >= VOTE_THRESHOLD) nextCaseStatus = "REJECTED";

  await client.query(
    `UPDATE transfer_blockchain_cases
     SET approval_count = $2,
         rejection_count = $3,
         status = $4,
         lro_approved_at = CASE
           WHEN $5 AND lro_approved_at IS NULL THEN NOW()
           ELSE lro_approved_at
         END,
         updated_at = NOW()
     WHERE transfer_id = $1`,
    [transferId, totals.approvals, totals.rejections, nextCaseStatus, shouldStampApproval]
  );

  await updateTransferRequestVotingState(client, transferId, nextCaseStatus);

  return totals;
}

function isAlreadyVotedError(errorMessage = "") {
  return /node\s+.+\s+already voted/i.test(String(errorMessage || ""));
}

function isAgreementNotFoundError(errorMessage = "") {
  return /agreement not found:/i.test(String(errorMessage || ""));
}

function extractTransferVoteEntry(chainRecord, nodeId) {
  if (!chainRecord || typeof chainRecord !== "object") return null;

  const approvals = Array.isArray(chainRecord.approvals) ? chainRecord.approvals : [];
  const rejections = Array.isArray(chainRecord.rejections) ? chainRecord.rejections : [];

  const approvedEntry = approvals.find((entry) => entry?.nodeId === nodeId);
  if (approvedEntry) {
    return {
      vote: "APPROVE",
      reason: approvedEntry.reason || "",
      txId: approvedEntry.txId || null,
      votedAt: approvedEntry.votedAt || null,
    };
  }

  const rejectedEntry = rejections.find((entry) => entry?.nodeId === nodeId);
  if (rejectedEntry) {
    return {
      vote: "REJECT",
      reason: rejectedEntry.reason || "",
      txId: rejectedEntry.txId || null,
      votedAt: rejectedEntry.votedAt || null,
    };
  }

  return null;
}

function extractAllTransferVotes(chainRecord) {
  if (!chainRecord || typeof chainRecord !== "object") return [];

  const approvals = Array.isArray(chainRecord.approvals) ? chainRecord.approvals : [];
  const rejections = Array.isArray(chainRecord.rejections) ? chainRecord.rejections : [];

  return [
    ...approvals.map((entry) => ({ ...entry, vote: "APPROVE" })),
    ...rejections.map((entry) => ({ ...entry, vote: "REJECT" })),
  ].filter((entry) => entry?.nodeId);
}

async function getTransferCase(client, transferId) {
  const result = await client.query(
    `SELECT
       tbc.*,
       tr.property_id,
       tr.channel_id,
       tr.status AS transfer_status,
       tr.payment_status,
       tr.challan_txn_id,
       tr.payment_transaction_id,
       tr.payment_completed_at,
       tr.transfer_amount,
       tr.total_amount,
       tr.agreed_price,
       tr.agreed_amount,
       tr.paid_amount,
       tr.seller_id,
       tr.buyer_id,
       tr.seller_agreed,
       tr.buyer_agreed,
       tr.both_agreed_at,
       tr.negotiated_terms,
       tr.channel_status,
       tr.approval_notes,
       tr.rejection_reason,
       p.owner_name,
       p.owner_cnic,
       p.father_name AS owner_father_name,
       p.district,
       p.tehsil,
       p.mauza,
       p.area_marla,
       p.property_type,
       p.khasra_no,
       p.khewat_no,
       p.khatooni_no,
       seller.name AS seller_name,
       seller.cnic AS seller_cnic,
       seller.father_name AS seller_father_name,
       buyer.name AS buyer_name,
       buyer.cnic AS buyer_cnic,
       buyer.father_name AS buyer_father_name
     FROM transfer_blockchain_cases tbc
     JOIN transfer_requests tr ON tr.transfer_id = tbc.transfer_id
     LEFT JOIN properties p ON p.property_id = tr.property_id
     LEFT JOIN users seller ON seller.user_id = tr.seller_id
     LEFT JOIN users buyer ON buyer.user_id = tr.buyer_id
     WHERE tbc.transfer_id = $1
     LIMIT 1`,
    [transferId]
  );

  return result.rows[0] || null;
}

async function buildQueueRow(client, transferId, currentUserId = null) {
  const [caseRecord, voteResult] = await Promise.all([
    getTransferCase(client, transferId),
    client.query(
      `SELECT
         transfer_id,
         property_id,
         channel_id,
         lro_node_id,
         lro_name,
         lro_user_id,
         vote,
         reason,
         tx_id,
         voted_at
       FROM transfer_blockchain_votes
       WHERE transfer_id = $1
       ORDER BY voted_at DESC`,
      [transferId]
    ),
  ]);

  if (!caseRecord) return null;

  const currentNode = currentUserId ? await resolveNode(currentUserId) : null;
  const currentVote =
    currentNode &&
    voteResult.rows.find((vote) => vote.lro_node_id === currentNode.nodeId);

  return {
    ...caseRecord,
    votes: voteResult.rows,
    currentUserVote: currentVote || null,
    canVote:
      String(caseRecord.status).toUpperCase() === "VOTING" &&
      !currentVote &&
      !!currentNode,
    approvals: Number(caseRecord.approval_count || 0),
    rejections: Number(caseRecord.rejection_count || 0),
    threshold: VOTE_THRESHOLD,
    displayAmount: normalizeMoney(
      caseRecord.paid_amount ||
        caseRecord.agreed_price ||
        caseRecord.agreed_amount ||
        caseRecord.transfer_amount ||
        caseRecord.total_amount
    ),
  };
}

async function getTableColumns(client, tableName) {
  const result = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName]
  );
  return result.rows.map((row) => row.column_name);
}

async function updateTransferRequestFields(client, transferId, fieldValues = {}) {
  const columns = await getTableColumns(client, "transfer_requests");
  const values = [transferId];
  const assignments = [];

  for (const [column, value] of Object.entries(fieldValues)) {
    if (!columns.includes(column)) continue;
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  }

  if (columns.includes("updated_at")) {
    assignments.push("updated_at = NOW()");
  }

  if (!assignments.length) return;

  await client.query(
    `UPDATE transfer_requests
     SET ${assignments.join(", ")}
     WHERE transfer_id = $1`,
    values
  );
}

async function updateTransferRequestVotingState(client, transferId, nextStatus, extraFields = {}) {
  const savepointName = "transfer_request_status_sp";
  await client.query(`SAVEPOINT ${savepointName}`);

  try {
    await updateTransferRequestFields(client, transferId, {
      status: nextStatus,
      ...extraFields,
    });
    await client.query(`RELEASE SAVEPOINT ${savepointName}`);
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
    await client.query(`RELEASE SAVEPOINT ${savepointName}`);

    const message = String(error.message || "");
    const canFallbackWithoutStatus =
      ["VOTING", "READY_FOR_DC", "FINALIZED"].includes(String(nextStatus).toUpperCase()) &&
      /violates check constraint|invalid input value|status/i.test(message);

    if (!canFallbackWithoutStatus) {
      throw error;
    }

    await updateTransferRequestFields(client, transferId, extraFields);
  }
}

async function syncTransferVotesFromFabric(client, transferId, votingCase = null) {
  const currentCase = votingCase || (await getTransferCase(client, transferId));
  if (!currentCase?.channel_id) {
    return { synced: 0, chainRecord: null };
  }

  try {
    const queryNodeId = currentCase.submitted_by_node || "LRO_NODE_1";
    const chainRecord = await fabricGatewayService.queryAgreement(currentCase.channel_id, queryNodeId);
    const chainVotes = extractAllTransferVotes(chainRecord);

    for (const entry of chainVotes) {
      const nodeInfo = findNodeById(entry.nodeId);
      await client.query(
        `INSERT INTO transfer_blockchain_votes
           (transfer_id, property_id, channel_id, lro_node_id, lro_name, lro_user_id, vote, reason, transfer_hash, tx_id, voted_at)
         VALUES
           ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11::timestamptz, NOW()))
         ON CONFLICT (transfer_id, lro_node_id) DO UPDATE
         SET vote = EXCLUDED.vote,
             reason = EXCLUDED.reason,
             transfer_hash = COALESCE(EXCLUDED.transfer_hash, transfer_blockchain_votes.transfer_hash),
             tx_id = COALESCE(EXCLUDED.tx_id, transfer_blockchain_votes.tx_id),
             voted_at = COALESCE(EXCLUDED.voted_at, transfer_blockchain_votes.voted_at)`,
        [
          transferId,
          currentCase.property_id,
          currentCase.channel_id,
          entry.nodeId,
          nodeInfo?.city || entry.nodeId,
          entry.voterUserId || null,
          String(entry.vote || "").toUpperCase(),
          entry.reason || "",
          currentCase.transfer_hash || null,
          entry.txId || null,
          entry.votedAt || null,
        ]
      );
    }

    return { synced: chainVotes.length, chainRecord };
  } catch (error) {
    return { synced: 0, chainRecord: null, error };
  }
}

async function recoverOnChainTransferVote(
  client,
  transferId,
  node,
  votingCase,
  userId,
  fallbackVote = null,
  fallbackReason = ""
) {
  let chainRecord = null;
  let entry = null;

  try {
    const syncResult = await syncTransferVotesFromFabric(client, transferId, votingCase);
    chainRecord = syncResult.chainRecord;
    entry = extractTransferVoteEntry(chainRecord, node.nodeId);
  } catch (error) {
    entry = null;
  }

  const existingVote = await client.query(
    `SELECT transfer_id, lro_node_id, vote, reason, tx_id, voted_at
     FROM transfer_blockchain_votes
     WHERE transfer_id = $1 AND lro_node_id = $2
     LIMIT 1`,
    [transferId, node.nodeId]
  );

  if (existingVote.rows.length) {
    const row = existingVote.rows[0];
    return {
      recovered: true,
      vote: row.vote,
      reason: row.reason || entry?.reason || "",
      txId: row.tx_id || entry?.txId || null,
      votedAt: row.voted_at || entry?.votedAt || null,
      inferred: false,
      chainRecord,
    };
  }

  if (!entry && ["APPROVE", "REJECT"].includes(String(fallbackVote || "").toUpperCase())) {
    entry = {
      vote: String(fallbackVote).toUpperCase(),
      reason: String(fallbackReason || ""),
      txId: null,
      votedAt: null,
      inferred: true,
    };
  }

  if (!entry) return null;

  await client.query("SAVEPOINT transfer_vote_recovery_insert");

  try {
    await client.query(
      `INSERT INTO transfer_blockchain_votes
         (transfer_id, property_id, channel_id, lro_node_id, lro_name, lro_user_id, vote, reason, transfer_hash, tx_id, voted_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11::timestamptz, NOW()))
       ON CONFLICT DO NOTHING`,
      [
        transferId,
        votingCase.property_id,
        votingCase.channel_id,
        node.nodeId,
        node.city,
        userId,
        entry.vote,
        entry.reason,
        votingCase.transfer_hash,
        entry.txId || `recovered-${transferId}-${node.nodeId}-${Date.now()}`,
        entry.votedAt || null,
      ]
    );
    await client.query("RELEASE SAVEPOINT transfer_vote_recovery_insert");
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT transfer_vote_recovery_insert");
    await client.query("RELEASE SAVEPOINT transfer_vote_recovery_insert");

    const retryVote = await client.query(
      `SELECT transfer_id, lro_node_id, vote, reason, tx_id, voted_at
       FROM transfer_blockchain_votes
       WHERE transfer_id = $1 AND lro_node_id = $2
       LIMIT 1`,
      [transferId, node.nodeId]
    );

    if (!retryVote.rows.length) {
      return null;
    }
  }

  return {
    recovered: true,
    vote: entry.vote,
    reason: entry.reason,
    txId: entry.txId || null,
    votedAt: entry.votedAt || null,
    inferred: Boolean(entry.inferred),
    chainRecord,
  };
}

async function reanchorTransferVotingCaseOnFabric(
  client,
  transferId,
  votingCase,
  fallbackNode,
  fallbackUserId
) {
  const snapshot =
    (votingCase?.agreement_snapshot && typeof votingCase.agreement_snapshot === "object"
      ? votingCase.agreement_snapshot
      : null) || buildAgreementSnapshot(votingCase);

  const submittedByNode = votingCase?.submitted_by_node || fallbackNode.nodeId;
  const submittedByUserId = votingCase?.submitted_by_uid || fallbackUserId;

  const chainResult = await fabricGatewayService.upsertAgreement(
    votingCase.channel_id,
    {
      ...snapshot,
      status: "VOTING",
      submittedByNode,
      submittedByUserId,
    },
    fallbackNode.nodeId
  );

  await client.query(
    `UPDATE transfer_blockchain_cases
     SET submitted_by_node = $2,
         submitted_by_uid = $3,
         status = 'VOTING',
         updated_at = NOW()
     WHERE transfer_id = $1`,
    [transferId, submittedByNode, submittedByUserId]
  );

  return {
    chainResult,
    snapshot,
    submittedByNode,
    submittedByUserId,
  };
}

async function insertOwnershipHistoryRecord(client, payload) {
  await ownershipHistoryService.recordOwnershipEvent(client, {
    propertyId: payload.propertyId,
    previousOwnerId: payload.previousOwnerId,
    previousOwnerName: payload.previousOwnerName,
    previousOwnerCnic: payload.previousOwnerCnic,
    newOwnerId: payload.newOwnerId,
    newOwnerName: payload.newOwnerName,
    newOwnerCnic: payload.newOwnerCnic,
    newOwnerFatherName: payload.newOwnerFatherName,
    transferType: "SALE",
    transferAmount: payload.transferAmount,
    transferDate: new Date(),
    transferId: payload.transferId,
    referenceType: "TRANSFER_REQUEST",
    referenceId: payload.transferId,
    remarks: payload.remarks,
    createdAt: new Date(),
  });
}

router.get(
  "/lro/pending-submissions",
  authenticateToken,
  requireRole(["LRO", "LAND RECORD OFFICER", "ADMIN"]),
  async (req, res) => {
    try {
      await ensureTables();

      const result = await pool.query(
        `SELECT
           tr.transfer_id,
           tr.property_id,
           tr.channel_id,
           tr.payment_status,
           tr.challan_txn_id,
           tr.payment_completed_at,
           tr.transfer_amount,
           tr.agreed_price,
           tr.seller_agreed,
           tr.buyer_agreed,
           p.district,
           p.tehsil,
           p.mauza,
           p.area_marla,
           p.property_type,
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
         ORDER BY COALESCE(tr.payment_completed_at, tr.updated_at, tr.created_at) DESC`
      );

      return res.json({
        success: true,
        transfers: result.rows,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.post(
  "/lro/:transferId/submit",
  authenticateToken,
  requireRole(["LRO", "LAND RECORD OFFICER", "ADMIN"]),
  async (req, res) => {
    const client = await pool.connect();
    let channelIdToClose = null;

    try {
      await ensureTables();
      await propertyEncumbranceService.ensureSchema(client);
      await client.query("BEGIN");

      const { transferId } = req.params;
      const node = await resolveNode(req.user.userId);

      if (!node) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ success: false, message: "This login is not mapped to a Fabric voting node" });
      }

      const transferResult = await client.query(
        `SELECT
           tr.*,
           p.owner_name,
           p.owner_cnic,
           p.father_name AS owner_father_name,
           p.district,
           p.tehsil,
           p.mauza,
           p.area_marla,
           p.property_type,
           p.khasra_no,
           p.khewat_no,
           p.khatooni_no,
           seller.name AS seller_name,
           seller.cnic AS seller_cnic,
           seller.father_name AS seller_father_name,
           buyer.name AS buyer_name,
           buyer.cnic AS buyer_cnic,
           buyer.father_name AS buyer_father_name
         FROM transfer_requests tr
         LEFT JOIN properties p ON p.property_id = tr.property_id
         LEFT JOIN users seller ON seller.user_id = tr.seller_id
         LEFT JOIN users buyer ON buyer.user_id = tr.buyer_id
         WHERE tr.transfer_id = $1
         LIMIT 1`,
        [transferId]
      );

      const transfer = transferResult.rows[0];
      if (!transfer) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, message: "Transfer not found" });
      }

      const freezeState = await propertyFreezeService.getPropertyFreezeState(transfer.property_id, client);
      if (freezeState?.is_frozen) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          message: `Property is currently under dispute hold${freezeState.freeze_reason_label ? `: ${freezeState.freeze_reason_label}` : ""}`,
        });
      }

      const encumbranceState = await propertyEncumbranceService.getPropertyEncumbranceState(
        transfer.property_id,
        client
      );
      if (encumbranceState?.is_encumbered) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          message: `Property has an active encumbrance${encumbranceState.encumbrance_summary ? `: ${encumbranceState.encumbrance_summary}` : ""}`,
        });
      }

      const existingCase = await client.query(
        "SELECT * FROM transfer_blockchain_cases WHERE transfer_id = $1 LIMIT 1",
        [transferId]
      );

      if (
        existingCase.rows.length &&
        ["VOTING", "READY_FOR_DC", "FINALIZED"].includes(
          String(existingCase.rows[0].status).toUpperCase()
        )
      ) {
        await client.query("ROLLBACK");
        return res
          .status(409)
          .json({ success: false, message: "Transfer is already in blockchain voting flow" });
      }

      if (!(transfer.payment_status === "PAID" || transfer.challan_txn_id)) {
        await client.query("ROLLBACK");
        return res
          .status(409)
          .json({ success: false, message: "Transfer payment is not completed yet" });
      }

      if (!transfer.seller_agreed || !transfer.buyer_agreed) {
        await client.query("ROLLBACK");
        return res
          .status(409)
          .json({ success: false, message: "Both seller and buyer must agree before voting" });
      }

      if (!transfer.channel_id) {
        await client.query("ROLLBACK");
        return res
          .status(409)
          .json({ success: false, message: "Transfer does not have an active negotiation channel" });
      }

      const snapshot = buildAgreementSnapshot(transfer);
      const transferHash = hashSnapshot(snapshot);

      if (existingCase.rows.length) {
        await client.query(
          `UPDATE transfer_blockchain_cases
           SET property_id = $2,
               channel_id = $3,
               transfer_hash = $4,
               agreement_snapshot = $5::jsonb,
               status = 'VOTING',
               submitted_by_node = $6,
               submitted_by_uid = $7,
               submitted_at = NOW(),
               expires_at = NOW() + INTERVAL '7 days',
               approval_count = 0,
               rejection_count = 0,
               lro_approved_at = NULL,
               dc_approved_by = NULL,
               dc_approved_at = NULL,
               fabric_tx_id = NULL,
               finalized_fabric_tx_id = NULL,
               local_block_hash = NULL,
               updated_at = NOW()
           WHERE transfer_id = $1`,
          [
            transferId,
            transfer.property_id,
            transfer.channel_id,
            transferHash,
            JSON.stringify(snapshot),
            node.nodeId,
            req.user.userId,
          ]
        );
      } else {
        await client.query(
          `INSERT INTO transfer_blockchain_cases
             (transfer_id, property_id, channel_id, transfer_hash, agreement_snapshot, status, submitted_by_node, submitted_by_uid, submitted_at, expires_at, approval_count, rejection_count, created_at, updated_at)
           VALUES
             ($1, $2, $3, $4, $5::jsonb, 'VOTING', $6, $7, NOW(), NOW() + INTERVAL '7 days', 0, 0, NOW(), NOW())`,
          [
            transferId,
            transfer.property_id,
            transfer.channel_id,
            transferHash,
            JSON.stringify(snapshot),
            node.nodeId,
            req.user.userId,
          ]
        );
      }

      await client.query(
        `DELETE FROM transfer_blockchain_votes
         WHERE transfer_id = $1`,
        [transferId]
      );

      await updateTransferRequestVotingState(client, transferId, "VOTING", {
        approval_notes: null,
        approved_by: null,
        approved_at: null,
      });

      const chainResult = await fabricGatewayService.upsertAgreement(
        transfer.channel_id,
        {
          ...snapshot,
          status: "VOTING",
          submittedByNode: node.nodeId,
          submittedByUserId: req.user.userId,
        },
        node.nodeId
      );

      await client.query(
        `UPDATE transfer_blockchain_cases
         SET fabric_tx_id = $2,
             updated_at = NOW()
         WHERE transfer_id = $1`,
        [transferId, chainResult?.txId || null]
      );

      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "Transfer submitted for 5-node voting",
        transferId,
        channelId: transfer.channel_id,
        transferHash,
        submittedByNode: node.nodeId,
        chainResult,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Transfer voting submit failed:", error);
      return res.status(500).json({ success: false, message: error.message });
    } finally {
      client.release();
    }
  }
);

router.get(
  "/lro/queue",
  authenticateToken,
  requireRole(["LRO", "LAND RECORD OFFICER", "ADMIN"]),
  async (req, res) => {
    try {
      await ensureTables();

      const result = await pool.query(
        `SELECT transfer_id
         FROM transfer_blockchain_cases
         WHERE status IN ('VOTING', 'READY_FOR_DC', 'FINALIZED')
         ORDER BY COALESCE(updated_at, created_at, submitted_at) DESC`
      );

      const cases = await Promise.all(
        result.rows.map((row) => buildQueueRow(pool, row.transfer_id, req.user.userId))
      );

      return res.json({
        success: true,
        nodeCount: 5,
        voteThreshold: VOTE_THRESHOLD,
        cases: cases.filter(Boolean),
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.post(
  "/lro/:transferId/vote",
  authenticateToken,
  requireRole(["LRO", "LAND RECORD OFFICER", "ADMIN"]),
  async (req, res) => {
    const client = await pool.connect();

    try {
      await ensureTables();
      await client.query("BEGIN");

      const { transferId } = req.params;
      const vote = String(req.body.vote || "").toUpperCase();
      const reason = String(req.body.reason || "");

      if (!["APPROVE", "REJECT"].includes(vote)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: "Vote must be APPROVE or REJECT" });
      }

      const node = await resolveNode(req.user.userId);
      if (!node) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ success: false, message: "This login is not mapped to a Fabric voting node" });
      }

      const votingCase = await getTransferCase(client, transferId);
      if (!votingCase) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, message: "Transfer voting case not found" });
      }

      if (String(votingCase.status).toUpperCase() !== "VOTING") {
        await client.query("ROLLBACK");
        return res
          .status(409)
          .json({ success: false, message: `Case is not open for voting (${votingCase.status})` });
      }

      const existingVote = await client.query(
        `SELECT 1
         FROM transfer_blockchain_votes
         WHERE transfer_id = $1 AND lro_node_id = $2
         LIMIT 1`,
        [transferId, node.nodeId]
      );

      if (existingVote.rows.length) {
        await client.query("ROLLBACK");
        return res.status(409).json({ success: false, message: `Node ${node.nodeId} already voted` });
      }

      let chainResult = null;
      let recoveredVote = null;
      let reanchored = null;

      try {
        const onChainRecord = await fabricGatewayService.queryAgreement(votingCase.channel_id, node.nodeId);
        const onChainEntry = extractTransferVoteEntry(onChainRecord, node.nodeId);

        if (onChainEntry) {
          recoveredVote = await recoverOnChainTransferVote(
            client,
            transferId,
            node,
            votingCase,
            req.user.userId,
            onChainEntry.vote,
            onChainEntry.reason
          );
        }
      } catch (error) {
        recoveredVote = null;
      }

      if (!recoveredVote) {
        try {
          chainResult = await fabricGatewayService.castAgreementVote(
            votingCase.channel_id,
            node.nodeId,
            vote,
            reason,
            req.user.userId,
            node.nodeId
          );
        } catch (error) {
          if (isAgreementNotFoundError(error?.message)) {
            reanchored = await reanchorTransferVotingCaseOnFabric(
              client,
              transferId,
              votingCase,
              node,
              req.user.userId
            );

            try {
              chainResult = await fabricGatewayService.castAgreementVote(
                votingCase.channel_id,
                node.nodeId,
                vote,
                reason,
                req.user.userId,
                node.nodeId
              );
            } catch (retryError) {
              if (!isAlreadyVotedError(retryError?.message)) {
                throw retryError;
              }

              recoveredVote = await recoverOnChainTransferVote(
                client,
                transferId,
                node,
                votingCase,
                req.user.userId,
                vote,
                reason
              );

              if (!recoveredVote) {
                await client.query("ROLLBACK");
                return res.status(409).json({
                  success: false,
                  message: retryError.message,
                });
              }
            }
          } else if (!isAlreadyVotedError(error?.message)) {
            throw error;
          }

          if (!recoveredVote) {
            recoveredVote = await recoverOnChainTransferVote(
              client,
              transferId,
              node,
              votingCase,
              req.user.userId,
              vote,
              reason
            );
          }

          if (!recoveredVote) {
            await client.query("ROLLBACK");
            return res.status(409).json({
              success: false,
              message: error.message,
            });
          }
        }
      }

      if (!recoveredVote) {
        await client.query(
          `INSERT INTO transfer_blockchain_votes
             (transfer_id, property_id, channel_id, lro_node_id, lro_name, lro_user_id, vote, reason, transfer_hash, tx_id, voted_at)
           VALUES
             ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
          [
            transferId,
            votingCase.property_id,
            votingCase.channel_id,
            node.nodeId,
            node.city,
            req.user.userId,
            vote,
            reason,
            votingCase.transfer_hash,
            chainResult?.txId || `vote-${transferId}-${node.nodeId}-${Date.now()}`,
          ]
        );
      }

      const totals = await syncCaseState(client, transferId);
      await client.query("COMMIT");

      const detail = await buildQueueRow(pool, transferId, req.user.userId);

      return res.json({
        success: true,
        message: recoveredVote
          ? recoveredVote.inferred
            ? "Blockchain already had this vote; local state was repaired"
            : "Existing blockchain vote was synced locally"
          : reanchored
            ? "Voting case was re-submitted to Fabric and vote recorded successfully"
            : "Vote recorded successfully",
        transferId,
        nodeId: node.nodeId,
        chainResult: recoveredVote || chainResult,
        reanchored: Boolean(reanchored),
        approvals: totals.approvals,
        rejections: totals.rejections,
        votes: totals.votes,
        case: detail,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Transfer voting vote failed:", error);
      return res.status(500).json({ success: false, message: error.message });
    } finally {
      client.release();
    }
  }
);

router.get(
  "/dc/queue",
  authenticateToken,
  requireRole(["DC", "ADMIN"]),
  async (req, res) => {
    try {
      await ensureTables();

      const result = await pool.query(
        `SELECT transfer_id
         FROM transfer_blockchain_cases
         WHERE status = 'READY_FOR_DC'
         ORDER BY COALESCE(updated_at, created_at, submitted_at) DESC`
      );

      const cases = await Promise.all(
        result.rows.map((row) => buildQueueRow(pool, row.transfer_id, req.user.userId))
      );

      return res.json({
        success: true,
        voteThreshold: VOTE_THRESHOLD,
        cases: cases.filter(Boolean),
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.post(
  "/dc/:transferId/approve",
  authenticateToken,
  requireRole(["DC", "ADMIN"]),
  async (req, res) => {
    const client = await pool.connect();
    let channelIdToClose = null;

    try {
      await ensureTables();
      await propertyRegistryIntegrityService.ensureTables();
      await propertyEncumbranceService.ensureSchema(client);
      await client.query("BEGIN");

      const { transferId } = req.params;
      const notes = String(req.body.notes || "");

      const votingCase = await getTransferCase(client, transferId);
      if (!votingCase) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, message: "Transfer voting case not found" });
      }

      if (String(votingCase.status).toUpperCase() !== "READY_FOR_DC") {
        await client.query("ROLLBACK");
        return res
          .status(409)
          .json({ success: false, message: `Case is not ready for DC (${votingCase.status})` });
      }

      const freezeState = await propertyFreezeService.getPropertyFreezeState(
        votingCase.property_id,
        client
      );
      if (freezeState?.is_frozen) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          message: `Property is currently under dispute hold${freezeState.freeze_reason_label ? `: ${freezeState.freeze_reason_label}` : ""}`,
        });
      }

      const encumbranceState = await propertyEncumbranceService.getPropertyEncumbranceState(
        votingCase.property_id,
        client
      );
      if (encumbranceState?.is_encumbered) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          message: `Property has an active encumbrance${encumbranceState.encumbrance_summary ? `: ${encumbranceState.encumbrance_summary}` : ""}`,
        });
      }

      // ── Finalize on Fabric, re-anchoring if the agreement record is missing ──
      // This mirrors the same re-anchor pattern used in the LRO vote handler.
      // It handles cases where the DB is in READY_FOR_DC but the Fabric ledger
      // was reset (dev teardown/rebuild) so the on-chain agreement no longer exists.
      let chainResult;
      try {
        chainResult = await fabricGatewayService.finalizeAgreement(
          votingCase.channel_id,
          req.user.userId,
          "LRO_NODE_1"
        );
      } catch (fabricError) {
        if (!isAgreementNotFoundError(fabricError?.message)) {
          throw fabricError;
        }

        // Agreement record missing on Fabric — re-anchor it then finalize
        console.warn(
          `[DC-APPROVE] Agreement ${votingCase.channel_id} not found on Fabric; re-anchoring then finalizing`
        );

        const snapshot =
          votingCase.agreement_snapshot && typeof votingCase.agreement_snapshot === "object"
            ? votingCase.agreement_snapshot
            : buildAgreementSnapshot(votingCase);

        await fabricGatewayService.upsertAgreement(
          votingCase.channel_id,
          {
            ...snapshot,
            status: "READY_FOR_DC",
            submittedByNode: votingCase.submitted_by_node || "LRO_NODE_1",
            submittedByUserId: votingCase.submitted_by_uid || req.user.userId,
            reanchoredByDC: true,
            reanchoredAt: new Date().toISOString(),
          },
          "LRO_NODE_1"
        );

        chainResult = await fabricGatewayService.finalizeAgreement(
          votingCase.channel_id,
          req.user.userId,
          "LRO_NODE_1"
        );
      }

      // Allow canonical owner-field mutation only within this approved transfer-finalization transaction.
      await client.query(
        `SELECT set_config('app.allow_registry_canonical_mutation', 'on', true)`
      );

      await client.query(
        `UPDATE properties
         SET owner_id = $1,
             owner_name = $2,
             owner_cnic = $3,
             father_name = $4,
             updated_at = NOW()
         WHERE property_id = $5`,
        [
          votingCase.buyer_id,
          votingCase.buyer_name,
          votingCase.buyer_cnic,
          votingCase.buyer_father_name,
          votingCase.property_id,
        ]
      );

      await insertOwnershipHistoryRecord(client, {
        propertyId: votingCase.property_id,
        previousOwnerId: votingCase.seller_id,
        previousOwnerName: votingCase.seller_name,
        previousOwnerCnic: votingCase.seller_cnic,
        newOwnerId: votingCase.buyer_id,
        newOwnerName: votingCase.buyer_name,
        newOwnerCnic: votingCase.buyer_cnic,
        newOwnerFatherName: votingCase.buyer_father_name,
        transferAmount: normalizeMoney(votingCase.displayAmount),
        transferId,
        remarks: `Transfer finalized through 5-node voting. ${notes || ""}`.trim(),
      });

      await updateTransferRequestVotingState(client, transferId, "APPROVED", {
        approved_by: req.user.userId,
        approved_at: new Date(),
        approval_notes: notes || "Transfer approved after blockchain voting",
      });

      const propertyResult = await client.query(
        `SELECT
           property_id,
           owner_id,
           owner_name,
           owner_cnic,
           father_name,
           district,
           tehsil,
           mauza,
           khewat_no,
           khatooni_no,
           khasra_no,
           area_marla,
           property_type,
           status,
           created_at,
           updated_at
         FROM properties
         WHERE property_id = $1
         LIMIT 1`,
        [votingCase.property_id]
      );

      const updatedProperty = propertyResult.rows[0];
      const snapshot = propertyRegistryIntegrityService.buildPropertySnapshot(updatedProperty);
      const propertyHash = propertyRegistryIntegrityService.hashPropertySnapshot(snapshot);

      await fabricGatewayService.submitLandRecord(
        updatedProperty.property_id,
        propertyHash,
        snapshot,
        "TRANSFER_FINALIZED",
        req.user.userId,
        "LRO_NODE_1"
      );

      const landRecordResult = await fabricGatewayService.finalizeLandRecord(
        updatedProperty.property_id,
        req.user.userId,
        propertyHash,
        "LRO_NODE_1"
      );

      // ── PoA mineBlock() removed: Hyperledger Fabric Raft IS the ledger ──
      // The Fabric tx IDs from submitLandRecord + finalizeAgreement are used instead.
      const fabricTxId = landRecordResult?.txId || chainResult?.txId || null;

      const previousTransactionResult = await client.query(
        `SELECT transaction_hash
         FROM property_transactions
         WHERE property_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [votingCase.property_id]
      );

      const transactionPayload = {
        transferId,
        propertyId: votingCase.property_id,
        channelId: votingCase.channel_id,
        previousOwnerId: votingCase.seller_id,
        previousOwnerName: votingCase.seller_name,
        newOwnerId: votingCase.buyer_id,
        newOwnerName: votingCase.buyer_name,
        amount: normalizeMoney(votingCase.displayAmount),
        status: "COMPLETED",
        approvedBy: req.user.userId,
        approvedAt: new Date().toISOString(),
        notes: notes || "Transfer approved after blockchain voting",
        agreementTxId: chainResult?.txId || null,
        landRecordTxId: landRecordResult?.txId || null,
      };
      const propertyTransactionHash = crypto
        .createHash("sha256")
        .update(JSON.stringify(transactionPayload))
        .digest("hex");

      await client.query(
        `INSERT INTO property_transactions
           (property_id, transaction_type, transaction_data, transaction_hash, previous_transaction_hash, block_hash, creator_user_id, created_at, verified)
         VALUES
           ($1, 'TRANSFER', $2::jsonb, $3, $4, $5, $6, NOW(), TRUE)`,
        [
          votingCase.property_id,
          JSON.stringify(transactionPayload),
          propertyTransactionHash,
          previousTransactionResult.rows[0]?.transaction_hash || null,
          fabricTxId,
          req.user.userId,
        ]
      );

      await client.query(
        `INSERT INTO audit_logs (user_id, action_type, target_id, details, ip_address)
         VALUES ($1, 'TRANSFER_APPROVED', $2, $3, $4)`,
        [
          req.user.userId,
          transferId,
          JSON.stringify({
            propertyId: updatedProperty.property_id,
            oldOwnerId: votingCase.seller_id,
            newOwnerId: votingCase.buyer_id,
            amount: normalizeMoney(votingCase.displayAmount),
            channelId: votingCase.channel_id,
          }),
          req.ip || "unknown",
        ]
      );

      await client.query(
        `UPDATE transfer_blockchain_cases
         SET status = 'FINALIZED',
             dc_approved_by = $2,
             dc_approved_at = NOW(),
             finalized_fabric_tx_id = $3,
             local_block_hash = $4,
             updated_at = NOW()
         WHERE transfer_id = $1`,
        [
          transferId,
          req.user.userId,
          chainResult?.txId || landRecordResult?.txId || null,
          fabricTxId,
        ]
      );

      const integrityRecord = await client.query(
        "SELECT property_id FROM property_registry_integrity WHERE property_id = $1 LIMIT 1",
        [updatedProperty.property_id]
      );

      if (integrityRecord.rows.length) {
        await client.query(
          `UPDATE property_registry_integrity
           SET property_hash = $2,
               property_snapshot = $3::jsonb,
               chain_status = 'FINALIZED',
               submitted_by_node = 'TRANSFER_FINALIZED',
               submitted_by_user_id = $4,
               anchored_at = COALESCE(anchored_at, NOW()),
               finalized_tx_id = $5,
               finalized_at = NOW(),
               last_verified_hash = $2,
               last_verified_at = NOW(),
               integrity_status = 'CLEAN',
               tamper_reason = NULL,
               updated_at = NOW()
           WHERE property_id = $1`,
          [
            updatedProperty.property_id,
            propertyHash,
            JSON.stringify(snapshot),
            req.user.userId,
            fabricTxId,
          ]
        );
      } else {
        await client.query(
          `INSERT INTO property_registry_integrity
             (property_id, property_hash, property_snapshot, chain_status, submitted_by_node, submitted_by_user_id, anchored_at, finalized_tx_id, finalized_at, last_verified_hash, last_verified_at, integrity_status, created_at, updated_at)
           VALUES
             ($1, $2, $3::jsonb, 'FINALIZED', 'TRANSFER_FINALIZED', $4, NOW(), $5, NOW(), $2, NOW(), 'CLEAN', NOW(), NOW())`,
          [
            updatedProperty.property_id,
            propertyHash,
            JSON.stringify(snapshot),
            req.user.userId,
            fabricTxId,
          ]
        );
      }

      channelIdToClose = votingCase.channel_id || null;

      await client.query("COMMIT");

      if (channelIdToClose) {
        try {
          await channelService.closeChannel(channelIdToClose);
        } catch (channelError) {
          console.warn("Transfer finalized but channel close failed:", channelError.message);
        }
      }

      return res.json({
        success: true,
        message: "Transfer approved and written to ledger",
        transferId,
        propertyId: updatedProperty.property_id,
        chainResult,
        landRecordResult,
        fabricTxId,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      return res.status(500).json({ success: false, message: error.message });
    } finally {
      client.release();
    }
  }
);

router.post(
  "/dc/:transferId/reject",
  authenticateToken,
  requireRole(["DC", "ADMIN"]),
  async (req, res) => {
    const client = await pool.connect();

    try {
      await ensureTables();
      await client.query("BEGIN");

      const { transferId } = req.params;
      const reason = String(req.body.reason || "").trim();

      if (!reason) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: "Rejection reason is required" });
      }

      const caseResult = await client.query(
        "SELECT * FROM transfer_blockchain_cases WHERE transfer_id = $1 LIMIT 1",
        [transferId]
      );

      if (!caseResult.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, message: "Transfer voting case not found" });
      }

      await client.query(
        `UPDATE transfer_blockchain_cases
         SET status = 'REJECTED',
             dc_approved_by = $2,
             dc_approved_at = NOW(),
             updated_at = NOW()
         WHERE transfer_id = $1`,
        [transferId, req.user.userId]
      );

      await updateTransferRequestVotingState(client, transferId, "REJECTED", {
        rejection_reason: reason,
      });

      await client.query(
        `INSERT INTO audit_logs (user_id, action_type, target_id, details, ip_address)
         VALUES ($1, 'TRANSFER_REJECTED', $2, $3, $4)`,
        [
          req.user.userId,
          transferId,
          JSON.stringify({ reason }),
          req.ip || "unknown",
        ]
      );

      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "Transfer rejected by DC",
        transferId,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      return res.status(500).json({ success: false, message: error.message });
    } finally {
      client.release();
    }
  }
);

export default router;