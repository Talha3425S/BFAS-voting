import pool from "../config/db.js";

const CREATE_AUDIT_LOGS_SQL = `
  CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id VARCHAR(60),
    action_type VARCHAR(120) NOT NULL,
    target_id VARCHAR(160),
    target_type VARCHAR(60),
    details TEXT,
    ip_address VARCHAR(120),
    route_path TEXT,
    http_method VARCHAR(12),
    status VARCHAR(20) DEFAULT 'SUCCESS',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`;

const OPTIONAL_COLUMNS = [
  ["id", "BIGSERIAL"],
  ["target_type", "VARCHAR(60)"],
  ["ip_address", "VARCHAR(120)"],
  ["route_path", "TEXT"],
  ["http_method", "VARCHAR(12)"],
  ["status", "VARCHAR(20) DEFAULT 'SUCCESS'"],
  ["created_at", "TIMESTAMPTZ DEFAULT NOW()"],
];

let auditSchemaReadyPromise = null;

function safeJsonParse(value) {
  if (!value || typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch (_error) {
    return value;
  }
}

function normalizeLimit(value, fallback = 20, max = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.trunc(parsed), max);
}

class AuditService {
  async ensureSchema() {
    if (!auditSchemaReadyPromise) {
      auditSchemaReadyPromise = (async () => {
        await pool.query(CREATE_AUDIT_LOGS_SQL);

        for (const [columnName, columnType] of OPTIONAL_COLUMNS) {
          await pool.query(
            `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ${columnName} ${columnType}`
          );
        }

        await pool.query(
          `CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC)`
        );
        await pool.query(
          `CREATE INDEX IF NOT EXISTS idx_audit_logs_action_type ON audit_logs (action_type)`
        );
        await pool.query(
          `CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs (user_id)`
        );
      })().catch((error) => {
        auditSchemaReadyPromise = null;
        throw error;
      });
    }

    return auditSchemaReadyPromise;
  }

  async writeLog({
    userId = null,
    actionType,
    targetId = null,
    targetType = null,
    details = null,
    ipAddress = null,
    routePath = null,
    httpMethod = null,
    status = "SUCCESS",
  }) {
    if (!actionType) {
      throw new Error("Audit log actionType is required");
    }

    await this.ensureSchema();

    const serializedDetails =
      details == null
        ? null
        : typeof details === "string"
          ? details
          : JSON.stringify(details);

    await pool.query(
      `INSERT INTO audit_logs
         (user_id, action_type, target_id, target_type, details, ip_address, route_path, http_method, status)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        userId,
        String(actionType).toUpperCase(),
        targetId,
        targetType ? String(targetType).toUpperCase() : null,
        serializedDetails,
        ipAddress,
        routePath,
        httpMethod ? String(httpMethod).toUpperCase() : null,
        status ? String(status).toUpperCase() : "SUCCESS",
      ]
    );
  }

  async listLogs({
    limit = 20,
    offset = 0,
    actionType = "",
    userId = "",
    targetType = "",
    status = "",
    search = "",
  } = {}) {
    await this.ensureSchema();

    const conditions = [];
    const params = [];
    let index = 1;

    if (actionType) {
      conditions.push(`UPPER(action_type) = $${index++}`);
      params.push(String(actionType).toUpperCase());
    }

    if (userId) {
      conditions.push(`user_id = $${index++}`);
      params.push(userId);
    }

    if (targetType) {
      conditions.push(`UPPER(COALESCE(target_type, '')) = $${index++}`);
      params.push(String(targetType).toUpperCase());
    }

    if (status) {
      conditions.push(`UPPER(COALESCE(status, 'SUCCESS')) = $${index++}`);
      params.push(String(status).toUpperCase());
    }

    if (search) {
      conditions.push(
        `(COALESCE(action_type, '') ILIKE $${index} OR COALESCE(target_id, '') ILIKE $${index} OR COALESCE(details, '') ILIKE $${index})`
      );
      params.push(`%${search}%`);
      index += 1;
    }

    const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const safeLimit = normalizeLimit(limit);
    const safeOffset = Math.max(0, Number(offset) || 0);

    const [rowsResult, totalResult] = await Promise.all([
      pool.query(
        `SELECT id, user_id, action_type, target_id, target_type, details, ip_address, route_path, http_method, status, created_at
         FROM audit_logs
         ${whereSql}
         ORDER BY created_at DESC
         LIMIT $${index} OFFSET $${index + 1}`,
        [...params, safeLimit, safeOffset]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count
         FROM audit_logs
         ${whereSql}`,
        params
      ),
    ]);

    return {
      total: totalResult.rows[0]?.count || 0,
      limit: safeLimit,
      offset: safeOffset,
      logs: rowsResult.rows.map((row) => ({
        ...row,
        details_parsed: safeJsonParse(row.details),
      })),
    };
  }

  async getSummary() {
    await this.ensureSchema();

    const [totalsResult, topActionsResult] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)::int AS total_events,
           COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS last_24h,
           COUNT(*) FILTER (WHERE UPPER(COALESCE(status, 'SUCCESS')) <> 'SUCCESS')::int AS total_failures,
           COUNT(*) FILTER (
             WHERE created_at >= NOW() - INTERVAL '24 hours'
               AND UPPER(COALESCE(status, 'SUCCESS')) <> 'SUCCESS'
           )::int AS failures_24h,
           COUNT(DISTINCT user_id)::int AS distinct_actors
         FROM audit_logs`
      ),
      pool.query(
        `SELECT action_type, COUNT(*)::int AS count
         FROM audit_logs
         WHERE created_at >= NOW() - INTERVAL '7 days'
         GROUP BY action_type
         ORDER BY count DESC, action_type ASC
         LIMIT 8`
      ),
    ]);

    const row = totalsResult.rows[0] || {};
    return {
      totalEvents: Number(row.total_events || 0),
      last24h: Number(row.last_24h || 0),
      totalFailures: Number(row.total_failures || 0),
      failures24h: Number(row.failures_24h || 0),
      distinctActors: Number(row.distinct_actors || 0),
      topActions: topActionsResult.rows.map((item) => ({
        actionType: item.action_type,
        count: Number(item.count || 0),
      })),
    };
  }
}

export default new AuditService();
