// =====================================================
// BLOCKCHAIN TAMPERING SERVICE
// Location: backend/src/services/blockchainTampering.service.js
// =====================================================

import crypto from 'crypto';
import pool from '../config/db.js';

class BlockchainTamperingService {
    
    constructor() {
        this.difficulty = 4; // Number of leading zeros required
    }

    // Calculate Block Hash
    calculateHash(blockData) {
        const { block_index, property_id, transaction_data, previous_hash, nonce, mined_at } = blockData;
        
        const dataString = JSON.stringify({
            block_index,
            property_id,
            transaction_data,
            previous_hash,
            nonce,
            mined_at
        });

        return crypto.createHash('sha256').update(dataString).digest('hex');
    }

    // 1️⃣ DETECT TAMPERING
    async detectTampering() {
        try {
            console.log("\n🔍 ========================================");
            console.log("🔍 BLOCKCHAIN TAMPERING DETECTION");
            console.log("🔍 ========================================\n");

            const result = await pool.query(
                `SELECT * FROM blockchain ORDER BY block_index ASC`
            );

            const chain = result.rows;
            
            if (chain.length === 0) {
                return { isValid: true, tamperedBlocks: [] };
            }

            console.log(`📊 Total Blocks: ${chain.length}\n`);

            const tamperedBlocks = [];
            let isValid = true;

            for (let i = 0; i < chain.length; i++) {
                const block = chain[i];
                const issues = [];

                console.log(`🔎 Verifying Block ${block.block_index}:`);

                // Check 1: Recalculate hash
                const calculatedHash = this.calculateHash(block);

                if (calculatedHash !== block.blockchain_hash) {
                    issues.push({
                        type: 'HASH_MISMATCH',
                        message: 'Block data has been modified',
                        stored: block.blockchain_hash,
                        calculated: calculatedHash
                    });
                    console.log("   ❌ HASH MISMATCH");
                }

                // Check 2: Verify difficulty
                const hashPrefix = block.blockchain_hash.substring(0, this.difficulty);
                const expectedPrefix = '0'.repeat(this.difficulty);
                
                if (hashPrefix !== expectedPrefix) {
                    issues.push({
                        type: 'INVALID_PROOF_OF_WORK',
                        message: `Hash doesn't meet difficulty requirement`,
                        hash: block.blockchain_hash
                    });
                    console.log("   ❌ INVALID PROOF OF WORK");
                }

                // Check 3: Verify chain linkage
                if (i > 0) {
                    const previousBlock = chain[i - 1];
                    if (block.previous_hash !== previousBlock.blockchain_hash) {
                        issues.push({
                            type: 'BROKEN_CHAIN',
                            message: 'Previous hash does not match'
                        });
                        console.log("   ❌ BROKEN CHAIN");
                    }
                }

                if (issues.length === 0) {
                    console.log("   ✅ VALID");
                } else {
                    isValid = false;
                    tamperedBlocks.push({
                        block_index: block.block_index,
                        property_id: block.property_id,
                        issues
                    });
                }
            }

            console.log("\n🔍 ========================================");
            console.log(`✅ Valid: ${chain.length - tamperedBlocks.length} | ❌ Tampered: ${tamperedBlocks.length}`);
            console.log("🔍 ========================================\n");

            return {
                isValid,
                totalBlocks: chain.length,
                validBlocks: chain.length - tamperedBlocks.length,
                tamperedBlocks,
                chain: chain.map(b => ({
                    block_index: b.block_index,
                    property_id: b.property_id,
                    hash: b.blockchain_hash,
                    previous_hash: b.previous_hash,
                    mined_at: b.mined_at
                }))
            };

        } catch (err) {
            console.error("❌ Detection error:", err);
            throw err;
        }
    }

    // 2️⃣ SIMULATE TAMPERING
    async simulateTampering(blockIndex, tamperingType = 'MODIFY_DATA') {
        try {
            console.log("\n⚠️  SIMULATING TAMPERING - Block", blockIndex);

            const blockResult = await pool.query(
                `SELECT * FROM blockchain WHERE block_index = $1`,
                [blockIndex]
            );

            if (blockResult.rows.length === 0) {
                throw new Error(`Block ${blockIndex} not found`);
            }

            const block = blockResult.rows[0];
            let query, params, description;

            switch (tamperingType) {
                case 'MODIFY_DATA':
                    const modifiedData = JSON.parse(block.transaction_data);
                    modifiedData.owner_name = "⚠️ FAKE OWNER - TAMPERED";
                    modifiedData.tampered = true;
                    
                    query = `UPDATE blockchain SET transaction_data = $1 WHERE block_index = $2 RETURNING *`;
                    params = [JSON.stringify(modifiedData), blockIndex];
                    description = "Modified transaction data";
                    break;

                case 'CHANGE_HASH':
                    const fakeHash = crypto.randomBytes(32).toString('hex');
                    query = `UPDATE blockchain SET blockchain_hash = $1 WHERE block_index = $2 RETURNING *`;
                    params = [fakeHash, blockIndex];
                    description = "Changed hash to random value";
                    break;

                case 'BREAK_CHAIN':
                    const fakePrevHash = crypto.randomBytes(32).toString('hex');
                    query = `UPDATE blockchain SET previous_hash = $1 WHERE block_index = $2 RETURNING *`;
                    params = [fakePrevHash, blockIndex];
                    description = "Broke chain linkage";
                    break;

                case 'MODIFY_NONCE':
                    const fakeNonce = Math.floor(Math.random() * 1000000);
                    query = `UPDATE blockchain SET nonce = $1 WHERE block_index = $2 RETURNING *`;
                    params = [fakeNonce, blockIndex];
                    description = "Changed nonce value";
                    break;

                default:
                    throw new Error(`Unknown tampering type: ${tamperingType}`);
            }

            const result = await pool.query(query, params);
            console.log("⚠️  Tampering applied:", description);

            return {
                success: true,
                tamperingType,
                description,
                originalBlock: block,
                tamperedBlock: result.rows[0]
            };

        } catch (err) {
            console.error("❌ Tampering error:", err);
            throw err;
        }
    }

    // 3️⃣ RESTORE BLOCK
    async restoreBlock(blockIndex) {
        try {
            console.log("\n🔧 RESTORING BLOCK", blockIndex);

            const blockResult = await pool.query(
                `SELECT * FROM blockchain WHERE block_index = $1`,
                [blockIndex]
            );

            if (blockResult.rows.length === 0) {
                throw new Error(`Block ${blockIndex} not found`);
            }

            const block = blockResult.rows[0];
            const correctHash = this.calculateHash(block);

            await pool.query(
                `UPDATE blockchain SET blockchain_hash = $1 WHERE block_index = $2`,
                [correctHash, blockIndex]
            );

            console.log("✅ Block restored successfully");

            return { success: true, restoredHash: correctHash };

        } catch (err) {
            console.error("❌ Restoration error:", err);
            throw err;
        }
    }

    // 4️⃣ COMPARE HASHES
    async compareHashes(blockIndex) {
        try {
            const blockResult = await pool.query(
                `SELECT * FROM blockchain WHERE block_index = $1`,
                [blockIndex]
            );

            if (blockResult.rows.length === 0) {
                throw new Error(`Block ${blockIndex} not found`);
            }

            const block = blockResult.rows[0];
            const calculatedHash = this.calculateHash(block);

            return {
                blockIndex,
                storedHash: block.blockchain_hash,
                calculatedHash,
                isValid: block.blockchain_hash === calculatedHash
            };

        } catch (err) {
            console.error("❌ Comparison error:", err);
            throw err;
        }
    }
}

export default new BlockchainTamperingService();