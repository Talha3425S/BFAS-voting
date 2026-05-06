import express from "express";
import jwt from "jsonwebtoken";

import pool from "../config/db.js";
import blockchainService from "../services/blockchain.service.js";
import fabricGatewayService from "../services/fabricGateway.service.js";
import ownershipHistoryService from "../services/ownershipHistory.service.js";
import propertyRegistryIntegrityService from "../services/propertyRegistryIntegrity.service.js";
import { findNodeById, findNodeByUserId, findNodeFromEmail } from "../config/plraNodes.js";

const router = express.Router();
const VOTE_THRESHOLD = 3;
const REGISTRATION_CASE_STATUSES = ["SUBMITTED", "VOTING", "READY_FOR_DC", "FINALIZED", "REJECTED"];

const CREATE_REGISTRATION_CASES_SQL = `
  CREATE TABLE IF NOT EXISTS reg_blockchain_cases (
    property_id VARCHAR(120) PRIMARY KEY,
    property_hash VARCHAR(128) NOT NULL,
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
    final_block_hash VARCHAR(180),
    fabric_tx_id VARCHAR(180),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
`;

const CREATE_REGISTRATION_VOTES_SQL = `
  CREATE TABLE IF NOT EXISTS reg_blockchain_votes (
    vote_id BIGSERIAL PRIMARY KEY,
    property_id VARCHAR(120) NOT NULL,
    lro_node_id VARCHAR(60) NOT NULL,
    lro_name VARCHAR(120),
    lro_user_id VARCHAR(60),
    vote VARCHAR(20) NOT NULL,
    reason TEXT,
    property_hash VARCHAR(128),
    tx_id VARCHAR(180),
    voted_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (property_id, lro_node_id)
  )
`;

let registrationSchemaReadyPromise = null;

