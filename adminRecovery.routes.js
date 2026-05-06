import express from "express";
import jwt from "jsonwebtoken";

import pool from "../config/db.js";
import auditService from "../services/audit.service.js";
import blockchainService from "../services/blockchain.service.js";
import fabricPLRAService from "../services/fabricPLRA.service.js";
import propertyRegistryIntegrityService from "../services/propertyRegistryIntegrity.service.js";

const router = express.Router();
const VOTE_THRESHOLD = 3;

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ success: false, message: "No token provided" });
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || "default-jwt-secret");
    next();
  } catch (_error) {
    return res.status(403).json({ success: false, message: "Invalid token" });
  }
}

function requireAdmin(req, res, next) {
  const role = String(req.user?.role || "").toUpperCase();
  if (role !== "ADMIN") {
    return res.status(403).json({ success: false, message: "Admin access required" });
  }
  next();
}

async function getTableAvailability() {
  const result = await pool.query(`
    SELECT
      to_regclass('public.property_registry_integrity') AS integrity_table,
      to_regclass('public.reg_blockchain_cases') AS reg_cases,
      to_regclass('public.reg_blockchain_votes') AS reg_votes,
      to_regclass('public.transfer_blockchain_cases') AS transfer_cases,
      to_regclass('public.transfer_blockchain_votes') AS transfer_votes
  `);

  const row = result.rows[0] || {};
  return {
    integrity: Boolean(row.integrity_table),
    regCases: Boolean(row.reg_cases),
    regVotes: Boolean(row.reg_votes),
    transferCases: Boolean(row.transfer_cases),
    transferVotes: Boolean(row.transfer_votes),
  };
}

async function getRegistrationSummary() {
  const tables = await getTableAvailability();
  if (!tables.regCases || !tables.regVotes) {
    return {
      total: 0,
      voting: 0,
      readyForDc: 0,
      finalized: 0,
      rejected: 0,
      stale: 0,
    };
  }

  const result = await pool.query(
    `
      WITH vote_totals AS (
        SELECT
          property_id,
          COUNT(*)::int AS votes,
          SUM(CASE WHEN UPPER(vote) = 'APPROVE' THEN 1 ELSE 0 END)::int AS approvals,
          SUM(CASE WHEN UPPER(vote) = 'REJECT' THEN 1 ELSE 0 END)::int AS rejections
        FROM reg_blockchain_votes
        GROUP BY property_id
      )
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE UPPER(COALESCE(rbc.status, '')) = 'VOTING')::int AS voting,
        COUNT(*) FILTER (WHERE UPPER(COALESCE(rbc.status, '')) = 'READY_FOR_DC')::int AS ready_for_dc,
        COUNT(*) FILTER (WHERE UPPER(COALESCE(rbc.status, '')) = 'FINALIZED')::int AS finalized,
        COUNT(*) FILTER (WHERE UPPER(COALESCE(rbc.status, '')) = 'REJECTED')::int AS rejected,
        COUNT(*) FILTER (
          WHERE
            COALESCE(rbc.approval_count, 0) <> COALESCE(vt.approvals, 0)
            OR COALESCE(rbc.rejection_count, 0) <> COALESCE(vt.rejections, 0)
            OR (
              COALESCE(vt.approvals, 0) >= $1
              AND UPPER(COALESCE(rbc.status, '')) <> 'READY_FOR_DC'
              AND UPPER(COALESCE(rbc.status, '')) <> 'FINALIZED'
            )
            OR (
              COALESCE(vt.rejections, 0) >= $1
              AND UPPER(COALESCE(rbc.status, '')) <> 'REJECTED'
            )
        )::int AS stale
      FROM reg_blockchain_cases rbc
      LEFT JOIN vote_totals vt ON vt.property_id = rbc.property_id
    `,
    [VOTE_THRESHOLD]
  );

  const row = result.rows[0] || {};
  return {
    total: Number(row.total || 0),
    voting: Number(row.voting || 0),
    readyForDc: Number(row.ready_for_dc || 0),
    finalized: Number(row.finalized || 0),
    rejected: Number(row.rejected || 0),
    stale: Number(row.stale || 0),
  };
}

async function getTransferSummary() {
  const tables = await getTableAvailability();
  if (!tables.transferCases || !tables.transferVotes) {
    return {
      total: 0,
      voting: 0,
      readyForDc: 0,
      finalized: 0,
      rejected: 0,
      stale: 0,
    };
  }

  const result = await pool.query(
    `
      WITH vote_totals AS (
        SELECT
          transfer_id,
          COUNT(*)::int AS votes,
          SUM(CASE WHEN UPPER(vote) = 'APPROVE' THEN 1 ELSE 0 END)::int AS approvals,
          SUM(CASE WHEN UPPER(vote) = 'REJECT' THEN 1 ELSE 0 END)::int AS rejections
        FROM transfer_blockchain_votes
        GROUP BY transfer_id
      )
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE UPPER(COALESCE(tbc.status, '')) = 'VOTING')::int AS voting,
        COUNT(*) FILTER (WHERE UPPER(COALESCE(tbc.status, '')) = 'READY_FOR_DC')::int AS ready_for_dc,
        COUNT(*) FILTER (WHERE UPPER(COALESCE(tbc.status, '')) = 'FINALIZED')::int AS finalized,
        COUNT(*) FILTER (WHERE UPPER(COALESCE(tbc.status, '')) = 'REJECTED')::int AS rejected,
        COUNT(*) FILTER (
          WHERE
            COALESCE(tbc.approval_count, 0) <> COALESCE(vt.approvals, 0)
            OR COALESCE(tbc.rejection_count, 0) <> COALESCE(vt.rejections, 0)
            OR (
              COALESCE(vt.approvals, 0) >= $1
              AND UPPER(COALESCE(tbc.status, '')) <> 'READY_FOR_DC'
              AND UPPER(COALESCE(tbc.status, '')) <> 'FINALIZED'
            )
            OR (
              COALESCE(vt.rejections, 0) >= $1
              AND UPPER(COALESCE(tbc.status, '')) <> 'REJECTED'
            )
        )::int AS stale
      FROM transfer_blockchain_cases tbc
      LEFT JOIN vote_totals vt ON vt.transfer_id = tbc.transfer_id
    `,
    [VOTE_THRESHOLD]
  );

  const row = result.rows[0] || {};
  return {
    total: Number(row.total || 0),
    voting: Number(row.voting || 0),
    readyForDc: Number(row.ready_for_dc || 0),
    finalized: Number(row.finalized || 0),
    rejected: Number(row.rejected || 0),
    stale: Number(row.stale || 0),
  };
}

