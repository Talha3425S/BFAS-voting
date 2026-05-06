// =====================================================
// ENHANCED TRANSFER ROUTES - Complete Property Transfer Workflow
// Location: backend/src/routes/transfer.js
// =====================================================
import express from "express";
const router = express.Router();
import pool from "../config/db.js";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import channelService from '../services/channel.service.js';
import propertyEncumbranceService from "../services/propertyEncumbrance.service.js";
import propertyFreezeService from "../services/propertyFreeze.service.js";
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
// UTILITY FUNCTIONS
// =====================================================
function formatCNIC(cnic) {
  if (!cnic || cnic.length !== 13) return cnic;
  return `${cnic.slice(0, 5)}-${cnic.slice(5, 12)}-${cnic.slice(12)}`;
}

// =====================================================
// 1️⃣ VERIFY BUYER - Check if buyer exists
// =====================================================
router.post("/verify-buyer", authenticateToken, async (req, res) => {
  try {
    const { buyerCnic } = req.body;

    if (!buyerCnic) {
      return res.status(400).json({
        success: false,
        message: "Buyer CNIC is required"
      });
    }

    const cleanedCnic = buyerCnic.replace(/\D/g, "");

    if (cleanedCnic.length !== 13) {
      return res.status(400).json({
        success: false,
        message: "Invalid CNIC format. Must be 13 digits."
      });
    }

    console.log("\n========================================");
    console.log("🔍 VERIFYING BUYER");
    console.log("CNIC:", cleanedCnic);

    const buyerResult = await pool.query(
      `SELECT user_id, name, cnic, father_name, email, mobile, role 
       FROM users 
       WHERE cnic = $1 AND role = 'CITIZEN' AND is_active = TRUE`,
      [cleanedCnic]
    );

    if (buyerResult.rows.length === 0) {
      console.log("❌ Buyer not found in system");
      console.log("========================================\n");
      
      return res.json({
        success: false,
        exists: false,
        message: "Buyer with this CNIC is not registered in the system. Please ask the buyer to register first."
      });
    }

    const buyer = buyerResult.rows[0];
    
    console.log("✅ Buyer found:");
    console.log("   User ID:", buyer.user_id);
    console.log("   Name:", buyer.name);
    console.log("========================================\n");

    return res.json({
      success: true,
      exists: true,
      buyer: {
        userId: buyer.user_id,
        name: buyer.name,
        cnic: buyer.cnic,
        fatherName: buyer.father_name,
        email: buyer.email,
        mobile: buyer.mobile
      },
      message: "Buyer verified successfully"
    });

  } catch (err) {
    console.error("❌ Verify buyer error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

// =====================================================
// 2️⃣ GET SELLER'S PROPERTIES (for dropdown)
// =====================================================
router.get("/seller-properties", authenticateToken, async (req, res) => {
  try {
    await propertyFreezeService.ensureSchema();
    await propertyEncumbranceService.ensureSchema();
    console.log("\n========================================");
    console.log("📋 FETCHING SELLER'S PROPERTIES");
    console.log("User ID:", req.user.userId);

    const result = await pool.query(
      `SELECT property_id, fard_no, khasra_no, khatooni_no, 
              district, tehsil, area_marla, property_type, status,
              COALESCE(is_frozen, FALSE) AS is_frozen,
              FALSE AS has_co_owners,
              'SOLE' AS ownership_model,
              0 AS active_co_owner_count,
              NULL::TEXT AS co_owner_summary,
              COALESCE(is_encumbered, FALSE) AS is_encumbered,
              encumbrance_summary,
              freeze_reason_label
       FROM properties 
       WHERE owner_id = $1 
       AND status = 'APPROVED'
       AND COALESCE(is_frozen, FALSE) = FALSE
       AND COALESCE(is_encumbered, FALSE) = FALSE
       AND property_id NOT IN (
         SELECT property_id FROM transfer_requests 
         WHERE status IN ('PAYMENT_PENDING', 'PAYMENT_UPLOADED', 'PAYMENT_VERIFIED', 'CHANNEL_ACTIVE')
           AND (expires_at IS NULL OR expires_at > NOW())
       )
       ORDER BY created_at DESC`,
      [req.user.userId]
    );

    console.log("✅ Found", result.rows.length, "available properties");
    console.log("========================================\n");

    return res.json({
      success: true,
      properties: result.rows,
      total: result.rows.length
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
// 3️⃣ INITIATE TRANSFER - Create transfer application
// =====================================================
router.post("/initiate", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await propertyFreezeService.ensureSchema(client);
    await propertyEncumbranceService.ensureSchema(client);
    await client.query('BEGIN');

    console.log("\n========================================");
    console.log("📄 INITIATE TRANSFER REQUEST");
    console.log("========================================");

    const {
      propertyId,
      buyerCnic,
      buyerName,
      transferAmount,
      durationDays
    } = req.body;

    // Validation
    if (!propertyId || !buyerCnic || !buyerName || !transferAmount || !durationDays) {
      throw new Error("All fields required: propertyId, buyerCnic, buyerName, transferAmount, durationDays");
    }

    const cleanedCnic = buyerCnic.replace(/\D/g, "");

    // Verify buyer exists
    const buyerCheck = await client.query(
      `SELECT user_id, name, father_name, cnic 
       FROM users 
       WHERE cnic = $1 AND role = 'CITIZEN' AND is_active = TRUE`,
      [cleanedCnic]
    );

    if (buyerCheck.rows.length === 0) {
      throw new Error(`Buyer with CNIC ${formatCNIC(cleanedCnic)} is not registered. Please ask the buyer to register first.`);
    }

    const registeredBuyer = buyerCheck.rows[0];

    // Validate name match
    const normalizedInputName = buyerName.trim().toLowerCase();
    const normalizedRegisteredName = registeredBuyer.name.trim().toLowerCase();

    if (normalizedInputName !== normalizedRegisteredName) {
      throw new Error(`Name mismatch! Entered "${buyerName}" does not match registered name "${registeredBuyer.name}"`);
    }

    console.log("✅ Buyer validated:", registeredBuyer.name);

    // Verify seller owns property
    const propertyCheck = await client.query(
      `SELECT * FROM properties 
       WHERE property_id = $1 AND owner_id = $2 AND status = 'APPROVED'`,
      [propertyId, req.user.userId]
    );

    if (propertyCheck.rows.length === 0) {
      throw new Error("Property not found or you don't own it");
    }

    const property = propertyCheck.rows[0];
    if (property.is_frozen) {
      throw new Error(
        `Property is currently under dispute hold${property.freeze_reason_label ? `: ${property.freeze_reason_label}` : ''}`
      );
    }

    if (property.is_encumbered) {
      throw new Error(
        `Property has an active encumbrance${property.encumbrance_summary ? `: ${property.encumbrance_summary}` : ''}`
      );
    }

    // Check for active (non-expired) pending transfers only
    const existingTransfer = await client.query(
      `SELECT transfer_id, expires_at FROM transfer_requests 
       WHERE property_id = $1 
       AND status IN ('PAYMENT_PENDING', 'PAYMENT_UPLOADED', 'PAYMENT_VERIFIED', 'CHANNEL_ACTIVE')
       AND (expires_at IS NULL OR expires_at > NOW())`,
      [propertyId]
    );

    if (existingTransfer.rows.length > 0) {
      throw new Error("This property already has an active pending transfer request");
    }

    // Auto-expire any stale transfers for this property before creating a new one
    await client.query(
      `UPDATE transfer_requests
       SET status = 'EXPIRED', updated_at = NOW()
       WHERE property_id = $1
         AND status IN ('PAYMENT_PENDING', 'PAYMENT_UPLOADED', 'CHANNEL_ACTIVE')
         AND expires_at IS NOT NULL
         AND expires_at <= NOW()`,
      [propertyId]
    );

    // Calculate taxes (2% each)
    const propertyTaxBuyer = parseFloat((transferAmount * 0.02).toFixed(2));
    const propertyTaxSeller = parseFloat((transferAmount * 0.02).toFixed(2));
    const totalAmount = parseFloat(transferAmount) + propertyTaxBuyer;

    // Calculate expiry date
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + parseInt(durationDays));

    // Generate transfer ID
    const transferId = `TR-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;



    /* LEGACY NESTED ROUTE REMOVED
    // ADD THIS NEW ENDPOINT FOR ACTIVATING CHANNEL
// Add this after the /initiate endpoint
// =====================================================

router.post("/activate-channel/:transferId", authenticateToken, async (req, res) => {
  try {
    const { transferId } = req.params;

    console.log("\n========================================");
    console.log("💬 ACTIVATING P2P CHANNEL");
    console.log("Transfer ID:", transferId);
    console.log("========================================");

    // Get transfer and channel info
    const transferResult = await pool.query(
      `SELECT channel_id, seller_id, buyer_id, channel_status
       FROM transfer_requests
       WHERE transfer_id = $1`,
      [transferId]
    );

    if (transferResult.rows.length === 0) {
      throw new Error("Transfer not found");
    }

    const transfer = transferResult.rows[0];

    // Verify user is seller
    if (transfer.seller_id !== req.user.userId) {
      throw new Error("Only the seller can activate the channel");
    }

    if (transfer.channel_status !== 'INACTIVE') {
      throw new Error(`Channel is already ${transfer.channel_status}`);
    }

    // Activate the channel
    await pool.query(
      `UPDATE transfer_requests
       SET channel_status = 'ACTIVE',
           channel_activated_at = NOW()
       WHERE transfer_id = $1`,
      [transferId]
    );

    // Add system message
    await pool.query(
      `INSERT INTO channel_messages (
        channel_id, sender_role, message_type, message_content, is_system_message
      ) VALUES ($1, 'SYSTEM', 'TEXT', $2, true)`,
      [
        transfer.channel_id,
        '✅ Channel activated! Both parties can now negotiate. Please be respectful and professional.'
      ]
    );

    console.log("✅ Channel activated:", transfer.channel_id);
    console.log("========================================\n");

    res.json({
      success: true,
      message: "Channel activated successfully",
      channelId: transfer.channel_id
    });

  } catch (err) {
    console.error("❌ Activate channel error:", err);
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});
    */
    // Create transfer request
    // =====================================================
    // NEW: Generate Channel ID for P2P Negotiation
    // =====================================================
    const channelId = `CH-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    console.log("💬 Creating P2P channel:", channelId);

    // Create transfer request WITH channel info
    const transferResult = await client.query(
      `INSERT INTO transfer_requests (
        transfer_id, property_id, seller_id, buyer_id, buyer_name, buyer_cnic, buyer_father_name,
        transfer_amount, property_tax_buyer, property_tax_seller, total_amount,
        status, expires_at, created_at,
        channel_id, channel_status, channel_created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'PAYMENT_PENDING', $12, NOW(), $13, 'INACTIVE', NOW())
      RETURNING *`,
      [
        transferId,
        propertyId,
        req.user.userId,
        registeredBuyer.user_id,
        registeredBuyer.name,
        cleanedCnic,
        registeredBuyer.father_name,
        transferAmount,
        propertyTaxBuyer,
        propertyTaxSeller,
        totalAmount,
        expiresAt,
        channelId  // NEW: Store channel ID
      ]
    );

    // =====================================================
    // NEW: Create channel participants
    // =====================================================
    await client.query(
      `INSERT INTO channel_participants (channel_id, user_id, role, joined_at)
       VALUES ($1, $2, 'SELLER', NOW()),
              ($1, $3, 'BUYER', NOW())`,
      [channelId, req.user.userId, registeredBuyer.user_id]
    );

    // =====================================================
    // NEW: Create initial system message
    // =====================================================
    await client.query(
      `INSERT INTO channel_messages (
        channel_id, sender_role, message_type, message_content, is_system_message
      ) VALUES ($1, 'SYSTEM', 'TEXT', $2, true)`,
      [
        channelId,
        `🔔 Negotiation channel created for ${propertyId}. Seller can now start the conversation.`
      ]
    );

    console.log("✅ P2P channel created successfully");

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (user_id, action_type, target_id, details, ip_address) 
       VALUES ($1, 'TRANSFER_INITIATED', $2, $3, $4)`,
      [
        req.user.userId,
        transferId,
        JSON.stringify({ 
          propertyId, 
          buyerId: registeredBuyer.user_id, 
          amount: transferAmount,
          channelId: channelId  // NEW
        }),
        req.ip || 'unknown'
      ]
    );

    await client.query('COMMIT');

    console.log("✅ Transfer initiated successfully");
    console.log("Transfer ID:", transferId);
    console.log("Channel ID:", channelId);
    console.log("Expires at:", expiresAt);
    console.log("========================================\n");

    return res.json({
      success: true,
      message: "Transfer request created successfully",
      transfer: transferResult.rows[0],
      channelId: channelId  // NEW: Return channel ID to frontend
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error("❌ Initiate transfer error:", err);
    return res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    client.release();
  }
});

// =====================================================
// 3bï¸âƒ£ ACTIVATE CHANNEL - Stable seller chat activation endpoint
// =====================================================
router.post("/activate-channel/:transferId", authenticateToken, async (req, res) => {
  const client = await pool.connect();

  try {
    const { transferId } = req.params;

    await client.query("BEGIN");

    const transferResult = await client.query(
      `SELECT transfer_id, channel_id, seller_id, buyer_id, channel_status, status
       FROM transfer_requests
       WHERE transfer_id = $1
       LIMIT 1`,
      [transferId]
    );

    if (transferResult.rows.length === 0) {
      throw new Error("Transfer not found");
    }

    const transfer = transferResult.rows[0];

    if (transfer.seller_id !== req.user.userId) {
      throw new Error("Only the seller can activate the channel");
    }

    if (!transfer.channel_id) {
      throw new Error("No negotiation channel exists for this transfer");
    }

    if (["ACTIVE", "NEGOTIATING", "AGREED", "PAYMENT_DONE", "PAYMENT_CONFIRMED"].includes(String(transfer.channel_status || "").toUpperCase())) {
      await client.query("COMMIT");
      return res.json({
        success: true,
        message: "Channel already active",
        channelId: transfer.channel_id
      });
    }

    await channelService.activateChannel(transfer.channel_id);

    await client.query(
      `UPDATE transfer_requests
       SET status = 'CHANNEL_ACTIVE',
           channel_status = 'ACTIVE',
           channel_activated_at = NOW(),
           updated_at = NOW()
       WHERE transfer_id = $1`,
      [transferId]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Channel activated successfully",
      channelId: transfer.channel_id
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("âŒ Activate channel error:", err);
    return res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    client.release();
  }
});


// Accept transfer request and activate channel
router.post('/transfers/:transferId/accept', authenticateToken, async (req, res) => {
  const { transferId } = req.params;
  const sellerId = req.user.userId;
  
  try {
    // Your existing accept logic
    await pool.query(`
      UPDATE transfer_requests 
      SET status = 'ACCEPTED', 
          accepted_at = NOW(),
          accepted_by = $1
      WHERE transfer_id = $2 AND seller_id = $1
    `, [sellerId, transferId]);
    
    // **NEW: Activate the channel**
    const channelResult = await pool.query(
      'SELECT channel_id FROM transfer_requests WHERE transfer_id = $1',
      [transferId]
    );
    
    if (channelResult.rows.length > 0 && channelResult.rows[0].channel_id) {
      const channelId = channelResult.rows[0].channel_id;
      
      // Activate the channel
      await channelService.activateChannel(channelId);
      
      res.json({
        success: true,
        message: 'Transfer accepted and chat activated',
        channelId: channelId,  // Send this to frontend
        redirectUrl: `/buyer/transfer_negotiation.html?channelId=${channelId}`
      });
    } else {
      res.json({
        success: true,
        message: 'Transfer accepted'
      });
    }
    
  } catch (error) {
    console.error('Error accepting transfer:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});



// Get seller's accepted transfers with channel info
router.get('/transfers/seller/:sellerId/accepted', authenticateToken, async (req, res) => {
  const { sellerId } = req.params;
  
  try {
    const result = await pool.query(`
      SELECT 
        tr.transfer_id,
        tr.property_id,
        tr.channel_id,
        tr.channel_status,
        tr.buyer_id,
        u.username as buyer_name,
        u.name as buyer_full_name,
        tr.created_at,
        tr.accepted_at,
        p.location as property_location,
        COUNT(cm.message_id) FILTER (
          WHERE cm.read_by_other = false AND cm.sender_id != $1
        ) as unread_count
      FROM transfer_requests tr
      LEFT JOIN users u ON tr.buyer_id = u.user_id
      LEFT JOIN properties p ON tr.property_id = p.property_id
      LEFT JOIN channel_messages cm ON tr.channel_id = cm.channel_id
      WHERE tr.seller_id = $1 
        AND tr.status = 'ACCEPTED'
        AND tr.channel_id IS NOT NULL
      GROUP BY tr.transfer_id, tr.property_id, tr.channel_id, 
               tr.channel_status, tr.buyer_id, u.username, u.name,
               tr.created_at, tr.accepted_at, p.location
      ORDER BY tr.accepted_at DESC
    `, [sellerId]);
    
    res.json({
      success: true,
      transfers: result.rows
    });
    
  } catch (error) {
    console.error('Error fetching accepted transfers:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
// Get transfers pending LRO approval (with screenshots)
router.get('/transfers/lro/pending-approval', authenticateToken, requireLRO, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        tr.transfer_id,
        tr.property_id,
        tr.channel_id,
        tr.buyer_id,
        tr.seller_id,
        tr.agreed_price,
        tr.agreement_text,
        tr.agreement_screenshot_url,
        tr.agreement_timestamp,
        tr.seller_agreed,
        tr.buyer_agreed,
        tr.seller_agreed_at,
        tr.buyer_agreed_at,
        seller.name as seller_name,
        seller.cnic as seller_cnic,
        buyer.name as buyer_name,
        buyer.cnic as buyer_cnic,
        p.location as property_location,
        p.size as property_size,
        p.owner_name as current_owner
      FROM transfer_requests tr
      JOIN users seller ON tr.seller_id = seller.user_id
      JOIN users buyer ON tr.buyer_id = buyer.user_id
      JOIN properties p ON tr.property_id = p.property_id
      WHERE tr.channel_status = 'AGREED'
        AND tr.seller_agreed = true
        AND tr.buyer_agreed = true
        AND tr.agreement_screenshot_url IS NOT NULL
        AND tr.status != 'APPROVED'
        AND tr.status != 'REJECTED'
      ORDER BY tr.agreement_timestamp DESC
    `);
    
    res.json({
      success: true,
      pendingTransfers: result.rows,
      count: result.rows.length
    });
    
  } catch (error) {
    console.error('Error fetching pending approvals:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// LRO approve transfer
router.post('/transfers/:transferId/lro-approve', authenticateToken, requireLRO, async (req, res) => {
  const { transferId } = req.params;
  const { approvalNotes } = req.body;
  const lroId = req.user.userId;
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Update transfer status
    await client.query(`
      UPDATE transfer_requests 
      SET status = 'APPROVED',
          approved_by = $1,
          approved_at = NOW(),
          approval_notes = $2
      WHERE transfer_id = $3
    `, [lroId, approvalNotes, transferId]);
    
    // Close the channel
    const channelResult = await client.query(
      'SELECT channel_id FROM transfer_requests WHERE transfer_id = $1',
      [transferId]
    );
    
    if (channelResult.rows.length > 0 && channelResult.rows[0].channel_id) {
      await channelService.closeChannel(channelResult.rows[0].channel_id);
    }
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      message: 'Transfer approved successfully'
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error approving transfer:', error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// LRO reject transfer
router.post('/transfers/:transferId/lro-reject', authenticateToken, requireLRO, async (req, res) => {
  const { transferId } = req.params;
  const { rejectionReason } = req.body;
  const lroId = req.user.userId;
  
  try {
    await pool.query(`
      UPDATE transfer_requests 
      SET status = 'REJECTED',
          approved_by = $1,
          approved_at = NOW(),
          approval_notes = $2
      WHERE transfer_id = $3
    `, [lroId, rejectionReason, transferId]);
    
    res.json({
      success: true,
      message: 'Transfer rejected'
    });
    
  } catch (error) {
    console.error('Error rejecting transfer:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
// =====================================================
// 4️⃣ BUYER: Get Pending Transfer Applications (Limited View)
// =====================================================
router.get("/buyer-pending", authenticateToken, async (req, res) => {
  try {
    const buyerId = req.user.userId;

    const result = await pool.query(
      `SELECT 
        tr.*,
        p.property_id,
        p.district,
        p.tehsil,
        p.mauza,
        p.area_marla,
        seller.name as seller_name,
        (SELECT COUNT(*) FROM channel_messages cm 
         WHERE cm.channel_id = tr.channel_id 
         AND cm.sender_id != $1 
         AND cm.read_by_other = false) as unread_count
       FROM transfer_requests tr
       LEFT JOIN properties p ON tr.property_id = p.property_id
       LEFT JOIN users seller ON tr.seller_id = seller.user_id
       WHERE tr.buyer_id = $1
         AND (
           tr.status NOT IN ('EXPIRED', 'CANCELLED', 'REJECTED')
           OR tr.payment_status = 'PAID'
           OR tr.challan_txn_id IS NOT NULL
           OR tr.channel_status IN ('PAYMENT_DONE', 'PAYMENT_CONFIRMED')
         )
         AND (
           tr.expires_at IS NULL
           OR tr.expires_at > NOW()
           OR tr.payment_status = 'PAID'
           OR tr.challan_txn_id IS NOT NULL
           OR tr.channel_status IN ('PAYMENT_DONE', 'PAYMENT_CONFIRMED')
         )
       ORDER BY tr.created_at DESC`,
      [buyerId]
    );

    res.json({
      success: true,
      transfers: result.rows
    });

  } catch (err) {
    console.error("❌ Get buyer transfers error:", err);
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});


// =====================================================
// 5️⃣ BUYER: Upload Payment Challan
// =====================================================
router.post("/upload-payment", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    console.log("\n========================================");
    console.log("💳 UPLOAD PAYMENT CHALLAN");
    console.log("========================================");

    const {
      transferId,
      paidAmount,
      challanUrl,
      agreementScreenshot  // NEW: Screenshot URL from P2P chat
    } = req.body;

    if (!transferId || !paidAmount || !challanUrl) {
      throw new Error("Transfer ID, paid amount, and challan URL are required");
    }

    // Get transfer details
    const transferCheck = await client.query(
      `SELECT * FROM transfer_requests WHERE transfer_id = $1`,
      [transferId]
    );

    if (transferCheck.rows.length === 0) {
      throw new Error("Transfer request not found");
    }

    const transfer = transferCheck.rows[0];

    // Verify user is the buyer
    if (transfer.buyer_id !== req.user.userId) {
      throw new Error("Only the buyer can upload payment challan");
    }

    // Verify status
    if (transfer.status !== 'PAYMENT_PENDING') {
      throw new Error(`Cannot upload payment. Current status: ${transfer.status}`);
    }

    // Verify amount matches
    const expectedAmount = parseFloat(transfer.total_amount);
    const actualAmount = parseFloat(paidAmount);
    
    if (Math.abs(expectedAmount - actualAmount) > 0.01) {
      throw new Error(`Amount mismatch. Expected: ${expectedAmount}, Received: ${actualAmount}`);
    }

    // Update transfer request
    const updateResult = await client.query(
      `UPDATE transfer_requests 
       SET status = 'PAYMENT_UPLOADED',
           paid_amount = $1,
           payment_challan_url = $2,
           payment_uploaded_at = NOW(),
           agreement_screenshot_url = $3
       WHERE transfer_id = $4
       RETURNING *`,
      [paidAmount, challanUrl, agreementScreenshot || null, transferId]
    );

    // =====================================================
    // NEW: Update channel status if screenshot uploaded
    // =====================================================
    if (agreementScreenshot) {
      await client.query(
        `UPDATE transfer_requests
         SET channel_status = 'CLOSED',
             screenshot_uploaded_at = NOW()
         WHERE transfer_id = $1`,
        [transferId]
      );

      // Add system message to channel
      if (transfer.channel_id) {
        await client.query(
          `INSERT INTO channel_messages (
            channel_id, sender_role, message_type, message_content, is_system_message
          ) VALUES ($1, 'SYSTEM', 'TEXT', $2, true)`,
          [
            transfer.channel_id,
            '📸 Agreement screenshot uploaded by buyer. Awaiting LRO approval...'
          ]
        );
      }

      console.log("✅ Agreement screenshot URL stored:", agreementScreenshot);
    }

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (user_id, action_type, target_id, details, ip_address)
       VALUES ($1, 'PAYMENT_UPLOADED', $2, $3, $4)`,
      [
        req.user.userId,
        transferId,
        JSON.stringify({ 
          paidAmount, 
          challanUrl,
          hasScreenshot: !!agreementScreenshot 
        }),
        req.ip || 'unknown'
      ]
    );

    await client.query('COMMIT');

    console.log("✅ Payment challan uploaded successfully");
    console.log("Transfer ID:", transferId);
    console.log("Amount:", paidAmount);
    console.log("Status:", updateResult.rows[0].status);
    console.log("========================================\n");

    res.json({
      success: true,
      message: "Payment challan uploaded successfully",
      transfer: updateResult.rows[0]
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error("❌ Upload payment error:", err);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    client.release();
  }
});

// =====================================================================
// TRANSFER.JS PATCH — ADD THIS ROUTE BEFORE "export default router;"
// in: backend/src/routes/transfer.js
//
// This is the endpoint called by OfficerPendingTransfers.jsx:
//   GET /api/transfers/lro/pending
// =====================================================================

/**
 * GET /api/transfers/lro/pending
 *
 * Returns all transfer requests that are ready for LRO review.
 * A transfer is ready when:
 *   - payment_status = 'PAID'  (simulated money transferred)
 *   - OR status = 'PAYMENT_UPLOADED'  (buyer uploaded challan screenshot)
 *   - OR challan_txn_id IS NOT NULL   (TXN reference exists)
 *
 * The LRO can then:
 *   1. Click "View Challan" to pull the payment receipt
 *   2. Approve → triggers blockchain PoA mining + ownership transfer
 *   3. Reject  → with a reason
 */
router.get('/lro/pending', authenticateToken, async (req, res) => {
  try {
    const userRole = req.user.role?.toUpperCase();
    if (!['LRO', 'LAND RECORD OFFICER', 'TEHSILDAR', 'AC', 'DC', 'ADMIN'].includes(userRole)) {
      return res.status(403).json({ success: false, message: 'Access denied. Officers only.' });
    }

    const result = await pool.query(`
      SELECT
        tr.transfer_id,
        tr.property_id,
        tr.seller_id,
        tr.buyer_id,
        tr.status,
        tr.payment_status,
        tr.channel_status,
        tr.agreed_price,
        tr.challan_txn_id,
        tr.payment_completed_at,
        tr.created_at,
        tr.updated_at,
        tr.channel_id,
        tr.seller_agreed,
        tr.buyer_agreed,
        tr.seller_agreed_at,
        tr.buyer_agreed_at,
        tr.agreement_screenshot_url,
        tr.screenshot_uploaded_at,
        tr.approval_notes,
        tr.rejection_reason,

        -- Property details
        p.district,
        p.tehsil,
        p.mauza,
        p.area_marla,
        p.khewat_no,
        p.khasra_no,
        p.khatooni_no,

        -- Seller info
        seller.name  AS seller_name,
        seller.cnic  AS seller_cnic,
        seller.email AS seller_email,

        -- Buyer info
        buyer.name   AS buyer_name,
        buyer.cnic   AS buyer_cnic,
        buyer.email  AS buyer_email,

        -- Payment transaction snapshot (joined for quick display)
        pt.txn_ref,
        pt.amount            AS paid_amount,
        pt.completed_at      AS txn_completed_at,
        pt.sender_account_no AS buyer_account_no,
        pt.receiver_account_no AS seller_account_no

      FROM transfer_requests tr
      JOIN  properties p     ON tr.property_id = p.property_id
      LEFT JOIN users seller ON tr.seller_id   = seller.user_id
      LEFT JOIN users buyer  ON tr.buyer_id    = buyer.user_id
      LEFT JOIN payment_transactions pt
             ON pt.txn_ref = tr.challan_txn_id

      WHERE (
            tr.payment_status = 'PAID'
         OR tr.status         IN ('PAYMENT_UPLOADED', 'PAYMENT_VERIFIED')
         OR tr.channel_status IN ('PAYMENT_DONE', 'PAYMENT_CONFIRMED', 'PAYMENT_UPLOADED')
         OR tr.challan_txn_id IS NOT NULL
      )
      AND tr.status NOT IN ('APPROVED', 'REJECTED', 'CANCELLED')

      ORDER BY COALESCE(tr.payment_completed_at, tr.updated_at) DESC
    `);

    const transfers = result.rows;

    return res.json({
      success: true,
      transfers,
      statistics: {
        total:          transfers.length,
        withScreenshot: transfers.filter(t => t.agreement_screenshot_url).length,
        withTxnRef:     transfers.filter(t => t.challan_txn_id).length,
        approvedToday:  0  // filled below
      }
    });

  } catch (err) {
    console.error('❌ /lro/pending error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});


// =====================================================
// 7️⃣ LRO: APPROVE TRANSFER - Transfer Property Ownership
// =====================================================
router.post("/approve", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    await propertyEncumbranceService.ensureSchema(client);

    const userRole = req.user.role.toUpperCase();
    if (!['LRO', 'LAND RECORD OFFICER', 'TEHSILDAR', 'ADMIN'].includes(userRole)) {
      throw new Error("Access denied. Only LRO/Tehsildar/Admin can approve transfers.");
    }

    console.log("\n========================================");
    console.log("✅ APPROVING PROPERTY TRANSFER");
    console.log("========================================");

    const { transferId, approvalNotes } = req.body;

    if (!transferId) {
      throw new Error("Transfer ID required");
    }

    // Get transfer details
    const transferResult = await client.query(
      `SELECT tr.*, p.*, u.name as buyer_full_name, u.father_name as buyer_father_name
       FROM transfer_requests tr
       LEFT JOIN properties p ON tr.property_id = p.property_id
       LEFT JOIN users u ON tr.buyer_id = u.user_id
       WHERE tr.transfer_id = $1 
       AND (
            tr.status IN ('PAYMENT_UPLOADED', 'PAYMENT_VERIFIED', 'AGREED')
         OR tr.payment_status = 'PAID'
         OR tr.channel_status IN ('PAYMENT_DONE', 'PAYMENT_CONFIRMED', 'AGREED')
         OR tr.challan_txn_id IS NOT NULL
       )`,
      [transferId]
    );

    if (transferResult.rows.length === 0) {
      throw new Error("Transfer not found or not ready for approval");
    }

    const transfer = transferResult.rows[0];
    await propertyEncumbranceService.assertNoActiveEncumbrance(
      transfer.property_id,
      client,
      "Property has an active encumbrance and cannot be transferred"
    );

    console.log("Property ID:", transfer.property_id);
    console.log("Current Owner ID:", transfer.owner_id);
    console.log("New Owner ID:", transfer.buyer_id);
    console.log("Current Owner Name:", transfer.owner_name);
    console.log("New Owner Name:", transfer.buyer_full_name);

    // Update property ownership (keep same property_id but change owner details)
    await client.query(
      `UPDATE properties 
       SET owner_id = $1,
           owner_name = $2,
           owner_cnic = $3,
           father_name = $4,
           updated_at = NOW()
       WHERE property_id = $5`,
      [
        transfer.buyer_id,
        transfer.buyer_full_name,
        transfer.buyer_cnic,
        transfer.buyer_father_name,
        transfer.property_id
      ]
    );

    await ownershipHistoryService.recordOwnershipEvent(client, {
      propertyId: transfer.property_id,
      previousOwnerId: transfer.owner_id,
      previousOwnerName: transfer.owner_name,
      previousOwnerCnic: transfer.owner_cnic,
      newOwnerId: transfer.buyer_id,
      newOwnerName: transfer.buyer_full_name || transfer.buyer_name,
      newOwnerCnic: transfer.buyer_cnic,
      newOwnerFatherName: transfer.buyer_father_name,
      transferType: "SALE",
      transferAmount: transfer.transfer_amount || transfer.agreed_price || 0,
      transferDate: new Date(),
      transferId,
      referenceType: "TRANSFER_REQUEST",
      referenceId: transferId,
      remarks: `Transfer approved by ${req.user.name || "Officer"}. ${approvalNotes || ""}`.trim(),
      createdAt: new Date(),
    });

    // Update transfer status to APPROVED
    await client.query(
      `UPDATE transfer_requests 
       SET status = 'APPROVED',
           approved_by = $1,
           approved_at = NOW(),
           approval_notes = $2,
           updated_at = NOW()
       WHERE transfer_id = $3`,
      [req.user.userId, approvalNotes || 'Transfer approved', transferId]
    );

    // Create transaction record
    await client.query(
      `INSERT INTO property_transactions (
        transaction_id, property_id, transaction_type, 
        from_user_id, to_user_id, amount, status, 
        transaction_date, created_at
      ) VALUES (
        $1, $2, 'TRANSFER', $3, $4, $5, 'COMPLETED', NOW(), NOW()
      )`,
      [
        `TXN-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
        transfer.property_id,
        transfer.owner_id,
        transfer.buyer_id,
        transfer.transfer_amount || transfer.agreed_price || 0
      ]
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (user_id, action_type, target_id, details, ip_address) 
       VALUES ($1, 'TRANSFER_APPROVED', $2, $3, $4)`,
      [
        req.user.userId,
        transferId,
        JSON.stringify({ 
          propertyId: transfer.property_id,
          oldOwnerId: transfer.owner_id,
          newOwnerId: transfer.buyer_id,
          amount: transfer.transfer_amount || transfer.agreed_price || 0
        }),
        req.ip || 'unknown'
      ]
    );

    await client.query('COMMIT');

    console.log("✅ Property ownership transferred successfully");
    console.log("Property:", transfer.property_id);
    console.log("From:", transfer.owner_name, "→ To:", transfer.buyer_full_name);
    console.log("========================================\n");

    return res.json({
      success: true,
      message: "Transfer approved successfully. Property ownership has been transferred.",
      propertyId: transfer.property_id,
      newOwnerId: transfer.buyer_id,
      newOwnerName: transfer.buyer_full_name
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error("❌ Approve transfer error:", err);
    return res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    client.release();
  }
});
// =====================================================
// MIDDLEWARE - LRO Role Check
// =====================================================
function requireLRO(req, res, next) {
  if (req.user.role !== 'LRO' && req.user.role !== 'ADMIN') {
    return res.status(403).json({ 
      success: false, 
      message: 'LRO access required' 
    });
  }
  next();
}
// =====================================================
// 8️⃣ LRO: REJECT TRANSFER
// =====================================================
router.post("/reject", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const userRole = req.user.role.toUpperCase();
    if (!['LRO', 'LAND RECORD OFFICER', 'TEHSILDAR', 'ADMIN'].includes(userRole)) {
      throw new Error("Access denied");
    }

    console.log("\n========================================");
    console.log("❌ REJECTING PROPERTY TRANSFER");
    console.log("========================================");

    const { transferId, reason } = req.body;

    if (!transferId || !reason) {
      throw new Error("Transfer ID and rejection reason required");
    }

    // Update transfer status
    await client.query(
      `UPDATE transfer_requests 
       SET status = 'REJECTED',
           rejection_reason = $1,
           rejected_by = $2,
           rejected_at = NOW(),
           updated_at = NOW()
       WHERE transfer_id = $3`,
      [reason, req.user.userId, transferId]
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (user_id, action_type, target_id, details, ip_address) 
       VALUES ($1, 'TRANSFER_REJECTED', $2, $3, $4)`,
      [
        req.user.userId,
        transferId,
        JSON.stringify({ reason }),
        req.ip || 'unknown'
      ]
    );

    await client.query('COMMIT');

    console.log("✅ Transfer rejected");
    console.log("Reason:", reason);
    console.log("========================================\n");

    return res.json({
      success: true,
      message: "Transfer rejected successfully"
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error("❌ Reject transfer error:", err);
    return res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    client.release();
  }
});

// =====================================================
// 9️⃣ GET SELLER'S TRANSFERS
// =====================================================
router.get("/seller-transfers", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        tr.*,
        p.district,
        p.tehsil,
        p.area_marla,
        p.property_type
       FROM transfer_requests tr
       LEFT JOIN properties p ON tr.property_id = p.property_id
       WHERE tr.seller_id = $1
       ORDER BY tr.created_at DESC`,
      [req.user.userId]
    );

    return res.json({
      success: true,
      transfers: result.rows,
      total: result.rows.length
    });

  } catch (err) {
    console.error("❌ Error:", err);
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

// =====================================================
// 🔟 CHECK TRANSFER EXPIRY (Cleanup Job)
// =====================================================
router.post("/cleanup-expired", authenticateToken, async (req, res) => {
  try {
    const userRole = req.user.role.toUpperCase();
    if (!['ADMIN', 'LRO'].includes(userRole)) {
      return res.status(403).json({ success: false, message: "Admin access required" });
    }

    const result = await pool.query(
      `UPDATE transfer_requests 
       SET status = 'EXPIRED',
           updated_at = NOW()
       WHERE status IN ('PAYMENT_PENDING', 'PAYMENT_UPLOADED')
       AND expires_at < NOW()
       RETURNING transfer_id`
    );

    return res.json({
      success: true,
      message: `${result.rows.length} expired transfers updated`,
      expiredTransfers: result.rows
    });

  } catch (err) {
    console.error("❌ Error:", err);
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
});
/**
 * ADD THESE ROUTES TO transfer.js (routes/transfer.js)
 * 
 * These endpoints handle pending transfers for sellers and buyers
 */

// GET /api/transfers/seller/:sellerId/pending
// Get all pending transfers for a seller
router.get('/seller/:sellerId/pending', authenticateToken, async (req, res) => {
  try {
    const { sellerId } = req.params;
    
    // Verify the user is the seller
    if (req.user.userId !== sellerId && req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized access'
      });
    }
    
    const result = await pool.query(`
      SELECT 
        tr.*,
        p.owner_name,
        p.district,
        p.tehsil,
        p.mauza,
        p.area_marla,
        p.khewat_no,
        p.khasra_no,
        buyer.name as buyer_name,
        buyer.cnic as buyer_cnic,
        buyer.email as buyer_email
      FROM transfer_requests tr
      JOIN properties p ON tr.property_id = p.property_id
      LEFT JOIN users buyer ON tr.buyer_id = buyer.user_id
      WHERE tr.seller_id = $1
        AND (
          tr.status IN ('PENDING', 'PAYMENT_PENDING', 'PAYMENT_UPLOADED', 'CHANNEL_ACTIVE')
          OR tr.payment_status = 'PAID'
          OR tr.challan_txn_id IS NOT NULL
          OR tr.channel_status IN ('PAYMENT_DONE', 'PAYMENT_CONFIRMED')
        )
        AND (
          tr.expires_at IS NULL
          OR tr.expires_at > NOW()
          OR tr.payment_status = 'PAID'
          OR tr.challan_txn_id IS NOT NULL
          OR tr.channel_status IN ('PAYMENT_DONE', 'PAYMENT_CONFIRMED')
        )
      ORDER BY tr.created_at DESC
    `, [sellerId]);
    
    res.json({
      success: true,
      transfers: result.rows,
      total: result.rows.length
    });
    
  } catch (error) {
    console.error('Error fetching seller pending transfers:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch pending transfers',
      error: error.message
    });
  }
});

// GET /api/transfers/buyer/:buyerId/pending
// Get all pending transfers for a buyer
router.get('/buyer/:buyerId/pending', authenticateToken, async (req, res) => {
  try {
    const { buyerId } = req.params;
    
    // Verify the user is the buyer
    if (req.user.userId !== buyerId && req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized access'
      });
    }
    
    const result = await pool.query(`
      SELECT 
        tr.*,
        p.district,
        p.tehsil,
        p.mauza,
        p.area_marla,
        seller.name as seller_name,
        seller.cnic as seller_cnic,
        seller.email as seller_email
      FROM transfer_requests tr
      JOIN properties p ON tr.property_id = p.property_id
      LEFT JOIN users seller ON tr.seller_id = seller.user_id
      WHERE tr.buyer_id = $1
        AND (
          tr.status IN ('PENDING', 'PAYMENT_PENDING', 'PAYMENT_UPLOADED', 'CHANNEL_ACTIVE')
          OR tr.payment_status = 'PAID'
          OR tr.challan_txn_id IS NOT NULL
          OR tr.channel_status IN ('PAYMENT_DONE', 'PAYMENT_CONFIRMED')
        )
        AND (
          tr.expires_at IS NULL
          OR tr.expires_at > NOW()
          OR tr.payment_status = 'PAID'
          OR tr.challan_txn_id IS NOT NULL
          OR tr.channel_status IN ('PAYMENT_DONE', 'PAYMENT_CONFIRMED')
        )
      ORDER BY tr.created_at DESC
    `, [buyerId]);
    
    res.json({
      success: true,
      transfers: result.rows,
      total: result.rows.length
    });
    
  } catch (error) {
    console.error('Error fetching buyer pending transfers:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch pending transfers',
      error: error.message
    });
  }
});

// POST /api/transfers/:transferId/seller-confirm
// Seller confirms transfer and creates/activates channel
router.post('/:transferId/seller-confirm', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { transferId } = req.params;
    const sellerId = req.user.userId;
    
    await client.query('BEGIN');
    
    // Verify seller owns this transfer
    const transfer = await client.query(`
      SELECT * FROM transfer_requests
      WHERE transfer_id = $1 AND seller_id = $2
    `, [transferId, sellerId]);
    
    if (transfer.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Transfer request not found'
      });
    }
    
    const transferData = transfer.rows[0];
    
    // Create channel if it doesn't exist
    let channelId = transferData.channel_id;
    
    if (!channelId) {
      // Import channelService
      const channelService = (await import('../services/channel.service.js')).default;
      
      const channelResult = await channelService.createChannel(
        transferId,
        transferData.seller_id,
        transferData.buyer_id
      );
      
      channelId = channelResult.channelId;
    }
    
    // Activate the channel
    await client.query(`
      UPDATE transfer_requests
      SET 
        status = 'CHANNEL_ACTIVE',
        channel_status = 'ACTIVE',
        channel_activated_at = NOW(),
        expires_at = NOW() + INTERVAL '7 days'
      WHERE transfer_id = $1
    `, [transferId]);
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      message: 'Transfer confirmed and channel activated',
      channelId
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error confirming transfer:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to confirm transfer',
      error: error.message
    });
  } finally {
    client.release();
  }
});

// GET /api/transfers/:transferId/chat-status
// Get chat/channel status for a transfer
router.get('/:transferId/chat-status', authenticateToken, async (req, res) => {
  try {
    const { transferId } = req.params;
    const userId = req.user.userId;
    
    const result = await pool.query(`
      SELECT 
        tr.channel_id,
        tr.channel_status,
        tr.seller_agreed,
        tr.buyer_agreed,
        tr.agreement_screenshot_url,
        tr.agreed_price,
        cp.role as my_role,
        cp.is_online as other_party_online
      FROM transfer_requests tr
      LEFT JOIN channel_participants cp ON tr.channel_id = cp.channel_id
      WHERE tr.transfer_id = $1
        AND (tr.seller_id = $2 OR tr.buyer_id = $2)
    `, [transferId, userId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Transfer not found or unauthorized'
      });
    }
    
    res.json({
      success: true,
      chatStatus: result.rows[0]
    });
    
  } catch (error) {
    console.error('Error fetching chat status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch chat status',
      error: error.message
    });
  }
});

// POST /api/transfers/:transferId/cancel
// Cancel a pending transfer
router.post('/:transferId/cancel', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { transferId } = req.params;
    const userId = req.user.userId;
    const { reason } = req.body;
    
    await client.query('BEGIN');
    
    // Verify user is part of this transfer
    const transfer = await client.query(`
      SELECT * FROM transfer_requests
      WHERE transfer_id = $1
        AND (seller_id = $2 OR buyer_id = $2)
        AND status NOT IN ('APPROVED', 'REJECTED', 'CANCELLED')
    `, [transferId, userId]);
    
    if (transfer.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Transfer not found or cannot be cancelled'
      });
    }
    
    // Update transfer status
    await client.query(`
      UPDATE transfer_requests
      SET 
        status = 'CANCELLED',
        channel_status = 'CLOSED',
        rejection_reason = $2,
        updated_at = NOW()
      WHERE transfer_id = $1
    `, [transferId, reason || 'Cancelled by user']);
    
    // Close channel if exists
    if (transfer.rows[0].channel_id) {
      await client.query(`
        INSERT INTO channel_messages
          (channel_id, transfer_request_id, sender_id, sender_role, message_type, message_content, is_system_message)
        VALUES
          ($1, $2, 'SYSTEM', 'SYSTEM', 'SYSTEM', $3, true)
      `, [
        transfer.rows[0].channel_id,
        transferId,
        '🚫 Transfer has been cancelled.'
      ]);
    }
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      message: 'Transfer cancelled successfully'
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error cancelling transfer:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel transfer',
      error: error.message
    });
  } finally {
    client.release();
  }
});

export default router;