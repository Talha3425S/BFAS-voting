import express from "express";
import pool from "../config/db.js";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import jwt from "jsonwebtoken";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import blockchainService from "../services/blockchain.service.js";
import propertyEncumbranceService from "../services/propertyEncumbrance.service.js";
import propertyFreezeService from "../services/propertyFreeze.service.js";
import ownershipHistoryService from "../services/ownershipHistory.service.js";

// =====================================================
// AUTHENTICATION MIDDLEWARE
// =====================================================
function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    console.log("❌ No token provided");
    return res.status(401).json({ success: false, message: "Access denied. No token provided." });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "default-jwt-secret");
    req.user = decoded;
    console.log("✅ Token verified for user:", decoded.userId, "Role:", decoded.role);
    next();
  } catch (err) {
    console.log("❌ Token verification failed:", err.message);
    return res.status(403).json({ success: false, message: "Invalid or expired token" });
  }
}

// =====================================================
// CREATE UPLOAD DIRECTORY IF NOT EXISTS
// =====================================================
const uploadDir = path.join(__dirname, '../../uploads/properties');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
  console.log("✅ Created upload directory:", uploadDir);
}

// =====================================================
// MULTER CONFIGURATION - File Upload
// =====================================================
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|pdf/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only images (JPEG, PNG) and PDFs are allowed'));
    }
  }
});

// =====================================================
// UTILITY FUNCTIONS
// =====================================================

// Generate SHA-256 hash for files
function generateFileHash(filePath) {
  try {
    const fileBuffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(fileBuffer).digest('hex');
  } catch (err) {
    console.error("Error generating file hash:", err);
    return null;
  }
}

// Generate unique Property ID
async function generatePropertyId() {
  let propertyId;
  let attempts = 0;
  
  while (attempts < 10) {
    propertyId = "PROP-" + Date.now() + "-" + Math.floor(Math.random() * 10000);
    const exists = await pool.query("SELECT property_id FROM properties WHERE property_id = $1", [propertyId]);
    if (exists.rows.length === 0) break;
    attempts++;
  }
  
  return propertyId;
}

// Generate blockchain hash for property
function generateBlockchainHash(propertyData) {
  const dataString = JSON.stringify(propertyData);
  return crypto.createHash('sha256').update(dataString).digest('hex');
}

// Get latest block hash
async function getLatestBlockHash() {
  try {
    const result = await pool.query(
      "SELECT blockchain_hash FROM blockchain_ledger ORDER BY created_at DESC LIMIT 1"
    );
    return result.rows.length > 0 ? result.rows[0].blockchain_hash : "GENESIS_BLOCK";
  } catch (err) {
    console.error("Error getting latest block hash:", err);
    return "GENESIS_BLOCK";
  }
}

function requirePropertyRestrictionAuthority(req, res, next) {
  const role = String(req.user?.role || "").toUpperCase();
  if (role !== "DC") {
    return res.status(403).json({
      success: false,
      message: "Access denied. Deputy Commissioner restriction authority required.",
    });
  }
  next();
}

function attachPropertyRestrictions(row, options = {}) {
  const encumbranceState = options.encumbranceState || null;
  return {
    ...row,
    freeze_details: propertyFreezeService.buildFreezeDetails(row),
    has_co_owners: false,
    ownership_model: "SOLE",
    active_co_owner_count: 0,
    co_owner_summary: null,
    last_co_ownership_sync_at: null,
    co_ownership_details: {
      active: false,
      count: 0,
      ownershipModel: "SOLE",
      summaryLabel: null,
      syncedAt: null,
      totalAllocatedPercent: 0,
      items: [],
    },
    co_owners: [],
    sale_transfer_consent: null,
    encumbrance_details:
      encumbranceState?.encumbrance_details ||
      propertyEncumbranceService.buildEncumbranceSummaryFromRow(row),
    active_encumbrances: encumbranceState?.active_encumbrances || [],
  };
}

async function getViewerShareAllocation(propertyId, userId) {
  const result = await pool.query(
    `
      WITH citizen AS (
        SELECT cnic
        FROM users
        WHERE user_id = $2
        LIMIT 1
      )
      SELECT
        h.heir_id AS allocation_id,
        h.relation_type,
        h.share_percent,
        h.share_fraction_text,
        COALESCE(r.completed_at, r.dc_approved_at, h.created_at) AS granted_at,
        r.request_no,
        r.succession_request_id,
        h.linked_user_id,
        h.cnic
      FROM succession_heirs h
      JOIN succession_requests r
        ON r.succession_request_id = h.succession_request_id
      LEFT JOIN citizen c ON TRUE
      WHERE r.property_id = $1
        AND (
          h.linked_user_id::text = $2
          OR (c.cnic IS NOT NULL AND h.cnic = c.cnic)
        )
        AND COALESCE(r.dc_status, '') = 'APPROVED'
        AND COALESCE(r.status, '') IN ('COMPLETED', 'APPROVED')
      ORDER BY COALESCE(r.completed_at, r.dc_approved_at, h.created_at) DESC, h.created_at DESC
      LIMIT 1
    `,
    [propertyId, userId]
  );

  return result.rows[0] || null;
}



// =====================================================
// TEST ROUTE
// =====================================================
router.get("/test", (req, res) => {
  res.json({ 
    success: true, 
    message: "Property routes are working!",
    uploadDir: uploadDir
  });
});

