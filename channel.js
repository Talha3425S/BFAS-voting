/**
 * CHANNEL ROUTES — Updated
 * Changes:
 *  - Fixed duplicate /agree route (removed broken pool-based duplicate)
 *  - POST /:channelId/agree  now calls channelService.recordAgreement
 *  - POST /:channelId/disagree  NEW — calls channelService.recordDisagreement
 *  - All other routes unchanged
 */

import express from 'express';
import channelService from '../services/channel.service.js';
import { uploadScreenshot, handleUploadError, uploadChatMedia } from '../middleware/upload.js';
import jwt from 'jsonwebtoken';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────────────────────────────────────────
function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'No token provided' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default-jwt-secret');
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ success: false, message: 'Invalid token' });
  }
}

// ─────────────────────────────────────────────────────────────────
// POST /api/channels/create
// ─────────────────────────────────────────────────────────────────
router.post('/create', authenticateToken, async (req, res) => {
  try {
    const { transferId, sellerId, buyerId } = req.body;
    if (!transferId || !sellerId || !buyerId) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    const result = await channelService.createChannel(transferId, sellerId, buyerId);
    res.status(201).json(result);
  } catch (error) {
    console.error('Error creating channel:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/channels/:channelId/activate
// ─────────────────────────────────────────────────────────────────
router.post('/:channelId/activate', authenticateToken, async (req, res) => {
  try {
    const result = await channelService.activateChannel(req.params.channelId);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /api/channels/:channelId/messages
// ─────────────────────────────────────────────────────────────────
router.get('/:channelId/messages', authenticateToken, async (req, res) => {
  try {
    const { channelId } = req.params;
    const userId = req.user?.userId || req.query.userId;
    if (!userId) return res.status(401).json({ success: false, error: 'Auth required' });

    const result = await channelService.getChannelHistory(
      channelId, userId,
      parseInt(req.query.limit) || 50,
      parseInt(req.query.offset) || 0
    );
    res.status(200).json(result);
  } catch (error) {
    res.status(error.message.includes('Unauthorized') ? 403 : 500)
       .json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/channels/:channelId/send
// ─────────────────────────────────────────────────────────────────
router.post('/:channelId/send', authenticateToken, async (req, res) => {
  try {
    const { channelId } = req.params;
    const { message, messageType = 'TEXT', priceOffer } = req.body;
    const userId = req.user?.userId || req.body.userId;
    if (!userId || !message) {
      return res.status(400).json({ success: false, error: 'Missing userId or message' });
    }
    const result = await channelService.sendMessage(channelId, userId, messageType, message, priceOffer);
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/channels/:channelId/agree   ← FIXED (was duplicated + broken)
// Body: { agreedTerms, agreedPrice }
// agreedPrice required when SELLER agrees (sets the final sale price)
// ─────────────────────────────────────────────────────────────────
router.post('/:channelId/agree', authenticateToken, async (req, res) => {
  try {
    const { channelId } = req.params;
    const { agreedTerms, agreedPrice } = req.body;
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const result = await channelService.recordAgreement(
      channelId, userId,
      agreedTerms || 'I agree to the negotiated terms.',
      agreedPrice || null
    );

    res.status(200).json(result);
  } catch (error) {
    console.error('Error recording agreement:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/channels/:channelId/disagree   ← NEW
// Body: { reason }  (optional)
// Resets both agreed flags → channel back to NEGOTIATING
// ─────────────────────────────────────────────────────────────────
router.post('/:channelId/disagree', authenticateToken, async (req, res) => {
  try {
    const { channelId } = req.params;
    const { reason } = req.body;
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const result = await channelService.recordDisagreement(channelId, userId, reason || '');
    res.status(200).json(result);
  } catch (error) {
    console.error('Error recording disagreement:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/channels/:channelId/upload-screenshot
// ─────────────────────────────────────────────────────────────────
router.post(
  '/:channelId/upload-screenshot',
  authenticateToken,
  uploadScreenshot,
  handleUploadError,
  async (req, res) => {
    try {
      const { channelId } = req.params;
      const { agreedPrice, agreedTerms } = req.body;
      if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
      if (!agreedPrice) return res.status(400).json({ success: false, error: 'Agreed price required' });

      const screenshotUrl = `/uploads/agreements/${req.file.filename}`;
      const result = await channelService.uploadScreenshot(
        channelId, screenshotUrl, parseFloat(agreedPrice), agreedTerms
      );
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ─────────────────────────────────────────────────────────────────
// GET /api/channels/  and  GET /api/channels/my-channels
// ─────────────────────────────────────────────────────────────────
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.query.userId;
    if (!userId) return res.status(401).json({ success: false, error: 'Auth required' });
    const result = await channelService.getUserChannels(userId);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/my-channels', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.query.userId;
    if (!userId) return res.status(401).json({ success: false, error: 'Auth required' });
    const result = await channelService.getUserChannels(userId);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /api/channels/:channelId/details
// ─────────────────────────────────────────────────────────────────
router.get('/:channelId/details', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.query.userId;
    if (!userId) return res.status(401).json({ success: false, error: 'Auth required' });
    const result = await channelService.getChannelDetails(req.params.channelId, userId);
    res.status(200).json(result);
  } catch (error) {
    res.status(error.message.includes('Unauthorized') ? 403 : 500)
       .json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/channels/:channelId/close
// ─────────────────────────────────────────────────────────────────
router.post('/:channelId/close', authenticateToken, async (req, res) => {
  try {
    const result = await channelService.closeChannel(req.params.channelId);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /api/channels/:channelId/validate-access
// ─────────────────────────────────────────────────────────────────
router.get('/:channelId/validate-access', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.query.userId;
    if (!userId) return res.status(401).json({ success: false, error: 'Auth required' });
    const result = await channelService.validateChannelAccess(req.params.channelId, userId);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/channels/:channelId/send-media
// ─────────────────────────────────────────────────────────────────
router.post(
  '/:channelId/send-media',
  authenticateToken,
  uploadChatMedia,
  handleUploadError,
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
      const mediaType = req.file.mimetype.startsWith('audio/') ? 'VOICE_MESSAGE' : 'IMAGE_MESSAGE';
      const mediaUrl  = `/uploads/chat-media/${req.file.filename}`;
      res.status(200).json({ success: true, mediaUrl, mediaType, fileName: req.file.originalname, fileSize: req.file.size });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ─────────────────────────────────────────────────────────────────
// POST /api/channels/:channelId/submit-challan  (unchanged)
// ─────────────────────────────────────────────────────────────────
router.post('/:channelId/submit-challan', authenticateToken, async (req, res) => {
  const pool = (await import('../config/db.js')).default;
  const client = await pool.connect();
  try {
    const { channelId, transferId, msgKey, challanData, buyerSignature, verifyAccountNo, verifyPin } = req.body;
    const buyerId = req.user.userId;

    if (!channelId || !buyerSignature || !verifyAccountNo || !verifyPin) {
      client.release();
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    await client.query('BEGIN');

    const channelRow = await client.query(`
      SELECT tr.*, u_buyer.name as buyer_name, u_buyer.cnic as buyer_cnic,
             u_seller.name as seller_name, u_seller.cnic as seller_cnic,
             p.property_id, p.area_marla, p.district, p.tehsil, p.mauza,
             p.khasra_no, p.khewat_no
      FROM transfer_requests tr
      JOIN users u_buyer  ON tr.buyer_id  = u_buyer.user_id
      JOIN users u_seller ON tr.seller_id = u_seller.user_id
      JOIN properties p   ON tr.property_id = p.property_id
      WHERE tr.channel_id = $1
    `, [channelId]);

    if (channelRow.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ success: false, message: 'Channel not found' });
    }

    const channelData = channelRow.rows[0];

    const accountRow = await client.query(
      'SELECT * FROM bank_accounts WHERE account_no = $1 AND user_id = $2 AND is_active = true',
      [verifyAccountNo, buyerId]
    );
    if (accountRow.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(400).json({ success: false, message: 'Account not found or inactive' });
    }

    const buyerAccount = accountRow.rows[0];

    const crypto = await import('crypto');
    const hashPin = pin => crypto.default.createHash('sha256').update(String(pin)).digest('hex');
    if (hashPin(verifyPin) !== buyerAccount.pin_hash) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(401).json({ success: false, message: 'Incorrect PIN' });
    }

    const agreedPrice = parseFloat(channelData.agreed_price || 0);
    if (parseFloat(buyerAccount.balance) < agreedPrice) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(400).json({
        success: false,
        message: `Insufficient balance. Need PKR ${agreedPrice.toLocaleString()}`
      });
    }

    const parsedChallanData = typeof challanData === 'string' ? JSON.parse(challanData) : (challanData || {});
    parsedChallanData.buyerSignature        = buyerSignature;
    parsedChallanData.buyerAccountVerified  = true;
    parsedChallanData.verifiedAt            = new Date().toISOString();

    await client.query(`
      UPDATE channel_messages
      SET message_content = $1, updated_at = NOW()
      WHERE channel_id = $2 AND message_type = 'CHALLAN'
    `, [JSON.stringify(parsedChallanData), channelId]);

    await client.query(`
      INSERT INTO channel_messages
        (channel_id, transfer_id, sender_id, sender_role, message_type, message_content, is_system_message)
      VALUES ($1, $2, $3, 'SYSTEM', 'SYSTEM',
        '📄 Buyer has verified their account. Ready for payment.', true)
    `, [channelId, transferId || null, buyerId]);

    await client.query('COMMIT');
    client.release();

    return res.json({
      success: true,
      message: 'Challan submitted with account verification',
      submission: {
        challanId: msgKey,
        verifiedAccount: verifyAccountNo,
        buyerBalance: parseFloat(buyerAccount.balance),
        agreedPrice,
        canAfford: parseFloat(buyerAccount.balance) >= agreedPrice,
      }
    });

  } catch (err) {
    await client.query('ROLLBACK');
    client.release();
    return res.status(500).json({ success: false, message: err.message });
  }
});

export default router;