async function getRegistrationIssues(limit = 6) {
  const tables = await getTableAvailability();
  if (!tables.regCases || !tables.regVotes) return [];

  const result = await pool.query(
    `
      WITH vote_totals AS (
        SELECT
          property_id,
          SUM(CASE WHEN UPPER(vote) = 'APPROVE' THEN 1 ELSE 0 END)::int AS approvals,
          SUM(CASE WHEN UPPER(vote) = 'REJECT' THEN 1 ELSE 0 END)::int AS rejections
        FROM reg_blockchain_votes
        GROUP BY property_id
      )
      SELECT
        rbc.property_id,
        rbc.status,
        COALESCE(rbc.approval_count, 0) AS stored_approvals,
        COALESCE(rbc.rejection_count, 0) AS stored_rejections,
        COALESCE(vt.approvals, 0) AS live_approvals,
        COALESCE(vt.rejections, 0) AS live_rejections,
        p.owner_name,
        p.district,
        p.tehsil,
        COALESCE(rbc.updated_at, rbc.created_at, rbc.submitted_at) AS occurred_at
      FROM reg_blockchain_cases rbc
      LEFT JOIN vote_totals vt ON vt.property_id = rbc.property_id
      LEFT JOIN properties p ON p.property_id = rbc.property_id
      WHERE
        COALESCE(rbc.approval_count, 0) <> COALESCE(vt.approvals, 0)
        OR COALESCE(rbc.rejection_count, 0) <> COALESCE(vt.rejections, 0)
        OR (
          COALESCE(vt.approvals, 0) >= $1
          AND UPPER(COALESCE(rbc.status, '')) <> 'READY_FOR_DC'
          AND UPPER(COALESCE(rbc.status, '')) <> 'FINALIZED'
        )
        OR (
          COALESCE(vt.rejections, 0) >= $1
          AND UPPER(COALESCE(rbc.status, '')) <> 'REJECTED'
        )
      ORDER BY COALESCE(rbc.updated_at, rbc.created_at, rbc.submitted_at) DESC
      LIMIT $2
    `,
    [VOTE_THRESHOLD, limit]
  );

  return result.rows;
}

async function getTransferIssues(limit = 6) {
  const tables = await getTableAvailability();
  if (!tables.transferCases || !tables.transferVotes) return [];

  const result = await pool.query(
    `
      WITH vote_totals AS (
        SELECT
          transfer_id,
          SUM(CASE WHEN UPPER(vote) = 'APPROVE' THEN 1 ELSE 0 END)::int AS approvals,
          SUM(CASE WHEN UPPER(vote) = 'REJECT' THEN 1 ELSE 0 END)::int AS rejections
        FROM transfer_blockchain_votes
        GROUP BY transfer_id
      )
      SELECT
        tbc.transfer_id,
        tbc.property_id,
        tbc.status,
        COALESCE(tbc.approval_count, 0) AS stored_approvals,
        COALESCE(tbc.rejection_count, 0) AS stored_rejections,
        COALESCE(vt.approvals, 0) AS live_approvals,
        COALESCE(vt.rejections, 0) AS live_rejections,
        seller.name AS seller_name,
        buyer.name AS buyer_name,
        COALESCE(tbc.updated_at, tbc.created_at, tbc.submitted_at) AS occurred_at
      FROM transfer_blockchain_cases tbc
      LEFT JOIN vote_totals vt ON vt.transfer_id = tbc.transfer_id
      LEFT JOIN transfer_requests tr ON tr.transfer_id = tbc.transfer_id
      LEFT JOIN users seller ON seller.user_id = tr.seller_id
      LEFT JOIN users buyer ON buyer.user_id = tr.buyer_id
      WHERE
        COALESCE(tbc.approval_count, 0) <> COALESCE(vt.approvals, 0)
        OR COALESCE(tbc.rejection_count, 0) <> COALESCE(vt.rejections, 0)
        OR (
          COALESCE(vt.approvals, 0) >= $1
          AND UPPER(COALESCE(tbc.status, '')) <> 'READY_FOR_DC'
          AND UPPER(COALESCE(tbc.status, '')) <> 'FINALIZED'
        )
        OR (
          COALESCE(vt.rejections, 0) >= $1
          AND UPPER(COALESCE(tbc.status, '')) <> 'REJECTED'
        )
      ORDER BY COALESCE(tbc.updated_at, tbc.created_at, tbc.submitted_at) DESC
      LIMIT $2
    `,
    [VOTE_THRESHOLD, limit]
  );

  return result.rows;
}

async function getIntegrityIssues(limit = 6) {
  const records = (await propertyRegistryIntegrityService.listRecords({ skipFabric: true })).filter(Boolean);

  return records
    .filter((record) => record.classification !== "APPROVED_ON_CHAIN")
    .slice(0, limit)
    .map((record) => ({
      propertyId: record.property?.property_id,
      ownerName: record.property?.owner_name,
      classification: record.classification,
      proofSource: record.proofSource,
      tamperDetected: record.tamperDetected,
      tamperReason: record.tamperReason,
      currentHash: record.currentHash,
      occurredAt:
        record.property?.updated_at ||
        record.property?.created_at ||
        record.integrity?.updated_at ||
        null,
    }));
}

