import crypto from "crypto";

import pool from "../config/db.js";
import auditService from "./audit.service.js";

export const PROPERTY_ENCUMBRANCE_TYPES = {
  MORTGAGE: "Mortgage",
  BANK_LIEN: "Bank Lien",
  COURT_ATTACHMENT: "Court Attachment",
  TAX_HOLD: "Tax Hold",
  // Legacy value kept so older rows can still display after restriction control moved to DC.
  ADMIN_ENCUMBRANCE: "Administrative Encumbrance",
};

let schemaReadyPromise = null;

function toExecutor(client) {
  return client || pool;
}

function normalizeTypeCode(value = "") {
  const normalized = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return PROPERTY_ENCUMBRANCE_TYPES[normalized] ? normalized : "MORTGAGE";
}

function buildEncumbranceId() {
  return `ENC-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function normalizeAmount(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(2)) : null;
}

function buildSummaryLabel(activeEncumbrances = []) {
  if (!activeEncumbrances.length) return null;

  if (activeEncumbrances.length === 1) {
    const primary = activeEncumbrances[0];
    return primary.holderName
      ? `${primary.typeLabel} - ${primary.holderName}`
      : primary.typeLabel;
  }

  return `${activeEncumbrances.length} active encumbrances`;
}

class PropertyEncumbranceService {
  async ensureSchema(client = null) {
    if (!client && schemaReadyPromise) {
      return schemaReadyPromise;
    }

    const run = async () => {
      const db = toExecutor(client);

      await db.query(`
        ALTER TABLE properties
          ADD COLUMN IF NOT EXISTS is_for_sale BOOLEAN DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS is_encumbered BOOLEAN NOT NULL DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS encumbrance_summary VARCHAR(180),
          ADD COLUMN IF NOT EXISTS active_encumbrance_count INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS last_encumbrance_recorded_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS last_encumbrance_released_at TIMESTAMPTZ
      `);

      await db.query(`
        CREATE TABLE IF NOT EXISTS property_encumbrances (
          encumbrance_id VARCHAR(80) PRIMARY KEY,
          property_id VARCHAR(120) NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
          type_code VARCHAR(40) NOT NULL,
          type_label VARCHAR(120) NOT NULL,
          holder_name VARCHAR(160),
          reference_no VARCHAR(120),
          notes TEXT,
          amount_secured NUMERIC(15,2),
          authority_role VARCHAR(20),
          authority_user_id VARCHAR(60),
          recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          released_at TIMESTAMPTZ,
          released_by VARCHAR(60),
          release_notes TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_property_encumbrances_active
        ON property_encumbrances (property_id, released_at, recorded_at DESC)
      `);

      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_properties_encumbered_status
        ON properties (is_encumbered, status)
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

  buildEncumbranceRecord(row) {
    if (!row) return null;

    const typeCode = normalizeTypeCode(row.type_code || "MORTGAGE");
    return {
      encumbranceId: row.encumbrance_id,
      typeCode,
      typeLabel: row.type_label || PROPERTY_ENCUMBRANCE_TYPES[typeCode],
      holderName: row.holder_name || null,
      referenceNo: row.reference_no || null,
      notes: row.notes || null,
      amountSecured: normalizeAmount(row.amount_secured),
      authorityRole: row.authority_role || null,
      authorityUserId: row.authority_user_id || null,
      recordedAt: row.recorded_at || null,
      releasedAt: row.released_at || null,
      releasedBy: row.released_by || null,
      releaseNotes: row.release_notes || null,
      active: !row.released_at,
    };
  }

  buildEncumbranceSummary(activeEncumbrances = [], row = null) {
    if (!activeEncumbrances.length && !row?.is_encumbered && !row?.encumbrance_summary) {
      return null;
    }

    const activeCount = activeEncumbrances.length || Number(row?.active_encumbrance_count || 0);
    const primary = activeEncumbrances[0] || null;

    return {
      active: activeCount > 0,
      count: activeCount,
      summaryLabel: row?.encumbrance_summary || buildSummaryLabel(activeEncumbrances),
      recordedAt: row?.last_encumbrance_recorded_at || primary?.recordedAt || null,
      releasedAt: row?.last_encumbrance_released_at || null,
      primaryTypeCode: primary?.typeCode || null,
      primaryTypeLabel: primary?.typeLabel || null,
      holderName: primary?.holderName || null,
      items: activeEncumbrances,
    };
  }

  buildEncumbranceSummaryFromRow(row) {
    return this.buildEncumbranceSummary([], row);
  }

  async listActiveEncumbrances(propertyId, client = null) {
    await this.ensureSchema(client);

    const db = toExecutor(client);
    const result = await db.query(
      `
        SELECT
          encumbrance_id,
          type_code,
          type_label,
          holder_name,
          reference_no,
          notes,
          amount_secured,
          authority_role,
          authority_user_id,
          recorded_at,
          released_at,
          released_by,
          release_notes
        FROM property_encumbrances
        WHERE property_id = $1
          AND released_at IS NULL
        ORDER BY recorded_at DESC, created_at DESC
      `,
      [propertyId]
    );

    return result.rows.map((row) => this.buildEncumbranceRecord(row));
  }

  async refreshPropertySummary(propertyId, client = null) {
    await this.ensureSchema(client);

    const db = toExecutor(client);
    const activeEncumbrances = await this.listActiveEncumbrances(propertyId, client);
    const activeCount = activeEncumbrances.length;
    const summaryLabel = buildSummaryLabel(activeEncumbrances);
    const lastRecordedAt = activeEncumbrances[0]?.recordedAt || null;

    await db.query(
      `
        UPDATE properties
        SET is_encumbered = $2,
            encumbrance_summary = $3,
            active_encumbrance_count = $4,
            last_encumbrance_recorded_at = CASE
              WHEN $2 THEN COALESCE($5::timestamptz, last_encumbrance_recorded_at)
              ELSE last_encumbrance_recorded_at
            END,
            last_encumbrance_released_at = CASE
              WHEN NOT $2 THEN NOW()
              ELSE last_encumbrance_released_at
            END,
            is_for_sale = CASE
              WHEN $2 THEN FALSE
              ELSE COALESCE(is_for_sale, FALSE)
            END,
            updated_at = NOW()
        WHERE property_id = $1
      `,
      [
        propertyId,
        activeCount > 0,
        summaryLabel,
        activeCount,
        lastRecordedAt,
      ]
    );

    return this.buildEncumbranceSummary(activeEncumbrances, {
      is_encumbered: activeCount > 0,
      encumbrance_summary: summaryLabel,
      active_encumbrance_count: activeCount,
      last_encumbrance_recorded_at: lastRecordedAt,
    });
  }

  async getPropertyEncumbranceState(propertyId, client = null) {
    await this.ensureSchema(client);

    const db = toExecutor(client);
    const propertyResult = await db.query(
      `
        SELECT
          property_id,
          status,
          owner_id,
          owner_name,
          COALESCE(is_encumbered, FALSE) AS is_encumbered,
          COALESCE(active_encumbrance_count, 0) AS active_encumbrance_count,
          encumbrance_summary,
          last_encumbrance_recorded_at,
          last_encumbrance_released_at
        FROM properties
        WHERE property_id = $1
        LIMIT 1
      `,
      [propertyId]
    );

    const row = propertyResult.rows[0] || null;
    if (!row) return null;

    const activeEncumbrances = await this.listActiveEncumbrances(propertyId, client);
    return {
      ...row,
      active_encumbrances: activeEncumbrances,
      encumbrance_details: this.buildEncumbranceSummary(activeEncumbrances, row),
    };
  }

  async assertNoActiveEncumbrance(
    propertyId,
    client = null,
    message = "Property has an active encumbrance and cannot proceed."
  ) {
    const state = await this.getPropertyEncumbranceState(propertyId, client);

    if (!state) {
      const error = new Error("Property not found");
      error.code = "PROPERTY_NOT_FOUND";
      throw error;
    }

    if (state.is_encumbered) {
      const error = new Error(message);
      error.code = "PROPERTY_ENCUMBERED";
      error.encumbranceDetails = state.encumbrance_details;
      throw error;
    }

    return state;
  }

  async createEncumbrance(
    {
      propertyId,
      actorUserId,
      actorRole,
      typeCode,
      holderName = "",
      referenceNo = "",
      notes = "",
      amountSecured = null,
      ipAddress = null,
      routePath = null,
      httpMethod = null,
    },
    client = null
  ) {
    await this.ensureSchema(client);

    const db = toExecutor(client);
    const propertyResult = await db.query(
      `
        SELECT property_id, status
        FROM properties
        WHERE property_id = $1
        LIMIT 1
      `,
      [propertyId]
    );

    const property = propertyResult.rows[0] || null;
    if (!property) {
      throw new Error("Property not found");
    }

    if (String(property.status || "").toUpperCase() !== "APPROVED") {
      throw new Error("Only approved properties can receive an encumbrance record");
    }

    const normalizedType = normalizeTypeCode(typeCode);
    const typeLabel = PROPERTY_ENCUMBRANCE_TYPES[normalizedType];
    const encumbranceId = buildEncumbranceId();

    const inserted = await db.query(
      `
        INSERT INTO property_encumbrances
          (encumbrance_id, property_id, type_code, type_label, holder_name, reference_no, notes, amount_secured, authority_role, authority_user_id, recorded_at, created_at, updated_at)
        VALUES
          ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), $8, $9, $10, NOW(), NOW(), NOW())
        RETURNING *
      `,
      [
        encumbranceId,
        propertyId,
        normalizedType,
        typeLabel,
        holderName,
        referenceNo,
        notes,
        normalizeAmount(amountSecured),
        actorRole,
        actorUserId,
      ]
    );

    const propertySummary = await this.refreshPropertySummary(propertyId, client);

    await auditService.writeLog({
      userId: actorUserId,
      actionType: "PROPERTY_ENCUMBRANCE_RECORDED",
      targetId: propertyId,
      targetType: "PROPERTY",
      details: {
        encumbranceId,
        typeCode: normalizedType,
        typeLabel,
        holderName: holderName || null,
        referenceNo: referenceNo || null,
        amountSecured: normalizeAmount(amountSecured),
      },
      ipAddress,
      routePath,
      httpMethod,
      status: "SUCCESS",
    }).catch(() => {});

    return {
      changed: true,
      encumbrance: this.buildEncumbranceRecord(inserted.rows[0]),
      property: propertySummary,
    };
  }

  async releaseEncumbrance(
    {
      encumbranceId,
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
    const encumbranceResult = await db.query(
      `
        SELECT *
        FROM property_encumbrances
        WHERE encumbrance_id = $1
        LIMIT 1
      `,
      [encumbranceId]
    );

    const current = encumbranceResult.rows[0] || null;
    if (!current) {
      throw new Error("Encumbrance record not found");
    }

    if (current.released_at) {
      return {
        changed: false,
        encumbrance: this.buildEncumbranceRecord(current),
        property: await this.getPropertyEncumbranceState(current.property_id, client),
      };
    }

    const updated = await db.query(
      `
        UPDATE property_encumbrances
        SET released_at = NOW(),
            released_by = $2,
            release_notes = NULLIF($3, ''),
            authority_role = COALESCE(authority_role, $4),
            updated_at = NOW()
        WHERE encumbrance_id = $1
        RETURNING *
      `,
      [encumbranceId, actorUserId, releaseNotes, actorRole]
    );

    const propertySummary = await this.refreshPropertySummary(current.property_id, client);

    await auditService.writeLog({
      userId: actorUserId,
      actionType: "PROPERTY_ENCUMBRANCE_RELEASED",
      targetId: current.property_id,
      targetType: "PROPERTY",
      details: {
        encumbranceId,
        releaseNotes: releaseNotes || null,
      },
      ipAddress,
      routePath,
      httpMethod,
      status: "SUCCESS",
    }).catch(() => {});

    return {
      changed: true,
      encumbrance: this.buildEncumbranceRecord(updated.rows[0]),
      property: propertySummary,
    };
  }

  async listEncumbrances({ includeReleased = false, limit = 12 } = {}, client = null) {
    await this.ensureSchema(client);

    const db = toExecutor(client);
    const safeLimit = Math.min(Math.max(Number(limit) || 12, 1), 100);
    const result = await db.query(
      `
        SELECT
          pe.encumbrance_id,
          pe.property_id,
          pe.type_code,
          pe.type_label,
          pe.holder_name,
          pe.reference_no,
          pe.notes,
          pe.amount_secured,
          pe.authority_role,
          pe.authority_user_id,
          pe.recorded_at,
          pe.released_at,
          pe.released_by,
          pe.release_notes,
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
          COALESCE(p.is_encumbered, FALSE) AS is_encumbered,
          COALESCE(p.active_encumbrance_count, 0) AS active_encumbrance_count,
          p.encumbrance_summary
        FROM property_encumbrances pe
        JOIN properties p ON p.property_id = pe.property_id
        WHERE ($1::boolean = TRUE OR pe.released_at IS NULL)
        ORDER BY
          CASE WHEN pe.released_at IS NULL THEN 0 ELSE 1 END,
          COALESCE(pe.recorded_at, pe.created_at) DESC
        LIMIT $2
      `,
      [includeReleased, safeLimit]
    );

    return result.rows.map((row) => {
      const encumbrance = this.buildEncumbranceRecord(row);
      return {
        ...row,
        active: encumbrance.active,
        encumbrance: encumbrance,
        encumbrance_details: this.buildEncumbranceSummary(
          encumbrance.active ? [encumbrance] : [],
          row
        ),
      };
    });
  }
}

export default new PropertyEncumbranceService();
