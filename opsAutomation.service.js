import crypto from "crypto";

import pool from "../config/db.js";
import auditService from "./audit.service.js";
import blockchainService from "./blockchain.service.js";
import fabricPLRAService from "./fabricPLRA.service.js";
import propertyRegistryIntegrityService from "./propertyRegistryIntegrity.service.js";
import { createBackup } from "../ops/backup.js";

const VOTE_THRESHOLD = 3;
const ALERT_SEVERITY_WEIGHT = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function toPositiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.trunc(numeric);
}

function hoursSince(timestamp) {
  if (!timestamp) return null;
  const value = new Date(timestamp).getTime();
  if (!Number.isFinite(value)) return null;
  return Math.max(0, (Date.now() - value) / (1000 * 60 * 60));
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

function fingerprintAlert(alert) {
  const source = [
    alert.category || "",
    alert.targetType || "",
    alert.targetId || "",
    alert.title || "",
  ].join("|");
  return crypto.createHash("sha256").update(source).digest("hex");
}

function logCriticalAlertLocally(alert) {
  console.log("\n[OPS ALERT:LOCAL_ONLY]");
  console.log(`Severity: ${alert.severity}`);
  console.log(`Category: ${alert.category}`);
  console.log(`Target: ${alert.targetType || "SYSTEM"}${alert.targetId ? ` | ${alert.targetId}` : ""}`);
  console.log(`Time: ${alert.occurredAt || new Date().toISOString()}`);
  console.log(`Title: ${alert.title}`);
  console.log("");
  console.log(alert.message);
  console.log("[/OPS ALERT:LOCAL_ONLY]\n");
}

class OpsAutomationService {
  constructor() {
    this.healthInterval = null;
    this.backupInterval = null;
    this.started = false;
    this.schemaReadyPromise = null;
  }

  getConfig() {
    return {
      enabled: toBoolean(process.env.OPS_AUTOMATION_ENABLED, true),
      backupEnabled: toBoolean(process.env.OPS_BACKUP_SCHEDULER_ENABLED, true),
      healthEnabled: toBoolean(process.env.OPS_HEALTH_MONITOR_ENABLED, true),
      backupIntervalMinutes: toPositiveInteger(process.env.OPS_BACKUP_INTERVAL_MINUTES, 24 * 60),
      healthIntervalMinutes: toPositiveInteger(process.env.OPS_HEALTH_INTERVAL_MINUTES, 30),
      backupStartupDelayMs: toPositiveInteger(process.env.OPS_BACKUP_STARTUP_DELAY_MS, 60_000),
      healthStartupDelayMs: toPositiveInteger(process.env.OPS_HEALTH_STARTUP_DELAY_MS, 15_000),
      alertRepeatMinutes: toPositiveInteger(process.env.OPS_ALERT_REPEAT_MINUTES, 180),
      alertMinSeverity: String(process.env.OPS_ALERT_MIN_SEVERITY || "CRITICAL").trim().toUpperCase(),
    };
  }

  async ensureSchema() {
    if (!this.schemaReadyPromise) {
      this.schemaReadyPromise = (async () => {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS system_health_snapshots (
            id BIGSERIAL PRIMARY KEY,
            snapshot_type VARCHAR(40) NOT NULL DEFAULT 'OPS_AUTOMATION',
            overall_status VARCHAR(24) NOT NULL DEFAULT 'HEALTHY',
            payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS system_alerts (
            id BIGSERIAL PRIMARY KEY,
            fingerprint VARCHAR(128) NOT NULL UNIQUE,
            severity VARCHAR(16) NOT NULL,
            category VARCHAR(80) NOT NULL,
            title TEXT NOT NULL,
            message TEXT NOT NULL,
            target_id VARCHAR(160),
            target_type VARCHAR(80),
            status VARCHAR(24) NOT NULL DEFAULT 'OPEN',
            payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            resolved_at TIMESTAMPTZ,
            occurrence_count INTEGER NOT NULL DEFAULT 1,
            last_delivery_at TIMESTAMPTZ,
            last_delivery_status VARCHAR(40)
          )
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS system_job_runs (
            id BIGSERIAL PRIMARY KEY,
            job_name VARCHAR(60) NOT NULL,
            status VARCHAR(24) NOT NULL DEFAULT 'SUCCESS',
            details JSONB NOT NULL DEFAULT '{}'::jsonb,
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            finished_at TIMESTAMPTZ
          )
        `);

        await pool.query(
          `CREATE INDEX IF NOT EXISTS idx_system_health_snapshots_created_at ON system_health_snapshots(created_at DESC)`
        );
        await pool.query(
          `CREATE INDEX IF NOT EXISTS idx_system_alerts_status_severity ON system_alerts(status, severity, last_seen_at DESC)`
        );
        await pool.query(
          `CREATE INDEX IF NOT EXISTS idx_system_job_runs_job_name_started_at ON system_job_runs(job_name, started_at DESC)`
        );
      })().catch((error) => {
        this.schemaReadyPromise = null;
        throw error;
      });
    }

    return this.schemaReadyPromise;
  }

  async recordJobRun(jobName, status, details, startedAt = new Date()) {
    await this.ensureSchema();
    await pool.query(
      `
        INSERT INTO system_job_runs (job_name, status, details, started_at, finished_at)
        VALUES ($1, $2, $3::jsonb, $4, NOW())
      `,
      [jobName, status, JSON.stringify(details || {}), startedAt]
    );
  }

  async getTableAvailability() {
    const result = await pool.query(`
      SELECT
        to_regclass('public.property_registry_integrity') AS integrity_table,
        to_regclass('public.reg_blockchain_cases') AS reg_cases,
        to_regclass('public.reg_blockchain_votes') AS reg_votes,
        to_regclass('public.transfer_blockchain_cases') AS transfer_cases,
        to_regclass('public.transfer_blockchain_votes') AS transfer_votes,
        to_regclass('public.system_backups') AS backup_table
    `);

    const row = result.rows[0] || {};
    return {
      integrity: Boolean(row.integrity_table),
      regCases: Boolean(row.reg_cases),
      regVotes: Boolean(row.reg_votes),
      transferCases: Boolean(row.transfer_cases),
      transferVotes: Boolean(row.transfer_votes),
      backups: Boolean(row.backup_table),
    };
  }

  async getRegistrationSummary() {
    const tables = await this.getTableAvailability();
    if (!tables.regCases || !tables.regVotes) {
      return { total: 0, voting: 0, readyForDc: 0, finalized: 0, rejected: 0, stale: 0 };
    }

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

  async getTransferSummary() {
    const tables = await this.getTableAvailability();
    if (!tables.transferCases || !tables.transferVotes) {
      return { total: 0, voting: 0, readyForDc: 0, finalized: 0, rejected: 0, stale: 0, paidBacklog: 0 };
    }

    const [summaryResult, paidBacklogResult] = await Promise.all([
      pool.query(
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
      ),
      pool.query(
        `
          SELECT COUNT(*)::int AS count
          FROM transfer_requests tr
          LEFT JOIN transfer_blockchain_cases tbc ON tbc.transfer_id = tr.transfer_id
          WHERE (tr.payment_status = 'PAID' OR tr.challan_txn_id IS NOT NULL)
            AND COALESCE(tr.seller_agreed, FALSE) = TRUE
            AND COALESCE(tr.buyer_agreed, FALSE) = TRUE
            AND (tbc.transfer_id IS NULL OR UPPER(COALESCE(tbc.status, '')) = 'REJECTED')
        `
      ),
    ]);

    const row = summaryResult.rows[0] || {};
    return {
      total: Number(row.total || 0),
      voting: Number(row.voting || 0),
      readyForDc: Number(row.ready_for_dc || 0),
      finalized: Number(row.finalized || 0),
      rejected: Number(row.rejected || 0),
      stale: Number(row.stale || 0),
      paidBacklog: Number(paidBacklogResult.rows[0]?.count || 0),
    };
  }

  async getDatabaseHealth() {
    const startedAt = Date.now();
    await pool.query("SELECT NOW()");
    const latencyMs = Date.now() - startedAt;
    return {
      status: latencyMs <= 150 ? "HEALTHY" : latencyMs <= 500 ? "DEGRADED" : "SLOW",
      connected: true,
      latencyMs,
    };
  }

  async getBackupHealth() {
    const availability = await this.getTableAvailability();
    const latestBackupResult = availability.backups
      ? await pool.query(
          `
            SELECT backup_id, label, backup_mode, status, created_at
            FROM system_backups
            ORDER BY created_at DESC
            LIMIT 1
          `
        )
      : { rows: [] };

    const latestBackup = latestBackupResult.rows[0] || null;
    const backupAgeHours = hoursSince(latestBackup?.created_at);

    return {
      enabled: availability.backups,
      status: !availability.backups
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
    };
  }

  async getBlockchainHealth() {
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
        error: null,
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

  buildAlerts({ integrityRecords, monitoring, registration, transfer, approvedMissingMirror }) {
    const alerts = [];
    const nowIso = new Date().toISOString();

    for (const record of integrityRecords.filter((item) => item?.tamperDetected).slice(0, 6)) {
      alerts.push({
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
      });
    }

    for (const block of monitoring?.blockchain?.invalidBlockSamples || []) {
      alerts.push({
        severity: "CRITICAL",
        category: "BLOCKCHAIN_TAMPER",
        title: `Blockchain ledger block ${block.blockIndex} failed validation`,
        message: block.reason || "The local PoA ledger has a broken hash chain.",
        targetId: String(block.blockIndex),
        targetType: "BLOCK",
        occurredAt: nowIso,
      });
    }

    if ((monitoring?.fabricNetwork?.status || "") === "DOWN" || (monitoring?.fabricNetwork?.status || "") === "DEGRADED") {
      alerts.push({
        severity: monitoring?.fabricNetwork?.status === "DOWN" ? "CRITICAL" : "HIGH",
        category: "FABRIC_HEALTH",
        title: monitoring?.fabricNetwork?.status === "DOWN" ? "Fabric network is offline" : "Fabric network is degraded",
        message: `${monitoring?.fabricNetwork?.peers?.reachable || 0}/${monitoring?.fabricNetwork?.peers?.total || 0} peers and ${monitoring?.fabricNetwork?.orderers?.reachable || 0}/${monitoring?.fabricNetwork?.orderers?.total || 0} orderers are reachable.`,
        targetId: null,
        targetType: "FABRIC",
        occurredAt: nowIso,
      });
    }

    if ((monitoring?.backups?.status || "") === "NO_BACKUP" || (monitoring?.backups?.status || "") === "STALE") {
      alerts.push({
        severity: monitoring?.backups?.status === "NO_BACKUP" ? "HIGH" : "MEDIUM",
        category: "BACKUP_HEALTH",
        title:
          monitoring?.backups?.status === "NO_BACKUP"
            ? "No operations backup has been created yet"
            : "Latest backup is stale",
        message:
          monitoring?.backups?.status === "NO_BACKUP"
            ? "Create a backup before the next workflow or Fabric reset."
            : `Latest backup is ${Math.round(monitoring?.backups?.backupAgeHours || 0)} hours old.`,
        targetId: monitoring?.backups?.latestBackupId || null,
        targetType: "BACKUP",
        occurredAt: monitoring?.backups?.latestBackupAt || nowIso,
      });
    }

    if (approvedMissingMirror > 0) {
      alerts.push({
        severity: "MEDIUM",
        category: "INTEGRITY_GAP",
        title: `${approvedMissingMirror} approved properties are missing integrity mirrors`,
        message: "Run an integrity refresh so approved properties are mirrored for tamper detection.",
        targetId: null,
        targetType: "INTEGRITY",
        occurredAt: nowIso,
      });
    }

    if (Number(registration?.stale || 0) > 0) {
      alerts.push({
        severity: "MEDIUM",
        category: "REGISTRATION_SYNC",
        title: `${registration.stale} registration cases need reconciliation`,
        message: "Stored registration statuses or counters no longer match live vote rows.",
        targetId: null,
        targetType: "REGISTRATION_CASE",
        occurredAt: nowIso,
      });
    }

    if (Number(transfer?.stale || 0) > 0) {
      alerts.push({
        severity: "MEDIUM",
        category: "TRANSFER_SYNC",
        title: `${transfer.stale} transfer cases need reconciliation`,
        message: "Stored transfer statuses or counters no longer match live vote rows.",
        targetId: null,
        targetType: "TRANSFER_CASE",
        occurredAt: nowIso,
      });
    }

    alerts.sort((a, b) => {
      const severityDelta =
        (ALERT_SEVERITY_WEIGHT[b.severity] || 0) - (ALERT_SEVERITY_WEIGHT[a.severity] || 0);
      if (severityDelta !== 0) return severityDelta;
      return String(b.occurredAt || "").localeCompare(String(a.occurredAt || ""));
    });

    return alerts;
  }

  async collectOverview() {
    const [tables, fabricProof, integrityRecords, registration, transfer, audit] = await Promise.all([
      this.getTableAvailability(),
      fabricPLRAService.getConnectivityProof().catch((error) => ({
        connected: false,
        sameVotingNodesForRegistryAndTransfer: true,
        topology: fabricPLRAService.buildVotingTopology(),
        network: { peers: [], orderers: [], gateway: { error: error.message } },
        probes: {
          registrationQuery: { ok: false, error: error.message, result: null },
          transferQuery: { ok: false, error: error.message, result: null },
          successionQuery: { ok: false, error: error.message, result: null },
        },
      })),
      propertyRegistryIntegrityService.listRecords({ skipFabric: true }),
      this.getRegistrationSummary(),
      this.getTransferSummary(),
      auditService.getSummary(),
    ]);

    const cleanIntegrityRecords = (integrityRecords || []).filter(Boolean);
    const integrity = summarizeIntegrityRecords(cleanIntegrityRecords);

    const approvedMissingMirrorResult = await pool.query(
      `
        SELECT COUNT(*)::int AS count
        FROM properties p
        LEFT JOIN property_registry_integrity pri ON pri.property_id = p.property_id
        WHERE UPPER(COALESCE(p.status, '')) = 'APPROVED'
          AND pri.property_id IS NULL
      `
    );
    const approvedMissingMirror = Number(approvedMissingMirrorResult.rows[0]?.count || 0);

    const [database, backups, blockchain] = await Promise.all([
      this.getDatabaseHealth(),
      this.getBackupHealth(),
      this.getBlockchainHealth(),
    ]);

    const network = fabricProof?.network || {};
    const peers = summarizeReachability(network.peers || []);
    const orderers = summarizeReachability(network.orderers || []);
    const gateway = network.gateway || {};

    const monitoring = {
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
      },
      backups,
      blockchain,
    };

    const alerts = this.buildAlerts({
      integrityRecords: cleanIntegrityRecords,
      monitoring,
      registration,
      transfer,
      approvedMissingMirror,
    });

    return {
      generatedAt: new Date().toISOString(),
      tables,
      integrity: {
        ...integrity,
        approvedMissingMirror,
      },
      registration,
      transfer,
      audit,
      monitoring,
      alerts,
    };
  }

  async persistHealthSnapshot(overview) {
    await this.ensureSchema();
    const statuses = [
      overview.monitoring?.api?.status,
      overview.monitoring?.database?.status,
      overview.monitoring?.fabricNetwork?.status,
      overview.monitoring?.backups?.status,
      overview.monitoring?.blockchain?.status,
    ].map((item) => String(item || "HEALTHY").toUpperCase());

    const overallStatus = statuses.includes("CRITICAL") || statuses.includes("DOWN")
      ? "CRITICAL"
      : statuses.includes("TAMPERED") || statuses.includes("DEGRADED") || statuses.includes("SLOW")
        ? "DEGRADED"
        : "HEALTHY";

    await pool.query(
      `
        INSERT INTO system_health_snapshots (snapshot_type, overall_status, payload)
        VALUES ('OPS_AUTOMATION', $1, $2::jsonb)
      `,
      [overallStatus, JSON.stringify(overview)]
    );
  }

  async syncAlerts(alerts = []) {
    await this.ensureSchema();
    const activeFingerprints = [];

    for (const alert of alerts) {
      const fingerprint = fingerprintAlert(alert);
      activeFingerprints.push(fingerprint);

      await pool.query(
        `
          INSERT INTO system_alerts (
            fingerprint, severity, category, title, message,
            target_id, target_type, status, payload,
            first_seen_at, last_seen_at, occurrence_count, resolved_at
          )
          VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, 'OPEN', $8::jsonb,
            NOW(), NOW(), 1, NULL
          )
          ON CONFLICT (fingerprint) DO UPDATE
          SET severity = EXCLUDED.severity,
              category = EXCLUDED.category,
              title = EXCLUDED.title,
              message = EXCLUDED.message,
              target_id = EXCLUDED.target_id,
              target_type = EXCLUDED.target_type,
              payload = EXCLUDED.payload,
              status = 'OPEN',
              last_seen_at = NOW(),
              resolved_at = NULL,
              occurrence_count = system_alerts.occurrence_count + 1
        `,
        [
          fingerprint,
          alert.severity,
          alert.category,
          alert.title,
          alert.message,
          alert.targetId,
          alert.targetType,
          JSON.stringify(alert),
        ]
      );
    }

    if (activeFingerprints.length > 0) {
      await pool.query(
        `
          UPDATE system_alerts
          SET status = 'RESOLVED',
              resolved_at = NOW()
          WHERE status = 'OPEN'
            AND NOT (fingerprint = ANY($1::varchar[]))
        `,
        [activeFingerprints]
      );
    } else {
      await pool.query(
        `
          UPDATE system_alerts
          SET status = 'RESOLVED',
              resolved_at = NOW()
          WHERE status = 'OPEN'
        `
      );
    }
  }

  shouldDeliver(alert) {
    const config = this.getConfig();
    const minSeverityWeight = ALERT_SEVERITY_WEIGHT[config.alertMinSeverity] || ALERT_SEVERITY_WEIGHT.CRITICAL;
    return (ALERT_SEVERITY_WEIGHT[String(alert.severity || "").toUpperCase()] || 0) >= minSeverityWeight;
  }

  async deliverAlerts(alerts = []) {
    await this.ensureSchema();
    const config = this.getConfig();

    let delivered = 0;
    let skipped = 0;

    for (const alert of alerts) {
      const fingerprint = fingerprintAlert(alert);
      const rowResult = await pool.query(
        `
          SELECT id, last_delivery_at, last_delivery_status
          FROM system_alerts
          WHERE fingerprint = $1
          LIMIT 1
        `,
        [fingerprint]
      );
      const row = rowResult.rows[0];
      if (!row || !this.shouldDeliver(alert)) {
        skipped += 1;
        continue;
      }

      const recentDeliveryHours = hoursSince(row.last_delivery_at);
      if (
        recentDeliveryHours !== null &&
        recentDeliveryHours * 60 < config.alertRepeatMinutes &&
        String(row.last_delivery_status || "").toUpperCase() === "LOCAL_LOGGED"
      ) {
        skipped += 1;
        continue;
      }

      try {
        logCriticalAlertLocally(alert);

        await pool.query(
          `
            UPDATE system_alerts
            SET last_delivery_at = NOW(),
                last_delivery_status = $2
            WHERE fingerprint = $1
          `,
          [fingerprint, "LOCAL_LOGGED"]
        );

        await auditService.writeLog({
          userId: "SYSTEM",
          actionType: "OPS_ALERT_DELIVERY",
          targetId: alert.targetId || alert.category,
          targetType: alert.targetType || "SYSTEM_ALERT",
          details: {
            severity: alert.severity,
            category: alert.category,
            delivery: {
              delivered: false,
              localLogged: true,
            },
          },
          routePath: "ops-automation",
          httpMethod: "SYSTEM",
          status: "SUCCESS",
        }).catch(() => {});

        delivered += 1;
      } catch (error) {
        await pool.query(
          `
            UPDATE system_alerts
            SET last_delivery_at = NOW(),
                last_delivery_status = $2
            WHERE fingerprint = $1
          `,
          [fingerprint, `FAILED:${error.message}`.slice(0, 40)]
        );
        skipped += 1;
      }
    }

    return { delivered, skipped, recipients: [] };
  }

  async runHealthMonitoringCycle() {
    const startedAt = new Date();
    await this.ensureSchema();

    try {
      const overview = await this.collectOverview();
      await this.persistHealthSnapshot(overview);
      await this.syncAlerts(overview.alerts);
      const delivery = await this.deliverAlerts(overview.alerts);

      const details = {
        alertCount: overview.alerts.length,
        deliveredAlerts: delivery.delivered,
        skippedAlerts: delivery.skipped,
        recipients: delivery.recipients,
      };

      await this.recordJobRun("HEALTH_MONITOR", "SUCCESS", details, startedAt);
      return details;
    } catch (error) {
      await this.recordJobRun("HEALTH_MONITOR", "FAILED", { error: error.message }, startedAt);
      throw error;
    }
  }

  async getLastBackupCreatedAt() {
    const availability = await this.getTableAvailability();
    if (!availability.backups) return null;
    const result = await pool.query(
      `
        SELECT created_at
        FROM system_backups
        ORDER BY created_at DESC
        LIMIT 1
      `
    );
    return result.rows[0]?.created_at || null;
  }

  async runScheduledBackupCycle(force = false) {
    const startedAt = new Date();
    await this.ensureSchema();
    const config = this.getConfig();

    try {
      if (!force) {
        const lastBackupAt = await this.getLastBackupCreatedAt();
        const ageHours = hoursSince(lastBackupAt);
        if (lastBackupAt && ageHours !== null && ageHours * 60 < config.backupIntervalMinutes) {
          const details = {
            skipped: true,
            reason: "BACKUP_NOT_DUE",
            lastBackupAt,
            ageHours,
          };
          await this.recordJobRun("SCHEDULED_BACKUP", "SKIPPED", details, startedAt);
          return details;
        }
      }

      const label = `scheduled-${new Date().toISOString().slice(0, 10)}`;
      await createBackup({ label });
      const details = { skipped: false, label };
      await this.recordJobRun("SCHEDULED_BACKUP", "SUCCESS", details, startedAt);

      await auditService.writeLog({
        userId: "SYSTEM",
        actionType: "OPS_SCHEDULED_BACKUP",
        targetType: "BACKUP",
        details,
        routePath: "ops-automation",
        httpMethod: "SYSTEM",
        status: "SUCCESS",
      }).catch(() => {});

      return details;
    } catch (error) {
      await this.recordJobRun("SCHEDULED_BACKUP", "FAILED", { error: error.message }, startedAt);
      throw error;
    }
  }

  start() {
    const config = this.getConfig();
    if (!config.enabled || this.started) {
      return;
    }

    this.started = true;
    console.log("[OPS] Automation scheduler enabled");

    this.ensureSchema().catch((error) => {
      console.error("[OPS] Failed to verify automation schema:", error.message);
    });

    if (config.healthEnabled) {
      setTimeout(() => {
        this.runHealthMonitoringCycle().catch((error) => {
          console.error("[OPS] Health monitor failed:", error.message);
        });
      }, config.healthStartupDelayMs).unref?.();

      this.healthInterval = setInterval(() => {
        this.runHealthMonitoringCycle().catch((error) => {
          console.error("[OPS] Health monitor failed:", error.message);
        });
      }, config.healthIntervalMinutes * 60 * 1000);
      this.healthInterval.unref?.();
    }

    if (config.backupEnabled) {
      setTimeout(() => {
        this.runScheduledBackupCycle(false).catch((error) => {
          console.error("[OPS] Scheduled backup failed:", error.message);
        });
      }, config.backupStartupDelayMs).unref?.();

      this.backupInterval = setInterval(() => {
        this.runScheduledBackupCycle(false).catch((error) => {
          console.error("[OPS] Scheduled backup failed:", error.message);
        });
      }, config.backupIntervalMinutes * 60 * 1000);
      this.backupInterval.unref?.();
    }
  }

  stop() {
    if (this.healthInterval) clearInterval(this.healthInterval);
    if (this.backupInterval) clearInterval(this.backupInterval);
    this.healthInterval = null;
    this.backupInterval = null;
    this.started = false;
  }
}

export default new OpsAutomationService();