function summarizeIntegrityRecords(records = []) {
  return {
    scannedRecords: records.length,
    approvedOnChain: records.filter((item) => item.classification === "APPROVED_ON_CHAIN").length,
    clean: records.filter((item) => item.classification === "APPROVED_ON_CHAIN").length,
    tampered: records.filter((item) => item.classification === "TAMPERED").length,
    localMirrorOnly: records.filter((item) => item.classification === "LOCAL_MIRROR_ONLY").length,
    notAnchored: records.filter((item) => item.classification === "NOT_ANCHORED").length,
    legacyOnly: records.filter((item) => item.classification === "LEGACY_ONLY").length,
  };
}

function summarizeReachability(entries = []) {
  const reachable = entries.filter((item) => item?.reachable).length;
  return {
    total: entries.length,
    reachable,
    unreachable: Math.max(0, entries.length - reachable),
    offlineNames: entries
      .filter((item) => !item?.reachable)
      .map((item) => item.peerName || item.ordererName || item.host || "Unknown"),
  };
}

function hoursSince(timestamp) {
  if (!timestamp) return null;
  const value = new Date(timestamp).getTime();
  if (!Number.isFinite(value)) return null;
  return Math.max(0, (Date.now() - value) / (1000 * 60 * 60));
}

async function getDatabaseHealth() {
  const startedAt = Date.now();
  await pool.query("SELECT NOW()");
  const latencyMs = Date.now() - startedAt;

  return {
    status: latencyMs <= 150 ? "HEALTHY" : latencyMs <= 500 ? "DEGRADED" : "SLOW",
    connected: true,
    latencyMs,
  };
}

async function getBackupHealth() {
  const availabilityResult = await pool.query(`
    SELECT
      to_regclass('public.system_backups') AS backup_table,
      to_regclass('public.system_restore_runs') AS restore_table,
      to_regclass('public.schema_migrations') AS migrations_table
  `);

  const availability = availabilityResult.rows[0] || {};
  const backupsEnabled = Boolean(availability.backup_table);
  const restoreEnabled = Boolean(availability.restore_table);
  const migrationsEnabled = Boolean(availability.migrations_table);

  const latestBackupResult = backupsEnabled
    ? await pool.query(
        `
          SELECT backup_id, label, backup_mode, status, created_at
          FROM system_backups
          ORDER BY created_at DESC
          LIMIT 1
        `
      )
    : { rows: [] };

  const latestRestoreResult = restoreEnabled
    ? await pool.query(
        `
          SELECT restore_id, backup_id, restore_mode, status, restored_at
          FROM system_restore_runs
          ORDER BY restored_at DESC
          LIMIT 1
        `
      )
    : { rows: [] };

  const migrationSummaryResult = migrationsEnabled
    ? await pool.query(
        `
          SELECT
            COUNT(*)::int AS applied_count,
            MAX(applied_at) AS latest_applied_at
          FROM schema_migrations
        `
      )
    : { rows: [{ applied_count: 0, latest_applied_at: null }] };

  const latestBackup = latestBackupResult.rows[0] || null;
  const latestRestore = latestRestoreResult.rows[0] || null;
  const migrationSummary = migrationSummaryResult.rows[0] || {};
  const backupAgeHours = hoursSince(latestBackup?.created_at);

  return {
    backups: {
      enabled: backupsEnabled,
      status: !backupsEnabled
        ? "UNAVAILABLE"
        : !latestBackup
          ? "NO_BACKUP"
          : backupAgeHours > 72
            ? "STALE"
            : "HEALTHY",
      latestBackupId: latestBackup?.backup_id || null,
      latestBackupLabel: latestBackup?.label || null,
      latestBackupMode: latestBackup?.backup_mode || null,
      latestBackupStatus: latestBackup?.status || null,
      latestBackupAt: latestBackup?.created_at || null,
      backupAgeHours: backupAgeHours == null ? null : Number(backupAgeHours.toFixed(2)),
      latestRestoreAt: latestRestore?.restored_at || null,
      latestRestoreStatus: latestRestore?.status || null,
      latestRestoreId: latestRestore?.restore_id || null,
    },
    migrations: {
      enabled: migrationsEnabled,
      status: migrationsEnabled ? "HEALTHY" : "UNAVAILABLE",
      appliedCount: Number(migrationSummary.applied_count || 0),
      latestAppliedAt: migrationSummary.latest_applied_at || null,
    },
  };
}

async function getBlockchainHealth() {
  const availabilityResult = await pool.query(`
    SELECT to_regclass('public.blockchain_ledger') AS blockchain_table
  `);
  const blockchainTable = Boolean(availabilityResult.rows[0]?.blockchain_table);

  if (!blockchainTable) {
    return {
      available: false,
      status: "UNAVAILABLE",
      totalBlocks: 0,
      totalProperties: 0,
      invalidBlocks: 0,
      invalidBlockSamples: [],
      lastBlockIndex: null,
      lastMiningTime: null,
    };
  }

  try {
    const [stats, verification] = await Promise.all([
      blockchainService.getBlockchainStats(),
      blockchainService.verifyChainDetailed(),
    ]);

    return {
      available: true,
      status: verification.isValid ? "HEALTHY" : "TAMPERED",
      totalBlocks: Number(stats.totalBlocks || 0),
      totalProperties: Number(stats.totalProperties || 0),
      invalidBlocks: Number(verification.invalidBlocks?.length || 0),
      invalidBlockSamples: (verification.invalidBlocks || []).slice(0, 5),
      lastBlockIndex: stats.lastBlockIndex ?? null,
      lastMiningTime: stats.lastMiningTime || null,
      consensusMechanism: stats.consensusMechanism || "Proof of Authority (PoA)",
      error: null,
    };
  } catch (error) {
    return {
      available: true,
      status: "DEGRADED",
      totalBlocks: 0,
      totalProperties: 0,
      invalidBlocks: 0,
      invalidBlockSamples: [],
      lastBlockIndex: null,
      lastMiningTime: null,
      consensusMechanism: "Proof of Authority (PoA)",
      error: error.message,
    };
  }
}

