/**
 * CHANNEL SERVICE
 * All INSERT-SELECT statements that reused $1 in both the column list and the
 * WHERE clause (PostgreSQL error 42P08 "inconsistent types for $1") have been
 * fixed by pre-fetching the needed row first, then using INSERT...VALUES.
 */

import pkg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import websocketService from './websocket.service.js';
import p2pSchemaService from './p2pSchema.service.js';

const { Pool } = pkg;

const pool = new Pool({
  user:     process.env.DB_USER     || 'postgres',
  host:     process.env.DB_HOST     || 'localhost',
  database: process.env.DB_NAME     || 'land_registry',
  password: process.env.DB_PASSWORD || 'postgres',
  port:     process.env.DB_PORT     || 5432,
});

// ─────────────────────────────────────────────────────────────────
// 1. CREATE CHANNEL
// ─────────────────────────────────────────────────────────────────
async function createChannel(transferId, sellerId, buyerId) {
  await p2pSchemaService.ensureSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const channelId = `ch-${uuidv4()}`;

    const existingChannel = await client.query(
      'SELECT channel_id FROM transfer_requests WHERE transfer_id = $1 AND channel_id IS NOT NULL',
      [transferId]
    );
    if (existingChannel.rows.length > 0) {
      throw new Error('Channel already exists for this transfer');
    }

    await client.query(`
      UPDATE transfer_requests
      SET channel_id = $1, channel_created_at = NOW(), channel_status = 'INACTIVE'
      WHERE transfer_id = $2
    `, [channelId, transferId]);

    await client.query(`
      INSERT INTO channel_participants (channel_id, user_id, role)
      VALUES ($1, $2, 'SELLER'), ($1, $3, 'BUYER')
    `, [channelId, sellerId, buyerId]);

    await client.query(`
      INSERT INTO channel_messages
        (channel_id, transfer_id, sender_id, sender_role, message_type, message_content, is_system_message)
      VALUES ($1, $2, $3, 'BUYER', 'SYSTEM', 'Channel created. Waiting for seller acceptance.', true)
    `, [channelId, transferId, buyerId]);

    await client.query('COMMIT');
    return {
      success: true, channelId,
      participants: [{ userId: sellerId, role: 'SELLER' }, { userId: buyerId, role: 'BUYER' }],
      status: 'INACTIVE', createdAt: new Date(),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────
// 2. ACTIVATE CHANNEL
// ─────────────────────────────────────────────────────────────────
async function activateChannel(channelId) {
  await p2pSchemaService.ensureSchema();
  const client = await pool.connect();
  try {
    const result = await client.query(`
      UPDATE transfer_requests
      SET channel_status = 'ACTIVE'
      WHERE channel_id = $1
      RETURNING transfer_id, buyer_id, channel_status
    `, [channelId]);

    if (result.rows.length === 0) throw new Error('Channel not found');
    const { transfer_id, buyer_id } = result.rows[0];

    // INSERT...VALUES (pre-fetched IDs) to avoid $1 type-inference conflict
    await client.query(`
      INSERT INTO channel_messages
        (channel_id, transfer_id, sender_id, sender_role, message_type, message_content, is_system_message)
      VALUES ($1, $2, $3, 'BUYER', 'SYSTEM', $4, true)
    `, [channelId, transfer_id, buyer_id, '✅ Chat is now active. You can negotiate the price here.']);

    return { success: true, channelId, status: 'ACTIVE' };
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────
// 3. SEND MESSAGE
// ─────────────────────────────────────────────────────────────────
async function sendMessage(channelId, senderId, messageType, messageContent, priceOffer = null) {
  await p2pSchemaService.ensureSchema();
  const client = await pool.connect();
  try {
    const participant = await client.query(
      'SELECT role FROM channel_participants WHERE channel_id = $1 AND user_id = $2',
      [channelId, senderId]
    );
    if (participant.rows.length === 0) throw new Error('User is not a participant');

    const senderRole = participant.rows[0].role;
    const transfer = await client.query(
      'SELECT transfer_id FROM transfer_requests WHERE channel_id = $1 LIMIT 1',
      [channelId]
    );
    const transferId = transfer.rows[0]?.transfer_id;

    const result = await client.query(`
      INSERT INTO channel_messages
        (channel_id, transfer_id, sender_id, sender_role, message_type, message_content, price_offer)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [channelId, transferId, senderId, senderRole, messageType, messageContent, priceOffer]);

    await client.query(`
      UPDATE transfer_requests
      SET channel_status = 'NEGOTIATING'
      WHERE channel_id = $1 AND channel_status = 'ACTIVE'
    `, [channelId]);

    return { success: true, message: result.rows[0] };
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────
// 4. RECORD AGREEMENT — auto-generates CHALLAN when both agree
// ─────────────────────────────────────────────────────────────────
async function recordAgreement(channelId, userId, agreedTerms, agreedPrice = null) {
  await p2pSchemaService.ensureSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const participant = await client.query(
      'SELECT role FROM channel_participants WHERE channel_id = $1 AND user_id = $2',
      [channelId, userId]
    );
    if (participant.rows.length === 0) throw new Error('User is not a participant');
    const role = participant.rows[0].role;

    // Pre-fetch transfer row — avoids $1 type-inference conflict in INSERT-SELECT
    const trFetch = await client.query(
      'SELECT transfer_id, transfer_amount, agreed_price FROM transfer_requests WHERE channel_id = $1',
      [channelId]
    );
    if (trFetch.rows.length === 0) throw new Error('Channel has no linked transfer');

    const transferId          = trFetch.rows[0].transfer_id;
    const transferAmount      = parseFloat(trFetch.rows[0].transfer_amount || 0);
    const existingAgreedPrice = parseFloat(trFetch.rows[0].agreed_price || 0);

    const finalAgreedPrice =
      agreedPrice !== null && agreedPrice !== undefined && agreedPrice !== ''
        ? parseFloat(agreedPrice)
        : (existingAgreedPrice > 0 ? existingAgreedPrice : transferAmount);

    if (!Number.isFinite(finalAgreedPrice) || finalAgreedPrice <= 0) {
      throw new Error('A valid agreed price is required before confirmation');
    }

    const columnName      = role === 'SELLER' ? 'seller_agreed' : 'buyer_agreed';
    const timestampColumn = role === 'SELLER' ? 'seller_agreed_at' : 'buyer_agreed_at';

    await client.query(`
      UPDATE transfer_requests
      SET ${columnName} = true,
          ${timestampColumn} = NOW(),
          agreed_price = $2,
          transfer_amount = CASE
            WHEN COALESCE(transfer_amount, 0) <= 0 THEN $2
            ELSE transfer_amount
          END,
          agreement_text = COALESCE(agreement_text, $3)
      WHERE channel_id = $1
    `, [channelId, finalAgreedPrice, agreedTerms]);

    const senderLabel = role === 'SELLER' ? '🤝 Seller' : '🤝 Buyer';
    await client.query(`
      INSERT INTO channel_messages
        (channel_id, transfer_id, sender_id, sender_role, message_type, message_content, is_system_message)
      VALUES ($1, $2, $3, $4, 'SYSTEM', $5, true)
    `, [
      channelId, transferId, userId, role,
      `${senderLabel} has agreed to the terms at PKR ${Number(finalAgreedPrice).toLocaleString('en-PK')}.`,
    ]);

    const agreementStatus = await client.query(`
      SELECT seller_agreed, buyer_agreed, agreed_price, transfer_id,
             seller_id, buyer_id,
             seller.name  AS seller_name, seller.cnic AS seller_cnic,
             buyer.name   AS buyer_name,  buyer.cnic  AS buyer_cnic,
             p.property_id, p.district, p.tehsil, p.mauza,
             p.area_marla, p.khasra_no, p.khewat_no
      FROM transfer_requests tr
      JOIN users seller ON tr.seller_id = seller.user_id
      JOIN users buyer  ON tr.buyer_id  = buyer.user_id
      JOIN properties p ON tr.property_id = p.property_id
      WHERE tr.channel_id = $1
    `, [channelId]);

    const row        = agreementStatus.rows[0];
    const bothAgreed = row.seller_agreed && row.buyer_agreed;

    if (bothAgreed) {
      await client.query(`
        UPDATE transfer_requests
        SET channel_status = 'AGREED', agreement_timestamp = NOW()
        WHERE channel_id = $1
      `, [channelId]);

      const challanId  = `CHAL-${Date.now()}`;
      const finalPrice = parseFloat(row.agreed_price) || finalAgreedPrice;

      const challanPayload = {
        challanId, type: 'CHALLAN', issuedAt: new Date().toISOString(), status: 'PENDING',
        transferId: row.transfer_id, channelId, agreedPrice: finalPrice,
        seller: { userId: row.seller_id, name: row.seller_name, cnic: row.seller_cnic },
        buyer:  { userId: row.buyer_id,  name: row.buyer_name,  cnic: row.buyer_cnic  },
        property: {
          propertyId: row.property_id, district: row.district, tehsil: row.tehsil,
          mauza: row.mauza, areaMarla: row.area_marla, khasraNo: row.khasra_no, khewatNo: row.khewat_no,
        },
        instructions: 'Buyer must pay the agreed amount to complete this property transfer.',
      };

      await client.query(`
        INSERT INTO channel_messages
          (channel_id, transfer_id, sender_id, sender_role, message_type, message_content, is_system_message)
        VALUES ($1, $2, $3, 'SYSTEM', 'CHALLAN', $4, false)
      `, [channelId, row.transfer_id, row.buyer_id, JSON.stringify(challanPayload)]);

      await client.query('COMMIT');

      try {
        websocketService.sendToChannel?.(channelId, 'challan_issued', {
          channelId, challanId, agreedPrice: finalPrice, buyerUserId: row.buyer_id,
          message: '📄 Challan has been issued. Buyer, please proceed to payment.',
        });
      } catch (_) { /* WS failure is non-fatal */ }

      return { success: true, role, agreed: true, bothAgreed: true, challanIssued: true, challanId, agreedPrice: finalPrice, timestamp: new Date() };
    }

    await client.query('COMMIT');
    return { success: true, role, agreed: true, bothAgreed: false, timestamp: new Date() };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────
// 4b. RECORD DISAGREEMENT
// ─────────────────────────────────────────────────────────────────
async function recordDisagreement(channelId, userId, reason = '') {
  await p2pSchemaService.ensureSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const participant = await client.query(
      'SELECT role FROM channel_participants WHERE channel_id = $1 AND user_id = $2',
      [channelId, userId]
    );
    if (participant.rows.length === 0) throw new Error('User is not a participant');
    const role = participant.rows[0].role;

    await client.query(`
      UPDATE transfer_requests
      SET seller_agreed = false, buyer_agreed = false, channel_status = 'NEGOTIATING'
      WHERE channel_id = $1
    `, [channelId]);

    // Pre-fetch transfer_id — avoids $1 type-inference conflict in INSERT-SELECT
    const trFetch = await client.query(
      'SELECT transfer_id FROM transfer_requests WHERE channel_id = $1 LIMIT 1',
      [channelId]
    );
    if (trFetch.rows.length > 0) {
      const label = role === 'SELLER' ? '❌ Seller' : '❌ Buyer';
      await client.query(`
        INSERT INTO channel_messages
          (channel_id, transfer_id, sender_id, sender_role, message_type, message_content, is_system_message)
        VALUES ($1, $2, $3, $4, 'SYSTEM', $5, true)
      `, [
        channelId, trFetch.rows[0].transfer_id, userId, role,
        `${label} has disagreed. ${reason ? reason + ' ' : ''}Please continue negotiating.`,
      ]);
    }

    await client.query('COMMIT');
    return { success: true, role, disagreed: true, timestamp: new Date() };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────
// 5. UPLOAD SCREENSHOT
// ─────────────────────────────────────────────────────────────────
async function uploadScreenshot(channelId, screenshotUrl, agreedPrice, agreedTerms) {
  await p2pSchemaService.ensureSchema();
  const client = await pool.connect();
  try {
    const agreementCheck = await client.query(
      `SELECT seller_agreed, buyer_agreed, payment_status, challan_txn_id,
              transfer_id, buyer_id
       FROM transfer_requests
       WHERE channel_id = $1`,
      [channelId]
    );
    if (agreementCheck.rows.length === 0) throw new Error('Channel not found');

    const { seller_agreed, buyer_agreed, payment_status, challan_txn_id,
            transfer_id, buyer_id } = agreementCheck.rows[0];
    const hasAgreement       = Boolean(seller_agreed && buyer_agreed);
    const hasCompletedPayment = payment_status === 'PAID' || Boolean(challan_txn_id);

    if (!hasAgreement && !hasCompletedPayment) {
      throw new Error('Payment or confirmed agreement is required before uploading receipt');
    }

    await client.query(`
      UPDATE transfer_requests
      SET agreement_screenshot_url = $1,
          agreed_price             = $2,
          agreement_text           = COALESCE(agreement_text, $3),
          channel_status           = 'AGREED'
      WHERE channel_id = $4
    `, [screenshotUrl, agreedPrice, agreedTerms, channelId]);

    // INSERT...VALUES with pre-fetched IDs — avoids $1 type-inference conflict
    await client.query(`
      INSERT INTO channel_messages
        (channel_id, transfer_id, sender_id, sender_role, message_type, message_content, is_system_message)
      VALUES ($1, $2, $3, 'BUYER', 'SCREENSHOT', $4, true)
    `, [channelId, transfer_id, buyer_id, '📎 Payment receipt uploaded. Awaiting LRO approval.']);

    return { success: true, screenshotUrl, agreedPrice, status: 'AGREED' };
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────
// 6. GET CHANNEL HISTORY
// ─────────────────────────────────────────────────────────────────
async function getChannelHistory(channelId, userId, limit = 50, offset = 0) {
  const client = await pool.connect();
  try {
    const participant = await client.query(
      'SELECT role FROM channel_participants WHERE channel_id = $1 AND user_id = $2',
      [channelId, userId]
    );
    if (participant.rows.length === 0) throw new Error('Unauthorized: User is not a participant');

    const messages = await client.query(`
      SELECT
        m.message_id, m.sender_id, m.sender_role, m.message_type,
        m.message_content, m.price_offer, m.timestamp, m.is_system_message,
        u.name as sender_name
      FROM channel_messages m
      LEFT JOIN users u ON m.sender_id = u.user_id
      WHERE m.channel_id = $1
      ORDER BY m.timestamp ASC
      LIMIT $2 OFFSET $3
    `, [channelId, limit, offset]);

    return { success: true, messages: messages.rows, count: messages.rows.length };
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────
// 7. GET CHANNEL DETAILS
// ─────────────────────────────────────────────────────────────────
async function getChannelDetails(channelId, userId) {
  const client = await pool.connect();
  try {
    const participant = await client.query(
      'SELECT role FROM channel_participants WHERE channel_id = $1 AND user_id = $2',
      [channelId, userId]
    );
    if (participant.rows.length === 0) throw new Error('Unauthorized: User is not a participant');

    const channel = await client.query(`
      SELECT
        tr.transfer_id, tr.channel_id, tr.channel_status, tr.channel_created_at,
        tr.agreement_screenshot_url, tr.agreement_text, tr.agreement_timestamp,
        tr.agreed_price, tr.seller_agreed, tr.buyer_agreed,
        tr.seller_agreed_at, tr.buyer_agreed_at,
        tr.property_id, tr.seller_id, tr.buyer_id,
        tr.transfer_amount,
        tr.payment_status, tr.challan_txn_id, tr.payment_completed_at,
        seller.name  AS seller_name, seller.cnic AS seller_cnic,
        buyer.name   AS buyer_name,  buyer.cnic  AS buyer_cnic,
        CONCAT(p.district, ', ', p.tehsil, ', ', p.mauza) AS property_location,
        p.area_marla AS property_size, p.district, p.tehsil, p.mauza
      FROM transfer_requests tr
      JOIN properties p      ON tr.property_id = p.property_id
      LEFT JOIN users seller ON tr.seller_id   = seller.user_id
      LEFT JOIN users buyer  ON tr.buyer_id    = buyer.user_id
      WHERE tr.channel_id = $1
    `, [channelId]);

    if (channel.rows.length === 0) throw new Error('Channel not found');

    const participants = await client.query(`
      SELECT cp.user_id, cp.role, cp.is_online, cp.last_seen, u.name
      FROM channel_participants cp
      JOIN users u ON cp.user_id = u.user_id
      WHERE cp.channel_id = $1
    `, [channelId]);

    return { success: true, channel: channel.rows[0], participants: participants.rows };
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────
// 8. CLOSE CHANNEL
// ─────────────────────────────────────────────────────────────────
async function closeChannel(channelId) {
  await p2pSchemaService.ensureSchema();
  const client = await pool.connect();
  try {
    await client.query(
      "UPDATE transfer_requests SET channel_status = 'CLOSED' WHERE channel_id = $1",
      [channelId]
    );
    await client.query(
      'UPDATE channel_participants SET is_online = false WHERE channel_id = $1',
      [channelId]
    );
    // Pre-fetch to avoid $1 type-inference conflict in INSERT-SELECT
    const trRow = await client.query(
      'SELECT transfer_id, buyer_id FROM transfer_requests WHERE channel_id = $1 LIMIT 1',
      [channelId]
    );
    if (trRow.rows.length > 0) {
      const { transfer_id, buyer_id } = trRow.rows[0];
      await client.query(`
        INSERT INTO channel_messages
          (channel_id, transfer_id, sender_id, sender_role, message_type, message_content, is_system_message)
        VALUES ($1, $2, $3, 'BUYER', 'SYSTEM', $4, true)
      `, [channelId, transfer_id, buyer_id, '🔒 Channel closed. Property transfer has been completed.']);
    }
    return { success: true, status: 'CLOSED' };
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────
// 9. VALIDATE CHANNEL ACCESS
// ─────────────────────────────────────────────────────────────────
async function validateChannelAccess(channelId, userId) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT role FROM channel_participants WHERE channel_id = $1 AND user_id = $2',
      [channelId, userId]
    );
    return { hasAccess: result.rows.length > 0, role: result.rows[0]?.role || null };
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────
// 10. GET USER CHANNELS
// ─────────────────────────────────────────────────────────────────
async function getUserChannels(userId) {
  const client = await pool.connect();
  try {
    const channels = await client.query(`
      SELECT
        tr.transfer_id,
        tr.channel_id, tr.channel_status, tr.channel_created_at,
        tr.property_id, tr.seller_agreed, tr.buyer_agreed,
        tr.seller_id, tr.buyer_id,
        tr.agreed_price, tr.transfer_amount,
        tr.payment_status, tr.challan_txn_id, tr.payment_completed_at,
        cp.role as user_role,
        p.district, p.tehsil, p.mauza,
        seller.name AS seller_name,
        buyer.name  AS buyer_name,
        CONCAT(p.district, ', ', p.tehsil, ', ', p.mauza) as property_location,
        COUNT(cm.message_id) as total_messages,
        MAX(cm.timestamp)    as last_message_at,
        COALESCE(SUM(
          CASE
            WHEN cm.sender_id IS NOT NULL
             AND cm.sender_id <> $1
             AND COALESCE(cm.read_by_other, false) = false
            THEN 1 ELSE 0
          END
        ), 0) as unread_count
      FROM channel_participants cp
      JOIN transfer_requests tr ON cp.channel_id = tr.channel_id
      JOIN properties p         ON tr.property_id = p.property_id
      LEFT JOIN users seller    ON tr.seller_id   = seller.user_id
      LEFT JOIN users buyer     ON tr.buyer_id    = buyer.user_id
      LEFT JOIN channel_messages cm ON cp.channel_id = cm.channel_id
      WHERE cp.user_id = $1
      GROUP BY
        tr.channel_id, tr.channel_status, tr.channel_created_at,
        tr.transfer_id, tr.property_id, tr.seller_agreed, tr.buyer_agreed,
        tr.seller_id, tr.buyer_id, tr.agreed_price, tr.transfer_amount,
        tr.payment_status, tr.challan_txn_id, tr.payment_completed_at,
        cp.role, p.district, p.tehsil, p.mauza, seller.name, buyer.name
      ORDER BY tr.channel_created_at DESC
    `, [userId]);
    return { success: true, channels: channels.rows };
  } finally {
    client.release();
  }
}

export default {
  createChannel,
  activateChannel,
  sendMessage,
  recordAgreement,
  recordDisagreement,
  uploadScreenshot,
  getChannelHistory,
  getChannelDetails,
  closeChannel,
  validateChannelAccess,
  getUserChannels,
};
