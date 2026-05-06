import crypto from "crypto";
import express from "express";
import jwt from "jsonwebtoken";

import pool from "../config/db.js";
import fabricGatewayService from "../services/fabricGateway.service.js";
import fabricPLRAService from "../services/fabricPLRA.service.js";
import ownershipHistoryService from "../services/ownershipHistory.service.js";
import successionRuleService from "../services/successionRule.service.js";
import { findNodeByUserId, findNodeFromEmail } from "../config/plraNodes.js";

const router = express.Router();

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

function requireCitizen(req, res, next) {
  const role = String(req.user?.role || "").toUpperCase();
  if (role !== "CITIZEN") {
    return res.status(403).json({ success: false, message: "Citizen access required" });
  }
  next();
}

function normalizeRelationType(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
}

function normalizeOwnerGender(value) {
  const normalized = String(value || "").trim().toUpperCase();
  return ["MALE", "FEMALE"].includes(normalized) ? normalized : "";
}

function inferGenderFromRelation(relationType) {
  const normalized = normalizeRelationType(relationType);
  if (normalized === "WIFE" || normalized === "DAUGHTER") return "FEMALE";
  if (normalized === "HUSBAND" || normalized === "SON") return "MALE";
  return "";
}

async function resolveNodeId(userId) {
  const direct = findNodeByUserId(userId);
  if (direct) return direct.nodeId;

  const result = await pool.query(
    "SELECT email FROM users WHERE user_id = $1 LIMIT 1",
    [userId]
  );
  const emailNode = findNodeFromEmail(result.rows[0]?.email);
  return emailNode?.nodeId || null;
}

async function getCaseDetail(successionRequestId) {
  const detail = await fabricPLRAService.getSuccessionCase(successionRequestId);
  if (!detail) return null;

  const approvals = detail.votes.filter((vote) => String(vote.vote).toUpperCase() === "APPROVE").length;
  const rejections = detail.votes.filter((vote) => String(vote.vote).toUpperCase() === "REJECT").length;

  return {
    ...detail,
    approvals,
    rejections,
    thresholdReached: approvals >= 3,
  };
}

async function getOwnerCnicForProperty(propertyId, client = pool) {
  const result = await client.query(
    `
      SELECT COALESCE(u.cnic, p.owner_cnic) AS owner_cnic
      FROM properties p
      LEFT JOIN users u
        ON u.user_id = p.owner_id
      WHERE p.property_id = $1
      LIMIT 1
    `,
    [propertyId]
  );
  return result.rows[0]?.owner_cnic || null;
}

async function getCitizenOwnedProperty(propertyId, userId, client = pool) {
  const result = await client.query(
    `
      SELECT
        p.property_id,
        p.owner_id,
        p.owner_name,
        p.owner_cnic,
        p.property_type,
        p.district,
        p.tehsil,
        p.mauza,
        p.area_marla,
        p.status,
        FALSE AS has_co_owners,
        u.gender AS owner_gender
      FROM properties p
      LEFT JOIN users u
        ON u.user_id = p.owner_id
      WHERE p.property_id = $1
        AND p.owner_id = $2
        AND COALESCE(p.status, '') = 'APPROVED'
      LIMIT 1
    `,
    [propertyId, userId]
  );

  return result.rows[0] || null;
}

async function listActiveFamilyMembers(ownerUserId, client = pool) {
  const result = await client.query(
    `
      SELECT
        family_member_id,
        owner_user_id,
        linked_user_id,
        relation_type,
        gender,
        full_name,
        cnic,
        date_of_birth,
        father_name,
        mother_name,
        notes,
        is_minor,
        is_active,
        created_at,
        updated_at
      FROM family_members
      WHERE owner_user_id = $1
        AND COALESCE(is_active, TRUE) = TRUE
      ORDER BY created_at ASC
    `,
    [ownerUserId]
  );

  return result.rows;
}

