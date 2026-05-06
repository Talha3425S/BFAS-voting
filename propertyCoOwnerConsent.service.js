import crypto from "crypto";

import pool from "../config/db.js";
import auditService from "./audit.service.js";
import propertyCoOwnershipService from "./propertyCoOwnership.service.js";

export const CO_OWNER_CONSENT_OPERATION_TYPES = {
  SALE_OR_TRANSFER: "Sale Or Transfer",
};

function toExecutor(client) {
  return client || pool;
}

function normalizeOperationType(value = "") {
  const normalized = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return CO_OWNER_CONSENT_OPERATION_TYPES[normalized] ? normalized : "SALE_OR_TRANSFER";
}

function buildConsentId() {
  return `COC-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function buildVoteId() {
  return `COV-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function normalizeMoney(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(2)) : null;
}

function normalizeVote(value = "") {
  const normalized = String(value || "").trim().toUpperCase();
  return normalized === "REJECT" ? "REJECT" : "APPROVE";
}

function buildSummaryLabel(status, approvals, requiredApprovals) {
  if (status === "NOT_REQUIRED") return "Sole ownership - co-owner consent not required";
  if (status === "NOT_STARTED") return "Co-owner consent has not been requested yet";
  if (status === "APPROVED") return `All ${requiredApprovals} co-owner approvals received`;
  if (status === "REJECTED") return "A co-owner rejected the request";
  return `${approvals}/${requiredApprovals} co-owner approvals received`;
}

let schemaReadyPromise = null;