async function getSystemMonitoring({ tables, fabricProof }) {
  const [database, operations, blockchain] = await Promise.all([
    getDatabaseHealth(),
    getBackupHealth(),
    getBlockchainHealth(),
  ]);

  const network = fabricProof?.network || {};
  const peers = summarizeReachability(network.peers || []);
  const orderers = summarizeReachability(network.orderers || []);
  const gateway = network.gateway || {};

  return {
    api: {
      status: "HEALTHY",
      environment: process.env.NODE_ENV || "development",
      uptimeSeconds: Math.round(process.uptime()),
      checkedAt: new Date().toISOString(),
    },
    database,
    fabricNetwork: {
      status: fabricProof?.connected
        ? "HEALTHY"
        : peers.reachable > 0 || orderers.reachable > 0
          ? "DEGRADED"
          : "DOWN",
      connected: Boolean(fabricProof?.connected),
      gatewayReady: Boolean(gateway.profileLoaded && gateway.walletReady),
      profileLoaded: Boolean(gateway.profileLoaded),
      walletReady: Boolean(gateway.walletReady),
      gatewayError: gateway.error || null,
      peers,
      orderers,
      hostOverride: network.hostOverride || gateway.hostOverride || null,
    },
    backups: operations.backups,
    migrations: operations.migrations,
    blockchain,
    tables,
  };
}

function buildTamperAlerts({
  integrityRecords = [],
  monitoring,
  registration,
  transfer,
  approvedMissingMirror = 0,
}) {
  const alerts = [];
  const nowIso = new Date().toISOString();
  const tamperedProperties = integrityRecords.filter((item) => item?.tamperDetected);

  for (const record of tamperedProperties.slice(0, 6)) {
    alerts.push({
      id: `property-${record.property?.property_id}`,
      severity: "CRITICAL",
      category: "PROPERTY_TAMPER",
      title: `Property ${record.property?.property_id} failed integrity verification`,
      message:
        record.tamperReason ||
        "The current property snapshot no longer matches the approved on-chain hash.",
      targetId: record.property?.property_id || null,
      targetType: "PROPERTY",
      occurredAt:
        record.property?.updated_at ||
        record.integrity?.updated_at ||
        record.property?.created_at ||
        nowIso,
      actionLabel: "Manual review required",
    });
  }

  for (const block of monitoring?.blockchain?.invalidBlockSamples || []) {
    alerts.push({
      id: `block-${block.blockIndex}-${block.reason}`,
      severity: "CRITICAL",
      category: "BLOCKCHAIN_TAMPER",
      title: `Blockchain ledger block ${block.blockIndex} failed validation`,
      message: block.reason || "The local PoA ledger has a broken hash chain.",
      targetId: String(block.blockIndex),
      targetType: "BLOCK",
      occurredAt: nowIso,
      actionLabel: "Inspect blockchain ledger",
    });
  }

  if ((monitoring?.fabricNetwork?.status || "") !== "HEALTHY") {
    alerts.push({
      id: "fabric-network-health",
      severity: "HIGH",
      category: "FABRIC_HEALTH",
      title: "Fabric network is degraded or offline",
      message: `${monitoring?.fabricNetwork?.peers?.reachable || 0}/${monitoring?.fabricNetwork?.peers?.total || 0} peers and ${monitoring?.fabricNetwork?.orderers?.reachable || 0}/${monitoring?.fabricNetwork?.orderers?.total || 0} orderers are reachable.`,
      targetId: null,
      targetType: "FABRIC",
      occurredAt: nowIso,
      actionLabel: "Check peer and orderer reachability",
    });
  }

  if ((monitoring?.backups?.status || "") === "NO_BACKUP" || (monitoring?.backups?.status || "") === "STALE") {
    alerts.push({
      id: "backup-freshness",
      severity: monitoring?.backups?.status === "NO_BACKUP" ? "HIGH" : "MEDIUM",
      category: "BACKUP_HEALTH",
      title:
        monitoring?.backups?.status === "NO_BACKUP"
          ? "No backup has been recorded yet"
          : "Latest backup is stale",
      message:
        monitoring?.backups?.status === "NO_BACKUP"
          ? "Create an operations backup before the next workflow reset."
          : `Latest backup is ${Math.round(monitoring?.backups?.backupAgeHours || 0)} hours old.`,
      targetId: monitoring?.backups?.latestBackupId || null,
      targetType: "BACKUP",
      occurredAt: monitoring?.backups?.latestBackupAt || nowIso,
      actionLabel: "Create a fresh backup",
    });
  }

  if (approvedMissingMirror > 0) {
    alerts.push({
      id: "missing-integrity-mirrors",
      severity: "MEDIUM",
      category: "INTEGRITY_GAP",
      title: `${approvedMissingMirror} approved properties are missing local integrity mirrors`,
      message: "Run the integrity refresh so approved properties are mirrored for tamper detection and fast recovery.",
      targetId: null,
      targetType: "INTEGRITY",
      occurredAt: nowIso,
      actionLabel: "Refresh integrity mirrors",
    });
  }

  if (Number(registration?.stale || 0) > 0) {
    alerts.push({
      id: "registration-sync",
      severity: "MEDIUM",
      category: "REGISTRATION_SYNC",
      title: `${registration.stale} registration voting cases need reconciliation`,
      message: "Stored registration counts or statuses no longer match live vote rows.",
      targetId: null,
      targetType: "REGISTRATION_CASE",
      occurredAt: nowIso,
      actionLabel: "Reconcile registration cases",
    });
  }

  if (Number(transfer?.stale || 0) > 0) {
    alerts.push({
      id: "transfer-sync",
      severity: "MEDIUM",
      category: "TRANSFER_SYNC",
      title: `${transfer.stale} transfer voting cases need reconciliation`,
      message: "Stored transfer counts or statuses no longer match live vote rows.",
      targetId: null,
      targetType: "TRANSFER_CASE",
      occurredAt: nowIso,
      actionLabel: "Reconcile transfer cases",
    });
  }

  const severityWeight = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
  alerts.sort((a, b) => {
    const severityDelta = (severityWeight[b.severity] || 0) - (severityWeight[a.severity] || 0);
    if (severityDelta !== 0) return severityDelta;
    return String(b.occurredAt || "").localeCompare(String(a.occurredAt || ""));
  });

  const limited = alerts.slice(0, 12);
  return {
    total: limited.length,
    critical: limited.filter((item) => item.severity === "CRITICAL").length,
    high: limited.filter((item) => item.severity === "HIGH").length,
    medium: limited.filter((item) => item.severity === "MEDIUM").length,
    low: limited.filter((item) => item.severity === "LOW").length,
    items: limited,
  };
}

