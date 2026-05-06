// =====================================================
// OWNERSHIP HISTORY ROUTES
// Location: backend/src/routes/ownershipHistory.js
// Purpose: Display property ownership history showing all transfers
// =====================================================

import express from "express";
const router = express.Router();
import pool from "../config/db.js";
import jwt from "jsonwebtoken";
import ownershipHistoryService from "../services/ownershipHistory.service.js";

// =====================================================
// MIDDLEWARE - JWT Authentication
// =====================================================
function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, message: "No token provided" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "default-jwt-secret");
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ success: false, message: "Invalid token" });
  }
}

// =====================================================
// 1️⃣ GET PROPERTY OWNERSHIP HISTORY BY PROPERTY ID
// =====================================================
router.get("/:propertyId", authenticateToken, async (req, res) => {
  try {
    const { propertyId } = req.params;
    
    console.log("\n========================================");
    console.log("📜 FETCHING OWNERSHIP HISTORY");
    console.log("Property ID:", propertyId);
    console.log("Requested by:", req.user.userId);
    console.log("========================================");

    // Step 1: Get current property details
    const propertyResult = await pool.query(
      `SELECT 
        p.property_id,
        p.owner_id,
        p.owner_name,
        p.owner_cnic,
        p.father_name,
        p.fard_no,
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
        p.updated_at
       FROM properties p
       WHERE p.property_id = $1`,
      [propertyId]
    );

    if (propertyResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Property not found"
      });
    }

    const property = propertyResult.rows[0];
    console.log("✅ Property found:", property.property_id);

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

    const historyRecords = await ownershipHistoryService.listPropertyOwnershipHistory(pool, propertyId);
    console.log("✅ Found", historyRecords.length, "ownership history record(s)");

    // Step 3: Get ALL transfer requests for this property (including pending)
    const allTransfersResult = await pool.query(
      `SELECT 
        tr.transfer_id,
        tr.property_id,
        tr.seller_id,
        tr.buyer_id,
        tr.buyer_name,
        tr.buyer_cnic,
        tr.buyer_father_name,
        tr.transfer_amount,
        tr.property_tax_buyer,
        tr.property_tax_seller,
        tr.total_amount,
        tr.status,
        tr.created_at,
        tr.completed_at,
        tr.payment_verified_at,
        tr.payment_verified_by,
        
        -- Seller Details
        seller.name as seller_name,
        seller.cnic as seller_cnic,
        seller.email as seller_email,
        
        -- Buyer Details (from users table if registered)
        buyer.name as buyer_registered_name,
        buyer.email as buyer_email
        
       FROM transfer_requests tr
       
       LEFT JOIN users seller ON tr.seller_id = seller.user_id
       LEFT JOIN users buyer ON tr.buyer_id = buyer.user_id
       
       WHERE tr.property_id = $1
       ORDER BY tr.created_at DESC`,
      [propertyId]
    );

    console.log("✅ Found", allTransfersResult.rows.length, "total transfer request(s)");

    // Step 4: Build comprehensive ownership chain
    const ownershipChain = [];

    const hasRegistrationRecord = historyRecords.some(
      (record) => String(record.transfer_type || "").toUpperCase() === "REGISTRATION"
    );

    if (!hasRegistrationRecord) {
      ownershipChain.push({
        sequence: 0,
        event_type: 'ORIGINAL_REGISTRATION',
        event_date: property.created_at,
        owner_name: property.owner_name,
        owner_cnic: property.owner_cnic,
        father_name: property.father_name,
        transfer_amount: null,
        transfer_type: 'REGISTRATION',
        status: 'COMPLETED'
      });
    }

    historyRecords.forEach((record) => {
      const normalizedType = String(record.transfer_type || '').toUpperCase();
      let eventType = 'OWNERSHIP_TRANSFER';
      if (normalizedType === 'REGISTRATION') eventType = 'ORIGINAL_REGISTRATION';
      if (normalizedType === 'SUCCESSION') eventType = 'SUCCESSION_ALLOCATION';

      ownershipChain.push({
        sequence: ownershipChain.length,
        event_type: eventType,
        event_date: record.transfer_date,
        transfer_id: record.transfer_id,
        reference_id: record.reference_id,
        reference_type: record.reference_type,
        previous_owner_id: record.previous_owner_id,
        previous_owner_name: record.resolved_previous_owner_name,
        previous_owner_cnic: record.resolved_previous_owner_cnic,
        new_owner_id: record.new_owner_id,
        new_owner_name: record.resolved_new_owner_name,
        new_owner_cnic: record.resolved_new_owner_cnic,
        new_owner_father_name: record.new_owner_father_name,
        transfer_type: record.transfer_type || 'SALE',
        transfer_amount: record.transfer_amount,
        remarks: record.remarks,
        status: 'COMPLETED'
      });
    });

    console.log("========================================");
    console.log("📊 OWNERSHIP HISTORY SUMMARY");
    console.log("Current Owner:", property.owner_name);
    console.log(
      "Total Ownership Changes:",
      historyRecords.filter((record) => String(record.transfer_type || '').toUpperCase() !== 'REGISTRATION').length
    );
    console.log("========================================\n");

    return res.json({
      success: true,
      property: {
        property_id: property.property_id,
        current_owner_id: property.owner_id,
        current_owner_name: property.owner_name,
        current_owner_cnic: property.owner_cnic,
        father_name: property.father_name,
        fard_no: property.fard_no,
        khasra_no: property.khasra_no,
        khatooni_no: property.khatooni_no,
        area_marla: property.area_marla,
        property_type: property.property_type,
        district: property.district,
        tehsil: property.tehsil,
        mauza: property.mauza,
        address: property.address,
        status: property.status,
        created_at: property.created_at,
        updated_at: property.updated_at
      },
      ownership_chain: ownershipChain,
      total_transfers: historyRecords.filter((record) => String(record.transfer_type || '').toUpperCase() !== 'REGISTRATION').length,
      all_transfer_requests: allTransfersResult.rows, // All transfers including pending
      history_records: historyRecords // Raw history records
    });

  } catch (err) {
    console.error("❌ Error fetching ownership history:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

// =====================================================
// 2️⃣ GET ALL PROPERTIES WITH TRANSFER HISTORY (for officers)
// =====================================================
router.get("/all/properties-with-history", authenticateToken, async (req, res) => {
  try {
    const userRole = req.user.role.toUpperCase();
    
    // Only officers and admin can view all properties
    if (!['LRO', 'LAND RECORD OFFICER', 'TEHSILDAR', 'ADMIN'].includes(userRole)) {
      return res.status(403).json({ 
        success: false, 
        message: "Access denied. Officer access required." 
      });
    }

    console.log("\n========================================");
    console.log("📋 FETCHING ALL PROPERTIES WITH HISTORY");
    console.log("Requested by:", req.user.userId, "(", userRole, ")");
    console.log("========================================");

    // Get all properties with their transfer counts
    const propertiesResult = await pool.query(
      `SELECT 
        p.property_id,
        p.owner_name,
        p.owner_cnic,
        p.district,
        p.tehsil,
        p.area_marla,
        p.property_type,
        p.status,
        p.created_at,
        
        -- Count transfers
        (SELECT COUNT(*) FROM ownership_history oh WHERE oh.property_id = p.property_id AND COALESCE(oh.transfer_type, 'SALE') = 'SALE') as transfer_count,
        
        -- Get latest transfer date
        (SELECT MAX(oh.transfer_date) FROM ownership_history oh WHERE oh.property_id = p.property_id AND COALESCE(oh.transfer_type, 'SALE') = 'SALE') as last_transfer_date
        
       FROM properties p
       WHERE p.status = 'APPROVED'
       ORDER BY p.created_at DESC`
    );

    console.log("✅ Found", propertiesResult.rows.length, "properties");
    console.log("========================================\n");

    return res.json({
      success: true,
      total: propertiesResult.rows.length,
      properties: propertiesResult.rows
    });

  } catch (err) {
    console.error("❌ Error fetching properties:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

// =====================================================
// 3️⃣ SEARCH PROPERTY BY FARD, KHASRA, OR KHATOONI
// =====================================================
router.get("/search/:searchQuery", authenticateToken, async (req, res) => {
  try {
    const { searchQuery } = req.params;
    
    console.log("\n========================================");
    console.log("🔍 SEARCHING PROPERTY");
    console.log("Query:", searchQuery);
    console.log("========================================");

    // Search by property_id, fard_no, khasra_no, or khatooni_no
    const searchResult = await pool.query(
      `SELECT 
        p.property_id,
        p.owner_name,
        p.owner_cnic,
        p.fard_no,
        p.khasra_no,
        p.khatooni_no,
        p.district,
        p.tehsil,
        p.area_marla,
        p.property_type,
        p.status,
        p.created_at,
        
        (SELECT COUNT(*) FROM ownership_history oh WHERE oh.property_id = p.property_id AND COALESCE(oh.transfer_type, 'SALE') = 'SALE') as transfer_count
        
       FROM properties p
       WHERE 
        p.property_id ILIKE $1 OR
        p.fard_no ILIKE $1 OR
        p.khasra_no ILIKE $1 OR
        p.khatooni_no ILIKE $1
       ORDER BY p.created_at DESC
       LIMIT 20`,
      [`%${searchQuery}%`]
    );

    console.log("✅ Found", searchResult.rows.length, "matching property(ies)");
    console.log("========================================\n");

    return res.json({
      success: true,
      total: searchResult.rows.length,
      properties: searchResult.rows
    });

  } catch (err) {
    console.error("❌ Error searching property:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

export default router;