async function listCitizenSuccessionRequests(userId, propertyId = null, client = pool) {
  const params = [userId];
  const clauses = ["sr.requester_user_id = $1"];

  if (propertyId) {
    params.push(propertyId);
    clauses.push(`sr.property_id = $${params.length}`);
  }

  const result = await client.query(
    `
      SELECT
        sr.*,
        p.owner_name,
        p.property_type,
        p.district,
        p.tehsil,
        p.mauza,
        p.area_marla
      FROM succession_requests sr
      LEFT JOIN properties p
        ON p.property_id = sr.property_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY COALESCE(sr.updated_at, sr.created_at, sr.submitted_at) DESC
      LIMIT 20
    `,
    params
  );

  return result.rows;
}

async function getCitizenGender(userId, client = pool) {
  const result = await client.query(
    `
      SELECT gender
      FROM users
      WHERE user_id = $1
      LIMIT 1
    `,
    [userId]
  );

  return normalizeOwnerGender(result.rows[0]?.gender);
}

function buildShareHash(shareSnapshot) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(shareSnapshot || []))
    .digest("hex");
}

router.get("/family-members", authenticateToken, requireCitizen, async (req, res) => {
  try {
    const ownerGender = await getCitizenGender(req.user.userId);
    const members = await listActiveFamilyMembers(req.user.userId);
    return res.json({
      success: true,
      members,
      ownerGender: ownerGender || null,
      supportedRelations: successionRuleService.getSupportedRelations(),
      allowedRelations: successionRuleService.getAllowedRelations(ownerGender),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/family-members", authenticateToken, requireCitizen, async (req, res) => {
  try {
    const relationType = normalizeRelationType(req.body.relationType);
    const fullName = String(req.body.fullName || "").trim();
    const cnic = String(req.body.cnic || "").trim() || null;
    const dateOfBirth = String(req.body.dateOfBirth || "").trim() || null;
    const notes = String(req.body.notes || "").trim() || null;
    const linkedUserId = String(req.body.linkedUserId || "").trim() || null;
    const inferredGender = inferGenderFromRelation(relationType);
    const ownerGender = await getCitizenGender(req.user.userId);
    const allowedRelations = successionRuleService.getAllowedRelations(ownerGender);

    if (!successionRuleService.getSupportedRelations().includes(relationType)) {
      return res.status(400).json({
        success: false,
        message: "Relation type must be WIFE, HUSBAND, SON, or DAUGHTER",
      });
    }

    if (!ownerGender) {
      return res.status(400).json({
        success: false,
        message: "Save owner gender in profile first before adding succession family members",
      });
    }

    if (!allowedRelations.includes(relationType)) {
      return res.status(400).json({
        success: false,
        message:
          ownerGender === "MALE"
            ? "Male owner can add wife and children only"
            : "Female owner can add children only",
      });
    }

    if (!fullName) {
      return res.status(400).json({
        success: false,
        message: "Full name is required",
      });
    }

    if (!inferredGender) {
      return res.status(400).json({
        success: false,
        message: "Unable to determine family member gender from relation type",
      });
    }

    let resolvedLinkedUserId = linkedUserId;
    let resolvedLinkedUserGender = "";
    if (!resolvedLinkedUserId && cnic) {
      const linkedUser = await pool.query(
        `
          SELECT user_id, gender
          FROM users
          WHERE cnic = $1
            AND UPPER(role) = 'CITIZEN'
          LIMIT 1
        `,
        [cnic]
      );
      resolvedLinkedUserId = linkedUser.rows[0]?.user_id || null;
      resolvedLinkedUserGender = normalizeOwnerGender(linkedUser.rows[0]?.gender);
    } else if (resolvedLinkedUserId) {
      const linkedUser = await pool.query(
        `
          SELECT gender
          FROM users
          WHERE user_id = $1
            AND UPPER(role) = 'CITIZEN'
          LIMIT 1
        `,
        [resolvedLinkedUserId]
      );
      resolvedLinkedUserGender = normalizeOwnerGender(linkedUser.rows[0]?.gender);
    }

    if (resolvedLinkedUserGender && resolvedLinkedUserGender !== inferredGender) {
      return res.status(400).json({
        success: false,
        message: `Linked citizen gender does not match relation type ${relationType}`,
      });
    }

    const isMinor = dateOfBirth
      ? Math.max(
          0,
          Math.floor(
            (Date.now() - new Date(dateOfBirth).getTime()) / (365.25 * 24 * 60 * 60 * 1000)
          )
        ) < 18
      : false;

    const result = await pool.query(
      `
        INSERT INTO family_members (
          family_member_id,
          owner_user_id,
          linked_user_id,
          relation_type,
          gender,
          full_name,
          cnic,
          date_of_birth,
          notes,
          is_minor,
          is_active,
          created_at,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, NULLIF($7, ''), NULLIF($8, '')::date, NULLIF($9, ''),
          $10, TRUE, NOW(), NOW()
        )
        RETURNING *
      `,
      [
        crypto.randomUUID(),
        req.user.userId,
        resolvedLinkedUserId,
        relationType,
        resolvedLinkedUserGender || inferredGender,
        fullName,
        cnic || "",
        dateOfBirth || "",
        notes || "",
        isMinor,
      ]
    );

    return res.json({
      success: true,
      message: "Family member added",
      member: result.rows[0],
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.delete("/family-members/:familyMemberId", authenticateToken, requireCitizen, async (req, res) => {
  try {
    const result = await pool.query(
      `
        UPDATE family_members
        SET is_active = FALSE,
            updated_at = NOW()
        WHERE family_member_id = $1
          AND owner_user_id = $2
        RETURNING family_member_id
      `,
      [req.params.familyMemberId, req.user.userId]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Family member not found",
      });
    }

    return res.json({
      success: true,
      message: "Family member removed",
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/property/:propertyId/preview", authenticateToken, requireCitizen, async (req, res) => {
  try {
    const property = await getCitizenOwnedProperty(req.params.propertyId, req.user.userId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: "Approved owned property not found",
      });
    }

    const familyMembers = await listActiveFamilyMembers(req.user.userId);
    const ownerGender = normalizeOwnerGender(property.owner_gender);
    const preview = successionRuleService.buildIslamicFamilyPreview({
      ownerGender,
      familyMembers,
    });
    const requests = await listCitizenSuccessionRequests(req.user.userId, req.params.propertyId);

    return res.json({
      success: true,
      property,
      familyMembers,
      preview,
      allowedRelations: successionRuleService.getAllowedRelations(ownerGender),
      requests,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/my-requests", authenticateToken, requireCitizen, async (req, res) => {
  try {
    const requests = await listCitizenSuccessionRequests(
      req.user.userId,
      String(req.query.propertyId || "").trim() || null
    );
    return res.json({
      success: true,
      requests,
      total: requests.length,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/requests", authenticateToken, requireCitizen, async (req, res) => {
  const client = await pool.connect();

  try {
    const propertyId = String(req.body.propertyId || "").trim();
    const notes = String(req.body.notes || "").trim() || null;
    const deathCertificateReference =
      String(req.body.deathCertificateReference || "").trim() || null;

    // Map frontend requestType to allowed DB values:
    //   succession_requests_request_type_check: LIFETIME_DIVISION | DEATH_SUCCESSION
    // The Islamic family division the citizen performs is a DEATH_SUCCESSION.
    const rawRequestType = String(req.body.requestType || "").trim();
    const REQUEST_TYPE_MAP = {
      ISLAMIC_FAMILY_DIVISION: "DEATH_SUCCESSION",
      DEATH_SUCCESSION:        "DEATH_SUCCESSION",
      LIFETIME_DIVISION:       "LIFETIME_DIVISION",
    };
    const requestType = REQUEST_TYPE_MAP[rawRequestType.toUpperCase()] || "DEATH_SUCCESSION";

    if (!propertyId) {
      return res.status(400).json({
        success: false,
        message: "Property ID is required",
      });
    }

    await client.query("BEGIN");

    const property = await getCitizenOwnedProperty(propertyId, req.user.userId, client);
    if (!property) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Approved owned property not found",
      });
    }

    const ownerGender = normalizeOwnerGender(property.owner_gender);
    if (!ownerGender) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Owner gender is missing on the citizen profile. Save it once in profile or succession planner before submitting.",
      });
    }

    const openRequest = await client.query(
      `
        SELECT succession_request_id
        FROM succession_requests
        WHERE property_id = $1
          AND requester_user_id = $2
          AND COALESCE(status, '') NOT IN ('COMPLETED', 'REJECTED')
        LIMIT 1
      `,
      [propertyId, req.user.userId]
    );

    if (openRequest.rows.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "There is already an open succession request for this property",
      });
    }

    const familyMembers = await listActiveFamilyMembers(req.user.userId, client);
    const preview = successionRuleService.buildIslamicFamilyPreview({
      ownerGender,
      familyMembers,
    });

    if (!preview.canSubmit) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: preview.blockers[0] || preview.warnings[0] || "Succession allocation is not ready for submission",
        preview,
      });
    }

    const successionRequestId = crypto.randomUUID();
    const requestNo = `SUC-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const shareHash = buildShareHash(preview.shareSnapshot);

    const requestInsert = await client.query(
      `
        INSERT INTO succession_requests (
          succession_request_id,
          request_no,
          property_id,
          requester_user_id,
          owner_user_id,
          request_type,
          owner_gender,
          death_certificate_reference,
          notes,
          status,
          lro_status,
          blockchain_status,
          dc_status,
          total_allocated_percent,
          total_heirs,
          share_snapshot,
          submitted_at,
          created_at,
          updated_at,
          share_hash
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, NULLIF($8, ''), NULLIF($9, ''),
          'SUBMITTED', 'PENDING', 'NOT_SUBMITTED', 'PENDING',
          $10, $11, $12::jsonb, NOW(), NOW(), NOW(), $13
        )
        RETURNING *
      `,
      [
        successionRequestId,
        requestNo,
        propertyId,
        req.user.userId,
        property.owner_id,
        requestType,
        ownerGender,
        deathCertificateReference || "",
        notes || "",
        preview.totalAllocatedPercent,
        preview.totalHeirs,
        JSON.stringify(preview.shareSnapshot),
        shareHash,
      ]
    );

    for (const heir of preview.allocations) {
      // Convert dateOfBirth to YYYY-MM-DD string regardless of whether it
      // comes back from PostgreSQL as a Date object or an ISO string.
      // Passing a Date object to NULLIF($8,'')::date causes a type error.
      let safeDob = null;
      if (heir.dateOfBirth) {
        const d = heir.dateOfBirth instanceof Date
          ? heir.dateOfBirth
          : new Date(heir.dateOfBirth);
        if (!isNaN(d.getTime())) {
          safeDob = d.toISOString().substring(0, 10); // "YYYY-MM-DD"
        }
      }

      await client.query(
        `
          INSERT INTO succession_heirs (
            heir_id,
            succession_request_id,
            family_member_id,
            linked_user_id,
            relation_type,
            full_name,
            cnic,
            date_of_birth,
            is_minor,
            share_numerator,
            share_denominator,
            share_percent,
            share_fraction_text,
            share_basis,
            allocation_kind,
            created_at
          )
          VALUES (
            $1, $2, $3::uuid, $4, $5, $6, NULLIF($7, ''), $8::date, $9,
            $10, $11, $12, $13, $14, $15, NOW()
          )
        `,
        [
          crypto.randomUUID(),
          successionRequestId,
          heir.familyMemberId,
          heir.linkedUserId || null,
          heir.relationType,
          heir.fullName,
          heir.cnic || "",
          safeDob,           // YYYY-MM-DD string or null
          heir.isMinor,
          heir.shareNumerator,
          heir.shareDenominator,
          heir.sharePercent,
          heir.shareFractionText,
          heir.shareBasis,
          heir.allocationKind,
        ]
      );
    }

    await client.query(
      `
        INSERT INTO succession_events (
          event_id,
          succession_request_id,
          event_type,
          actor_id,
          actor_role,
          metadata,
          notes,
          created_at
        )
        VALUES (
          $1, $2, 'CITIZEN_SUCCESSION_SUBMITTED', $3, $4, $5::jsonb, $6, NOW()
        )
      `,
      [
        crypto.randomUUID(),
        successionRequestId,
        req.user.userId,
        "CITIZEN",
        JSON.stringify({
          propertyId,
          requestType,
          ownerGender,
          totalAllocatedPercent: preview.totalAllocatedPercent,
          totalHeirs: preview.totalHeirs,
        }),
        notes || "Islamic family succession request submitted",
      ]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Succession request submitted successfully",
      request: requestInsert.rows[0],
      preview,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
});

router.get(
  "/analytics/summary",
  authenticateToken,
  requireRole(["ADMIN", "DC", "LRO", "LAND RECORD OFFICER"]),
  async (req, res) => {
    try {
      const [
        summaryResult,
        requestTypeResult,
        relationResult,
        districtResult,
        propertyTypeResult,
        monthlyResult,
        recentResult,
      ] = await Promise.all([
        pool.query(
          `
            SELECT
              COUNT(*) AS total_requests,
              COUNT(*) FILTER (
                WHERE COALESCE(status, '') NOT IN ('COMPLETED', 'REJECTED')
              ) AS open_requests,
              COUNT(*) FILTER (
                WHERE COALESCE(lro_status, '') = 'APPROVED'
              ) AS lro_approved,
              COUNT(*) FILTER (
                WHERE COALESCE(blockchain_status, '') = 'READY_FOR_DC'
              ) AS ready_for_dc,
              COUNT(*) FILTER (
                WHERE COALESCE(dc_status, '') = 'APPROVED'
              ) AS dc_approved,
              COUNT(*) FILTER (
                WHERE COALESCE(status, '') = 'COMPLETED'
              ) AS completed_requests,
              COUNT(*) FILTER (
                WHERE COALESCE(status, '') = 'REJECTED'
                   OR COALESCE(dc_status, '') = 'REJECTED'
              ) AS rejected_requests,
              COUNT(*) FILTER (
                WHERE COALESCE(blockchain_status, '') = 'NOT_SUBMITTED'
              ) AS pending_blockchain,
              COALESCE(SUM(total_heirs), 0) AS total_heir_rows,
              ROUND(COALESCE(AVG(NULLIF(total_heirs, 0)), 0)::numeric, 2) AS avg_heirs_per_request,
              ROUND(COALESCE(AVG(total_allocated_percent), 0)::numeric, 2) AS avg_allocated_percent
            FROM succession_requests
          `
        ),
        pool.query(
          `
            SELECT
              COALESCE(request_type, 'UNSPECIFIED') AS request_type,
              COUNT(*) AS request_count,
              ROUND((COUNT(*) * 100.0 / NULLIF(SUM(COUNT(*)) OVER (), 0))::numeric, 2) AS percentage
            FROM succession_requests
            GROUP BY COALESCE(request_type, 'UNSPECIFIED')
            ORDER BY request_count DESC, request_type ASC
          `
        ),
        pool.query(
          `
            SELECT
              COALESCE(relation_type, 'UNSPECIFIED') AS relation_type,
              COUNT(*) AS heir_count,
              ROUND((COUNT(*) * 100.0 / NULLIF(SUM(COUNT(*)) OVER (), 0))::numeric, 2) AS percentage
            FROM succession_heirs
            GROUP BY COALESCE(relation_type, 'UNSPECIFIED')
            ORDER BY heir_count DESC, relation_type ASC
          `
        ),
        pool.query(
          `
            SELECT
              COALESCE(p.district, 'Unknown') AS district,
              COUNT(*) AS request_count,
              COUNT(*) FILTER (WHERE COALESCE(sr.dc_status, '') = 'APPROVED') AS approved_count,
              ROUND(COALESCE(AVG(NULLIF(sr.total_heirs, 0)), 0)::numeric, 2) AS avg_heirs
            FROM succession_requests sr
            LEFT JOIN properties p
              ON p.property_id = sr.property_id
            GROUP BY COALESCE(p.district, 'Unknown')
            ORDER BY request_count DESC, district ASC
            LIMIT 8
          `
        ),
        pool.query(
          `
            SELECT
              COALESCE(p.property_type, 'UNKNOWN') AS property_type,
              COUNT(*) AS request_count,
              COUNT(*) FILTER (WHERE COALESCE(sr.dc_status, '') = 'APPROVED') AS approved_count,
              ROUND(COALESCE(AVG(NULLIF(sr.total_heirs, 0)), 0)::numeric, 2) AS avg_heirs
            FROM succession_requests sr
            LEFT JOIN properties p
              ON p.property_id = sr.property_id
            GROUP BY COALESCE(p.property_type, 'UNKNOWN')
            ORDER BY request_count DESC, property_type ASC
            LIMIT 8
          `
        ),
        pool.query(
          `
            WITH months AS (
              SELECT generate_series(
                date_trunc('month', NOW()) - INTERVAL '5 months',
                date_trunc('month', NOW()),
                INTERVAL '1 month'
              ) AS month_start
            ),
            month_rollup AS (
              SELECT
                date_trunc('month', COALESCE(submitted_at, created_at)) AS month_start,
                COUNT(*) AS request_count,
                COUNT(*) FILTER (WHERE COALESCE(dc_status, '') = 'APPROVED') AS approved_count,
                COUNT(*) FILTER (
                  WHERE COALESCE(status, '') = 'REJECTED'
                     OR COALESCE(dc_status, '') = 'REJECTED'
                ) AS rejected_count
              FROM succession_requests
              GROUP BY date_trunc('month', COALESCE(submitted_at, created_at))
            )
            SELECT
              TO_CHAR(months.month_start, 'YYYY-MM') AS month_key,
              TO_CHAR(months.month_start, 'Mon YYYY') AS month_label,
              COALESCE(month_rollup.request_count, 0) AS request_count,
              COALESCE(month_rollup.approved_count, 0) AS approved_count,
              COALESCE(month_rollup.rejected_count, 0) AS rejected_count
            FROM months
            LEFT JOIN month_rollup
              ON month_rollup.month_start = months.month_start
            ORDER BY months.month_start ASC
          `
        ),
        pool.query(
          `
            SELECT
              sr.succession_request_id,
              sr.request_no,
              sr.property_id,
              sr.request_type,
              sr.status,
              sr.lro_status,
              sr.dc_status,
              sr.total_heirs,
              sr.total_allocated_percent,
              sr.submitted_at,
              sr.created_at,
              p.district,
              p.tehsil,
              p.mauza,
              p.property_type
            FROM succession_requests sr
            LEFT JOIN properties p
              ON p.property_id = sr.property_id
            ORDER BY COALESCE(sr.updated_at, sr.created_at, sr.submitted_at) DESC
            LIMIT 8
          `
        ),
      ]);

      return res.json({
        success: true,
        summary: summaryResult.rows[0] || {},
        requestTypes: requestTypeResult.rows,
        heirRelations: relationResult.rows,
        topDistricts: districtResult.rows,
        propertyTypes: propertyTypeResult.rows,
        monthlyTrend: monthlyResult.rows,
        recentRequests: recentResult.rows,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.get("/cases", authenticateToken, requireRole(["ADMIN", "DC", "LRO", "LAND RECORD OFFICER"]), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT *
       FROM succession_requests
       ORDER BY COALESCE(updated_at, created_at, submitted_at) DESC`
    );

    return res.json({
      success: true,
      cases: result.rows,
      total: result.rows.length,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/cases/:successionRequestId", authenticateToken, requireRole(["ADMIN", "DC", "LRO", "LAND RECORD OFFICER"]), async (req, res) => {
  try {
    const detail = await getCaseDetail(req.params.successionRequestId);
    if (!detail) {
      return res.status(404).json({ success: false, message: "Succession case not found" });
    }

    return res.json({ success: true, ...detail });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post(
  "/officer/lro/:successionRequestId/submit",
  authenticateToken,
  requireRole(["LRO", "LAND RECORD OFFICER", "ADMIN"]),
  async (req, res) => {
    try {
      const { successionRequestId } = req.params;

      const updated = await pool.query(
        `UPDATE succession_requests
         SET status = COALESCE(status, 'UNDER_REVIEW'),
             blockchain_status = 'SUBMITTED',
             submitted_to_blockchain_at = COALESCE(submitted_to_blockchain_at, NOW()),
             updated_at = NOW()
         WHERE succession_request_id = $1
         RETURNING *`,
        [successionRequestId]
      );

      if (!updated.rows.length) {
        return res.status(404).json({ success: false, message: "Succession case not found" });
      }

      const ownerCnic = await getOwnerCnicForProperty(updated.rows[0].property_id);

      await pool.query(
        `INSERT INTO succession_events
           (event_id, succession_request_id, event_type, actor_id, actor_role, metadata, notes, created_at)
         VALUES
           ($1, $2, 'SUBMITTED_FOR_LRO_VOTING', $3, $4, $5::jsonb, $6, NOW())`,
        [
          crypto.randomUUID(),
          successionRequestId,
          req.user.userId,
          String(req.user.role || "").toUpperCase(),
          JSON.stringify({ submittedBy: req.user.userId }),
          "Succession case submitted for LRO voting",
        ]
      );

      await fabricGatewayService.submitSuccessionCase(
        successionRequestId,
        {
          status: "SUBMITTED",
          propertyId: updated.rows[0].property_id,
          ownerCnic,
          lroStatus: updated.rows[0].lro_status,
        },
        "LRO_NODE_1"
      );

      return res.json({
        success: true,
        message: "Succession case submitted for voting",
        request: updated.rows[0],
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.post(
  "/officer/lro/:successionRequestId/vote",
  authenticateToken,
  requireRole(["LRO", "LAND RECORD OFFICER", "ADMIN"]),
  async (req, res) => {
    try {
      const { successionRequestId } = req.params;
      const vote = String(req.body.vote || "APPROVE").toUpperCase();
      const reason = String(req.body.reason || "");

      if (!["APPROVE", "REJECT"].includes(vote)) {
        return res.status(400).json({ success: false, message: "Vote must be APPROVE or REJECT" });
      }

      const nodeId = await resolveNodeId(req.user.userId);
      if (!nodeId) {
        return res.status(400).json({ success: false, message: "Unable to resolve LRO node for this user" });
      }

      const requestResult = await pool.query(
        "SELECT * FROM succession_requests WHERE succession_request_id = $1 LIMIT 1",
        [successionRequestId]
      );

      if (!requestResult.rows.length) {
        return res.status(404).json({ success: false, message: "Succession case not found" });
      }

      const existingVote = await pool.query(
        `SELECT *
         FROM succession_votes
         WHERE succession_request_id = $1 AND node_id = $2
         LIMIT 1`,
        [successionRequestId, nodeId]
      );

      if (existingVote.rows.length) {
        return res.status(409).json({
          success: false,
          message: `Node ${nodeId} already voted`,
        });
      }

      const chainResult = await fabricGatewayService.castSuccessionVote(
        successionRequestId,
        nodeId,
        vote,
        reason,
        req.user.userId,
        nodeId
      );
      const syntheticTxId =
        chainResult?.txId ||
        fabricPLRAService.createSyntheticTxId(`${successionRequestId}:${nodeId}:${vote}:${Date.now()}`);

      await pool.query(
        `INSERT INTO succession_votes
           (vote_id, succession_request_id, node_id, vote, reason, tx_id, created_at)
         VALUES
           ($1, $2, $3, $4, $5, $6, NOW())`,
        [crypto.randomUUID(), successionRequestId, nodeId, vote, reason, syntheticTxId]
      );

      await pool.query(
        `INSERT INTO succession_events
           (event_id, succession_request_id, event_type, actor_id, actor_role, metadata, notes, created_at)
         VALUES
           ($1, $2, 'LRO_VOTE_CAST', $3, $4, $5::jsonb, $6, NOW())`,
        [
          crypto.randomUUID(),
          successionRequestId,
          req.user.userId,
          String(req.user.role || "").toUpperCase(),
          JSON.stringify({ nodeId, vote, txId: syntheticTxId }),
          reason || `${vote} vote recorded`,
        ]
      );

      const detail = await getCaseDetail(successionRequestId);

      if (detail?.thresholdReached) {
        await pool.query(
          `UPDATE succession_requests
           SET lro_status = 'APPROVED',
               blockchain_status = 'READY_FOR_DC',
               lro_verified_by = COALESCE(lro_verified_by, $2),
               lro_verified_at = COALESCE(lro_verified_at, NOW()),
               updated_at = NOW()
           WHERE succession_request_id = $1`,
          [successionRequestId, req.user.userId]
        );
      }

      return res.json({
        success: true,
        message: "Vote recorded successfully",
        nodeId,
        chainResult,
        approvals: detail?.approvals || 0,
        rejections: detail?.rejections || 0,
        thresholdReached: detail?.thresholdReached || false,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.post(
  "/officer/dc/:successionRequestId/approve",
  authenticateToken,
  requireRole(["DC", "ADMIN"]),
  async (req, res) => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const { successionRequestId } = req.params;
      const detail = await getCaseDetail(successionRequestId);

      if (!detail) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, message: "Succession case not found" });
      }

      if (!detail.thresholdReached && String(detail.request.lro_status || "").toUpperCase() !== "APPROVED") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          message: "Succession case does not yet have enough LRO approvals",
        });
      }

      const updated = await client.query(
        `UPDATE succession_requests
         SET status = 'COMPLETED',
             blockchain_status = 'COMPLETED',
             dc_status = 'APPROVED',
             dc_approved_by = $2,
             dc_approved_at = NOW(),
             completed_at = NOW(),
             updated_at = NOW()
         WHERE succession_request_id = $1
         RETURNING *`,
        [successionRequestId, req.user.userId]
      );

      const approvedRequest = updated.rows[0];

      await client.query(
        `INSERT INTO succession_events
           (event_id, succession_request_id, event_type, actor_id, actor_role, metadata, notes, created_at)
         VALUES
           ($1, $2, 'DC_SUCCESSION_EXECUTED', $3, $4, $5::jsonb, $6, NOW())`,
        [
          crypto.randomUUID(),
          successionRequestId,
          req.user.userId,
          String(req.user.role || "").toUpperCase(),
          JSON.stringify({ approvedBy: req.user.userId }),
          "Deputy Commissioner approved the succession case",
        ]
      );

      const propertyResult = await client.query(
        `SELECT property_id, owner_id, owner_name, owner_cnic, father_name
           FROM properties
          WHERE property_id = $1
          LIMIT 1`,
        [approvedRequest.property_id]
      );

      const property = propertyResult.rows[0];

      const heirsResult = await client.query(
        `SELECT
           heir_id,
           linked_user_id,
           full_name,
           cnic,
           share_percent,
           share_fraction_text
         FROM succession_heirs
         WHERE succession_request_id = $1
         ORDER BY created_at ASC, heir_id ASC`,
        [successionRequestId]
      );

      for (const heir of heirsResult.rows) {
        const shareLabel =
          String(heir.share_fraction_text || "").trim() ||
          (heir.share_percent !== null && heir.share_percent !== undefined ? `${heir.share_percent}%` : "");

        await ownershipHistoryService.recordOwnershipEvent(client, {
          propertyId: approvedRequest.property_id,
          previousOwnerId: approvedRequest.owner_user_id,
          previousOwnerName: property?.owner_name || detail.request?.owner_name || null,
          previousOwnerCnic: property?.owner_cnic || null,
          newOwnerId: heir.linked_user_id,
          newOwnerName: heir.full_name,
          newOwnerCnic: heir.cnic,
          newOwnerFatherName: property?.father_name || null,
          transferType: "SUCCESSION",
          transferAmount: null,
          transferDate: approvedRequest.completed_at || approvedRequest.dc_approved_at || new Date(),
          referenceType: "SUCCESSION_HEIR",
          referenceId: heir.heir_id,
          remarks: `Succession allocation approved${shareLabel ? ` (${shareLabel})` : ""}`,
          createdAt: approvedRequest.completed_at || approvedRequest.dc_approved_at || new Date(),
        });
      }

      await client.query(
        `INSERT INTO audit_logs (user_id, action_type, target_id, details, ip_address)
         VALUES ($1, 'SUCCESSION_APPROVED_BY_DC', $2, $3, $4)`,
        [
          req.user.userId,
          successionRequestId,
          JSON.stringify({
            successionRequestId,
            propertyId: approvedRequest.property_id,
            totalHeirs: heirsResult.rows.length,
          }),
          req.ip || "unknown",
        ]
      );

      const chainResult = await fabricGatewayService.finalizeSuccessionCase(
        successionRequestId,
        req.user.userId,
        "LRO_NODE_1"
      );

      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "Succession case approved by DC",
        chainResult,
        request: approvedRequest,
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