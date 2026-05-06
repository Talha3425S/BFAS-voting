// =====================================================
// PAYMENT ROUTES — Simulated Banking Module
// Location: backend/src/routes/payment.js
// =====================================================

import express from 'express';
import pool from '../config/db.js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const router = express.Router();

// ─── AUTH MIDDLEWARE ───────────────────────────────
function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'No token provided' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'default-jwt-secret');
    next();
  } catch {
    return res.status(403).json({ success: false, message: 'Invalid token' });
  }
}

// ─── HELPER FUNCTIONS ──────────────────────────────
function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

function generateTxnRef() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(Math.random() * 999999).toString().padStart(6, '0');
  return `TXN-${date}-${rand}`;
}

function maskAccount(accNo) {
  if (!accNo || accNo.length < 6) return accNo;
  return accNo.slice(0, 2) + '************' + accNo.slice(-4);
}

/**
 * Auto-create a bank account for any user who doesn't have one.
 * New citizens registered after the initial data seed never had
 * accounts inserted, which caused "Seller's bank account not found"
 * 404 errors during challan payment. This function is idempotent:
 * it returns the existing account if found, otherwise creates one
 * with the standard PKR 50,000,000 starting balance.
 *
 * Default PIN is '0000' (hashed). The user should set their own PIN
 * from their account settings page.
 */