async function reconcileRegistrationCases() {
  const tables = await getTableAvailability();
  if (!tables.regCases || !tables.regVotes) {
    return { repaired: 0, remaining: 0 };
  }

  const before = await getRegistrationSummary();
  await pool.query(
    `
      UPDATE reg_blockchain_cases rbc
      SET
        approval_count = COALESCE((
          SELECT SUM(CASE WHEN UPPER(vote) = 'APPROVE' THEN 1 ELSE 0 END)::int
          FROM reg_blockchain_votes rv
          WHERE rv.property_id = rbc.property_id
        ), 0),
        rejection_count = COALESCE((
          SELECT SUM(CASE WHEN UPPER(vote) = 'REJECT' THEN 1 ELSE 0 END)::int
          FROM reg_blockchain_votes rv
          WHERE rv.property_id = rbc.property_id
        ), 0),
        status = CASE
          WHEN UPPER(COALESCE(rbc.status, '')) = 'FINALIZED' THEN 'FINALIZED'
          WHEN COALESCE((
            SELECT SUM(CASE WHEN UPPER(vote) = 'REJECT' THEN 1 ELSE 0 END)::int
            FROM reg_blockchain_votes rv
            WHERE rv.property_id = rbc.property_id
          ), 0) >= $1 THEN 'REJECTED'
          WHEN COALESCE((
            SELECT SUM(CASE WHEN UPPER(vote) = 'APPROVE' THEN 1 ELSE 0 END)::int
            FROM reg_blockchain_votes rv
            WHERE rv.property_id = rbc.property_id
          ), 0) >= $1 THEN 'READY_FOR_DC'
          ELSE CASE
            WHEN UPPER(COALESCE(rbc.status, '')) = 'SUBMITTED' THEN 'VOTING'
            ELSE 'VOTING'
          END
        END,
        lro_approved_at = CASE
          WHEN COALESCE((
            SELECT SUM(CASE WHEN UPPER(vote) = 'APPROVE' THEN 1 ELSE 0 END)::int
            FROM reg_blockchain_votes rv
            WHERE rv.property_id = rbc.property_id
          ), 0) >= $1 AND rbc.lro_approved_at IS NULL THEN NOW()
          ELSE rbc.lro_approved_at
        END,
        updated_at = NOW()
    `,
    [VOTE_THRESHOLD]
  );
  const after = await getRegistrationSummary();
  return {
    repaired: Math.max(0, before.stale - after.stale),
    remaining: after.stale,
  };
}

async function reconcileRegistrationCase(propertyId) {
  const tables = await getTableAvailability();
  if (!tables.regCases || !tables.regVotes) {
    return { found: false, repaired: 0 };
  }

  const beforeResult = await pool.query(
    `
      SELECT
        rbc.property_id,
        rbc.status,
        COALESCE(rbc.approval_count, 0) AS approval_count,
        COALESCE(rbc.rejection_count, 0) AS rejection_count
      FROM reg_blockchain_cases rbc
      WHERE rbc.property_id = $1
      LIMIT 1
    `,
    [propertyId]
  );

  if (!beforeResult.rows.length) {
    return { found: false, repaired: 0 };
  }

  await pool.query(
    `
      UPDATE reg_blockchain_cases rbc
      SET
        approval_count = COALESCE((
          SELECT SUM(CASE WHEN UPPER(vote) = 'APPROVE' THEN 1 ELSE 0 END)::int
          FROM reg_blockchain_votes rv
          WHERE rv.property_id = rbc.property_id
        ), 0),
        rejection_count = COALESCE((
          SELECT SUM(CASE WHEN UPPER(vote) = 'REJECT' THEN 1 ELSE 0 END)::int
          FROM reg_blockchain_votes rv
          WHERE rv.property_id = rbc.property_id
        ), 0),
        status = CASE
          WHEN UPPER(COALESCE(rbc.status, '')) = 'FINALIZED' THEN 'FINALIZED'
          WHEN COALESCE((
            SELECT SUM(CASE WHEN UPPER(vote) = 'REJECT' THEN 1 ELSE 0 END)::int
            FROM reg_blockchain_votes rv
            WHERE rv.property_id = rbc.property_id
          ), 0) >= $2 THEN 'REJECTED'
          WHEN COALESCE((
            SELECT SUM(CASE WHEN UPPER(vote) = 'APPROVE' THEN 1 ELSE 0 END)::int
            FROM reg_blockchain_votes rv
            WHERE rv.property_id = rbc.property_id
          ), 0) >= $2 THEN 'READY_FOR_DC'
          ELSE CASE
            WHEN UPPER(COALESCE(rbc.status, '')) = 'SUBMITTED' THEN 'VOTING'
            ELSE 'VOTING'
          END
        END,
        lro_approved_at = CASE
          WHEN COALESCE((
            SELECT SUM(CASE WHEN UPPER(vote) = 'APPROVE' THEN 1 ELSE 0 END)::int
            FROM reg_blockchain_votes rv
            WHERE rv.property_id = rbc.property_id
          ), 0) >= $2 AND rbc.lro_approved_at IS NULL THEN NOW()
          ELSE rbc.lro_approved_at
        END,
        updated_at = NOW()
      WHERE rbc.property_id = $1
    `,
    [propertyId, VOTE_THRESHOLD]
  );

  const afterResult = await pool.query(
    `
      SELECT
        property_id,
        status,
        COALESCE(approval_count, 0) AS approval_count,
        COALESCE(rejection_count, 0) AS rejection_count
      FROM reg_blockchain_cases
      WHERE property_id = $1
      LIMIT 1
    `,
    [propertyId]
  );

  const before = beforeResult.rows[0];
  const after = afterResult.rows[0];
  const repaired =
    before.status !== after.status ||
    Number(before.approval_count || 0) !== Number(after.approval_count || 0) ||
    Number(before.rejection_count || 0) !== Number(after.rejection_count || 0);

  return {
    found: true,
    repaired: repaired ? 1 : 0,
    before,
    after,
  };
}