async function ensureRegistrationVotingSchema() {
  if (!registrationSchemaReadyPromise) {
    registrationSchemaReadyPromise = (async () => {
      await pool.query(CREATE_REGISTRATION_CASES_SQL);
      await pool.query(CREATE_REGISTRATION_VOTES_SQL);
      await pool.query(`
        UPDATE reg_blockchain_cases
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
        ALTER TABLE reg_blockchain_cases
        DROP CONSTRAINT IF EXISTS reg_blockchain_cases_status_check
      `);
      await pool.query(`
        ALTER TABLE reg_blockchain_cases
        ADD CONSTRAINT reg_blockchain_cases_status_check
        CHECK (UPPER(status) = ANY (ARRAY['SUBMITTED','VOTING','READY_FOR_DC','FINALIZED','REJECTED']))
      `);
    })().catch((error) => {
      registrationSchemaReadyPromise = null;
      throw error;
    });
  }

  return registrationSchemaReadyPromise;
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

function requireRole(allowed) {
  return (req, res, next) => {
    const role = String(req.user?.role || "").toUpperCase();
    if (!allowed.includes(role)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }
    next();
  };
}

router.use(async (_req, res, next) => {
  try {
    await ensureRegistrationVotingSchema();
    next();
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

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

async function getVoteTotals(client, propertyId) {
  const result = await client.query(
    `SELECT
       COUNT(*)::int AS votes,
       SUM(CASE WHEN UPPER(vote) = 'APPROVE' THEN 1 ELSE 0 END)::int AS approvals,
       SUM(CASE WHEN UPPER(vote) = 'REJECT' THEN 1 ELSE 0 END)::int AS rejections
     FROM reg_blockchain_votes
     WHERE property_id = $1`,
    [propertyId]
  );

  const row = result.rows[0] || {};
  return {
    votes: Number(row.votes || 0),
    approvals: Number(row.approvals || 0),
    rejections: Number(row.rejections || 0),
  };
}

async function buildQueueRow(client, propertyId, currentUserId = null) {
  const [caseResult, voteResult] = await Promise.all([
    client.query(
      `SELECT
         rbc.*,
         p.owner_name,
         p.owner_cnic,
         p.father_name,
         p.district,
         p.tehsil,
         p.mauza,
         p.khasra_no,
         p.khatooni_no,
         p.khewat_no,
         p.area_marla,
         p.property_type,
         p.status AS property_status,
         p.created_at AS property_created_at,
         p.updated_at AS property_updated_at
       FROM reg_blockchain_cases rbc
       JOIN properties p ON p.property_id = rbc.property_id
       WHERE rbc.property_id = $1
       LIMIT 1`,
      [propertyId]
    ),
    client.query(
      `SELECT property_id, lro_node_id, lro_name, lro_user_id, vote, reason, tx_id, voted_at
       FROM reg_blockchain_votes
       WHERE property_id = $1
       ORDER BY voted_at DESC`,
      [propertyId]
    ),
  ]);

  const record = caseResult.rows[0];
  if (!record) return null;

  const currentNode = currentUserId ? await resolveNode(currentUserId) : null;
  const currentVote =
    currentNode &&
    voteResult.rows.find((vote) => vote.lro_node_id === currentNode.nodeId);
  const liveApprovals = voteResult.rows.filter((vote) => String(vote.vote).toUpperCase() === "APPROVE").length;
  const liveRejections = voteResult.rows.filter((vote) => String(vote.vote).toUpperCase() === "REJECT").length;
  const normalizedStatus = (() => {
    const baseStatus = String(record.status || "").toUpperCase();
    if (baseStatus === "FINALIZED" || baseStatus === "REJECTED") return baseStatus;
    if (liveApprovals >= VOTE_THRESHOLD) return "READY_FOR_DC";
    if (liveRejections >= VOTE_THRESHOLD) return "REJECTED";
    return baseStatus || "VOTING";
  })();

  return {
    ...record,
    status: normalizedStatus,
    votes: voteResult.rows,
    currentUserVote: currentVote || null,
    canVote:
      normalizedStatus === "VOTING" &&
      !currentVote &&
      !!currentNode,
    approvals: liveApprovals,
    rejections: liveRejections,
    threshold: VOTE_THRESHOLD,
  };
}

async function syncCaseState(client, propertyId) {
  const totals = await getVoteTotals(client, propertyId);
  let nextCaseStatus = "VOTING";
  const shouldStampApproval = totals.approvals >= VOTE_THRESHOLD;

  if (shouldStampApproval) nextCaseStatus = "READY_FOR_DC";
  if (totals.rejections >= VOTE_THRESHOLD) nextCaseStatus = "REJECTED";

  await client.query(
    `UPDATE reg_blockchain_cases
     SET approval_count = $2,
         rejection_count = $3,
         status = $4,
         lro_approved_at = CASE
           WHEN $5 AND lro_approved_at IS NULL THEN NOW()
           ELSE lro_approved_at
         END,
         updated_at = NOW()
     WHERE property_id = $1`,
    [propertyId, totals.approvals, totals.rejections, nextCaseStatus, shouldStampApproval]
  );

  if (nextCaseStatus === "READY_FOR_DC") {
    await client.query(
      `UPDATE properties
       SET current_approver_role = 'DC',
           updated_at = NOW()
       WHERE property_id = $1`,
      [propertyId]
    );

    await client.query(
      `UPDATE property_registry_integrity
       SET chain_status = 'READY_FOR_DC',
           integrity_status = COALESCE(NULLIF(integrity_status, ''), 'PENDING'),
           updated_at = NOW()
       WHERE property_id = $1`,
      [propertyId]
    );
  }

  if (nextCaseStatus === "REJECTED") {
    await client.query(
      `UPDATE properties
       SET status = 'REJECTED',
           current_approver_role = NULL,
           updated_at = NOW()
       WHERE property_id = $1`,
      [propertyId]
    );

    await client.query(
      `UPDATE property_registry_integrity
       SET chain_status = 'REJECTED',
           integrity_status = 'REJECTED',
           updated_at = NOW()
       WHERE property_id = $1`,
      [propertyId]
    );
  }

  return totals;
}

async function reconcileRegistrationCaseStates(client = pool) {
  const result = await client.query(
    `SELECT property_id, property_hash, submitted_by_node
     FROM reg_blockchain_cases
     WHERE UPPER(COALESCE(status, '')) NOT IN ('FINALIZED', 'REJECTED')
     ORDER BY COALESCE(updated_at, created_at, submitted_at) DESC`
  );

  for (const row of result.rows) {
    await syncVotesFromFabric(client, row.property_id, row);
    await syncCaseState(client, row.property_id);
  }
}

function isAlreadyVotedError(errorMessage = "") {
  return /node\s+.+\s+already voted/i.test(String(errorMessage || ""));
}

function isLandRecordNotFoundError(errorMessage = "") {
  return /land record not found:/i.test(String(errorMessage || ""));
}

function extractFabricVoteEntry(chainRecord, nodeId) {
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

function extractAllFabricVotes(chainRecord) {
  if (!chainRecord || typeof chainRecord !== "object") return [];

  const approvals = Array.isArray(chainRecord.approvals) ? chainRecord.approvals : [];
  const rejections = Array.isArray(chainRecord.rejections) ? chainRecord.rejections : [];

  return [
    ...approvals.map((entry) => ({ ...entry, vote: "APPROVE" })),
    ...rejections.map((entry) => ({ ...entry, vote: "REJECT" })),
  ].filter((entry) => entry?.nodeId);
}

async function syncVotesFromFabric(client, propertyId, regCase = null) {
  try {
    const queryNodeId = regCase?.submitted_by_node || "LRO_NODE_1";
    const chainRecord = await fabricGatewayService.queryLandRecord(propertyId, queryNodeId);
    const chainVotes = extractAllFabricVotes(chainRecord);

    for (const entry of chainVotes) {
      const nodeInfo = findNodeById(entry.nodeId);
      await client.query(
        `INSERT INTO reg_blockchain_votes
           (property_id, lro_node_id, lro_name, lro_user_id, vote, reason, property_hash, tx_id, voted_at)
         VALUES
           ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, NOW()))
         ON CONFLICT (property_id, lro_node_id) DO UPDATE
         SET vote = EXCLUDED.vote,
             reason = EXCLUDED.reason,
             property_hash = COALESCE(EXCLUDED.property_hash, reg_blockchain_votes.property_hash),
             tx_id = COALESCE(EXCLUDED.tx_id, reg_blockchain_votes.tx_id),
             voted_at = COALESCE(EXCLUDED.voted_at, reg_blockchain_votes.voted_at)`,
        [
          propertyId,
          entry.nodeId,
          nodeInfo?.city || entry.nodeId,
          entry.voterUserId || null,
          String(entry.vote || "").toUpperCase(),
          entry.reason || "",
          regCase?.property_hash || chainRecord?.propertyHash || null,
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

async function recoverOnChainVote(
  client,
  propertyId,
  node,
  regCase,
  userId,
  fallbackVote = null,
  fallbackReason = ""
) {
  let chainRecord = null;
  let entry = null;

  try {
    chainRecord = await fabricGatewayService.queryLandRecord(propertyId, node.nodeId);
    entry = extractFabricVoteEntry(chainRecord, node.nodeId);
  } catch (error) {
    entry = null;
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

  const existingVote = await client.query(
    `SELECT property_id, lro_node_id, vote, reason, tx_id, voted_at
     FROM reg_blockchain_votes
     WHERE property_id = $1 AND lro_node_id = $2
     LIMIT 1`,
    [propertyId, node.nodeId]
  );

  if (!existingVote.rows.length) {
    await client.query("SAVEPOINT reg_vote_recovery_insert");

    try {
      await client.query(
        `INSERT INTO reg_blockchain_votes
           (property_id, lro_node_id, lro_name, lro_user_id, vote, reason, property_hash, tx_id, voted_at)
         VALUES
           ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, NOW()))
         ON CONFLICT DO NOTHING`,
        [
          propertyId,
          node.nodeId,
          node.city,
          userId,
          entry.vote,
          entry.reason,
          regCase.property_hash,
          entry.txId || `recovered-${propertyId}-${node.nodeId}-${Date.now()}`,
          entry.votedAt || null,
        ]
      );
      await client.query("RELEASE SAVEPOINT reg_vote_recovery_insert");
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT reg_vote_recovery_insert");
      await client.query("RELEASE SAVEPOINT reg_vote_recovery_insert");

      const retryVote = await client.query(
        `SELECT property_id, lro_node_id, vote, reason, tx_id, voted_at
         FROM reg_blockchain_votes
         WHERE property_id = $1 AND lro_node_id = $2
         LIMIT 1`,
        [propertyId, node.nodeId]
      );

      if (!retryVote.rows.length) {
        return null;
      }
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

async function reanchorVotingCaseOnFabric(client, propertyId, regCase, fallbackNode, fallbackUserId) {
  const [property, integrity] = await Promise.all([
    propertyRegistryIntegrityService.getPropertyRow(propertyId),
    propertyRegistryIntegrityService.getIntegrityRecord(propertyId),
  ]);

  if (!property) {
    throw new Error(`Property not found for Fabric re-anchor: ${propertyId}`);
  }

  const snapshot =
    integrity?.property_snapshot ||
    propertyRegistryIntegrityService.buildPropertySnapshot(property);

  const propertyHash =
    regCase?.property_hash ||
    integrity?.property_hash ||
    propertyRegistryIntegrityService.hashPropertySnapshot(snapshot);

  const submittedByNode =
    regCase?.submitted_by_node ||
    integrity?.submitted_by_node ||
    fallbackNode.nodeId;

  const submittedByUserId =
    regCase?.submitted_by_uid ||
    integrity?.submitted_by_user_id ||
    fallbackUserId;

  const chainResult = await fabricGatewayService.submitLandRecord(
    propertyId,
    propertyHash,
    snapshot,
    submittedByNode,
    submittedByUserId,
    fallbackNode.nodeId
  );

  await client.query(
    `UPDATE reg_blockchain_cases
     SET property_hash = $2,
         submitted_by_node = $3,
         submitted_by_uid = $4,
         status = 'VOTING',
         updated_at = NOW()
     WHERE property_id = $1`,
    [propertyId, propertyHash, submittedByNode, submittedByUserId]
  );

  await client.query(
    `UPDATE property_registry_integrity
     SET property_hash = $2,
         property_snapshot = $3::jsonb,
         chain_status = 'VOTING',
         submitted_by_node = $4,
         submitted_by_user_id = $5,
         anchored_at = COALESCE(anchored_at, NOW()),
         last_verified_hash = $2,
         last_verified_at = NOW(),
         integrity_status = 'PENDING',
         tamper_reason = NULL,
         updated_at = NOW()
     WHERE property_id = $1`,
    [propertyId, propertyHash, JSON.stringify(snapshot), submittedByNode, submittedByUserId]
  );

  return {
    chainResult,
    propertyHash,
    snapshot,
    submittedByNode,
    submittedByUserId,
  };
}

router.get(
  "/lro/pending-submissions",
  authenticateToken,
  requireRole(["LRO", "LAND RECORD OFFICER", "ADMIN"]),
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT
           p.property_id,
           p.owner_name,
           p.owner_cnic,
           p.father_name,
           p.khewat_no,
           p.khatooni_no,
           p.khasra_no,
           p.area_marla,
           p.property_type,
           p.district,
           p.tehsil,
           p.mauza,
           p.address,
           p.status,
           p.created_at,
           p.year
         FROM properties p
         LEFT JOIN reg_blockchain_cases rbc ON rbc.property_id = p.property_id
         WHERE p.status = 'PENDING'
           AND (rbc.property_id IS NULL OR rbc.status = 'REJECTED')
         ORDER BY p.created_at DESC`
      );

      return res.json({
        success: true,
        properties: result.rows,
        total: result.rows.length,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.post(
  "/lro/:propertyId/submit",
  authenticateToken,
  requireRole(["LRO", "LAND RECORD OFFICER", "ADMIN"]),
  async (req, res) => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const { propertyId } = req.params;
      const node = await resolveNode(req.user.userId);

      if (!node) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ success: false, message: "This login is not mapped to a Fabric voting node" });
      }

      const propertyResult = await client.query(
        `SELECT *
         FROM properties
         WHERE property_id = $1 AND status = 'PENDING'
         LIMIT 1`,
        [propertyId]
      );

      const property = propertyResult.rows[0];
      if (!property) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, message: "Pending property not found" });
      }

      const existingCase = await client.query(
        "SELECT * FROM reg_blockchain_cases WHERE property_id = $1 LIMIT 1",
        [propertyId]
      );

      if (existingCase.rows.length && ["VOTING", "READY_FOR_DC", "FINALIZED"].includes(String(existingCase.rows[0].status).toUpperCase())) {
        await client.query("ROLLBACK");
        return res.status(409).json({ success: false, message: "Property is already in registration voting flow" });
      }

      const snapshot = propertyRegistryIntegrityService.buildPropertySnapshot(property);
      const propertyHash = propertyRegistryIntegrityService.hashPropertySnapshot(snapshot);

      if (existingCase.rows.length) {
        await client.query(
          `UPDATE reg_blockchain_cases
           SET property_hash = $2,
               status = 'VOTING',
               submitted_by_node = $3,
               submitted_by_uid = $4,
               submitted_at = NOW(),
               expires_at = NOW() + INTERVAL '7 days',
               approval_count = 0,
               rejection_count = 0,
               dc_approved_by = NULL,
               dc_approved_at = NULL,
               final_block_hash = NULL,
               fabric_tx_id = NULL,
               updated_at = NOW()
           WHERE property_id = $1`,
          [propertyId, propertyHash, node.nodeId, req.user.userId]
        );
      } else {
        await client.query(
          `INSERT INTO reg_blockchain_cases
             (property_id, property_hash, status, submitted_by_node, submitted_by_uid, submitted_at, expires_at, approval_count, rejection_count, created_at, updated_at)
           VALUES
             ($1, $2, 'VOTING', $3, $4, NOW(), NOW() + INTERVAL '7 days', 0, 0, NOW(), NOW())`,
          [propertyId, propertyHash, node.nodeId, req.user.userId]
        );
      }

      await client.query(
        `DELETE FROM reg_blockchain_votes
         WHERE property_id = $1`,
        [propertyId]
      );

      await client.query(
        `UPDATE properties
         SET current_approver_role = 'REGISTRATION_VOTING',
             updated_at = NOW()
         WHERE property_id = $1`,
        [propertyId]
      );

      const integrityRecord = await client.query(
        "SELECT property_id FROM property_registry_integrity WHERE property_id = $1 LIMIT 1",
        [propertyId]
      );

      if (integrityRecord.rows.length) {
        await client.query(
          `UPDATE property_registry_integrity
           SET property_hash = $2,
               property_snapshot = $3::jsonb,
               chain_status = 'VOTING',
               submitted_by_node = $4,
               submitted_by_user_id = $5,
               anchored_at = COALESCE(anchored_at, NOW()),
               finalized_tx_id = NULL,
               finalized_at = NULL,
               last_verified_hash = $2,
               last_verified_at = NOW(),
               integrity_status = 'PENDING',
               tamper_reason = NULL,
               updated_at = NOW()
           WHERE property_id = $1`,
          [propertyId, propertyHash, JSON.stringify(snapshot), node.nodeId, req.user.userId]
        );
      } else {
        await client.query(
          `INSERT INTO property_registry_integrity
             (property_id, property_hash, property_snapshot, chain_status, submitted_by_node, submitted_by_user_id, anchored_at, last_verified_hash, last_verified_at, integrity_status, created_at, updated_at)
           VALUES
             ($1, $2, $3::jsonb, 'VOTING', $4, $5, NOW(), $2, NOW(), 'PENDING', NOW(), NOW())`,
          [propertyId, propertyHash, JSON.stringify(snapshot), node.nodeId, req.user.userId]
        );
      }

      await fabricGatewayService.submitLandRecord(
        propertyId,
        propertyHash,
        snapshot,
        node.nodeId,
        req.user.userId,
        node.nodeId
      );

      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "Property submitted for 5-node voting",
        propertyId,
        propertyHash,
        submittedByNode: node.nodeId,
      });
    } catch (error) {
      await client.query("ROLLBACK");
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
      const result = await pool.query(
        `SELECT property_id
         FROM reg_blockchain_cases
         WHERE status IN ('VOTING', 'READY_FOR_DC', 'FINALIZED')
         ORDER BY COALESCE(updated_at, created_at, submitted_at) DESC`
      );

      const cases = await Promise.all(
        result.rows.map((row) => buildQueueRow(pool, row.property_id, req.user.userId))
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
  "/lro/:propertyId/vote",
  authenticateToken,
  requireRole(["LRO", "LAND RECORD OFFICER", "ADMIN"]),
  async (req, res) => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const { propertyId } = req.params;
      const vote = String(req.body.vote || "").toUpperCase();
      const reason = String(req.body.reason || "");

      if (!["APPROVE", "REJECT"].includes(vote)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: "Vote must be APPROVE or REJECT" });
      }

      const node = await resolveNode(req.user.userId);
      if (!node) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: "This login is not mapped to a Fabric voting node" });
      }

      const caseResult = await client.query(
        "SELECT * FROM reg_blockchain_cases WHERE property_id = $1 LIMIT 1",
        [propertyId]
      );
      const regCase = caseResult.rows[0];

      if (!regCase) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, message: "Voting case not found" });
      }

      if (String(regCase.status).toUpperCase() !== "VOTING") {
        await client.query("ROLLBACK");
        return res.status(409).json({ success: false, message: `Case is not open for voting (${regCase.status})` });
      }

      const existingVote = await client.query(
        `SELECT 1
         FROM reg_blockchain_votes
         WHERE property_id = $1 AND lro_node_id = $2
         LIMIT 1`,
        [propertyId, node.nodeId]
      );

      if (existingVote.rows.length) {
        await client.query("ROLLBACK");
        return res.status(409).json({ success: false, message: `Node ${node.nodeId} already voted` });
      }

      let chainResult = null;
      let recoveredVote = null;
      let reanchored = null;

      try {
        const onChainRecord = await fabricGatewayService.queryLandRecord(propertyId, node.nodeId);
        const onChainEntry = extractFabricVoteEntry(onChainRecord, node.nodeId);

        if (onChainEntry) {
          recoveredVote = await recoverOnChainVote(
            client,
            propertyId,
            node,
            regCase,
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
          chainResult = await fabricGatewayService.castLandRecordVote(
            propertyId,
            node.nodeId,
            vote,
            reason,
            req.user.userId,
            node.nodeId
          );
        } catch (error) {
          if (isLandRecordNotFoundError(error?.message)) {
            reanchored = await reanchorVotingCaseOnFabric(
              client,
              propertyId,
              regCase,
              node,
              req.user.userId
            );

            try {
              chainResult = await fabricGatewayService.castLandRecordVote(
                propertyId,
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

              recoveredVote = await recoverOnChainVote(
                client,
                propertyId,
                node,
                { ...regCase, property_hash: reanchored.propertyHash },
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
            recoveredVote = await recoverOnChainVote(
              client,
              propertyId,
              node,
              regCase,
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
          `INSERT INTO reg_blockchain_votes
             (property_id, lro_node_id, lro_name, lro_user_id, vote, reason, property_hash, tx_id, voted_at)
           VALUES
             ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
          [
            propertyId,
            node.nodeId,
            node.city,
            req.user.userId,
            vote,
            reason,
            regCase.property_hash,
            chainResult?.txId || `vote-${propertyId}-${node.nodeId}-${Date.now()}`,
          ]
        );
      }

      const totals = await syncCaseState(client, propertyId);
      await client.query("COMMIT");

      const detail = await buildQueueRow(pool, propertyId, req.user.userId);

      return res.json({
        success: true,
        message: recoveredVote
          ? recoveredVote.inferred
            ? "Blockchain already had this vote; local state was repaired"
            : "Existing blockchain vote was synced locally"
          : reanchored
            ? "Voting case was re-submitted to Fabric and vote recorded successfully"
          : "Vote recorded successfully",
        propertyId,
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
      await reconcileRegistrationCaseStates(pool);

      const result = await pool.query(
        `SELECT rbc.property_id
         FROM reg_blockchain_cases rbc
         LEFT JOIN (
           SELECT
             property_id,
             SUM(CASE WHEN UPPER(vote) = 'APPROVE' THEN 1 ELSE 0 END)::int AS approvals,
             SUM(CASE WHEN UPPER(vote) = 'REJECT' THEN 1 ELSE 0 END)::int AS rejections
           FROM reg_blockchain_votes
           GROUP BY property_id
         ) rv ON rv.property_id = rbc.property_id
         WHERE UPPER(COALESCE(rbc.status, '')) = 'READY_FOR_DC'
            OR (
              UPPER(COALESCE(rbc.status, '')) NOT IN ('FINALIZED', 'REJECTED')
              AND COALESCE(rv.approvals, 0) >= $1
            )
         ORDER BY COALESCE(rbc.updated_at, rbc.created_at, rbc.submitted_at) DESC`,
        [VOTE_THRESHOLD]
      );

      const cases = await Promise.all(
        result.rows.map((row) => buildQueueRow(pool, row.property_id, req.user.userId))
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
  "/dc/:propertyId/approve",
  authenticateToken,
  requireRole(["DC", "ADMIN"]),
  async (req, res) => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const { propertyId } = req.params;
      const notes = String(req.body.notes || "");

      const caseResult = await client.query(
        "SELECT * FROM reg_blockchain_cases WHERE property_id = $1 LIMIT 1",
        [propertyId]
      );
      let regCase = caseResult.rows[0];

      if (!regCase) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, message: "Registration case not found" });
      }

      if (String(regCase.status).toUpperCase() !== "READY_FOR_DC") {
        const totals = await syncCaseState(client, propertyId);
        const refreshedCaseResult = await client.query(
          "SELECT * FROM reg_blockchain_cases WHERE property_id = $1 LIMIT 1",
          [propertyId]
        );
        regCase = refreshedCaseResult.rows[0] || regCase;

        if (String(regCase.status).toUpperCase() !== "READY_FOR_DC") {
          await client.query("ROLLBACK");
          return res.status(409).json({
            success: false,
            message: `Case is not ready for DC (${regCase.status}). Approvals: ${totals.approvals}/${VOTE_THRESHOLD}`,
          });
        }
      }

      const propertyResult = await client.query(
        "SELECT * FROM properties WHERE property_id = $1 LIMIT 1",
        [propertyId]
      );
      const property = propertyResult.rows[0];

      if (!property) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, message: "Property not found" });
      }

      // ── Finalize on Fabric, re-anchoring if the land record is missing ──
      // Mirrors the same re-anchor pattern used in the transfer DC approve handler.
      // snapshot and propertyHash are declared here (outside try) so the catch
      // branch can use them to re-anchor via submitLandRecord().
      const snapshot = propertyRegistryIntegrityService.buildPropertySnapshot(property);
      const propertyHash = propertyRegistryIntegrityService.hashPropertySnapshot(snapshot);

      let chainResult;
      try {
        chainResult = await fabricGatewayService.finalizeLandRecord(
          propertyId,
          req.user.userId,
          propertyHash,
          "LRO_NODE_1"
        );
      } catch (fabricError) {
        if (!/land record not found:/i.test(String(fabricError?.message || ""))) {
          throw fabricError;
        }

        // Land record missing on Fabric — re-anchor it then finalize
        console.warn(
          `[DC-APPROVE-REG] Land record ${propertyId} not found on Fabric; re-anchoring then finalizing`
        );

        await fabricGatewayService.submitLandRecord(
          propertyId,
          propertyHash,
          snapshot,
          regCase?.submitted_by_node || "LRO_NODE_1",
          regCase?.submitted_by_uid || req.user.userId,
          "LRO_NODE_1"
        );

        chainResult = await fabricGatewayService.finalizeLandRecord(
          propertyId,
          req.user.userId,
          propertyHash,
          "LRO_NODE_1"
        );
      }
      const fabricTxId = chainResult?.txId || null;

      await client.query(
        `UPDATE reg_blockchain_cases
         SET status = 'FINALIZED',
             dc_approved_by = $2,
             dc_approved_at = NOW(),
             final_block_hash = $3,
             fabric_tx_id = $4,
             updated_at = NOW()
         WHERE property_id = $1`,
        [propertyId, req.user.userId, fabricTxId, fabricTxId]
      );

      await client.query(
        `UPDATE properties
         SET status = 'APPROVED',
             current_approver_role = NULL,
             assigned_dc_id = $2,
             updated_at = NOW()
         WHERE property_id = $1`,
        [propertyId, req.user.userId]
      );

      await client.query(
        `UPDATE property_registry_integrity
         SET property_hash = $2,
             property_snapshot = $3::jsonb,
             chain_status = 'FINALIZED',
             finalized_tx_id = $4,
             finalized_at = NOW(),
             last_verified_hash = $2,
             last_verified_at = NOW(),
             integrity_status = 'CLEAN',
             tamper_reason = NULL,
             updated_at = NOW()
         WHERE property_id = $1`,
        [propertyId, propertyHash, JSON.stringify(snapshot), fabricTxId]
      );

      await ownershipHistoryService.recordOwnershipEvent(client, {
        propertyId,
        previousOwnerId: null,
        previousOwnerName: null,
        previousOwnerCnic: null,
        newOwnerId: property.owner_id,
        newOwnerName: property.owner_name,
        newOwnerCnic: property.owner_cnic,
        newOwnerFatherName: property.father_name,
        transferType: "REGISTRATION",
        transferAmount: null,
        transferDate: new Date(),
        referenceType: "PROPERTY_REGISTRATION",
        referenceId: propertyId,
        remarks: `Property registration approved by ${req.user.userId}${notes ? `: ${notes}` : ""}`,
        createdAt: new Date(),
      });

      await client.query(
        `INSERT INTO audit_logs (user_id, action_type, target_id, details, ip_address)
         VALUES ($1, 'PROPERTY_APPROVED_BY_DC', $2, $3, $4)`,
        [
          req.user.userId,
          propertyId,
          JSON.stringify({
            propertyId,
            notes,
            fabricTxId,
            workflow: "REGISTRATION_VOTING",
          }),
          req.ip || "unknown",
        ]
      );

      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "Property approved and written to ledger",
        propertyId,
        notes,
        chainResult,
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
  "/dc/:propertyId/reject",
  authenticateToken,
  requireRole(["DC", "ADMIN"]),
  async (req, res) => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const { propertyId } = req.params;
      const reason = String(req.body.reason || "").trim();

      if (!reason) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: "Rejection reason is required" });
      }

      const caseResult = await client.query(
        "SELECT * FROM reg_blockchain_cases WHERE property_id = $1 LIMIT 1",
        [propertyId]
      );

      if (!caseResult.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, message: "Registration case not found" });
      }

      const regCase = caseResult.rows[0];
      if (String(regCase.status).toUpperCase() !== "READY_FOR_DC") {
        await syncCaseState(client, propertyId);
      }

      await client.query(
        `UPDATE reg_blockchain_cases
         SET status = 'REJECTED',
             dc_approved_by = $2,
             dc_approved_at = NOW(),
             updated_at = NOW()
         WHERE property_id = $1`,
        [propertyId, req.user.userId]
      );

      await client.query(
        `UPDATE properties
         SET status = 'REJECTED',
             current_approver_role = NULL,
             rejection_reason = $2,
             updated_at = NOW()
         WHERE property_id = $1`,
        [propertyId, reason]
      );

      await client.query(
        `UPDATE property_registry_integrity
         SET chain_status = 'REJECTED',
             integrity_status = 'REJECTED',
             tamper_reason = $2,
             updated_at = NOW()
         WHERE property_id = $1`,
        [propertyId, reason]
      );

      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "Property rejected by DC",
        propertyId,
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