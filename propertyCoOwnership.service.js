import pool from "../config/db.js";

function toExecutor(client) {
  return client || pool;
}

function buildFallbackName(row) {
  if (row.owner_name) return row.owner_name;
  if (row.owner_cnic) return `Heir ${row.owner_cnic}`;
  return "Unlinked Heir";
}

function buildSummaryLabel(activeCoOwners = []) {
  if (!activeCoOwners.length) return null;
  if (activeCoOwners.length === 1) {
    const primary = activeCoOwners[0];
    const suffix = primary.share_fraction_text || primary.share_percent ? ` (${primary.share_fraction_text || `${Number(primary.share_percent || 0).toFixed(2)}%`})` : "";
    return `${primary.owner_name || "1 co-owner"}${suffix}`;
  }

  return `${activeCoOwners.length} co-owners via approved succession`;
}

let schemaReadyPromise = null;

class PropertyCoOwnershipService {
  async ensureSchema(client = null) {
    if (!client && schemaReadyPromise) {
      return schemaReadyPromise;
    }

    const run = async () => {
      const db = toExecutor(client);

      await db.query(`
        ALTER TABLE properties
          ADD COLUMN IF NOT EXISTS has_co_owners BOOLEAN NOT NULL DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS ownership_model VARCHAR(20) NOT NULL DEFAULT 'SOLE',
          ADD COLUMN IF NOT EXISTS active_co_owner_count INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS co_owner_summary VARCHAR(180),
          ADD COLUMN IF NOT EXISTS last_co_ownership_sync_at TIMESTAMPTZ
      `);

      await db.query(`
        CREATE TABLE IF NOT EXISTS property_co_owners (
          allocation_id VARCHAR(120) PRIMARY KEY,
          property_id VARCHAR(120) NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
          source_type VARCHAR(40) NOT NULL DEFAULT 'SUCCESSION',
          source_reference_id VARCHAR(120),
          request_no VARCHAR(120),
          user_id VARCHAR(60),
          owner_name VARCHAR(160),
          owner_cnic VARCHAR(30),
          father_name VARCHAR(160),
          relation_type VARCHAR(80),
          share_percent NUMERIC(8,2),
          share_fraction_text VARCHAR(80),
          is_primary_owner BOOLEAN NOT NULL DEFAULT FALSE,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          granted_at TIMESTAMPTZ,
          synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_property_co_owners_property
        ON property_co_owners (property_id, is_active, granted_at DESC)
      `);

      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_properties_joint_ownership
        ON properties (has_co_owners, ownership_model, status)
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

  buildCoOwnerRecord(row) {
    if (!row) return null;

    const sharePercent = Number(row.share_percent);
    return {
      allocation_id: row.allocation_id,
      source_type: row.source_type || "SUCCESSION",
      source_reference_id: row.source_reference_id || null,
      request_no: row.request_no || null,
      user_id: row.user_id || null,
      owner_name: buildFallbackName(row),
      owner_cnic: row.owner_cnic || null,
      father_name: row.father_name || null,
      relation_type: row.relation_type || null,
      share_percent: Number.isFinite(sharePercent) ? Number(sharePercent.toFixed(2)) : null,
      share_fraction_text: row.share_fraction_text || null,
      is_primary_owner: Boolean(row.is_primary_owner),
      is_active: row.is_active !== false,
      granted_at: row.granted_at || null,
      synced_at: row.synced_at || null,
    };
  }

  buildCoOwnershipSummary(activeCoOwners = [], row = null) {
    const activeCount = activeCoOwners.length || Number(row?.active_co_owner_count || 0);
    const totalAllocatedPercent = activeCoOwners.reduce((sum, item) => {
      const numeric = Number(item.share_percent);
      return sum + (Number.isFinite(numeric) ? numeric : 0);
    }, 0);

    if (!activeCount && !row?.has_co_owners && !row?.co_owner_summary) {
      return {
        active: false,
        count: 0,
        ownershipModel: "SOLE",
        summaryLabel: null,
        syncedAt: row?.last_co_ownership_sync_at || null,
        totalAllocatedPercent: 0,
        items: [],
      };
    }

    return {
      active: activeCount > 0,
      count: activeCount,
      ownershipModel: row?.ownership_model || (activeCount > 0 ? "JOINT" : "SOLE"),
      summaryLabel: row?.co_owner_summary || buildSummaryLabel(activeCoOwners),
      syncedAt: row?.last_co_ownership_sync_at || null,
      totalAllocatedPercent: Number(totalAllocatedPercent.toFixed(2)),
      items: activeCoOwners,
    };
  }

  buildCoOwnershipSummaryFromRow(row) {
    return this.buildCoOwnershipSummary([], row);
  }

  async listActiveCoOwners(propertyId, client = null) {
    await this.ensureSchema(client);

    const db = toExecutor(client);
    const result = await db.query(
      `
        SELECT
          allocation_id,
          source_type,
          source_reference_id,
          request_no,
          user_id,
          owner_name,
          owner_cnic,
          father_name,
          relation_type,
          share_percent,
          share_fraction_text,
          is_primary_owner,
          is_active,
          granted_at,
          synced_at
        FROM property_co_owners
        WHERE property_id = $1
          AND is_active = TRUE
        ORDER BY granted_at ASC NULLS LAST, created_at ASC
      `,
      [propertyId]
    );

    return result.rows.map((row) => this.buildCoOwnerRecord(row));
  }

  async syncPropertyCoOwnersFromSuccession(propertyId, client = null) {
    await this.ensureSchema(client);

    const db = toExecutor(client);
    const propertyResult = await db.query(
      `
        SELECT
          property_id,
          owner_id,
          owner_name,
          owner_cnic,
          status
        FROM properties
        WHERE property_id = $1
        LIMIT 1
      `,
      [propertyId]
    );

    const property = propertyResult.rows[0] || null;
    if (!property) return null;

    const result = await db.query(
      `
        WITH property_base AS (
          SELECT property_id, owner_id, owner_cnic
          FROM properties
          WHERE property_id = $1
          LIMIT 1
        ),
        latest_request AS (
          SELECT
            succession_request_id,
            request_no,
            COALESCE(completed_at, dc_approved_at, updated_at, created_at) AS granted_at
          FROM succession_requests
          WHERE property_id = $1
            AND COALESCE(dc_status, '') = 'APPROVED'
            AND COALESCE(status, '') IN ('COMPLETED', 'APPROVED')
          ORDER BY COALESCE(completed_at, dc_approved_at, updated_at, created_at) DESC
          LIMIT 1
        )
        SELECT
          h.heir_id AS allocation_id,
          'SUCCESSION' AS source_type,
          lr.succession_request_id AS source_reference_id,
          lr.request_no,
          COALESCE(u.user_id, h.linked_user_id) AS user_id,
          COALESCE(u.name, NULLIF(TRIM(COALESCE(u.name, '')), ''), NULL) AS owner_name,
          COALESCE(u.cnic, h.cnic) AS owner_cnic,
          u.father_name,
          h.relation_type,
          h.share_percent,
          h.share_fraction_text,
          FALSE AS is_primary_owner,
          TRUE AS is_active,
          COALESCE(lr.granted_at, h.created_at) AS granted_at,
          NOW() AS synced_at
        FROM latest_request lr
        JOIN succession_heirs h
          ON h.succession_request_id = lr.succession_request_id
        JOIN property_base pb
          ON TRUE
        LEFT JOIN users u
          ON u.user_id = h.linked_user_id
          OR (h.linked_user_id IS NULL AND h.cnic IS NOT NULL AND u.cnic = h.cnic)
        WHERE NOT (
          (h.linked_user_id IS NOT NULL AND h.linked_user_id = pb.owner_id)
          OR (
            pb.owner_cnic IS NOT NULL
            AND h.cnic IS NOT NULL
            AND h.cnic = pb.owner_cnic
          )
        )
        ORDER BY h.created_at ASC
      `,
      [propertyId]
    );

    await db.query(`DELETE FROM property_co_owners WHERE property_id = $1`, [propertyId]);

    for (const row of result.rows) {
      await db.query(
        `
          INSERT INTO property_co_owners (
            allocation_id,
            property_id,
            source_type,
            source_reference_id,
            request_no,
            user_id,
            owner_name,
            owner_cnic,
            father_name,
            relation_type,
            share_percent,
            share_fraction_text,
            is_primary_owner,
            is_active,
            granted_at,
            synced_at,
            created_at,
            updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, NOW(), NOW()
          )
        `,
        [
          row.allocation_id,
          propertyId,
          row.source_type,
          row.source_reference_id,
          row.request_no,
          row.user_id,
          buildFallbackName(row),
          row.owner_cnic,
          row.father_name,
          row.relation_type,
          row.share_percent,
          row.share_fraction_text,
          false,
          true,
          row.granted_at,
          row.synced_at,
        ]
      );
    }

    const activeCoOwners = result.rows.map((row) => this.buildCoOwnerRecord(row));
    const activeCount = activeCoOwners.length;
    const summaryLabel = buildSummaryLabel(activeCoOwners);

    await db.query(
      `
        UPDATE properties
        SET has_co_owners = $2::BOOLEAN,
            ownership_model = $3::VARCHAR(20),
            active_co_owner_count = $4::INTEGER,
            co_owner_summary = $5::VARCHAR(180),
            last_co_ownership_sync_at = NOW(),
            updated_at = CASE
              WHEN COALESCE(has_co_owners, FALSE) IS DISTINCT FROM $2::BOOLEAN
                OR COALESCE(ownership_model, 'SOLE'::VARCHAR(20)) IS DISTINCT FROM $3::VARCHAR(20)
                OR COALESCE(active_co_owner_count, 0) IS DISTINCT FROM $4::INTEGER
                OR COALESCE(co_owner_summary, ''::VARCHAR(180)) IS DISTINCT FROM COALESCE($5::VARCHAR(180), ''::VARCHAR(180))
              THEN NOW()
              ELSE updated_at
            END
        WHERE property_id = $1
      `,
      [
        propertyId,
        activeCount > 0,
        activeCount > 0 ? "JOINT" : "SOLE",
        activeCount,
        summaryLabel,
      ]
    );

    return {
      ...property,
      has_co_owners: activeCount > 0,
      ownership_model: activeCount > 0 ? "JOINT" : "SOLE",
      active_co_owner_count: activeCount,
      co_owner_summary: summaryLabel,
      last_co_ownership_sync_at: new Date().toISOString(),
      co_owners: activeCoOwners,
      co_ownership_details: this.buildCoOwnershipSummary(activeCoOwners, {
        has_co_owners: activeCount > 0,
        ownership_model: activeCount > 0 ? "JOINT" : "SOLE",
        active_co_owner_count: activeCount,
        co_owner_summary: summaryLabel,
        last_co_ownership_sync_at: new Date().toISOString(),
      }),
    };
  }

  async getPropertyCoOwnershipState(propertyId, client = null, options = {}) {
    await this.ensureSchema(client);

    const syncBeforeRead = options.syncBeforeRead !== false;
    if (syncBeforeRead) {
      await this.syncPropertyCoOwnersFromSuccession(propertyId, client);
    }

    const db = toExecutor(client);
    const propertyResult = await db.query(
      `
        SELECT
          property_id,
          owner_id,
          owner_name,
          owner_cnic,
          status,
          COALESCE(has_co_owners, FALSE) AS has_co_owners,
          COALESCE(ownership_model, 'SOLE') AS ownership_model,
          COALESCE(active_co_owner_count, 0) AS active_co_owner_count,
          co_owner_summary,
          last_co_ownership_sync_at
        FROM properties
        WHERE property_id = $1
        LIMIT 1
      `,
      [propertyId]
    );

    const row = propertyResult.rows[0] || null;
    if (!row) return null;

    const activeCoOwners = await this.listActiveCoOwners(propertyId, client);
    return {
      ...row,
      co_owners: activeCoOwners,
      co_ownership_details: this.buildCoOwnershipSummary(activeCoOwners, row),
    };
  }

  async assertSoleOwnership(
    propertyId,
    client = null,
    message = "Property has registered co-owners. Joint-owner consent workflow is required before sale or transfer."
  ) {
    const state = await this.getPropertyCoOwnershipState(propertyId, client);

    if (!state) {
      const error = new Error("Property not found");
      error.code = "PROPERTY_NOT_FOUND";
      throw error;
    }

    if (state.has_co_owners) {
      const error = new Error(message);
      error.code = "PROPERTY_HAS_CO_OWNERS";
      error.coOwnershipDetails = state.co_ownership_details;
      throw error;
    }

    return state;
  }

  async listCoOwnershipCases({ limit = 12 } = {}, client = null) {
    await this.ensureSchema(client);

    const db = toExecutor(client);
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
          p.status,
          p.ownership_model,
          COALESCE(p.has_co_owners, FALSE) AS has_co_owners,
          COALESCE(p.active_co_owner_count, 0) AS active_co_owner_count,
          p.co_owner_summary,
          p.last_co_ownership_sync_at
        FROM properties p
        WHERE COALESCE(p.has_co_owners, FALSE) = TRUE
        ORDER BY p.last_co_ownership_sync_at DESC NULLS LAST, p.updated_at DESC
        LIMIT $1
      `,
      [Math.min(Math.max(Number(limit) || 12, 1), 100)]
    );

    const cases = [];
    for (const row of result.rows) {
      const state = await this.getPropertyCoOwnershipState(row.property_id, client, {
        syncBeforeRead: false,
      });
      cases.push({
        ...row,
        allocated_share_percent:
          state?.co_ownership_details?.totalAllocatedPercent ||
          this.buildCoOwnershipSummaryFromRow(row).totalAllocatedPercent ||
          0,
        co_ownership_details: state?.co_ownership_details || this.buildCoOwnershipSummaryFromRow(row),
        co_owners: state?.co_owners || [],
      });
    }

    return cases;
  }
}

export default new PropertyCoOwnershipService();