async function reconcileTransferCases() {
  const tables = await getTableAvailability();
  if (!tables.transferCases || !tables.transferVotes) {
    return { repaired: 0, remaining: 0 };
  }

  const before = await getTransferSummary();
  await pool.query(
    `
      UPDATE transfer_blockchain_cases tbc
      SET
        approval_count = COALESCE((
          SELECT SUM(CASE WHEN UPPER(vote) = 'APPROVE' THEN 1 ELSE 0 END)::int
          FROM transfer_blockchain_votes tbv
          WHERE tbv.transfer_id = tbc.transfer_id
        ), 0),
        rejection_count = COALESCE((
          SELECT SUM(CASE WHEN UPPER(vote) = 'REJECT' THEN 1 ELSE 0 END)::int
          FROM transfer_blockchain_votes tbv
          WHERE tbv.transfer_id = tbc.transfer_id
        ), 0),
        status = CASE
          WHEN UPPER(COALESCE(tbc.status, '')) = 'FINALIZED' THEN 'FINALIZED'
          WHEN COALESCE((
            SELECT SUM(CASE WHEN UPPER(vote) = 'REJECT' THEN 1 ELSE 0 END)::int
            FROM transfer_blockchain_votes tbv
            WHERE tbv.transfer_id = tbc.transfer_id
          ), 0) >= $1 THEN 'REJECTED'
          WHEN COALESCE((
            SELECT SUM(CASE WHEN UPPER(vote) = 'APPROVE' THEN 1 ELSE 0 END)::int
            FROM transfer_blockchain_votes tbv
            WHERE tbv.transfer_id = tbc.transfer_id
          ), 0) >= $1 THEN 'READY_FOR_DC'
          ELSE CASE
            WHEN UPPER(COALESCE(tbc.status, '')) = 'SUBMITTED' THEN 'VOTING'
            ELSE 'VOTING'
          END
        END,
        lro_approved_at = CASE
          WHEN COALESCE((
            SELECT SUM(CASE WHEN UPPER(vote) = 'APPROVE' THEN 1 ELSE 0 END)::int
            FROM transfer_blockchain_votes tbv
            WHERE tbv.transfer_id = tbc.transfer_id
          ), 0) >= $1 AND tbc.lro_approved_at IS NULL THEN NOW()
          ELSE tbc.lro_approved_at
        END,
        updated_at = NOW()
    `,
    [VOTE_THRESHOLD]
  );
  const after = await getTransferSummary();
  return {
    repaired: Math.max(0, before.stale - after.stale),
    remaining: after.stale,
  };
}

async function reconcileTransferCase(transferId) {
  const tables = await getTableAvailability();
  if (!tables.transferCases || !tables.transferVotes) {
    return { found: false, repaired: 0 };
  }

  const beforeResult = await pool.query(
    `
      SELECT
        transfer_id,
        status,
        COALESCE(approval_count, 0) AS approval_count,
        COALESCE(rejection_count, 0) AS rejection_count
      FROM transfer_blockchain_cases
      WHERE transfer_id = $1
      LIMIT 1
    `,
    [transferId]
  );

  if (!beforeResult.rows.length) {
    return { found: false, repaired: 0 };
  }

  await pool.query(
    `
      UPDATE transfer_blockchain_cases tbc
      SET
        approval_count = COALESCE((
          SELECT SUM(CASE WHEN UPPER(vote) = 'APPROVE' THEN 1 ELSE 0 END)::int
          FROM transfer_blockchain_votes tbv
          WHERE tbv.transfer_id = tbc.transfer_id
        ), 0),
        rejection_count = COALESCE((
          SELECT SUM(CASE WHEN UPPER(vote) = 'REJECT' THEN 1 ELSE 0 END)::int
          FROM transfer_blockchain_votes tbv
          WHERE tbv.transfer_id = tbc.transfer_id
        ), 0),
        status = CASE
          WHEN UPPER(COALESCE(tbc.status, '')) = 'FINALIZED' THEN 'FINALIZED'
          WHEN COALESCE((
            SELECT SUM(CASE WHEN UPPER(vote) = 'REJECT' THEN 1 ELSE 0 END)::int
            FROM transfer_blockchain_votes tbv
            WHERE tbv.transfer_id = tbc.transfer_id
          ), 0) >= $2 THEN 'REJECTED'
          WHEN COALESCE((
            SELECT SUM(CASE WHEN UPPER(vote) = 'APPROVE' THEN 1 ELSE 0 END)::int
            FROM transfer_blockchain_votes tbv
            WHERE tbv.transfer_id = tbc.transfer_id
          ), 0) >= $2 THEN 'READY_FOR_DC'
          ELSE CASE
            WHEN UPPER(COALESCE(tbc.status, '')) = 'SUBMITTED' THEN 'VOTING'
            ELSE 'VOTING'
          END
        END,
        lro_approved_at = CASE
          WHEN COALESCE((
            SELECT SUM(CASE WHEN UPPER(vote) = 'APPROVE' THEN 1 ELSE 0 END)::int
            FROM transfer_blockchain_votes tbv
            WHERE tbv.transfer_id = tbc.transfer_id
          ), 0) >= $2 AND tbc.lro_approved_at IS NULL THEN NOW()
          ELSE tbc.lro_approved_at
        END,
        updated_at = NOW()
      WHERE tbc.transfer_id = $1
    `,
    [transferId, VOTE_THRESHOLD]
  );

  const afterResult = await pool.query(
    `
      SELECT
        transfer_id,
        status,
        COALESCE(approval_count, 0) AS approval_count,
        COALESCE(rejection_count, 0) AS rejection_count
      FROM transfer_blockchain_cases
      WHERE transfer_id = $1
      LIMIT 1
    `,
    [transferId]
  );

  const before = beforeResult.rows[0];
  const after = afterResult.rows[0];
  const repaired =
    before.status !== after.status ||
    Number(before.approval_count || 0) !== Number(after.approval_count || 0) ||
    Number(before.rejection_count || 0) !== Number(after.rejection_count || 0);

  return {
    found: true,
    repaired: repaired ? 1 : 0,
    before,
    after,
  };
}

