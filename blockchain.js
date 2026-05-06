// =====================================================
// BLOCKCHAIN ROUTES - Complete Implementation
// Location: backend/src/routes/blockchain.js
// =====================================================

import express from 'express';
import blockchainService from '../services/blockchain.service.js';
import tamperingService from '../services/blockchainTampering.service.js';
import jwt from 'jsonwebtoken';

const router = express.Router();

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

// Admin-only middleware
function requireAdmin(req, res, next) {
    if (req.user.role !== 'ADMIN' && req.user.role !== 'LRO') {
        return res.status(403).json({ success: false, message: "Admin access required" });
    }
    next();
}

// Optional authentication middleware (allows anonymous access)
function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (token) {
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET || "default-jwt-secret");
            req.user = decoded;
        } catch (err) {
            // Invalid token, but continue without user
            req.user = null;
        }
    } else {
        req.user = null;
    }
    next();
}

// =====================================================
// 1️⃣ MINE NEW BLOCK (Add Property to Blockchain)
// =====================================================
router.post('/mine', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { propertyId } = req.body;
        const adminId = req.user.userId;

        console.log("\n⛏️ ========================================");
        console.log("⛏️  MINING NEW BLOCK");
        console.log("⛏️ ========================================");
        console.log("Property ID:", propertyId);
        console.log("Admin ID:", adminId);

        if (!propertyId) {
            return res.status(400).json({ 
                success: false, 
                message: "Property ID is required" 
            });
        }

        // Get property details from database
        const propertyData = await blockchainService.getPropertyData(propertyId);
        
        if (!propertyData) {
            return res.status(404).json({ 
                success: false, 
                message: "Property not found" 
            });
        }

        // Mine the block (Proof of Work)
        const startTime = Date.now();
        const newBlock = await blockchainService.mineBlock(propertyData, adminId);
        const miningTime = ((Date.now() - startTime) / 1000).toFixed(2);

        console.log("✅ Block mined successfully!");
        console.log("Block Index:", newBlock.block_index);
        console.log("Block Hash:", newBlock.blockchain_hash);
        console.log("Mining Time:", miningTime, "seconds");
        console.log("Nonce:", newBlock.nonce);
        console.log("⛏️ ========================================\n");

        res.json({
            success: true,
            message: "Property successfully added to blockchain",
            block: {
                block_index: newBlock.block_index,
                property_id: newBlock.property_id,
                blockchain_hash: newBlock.blockchain_hash,
                previous_hash: newBlock.previous_hash,
                nonce: newBlock.nonce,
                mined_by: newBlock.mined_by,
                mined_at: newBlock.mined_at,
                transaction_data: newBlock.transaction_data,
                mining_time: miningTime + " seconds"
            }
        });

    } catch (err) {
        console.error("❌ Mining Error:", err);
        res.status(500).json({ 
            success: false, 
            message: "Mining failed: " + err.message 
        });
    }
});

// =====================================================
// 2️⃣ GET FULL BLOCKCHAIN (Blockchain Explorer)
// =====================================================
router.get("/explorer", optionalAuth, async (req, res) => {
    try {
        console.log("\n🔍 ========================================");
        console.log("🔍 BLOCKCHAIN EXPLORER - LOADING FULL CHAIN");
        console.log("🔍 ========================================");

        const chain = await blockchainService.getFullChain();
        
        console.log("✅ Blockchain loaded successfully");
        console.log("Total Blocks:", chain.length);
        console.log("🔍 ========================================\n");

        // Verify blockchain integrity
        const isValid = await blockchainService.verifyChain();

        res.json({
            success: true,
            total_blocks: chain.length,
            blockchain_valid: isValid,
            chain: chain.map(block => ({
                block_index: block.block_index,
                property_id: block.property_id,
                blockchain_hash: block.blockchain_hash,
                previous_hash: block.previous_hash,
                nonce: block.nonce,
                mined_by: block.mined_by,
                mined_at: block.mined_at,
                transaction_data: block.transaction_data
            }))
        });

    } catch (err) {
        console.error("❌ Explorer Error:", err);
        res.status(500).json({ 
            success: false, 
            message: "Failed to load blockchain: " + err.message 
        });
    }
});

// =====================================================
// 3️⃣ TRACE PROPERTY HISTORY (Property-specific blocks)
// =====================================================
router.get("/trace/:propertyId", optionalAuth, async (req, res) => {
    try {
        const { propertyId } = req.params;

        console.log("\n🔎 ========================================");
        console.log("🔎 TRACING PROPERTY HISTORY");
        console.log("🔎 ========================================");
        console.log("Property ID:", propertyId);

        const history = await blockchainService.getPropertyHistory(propertyId);

        console.log("✅ Found", history.length, "block(s) for this property");
        console.log("🔎 ========================================\n");

        if (history.length === 0) {
            return res.json({
                success: true,
                message: "No blockchain records found for this property",
                property_id: propertyId,
                blocks: []
            });
        }

        res.json({ 
            success: true,
            property_id: propertyId,
            total_blocks: history.length,
            blocks: history.map(block => ({
                block_index: block.block_index,
                blockchain_hash: block.blockchain_hash,
                previous_hash: block.previous_hash,
                nonce: block.nonce,
                mined_by: block.mined_by,
                mined_at: block.mined_at,
                transaction_data: block.transaction_data
            }))
        });

    } catch (err) {
        console.error("❌ Trace Error:", err);
        res.status(500).json({ 
            success: false, 
            message: "Failed to trace property: " + err.message 
        });
    }
});

