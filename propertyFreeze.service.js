import pool from "../config/db.js";
import auditService from "./audit.service.js";

export const PROPERTY_FREEZE_REASONS = {
  OWNERSHIP_DISPUTE: "Ownership Dispute",
  COURT_ORDER: "Court Order",
  FRAUD_REVIEW: "Fraud Review",
  SUCCESSION_DISPUTE: "Succession Dispute",
  // Legacy value kept so old records still render correctly after authority ownership moved to DC.
  ADMIN_HOLD: "Administrative Hold",
};

let schemaReadyPromise = null;

function normalizeReasonCode(value = "") {
  const normalized = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return PROPERTY_FREEZE_REASONS[normalized] ? normalized : "OWNERSHIP_DISPUTE";
}

function toExecutor(client) {
  return client || pool;
}

class PropertyFreezeService {
  async ensureSchema(client = null) {
    if (!client && schemaReadyPromise) {
      return schemaReadyPromise;
    }

    const run = async () => {
      const db = toExecutor(client);

      await db.query(`
        ALTER TABLE properties
          ADD COLUMN IF NOT EXISTS is_for_sale BOOLEAN DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS asking_price NUMERIC(15,2),
          ADD COLUMN IF NOT EXISTS listed_at TIMESTAMP,
          ADD COLUMN IF NOT EXISTS is_frozen BOOLEAN NOT NULL DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS freeze_reason_code VARCHAR(40),
          ADD COLUMN IF NOT EXISTS freeze_reason_label VARCHAR(120),
          ADD COLUMN IF NOT EXISTS freeze_reference_no VARCHAR(120),
          ADD COLUMN IF NOT EXISTS freeze_notes TEXT,
          ADD COLUMN IF NOT EXISTS freeze_authority_role VARCHAR(20),
          ADD COLUMN IF NOT EXISTS freeze_authority_user_id VARCHAR(60),
          ADD COLUMN IF NOT EXISTS freeze_started_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS freeze_released_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS freeze_released_by VARCHAR(60),
          ADD COLUMN IF NOT EXISTS freeze_release_notes TEXT
      `);

      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_properties_frozen_status
        ON properties (is_frozen, status)
      `);

      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_properties_freeze_started_at
        ON properties (freeze_started_at DESC)
      `);
    };

    if (client) {
      await run();
      return;
    }

    schemaReadyPromise = run().catch((error) => {
      schemaReadyPromise = null;
      throw error;
    });