async function rebuildIntegrityMirror(propertyId, userId) {
  await propertyRegistryIntegrityService.ensureTables();
  const verified = await propertyRegistryIntegrityService.verifyProperty(propertyId);

  if (!verified) {
    return { found: false };
  }

  if (verified.classification === "TAMPERED") {
    return {
      found: true,
      blocked: true,
      classification: verified.classification,
      tamperReason: verified.tamperReason,
    };
  }

  const snapshot = propertyRegistryIntegrityService.buildPropertySnapshot(verified.property);
  const propertyHash = propertyRegistryIntegrityService.hashPropertySnapshot(snapshot);
  const chainStatus =
    verified.classification === "APPROVED_ON_CHAIN"
      ? "FINALIZED"
      : verified.classification === "LOCAL_MIRROR_ONLY"
        ? "LOCAL_MIRROR_ONLY"
        : verified.classification;

  await pool.query(
    `
      INSERT INTO property_registry_integrity
        (property_id, property_hash, property_snapshot, chain_status, submitted_by_node, submitted_by_user_id, anchored_at, last_verified_hash, last_verified_at, integrity_status, created_at, updated_at)
      VALUES
        ($1, $2, $3::jsonb, $4, 'ADMIN_RECOVERY', $5, NOW(), $2, NOW(), 'CLEAN', NOW(), NOW())
      ON CONFLICT (property_id)
      DO UPDATE SET
        property_hash = EXCLUDED.property_hash,
        property_snapshot = EXCLUDED.property_snapshot,
        chain_status = EXCLUDED.chain_status,
        submitted_by_user_id = EXCLUDED.submitted_by_user_id,
        last_verified_hash = EXCLUDED.last_verified_hash,
        last_verified_at = EXCLUDED.last_verified_at,
        integrity_status = 'CLEAN',
        tamper_reason = NULL,
        updated_at = NOW()
    `,
    [propertyId, propertyHash, JSON.stringify(snapshot), chainStatus, userId]
  );

  return {
    found: true,
    blocked: false,
    propertyId,
    classification: verified.classification,
    propertyHash,
  };
}

async function refreshIntegrityMirrors(userId) {
  const propertyIdsResult = await pool.query(
    "SELECT property_id FROM properties ORDER BY COALESCE(updated_at, created_at) DESC"
  );

  let createdOrUpdated = 0;
  let blocked = 0;

  for (const row of propertyIdsResult.rows) {
    const result = await rebuildIntegrityMirror(row.property_id, userId);
    if (!result?.found) continue;
    if (result.blocked) {
      blocked += 1;
      continue;
    }
    createdOrUpdated += 1;
  }

  return {
    refreshed: createdOrUpdated,
    blocked,
  };
}

router.use(authenticateToken, requireAdmin);