// =====================================================
// 4️⃣ GET BLOCKCHAIN STATISTICS
// =====================================================
router.get("/stats", optionalAuth, async (req, res) => {
    try {
        const stats = await blockchainService.getBlockchainStats();
        
        res.json({
            success: true,
            statistics: stats
        });

    } catch (err) {
        console.error("❌ Stats Error:", err);
        res.status(500).json({ 
            success: false, 
            message: "Failed to load statistics: " + err.message 
        });
    }
});

// =====================================================
// 5️⃣ VERIFY BLOCKCHAIN INTEGRITY
// =====================================================
router.get('/verify', authenticateToken, requireAdmin, async (req, res) => {
    try {
        console.log("\n🔒 ========================================");
        console.log("🔒 VERIFYING BLOCKCHAIN INTEGRITY");
        console.log("🔒 ========================================");

        const verification = await blockchainService.verifyChainDetailed();

        console.log("Blockchain Valid:", verification.isValid);
        console.log("Total Blocks Verified:", verification.totalBlocks);
        
        if (!verification.isValid) {
            console.log("❌ Invalid Blocks:", verification.invalidBlocks.length);
        }
        
        console.log("🔒 ========================================\n");

        res.json({
            success: true,
            verification
        });

    } catch (err) {
        console.error("❌ Verification Error:", err);
        res.status(500).json({ 
            success: false, 
            message: "Verification failed: " + err.message 
        });
    }
});

// =====================================================
// 6️⃣ GET SINGLE BLOCK BY INDEX
// =====================================================
router.get("/block/:blockIndex", optionalAuth, async (req, res) => {
    try {
        const { blockIndex } = req.params;
        const block = await blockchainService.getBlockByIndex(parseInt(blockIndex));

        if (!block) {
            return res.status(404).json({
                success: false,
                message: "Block not found"
            });
        }

        res.json({
            success: true,
            block: {
                block_index: block.block_index,
                property_id: block.property_id,
                blockchain_hash: block.blockchain_hash,
                previous_hash: block.previous_hash,
                nonce: block.nonce,
                mined_by: block.mined_by,
                mined_at: block.mined_at,
                transaction_data: block.transaction_data
            }
        });

    } catch (err) {
        console.error("❌ Block Fetch Error:", err);
        res.status(500).json({ 
            success: false, 
            message: "Failed to fetch block: " + err.message 
        });
    }
});

// =====================================================
// 🔐 TAMPERING DETECTION & TESTING ROUTES
// =====================================================

// 1️⃣ Detect Tampering
router.get('/tampering/detect', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await tamperingService.detectTampering();
        res.json({ success: true, ...result });
    } catch (err) {
        console.error("❌ Detection Error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2️⃣ Simulate Tampering
router.post('/tampering/simulate', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { blockIndex, tamperingType } = req.body;

        if (!blockIndex && blockIndex !== 0) {
            return res.status(400).json({ success: false, message: "Block index required" });
        }

        const validTypes = ['MODIFY_DATA', 'CHANGE_HASH', 'BREAK_CHAIN', 'MODIFY_NONCE'];
        const type = tamperingType || 'MODIFY_DATA';

        if (!validTypes.includes(type)) {
            return res.status(400).json({ 
                success: false, 
                message: `Invalid type. Use: ${validTypes.join(', ')}` 
            });
        }

        const result = await tamperingService.simulateTampering(blockIndex, type);
        res.json({ success: true, message: `Block ${blockIndex} tampered (${type})`, ...result });

    } catch (err) {
        console.error("❌ Tampering Error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 3️⃣ Restore Block
router.post('/tampering/restore/:blockIndex', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const blockIndex = parseInt(req.params.blockIndex);

        if (isNaN(blockIndex)) {
            return res.status(400).json({ success: false, message: "Invalid block index" });
        }

        const result = await tamperingService.restoreBlock(blockIndex);
        res.json({ success: true, message: `Block ${blockIndex} restored`, ...result });

    } catch (err) {
        console.error("❌ Restoration Error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 4️⃣ Compare Hashes
router.get('/tampering/compare/:blockIndex', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const blockIndex = parseInt(req.params.blockIndex);

        if (isNaN(blockIndex)) {
            return res.status(400).json({ success: false, message: "Invalid block index" });
        }

        const result = await tamperingService.compareHashes(blockIndex);
        res.json({ success: true, ...result });

    } catch (err) {
        console.error("❌ Comparison Error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 5️⃣ Tampering Info
router.get('/tampering/info', authenticateToken, requireAdmin, async (req, res) => {
    res.json({
        success: true,
        message: "Blockchain Tampering Test Tool",
        endpoints: {
            detect: "GET /api/blockchain/tampering/detect",
            simulate: "POST /api/blockchain/tampering/simulate",
            restore: "POST /api/blockchain/tampering/restore/:blockIndex",
            compare: "GET /api/blockchain/tampering/compare/:blockIndex"
        },
        tamperingTypes: [
            "MODIFY_DATA - Change transaction data",
            "CHANGE_HASH - Modify blockchain hash",
            "BREAK_CHAIN - Break chain linkage",
            "MODIFY_NONCE - Change nonce value"
        ],
        example: {
            simulate: {
                url: "POST /api/blockchain/tampering/simulate",
                body: { blockIndex: 1, tamperingType: "MODIFY_DATA" }
            }
        }
    });
});

export default router;