    return schemaReadyPromise;
  }

  buildFreezeDetails(row) {
    if (!row || !row.is_frozen) {
      return null;
    }

    const reasonCode = normalizeReasonCode(row.freeze_reason_code || "OWNERSHIP_DISPUTE");

    return {
      active: true,
      reasonCode,
      reasonLabel: row.freeze_reason_label || PROPERTY_FREEZE_REASONS[reasonCode],
      referenceNo: row.freeze_reference_no || null,
      notes: row.freeze_notes || null,
      authorityRole: row.freeze_authority_role || null,
      authorityUserId: row.freeze_authority_user_id || null,
      startedAt: row.freeze_started_at || null,
      releasedAt: row.freeze_released_at || null,
      releasedBy: row.freeze_released_by || null,
      releaseNotes: row.freeze_release_notes || null,
    };
  }

  async getPropertyFreezeState(propertyId, client = null) {
    await this.ensureSchema(client);

    const db = toExecutor(client);
    const result = await db.query(
      `
        SELECT
          property_id,
          status,
          owner_id,
          owner_name,
          COALESCE(is_frozen, FALSE) AS is_frozen,
          COALESCE(is_for_sale, FALSE) AS is_for_sale,
          freeze_reason_code,
          freeze_reason_label,
          freeze_reference_no,
          freeze_notes,
          freeze_authority_role,
          freeze_authority_user_id,
          freeze_started_at,
          freeze_released_at,
          freeze_released_by,
          freeze_release_notes
        FROM properties
        WHERE property_id = $1
        LIMIT 1
      `,
      [propertyId]
    );

    const row = result.rows[0] || null;
    return row
      ? {
          ...row,
          freeze_details: this.buildFreezeDetails(row),
        }
      : null;
  }

  async assertNotFrozen(propertyId, client = null, message = "Property is currently under dispute hold.") {
    const state = await this.getPropertyFreezeState(propertyId, client);

    if (!state) {
      const error = new Error("Property not found");
      error.code = "PROPERTY_NOT_FOUND";
      throw error;
    }

    if (state.is_frozen) {
      const error = new Error(message);
      error.code = "PROPERTY_FROZEN";
      error.freezeDetails = state.freeze_details;
      throw error;
    }

    return state;
  }

  async freezeProperty(
    {
      propertyId,
      actorUserId,
      actorRole,
      reasonCode,
      notes = "",
      referenceNo = "",
      ipAddress = null,
      routePath = null,
      httpMethod = null,
    },
    client = null
  ) {
    await this.ensureSchema(client);

    const db = toExecutor(client);
    const currentState = await this.getPropertyFreezeState(propertyId, client);

    if (!currentState) {
      throw new Error("Property not found");
    }

    if (String(currentState.status || "").toUpperCase() !== "APPROVED") {
      throw new Error("Only approved properties can be placed under dispute hold");
    }

    if (currentState.is_frozen) {
      return {
        changed: false,
        property: currentState,
      };
    }

    const normalizedReason = normalizeReasonCode(reasonCode);
    const reasonLabel = PROPERTY_FREEZE_REASONS[normalizedReason];

    const result = await db.query(
      `
        UPDATE properties
        SET is_frozen = TRUE,
            is_for_sale = FALSE,
            freeze_reason_code = $2,
            freeze_reason_label = $3,
            freeze_reference_no = NULLIF($4, ''),
            freeze_notes = NULLIF($5, ''),
            freeze_authority_role = $6,
            freeze_authority_user_id = $7,
            freeze_started_at = NOW(),
            freeze_released_at = NULL,
            freeze_released_by = NULL,
            freeze_release_notes = NULL,
            updated_at = NOW()
        WHERE property_id = $1
        RETURNING *
      `,
      [
        propertyId,
        normalizedReason,
        reasonLabel,
        referenceNo,
        notes,
        actorRole,
        actorUserId,
      ]
    );

    const property = {
      ...result.rows[0],
      freeze_details: this.buildFreezeDetails(result.rows[0]),
    };

    await auditService.writeLog({
      userId: actorUserId,
      actionType: "PROPERTY_FROZEN",
      targetId: propertyId,
      targetType: "PROPERTY",
      details: {
        reasonCode: normalizedReason,
        reasonLabel,
        notes: notes || null,
        referenceNo: referenceNo || null,
      },
      ipAddress,
      routePath,
      httpMethod,
      status: "SUCCESS",
    }).catch(() => {});

    return {
      changed: true,
      property,
    };
  }

  async releaseFreeze(
    {
      propertyId,
      actorUserId,
      actorRole,
      releaseNotes = "",
      ipAddress = null,
      routePath = null,
      httpMethod = null,
    },
    client = null
  ) {
    await this.ensureSchema(client);

    const db = toExecutor(client);
    const currentState = await this.getPropertyFreezeState(propertyId, client);

    if (!currentState) {
      throw new Error("Property not found");
    }

    if (!currentState.is_frozen) {
      return {
        changed: false,
        property: currentState,
      };
    }

    const result = await db.query(
      `
        UPDATE properties
        SET is_frozen = FALSE,
            freeze_released_at = NOW(),
            freeze_released_by = $2,
            freeze_authority_role = COALESCE(freeze_authority_role, $3),
            freeze_release_notes = NULLIF($4, ''),
            updated_at = NOW()
        WHERE property_id = $1
        RETURNING *
      `,
      [propertyId, actorUserId, actorRole, releaseNotes]
    );

    const property = {
      ...result.rows[0],
      freeze_details: this.buildFreezeDetails(result.rows[0]),
    };

    await auditService.writeLog({
      userId: actorUserId,
      actionType: "PROPERTY_FREEZE_RELEASED",
      targetId: propertyId,
      targetType: "PROPERTY",
      details: {
        releaseNotes: releaseNotes || null,
      },
      ipAddress,
      routePath,
      httpMethod,
      status: "SUCCESS",
    }).catch(() => {});

    return {
      changed: true,
      property,
    };
  }

  async listFreezeCases({ includeReleased = false, limit = 12 } = {}, client = null) {
    await this.ensureSchema(client);

    const db = toExecutor(client);
    const safeLimit = Math.min(Math.max(Number(limit) || 12, 1), 100);
    const result = await db.query(
      `
        SELECT
          p.property_id,
          p.owner_id,
          p.owner_name,
          p.owner_cnic,
          p.district,
          p.tehsil,
          p.mauza,
          p.khasra_no,
          p.khatooni_no,
          p.khewat_no,
          p.area_marla,
          p.property_type,
          p.status,
          COALESCE(p.is_frozen, FALSE) AS is_frozen,
          p.freeze_reason_code,
          p.freeze_reason_label,
          p.freeze_reference_no,
          p.freeze_notes,
          p.freeze_authority_role,
          p.freeze_authority_user_id,
          p.freeze_started_at,
          p.freeze_released_at,
          p.freeze_released_by,
          p.freeze_release_notes
        FROM properties p
        WHERE ($1::boolean = TRUE OR COALESCE(p.is_frozen, FALSE) = TRUE)
          AND (
            COALESCE(p.is_frozen, FALSE) = TRUE
            OR p.freeze_started_at IS NOT NULL
          )
        ORDER BY
          COALESCE(p.is_frozen, FALSE) DESC,
          COALESCE(p.freeze_started_at, p.updated_at, p.created_at) DESC
        LIMIT $2
      `,
      [includeReleased, safeLimit]
    );

    return result.rows.map((row) => ({
      ...row,
      freeze_details: this.buildFreezeDetails(row),
    }));
  }
}

export default new PropertyFreezeService();