router.get("/overview", async (_req, res) => {
  try {
    await auditService.ensureSchema();

    const [tables, fabricProof, integrityRecords, registration, transfer, audit] = await Promise.all([
      getTableAvailability(),
      fabricPLRAService.getConnectivityProof(),
      propertyRegistryIntegrityService.listRecords({ skipFabric: true }),
      getRegistrationSummary(),
      getTransferSummary(),
      auditService.getSummary(),
    ]);

    const cleanIntegrityRecords = (integrityRecords || []).filter(Boolean);
    const integritySummary = summarizeIntegrityRecords(cleanIntegrityRecords);

    const approvedMissingMirrorResult = await pool.query(
      `
        SELECT COUNT(*)::int AS count
        FROM properties p
        LEFT JOIN property_registry_integrity pri ON pri.property_id = p.property_id
        WHERE UPPER(COALESCE(p.status, '')) = 'APPROVED'
          AND pri.property_id IS NULL
      `
    );

    const paidTransferBacklogResult = tables.transferCases
      ? await pool.query(
          `
            SELECT COUNT(*)::int AS count
            FROM transfer_requests tr
            LEFT JOIN transfer_blockchain_cases tbc ON tbc.transfer_id = tr.transfer_id
            WHERE (tr.payment_status = 'PAID' OR tr.challan_txn_id IS NOT NULL)
              AND COALESCE(tr.seller_agreed, FALSE) = TRUE
              AND COALESCE(tr.buyer_agreed, FALSE) = TRUE
              AND (tbc.transfer_id IS NULL OR UPPER(COALESCE(tbc.status, '')) = 'REJECTED')
          `
        )
      : { rows: [{ count: 0 }] };

    const approvedMissingMirror = Number(approvedMissingMirrorResult.rows[0]?.count || 0);
    const paidBacklog = Number(paidTransferBacklogResult.rows[0]?.count || 0);
    const system = await getSystemMonitoring({ tables, fabricProof });
    const alerts = buildTamperAlerts({
      integrityRecords: cleanIntegrityRecords,
      monitoring: system,
      registration,
      transfer: { ...transfer, paidBacklog },
      approvedMissingMirror,
    });

    return res.json({
      success: true,
      generatedAt: new Date().toISOString(),
      tables,
      fabric: {
        connected: Boolean(fabricProof.connected),
        sameVotingNodesForRegistryAndTransfer: Boolean(
          fabricProof.sameVotingNodesForRegistryAndTransfer
        ),
        nodeCount: fabricProof?.topology?.nodeCount || 5,
        voteThreshold: fabricProof?.topology?.voteThreshold || VOTE_THRESHOLD,
        probes: fabricProof.probes,
      },
      integrity: {
        ...integritySummary,
        approvedMissingMirror,
      },
      registration,
      transfer: {
        ...transfer,
        paidBacklog,
      },
      audit,
      system,
      alerts,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/issues", async (_req, res) => {
  try {
    const [integrityIssues, registrationIssues, transferIssues] = await Promise.all([
      getIntegrityIssues(6),
      getRegistrationIssues(6),
      getTransferIssues(6),
    ]);

    return res.json({
      success: true,
      integrityIssues,
      registrationIssues,
      transferIssues,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/audit-logs", async (req, res) => {
  try {
    const payload = await auditService.listLogs({
      limit: req.query.limit,
      offset: req.query.offset,
      actionType: req.query.actionType,
      userId: req.query.userId,
      targetType: req.query.targetType,
      status: req.query.status,
      search: req.query.search,
    });

    return res.json({
      success: true,
      ...payload,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/reconcile", async (req, res) => {
  try {
    const scope = String(req.body.scope || "all").toLowerCase();
    const result = {};

    if (scope === "all" || scope === "registration") {
      result.registration = await reconcileRegistrationCases();
    }

    if (scope === "all" || scope === "transfer") {
      result.transfer = await reconcileTransferCases();
    }

    if (scope === "all" || scope === "integrity") {
      result.integrity = await refreshIntegrityMirrors(req.user.userId);
    }

    await auditService.writeLog({
      userId: req.user.userId,
      actionType: "ADMIN_RECOVERY_RECONCILE",
      targetType: "RECOVERY",
      details: { scope, result },
      ipAddress: req.ip || "unknown",
      routePath: req.originalUrl,
      httpMethod: req.method,
      status: "SUCCESS",
    });

    return res.json({
      success: true,
      message: "Recovery reconciliation completed",
      scope,
      result,
    });
  } catch (error) {
    await auditService.writeLog({
      userId: req.user.userId,
      actionType: "ADMIN_RECOVERY_RECONCILE",
      targetType: "RECOVERY",
      details: { scope: req.body.scope || "all", error: error.message },
      ipAddress: req.ip || "unknown",
      routePath: req.originalUrl,
      httpMethod: req.method,
      status: "FAILED",
    }).catch(() => {});

    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/properties/:propertyId/rebuild-integrity", async (req, res) => {
  try {
    const { propertyId } = req.params;
    const result = await rebuildIntegrityMirror(propertyId, req.user.userId);

    if (!result?.found) {
      return res.status(404).json({ success: false, message: "Property not found" });
    }

    if (result.blocked) {
      return res.status(409).json({
        success: false,
        message: "Property is flagged as tampered. Mirror rebuild is blocked until manual review.",
        tamperReason: result.tamperReason,
      });
    }

    await auditService.writeLog({
      userId: req.user.userId,
      actionType: "ADMIN_REBUILD_INTEGRITY",
      targetId: propertyId,
      targetType: "PROPERTY",
      details: result,
      ipAddress: req.ip || "unknown",
      routePath: req.originalUrl,
      httpMethod: req.method,
      status: "SUCCESS",
    });

    return res.json({
      success: true,
      message: "Property integrity mirror rebuilt successfully",
      result,
    });
  } catch (error) {
    await auditService.writeLog({
      userId: req.user.userId,
      actionType: "ADMIN_REBUILD_INTEGRITY",
      targetId: req.params.propertyId,
      targetType: "PROPERTY",
      details: { error: error.message },
      ipAddress: req.ip || "unknown",
      routePath: req.originalUrl,
      httpMethod: req.method,
      status: "FAILED",
    }).catch(() => {});

    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/registration/:propertyId/reconcile", async (req, res) => {
  try {
    const { propertyId } = req.params;
    const result = await reconcileRegistrationCase(propertyId);

    if (!result.found) {
      return res.status(404).json({ success: false, message: "Registration case not found" });
    }

    await auditService.writeLog({
      userId: req.user.userId,
      actionType: "ADMIN_REPAIR_REGISTRATION_CASE",
      targetId: propertyId,
      targetType: "REGISTRATION_CASE",
      details: result,
      ipAddress: req.ip || "unknown",
      routePath: req.originalUrl,
      httpMethod: req.method,
      status: "SUCCESS",
    });

    return res.json({
      success: true,
      message: result.repaired
        ? "Registration case repaired successfully"
        : "Registration case was already in sync",
      result,
    });
  } catch (error) {
    await auditService.writeLog({
      userId: req.user.userId,
      actionType: "ADMIN_REPAIR_REGISTRATION_CASE",
      targetId: req.params.propertyId,
      targetType: "REGISTRATION_CASE",
      details: { error: error.message },
      ipAddress: req.ip || "unknown",
      routePath: req.originalUrl,
      httpMethod: req.method,
      status: "FAILED",
    }).catch(() => {});

    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/transfer/:transferId/reconcile", async (req, res) => {
  try {
    const { transferId } = req.params;
    const result = await reconcileTransferCase(transferId);

    if (!result.found) {
      return res.status(404).json({ success: false, message: "Transfer case not found" });
    }

    await auditService.writeLog({
      userId: req.user.userId,
      actionType: "ADMIN_REPAIR_TRANSFER_CASE",
      targetId: transferId,
      targetType: "TRANSFER_CASE",
      details: result,
      ipAddress: req.ip || "unknown",
      routePath: req.originalUrl,
      httpMethod: req.method,
      status: "SUCCESS",
    });

    return res.json({
      success: true,
      message: result.repaired
        ? "Transfer case repaired successfully"
        : "Transfer case was already in sync",
      result,
    });
  } catch (error) {
    await auditService.writeLog({
      userId: req.user.userId,
      actionType: "ADMIN_REPAIR_TRANSFER_CASE",
      targetId: req.params.transferId,
      targetType: "TRANSFER_CASE",
      details: { error: error.message },
      ipAddress: req.ip || "unknown",
      routePath: req.originalUrl,
      httpMethod: req.method,
      status: "FAILED",
    }).catch(() => {});

    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