async function ensureBankAccount(userId, dbClient = pool) {
  // 1. Try to return the existing active account
  const existing = await dbClient.query(
    'SELECT * FROM bank_accounts WHERE user_id = $1 AND is_active = true LIMIT 1',
    [userId]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  // 2. Resolve owner name for account title
  const userRow = await dbClient.query(
    'SELECT name FROM users WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  const ownerName = userRow.rows[0]?.name || 'Account Holder';

  // 3. Generate a unique account number  (PK + 14 digits)
  const accountNo = 'PK' + Date.now().toString().slice(-8) +
    Math.floor(Math.random() * 1000000).toString().padStart(6, '0');

  const banks = [
    { name: 'HBL - Habib Bank Limited',  code: 'HBL001', city: 'Lahore'     },
    { name: 'UBL - United Bank Limited', code: 'UBL001', city: 'Karachi'    },
    { name: 'MCB Bank Limited',          code: 'MCB001', city: 'Islamabad'  },
    { name: 'Allied Bank Limited',       code: 'ABL001', city: 'Rawalpindi' },
    { name: 'Bank Alfalah',             code: 'BAF001', city: 'Multan'     },
  ];
  const bank = banks[Math.floor(Math.random() * banks.length)];

  // Default PIN = '0000' hashed. User must reset it from their account page.
  const defaultPinHash = crypto.createHash('sha256').update('0000').digest('hex');

  try {
    const inserted = await dbClient.query(`
      INSERT INTO bank_accounts
        (user_id, account_no, account_title, bank_name, branch_code, branch_city,
         balance, pin_hash, is_active, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, 50000000, $7, true, NOW(), NOW())
      ON CONFLICT (user_id) DO UPDATE
        SET is_active = true, updated_at = NOW()
      RETURNING *
    `, [userId, accountNo, ownerName, bank.name, bank.code, bank.city, defaultPinHash]);

    if (inserted.rows.length > 0) {
      console.log(`🏦 Auto-created bank account for ${userId}: ${accountNo} (default PIN: 0000)`);
      return inserted.rows[0];
    }
  } catch (_) {
    // ON CONFLICT race — another request created it simultaneously
  }

  // 4. Fallback: fetch the just-created account
  const retry = await dbClient.query(
    'SELECT * FROM bank_accounts WHERE user_id = $1 AND is_active = true LIMIT 1',
    [userId]
  );
  return retry.rows[0] || null;
}


// ─────────────────────────────────────────────────────────────────
// 1. GET /api/payments/my-account
// ─────────────────────────────────────────────────────────────────
router.get('/my-account', authenticateToken, async (req, res) => {
  try {
    // Auto-create account for new users who have never had one
    await ensureBankAccount(req.user.userId);

    const result = await pool.query(`
      SELECT
        ba.account_id,
        ba.account_no,
        ba.account_title,
        ba.bank_name,
        ba.branch_city,
        ba.balance,
        ba.is_active,
        u.name,
        u.cnic,
        u.email,
        u.mobile
      FROM bank_accounts ba
      JOIN users u ON ba.user_id = u.user_id
      WHERE ba.user_id = $1
    `, [req.user.userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Bank account not found for this user' });
    }

    const acct = result.rows[0];

    return res.json({
      success: true,
      account: {
        accountNo: acct.account_no,
        maskedNo: maskAccount(acct.account_no),
        accountTitle: acct.account_title,
        bankName: acct.bank_name,
        branchCity: acct.branch_city,
        balance: parseFloat(acct.balance),
        isActive: acct.is_active,
        ownerName: acct.name,
        cnic: acct.cnic,
        email: acct.email,
        mobile: acct.mobile
      }
    });

  } catch (err) {
    console.error('❌ my-account error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// 2. GET /api/payments/account/:userId
// ─────────────────────────────────────────────────────────────────
router.get('/account/:userId', authenticateToken, async (req, res) => {
  try {
    // Auto-create account for the target user if missing (e.g. new seller)
    await ensureBankAccount(req.params.userId);

    const result = await pool.query(`
      SELECT
        ba.account_no,
        ba.account_title,
        ba.bank_name,
        ba.branch_city,
        u.name
      FROM bank_accounts ba
      JOIN users u ON ba.user_id = u.user_id
      WHERE ba.user_id = $1 AND ba.is_active = true
    `, [req.params.userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    const acct = result.rows[0];

    return res.json({
      success: true,
      account: {
        accountNo: acct.account_no,
        maskedNo: maskAccount(acct.account_no),
        accountTitle: acct.account_title,
        bankName: acct.bank_name,
        branchCity: acct.branch_city,
        ownerName: acct.name
      }
    });

  } catch (err) {
    console.error('❌ account/:userId error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// 3. POST /api/payments/transfer
// THE MAIN PAYMENT ENDPOINT
// ─────────────────────────────────────────────────────────────────
router.post('/transfer', authenticateToken, async (req, res) => {
  const client = await pool.connect();

  try {
    const { transferId, channelId, receiverUserId, amount, pin } = req.body;
    const senderUserId = req.user.userId;

    console.log('\n╔═══════════════════════════════════════╗');
    console.log('║         PAYMENT TRANSFER REQUEST       ║');
    console.log('╠═══════════════════════════════════════╣');
    console.log('║ Transfer ID :', transferId);
    console.log('║ Sender      :', senderUserId);
    console.log('║ Receiver    :', receiverUserId);
    console.log('║ Amount      : PKR', amount);
    console.log('╚═══════════════════════════════════════╝\n');

    // ── Validate input ─────────────────────────────────────────────
    if (!transferId || !receiverUserId || !amount || !pin) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: transferId, receiverUserId, amount, pin'
      });
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }

    if (senderUserId === receiverUserId) {
      return res.status(400).json({ success: false, message: 'Cannot transfer to yourself' });
    }

    // ── Fetch buyer account (auto-create for new users) ────────────
    const sender = await ensureBankAccount(senderUserId);
    if (!sender) {
      return res.status(404).json({ success: false, message: 'Your bank account was not found' });
    }

    // ── Verify PIN ─────────────────────────────────────────────────
    if (hashPin(pin) !== sender.pin_hash) {
      console.log('❌ PIN mismatch for user:', senderUserId);
      return res.status(401).json({ success: false, message: 'Incorrect PIN. Please try again.' });
    }

    // ── Check sufficient balance ───────────────────────────────────
    if (parseFloat(sender.balance) < parsedAmount) {
      return res.status(400).json({
        success: false,
        message: `Insufficient balance. Your balance is PKR ${Number(sender.balance).toLocaleString()} but transfer amount is PKR ${parsedAmount.toLocaleString()}`
      });
    }

    // ── Fetch seller account (auto-create for new sellers) ─────────
    const receiver = await ensureBankAccount(receiverUserId);
    if (!receiver) {
      return res.status(404).json({ success: false, message: "Seller's bank account could not be resolved" });
    }

    // ── Verify this transfer belongs to these two users ────────────
    const transferCheck = await pool.query(`
      SELECT transfer_id, seller_id, buyer_id, agreed_price, payment_status
      FROM transfer_requests
      WHERE transfer_id = $1
    `, [transferId]);

    if (transferCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Transfer request not found' });
    }

    const transfer = transferCheck.rows[0];

    if (transfer.buyer_id !== senderUserId) {
      return res.status(403).json({ success: false, message: 'You are not the buyer of this transfer' });
    }

    if (transfer.seller_id !== receiverUserId) {
      return res.status(403).json({ success: false, message: 'Receiver does not match seller of this transfer' });
    }

    if (transfer.payment_status === 'PAID') {
      return res.status(400).json({ success: false, message: 'This transfer has already been paid' });
    }

    // ── Snapshot balances BEFORE ───────────────────────────────────
    const balanceBeforeSender   = parseFloat(sender.balance);
    const balanceBeforeReceiver = parseFloat(receiver.balance);
    const balanceAfterSender    = balanceBeforeSender   - parsedAmount;
    const balanceAfterReceiver  = balanceBeforeReceiver + parsedAmount;

    // ── Generate transaction reference ─────────────────────────────
    const txnRef = generateTxnRef();

    // ╔══════════════════════════════╗
    // ║  ATOMIC DATABASE TRANSACTION ║
    // ╚══════════════════════════════╝
    await client.query('BEGIN');

    // 1. Deduct from buyer
    await client.query(`
      UPDATE bank_accounts
      SET balance = balance - $1, updated_at = NOW()
      WHERE user_id = $2 AND balance >= $1
    `, [parsedAmount, senderUserId]);

    // Verify deduction happened
    const verifyDeduct = await client.query(
      'SELECT balance FROM bank_accounts WHERE user_id = $1',
      [senderUserId]
    );
    if (parseFloat(verifyDeduct.rows[0].balance) !== balanceAfterSender) {
      throw new Error('Balance deduction failed — possible concurrent transaction');
    }

    // 2. Credit to seller
    await client.query(`
      UPDATE bank_accounts
      SET balance = balance + $1, updated_at = NOW()
      WHERE user_id = $2
    `, [parsedAmount, receiverUserId]);

    // 3. Insert payment transaction record
    const txnResult = await client.query(`
      INSERT INTO payment_transactions (
        txn_ref, transfer_id, channel_id,
        sender_user_id, receiver_user_id,
        sender_account_no, receiver_account_no,
        amount,
        balance_before_sender, balance_after_sender,
        balance_before_receiver, balance_after_receiver,
        status, payment_purpose, completed_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'SUCCESS', 'Property Transfer Payment', NOW()
      )
      RETURNING *
    `, [
      txnRef, transferId, channelId || null,
      senderUserId, receiverUserId,
      sender.account_no, receiver.account_no,
      parsedAmount,
      balanceBeforeSender, balanceAfterSender,
      balanceBeforeReceiver, balanceAfterReceiver
    ]);

    const savedTxn = txnResult.rows[0];

    // 4. Update transfer_requests
    await client.query(`
      UPDATE transfer_requests
      SET payment_status = 'PAID',
          payment_transaction_id = $1,
          payment_completed_at = NOW(),
          channel_status = 'PAYMENT_DONE',
          challan_txn_id = $2
      WHERE transfer_id = $3
    `, [savedTxn.transaction_id, txnRef, transferId]);

    // 5. Insert system message in chat
    await client.query(`
      INSERT INTO channel_messages
        (channel_id, transfer_id, sender_id, sender_role, message_type, message_content, is_system_message)
      VALUES ($1, $2, $3, 'BUYER', 'SYSTEM',
        '💸 Payment of PKR ' || $4 || ' transferred successfully. TXN Ref: ' || $5,
        true)
    `, [
      channelId || null,
      transferId,
      senderUserId,
      parsedAmount.toLocaleString('en-PK'),
      txnRef
    ]);

    await client.query('COMMIT');

    // 6. Mark the CHALLAN message as PAID in channel_messages
    if (channelId) {
      try {
        const challanMsg = await pool.query(
          `SELECT message_id, message_content
           FROM channel_messages
           WHERE channel_id = $1 AND message_type = 'CHALLAN'
           ORDER BY timestamp DESC LIMIT 1`,
          [channelId]
        );
        if (challanMsg.rows.length > 0) {
          let payload = {};
          try { payload = JSON.parse(challanMsg.rows[0].message_content || '{}'); } catch (_) {}
          payload.status  = 'PAID';
          payload.txnRef  = txnRef;
          payload.paidAt  = new Date().toISOString();
          payload.receipt = {
            txnRef,
            amount: parsedAmount,
            completedAt: new Date().toISOString(),
            sender:   { balanceAfter: balanceAfterSender   },
            receiver: { balanceAfter: balanceAfterReceiver },
          };
          await pool.query(
            `UPDATE channel_messages SET message_content = $1 WHERE message_id = $2`,
            [JSON.stringify(payload), challanMsg.rows[0].message_id]
          );
        }
      } catch (updateErr) {
        console.warn('⚠️ Could not mark CHALLAN message as PAID:', updateErr.message);
      }
    }

    console.log('✅ PAYMENT SUCCESS');
    console.log('   TXN Ref      :', txnRef);
    console.log('   Amount       : PKR', parsedAmount);
    console.log('   Sender after : PKR', balanceAfterSender);
    console.log('   Receiver after: PKR', balanceAfterReceiver);

    // ── Fetch names for receipt ────────────────────────────────────
    const names = await pool.query(`
      SELECT user_id, name FROM users WHERE user_id IN ($1, $2)
    `, [senderUserId, receiverUserId]);

    const nameMap = {};
    names.rows.forEach(r => { nameMap[r.user_id] = r.name; });

    // ── Return receipt ─────────────────────────────────────────────
    return res.json({
      success: true,
      message: 'Payment transferred successfully',
      receipt: {
        txnRef,
        transactionId: savedTxn.transaction_id,
        status: 'SUCCESS',
        amount: parsedAmount,
        amountFormatted: 'PKR ' + parsedAmount.toLocaleString('en-PK'),
        completedAt: savedTxn.completed_at,

        sender: {
          name: nameMap[senderUserId],
          accountNo: sender.account_no,
          maskedNo: maskAccount(sender.account_no),
          bankName: sender.bank_name,
          balanceBefore: balanceBeforeSender,
          balanceAfter: balanceAfterSender
        },
        receiver: {
          name: nameMap[receiverUserId],
          accountNo: receiver.account_no,
          maskedNo: maskAccount(receiver.account_no),
          bankName: receiver.bank_name,
          balanceBefore: balanceBeforeReceiver,
          balanceAfter: balanceAfterReceiver
        },

        transferId,
        channelId: channelId || null
      }
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ PAYMENT FAILED:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Payment failed: ' + err.message
    });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────
// 4. GET /api/payments/transaction/:txnRef
// ─────────────────────────────────────────────────────────────────
router.get('/transaction/:txnRef', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        pt.*,
        s.name AS sender_name,
        r.name AS receiver_name
      FROM payment_transactions pt
      LEFT JOIN users s ON pt.sender_user_id = s.user_id
      LEFT JOIN users r ON pt.receiver_user_id = r.user_id
      WHERE pt.txn_ref = $1
    `, [req.params.txnRef]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    const t = result.rows[0];

    const isParty   = t.sender_user_id === req.user.userId || t.receiver_user_id === req.user.userId;
    const isOfficer = ['LRO', 'DC', 'ADMIN'].includes(req.user.role);

    if (!isParty && !isOfficer) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    return res.json({
      success: true,
      transaction: {
        txnRef: t.txn_ref,
        transactionId: t.transaction_id,
        status: t.status,
        amount: parseFloat(t.amount),
        amountFormatted: 'PKR ' + parseFloat(t.amount).toLocaleString('en-PK'),
        initiatedAt: t.initiated_at,
        completedAt: t.completed_at,

        sender: {
          name: t.sender_name,
          accountNo: t.sender_account_no,
          maskedNo: maskAccount(t.sender_account_no),
          balanceBefore: parseFloat(t.balance_before_sender),
          balanceAfter:  parseFloat(t.balance_after_sender)
        },
        receiver: {
          name: t.receiver_name,
          accountNo: t.receiver_account_no,
          maskedNo: maskAccount(t.receiver_account_no),
          balanceBefore: parseFloat(t.balance_before_receiver),
          balanceAfter:  parseFloat(t.balance_after_receiver)
        },

        transferId: t.transfer_id,
        channelId: t.channel_id,
        purpose: t.payment_purpose
      }
    });

  } catch (err) {
    console.error('❌ transaction/:txnRef error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// 5. GET /api/payments/history
// ─────────────────────────────────────────────────────────────────
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        pt.txn_ref,
        pt.amount,
        pt.status,
        pt.initiated_at,
        pt.completed_at,
        pt.payment_purpose,
        CASE
          WHEN pt.sender_user_id = $1 THEN 'DEBIT'
          ELSE 'CREDIT'
        END AS direction,
        CASE
          WHEN pt.sender_user_id = $1 THEN pt.balance_after_sender
          ELSE pt.balance_after_receiver
        END AS balance_after,
        CASE
          WHEN pt.sender_user_id = $1 THEN r.name
          ELSE s.name
        END AS other_party_name,
        CASE
          WHEN pt.sender_user_id = $1 THEN pt.receiver_account_no
          ELSE pt.sender_account_no
        END AS other_party_account
      FROM payment_transactions pt
      LEFT JOIN users s ON pt.sender_user_id = s.user_id
      LEFT JOIN users r ON pt.receiver_user_id = r.user_id
      WHERE pt.sender_user_id = $1 OR pt.receiver_user_id = $1
      ORDER BY pt.initiated_at DESC
      LIMIT 50
    `, [req.user.userId]);

    return res.json({
      success: true,
      transactions: result.rows
    });

  } catch (err) {
    console.error('❌ history error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
