import pool from "../config/db.js";

const CANONICAL_TABLE = "ownership_history";
const LEGACY_TABLE = "property_ownership_history";
const OFFICER_ROLES = new Set(["ADMIN", "DC", "LRO", "LAND RECORD OFFICER", "TEHSILDAR"]);

let ownershipHistorySchemaPromise = null;

function normalizeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeAmount(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDate(value) {
  if (!value) return new Date();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

async function getTableColumns(client, tableName) {
  const result = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
      ORDER BY ordinal_position`,
    [tableName]
  );

  return result.rows.map((row) => row.column_name);
}

async function hasTable(client, tableName) {
  const result = await client.query(
    `SELECT 1
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1
      LIMIT 1`,
    [tableName]
  );

  return result.rows.length > 0;
}

async function pushColumnIfPresent(columns, values, fieldNames, payload, columnName, transform = (value) => value) {
  if (!columns.includes(columnName)) return;
  const rawValue = payload[columnName];
  if (rawValue === undefined) return;
  fieldNames.push(columnName);
  values.push(transform(rawValue));
}

async function ensureBaseSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${CANONICAL_TABLE} (
      id BIGSERIAL PRIMARY KEY,
      property_id VARCHAR(120) NOT NULL,
      previous_owner_id VARCHAR(120),
      previous_owner_name VARCHAR(180),
      previous_owner_cnic VARCHAR(25),
      new_owner_id VARCHAR(120),
      new_owner_name VARCHAR(180),
      new_owner_cnic VARCHAR(25),
      new_owner_father_name VARCHAR(180),
      transfer_type VARCHAR(40) NOT NULL DEFAULT 'SALE',
      transfer_amount NUMERIC(14, 2),
      transfer_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      transfer_id VARCHAR(120),
      reference_id VARCHAR(160),
      reference_type VARCHAR(60),
      remarks TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await client.query(`
    ALTER TABLE ${CANONICAL_TABLE}
      ADD COLUMN IF NOT EXISTS previous_owner_name VARCHAR(180),
      ADD COLUMN IF NOT EXISTS previous_owner_cnic VARCHAR(25),
      ADD COLUMN IF NOT EXISTS new_owner_name VARCHAR(180),
      ADD COLUMN IF NOT EXISTS new_owner_cnic VARCHAR(25),
      ADD COLUMN IF NOT EXISTS new_owner_father_name VARCHAR(180),
      ADD COLUMN IF NOT EXISTS transfer_id VARCHAR(120),
      ADD COLUMN IF NOT EXISTS reference_id VARCHAR(160),
      ADD COLUMN IF NOT EXISTS reference_type VARCHAR(60),
      ADD COLUMN IF NOT EXISTS remarks TEXT,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()
  `);

  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_ownership_history_property_date
       ON ${CANONICAL_TABLE} (property_id, transfer_date DESC)`
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_ownership_history_reference
       ON ${CANONICAL_TABLE} (reference_type, reference_id)`
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_ownership_history_transfer_id
       ON ${CANONICAL_TABLE} (transfer_id)`
  );
}

async function resolveOwnershipReference(client, event) {
  if (event.reference_id && event.reference_type) {
    const result = await client.query(
      `SELECT id
         FROM ${CANONICAL_TABLE}
        WHERE property_id = $1
          AND transfer_type = $2
          AND reference_type = $3
          AND reference_id = $4
        LIMIT 1`,
      [event.property_id, event.transfer_type, event.reference_type, event.reference_id]
    );

    if (result.rows.length) return result.rows[0].id;
  }

  if (event.transfer_id) {
    const result = await client.query(
      `SELECT id
         FROM ${CANONICAL_TABLE}
        WHERE property_id = $1
          AND transfer_type = $2
          AND transfer_id = $3
        LIMIT 1`,
      [event.property_id, event.transfer_type, event.transfer_id]
    );

    if (result.rows.length) return result.rows[0].id;
  }

  if (event.transfer_type === "REGISTRATION") {
    const result = await client.query(
      `SELECT id
         FROM ${CANONICAL_TABLE}
        WHERE property_id = $1
          AND transfer_type = 'REGISTRATION'
        LIMIT 1`,
      [event.property_id]
    );

    if (result.rows.length) return result.rows[0].id;
  }

  return null;
}

async function insertOwnershipEvent(client, payload) {
  const columns = await getTableColumns(client, CANONICAL_TABLE);
  if (!columns.length) return null;

  const existingId = await resolveOwnershipReference(client, payload);
  if (existingId) return { id: existingId, inserted: false };

  const fieldNames = [];
  const values = [];

  await pushColumnIfPresent(columns, values, fieldNames, payload, "property_id", normalizeText);
  await pushColumnIfPresent(columns, values, fieldNames, payload, "previous_owner_id", normalizeText);
  await pushColumnIfPresent(columns, values, fieldNames, payload, "previous_owner_name", normalizeText);
  await pushColumnIfPresent(columns, values, fieldNames, payload, "previous_owner_cnic", normalizeText);
  await pushColumnIfPresent(columns, values, fieldNames, payload, "new_owner_id", normalizeText);
  await pushColumnIfPresent(columns, values, fieldNames, payload, "new_owner_name", normalizeText);
  await pushColumnIfPresent(columns, values, fieldNames, payload, "new_owner_cnic", normalizeText);
  await pushColumnIfPresent(columns, values, fieldNames, payload, "new_owner_father_name", normalizeText);
  await pushColumnIfPresent(columns, values, fieldNames, payload, "transfer_type", normalizeText);
  await pushColumnIfPresent(columns, values, fieldNames, payload, "transfer_amount", normalizeAmount);
  await pushColumnIfPresent(columns, values, fieldNames, payload, "transfer_date", normalizeDate);
  await pushColumnIfPresent(columns, values, fieldNames, payload, "transfer_id", normalizeText);
  await pushColumnIfPresent(columns, values, fieldNames, payload, "reference_id", normalizeText);
  await pushColumnIfPresent(columns, values, fieldNames, payload, "reference_type", normalizeText);
  await pushColumnIfPresent(columns, values, fieldNames, payload, "remarks", normalizeText);
  await pushColumnIfPresent(columns, values, fieldNames, payload, "created_at", normalizeDate);

  const placeholders = values.map((_, index) => `$${index + 1}`);
  const result = await client.query(
    `INSERT INTO ${CANONICAL_TABLE} (${fieldNames.join(", ")})
     VALUES (${placeholders.join(", ")})
     RETURNING id`,
    values
  );

  return { id: result.rows[0]?.id || null, inserted: true };
}

async function backfillLegacyTransfers(client) {
  if (!(await hasTable(client, LEGACY_TABLE))) return;

  const legacyColumns = await getTableColumns(client, LEGACY_TABLE);
  const idColumn = legacyColumns.includes("history_id") ? "history_id" : legacyColumns.includes("id") ? "id" : null;
  const transferIdColumn = legacyColumns.includes("transfer_id") ? "transfer_id" : null;
  const createdAtColumn = legacyColumns.includes("created_at") ? "created_at" : null;

  const result = await client.query(
    `SELECT
       l.*,
       prev.name AS previous_owner_name,
       prev.cnic AS previous_owner_cnic,
       new_user.name AS new_owner_name,
       new_user.cnic AS new_owner_cnic
     FROM ${LEGACY_TABLE} l
     LEFT JOIN users prev
       ON prev.user_id = l.previous_owner_id
     LEFT JOIN users new_user
       ON new_user.user_id = l.new_owner_id
     ORDER BY COALESCE(l.transfer_date, l.created_at) ASC`
  );

  for (const row of result.rows) {
    const fallbackReference = idColumn ? String(row[idColumn]) : `${row.property_id}:${row.previous_owner_id || "NA"}:${row.new_owner_id || "NA"}:${row.transfer_date || row.created_at || "NA"}`;
    await insertOwnershipEvent(client, {
      property_id: row.property_id,
      previous_owner_id: row.previous_owner_id,
      previous_owner_name: row.previous_owner_name,
      previous_owner_cnic: row.previous_owner_cnic,
      new_owner_id: row.new_owner_id,
      new_owner_name: row.new_owner_name,
      new_owner_cnic: row.new_owner_cnic,
      transfer_type: normalizeText(row.transfer_type) || "SALE",
      transfer_amount: row.transfer_amount,
      transfer_date: row.transfer_date || row.created_at,
      transfer_id: transferIdColumn ? row[transferIdColumn] : null,
      reference_type: "LEGACY_OWNERSHIP_HISTORY",
      reference_id: fallbackReference,
      remarks: row.remarks || "Migrated from legacy property ownership history",
      created_at: createdAtColumn ? row[createdAtColumn] : row.transfer_date,
    });
  }
}

async function backfillApprovedRegistrations(client) {
  const result = await client.query(
    `SELECT
       p.property_id,
       p.owner_id,
       p.owner_name,
       p.owner_cnic,
       p.father_name,
       p.created_at,
       p.updated_at
     FROM properties p
     LEFT JOIN ${CANONICAL_TABLE} oh
       ON oh.property_id = p.property_id
      AND oh.transfer_type = 'REGISTRATION'
     WHERE COALESCE(p.status, '') = 'APPROVED'
       AND oh.id IS NULL
     ORDER BY COALESCE(p.updated_at, p.created_at) ASC`
  );

  for (const property of result.rows) {
    await insertOwnershipEvent(client, {
      property_id: property.property_id,
      previous_owner_id: null,
      previous_owner_name: null,
      previous_owner_cnic: null,
      new_owner_id: property.owner_id,
      new_owner_name: property.owner_name,
      new_owner_cnic: property.owner_cnic,
      new_owner_father_name: property.father_name,
      transfer_type: "REGISTRATION",
      transfer_amount: null,
      transfer_date: property.updated_at || property.created_at,
      transfer_id: null,
      reference_type: "PROPERTY_REGISTRATION",
      reference_id: property.property_id,
      remarks: "Original owner captured at registration approval",
      created_at: property.updated_at || property.created_at,
    });
  }
}

async function backfillCompletedTransfers(client) {
  const result = await client.query(
    `SELECT
       tr.transfer_id,
       tr.property_id,
       tr.seller_id,
       tr.buyer_id,
       tr.buyer_name,
       tr.buyer_cnic,
       tr.buyer_father_name,
       tr.transfer_amount,
       tr.agreed_price,
       tr.total_amount,
       tr.completed_at,
       tr.approved_at,
       tr.updated_at,
       tr.created_at,
       seller.name AS seller_name,
       seller.cnic AS seller_cnic,
       buyer.name AS buyer_registered_name,
       buyer.cnic AS buyer_registered_cnic
     FROM transfer_requests tr
     LEFT JOIN users seller
       ON seller.user_id = tr.seller_id
     LEFT JOIN users buyer
       ON buyer.user_id = tr.buyer_id
     LEFT JOIN ${CANONICAL_TABLE} oh
       ON oh.property_id = tr.property_id
      AND oh.transfer_id = tr.transfer_id
      AND oh.transfer_type = 'SALE'
     WHERE COALESCE(tr.status, '') IN ('APPROVED', 'COMPLETED')
       AND oh.id IS NULL
     ORDER BY COALESCE(tr.completed_at, tr.approved_at, tr.updated_at, tr.created_at) ASC`
  );

  for (const transfer of result.rows) {
    await insertOwnershipEvent(client, {
      property_id: transfer.property_id,
      previous_owner_id: transfer.seller_id,
      previous_owner_name: transfer.seller_name,
      previous_owner_cnic: transfer.seller_cnic,
      new_owner_id: transfer.buyer_id,
      new_owner_name: transfer.buyer_registered_name || transfer.buyer_name,
      new_owner_cnic: transfer.buyer_registered_cnic || transfer.buyer_cnic,
      new_owner_father_name: transfer.buyer_father_name,
      transfer_type: "SALE",
      transfer_amount: transfer.transfer_amount || transfer.agreed_price || transfer.total_amount,
      transfer_date: transfer.completed_at || transfer.approved_at || transfer.updated_at || transfer.created_at,
      transfer_id: transfer.transfer_id,
      reference_type: "TRANSFER_REQUEST",
      reference_id: transfer.transfer_id,
      remarks: "Backfilled from completed transfer workflow",
      created_at: transfer.completed_at || transfer.approved_at || transfer.updated_at || transfer.created_at,
    });
  }
}

async function backfillCompletedSuccessionAllocations(client) {
  const result = await client.query(
    `SELECT
       sr.succession_request_id,
       sr.request_no,
       sr.owner_user_id,
       sr.property_id,
       sr.completed_at,
       sr.dc_approved_at,
       sr.updated_at,
       sr.created_at,
       p.owner_name,
       p.owner_cnic,
       p.father_name,
       h.heir_id,
       h.linked_user_id,
       h.full_name,
       h.cnic,
       h.share_percent,
       h.share_fraction_text
     FROM succession_requests sr
     JOIN properties p
       ON p.property_id = sr.property_id
     JOIN succession_heirs h
       ON h.succession_request_id = sr.succession_request_id
     LEFT JOIN ${CANONICAL_TABLE} oh
       ON oh.reference_type = 'SUCCESSION_HEIR'
      AND oh.reference_id = h.heir_id::text
      AND oh.property_id = sr.property_id
     WHERE COALESCE(sr.dc_status, '') = 'APPROVED'
       AND COALESCE(sr.status, '') IN ('COMPLETED', 'APPROVED')
       AND oh.id IS NULL
     ORDER BY COALESCE(sr.completed_at, sr.dc_approved_at, sr.updated_at, sr.created_at) ASC, h.created_at ASC`
  );

  for (const heir of result.rows) {
    const shareLabel = normalizeText(heir.share_fraction_text) || (heir.share_percent !== null && heir.share_percent !== undefined ? `${heir.share_percent}%` : null);
    await insertOwnershipEvent(client, {
      property_id: heir.property_id,
      previous_owner_id: heir.owner_user_id,
      previous_owner_name: heir.owner_name,
      previous_owner_cnic: heir.owner_cnic,
      new_owner_id: heir.linked_user_id,
      new_owner_name: heir.full_name,
      new_owner_cnic: heir.cnic,
      new_owner_father_name: heir.father_name,
      transfer_type: "SUCCESSION",
      transfer_amount: null,
      transfer_date: heir.completed_at || heir.dc_approved_at || heir.updated_at || heir.created_at,
      transfer_id: null,
      reference_type: "SUCCESSION_HEIR",
      reference_id: heir.heir_id,
      remarks: `Succession allocation recorded${shareLabel ? ` (${shareLabel})` : ""}${heir.request_no ? ` for request ${heir.request_no}` : ""}`,
      created_at: heir.completed_at || heir.dc_approved_at || heir.updated_at || heir.created_at,
    });
  }
}

async function ensureSchemaInternal(client) {
  await ensureBaseSchema(client);
  await backfillLegacyTransfers(client);
  await backfillApprovedRegistrations(client);
  await backfillCompletedTransfers(client);
  await backfillCompletedSuccessionAllocations(client);
}

async function ensureSchema(client = pool) {
  if (client === pool) {
    if (!ownershipHistorySchemaPromise) {
      ownershipHistorySchemaPromise = ensureSchemaInternal(pool);
    }
    return ownershipHistorySchemaPromise;
  }

  return ensureSchemaInternal(client);
}

async function recordOwnershipEvent(client, event) {
  await ensureSchema(client);

  return insertOwnershipEvent(client, {
    property_id: normalizeText(event.propertyId),
    previous_owner_id: normalizeText(event.previousOwnerId),
    previous_owner_name: normalizeText(event.previousOwnerName),
    previous_owner_cnic: normalizeText(event.previousOwnerCnic),
    new_owner_id: normalizeText(event.newOwnerId),
    new_owner_name: normalizeText(event.newOwnerName),
    new_owner_cnic: normalizeText(event.newOwnerCnic),
    new_owner_father_name: normalizeText(event.newOwnerFatherName),
    transfer_type: normalizeText(event.transferType) || "SALE",
    transfer_amount: event.transferAmount,
    transfer_date: event.transferDate,
    transfer_id: normalizeText(event.transferId),
    reference_id: normalizeText(event.referenceId),
    reference_type: normalizeText(event.referenceType),
    remarks: normalizeText(event.remarks),
    created_at: event.createdAt || event.transferDate,
  });
}

async function canUserViewPropertyHistory(client, user, propertyId) {
  const role = normalizeText(user?.role)?.toUpperCase() || "";
  if (OFFICER_ROLES.has(role)) return true;
  if (role !== "CITIZEN") return false;

  const userId = normalizeText(user?.userId);
  if (!userId) return false;

  const userResult = await client.query(
    "SELECT cnic FROM users WHERE user_id = $1 LIMIT 1",
    [userId]
  );
  const userCnic = userResult.rows[0]?.cnic || null;

  const propertyResult = await client.query(
    `SELECT owner_id, owner_cnic
       FROM properties
      WHERE property_id = $1
      LIMIT 1`,
    [propertyId]
  );

  if (!propertyResult.rows.length) return false;

  const property = propertyResult.rows[0];
  if (property.owner_id === userId) return true;
  if (userCnic && property.owner_cnic === userCnic) return true;

  const transferMatch = await client.query(
    `SELECT 1
       FROM transfer_requests
      WHERE property_id = $1
        AND (seller_id = $2 OR buyer_id = $2)
      LIMIT 1`,
    [propertyId, userId]
  );
  if (transferMatch.rows.length) return true;

  const successionMatch = await client.query(
    `SELECT 1
       FROM succession_requests sr
       JOIN succession_heirs h
         ON h.succession_request_id = sr.succession_request_id
      WHERE sr.property_id = $1
        AND COALESCE(sr.dc_status, '') = 'APPROVED'
        AND COALESCE(sr.status, '') IN ('COMPLETED', 'APPROVED')
        AND (
          h.linked_user_id::text = $2
          OR ($3 IS NOT NULL AND h.cnic = $3)
        )
      LIMIT 1`,
    [propertyId, userId, userCnic]
  );

  return successionMatch.rows.length > 0;
}

async function listPropertyOwnershipHistory(client, propertyId) {
  await ensureSchema(client);

  const result = await client.query(
    `SELECT
       oh.*,
       COALESCE(oh.previous_owner_name, prev.name) AS resolved_previous_owner_name,
       COALESCE(oh.previous_owner_cnic, prev.cnic) AS resolved_previous_owner_cnic,
       COALESCE(oh.new_owner_name, new_user.name) AS resolved_new_owner_name,
       COALESCE(oh.new_owner_cnic, new_user.cnic) AS resolved_new_owner_cnic
     FROM ${CANONICAL_TABLE} oh
     LEFT JOIN users prev
       ON prev.user_id = oh.previous_owner_id
     LEFT JOIN users new_user
       ON new_user.user_id = oh.new_owner_id
     WHERE oh.property_id = $1
     ORDER BY COALESCE(oh.transfer_date, oh.created_at) DESC, oh.id DESC`,
    [propertyId]
  );

  return result.rows;
}

export default {
  ensureSchema,
  recordOwnershipEvent,
  canUserViewPropertyHistory,
  listPropertyOwnershipHistory,
};