class PropertyCoOwnerConsentService {
  async ensureSchema(client = null) {
    if (!client && schemaReadyPromise) {
      return schemaReadyPromise;
    }

    const run = async () => {
      const db = toExecutor(client);

      await db.query(`
        CREATE TABLE IF NOT EXISTS property_co_owner_consents (
          consent_id VARCHAR(120) PRIMARY KEY,
          property_id VARCHAR(120) NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
          operation_type VARCHAR(40) NOT NULL,
          operation_label VARCHAR(120) NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
          initiated_by_user_id VARCHAR(60) NOT NULL,
          initiated_by_name VARCHAR(160),
          notes TEXT,
          requested_price NUMERIC(15,2),
          initiated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          resolved_at TIMESTAMPTZ,
          resolved_by VARCHAR(60),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await db.query(`
        CREATE TABLE IF NOT EXISTS property_co_owner_consent_votes (
          vote_id VARCHAR(120) PRIMARY KEY,
          consent_id VARCHAR(120) NOT NULL REFERENCES property_co_owner_consents(consent_id) ON DELETE CASCADE,
          property_id VARCHAR(120) NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
          participant_user_id VARCHAR(60) NOT NULL,
          participant_name VARCHAR(160),
          participant_role VARCHAR(20) NOT NULL,
          allocation_id VARCHAR(120),
          vote VARCHAR(20),
          response_notes TEXT,
          responded_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (consent_id, participant_user_id)
        )
      `);

      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_property_co_owner_consents_property
        ON property_co_owner_consents (property_id, operation_type, initiated_at DESC)
      `);

      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_property_co_owner_consents_status
        ON property_co_owner_consents (status, initiated_at DESC)
      `);

      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_property_co_owner_consent_votes_user
        ON property_co_owner_consent_votes (participant_user_id, consent_id, responded_at)
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

  buildConsentSummary(consentRow, voteRows = [], viewerUserId = null, coOwnershipState = null) {
    const required = Boolean(coOwnershipState?.has_co_owners);

    if (!consentRow) {
      const status = required ? "NOT_STARTED" : "NOT_REQUIRED";
      return {
        required,
        active: false,
        canProceed: !required,
        consentId: null,
        operationType: "SALE_OR_TRANSFER",
        operationLabel: CO_OWNER_CONSENT_OPERATION_TYPES.SALE_OR_TRANSFER,
        status,
        summaryLabel: buildSummaryLabel(status, 0, 0),
        initiatedByUserId: null,
        initiatedByName: null,
        initiatedAt: null,
        resolvedAt: null,
        requestedPrice: null,
        notes: null,
        approvals: 0,
        rejections: 0,
        requiredApprovals: required ? Number(coOwnershipState?.active_co_owner_count || 0) + 1 : 0,
        pendingCount: required ? Number(coOwnershipState?.active_co_owner_count || 0) + 1 : 0,
        viewerVote: null,
        actionableForViewer: false,
        participants: [],
      };
    }

    const approvals = voteRows.filter((row) => String(row.vote || "").toUpperCase() === "APPROVE").length;
    const rejections = voteRows.filter((row) => String(row.vote || "").toUpperCase() === "REJECT").length;
    const requiredApprovals = voteRows.length;
    const pendingCount = voteRows.filter((row) => !row.vote).length;
    const viewerVoteRow = viewerUserId
      ? voteRows.find((row) => row.participant_user_id === viewerUserId) || null
      : null;
    const status = String(consentRow.status || "PENDING").toUpperCase();

    return {
      required,
      active: ["PENDING", "APPROVED"].includes(status),
      canProceed: !required || status === "APPROVED",
      consentId: consentRow.consent_id,
      operationType: consentRow.operation_type,
      operationLabel: consentRow.operation_label,
      status,
      summaryLabel: buildSummaryLabel(status, approvals, requiredApprovals),
      initiatedByUserId: consentRow.initiated_by_user_id,
      initiatedByName: consentRow.initiated_by_name || null,
      initiatedAt: consentRow.initiated_at || null,
      resolvedAt: consentRow.resolved_at || null,
      requestedPrice: normalizeMoney(consentRow.requested_price),
      notes: consentRow.notes || null,
      approvals,
      rejections,
      requiredApprovals,
      pendingCount,
      viewerVote: viewerVoteRow
        ? {
            participantUserId: viewerVoteRow.participant_user_id,
            participantName: viewerVoteRow.participant_name,
            participantRole: viewerVoteRow.participant_role,
            vote: viewerVoteRow.vote || null,
            respondedAt: viewerVoteRow.responded_at || null,
            responseNotes: viewerVoteRow.response_notes || null,
          }
        : null,
      actionableForViewer: Boolean(viewerVoteRow && !viewerVoteRow.vote && status === "PENDING"),
      participants: voteRows.map((row) => ({
        voteId: row.vote_id,
        participantUserId: row.participant_user_id,
        participantName: row.participant_name,
        participantRole: row.participant_role,
        allocationId: row.allocation_id || null,
        vote: row.vote || null,
        respondedAt: row.responded_at || null,
        responseNotes: row.response_notes || null,
      })),
    };
  }

  async listVotes(consentId, client = null) {
    const db = toExecutor(client);
    const result = await db.query(
      `
        SELECT
          vote_id,
          consent_id,
          property_id,
          participant_user_id,
          participant_name,
          participant_role,
          allocation_id,
          vote,
          response_notes,
          responded_at
        FROM property_co_owner_consent_votes
        WHERE consent_id = $1
        ORDER BY participant_role DESC, participant_name ASC
      `,
      [consentId]
    );

    return result.rows;
  }

  async getLatestConsentRecord(propertyId, operationType = "SALE_OR_TRANSFER", client = null) {
    await this.ensureSchema(client);

    const db = toExecutor(client);
    const normalizedType = normalizeOperationType(operationType);
    const result = await db.query(
      `
        SELECT *
        FROM property_co_owner_consents
        WHERE property_id = $1
          AND operation_type = $2
        ORDER BY initiated_at DESC, created_at DESC
        LIMIT 1
      `,
      [propertyId, normalizedType]
    );

    return result.rows[0] || null;
  }

  async getPropertyConsentState(propertyId, viewerUserId = null, client = null, operationType = "SALE_OR_TRANSFER") {
    await this.ensureSchema(client);

    const coOwnershipState = await propertyCoOwnershipService.getPropertyCoOwnershipState(propertyId, client);
    if (!coOwnershipState) return null;

    const consentRow = await this.getLatestConsentRecord(propertyId, operationType, client);
    const voteRows = consentRow ? await this.listVotes(consentRow.consent_id, client) : [];
    return this.buildConsentSummary(consentRow, voteRows, viewerUserId, coOwnershipState);
  }

  async resolveParticipants(propertyId, client = null) {
    const coOwnershipState = await propertyCoOwnershipService.getPropertyCoOwnershipState(propertyId, client);
    if (!coOwnershipState) {
      throw new Error("Property not found");
    }

    if (!coOwnershipState.has_co_owners) {
      return { coOwnershipState, participants: [] };
    }

    const participants = [
      {
        participantUserId: coOwnershipState.owner_id,
        participantName: coOwnershipState.owner_name,
        participantRole: "PRIMARY_OWNER",
        allocationId: null,
      },
    ];

    for (const item of coOwnershipState.co_owners || []) {
      if (!item.user_id) {
        throw new Error(
          `Co-owner ${item.owner_name || item.owner_cnic || "Unknown"} is not linked to a citizen account yet`
        );
      }

      participants.push({
        participantUserId: item.user_id,
        participantName: item.owner_name,
        participantRole: "CO_OWNER",
        allocationId: item.allocation_id || null,
      });
    }

    const deduped = [];
    const seen = new Set();
    for (const participant of participants) {
      if (!participant.participantUserId || seen.has(participant.participantUserId)) continue;
      seen.add(participant.participantUserId);
      deduped.push(participant);
    }

    return { coOwnershipState, participants: deduped };
  }

  async recomputeConsentStatus(consentId, client = null) {
    const db = toExecutor(client);
    const consentResult = await db.query(
      `SELECT * FROM property_co_owner_consents WHERE consent_id = $1 LIMIT 1`,
      [consentId]
    );
    const consentRow = consentResult.rows[0] || null;
    if (!consentRow) {
      throw new Error("Consent request not found");
    }

    const voteRows = await this.listVotes(consentId, client);
    const approvals = voteRows.filter((row) => row.vote === "APPROVE").length;
    const rejections = voteRows.filter((row) => row.vote === "REJECT").length;
    const pending = voteRows.filter((row) => !row.vote).length;

    let nextStatus = "PENDING";
    if (rejections > 0) nextStatus = "REJECTED";
    else if (pending === 0 && approvals === voteRows.length) nextStatus = "APPROVED";

    await db.query(
      `
        UPDATE property_co_owner_consents
        SET status = $2,
            resolved_at = CASE
              WHEN $2 IN ('APPROVED', 'REJECTED') THEN COALESCE(resolved_at, NOW())
              ELSE NULL
            END,
            updated_at = NOW()
        WHERE consent_id = $1
      `,
      [consentId, nextStatus]
    );

    const coOwnershipState = await propertyCoOwnershipService.getPropertyCoOwnershipState(
      consentRow.property_id,
      client
    );

    return this.buildConsentSummary(
      { ...consentRow, status: nextStatus, resolved_at: nextStatus === "PENDING" ? null : consentRow.resolved_at || new Date().toISOString() },
      voteRows,
      null,
      coOwnershipState
    );
  }

  async requestConsent(
    {
      propertyId,
      actorUserId,
      actorName = null,
      operationType = "SALE_OR_TRANSFER",
      requestedPrice = null,
      notes = "",
      ipAddress = null,
      routePath = null,
      httpMethod = null,
    },
    client = null
  ) {
    await this.ensureSchema(client);

    const db = toExecutor(client);
    const normalizedType = normalizeOperationType(operationType);
    const operationLabel = CO_OWNER_CONSENT_OPERATION_TYPES[normalizedType];
    const { coOwnershipState, participants } = await this.resolveParticipants(propertyId, client);

    if (!coOwnershipState.has_co_owners) {
      return {
        changed: false,
        consent: await this.getPropertyConsentState(propertyId, actorUserId, client, normalizedType),
      };
    }

    const actorAllowed = participants.some((participant) => participant.participantUserId === actorUserId);
    if (!actorAllowed) {
      throw new Error("Only a registered owner or co-owner can request shared-owner consent");
    }

    const latest = await this.getLatestConsentRecord(propertyId, normalizedType, client);
    if (latest && ["PENDING", "APPROVED"].includes(String(latest.status || "").toUpperCase())) {
      const state = await this.getPropertyConsentState(propertyId, actorUserId, client, normalizedType);
      return { changed: false, consent: state };
    }

    const initiator = participants.find((participant) => participant.participantUserId === actorUserId) || null;
    const resolvedActorName = actorName || initiator?.participantName || null;
    const consentId = buildConsentId();
    const price = normalizeMoney(requestedPrice);
    await db.query(
      `
        INSERT INTO property_co_owner_consents (
          consent_id,
          property_id,
          operation_type,
          operation_label,
          status,
          initiated_by_user_id,
          initiated_by_name,
          notes,
          requested_price,
          initiated_at,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, 'PENDING', $5, $6, NULLIF($7, ''), $8, NOW(), NOW(), NOW())
      `,
      [
        consentId,
        propertyId,
        normalizedType,
        operationLabel,
        actorUserId,
        resolvedActorName,
        notes,
        price,
      ]
    );

    for (const participant of participants) {
      const autoVote = participant.participantUserId === actorUserId ? "APPROVE" : null;
      await db.query(
        `
          INSERT INTO property_co_owner_consent_votes (
            vote_id,
            consent_id,
            property_id,
            participant_user_id,
            participant_name,
            participant_role,
            allocation_id,
            vote,
            response_notes,
            responded_at,
            created_at,
            updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            CASE WHEN $8 IS NOT NULL THEN 'Initiated by participant' ELSE NULL END,
            CASE WHEN $8 IS NOT NULL THEN NOW() ELSE NULL END,
            NOW(),
            NOW()
          )
        `,
        [
          buildVoteId(),
          consentId,
          propertyId,
          participant.participantUserId,
          participant.participantName,
          participant.participantRole,
          participant.allocationId,
          autoVote,
        ]
      );
    }

    await auditService.writeLog({
      userId: actorUserId,
      actionType: "CO_OWNER_CONSENT_REQUESTED",
      targetId: consentId,
      targetType: "PROPERTY",
      details: {
        propertyId,
        operationType: normalizedType,
        requestedPrice: price,
        participants: participants.map((participant) => ({
          userId: participant.participantUserId,
          role: participant.participantRole,
        })),
      },
      ipAddress,
      routePath,
      httpMethod,
      status: "SUCCESS",
    }).catch(() => {});

    const consent = await this.recomputeConsentStatus(consentId, client);
    return { changed: true, consent };
  }

  async respondToConsent(
    {
      consentId,
      actorUserId,
      vote,
      notes = "",
      ipAddress = null,
      routePath = null,
      httpMethod = null,
    },
    client = null
  ) {
    await this.ensureSchema(client);

    const db = toExecutor(client);
    const consentResult = await db.query(
      `SELECT * FROM property_co_owner_consents WHERE consent_id = $1 LIMIT 1`,
      [consentId]
    );

    const consentRow = consentResult.rows[0] || null;
    if (!consentRow) {
      throw new Error("Consent request not found");
    }

    if (String(consentRow.status || "").toUpperCase() !== "PENDING") {
      throw new Error(`Consent request is already ${String(consentRow.status || "").toLowerCase()}`);
    }

    const voteRowResult = await db.query(
      `
        SELECT *
        FROM property_co_owner_consent_votes
        WHERE consent_id = $1
          AND participant_user_id = $2
        LIMIT 1
      `,
      [consentId, actorUserId]
    );

    const voteRow = voteRowResult.rows[0] || null;
    if (!voteRow) {
      throw new Error("You are not a participant on this consent request");
    }

    if (voteRow.vote) {
      throw new Error("You already responded to this consent request");
    }

    const normalizedVote = normalizeVote(vote);
    await db.query(
      `
        UPDATE property_co_owner_consent_votes
        SET vote = $3,
            response_notes = NULLIF($4, ''),
            responded_at = NOW(),
            updated_at = NOW()
        WHERE consent_id = $1
          AND participant_user_id = $2
      `,
      [consentId, actorUserId, normalizedVote, notes]
    );

    await auditService.writeLog({
      userId: actorUserId,
      actionType: "CO_OWNER_CONSENT_RESPONDED",
      targetId: consentId,
      targetType: "PROPERTY",
      details: {
        consentId,
        propertyId: consentRow.property_id,
        vote: normalizedVote,
        notes: notes || null,
      },
      ipAddress,
      routePath,
      httpMethod,
      status: "SUCCESS",
    }).catch(() => {});

    return this.recomputeConsentStatus(consentId, client);
  }

  async assertConsentApproved(
    propertyId,
    client = null,
    operationType = "SALE_OR_TRANSFER",
    message = "Shared-owner consent is required before this action can proceed."
  ) {
    const state = await this.getPropertyConsentState(propertyId, null, client, operationType);

    if (!state) {
      const error = new Error("Property not found");
      error.code = "PROPERTY_NOT_FOUND";
      throw error;
    }

    if (!state.required || state.canProceed) {
      return state;
    }

    const error = new Error(message);
    error.code = "CO_OWNER_CONSENT_REQUIRED";
    error.consentDetails = state;
    throw error;
  }

  async listConsentCases({ limit = 12, includeResolved = false } = {}, client = null) {
    await this.ensureSchema(client);

    const db = toExecutor(client);
    const params = [];
    const where = [];

    if (!includeResolved) {
      params.push(["PENDING", "APPROVED"]);
      where.push(`status = ANY($${params.length})`);
    }

    params.push(Math.min(Math.max(Number(limit) || 12, 1), 100));

    const result = await db.query(
      `
        SELECT
          c.*,
          p.owner_name,
          p.owner_cnic,
          p.district,
          p.tehsil,
          p.mauza,
          p.status AS property_status
        FROM property_co_owner_consents c
        JOIN properties p ON p.property_id = c.property_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY c.initiated_at DESC, c.created_at DESC
        LIMIT $${params.length}
      `,
      params
    );

    const cases = [];
    for (const row of result.rows) {
      const votes = await this.listVotes(row.consent_id, client);
      const coOwnershipState = await propertyCoOwnershipService.getPropertyCoOwnershipState(
        row.property_id,
        client,
        { syncBeforeRead: false }
      );
      cases.push({
        ...this.buildConsentSummary(row, votes, null, coOwnershipState),
        propertyId: row.property_id,
        ownerName: row.owner_name,
        ownerCnic: row.owner_cnic,
        district: row.district,
        tehsil: row.tehsil,
        mauza: row.mauza,
        propertyStatus: row.property_status,
      });
    }

    return cases;
  }

  async listPendingForUser(userId, client = null) {
    await this.ensureSchema(client);

    const db = toExecutor(client);
    const result = await db.query(
      `
        SELECT DISTINCT c.*
        FROM property_co_owner_consents c
        JOIN property_co_owner_consent_votes v
          ON v.consent_id = c.consent_id
        WHERE v.participant_user_id = $1
          AND v.vote IS NULL
          AND c.status = 'PENDING'
        ORDER BY c.initiated_at DESC, c.created_at DESC
      `,
      [userId]
    );

    const items = [];
    for (const row of result.rows) {
      const votes = await this.listVotes(row.consent_id, client);
      const coOwnershipState = await propertyCoOwnershipService.getPropertyCoOwnershipState(
        row.property_id,
        client,
        { syncBeforeRead: false }
      );
      const summary = this.buildConsentSummary(row, votes, userId, coOwnershipState);
      items.push({
        ...summary,
        propertyId: row.property_id,
      });
    }

    return items;
  }
}

export default new PropertyCoOwnerConsentService();