// =====================================================
// ADD PROPERTY - SIMPLE (No Photos Required)
// =====================================================
router.post("/add-property-simple", authenticateToken, async (req, res) => {
  console.log("\n========================================");
  console.log("📝 ADD PROPERTY (PENDING APPROVAL)");
  console.log("========================================");
  
  try {
    const userRole = req.user.role.toUpperCase();
    
    if (!['LRO', 'LAND RECORD OFFICER'].includes(userRole)) {
      return res.status(403).json({ 
        success: false, 
        message: "Access denied. Only Land Record Officers can add properties." 
      });
    }

    const {
      ownerName, ownerCnic, fatherName, khewatNo, khatooniNo, khasraNo,
      areaMarla, propertyType, district, tehsil, mauza, address, year
    } = req.body;

    console.log("📋 Form Data:", {
      ownerName, ownerCnic, fatherName, khewatNo, khatooniNo, khasraNo,
      areaMarla, district, tehsil, mauza
    });

    // Validate required fields
    const requiredFields = {
      ownerName, ownerCnic, fatherName, khewatNo, khatooniNo, khasraNo,
      areaMarla, district, tehsil
    };

    const missingFields = Object.entries(requiredFields)
      .filter(([key, value]) => !value)
      .map(([key]) => key);

    if (missingFields.length > 0) {
      return res.status(400).json({ 
        success: false, 
        message: `Please provide all mandatory fields. Missing: ${missingFields.join(', ')}` 
      });
    }

    const cleanedCnic = ownerCnic.replace(/\D/g, "");
    const currentYear = year || new Date().getFullYear();

    // Check if property already exists
    const existingProperty = await pool.query(
      "SELECT * FROM properties WHERE khewat_no = $1 AND khasra_no = $2 AND khatooni_no = $3 AND district = $4",
      [khewatNo, khasraNo, khatooniNo, district]
    );

    if (existingProperty.rows.length > 0) {
      return res.json({
        success: false,
        message: "Property with these details already exists"
      });
    }

    // Check if owner exists, if not create owner record
    let ownerResult = await pool.query(
      "SELECT user_id FROM users WHERE cnic = $1",
      [cleanedCnic]
    );

    let ownerId;
    if (ownerResult.rows.length === 0) {
      const userId = "USR" + Math.floor(100000 + Math.random() * 900000);
      const bcrypt = await import('bcrypt');
      const defaultPassword = await bcrypt.hash("default123", 10);
      
      await pool.query(
        `INSERT INTO users (user_id, name, cnic, father_name, email, mobile, password, role, account_verified)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [userId, ownerName, cleanedCnic, fatherName, `${cleanedCnic}@temp.pk`, 
         `03001234567`, defaultPassword, 'CITIZEN', true]
      );
      ownerId = userId;
      console.log("✅ Created new owner:", ownerId);
    } else {
      ownerId = ownerResult.rows[0].user_id;
      console.log("✅ Found existing owner:", ownerId);
    }

    // Generate property ID
    const propertyId = await generatePropertyId();

    // Insert property with ALL required fields
    await pool.query(
      `INSERT INTO properties 
       (property_id, owner_id, owner_name, owner_cnic, father_name, 
        fard_no, khewat_no, khasra_no, khatooni_no, area_marla, 
        property_type, district, tehsil, mauza, address, 
        status, added_by_officer_id, year)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        propertyId,
        ownerId,
        ownerName,
        cleanedCnic,
        fatherName,
        khewatNo,
        khewatNo,
        khasraNo,
        khatooniNo,
        areaMarla,
        propertyType || 'residential',
        district,
        tehsil,
        mauza || null,
        address || null,
        'PENDING',
        req.user.userId,
        currentYear
      ]
    );

    console.log("✅ Property inserted into database with status PENDING");

    

    // Create audit log
    await pool.query(
      `INSERT INTO audit_logs (user_id, action_type, target_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user.userId,
        'PROPERTY_ADDED',
        propertyId,
        JSON.stringify({ propertyId, ownerName, status: 'PENDING' }),
        req.ip || 'unknown'
      ]
    );

    console.log("✅ Property added successfully:", propertyId);
    console.log("========================================\n");

    return res.json({
      success: true,
      message: "Property added successfully. Awaiting approval.",
      propertyId,
      status: 'PENDING'
    });

  } catch (err) {
    console.error("❌ Error adding property:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

// =====================================================
// GET USER PROPERTIES (Citizen - Only APPROVED)
// =====================================================
router.get("/my-properties", authenticateToken, async (req, res) => {
  try {
    console.log("📋 Fetching properties for user:", req.user.userId);

    const result = await pool.query(
      `SELECT 
        p.property_id, p.owner_name, p.owner_cnic, p.father_name, 
        p.fard_no, p.khewat_no, p.khasra_no, p.khatooni_no, p.area_marla, 
        p.property_type, p.district, p.tehsil, p.mauza, p.address,
        p.status, p.created_at, p.property_photo_path, p.year,
        COALESCE(p.is_for_sale, FALSE) AS is_for_sale,
        p.asking_price,
        p.listed_at,
        COALESCE(p.is_frozen, FALSE) AS is_frozen,
        FALSE AS has_co_owners,
        'SOLE' AS ownership_model,
        0 AS active_co_owner_count,
        NULL::TEXT AS co_owner_summary,
        NULL::TIMESTAMP AS last_co_ownership_sync_at,
        COALESCE(p.is_encumbered, FALSE) AS is_encumbered,
        COALESCE(p.active_encumbrance_count, 0) AS active_encumbrance_count,
        p.encumbrance_summary,
        p.last_encumbrance_recorded_at,
        p.last_encumbrance_released_at,
        p.freeze_reason_code, p.freeze_reason_label, p.freeze_reference_no,
        p.freeze_notes, p.freeze_authority_role, p.freeze_authority_user_id,
        p.freeze_started_at, p.freeze_released_at, p.freeze_released_by, p.freeze_release_notes,
        u.name as added_by_name
      FROM properties p
      LEFT JOIN users u ON p.added_by_officer_id = u.user_id
      WHERE p.owner_id = $1 AND p.status = 'APPROVED'
      ORDER BY p.created_at DESC`,
      [req.user.userId]
    );

    console.log("✅ Found", result.rows.length, "approved properties");

    const properties = result.rows.map((row) => attachPropertyRestrictions(row));

    return res.json({
      success: true,
      properties,
      total: properties.length
    });

  } catch (err) {
    console.error("❌ Get properties error:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Server error: " + err.message 
    });
  }
});

router.use(async (_req, _res, next) => {
  try {
    await propertyFreezeService.ensureSchema();
    await propertyEncumbranceService.ensureSchema();
    next();
  } catch (error) {
    next(error);
  }
});

router.get("/my-share-properties", authenticateToken, async (req, res) => {
  try {
    console.log("🧾 Fetching inherited share allocations for user:", req.user.userId);

    const result = await pool.query(
      `
        WITH citizen AS (
          SELECT user_id, cnic
          FROM users
          WHERE user_id = $1
          LIMIT 1
        )
        SELECT
          p.property_id,
          p.owner_id,
          p.owner_name,
          p.owner_cnic,
          p.father_name,
          p.fard_no,
          p.khewat_no,
          p.khasra_no,
          p.khatooni_no,
          p.area_marla,
          p.property_type,
          p.district,
          p.tehsil,
          p.mauza,
          p.address,
          p.status,
          p.created_at,
          p.property_photo_path,
          p.year,
          COALESCE(p.is_frozen, FALSE) AS is_frozen,
          FALSE AS has_co_owners,
          'SOLE' AS ownership_model,
          0 AS active_co_owner_count,
          NULL::TEXT AS co_owner_summary,
          NULL::TIMESTAMP AS last_co_ownership_sync_at,
          COALESCE(p.is_encumbered, FALSE) AS is_encumbered,
          COALESCE(p.active_encumbrance_count, 0) AS active_encumbrance_count,
          p.encumbrance_summary,
          p.last_encumbrance_recorded_at,
          p.last_encumbrance_released_at,
          p.freeze_reason_code,
          p.freeze_reason_label,
          p.freeze_reference_no,
          p.freeze_notes,
          p.freeze_authority_role,
          p.freeze_authority_user_id,
          p.freeze_started_at,
          p.freeze_released_at,
          p.freeze_released_by,
          p.freeze_release_notes,
          h.heir_id AS allocation_id,
          h.relation_type,
          h.share_percent,
          h.share_fraction_text,
          COALESCE(r.completed_at, r.dc_approved_at, h.created_at) AS granted_at,
          r.request_no,
          r.succession_request_id,
          h.linked_user_id,
          h.cnic AS allocation_cnic
        FROM succession_heirs h
        JOIN succession_requests r
          ON r.succession_request_id = h.succession_request_id
        JOIN properties p
          ON p.property_id = r.property_id
        JOIN citizen c
          ON TRUE
        WHERE p.status = 'APPROVED'
          AND COALESCE(r.dc_status, '') = 'APPROVED'
          AND COALESCE(r.status, '') IN ('COMPLETED', 'APPROVED')
          AND (
            h.linked_user_id::text = c.user_id
            OR (c.cnic IS NOT NULL AND h.cnic = c.cnic)
          )
        ORDER BY COALESCE(r.completed_at, r.updated_at, r.created_at) DESC, h.created_at DESC
      `,
      [req.user.userId]
    );

    const shares = result.rows.map((row) => {
        return {
          property_id: row.property_id,
          owner_id: row.owner_id,
          owner_name: row.owner_name,
          owner_cnic: row.owner_cnic,
          father_name: row.father_name,
          fard_no: row.fard_no,
          khewat_no: row.khewat_no,
          khasra_no: row.khasra_no,
          khatooni_no: row.khatooni_no,
          area_marla: row.area_marla,
          property_type: row.property_type,
          district: row.district,
          tehsil: row.tehsil,
          mauza: row.mauza,
          address: row.address,
          status: row.status,
          created_at: row.created_at,
          property_photo_path: row.property_photo_path,
          year: row.year,
          is_frozen: row.is_frozen,
          has_co_owners: false,
          ownership_model: "SOLE",
          active_co_owner_count: 0,
          co_owner_summary: null,
          last_co_ownership_sync_at: null,
          is_encumbered: row.is_encumbered,
          active_encumbrance_count: row.active_encumbrance_count,
          encumbrance_summary: row.encumbrance_summary,
          last_encumbrance_recorded_at: row.last_encumbrance_recorded_at,
          last_encumbrance_released_at: row.last_encumbrance_released_at,
          freeze_reason_code: row.freeze_reason_code,
          freeze_reason_label: row.freeze_reason_label,
          freeze_reference_no: row.freeze_reference_no,
          freeze_notes: row.freeze_notes,
          freeze_authority_role: row.freeze_authority_role,
          freeze_authority_user_id: row.freeze_authority_user_id,
          freeze_started_at: row.freeze_started_at,
          freeze_released_at: row.freeze_released_at,
          freeze_released_by: row.freeze_released_by,
          freeze_release_notes: row.freeze_release_notes,
          ...attachPropertyRestrictions(
            row
          ),
          viewer_share: {
            allocation_id: row.allocation_id,
            relation_type: row.relation_type,
            share_percent: row.share_percent,
            share_fraction_text: row.share_fraction_text,
            granted_at: row.granted_at,
            request_no: row.request_no,
            succession_request_id: row.succession_request_id,
            linked_user_id: row.linked_user_id,
            cnic: row.allocation_cnic,
          },
          shareAllocation: {
            allocation_id: row.allocation_id,
            relation_type: row.relation_type,
            share_percent: row.share_percent,
            share_fraction_text: row.share_fraction_text,
            granted_at: row.granted_at,
            request_no: row.request_no,
            succession_request_id: row.succession_request_id,
            linked_user_id: row.linked_user_id,
            cnic: row.allocation_cnic,
          },
        };
      });

    const linkedAllocations = shares.filter(
      (item) => item.viewer_share?.linked_user_id === req.user.userId
    ).length;

    return res.json({
      success: true,
      shares,
      claimSync: {
        linkedAllocations,
        matchedByCnic: shares.length - linkedAllocations,
      },
    });
  } catch (err) {
    console.error("❌ Get inherited share properties error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message,
    });
  }
});

// =====================================================
// GET PROPERTY DETAILS
// =====================================================
router.get("/property/:propertyId", authenticateToken, async (req, res) => {
  try {
    const { propertyId } = req.params;
    console.log("📄 Fetching property details for:", propertyId);

    const result = await pool.query(
      `SELECT 
        p.*, 
        u.name as owner_full_name,
        u.email as owner_email,
        u.mobile as owner_mobile,
        officer.name as officer_name,
        officer.user_id as officer_id
      FROM properties p
      LEFT JOIN users u ON p.owner_id = u.user_id
      LEFT JOIN users officer ON p.added_by_officer_id = officer.user_id
      WHERE p.property_id = $1`,
      [propertyId]
    );

    if (result.rows.length === 0) {
      console.log("❌ Property not found");
      return res.status(404).json({ 
        success: false, 
        message: "Property not found" 
      });
    }

    const property = result.rows[0];
    const userRole = req.user.role.toUpperCase();
    let viewerShare = null;
    const encumbranceState = await propertyEncumbranceService.getPropertyEncumbranceState(propertyId);
    
    if (userRole === 'CITIZEN' && property.owner_id !== req.user.userId) {
      viewerShare = await getViewerShareAllocation(propertyId, req.user.userId);

      if (!viewerShare) {
        console.log("❌ Access denied");
        return res.status(403).json({ 
          success: false, 
          message: "Access denied. You can only view your own or allocated properties." 
        });
      }
    }

    // Get blockchain history
    const blockchainHistory = await pool.query(
      `SELECT transaction_type, blockchain_hash, previous_hash, created_at, creator_user_id
       FROM blockchain_ledger
       WHERE property_id = $1
       ORDER BY created_at DESC`,
      [propertyId]
    );

    console.log("✅ Property details retrieved");

    return res.json({
      success: true,
      property: {
        ...attachPropertyRestrictions(
          result.rows[0],
          { encumbranceState }
        ),
        ...(viewerShare ? { viewer_share: viewerShare } : {}),
      },
      viewerShare,
      blockchainHistory: blockchainHistory.rows
    });

  } catch (err) {
    console.error("❌ Get property details error:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Server error: " + err.message 
    });
  }
});

// =====================================================
// GET OFFICER STATS
// =====================================================
router.get("/officer-stats", authenticateToken, async (req, res) => {
  try {
    console.log("📊 Fetching officer stats");

    const pendingReg = await pool.query(
      "SELECT COUNT(*) FROM properties WHERE status = 'PENDING'"
    );

    const pendingTransfer = await pool.query(
      "SELECT COUNT(*) FROM transfer_requests WHERE status = 'PAYMENT_PENDING' OR status = 'PAYMENT_UPLOADED'"
    );

    const frozen = await pool.query(
      "SELECT COUNT(*) FROM properties WHERE COALESCE(is_frozen, FALSE) = TRUE"
    );

    const encumbered = await pool.query(
      "SELECT COUNT(*) FROM properties WHERE COALESCE(is_encumbered, FALSE) = TRUE"
    );

    const approvedToday = await pool.query(
      "SELECT COUNT(*) FROM properties WHERE status = 'APPROVED' AND DATE(updated_at) = CURRENT_DATE"
    );

    return res.json({
      success: true,
      pendingRegistrations: parseInt(pendingReg.rows[0].count),
      pendingTransfers: parseInt(pendingTransfer.rows[0].count),
      frozenProperties: parseInt(frozen.rows[0].count),
      encumberedProperties: parseInt(encumbered.rows[0].count),
      approvedToday: parseInt(approvedToday.rows[0].count)
    });

  } catch (err) {
    console.error("❌ Get stats error:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Server error: " + err.message 
    });
  }
});

// =====================================================
// GET PENDING REGISTRATIONS (LRO)
// =====================================================
router.get("/pending-registrations", authenticateToken, async (req, res) => {
  try {
    console.log("\n========================================");
    console.log("📋 FETCHING PENDING REGISTRATIONS");
    console.log("========================================");
    console.log("User ID:", req.user.userId);
    console.log("User Role:", req.user.role);
    
    const userRole = req.user.role.toUpperCase();
    
    if (!['LRO', 'LAND RECORD OFFICER', 'TEHSILDAR', 'ADMIN'].includes(userRole)) {
      console.log("❌ Access denied - invalid role");
      return res.status(403).json({ 
        success: false, 
        message: "Access denied. Only officers can view pending registrations." 
      });
    }

    console.log("✅ Role check passed");

    const result = await pool.query(
      `SELECT 
        p.property_id, 
        p.owner_name, 
        p.owner_cnic, 
        p.father_name, 
        p.fard_no, 
        p.khewat_no, 
        p.khasra_no, 
        p.khatooni_no, 
        p.area_marla, 
        p.property_type, 
        p.district, 
        p.tehsil, 
        p.mauza, 
        p.address,
        p.status, 
        p.created_at, 
        p.year,
        u.name as owner_full_name, 
        u.email as owner_email, 
        u.mobile as owner_mobile,
        officer.name as added_by_officer_name
      FROM properties p
      LEFT JOIN users u ON p.owner_id = u.user_id
      LEFT JOIN users officer ON p.added_by_officer_id = officer.user_id
      WHERE p.status = 'PENDING'
      ORDER BY p.created_at DESC`
    );

    console.log("✅ Query executed successfully");
    console.log("Found", result.rows.length, "pending properties");
    
    if (result.rows.length > 0) {
      console.log("First property:", {
        id: result.rows[0].property_id,
        owner: result.rows[0].owner_name,
        status: result.rows[0].status
      });
    }
    
    console.log("========================================\n");

    return res.json({
      success: true,
      properties: result.rows,
      total: result.rows.length
    });
    
  } catch (err) {
    console.error("========================================");
    console.error("❌ GET PENDING REGISTRATIONS ERROR");
    console.error("========================================");
    console.error("Error:", err.message);
    console.error("Error code:", err.code);
    console.error("Position:", err.position);
    console.error("Hint:", err.hint);
    console.error("========================================\n");
    
    return res.status(500).json({ 
      success: false, 
      message: "Server error: " + err.message 
    });
  }
});

// GET ALL TEHSILDARS (for LRO dropdown)
router.get("/get-tehsildars", authenticateToken, async (req, res) => {
  try {
    console.log("\n========================================");
    console.log("📋 FETCHING TEHSILDARS FOR DROPDOWN");
    console.log("========================================");
    
    const userRole = req.user.role.toUpperCase();
    
    if (!['LRO', 'LAND RECORD OFFICER', 'ADMIN'].includes(userRole)) {
      return res.status(403).json({ 
        success: false, 
        message: "Access denied" 
      });
    }

    // More flexible query - get APPROVED and ACTIVE Tehsildars
    const result = await pool.query(
      `SELECT user_id, name, email, role, approval_status, is_active
       FROM users 
       WHERE UPPER(role) = 'TEHSILDAR' 
         AND approval_status = 'APPROVED'
         AND is_active = TRUE
       ORDER BY name ASC`
    );

    console.log("✅ Found", result.rows.length, "Tehsildars");
    
    if (result.rows.length > 0) {
      console.log("Available Tehsildars:");
      result.rows.forEach(t => {
        console.log(`  - ${t.name} (${t.user_id}) - ${t.district}/${t.tehsil}`);
      });
    } else {
      console.log("⚠️ No Tehsildars found!");
      console.log("Please ensure:");
      console.log("  1. Tehsildars are registered");
      console.log("  2. Admin has approved them");
      console.log("  3. approval_status = 'APPROVED'");
      console.log("  4. is_active = TRUE");
    }
    
    console.log("========================================\n");

    return res.json({
      success: true,
      tehsildars: result.rows,
      total: result.rows.length
    });

  } catch (err) {
    console.error("❌ Error fetching tehsildars:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Server error: " + err.message 
    });
  }
});


// =====================================================
// GET ALL ACs (for Tehsildar dropdown)
// GET ALL ACs (for Tehsildar dropdown)
router.get("/get-acs", authenticateToken, async (req, res) => {
  try {
    console.log("\n========================================");
    console.log("📋 FETCHING ACs FOR DROPDOWN");
    console.log("========================================");
    
    const userRole = req.user.role.toUpperCase();
    
    if (!['TEHSILDAR', 'ADMIN'].includes(userRole)) {
      return res.status(403).json({ 
        success: false, 
        message: "Access denied" 
      });
    }

    const result = await pool.query(
      `SELECT user_id, name, email, role, approval_status, is_active
       FROM users 
       WHERE UPPER(role) = 'AC'
         AND approval_status = 'APPROVED'
         AND is_active = TRUE
       ORDER BY name ASC`
    );

    console.log("✅ Found", result.rows.length, "ACs");
    
    if (result.rows.length > 0) {
      console.log("Available ACs:");
      result.rows.forEach(ac => {
        console.log(`  - ${ac.name} (${ac.user_id}) - ${ac.district}`);
      });
    } else {
      console.log("⚠️ No ACs found!");
    }
    
    console.log("========================================\n");

    return res.json({
      success: true,
      acs: result.rows,
      total: result.rows.length
    });

  } catch (err) {
    console.error("❌ Error fetching ACs:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Server error: " + err.message 
    });
  }
});

// =====================================================
// GET ALL DCs (for AC dropdown)
// GET ALL DCs (for AC dropdown)
router.get("/get-dcs", authenticateToken, async (req, res) => {
  try {
    console.log("\n========================================");
    console.log("📋 FETCHING DCs FOR DROPDOWN");
    console.log("========================================");
    
    const userRole = req.user.role.toUpperCase();
    
    if (!['LRO', 'LAND RECORD OFFICER', 'DC', 'ADMIN'].includes(userRole)) {
      return res.status(403).json({ 
        success: false, 
        message: "Access denied" 
      });
    }

    const result = await pool.query(
      `SELECT user_id, name, email, role, approval_status, is_active
       FROM users 
       WHERE UPPER(role) = 'DC'
         AND approval_status = 'APPROVED'
         AND is_active = TRUE
       ORDER BY name ASC`
    );

    console.log("✅ Found", result.rows.length, "DCs");
    
    if (result.rows.length > 0) {
      console.log("Available DCs:");
      result.rows.forEach(dc => {
        console.log(`  - ${dc.name} (${dc.user_id}) - ${dc.district}`);
      });
    } else {
      console.log("⚠️ No DCs found!");
    }
    
    console.log("========================================\n");

    return res.json({
      success: true,
      dcs: result.rows,
      total: result.rows.length
    });

  } catch (err) {
    console.error("❌ Error fetching DCs:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Server error: " + err.message 
    });
  }
});
// =====================================================
// GET FATHER NAME BY CNIC (Auto-fill functionality)
// =====================================================
router.get("/get-father-name/:cnic", authenticateToken, async (req, res) => {
  try {
    const cnic = req.params.cnic.replace(/\D/g, '');
    
    if (cnic.length !== 13) {
      return res.status(400).json({ 
        success: false, 
        message: "Invalid CNIC format" 
      });
    }

    const result = await pool.query(
      `SELECT father_name, father_cnic FROM users WHERE cnic = $1`,
      [cnic]
    );

    if (result.rows.length > 0 && result.rows[0].father_name) {
      return res.json({
        success: true,
        fatherName: result.rows[0].father_name,
        fatherCnic: result.rows[0].father_cnic
      });
    }

    return res.json({
      success: false,
      message: "No record found for this CNIC"
    });

  } catch (err) {
    console.error("❌ Error fetching father name:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Server error: " + err.message 
    });
  }
});

// =====================================================
// LRO APPROVE & FORWARD TO DC
// =====================================================
router.post("/approve-and-forward", authenticateToken, async (req, res) => {
  try {
    const { propertyId, assignedDcId, assignedTehsildarId } = req.body;
    const userRole = req.user.role.toUpperCase();
    
    if (!['LRO', 'LAND RECORD OFFICER', 'ADMIN'].includes(userRole)) {
      return res.status(403).json({ 
        success: false, 
        message: "Access denied" 
      });
    }

    const targetDcId = assignedDcId || assignedTehsildarId;

    if (!propertyId || !targetDcId) {
      return res.status(400).json({
        success: false,
        message: "Property ID and DC selection required"
      });
    }

    // Verify DC exists
    const dcCheck = await pool.query(
      "SELECT user_id, name FROM users WHERE user_id = $1 AND UPPER(role) = 'DC'",
      [targetDcId]
    );

    if (dcCheck.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid DC selected"
      });
    }

    // Check property exists and is pending
    const propertyCheck = await pool.query(
      "SELECT * FROM properties WHERE property_id = $1 AND status IN ('PENDING', 'PENDING_APPROVAL')",
      [propertyId]
    );

    if (propertyCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Property not found or not in pending status"
      });
    }

    // Update property status
    await pool.query(
      `UPDATE properties 
       SET status = 'PENDING_DC',
           assigned_dc_id = $1,
           current_approver_role = 'DC',
           updated_at = NOW()
       WHERE property_id = $2`,
      [targetDcId, propertyId]
    );

    // Create approval chain record
    try {
      await pool.query(
        `INSERT INTO approval_chain 
         (property_id, approver_user_id, approver_role, action, assigned_to_user_id, assigned_to_role)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [propertyId, req.user.userId, 'LRO', 'APPROVED_AND_FORWARDED', targetDcId, 'DC']
      );
    } catch (e) {
      console.log("⚠️ approval_chain table may not exist yet");
    }

    // Create audit log
    await pool.query(
      `INSERT INTO audit_logs (user_id, action_type, target_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user.userId,
        'PROPERTY_APPROVED_AND_FORWARDED',
        propertyId,
        JSON.stringify({ propertyId, assignedDc: dcCheck.rows[0].name }),
        req.ip || 'unknown'
      ]
    );

    console.log("✅ Property approved and forwarded to DC");

    return res.json({
      success: true,
      message: "Property approved and forwarded to DC",
      propertyId,
      assignedTo: dcCheck.rows[0].name,
      status: 'PENDING_DC'
    });

  } catch (err) {
    console.error("❌ Error approving property:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

// =====================================================
// GET PROPERTIES PENDING FOR TEHSILDAR
// =====================================================
router.get("/tehsildar-pending", authenticateToken, async (req, res) => {
  try {
    const userRole = req.user.role.toUpperCase();
    
    if (userRole !== 'TEHSILDAR') {
      return res.status(403).json({ 
        success: false, 
        message: "Access denied. Tehsildar only." 
      });
    }

    const result = await pool.query(
      `SELECT p.*, u.name as owner_name, u.cnic as owner_cnic, u.father_name,
              lro.name as added_by_officer_name
       FROM properties p
       LEFT JOIN users u ON p.owner_id = u.user_id
       LEFT JOIN users lro ON p.added_by_officer_id = lro.user_id
       WHERE p.assigned_tehsildar_id = $1 AND p.status = 'PENDING_TEHSILDAR'
       ORDER BY p.created_at DESC`,
      [req.user.userId]
    );

    return res.json({
      success: true,
      properties: result.rows,
      total: result.rows.length
    });

  } catch (err) {
    console.error("❌ Error fetching Tehsildar pending:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

// =====================================================
// TEHSILDAR FORWARD TO AC
// =====================================================
router.post("/tehsildar-forward-to-ac", authenticateToken, async (req, res) => {
  try {
    const { propertyId, assignedAcId, comments } = req.body;
    const userRole = req.user.role.toUpperCase();
    
    if (userRole !== 'TEHSILDAR') {
      return res.status(403).json({ 
        success: false, 
        message: "Access denied" 
      });
    }

    if (!propertyId || !assignedAcId) {
      return res.status(400).json({
        success: false,
        message: "Property ID and AC selection required"
      });
    }

    // Verify AC exists
    const acCheck = await pool.query(
      "SELECT user_id, name FROM users WHERE user_id = $1 AND UPPER(role) = 'AC'",
      [assignedAcId]
    );

    if (acCheck.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid AC selected"
      });
    }

    // Check property is assigned to this Tehsildar
    const propertyCheck = await pool.query(
      "SELECT * FROM properties WHERE property_id = $1 AND assigned_tehsildar_id = $2 AND status = 'PENDING_TEHSILDAR'",
      [propertyId, req.user.userId]
    );

    if (propertyCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Property not found or not assigned to you"
      });
    }

    // Update property
    await pool.query(
      `UPDATE properties 
       SET status = 'PENDING_AC', 
           assigned_ac_id = $1,
           current_approver_role = 'AC',
           updated_at = NOW()
       WHERE property_id = $2`,
      [assignedAcId, propertyId]
    );

    // Create approval chain record
    await pool.query(
      `INSERT INTO approval_chain 
       (property_id, approver_user_id, approver_role, action, comments, assigned_to_user_id, assigned_to_role)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [propertyId, req.user.userId, 'TEHSILDAR', 'FORWARDED', comments, assignedAcId, 'AC']
    );

    // Create audit log
    await pool.query(
      `INSERT INTO audit_logs (user_id, action_type, target_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user.userId,
        'PROPERTY_FORWARDED_TO_AC',
        propertyId,
        JSON.stringify({ propertyId, assignedAc: acCheck.rows[0].name, comments }),
        req.ip || 'unknown'
      ]
    );

    console.log("✅ Tehsildar forwarded property to AC");

    return res.json({
      success: true,
      message: "Property forwarded to AC for approval",
      assignedTo: acCheck.rows[0].name
    });

  } catch (err) {
    console.error("❌ Error forwarding to AC:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

// =====================================================
// GET PROPERTIES PENDING FOR AC
// =====================================================
router.get("/ac-pending", authenticateToken, async (req, res) => {
  try {
    const userRole = req.user.role.toUpperCase();
    
    if (userRole !== 'AC') {
      return res.status(403).json({ 
        success: false, 
        message: "Access denied. AC only." 
      });
    }

    const result = await pool.query(
      `SELECT 
        p.*,
        u.name as owner_name, 
        u.cnic as owner_cnic, 
        u.father_name,
        tehsildar.name as tehsildar_name,
        lro.name as added_by_officer_name
       FROM properties p
       LEFT JOIN users u ON p.owner_id = u.user_id
       LEFT JOIN users tehsildar ON p.assigned_tehsildar_id = tehsildar.user_id
       LEFT JOIN users lro ON p.added_by_officer_id = lro.user_id
       WHERE p.assigned_ac_id = $1 AND p.status = 'PENDING_AC'
       ORDER BY p.created_at DESC`,
      [req.user.userId]
    );

    return res.json({
      success: true,
      properties: result.rows,
      total: result.rows.length
    });

  } catch (err) {
    console.error("❌ Error fetching AC pending:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

// =====================================================
// AC FORWARD TO DC
// =====================================================
router.post("/ac-forward-to-dc", authenticateToken, async (req, res) => {
  try {
    const { propertyId, assignedDcId, comments } = req.body;
    const userRole = req.user.role.toUpperCase();
    
    if (userRole !== 'AC') {
      return res.status(403).json({ 
        success: false, 
        message: "Access denied" 
      });
    }

    if (!propertyId || !assignedDcId) {
      return res.status(400).json({
        success: false,
        message: "Property ID and DC selection required"
      });
    }

    // Verify DC exists
    const dcCheck = await pool.query(
      "SELECT user_id, name FROM users WHERE user_id = $1 AND UPPER(role) = 'DC'",
      [assignedDcId]
    );

    if (dcCheck.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid DC selected"
      });
    }

    // Update property
    await pool.query(
      `UPDATE properties 
       SET status = 'PENDING_DC', 
           assigned_dc_id = $1,
           current_approver_role = 'DC',
           updated_at = NOW()
       WHERE property_id = $2 AND assigned_ac_id = $3`,
      [assignedDcId, propertyId, req.user.userId]
    );

    // Create approval chain record
    await pool.query(
      `INSERT INTO approval_chain 
       (property_id, approver_user_id, approver_role, action, comments, assigned_to_user_id, assigned_to_role)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [propertyId, req.user.userId, 'AC', 'FORWARDED', comments, assignedDcId, 'DC']
    );

    // Create audit log
    await pool.query(
      `INSERT INTO audit_logs (user_id, action_type, target_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user.userId,
        'PROPERTY_FORWARDED_TO_DC',
        propertyId,
        JSON.stringify({ propertyId, assignedDc: dcCheck.rows[0].name, comments }),
        req.ip || 'unknown'
      ]
    );

    return res.json({
      success: true,
      message: "Property forwarded to DC for final approval",
      assignedTo: dcCheck.rows[0].name
    });

  } catch (err) {
    console.error("❌ Error forwarding to DC:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

// =====================================================
// GET PROPERTIES PENDING FOR DC
// =====================================================
router.get("/dc-pending", authenticateToken, async (req, res) => {
  try {
    const userRole = req.user.role.toUpperCase();
    
    if (userRole !== 'DC') {
      return res.status(403).json({ 
        success: false, 
        message: "Access denied. DC only." 
      });
    }

    const result = await pool.query(
      `SELECT 
        p.*,
        u.name as owner_name, 
        u.cnic as owner_cnic, 
        u.father_name,
        ac.name as ac_name, 
        tehsildar.name as tehsildar_name,
        lro.name as added_by_officer_name
       FROM properties p
       LEFT JOIN users u ON p.owner_id = u.user_id
       LEFT JOIN users ac ON p.assigned_ac_id = ac.user_id
       LEFT JOIN users tehsildar ON p.assigned_tehsildar_id = tehsildar.user_id
       LEFT JOIN users lro ON p.added_by_officer_id = lro.user_id
       WHERE p.assigned_dc_id = $1 AND p.status = 'PENDING_DC'
       ORDER BY p.created_at DESC`,
      [req.user.userId]
    );

    return res.json({
      success: true,
      properties: result.rows,
      total: result.rows.length
    });

  } catch (err) {
    console.error("❌ Error fetching DC pending:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

// =====================================================
// DC FINAL APPROVAL
// =====================================================
// =====================================================
// DC APPROVAL ENDPOINT - WITH BLOCKCHAIN REQUIREMENT
// Location: backend/src/routes/property.js (REPLACE dc-approve endpoint)
// =====================================================

// =====================================================
// DC APPROVAL ENDPOINT - CORRECTED VERSION
// Location: backend/src/routes/property.js
// REPLACE the existing /dc-approve endpoint with this
// =====================================================

router.post("/dc-approve", authenticateToken, async (req, res) => {
  // Start a database transaction
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { propertyId, comments } = req.body;
    const userRole = req.user.role.toUpperCase();
    
    if (userRole !== 'DC') {
      await client.query('ROLLBACK');
      return res.status(403).json({ 
        success: false, 
        message: "Access denied. Only DC can approve." 
      });
    }

    if (!propertyId) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: "Property ID required"
      });
    }

    console.log("\n" + "=".repeat(60));
    console.log("✅ DC FINAL APPROVAL - AUTO MINING INITIATED");
    console.log("=".repeat(60));
    console.log("Property ID:", propertyId);
    console.log("Approved by:", req.user.userId);

    // ✅ CORRECTED QUERY - Uses owner_id instead of user_id
    const propertyDataResult = await client.query(
      `SELECT 
        p.*,
        p.owner_name,
        p.owner_cnic
       FROM properties p
       WHERE p.property_id = $1 AND p.assigned_dc_id = $2`,
      [propertyId, req.user.userId]
    );

    if (propertyDataResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: "Property not found or not assigned to you"
      });
    }

    const property = propertyDataResult.rows[0];

    // Check if already mined
    const existingBlock = await client.query(
      "SELECT * FROM blockchain_ledger WHERE property_id = $1",
      [propertyId]
    );

    if (existingBlock.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.json({
        success: false,
        message: "Property already exists on blockchain",
        blockHash: existingBlock.rows[0].blockchain_hash
      });
    }

    // ✅ STEP 1: MINE TO BLOCKCHAIN FIRST (Proof of Authority)
    console.log("⛏️  Mining property to blockchain using Proof of Authority...");
    
    let newBlock;
    try {
      newBlock = await blockchainService.mineBlock(property, req.user.userId);
      
      console.log("✅ Property mined to blockchain successfully!");
      console.log("   Block Index:", newBlock.block_index);
      console.log("   Block Hash:", newBlock.blockchain_hash.substring(0, 20) + "...");
      console.log("   Nonce:", newBlock.nonce);
      console.log("   Validator:", req.user.userId, "(DC - Authority)");
      
    } catch (blockchainError) {
      await client.query('ROLLBACK');
      console.error("❌ Blockchain mining failed:", blockchainError.message);
      console.log("=".repeat(60));
      console.log("❌ APPROVAL ABORTED - BLOCKCHAIN MINING FAILED");
      console.log("=".repeat(60) + "\n");
      
      // Log the failure
      await pool.query(
        `INSERT INTO audit_logs (user_id, action_type, target_id, details, ip_address)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          req.user.userId,
          'BLOCKCHAIN_MINING_FAILED',
          propertyId,
          JSON.stringify({ 
            error: blockchainError.message,
            reason: 'Property NOT approved due to blockchain failure'
          }),
          req.ip || 'unknown'
        ]
      );
      
      return res.status(500).json({
        success: false,
        message: "❌ Property approval failed. Blockchain mining error: " + blockchainError.message,
        error: "BLOCKCHAIN_MINING_FAILED",
        details: "Property cannot be approved without successful blockchain registration."
      });
    }

    // ✅ STEP 2: UPDATE PROPERTY STATUS (Only after successful mining)
    await client.query(
      `UPDATE properties 
       SET status = 'APPROVED', 
           current_approver_role = NULL,
           updated_at = NOW()
       WHERE property_id = $1`,
      [propertyId]
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
      remarks: `Property registration approved by ${req.user.userId}${comments ? `: ${comments}` : ""}`,
      createdAt: new Date(),
    });

    // ✅ STEP 3: CREATE APPROVAL CHAIN RECORD
    await client.query(
      `INSERT INTO approval_chain 
       (property_id, approver_user_id, approver_role, action, comments)
       VALUES ($1, $2, $3, $4, $5)`,
      [propertyId, req.user.userId, 'DC', 'APPROVED', comments]
    );

    // ✅ STEP 4: CREATE AUDIT LOG
    await client.query(
      `INSERT INTO audit_logs (user_id, action_type, target_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user.userId,
        'PROPERTY_APPROVED_BY_DC',
        propertyId,
        JSON.stringify({ 
          propertyId, 
          comments,
          blockchainMined: true,
          blockHash: newBlock.blockchain_hash,
          blockIndex: newBlock.block_index,
          consensusMechanism: "Proof of Authority (PoA)"
        }),
        req.ip || 'unknown'
      ]
    );

    // Commit transaction
    await client.query('COMMIT');

    console.log("=".repeat(60));
    console.log("✅ APPROVAL SUCCESSFUL - PROPERTY REGISTERED ON BLOCKCHAIN");
    console.log("=".repeat(60) + "\n");

    // Return success with blockchain info
    return res.json({
      success: true,
      message: "✅ Property approved and successfully mined to blockchain!",
      propertyId,
      status: 'APPROVED',
      blockchain: {
        blockIndex: newBlock.block_index,
        blockHash: newBlock.blockchain_hash,
        previousHash: newBlock.previous_hash,
        nonce: newBlock.nonce,
        minedAt: newBlock.mined_at,
        minedBy: req.user.userId,
        validatorRole: 'DC'
      },
      consensusMechanism: "Proof of Authority (PoA)",
      validator: {
        userId: req.user.userId,
        role: 'DC',
        approvedAt: new Date().toISOString()
      }
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error("❌ Error approving property:", err);
    console.log("=".repeat(60));
    console.log("❌ APPROVAL FAILED - TRANSACTION ROLLED BACK");
    console.log("=".repeat(60) + "\n");
    
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  } finally {
    client.release();
  }
});

// =====================================================
// REJECT PROPERTY (Any approver in chain)
// =====================================================
router.post("/reject-property", authenticateToken, async (req, res) => {
  try {
    const { propertyId, reason } = req.body;
    const userRole = req.user.role.toUpperCase();
    
    if (!['LRO', 'LAND RECORD OFFICER', 'TEHSILDAR', 'AC', 'DC', 'ADMIN'].includes(userRole)) {
      return res.status(403).json({ 
        success: false, 
        message: "Access denied" 
      });
    }

    if (!propertyId || !reason) {
      return res.status(400).json({
        success: false,
        message: "Property ID and rejection reason required"
      });
    }

    // Update property to REJECTED
    await pool.query(
      `UPDATE properties 
       SET status = 'REJECTED', 
           rejection_reason = $1,
           current_approver_role = NULL,
           updated_at = NOW()
       WHERE property_id = $2`,
      [reason, propertyId]
    );

    // Create approval chain record
    await pool.query(
      `INSERT INTO approval_chain 
       (property_id, approver_user_id, approver_role, action, comments)
       VALUES ($1, $2, $3, $4, $5)`,
      [propertyId, req.user.userId, userRole, 'REJECTED', reason]
    );

    // Create audit log
    await pool.query(
      `INSERT INTO audit_logs (user_id, action_type, target_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user.userId,
        'PROPERTY_REJECTED',
        propertyId,
        JSON.stringify({ propertyId, reason, rejectedBy: userRole }),
        req.ip || 'unknown'
      ]
    );

    return res.json({
      success: true,
      message: "Property rejected successfully",
      propertyId,
      status: 'REJECTED'
    });

  } catch (err) {
    console.error("❌ Error rejecting property:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

router.post("/reject-in-chain", authenticateToken, async (req, res) => {
  try {
    const { propertyId, reason } = req.body;
    const userRole = req.user.role.toUpperCase();
    
    if (!['TEHSILDAR', 'AC', 'DC'].includes(userRole)) {
      return res.status(403).json({ 
        success: false, 
        message: "Access denied" 
      });
    }

    if (!propertyId || !reason) {
      return res.status(400).json({
        success: false,
        message: "Property ID and rejection reason required"
      });
    }

    await pool.query(
      `UPDATE properties 
       SET status = 'REJECTED', 
           rejection_reason = $1,
           current_approver_role = NULL,
           updated_at = NOW()
       WHERE property_id = $2`,
      [reason, propertyId]
    );

    await pool.query(
      `INSERT INTO approval_chain 
       (property_id, approver_user_id, approver_role, action, comments)
       VALUES ($1, $2, $3, $4, $5)`,
      [propertyId, req.user.userId, userRole, 'REJECTED', reason]
    );

    await pool.query(
      `INSERT INTO audit_logs (user_id, action_type, target_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user.userId,
        'PROPERTY_REJECTED',
        propertyId,
        JSON.stringify({ propertyId, reason, rejectedBy: userRole }),
        req.ip || 'unknown'
      ]
    );

    return res.json({
      success: true,
      message: "Property rejected successfully",
      propertyId,
      status: 'REJECTED'
    });

  } catch (err) {
    console.error("❌ Error rejecting property:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

// =====================================================
// GET PROPERTY HISTORY
// =====================================================
router.get("/history/:propertyId", authenticateToken, async (req, res) => {
  try {
    const { propertyId } = req.params;
    
    console.log("📜 Fetching ownership history for:", propertyId);

    const canViewHistory = await ownershipHistoryService.canUserViewPropertyHistory(
      pool,
      req.user,
      propertyId
    );

    if (!canViewHistory) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to view this ownership history"
      });
    }

    const latestHistory = await ownershipHistoryService.listPropertyOwnershipHistory(pool, propertyId);
    console.log("Ownership history records found:", latestHistory.length);

    return res.json({
      success: true,
      history: latestHistory,
      total: latestHistory.length
    });

    let history = [];
    
    try {
      const historyResult = await pool.query(
        `SELECT 
          oh.*,
          prev.name as previous_owner_name,
          prev.cnic as previous_owner_cnic,
          new_user.name as new_owner_name,
          new_user.cnic as new_owner_cnic
         FROM ownership_history oh
         LEFT JOIN users prev ON oh.previous_owner_id = prev.user_id
         LEFT JOIN users new_user ON oh.new_owner_id = new_user.user_id
         WHERE oh.property_id = $1
         ORDER BY oh.transfer_date DESC`,
        [propertyId]
      );

      history = historyResult.rows;
      console.log("✅ Found", history.length, "history records");

    } catch (tableErr) {
      console.log("⚠️ ownership_history table might not exist, trying transfer_requests...");
      
      const transferResult = await pool.query(
        `SELECT 
          t.transfer_id,
          t.property_id,
          t.seller_id as previous_owner_id,
          t.buyer_cnic as new_owner_cnic,
          seller.name as previous_owner_name,
          seller.cnic as previous_owner_cnic,
          t.buyer_name as new_owner_name,
          t.transfer_amount,
          t.completed_at as transfer_date,
          'SALE' as transfer_type
         FROM transfer_requests t
         LEFT JOIN users seller ON t.seller_id = seller.user_id
         WHERE t.property_id = $1 
         AND t.status = 'COMPLETED'
         ORDER BY t.completed_at DESC`,
        [propertyId]
      );

      history = transferResult.rows;
      console.log("✅ Found", history.length, "transfer records");
    }

    return res.json({
      success: true,
      history: history,
      total: history.length
    });

  } catch (err) {
    console.error("❌ Get property history error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

// =====================================================
// ADMIN: GET ALL PROPERTIES (Including Blockchain Status)
// Add this route to property.js for admin dashboard
// =====================================================

router.get("/admin/all-properties", authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: "Access denied. Admin only."
      });
    }

    const result = await pool.query(`
      SELECT 
        p.*,
        bl.block_index,
        bl.blockchain_hash,
        bl.nonce,
        bl.mined_at,
        bl.mined_by,
        miner.name as miner_name,
        CASE 
          WHEN bl.blockchain_hash IS NOT NULL THEN true
          ELSE false
        END as is_mined
      FROM properties p
      LEFT JOIN blockchain_ledger bl ON p.property_id = bl.property_id
      LEFT JOIN users miner ON bl.mined_by = miner.user_id
      ORDER BY 
        CASE 
          WHEN p.status = 'APPROVED' AND bl.blockchain_hash IS NOT NULL THEN 1
          WHEN p.status = 'APPROVED' THEN 2
          WHEN p.status = 'PENDING' THEN 3
          ELSE 4
        END,
        p.created_at DESC
    `);

    return res.json({
      success: true,
      totalProperties: result.rows.length,
      minedProperties: result.rows.filter(p => p.is_mined).length,
      properties: result.rows
    });

  } catch (err) {
    console.error("❌ Get all properties error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

// =====================================================
// ADMIN: GET PROPERTY STATS (Including Blockchain)
// =====================================================

router.get("/admin/property-stats", authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: "Access denied. Admin only."
      });
    }

    const pendingCount = await pool.query(
      "SELECT COUNT(*) as count FROM properties WHERE status = 'PENDING'"
    );

    const approvedCount = await pool.query(
      "SELECT COUNT(*) as count FROM properties WHERE status = 'APPROVED'"
    );

    const rejectedCount = await pool.query(
      "SELECT COUNT(*) as count FROM properties WHERE status = 'REJECTED'"
    );

    const frozenCount = await pool.query(
      "SELECT COUNT(*) as count FROM properties WHERE COALESCE(is_frozen, FALSE) = TRUE"
    );

    const encumberedCount = await pool.query(
      "SELECT COUNT(*) as count FROM properties WHERE COALESCE(is_encumbered, FALSE) = TRUE"
    );

    const jointOwnershipCount = await pool.query(`
      WITH latest_succession AS (
        SELECT DISTINCT ON (property_id)
          property_id,
          succession_request_id
        FROM succession_requests
        WHERE COALESCE(dc_status, '') = 'APPROVED'
          AND COALESCE(status, '') IN ('COMPLETED', 'APPROVED')
        ORDER BY property_id, COALESCE(completed_at, dc_approved_at, updated_at, created_at) DESC
      )
      SELECT COUNT(DISTINCT ls.property_id) AS count
      FROM latest_succession ls
      JOIN succession_heirs h
        ON h.succession_request_id = ls.succession_request_id
    `);

    const minedCount = await pool.query(
      "SELECT COUNT(*) as count FROM blockchain_ledger"
    );

    const unminedApproved = await pool.query(`
      SELECT COUNT(*) as count 
      FROM properties p
      LEFT JOIN blockchain_ledger bl ON p.property_id = bl.property_id
      WHERE p.status = 'APPROVED' AND bl.blockchain_hash IS NULL
    `);

    return res.json({
      success: true,
      stats: {
        pending: parseInt(pendingCount.rows[0].count),
        approved: parseInt(approvedCount.rows[0].count),
        rejected: parseInt(rejectedCount.rows[0].count),
        frozen: parseInt(frozenCount.rows[0].count),
        encumbered: parseInt(encumberedCount.rows[0].count),
        jointOwnership: parseInt(jointOwnershipCount.rows[0].count),
        minedToBlockchain: parseInt(minedCount.rows[0].count),
        approvedButUnmined: parseInt(unminedApproved.rows[0].count)
      }
    });

  } catch (err) {
    console.error("❌ Get stats error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

router.get("/freeze-cases", authenticateToken, requirePropertyRestrictionAuthority, async (req, res) => {
  try {
    const includeReleased = String(req.query.includeReleased || "").toLowerCase() === "true";
    const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 100);
    const cases = await propertyFreezeService.listFreezeCases({ includeReleased, limit });

    return res.json({
      success: true,
      cases,
      summary: {
        active: cases.filter((item) => item.is_frozen).length,
        released: cases.filter((item) => !item.is_frozen).length,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message,
    });
  }
});

router.post("/freeze", authenticateToken, requirePropertyRestrictionAuthority, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const propertyId = String(req.body.propertyId || "").trim();
    const reasonCode = req.body.reasonCode;
    const notes = String(req.body.notes || "");
    const referenceNo = String(req.body.referenceNo || "");

    if (!propertyId) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "Property ID is required" });
    }

    const result = await propertyFreezeService.freezeProperty(
      {
        propertyId,
        actorUserId: req.user.userId,
        actorRole: req.user.role,
        reasonCode,
        notes,
        referenceNo,
        ipAddress: req.ip || null,
        routePath: req.originalUrl,
        httpMethod: req.method,
      },
      client
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: result.changed
        ? `Property ${propertyId} is now under dispute hold`
        : `Property ${propertyId} is already under dispute hold`,
      property: result.property,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(400).json({
      success: false,
      message: err.message,
    });
  } finally {
    client.release();
  }
});

router.post("/freeze/:propertyId/release", authenticateToken, requirePropertyRestrictionAuthority, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await propertyFreezeService.releaseFreeze(
      {
        propertyId: req.params.propertyId,
        actorUserId: req.user.userId,
        actorRole: req.user.role,
        releaseNotes: String(req.body.notes || ""),
        ipAddress: req.ip || null,
        routePath: req.originalUrl,
        httpMethod: req.method,
      },
      client
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: result.changed
        ? `Dispute hold released for ${req.params.propertyId}`
        : `${req.params.propertyId} was not under dispute hold`,
      property: result.property,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(400).json({
      success: false,
      message: err.message,
    });
  } finally {
    client.release();
  }
});

router.get("/encumbrances", authenticateToken, requirePropertyRestrictionAuthority, async (req, res) => {
  try {
    const includeReleased = String(req.query.includeReleased || "").toLowerCase() === "true";
    const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 100);
    const cases = await propertyEncumbranceService.listEncumbrances({ includeReleased, limit });

    return res.json({
      success: true,
      cases,
      summary: {
        active: cases.filter((item) => item.active).length,
        released: cases.filter((item) => !item.active).length,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message,
    });
  }
});

router.get("/co-ownerships", authenticateToken, requirePropertyRestrictionAuthority, async (req, res) => {
  return res.status(410).json({
    success: false,
    message: "Joint ownership has been disabled in this build.",
  });
});

router.get("/my-co-owner-consents", authenticateToken, async (req, res) => {
  return res.status(410).json({
    success: false,
    message: "Joint ownership consent workflow has been disabled in this build.",
  });
});

router.get("/co-owner-consents", authenticateToken, requirePropertyRestrictionAuthority, async (req, res) => {
  return res.status(410).json({
    success: false,
    message: "Joint ownership consent workflow has been disabled in this build.",
  });
});

router.post("/co-owner-consents/request", authenticateToken, async (req, res) => {
  return res.status(410).json({
    success: false,
    message: "Joint ownership consent workflow has been disabled in this build.",
  });
});

router.post("/co-owner-consents/:consentId/respond", authenticateToken, async (req, res) => {
  return res.status(410).json({
    success: false,
    message: "Joint ownership consent workflow has been disabled in this build.",
  });
});

router.post("/encumbrances", authenticateToken, requirePropertyRestrictionAuthority, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const propertyId = String(req.body.propertyId || "").trim();
    const typeCode = req.body.typeCode;
    const holderName = String(req.body.holderName || "");
    const referenceNo = String(req.body.referenceNo || "");
    const notes = String(req.body.notes || "");
    const amountSecured = req.body.amountSecured;

    if (!propertyId) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "Property ID is required" });
    }

    const result = await propertyEncumbranceService.createEncumbrance(
      {
        propertyId,
        actorUserId: req.user.userId,
        actorRole: req.user.role,
        typeCode,
        holderName,
        referenceNo,
        notes,
        amountSecured,
        ipAddress: req.ip || null,
        routePath: req.originalUrl,
        httpMethod: req.method,
      },
      client
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: `Encumbrance recorded for ${propertyId}`,
      encumbrance: result.encumbrance,
      property: result.property,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(400).json({
      success: false,
      message: err.message,
    });
  } finally {
    client.release();
  }
});

router.post(
  "/encumbrances/:encumbranceId/release",
  authenticateToken,
  requirePropertyRestrictionAuthority,
  async (req, res) => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await propertyEncumbranceService.releaseEncumbrance(
        {
          encumbranceId: req.params.encumbranceId,
          actorUserId: req.user.userId,
          actorRole: req.user.role,
          releaseNotes: String(req.body.notes || ""),
          ipAddress: req.ip || null,
          routePath: req.originalUrl,
          httpMethod: req.method,
        },
        client
      );

      await client.query("COMMIT");

      return res.json({
        success: true,
        message: result.changed
          ? `Encumbrance released for ${result.encumbrance?.encumbranceId || req.params.encumbranceId}`
          : "Encumbrance was already released",
        encumbrance: result.encumbrance,
        property: result.property,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: err.message,
      });
    } finally {
      client.release();
    }
  }
);

// =====================================================
// ADMIN: GET PENDING PROPERTIES
// =====================================================

router.get("/admin/pending-properties", authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: "Access denied. Admin only."
      });
    }

    const result = await pool.query(`
      SELECT 
        p.*,
        officer.name as added_by_officer_name
      FROM properties p
      LEFT JOIN users officer ON p.added_by_officer_id = officer.user_id
      WHERE p.status = 'PENDING'
      ORDER BY p.created_at DESC
    `);

    return res.json({
      success: true,
      totalPending: result.rows.length,
      properties: result.rows
    });

  } catch (err) {
    console.error("❌ Get pending properties error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

// =====================================================
// ADMIN: APPROVE PROPERTY
// =====================================================

router.post("/admin/approve-property", authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: "Access denied. Admin only."
      });
    }

    const { propertyId } = req.body;
    const propertyResult = await pool.query(
      `SELECT property_id, owner_id, owner_name, owner_cnic, father_name
         FROM properties
        WHERE property_id = $1
        LIMIT 1`,
      [propertyId]
    );

    const property = propertyResult.rows[0];

    if (!property) {
      return res.status(404).json({
        success: false,
        message: "Property not found."
      });
    }

    await pool.query(
      `UPDATE properties 
       SET status = 'APPROVED', 
           updated_at = NOW()
       WHERE property_id = $1`,
      [propertyId]
    );

    await ownershipHistoryService.recordOwnershipEvent(pool, {
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
      remarks: `Property registration approved by admin ${req.user.userId}`,
      createdAt: new Date(),
    });

    return res.json({
      success: true,
      message: "Property approved successfully"
    });

  } catch (err) {
    console.error("❌ Approve property error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

// =====================================================
// ADMIN: REJECT PROPERTY
// =====================================================

router.post("/admin/reject-property", authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: "Access denied. Admin only."
      });
    }

    const { propertyId, reason } = req.body;

    await pool.query(
      `UPDATE properties 
       SET status = 'REJECTED',
           rejection_reason = $1,
           updated_at = NOW()
       WHERE property_id = $2`,
      [reason, propertyId]
    );

    return res.json({
      success: true,
      message: "Property rejected successfully"
    });

  } catch (err) {
    console.error("❌ Reject property error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

router.post("/dc-approve", authenticateToken, async (req, res) => {
  try {
    const { propertyId, comments } = req.body;
    const userRole = req.user.role.toUpperCase();
    
    if (userRole !== 'DC') {
      return res.status(403).json({ 
        success: false, 
        message: "Access denied" 
      });
    }

    if (!propertyId) {
      return res.status(400).json({
        success: false,
        message: "Property ID required"
      });
    }

    console.log("\n" + "=".repeat(60));
    console.log("✅ DC FINAL APPROVAL - AUTO MINING INITIATED");
    console.log("=".repeat(60));
    console.log("Property ID:", propertyId);
    console.log("Approved by:", req.user.userId);

    // Update property to APPROVED
    await pool.query(
      `UPDATE properties 
       SET status = 'APPROVED', 
           current_approver_role = NULL,
           updated_at = NOW()
       WHERE property_id = $1 AND assigned_dc_id = $2`,
      [propertyId, req.user.userId]
    );

    // Create approval chain record
    await pool.query(
      `INSERT INTO approval_chain 
       (property_id, approver_user_id, approver_role, action, comments)
       VALUES ($1, $2, $3, $4, $5)`,
      [propertyId, req.user.userId, 'DC', 'APPROVED', comments]
    );

    // ✅ AUTO-MINE TO BLOCKCHAIN (Proof of Authority Consensus)
    let blockchainResult = null;
    try {
      console.log("⛏️  Mining property to blockchain using Proof of Authority...");
      
      // Get property data for mining
      const propertyData = await pool.query(
        "SELECT * FROM properties WHERE property_id = $1",
        [propertyId]
      );

      if (propertyData.rows.length > 0) {
        const property = propertyData.rows[0];

        await ownershipHistoryService.recordOwnershipEvent(pool, {
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
          remarks: `Property registration approved by DC ${req.user.userId}${comments ? `: ${comments}` : ""}`,
          createdAt: new Date(),
        });
        
        // Mine the block - DC is the authority validator
        const newBlock = await blockchainService.mineBlock(property, req.user.userId);
        
        blockchainResult = {
          blockIndex: newBlock.block_index,
          blockHash: newBlock.blockchain_hash,
          previousHash: newBlock.previous_hash,
          nonce: newBlock.nonce,
          minedAt: newBlock.mined_at,
          minedBy: req.user.userId,
          validatorRole: 'DC' // Proof of Authority - DC is the validator
        };

        console.log("✅ Property mined to blockchain successfully!");
        console.log("   Block Index:", newBlock.block_index);
        console.log("   Block Hash:", newBlock.blockchain_hash.substring(0, 20) + "...");
        console.log("   Nonce:", newBlock.nonce);
        console.log("   Validator:", req.user.userId, "(DC - Authority)");
        console.log("   Mining Time:", new Date(newBlock.mined_at).toLocaleString());
      }
    } catch (blockchainError) {
      console.error("❌ Blockchain mining error:", blockchainError.message);
      // Property is still approved even if mining fails
      // We log this for admin review
      await pool.query(
        `INSERT INTO audit_logs (user_id, action_type, target_id, details, ip_address)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          req.user.userId,
          'BLOCKCHAIN_MINING_FAILED',
          propertyId,
          JSON.stringify({ error: blockchainError.message }),
          req.ip || 'unknown'
        ]
      );
    }

    // Create audit log for approval
    await pool.query(
      `INSERT INTO audit_logs (user_id, action_type, target_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user.userId,
        'PROPERTY_APPROVED_BY_DC',
        propertyId,
        JSON.stringify({ 
          propertyId, 
          comments,
          blockchainMined: blockchainResult !== null,
          blockHash: blockchainResult?.blockHash,
          blockIndex: blockchainResult?.blockIndex
        }),
        req.ip || 'unknown'
      ]
    );

    console.log("=".repeat(60) + "\n");

    // Return success with blockchain info
    return res.json({
      success: true,
      message: blockchainResult 
        ? "Property approved and successfully mined to blockchain!" 
        : "Property approved. Blockchain mining pending.",
      propertyId,
      status: 'APPROVED',
      blockchain: blockchainResult,
      consensusMechanism: "Proof of Authority (PoA)",
      validator: {
        userId: req.user.userId,
        role: 'DC',
        approvedAt: new Date().toISOString()
      }
    });

  } catch (err) {
    console.error("❌ Error approving property:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

export default router;