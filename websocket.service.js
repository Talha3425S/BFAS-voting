import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import pkg from 'pg';
import p2pSchemaService from './p2pSchema.service.js';

const { Pool } = pkg;

const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'landdb',
  password: process.env.DB_PASSWORD || 'postgres',
  port: process.env.DB_PORT || 5432,
});

let io = null;

const activeConnections = new Map(); // userId -> socket.id
const userSockets = new Map(); // socket.id -> userId

// ─────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────
function initializeSocketIO(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: '*',
      credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000
  });

  io.use(authenticateSocket);
  io.on('connection', handleConnection);

  console.log('✅ Socket.IO server initialized');
  return io;
}

// ─────────────────────────────────────────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────────────────────────────────────────
async function authenticateSocket(socket, next) {
  try {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication required'));

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    socket.userId = decoded.userId;
    socket.userRole = decoded.role;
    next();
  } catch (err) {
    console.error('Socket auth failed:', err.message);
    next(new Error('Invalid authentication token'));
  }
}

// ─────────────────────────────────────────────────────────────────
// CONNECTION HANDLER — ALL socket.on() calls are INSIDE this function
// ─────────────────────────────────────────────────────────────────
function handleConnection(socket) {
  const userId = socket.userId;
  console.log(`✅ User connected: ${userId} (${socket.id})`);

  // Disconnect stale socket for this user
  const existingSocketId = activeConnections.get(userId);
  if (existingSocketId && existingSocketId !== socket.id) {
    const oldSocket = io.sockets.sockets.get(existingSocketId);
    if (oldSocket) {
      console.log(`⚠️ Disconnecting stale socket ${existingSocketId} for user ${userId}`);
      oldSocket.disconnect(true);
    }
    userSockets.delete(existingSocketId);
  }

  activeConnections.set(userId, socket.id);
  userSockets.set(socket.id, userId);

  // ── JOIN CHANNEL ──────────────────────────────────────────────
  socket.on('join_channel', async (data) => {
    let client;
    try {
      const { channelId } = data;

      client = await pool.connect();
      const participant = await client.query(
        'SELECT role FROM channel_participants WHERE channel_id = $1 AND user_id = $2',
        [channelId, userId]
      );

      if (participant.rows.length === 0) {
        socket.emit('error', { message: 'Unauthorized: Not a participant' });
        return;
      }

      const role = participant.rows[0].role;

      await client.query(
        'UPDATE channel_participants SET is_online = true, last_seen = NOW() WHERE channel_id = $1 AND user_id = $2',
        [channelId, userId]
      );

      const onlineRows = await client.query(
        `SELECT cp.user_id, cp.role FROM channel_participants cp
         WHERE cp.channel_id = $1 AND cp.is_online = true AND cp.user_id != $2`,
        [channelId, userId]
      );

      socket.leave(channelId);
      socket.join(channelId);

      socket.to(channelId).emit('user_joined', { userId, role, timestamp: new Date() });
      for (const row of onlineRows.rows) {
        socket.emit('user_joined', { userId: row.user_id, role: row.role, timestamp: new Date(), alreadyOnline: true });
      }

      socket.emit('self_joined', { userId, role, timestamp: new Date() });

      console.log(`User ${userId} joined channel ${channelId} as ${role}. Already online peers: ${onlineRows.rows.length}`);

    } catch (err) {
      console.error('Error joining channel:', err);
      socket.emit('error', { message: 'Failed to join channel' });
    } finally {
      client?.release();
    }
  });

  // ── SEND MESSAGE ──────────────────────────────────────────────
  socket.on('send_message', async (data) => {
    try {
      const { channelId, message, messageType = 'TEXT' } = data;
      const safeMessageType = String(messageType || 'TEXT').trim().toUpperCase();

      await p2pSchemaService.ensureSchema();

      console.log(`📨 send_message from ${userId} channel=${channelId} msg="${message}"`);

      if (!channelId || !message || !String(message).trim()) {
        socket.emit('error', { message: 'Invalid message data' });
        return;
      }

      const client = await pool.connect();

      const participant = await client.query(
        'SELECT role FROM channel_participants WHERE channel_id = $1 AND user_id = $2',
        [channelId, userId]
      );

      if (participant.rows.length === 0) {
        client.release();
        socket.emit('error', { message: 'Unauthorized: Not a participant' });
        return;
      }

      const senderRole = participant.rows[0].role;

      const transferRow = await client.query(
        'SELECT transfer_id FROM transfer_requests WHERE channel_id = $1',
        [channelId]
      );
      const transferId = transferRow.rows[0]?.transfer_id || null;

      let result;
      try {
        result = await client.query(`
          INSERT INTO channel_messages
            (channel_id, transfer_id, sender_id, sender_role, message_type, message_content)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING *
        `, [channelId, transferId, userId, senderRole, safeMessageType, String(message).trim()]);
      } catch (insertErr) {
        if (insertErr.code === '42703') {
          result = await client.query(`
            INSERT INTO channel_messages
              (channel_id, sender_id, sender_role, message_type, message_content)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
          `, [channelId, userId, senderRole, safeMessageType, String(message).trim()]);
        } else {
          throw insertErr;
        }
      }

      client.release();

      const saved = result.rows[0];
      console.log(`✅ Message saved id=${saved.message_id}`);

      socket.to(channelId).emit('new_message', {
        messageId: saved.message_id,
        senderId: userId,
        senderRole: senderRole,
        messageType: safeMessageType,
        messageContent: String(message).trim(),
        timestamp: saved.timestamp || saved.created_at || new Date(),
        isSystemMessage: false
      });

    } catch (err) {
      console.error('Error sending message:', err);
      socket.emit('error', { message: 'Failed to send message: ' + err.message });
    }
  });

  // ── SEND PRICE OFFER ──────────────────────────────────────────
  socket.on('send_price_offer', async (data) => {
    try {
      const { channelId, offeredPrice } = data;
      await p2pSchemaService.ensureSchema();

      const client = await pool.connect();

      const participant = await client.query(
        'SELECT role FROM channel_participants WHERE channel_id = $1 AND user_id = $2',
        [channelId, userId]
      );

      if (participant.rows.length === 0) {
        client.release();
        socket.emit('error', { message: 'Unauthorized' });
        return;
      }

      const senderRole = participant.rows[0].role;

      const transferRow = await client.query(
        'SELECT transfer_id FROM transfer_requests WHERE channel_id = $1',
        [channelId]
      );
      const transferId = transferRow.rows[0]?.transfer_id || null;

      let result;
      try {
        result = await client.query(`
          INSERT INTO channel_messages
            (channel_id, transfer_id, sender_id, sender_role, message_type, message_content, price_offer)
          VALUES ($1, $2, $3, $4, 'PRICE_OFFER', $5, $6)
          RETURNING *
        `, [channelId, transferId, userId, senderRole,
          `Offered price: PKR ${Number(offeredPrice).toLocaleString()}`, offeredPrice]);
      } catch (insertErr) {
        if (insertErr.code === '42703') {
          result = await client.query(`
            INSERT INTO channel_messages
              (channel_id, sender_id, sender_role, message_type, message_content, price_offer)
            VALUES ($1, $2, $3, 'PRICE_OFFER', $4, $5)
            RETURNING *
          `, [channelId, userId, senderRole,
            `Offered price: PKR ${Number(offeredPrice).toLocaleString()}`, offeredPrice]);
        } else {
          throw insertErr;
        }
      }

      client.release();

      const saved = result.rows[0];

      socket.to(channelId).emit('new_message', {
        messageId: saved.message_id,
        senderId: userId,
        senderRole: senderRole,
        messageType: 'PRICE_OFFER',
        messageContent: saved.message_content,
        priceOffer: offeredPrice,
        timestamp: saved.timestamp || saved.created_at || new Date(),
        isSystemMessage: false
      });

      console.log(`Price offer ${offeredPrice} sent in channel ${channelId}`);

    } catch (err) {
      console.error('Error sending price offer:', err);
      socket.emit('error', { message: 'Failed to send price offer' });
    }
  });

  // ── AGREE TO DEAL ──────────────────────────────────────────
  socket.on('agree_to_deal', async (data) => {
    try {
      const { channelId, agreedTerms, agreedPrice } = data;

      const client = await pool.connect();
      await client.query('BEGIN');

      const participant = await client.query(
        'SELECT role FROM channel_participants WHERE channel_id = $1 AND user_id = $2',
        [channelId, userId]
      );
      if (participant.rows.length === 0) {
        await client.query('ROLLBACK');
        client.release();
        socket.emit('error', { message: 'Unauthorized' });
        return;
      }

      const role = participant.rows[0].role;
      const columnName = role === 'SELLER' ? 'seller_agreed' : 'buyer_agreed';
      const timestampColumn = role === 'SELLER' ? 'seller_agreed_at' : 'buyer_agreed_at';
      const parsedPrice = agreedPrice ? parseFloat(agreedPrice) : null;

      if (parsedPrice && parsedPrice > 0) {
        await client.query(`
          UPDATE transfer_requests
          SET ${columnName} = true,
              ${timestampColumn} = NOW(),
              agreed_price = $3,
              agreement_text = COALESCE(agreement_text, $2)
          WHERE channel_id = $1
        `, [channelId, agreedTerms || 'I agree.', parsedPrice]);
      } else {
        await client.query(`
          UPDATE transfer_requests
          SET ${columnName} = true,
              ${timestampColumn} = NOW(),
              agreement_text = COALESCE(agreement_text, $2)
          WHERE channel_id = $1
        `, [channelId, agreedTerms || 'I agree.']);
      }

      const status = await client.query(
        'SELECT seller_agreed, buyer_agreed, agreed_price FROM transfer_requests WHERE channel_id = $1',
        [channelId]
      );
      const row = status.rows[0] || {};
      const bothAgreed = row.seller_agreed && row.buyer_agreed;
      let challanPayload = null;
      let challanMsgId = null;
      const finalPrice = parsedPrice || parseFloat(row.agreed_price || 0);

      if (bothAgreed) {
        await client.query(`
          UPDATE transfer_requests
          SET channel_status = 'AGREED', agreement_timestamp = NOW()
          WHERE channel_id = $1
        `, [channelId]);

        // Pre-fetch transfer_id to avoid reusing $1 in both INSERT value and WHERE,
        // which causes PostgreSQL error 42P08 (inconsistent types for parameter $1).
        const trPrefetch = await client.query(
          'SELECT transfer_id FROM transfer_requests WHERE channel_id = $1',
          [channelId]
        );
        const preFetchedTransferId = trPrefetch.rows[0]?.transfer_id || null;

        await client.query(`
          INSERT INTO channel_messages
            (channel_id, transfer_id, sender_id, sender_role, message_type, message_content, is_system_message)
          VALUES ($1, $2, $3, 'SYSTEM', 'SYSTEM', $4, true)
        `, [
          channelId,
          preFetchedTransferId,
          userId,
          `🤝 Both parties agreed at PKR ${Number(finalPrice||0).toLocaleString('en-PK')}. Challan generated below.`,
        ]);

        // ── Generate CHALLAN message with full details ──
        try {
          const cdRow = await client.query(`
            SELECT
              tr.transfer_id, tr.seller_id, tr.buyer_id,
              p.property_id, p.district, p.tehsil, p.mauza, p.area_marla,
              p.khasra_no, p.khewat_no,
              s.name        AS seller_name,   s.cnic  AS seller_cnic,   s.father_name AS seller_father,
              b.name        AS buyer_name,    b.cnic  AS buyer_cnic,    b.father_name AS buyer_father,
              sa.account_no AS seller_account_no
            FROM transfer_requests tr
            JOIN properties    p  ON tr.property_id = p.property_id
            JOIN users         s  ON tr.seller_id   = s.user_id
            JOIN users         b  ON tr.buyer_id    = b.user_id
            LEFT JOIN bank_accounts sa ON sa.user_id = tr.seller_id AND sa.is_active = true
            WHERE tr.channel_id = $1
            LIMIT 1
          `, [channelId]);

          if (cdRow.rows.length > 0) {
            const cd = cdRow.rows[0];
            challanPayload = JSON.stringify({
              challanType: 'PROPERTY_TRANSFER',
              status: 'UNPAID',
              agreedPrice: finalPrice,
              transferId: cd.transfer_id,
              sellerId: cd.seller_id,
              buyerId: cd.buyer_id,
              property: {
                propertyId: cd.property_id,
                district: cd.district,
                tehsil: cd.tehsil,
                mauza: cd.mauza,
                areaMarla: cd.area_marla,
                khasraNo: cd.khasra_no,
                khewatNo: cd.khewat_no,
              },
              seller: {
                userId: cd.seller_id,
                name: cd.seller_name,
                cnic: cd.seller_cnic,
                fatherName: cd.seller_father,
                accountNo: cd.seller_account_no,
              },
              buyer: {
                userId: cd.buyer_id,
                name: cd.buyer_name,
                cnic: cd.buyer_cnic,
                fatherName: cd.buyer_father,
              },
              generatedAt: new Date().toISOString(),
            });

            const challanInsert = await client.query(`
              INSERT INTO channel_messages
                (channel_id, transfer_id, sender_id, sender_role, message_type, message_content, is_system_message)
              VALUES ($1, $2, $3, 'SYSTEM', 'CHALLAN', $4, false)
              RETURNING message_id
            `, [channelId, preFetchedTransferId, userId, challanPayload]);
            challanMsgId = challanInsert.rows[0]?.message_id;
          }
        } catch (challanErr) {
          console.error('⚠️ Challan generation error (non-fatal):', challanErr.message);
        }
      }

      await client.query('COMMIT');
      client.release();

      io.to(channelId).emit('agreement_updated', {
        role, agreed: true, bothAgreed,
        agreedPrice: finalPrice || null,
        timestamp: new Date()
      });

      if (bothAgreed) {
        io.to(channelId).emit('both_agreed', {
          message: 'Both parties agreed. Challan generated in chat.',
          agreedPrice: finalPrice || null,
          timestamp: new Date()
        });

        if (challanPayload) {
          io.to(channelId).emit('new_message', {
            messageId: challanMsgId,
            senderId: 0,
            senderRole: 'SYSTEM',
            messageType: 'CHALLAN',
            messageContent: challanPayload,
            isSystemMessage: false,
            timestamp: new Date(),
          });
        }
      }

      console.log(`${role} agreed in channel ${channelId} @ PKR ${finalPrice}. Both: ${bothAgreed}`);
    } catch (err) {
      console.error('Error recording agreement:', err);
      socket.emit('error', { message: 'Failed to record agreement' });
    }
  });

  // ── CHALLAN SUBMITTED ──────────────────────────────────────────
  socket.on('notify_challan_submitted', (data) => {
    try {
      const { channelId, buyerSignature, verifyAccountNo, buyerBalance } = data;
      if (!channelId) return;

      console.log('📄 Challan submitted event:', channelId);

      io.to(channelId).emit('challan_submitted', {
        message: 'Buyer submitted signed challan with account verification',
        buyerSignature: buyerSignature.substring(0, 50) + '...',
        verifiedAccount: verifyAccountNo,
        buyerBalance: buyerBalance,
        timestamp: new Date(),
      });

    } catch (err) {
      console.error('Error in notify_challan_submitted:', err);
    }
  });

  // ── CHALLAN PAYMENT CONFIRMED ──────────────────────────────────────────
  socket.on('notify_payment_done', (data) => {
    try {
      const { channelId, txnRef, amount, buyerName, sellerBalanceAfter, buyerBalanceAfter } = data || {};
      if (!channelId) return;

      io.to(channelId).emit('payment_received', {
        txnRef,
        amount,
        buyerName,
        sellerBalanceAfter,
        buyerBalanceAfter,
        timestamp: new Date(),
      });

      io.to(channelId).emit('challan_payment_confirmed', {
        txnRef,
        amount,
        status: 'PAID',
        buyerBalanceAfter,
        sellerBalanceAfter,
        timestamp: new Date(),
        message: 'Payment verified. Both parties can download the challan.',
      });
    } catch (err) {
      console.error('Error in notify_payment_done:', err);
    }
  });

  socket.on('confirm_challan_payment', async (data) => {
    try {
      const { channelId, transferId, txnRef, buyerBalanceAfter, sellerBalanceAfter, amount, buyerName } = data;
      if (!channelId) return;

      console.log('✅ Challan payment confirmed:', txnRef);

      io.to(channelId).emit('payment_received', {
        txnRef,
        amount,
        buyerName,
        buyerBalanceAfter,
        sellerBalanceAfter,
        timestamp: new Date(),
      });

      io.to(channelId).emit('challan_payment_confirmed', {
        txnRef,
        amount,
        status: 'PAID',
        buyerBalanceAfter,
        sellerBalanceAfter,
        timestamp: new Date(),
        message: '🎉 Payment verified! Both parties can download the challan.',
      });

    } catch (err) {
      console.error('Error in confirm_challan_payment:', err);
    }
  });

  // ── LEAVE CHANNEL ─────────────────────────────────────────────
  socket.on('leave_channel', async (data) => {
    try {
      const { channelId } = data;
      socket.leave(channelId);

      const client = await pool.connect();
      const pRow = await client.query(
        'SELECT role FROM channel_participants WHERE channel_id = $1 AND user_id = $2',
        [channelId, userId]
      );
      const role = pRow.rows[0]?.role || 'UNKNOWN';
      await client.query(
        'UPDATE channel_participants SET is_online = false, last_seen = NOW() WHERE channel_id = $1 AND user_id = $2',
        [channelId, userId]
      );
      client.release();

      socket.to(channelId).emit('user_left', { userId, role, timestamp: new Date() });
      console.log(`User ${userId} left channel ${channelId}`);

    } catch (err) {
      console.error('Error leaving channel:', err);
    }
  });

  // ── TYPING ────────────────────────────────────────────────────
  socket.on('typing', (data) => {
    const { channelId } = data || {};
    if (channelId) {
      socket.to(channelId).emit('typing', { userId, timestamp: new Date() });
    }
  });

  // ── DISCONNECT ────────────────────────────────────────────────
  socket.on('disagreed', (data) => {
    try {
      const { channelId, reason } = data || {};
      if (!channelId) return;
      socket.to(channelId).emit('disagreed', {
        userId,
        reason: reason || '',
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('Error in disagreed event:', err);
    }
  });

  socket.on('disconnect', async () => {
    try {
      console.log(`❌ User disconnected: ${userId} (${socket.id})`);
      activeConnections.delete(userId);
      userSockets.delete(socket.id);

      const client = await pool.connect();
      await client.query(
        'UPDATE channel_participants SET is_online = false, last_seen = NOW() WHERE user_id = $1',
        [userId]
      );
      client.release();

    } catch (err) {
      console.error('Error handling disconnect:', err);
    }
  });

} // ← end of handleConnection

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────
function emitToChannel(channelId, eventName, data) {
  if (io) io.to(channelId).emit(eventName, data);
}

function emitToUser(uid, eventName, data) {
  const socketId = activeConnections.get(uid);
  if (io && socketId) io.to(socketId).emit(eventName, data);
}

async function getOnlineUsers(channelId) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT user_id, role FROM channel_participants WHERE channel_id = $1 AND is_online = true',
      [channelId]
    );
    return result.rows;
  } finally {
    client.release();
  }
}

function isUserOnline(uid) {
  return activeConnections.has(uid);
}

export default { initializeSocketIO, emitToChannel, emitToUser, getOnlineUsers, isUserOnline };
