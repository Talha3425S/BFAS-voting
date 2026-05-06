import express from "express";
import pool from "../config/db.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import CryptoJS from "crypto-js";
import elliptic from "elliptic";
import auditService from "../services/audit.service.js";
const { ec: EC } = elliptic;

const router = express.Router();
const ec = new EC("secp256k1");
const LOGIN_TOTP_ISSUER = process.env.LOGIN_TOTP_ISSUER || "PLRA Land Registry";
const LOGIN_2FA_CHALLENGE_MINUTES = parseInt(
  process.env.LOGIN_2FA_CHALLENGE_MINUTES || "10",
  10
);


// =====================================================
// UTILITY FUNCTIONS
// =====================================================

function generateKeyPair() {
  const keyPair = ec.genKeyPair();
  return {
    publicKey: keyPair.getPublic("hex"),
    privateKey: keyPair.getPrivate("hex")
  };
}

function encryptPrivateKey(privateKey, password) {
  const secretKey = process.env.AES_SECRET_KEY || "default-secret-key-32chars-long";
  return CryptoJS.AES.encrypt(privateKey, password + secretKey).toString();
}

function generateBlockchainAddress(publicKey) {
  return "0x" + crypto.createHash("sha256").update(publicKey).digest("hex").substring(0, 40);
}

function generateJWT(userId, role, userEmail) {
  const payload = { userId, role, email: userEmail, timestamp: Date.now() };
  return jwt.sign(payload, process.env.JWT_SECRET || "default-jwt-secret", {
    expiresIn: process.env.JWT_EXPIRES_IN || "24h",
  });
}

function generateLoginChallengeToken(userId, role, userEmail) {
  return jwt.sign(
    { type: "LOGIN_2FA_PENDING", userId, role, email: userEmail, timestamp: Date.now() },
    process.env.JWT_SECRET || "default-jwt-secret",
    { expiresIn: process.env.LOGIN_2FA_CHALLENGE_EXPIRES_IN || "10m" }
  );
}

async function deliverLocalNotice(target, subject, body) {
  console.log("\n[NOTICE:LOCAL_ONLY]");
  console.log(`Target: ${target || "UNSPECIFIED"}`);
  console.log(`Subject: ${subject}`);
  console.log(body);
  console.log("[/NOTICE:LOCAL_ONLY]\n");
  return {
    delivered: false,
    localLogged: true,
  };
}

async function isAccountLocked(email) {
  const result = await pool.query(
    "SELECT account_locked, lock_until FROM users WHERE email = $1",
    [email]
  );

  if (result.rows.length === 0) return false;

  const user = result.rows[0];
  if (user.account_locked && user.lock_until && new Date(user.lock_until) > new Date()) {
    return true;
  }

  if (user.account_locked && user.lock_until && new Date(user.lock_until) <= new Date()) {
    await pool.query(
      "UPDATE users SET account_locked = FALSE, lock_until = NULL, failed_login_attempts = 0 WHERE email = $1",
      [email]
    );
    return false;
  }

  return false;
}

async function recordLoginAttempt(email, ipAddress, success, failureReason = null) {
  try {
    await pool.query(
      "INSERT INTO login_attempts (email, ip_address, success, failure_reason) VALUES ($1, $2, $3, $4)",
      [email, ipAddress, success, failureReason]
    );
  } catch (err) {
    console.error("Error recording login attempt:", err.message);
  }
}

async function handleFailedLogin(email, ipAddress) {
  const result = await pool.query(
    "SELECT failed_login_attempts FROM users WHERE email = $1",
    [email]
  );

  if (result.rows.length === 0) return;

  const attempts = result.rows[0].failed_login_attempts + 1;
  const maxAttempts = parseInt(process.env.MAX_LOGIN_ATTEMPTS || 5);

  if (attempts >= maxAttempts) {
    const lockDuration = parseInt(process.env.ACCOUNT_LOCK_DURATION_MINUTES || 25);
    const lockUntil = new Date(Date.now() + lockDuration * 60 * 1000);

    await pool.query(
      "UPDATE users SET failed_login_attempts = $1, account_locked = TRUE, lock_until = $2 WHERE email = $3",
      [attempts, lockUntil, email]
    );

    await deliverLocalNotice(
      process.env.ADMIN_EMAIL || "admin@landrecords.gov.pk",
      "⚠️ Account Locked - Multiple Failed Attempts",
      `User ${email} locked after ${attempts} failed attempts from IP: ${ipAddress}`
    );
  } else {
    await pool.query(
      "UPDATE users SET failed_login_attempts = $1 WHERE email = $2",
      [attempts, email]
    );
  }
}

async function ensureOtpVerificationSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS otp_verification (
      email VARCHAR(255) NOT NULL,
      otp VARCHAR(20) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      otp_type VARCHAR(80) NOT NULL DEFAULT 'registration',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function ensureUserTwoFactorSchema() {
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS two_factor_method VARCHAR(32) NOT NULL DEFAULT 'NONE',
      ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS two_factor_secret VARCHAR(128),
      ADD COLUMN IF NOT EXISTS two_factor_temp_secret VARCHAR(128),
      ADD COLUMN IF NOT EXISTS two_factor_setup_at TIMESTAMPTZ
  `);
}

function normalizeTwoFactorMethod(value = "") {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "TOTP") return "TOTP";
  if (normalized === "EMAIL_OTP") return "EMAIL_OTP";
  return "NONE";
}

function normalizeGender(value = "") {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "MALE" || normalized === "FEMALE") {
    return normalized;
  }
  return "";
}

function normalizeLoginIdentifier(value = "") {
  return String(value || "").trim();
}

function isEmailLikeIdentifier(value = "") {
  return String(value || "").includes("@");
}

function extractCnicDigits(value = "") {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 13 ? digits : "";
}

async function findUserByLoginIdentifier(identifier) {
  const normalizedIdentifier = normalizeLoginIdentifier(identifier);
  const loweredIdentifier = normalizedIdentifier.toLowerCase();
  const upperIdentifier = normalizedIdentifier.toUpperCase();
  const cnicDigits = extractCnicDigits(normalizedIdentifier);

  const result = await pool.query(
    `SELECT user_id, role, password_hash, is_active, approval_status,
            approved_at, name, rejection_reason, email, cnic,
            account_locked, lock_until
     FROM users
     WHERE LOWER(email) = $1
        OR UPPER(user_id) = $2
        OR ($3 <> '' AND cnic = $3)
     ORDER BY
       CASE
         WHEN LOWER(email) = $1 THEN 1
         WHEN UPPER(user_id) = $2 THEN 2
         WHEN ($3 <> '' AND cnic = $3) THEN 3
         ELSE 4
       END
     LIMIT 1`,
    [loweredIdentifier, upperIdentifier, cnicDigits]
  );

  return result.rows[0] || null;
}

function mapUserIdentityConstraintError(error) {
  if (!error || error.code !== "23505") return null;

  const details = `${error.constraint || ""} ${error.detail || ""}`.toLowerCase();

  if (details.includes("cnic")) {
    return "CNIC is already registered";
  }

  if (details.includes("email")) {
    return "Email is already registered";
  }

  if (details.includes("user_id")) {
    return "Generated user ID conflicted with an existing account. Please try again.";
  }

  return "This account information is already registered";
}

function base32Encode(buffer) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  let encoded = "";

  for (const byte of buffer) {
    bits += byte.toString(2).padStart(8, "0");
  }

  for (let index = 0; index < bits.length; index += 5) {
    const chunk = bits.slice(index, index + 5).padEnd(5, "0");
    encoded += alphabet[parseInt(chunk, 2)];
  }

  return encoded;
}

function base32Decode(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = String(secret || "")
    .toUpperCase()
    .replace(/=+$/g, "")
    .replace(/[^A-Z2-7]/g, "");

  let bits = "";
  for (const character of normalized) {
    const value = alphabet.indexOf(character);
    if (value === -1) continue;
    bits += value.toString(2).padStart(5, "0");
  }

  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(parseInt(bits.slice(index, index + 8), 2));
  }

  return Buffer.from(bytes);
}

function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function sanitizeVerificationCode(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/[^0-9]/g, "")
    .slice(0, 6);
}

function generateTotpCode(secret, timestamp = Date.now()) {
  const decodedSecret = base32Decode(secret);
  const counter = Math.floor(timestamp / 30000);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuffer.writeUInt32BE(counter % 0x100000000, 4);

  const hmac = crypto
    .createHmac("sha1", decodedSecret)
    .update(counterBuffer)
    .digest();

  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(binary % 1000000).padStart(6, "0");
}

function verifyTotpCode(secret, candidateCode, window = 1) {
  const normalizedCode = sanitizeVerificationCode(candidateCode);
  if (!secret || normalizedCode.length !== 6) {
    return false;
  }

  const now = Date.now();
  for (let offset = -window; offset <= window; offset += 1) {
    const comparisonCode = generateTotpCode(secret, now + offset * 30000);
    if (comparisonCode === normalizedCode) {
      return true;
    }
  }

  return false;
}

function createOtpAuthUrl(email, secret) {
  const label = encodeURIComponent(`${LOGIN_TOTP_ISSUER}:${email}`);
  const issuer = encodeURIComponent(LOGIN_TOTP_ISSUER);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

function requiresLoginTwoFactor(role = "") {
  const normalized = String(role).toUpperCase();
  return ["LAND RECORD OFFICER", "LRO", "DC", "DEPUTY COMMISSIONER", "ADMIN"].includes(normalized);
}

async function issueLoginOtpChallenge({
  user,
  email,
  ipAddress,
  req,
  actionType = "LOGIN_2FA_CHALLENGE",
}) {
  await ensureOtpVerificationSchema();

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const minutes = parseInt(process.env.LOGIN_2FA_OTP_MINUTES || 10, 10);
  const expires = new Date(Date.now() + minutes * 60 * 1000);

  await pool.query(
    "DELETE FROM otp_verification WHERE email = $1 AND otp_type = 'login_2fa'",
    [email]
  );
  await pool.query(
    "INSERT INTO otp_verification (email, otp, expires_at, otp_type) VALUES ($1, $2, $3, 'login_2fa')",
    [email, otp, expires]
  );

  await deliverLocalNotice(
    email,
    "Secure Login Verification Code",
    `Hi ${user.name || "Officer"},\n\nYour secure login verification code is ${otp}.\nIt is valid for ${minutes} minutes.\n\nIf you did not try to sign in, please contact the administrator.`
  );

  console.log("\n" + "=".repeat(60));
  console.log("LOGIN 2FA OTP CODE");
  console.log("=".repeat(60));
  console.log(`Email: ${email}`);
  console.log(`User ID: ${user.user_id}`);
  console.log(`Role: ${user.role}`);
  console.log(`OTP: ${otp}`);
  console.log(`Expires at: ${expires.toLocaleString()}`);
  console.log("=".repeat(60) + "\n");

  await auditService.writeLog({
    userId: user.user_id,
    actionType,
    targetId: user.user_id,
    targetType: "USER",
    details: {
      email,
      role: user.role,
      expiresAt: expires.toISOString(),
    },
    ipAddress,
    routePath: req.originalUrl,
    httpMethod: req.method,
    status: "SUCCESS",
  }).catch(() => { });

  const isDevelopment = process.env.NODE_ENV !== "production";
  return {
    challengeToken: generateLoginChallengeToken(user.user_id, user.role, email),
    expiresAt: expires.toISOString(),
    ...(isDevelopment ? { otp } : {}),
  };
}

async function issueLoginTotpChallenge({
  user,
  email,
  ipAddress,
  req,
  actionType = "LOGIN_2FA_CHALLENGE",
  setupRequired = false,
  manualEntryKey = null,
}) {
  const normalizedEmail = String(email || "").toLowerCase();
  const expires = new Date(Date.now() + LOGIN_2FA_CHALLENGE_MINUTES * 60 * 1000);

  await auditService.writeLog({
    userId: user.user_id,
    actionType,
    targetId: user.user_id,
    targetType: "USER",
    details: {
      email: normalizedEmail,
      role: user.role,
      expiresAt: expires.toISOString(),
      method: "TOTP",
      setupRequired,
    },
    ipAddress,
    routePath: req.originalUrl,
    httpMethod: req.method,
    status: "SUCCESS",
  }).catch(() => { });

  return {
    challengeToken: generateLoginChallengeToken(user.user_id, user.role, normalizedEmail),
    expiresAt: expires.toISOString(),
    twoFactorMethod: "TOTP",
    setupRequired,
    ...(setupRequired && manualEntryKey
      ? {
        manualEntryKey,
        issuer: LOGIN_TOTP_ISSUER,
        accountLabel: normalizedEmail,
        otpauthUrl: createOtpAuthUrl(normalizedEmail, manualEntryKey),
      }
      : {}),
  };
}

async function issueLoginTotpSetupChallenge({
  user,
  email,
  ipAddress,
  req,
  actionType = "LOGIN_2FA_SETUP_REQUIRED",
}) {
  await ensureUserTwoFactorSchema();
  const manualEntryKey = generateTotpSecret();

  await pool.query(
    `UPDATE users
     SET two_factor_method = 'TOTP',
         two_factor_enabled = FALSE,
         two_factor_temp_secret = $1
     WHERE user_id = $2`,
    [manualEntryKey, user.user_id]
  );

  return issueLoginTotpChallenge({
    user,
    email,
    ipAddress,
    req,
    actionType,
    setupRequired: true,
    manualEntryKey,
  });
}

async function finalizeSuccessfulLogin({ user, email, ipAddress, req, loginIdentifier = null }) {
  await pool.query(
    "UPDATE users SET failed_login_attempts = 0, last_login = NOW() WHERE user_id = $1",
    [user.user_id]
  );

  const token = generateJWT(user.user_id, user.role, email);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO jwt_sessions (user_id, token, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [user.user_id, token, expiresAt, ipAddress, req.get("user-agent") || "unknown"]
  );

  await recordLoginAttempt(email, ipAddress, true);
  await auditService.writeLog({
    userId: user.user_id,
    actionType: "LOGIN_SUCCESS",
    targetId: user.user_id,
    targetType: "USER",
    details: {
      loginIdentifier,
      email,
      role: user.role,
      approvalStatus: user.approval_status,
    },
    ipAddress,
    routePath: req.originalUrl,
    httpMethod: req.method,
    status: "SUCCESS",
  }).catch(() => { });

  console.log("\n" + "=".repeat(60));
  console.log("LOGIN SUCCESSFUL");
  console.log("=".repeat(60));
  console.log(`Login Identifier: ${loginIdentifier || email}`);
  console.log(`Email: ${email}`);
  console.log(`User ID: ${user.user_id}`);
  console.log(`Role: ${user.role}`);
  console.log(`Approval Status: ${user.approval_status}`);
  console.log(`IP Address: ${ipAddress}`);
  console.log(`Time: ${new Date().toLocaleString()}`);
  console.log("=".repeat(60) + "\n");

  return {
    success: true,
    role: user.role,
    userId: user.user_id,
    token,
    message: "Login successful",
  };
}

// =====================================================
// AUTHENTICATION MIDDLEWARE
// =====================================================
function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Access denied. No token provided."
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "default-jwt-secret");
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({
      success: false,
      message: "Invalid or expired token"
    });
  }
}

// =====================================================
// 1️⃣ REGISTER - SEND OTP
// =====================================================
router.post("/register-citizen", async (req, res) => {
  try {
    let { name, cnic, email, mobile, password, role, fatherName, fatherCnic, gender } = req.body;

    name = name.trim();
    email = email.trim().toLowerCase();
    mobile = mobile.trim();
    const father_name = fatherName ? fatherName.trim() : null;
    const father_cnic = fatherCnic ? fatherCnic.replace(/\D/g, "") : null;
    const normalizedGender = normalizeGender(gender);

    // Debug log
    console.log("✅ Processing father_name:", father_name);
    console.log("✅ Processing father_cnic:", father_cnic);
    cnic = cnic.replace(/\D/g, "");

    if (!name || !cnic || !email || !mobile || !password || !role || !normalizedGender) {
      return res.json({ success: false, message: "All fields are required" });
    }

    // Log fatherName for debugging
    console.log("📝 Registration received - Father Name:", fatherName);

    const existing = await pool.query(
      `SELECT *
       FROM users
       WHERE cnic = $1
          OR LOWER(email) = LOWER($2)
          OR mobile = $3`,
      [cnic, email, mobile]
    );

    if (existing.rows.length > 0) {
      return res.json({
        success: false,
        message: "CNIC, Email or Mobile already registered",
      });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 5 * 60 * 1000);

    await pool.query("DELETE FROM otp_verification WHERE email=$1", [email]);

    await pool.query(
      "INSERT INTO otp_verification (email, otp, expires_at, otp_type) VALUES ($1, $2, $3, $4)",
      [email, otp, expires, "registration"]
    );

    await deliverLocalNotice(email, "Registration OTP", `Your OTP: ${otp}\nValid for 5 minutes.`);

    // ✅ DISPLAY OTP PROMINENTLY IN TERMINAL
    console.log("\n" + "=".repeat(60));
    console.log("🔑  REGISTRATION OTP CODE");
    console.log("=".repeat(60));
    console.log(`📧 Email: ${email}`);
    console.log(`👤 Name: ${name}`);
    console.log("");
    console.log("    ╔════════════════════════════════════╗");
    console.log(`    ║          OTP:  ${otp}          ║`);
    console.log("    ╚════════════════════════════════════╝");
    console.log("");
    console.log(`⏰ Expires in: 5 minutes`);
    console.log(`📱 Type: Registration`);
    console.log("=".repeat(60) + "\n");

    // ✅ DEVELOPMENT MODE: Return OTP in response for auto-fill
    const isDevelopment = process.env.NODE_ENV !== 'production';

    return res.json({
      success: true,
      message: "Verification code generated",
      ...(isDevelopment && { otp: otp }) // Only include OTP in development
    });
  } catch (err) {
    console.error("❌ register-citizen error:", err);
    return res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

// =====================================================
// 2️⃣ VERIFY OTP & CREATE USER
// =====================================================

router.post("/verify-otp", async (req, res) => {
  try {
    let { name, cnic, email, mobile, password, role, otp, fatherName, fatherCnic, gender } = req.body;

    email = email.trim().toLowerCase();
    otp = otp.trim();

    // Verify OTP
    const checkOtp = await pool.query(
      "SELECT * FROM otp_verification WHERE email = $1 AND otp = $2 AND otp_type = 'registration'",
      [email, otp]
    );

    if (checkOtp.rows.length === 0) {
      return res.json({ success: false, message: "Invalid OTP" });
    }

    if (new Date(checkOtp.rows[0].expires_at) < new Date()) {
      await pool.query("DELETE FROM otp_verification WHERE email=$1", [email]);
      return res.json({ success: false, message: "OTP has expired" });
    }

    // Generate blockchain credentials
    const { publicKey, privateKey } = generateKeyPair();
    const encryptedPrivateKey = encryptPrivateKey(privateKey, password);
    const blockchainAddress = generateBlockchainAddress(publicKey);
    const hash = await bcrypt.hash(password, 10);

    // Generate unique User ID
    let userID;
    let attempts = 0;
    while (attempts < 10) {
      userID = "USR" + Math.floor(100000 + Math.random() * 900000);
      const exists = await pool.query("SELECT * FROM users WHERE user_id=$1", [userID]);
      if (exists.rows.length === 0) break;
      attempts++;
    }

    const id = uuidv4();
    cnic = cnic.replace(/\D/g, "");
    name = name.trim();
    mobile = mobile.trim();
    const father_name = fatherName ? fatherName.trim() : null;
    const father_cnic = fatherCnic ? fatherCnic.replace(/\D/g, "") : null;
    const normalizedGender = normalizeGender(gender);

    if (!normalizedGender) {
      return res.json({ success: false, message: "Gender is required" });
    }

    const duplicateIdentity = await pool.query(
      `SELECT user_id
       FROM users
       WHERE cnic = $1
          OR LOWER(email) = LOWER($2)
       LIMIT 1`,
      [cnic, email]
    );

    if (duplicateIdentity.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "CNIC or Email is already registered",
      });
    }

    // ✅ CRITICAL: Determine approval status based on role
    const roleUpper = role.toUpperCase();

    // These roles REQUIRE admin approval
    const rolesNeedingApproval = [
      'LAND RECORD OFFICER',
      'LRO',
      'DC',
      'DEPUTY COMMISSIONER',
      'ADMIN'
    ];

    const needsApproval = rolesNeedingApproval.includes(roleUpper);

    // Set approval status and active status
    const approvalStatus = needsApproval ? 'PENDING' : 'APPROVED';
    const isActive = needsApproval ? false : true;

    console.log("\n========================================");
    console.log("📝 USER REGISTRATION");
    console.log("========================================");
    console.log("Name:", name);
    console.log("Email:", email);
    console.log("Role:", roleUpper);
    console.log("Needs Approval:", needsApproval);
    console.log("Approval Status:", approvalStatus);
    console.log("Is Active:", isActive);
    console.log("========================================\n");

    // Insert user with proper approval status
    // Add requested_at to your main user insert
    await pool.query(
      `INSERT INTO users (
    id, user_id, role, name, cnic, email, mobile, password_hash, 
    public_key, encrypted_private_key, blockchain_address, 
    approval_status, is_active, father_name, father_cnic, gender, requested_at
  ) 
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())`,
      [
        id, userID, roleUpper, name, cnic, email, mobile, hash,
        publicKey, encryptedPrivateKey, blockchainAddress,
        approvalStatus, isActive, father_name, father_cnic, normalizedGender
      ]
    );

    // Insert blockchain identity
    await pool.query(
      `INSERT INTO blockchain_identities (user_id, public_key, blockchain_address) 
       VALUES ($1, $2, $3)`,
      [userID, publicKey, blockchainAddress]
    );

    // // Create approval request if needed
    // if (needsApproval) {
    //   const requestId = uuidv4();
    //   await pool.query(
    //     `INSERT INTO approval_requests (
    //       request_id, user_id, request_type, status, requested_at
    //     )
    //     VALUES ($1, $2, $3, $4, NOW())`,
    //     [requestId, userID, 'USER_REGISTRATION', 'PENDING']
    //   );

    //   console.log("✅ Approval request created:", requestId);
    // }

    // Delete used OTP
    await pool.query("DELETE FROM otp_verification WHERE email=$1", [email]);

    // Send appropriate email based on approval status
    if (needsApproval) {
      await deliverLocalNotice(
        email,
        "Registration Pending Approval",
        `Dear ${name},

Thank you for registering as ${role}.

Your account is pending admin approval. Please wait for confirmation from the admin portal.

User ID: ${userID}
Blockchain Address: ${blockchainAddress}

Please do not attempt to login until you receive approval confirmation.

Best regards,
Blockchain Land Records Team`
      );

      // Notify admin about new registration
      const adminEmail = process.env.ADMIN_EMAIL || "admin@landrecords.gov.pk";
      await deliverLocalNotice(
        adminEmail,
        "New User Registration Requires Approval",
        `A new ${role} registration requires your approval:

Name: ${name}
Email: ${email}
CNIC: ${cnic}
User ID: ${userID}

Please review and approve/reject this registration in the admin panel.`
      );

    } else {
      // Citizen registration - auto-approved
      await deliverLocalNotice(
        email,
        "Welcome to Blockchain Land Records!",
        `Welcome ${name}!

Your account has been successfully created and is ready to use.

User ID: ${userID}
Blockchain Address: ${blockchainAddress}

You can now login at: ${process.env.FRONTEND_URL || 'http://localhost:5000'}

Best regards,
Blockchain Land Records Team`
      );
    }

    return res.json({
      success: true,
      message: needsApproval
        ? "Registration submitted. Pending admin approval."
        : "User registered successfully",
      userID,
      blockchainAddress,
      needsApproval,
      approvalStatus
    });

  } catch (err) {
    console.error("❌ verify-otp error:", err);
    const identityConstraintMessage = mapUserIdentityConstraintError(err);
    if (identityConstraintMessage) {
      return res.status(409).json({
        success: false,
        message: identityConstraintMessage,
      });
    }

    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});


// =====================================================
// 3️⃣ LOGIN WITH APPROVAL CHECK
// =====================================================
router.post("/login", async (req, res, next) => {
  try {
    const identifier = normalizeLoginIdentifier(
      req.body.identifier || req.body.email || req.body.userId || req.body.cnic || ""
    );
    const { password } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress || "unknown";

    if (!identifier || !password) {
      return res.status(400).json({
        success: false,
        message: "User ID or CNIC and password required",
      });
    }

    const user = await findUserByLoginIdentifier(identifier);

    if (!user) {
      await recordLoginAttempt(identifier, ipAddress, false, "User not found");
      return res.json({
        success: false,
        message: "Invalid login ID or password",
      });
    }

    if (isEmailLikeIdentifier(identifier) && String(user.role || "").toUpperCase() === "CITIZEN") {
      await recordLoginAttempt(identifier, ipAddress, false, "Citizen email login blocked");
      return res.json({
        success: false,
        message: "Citizens must login with User ID or CNIC only.",
      });
    }

    const normalizedEmail = String(user.email || "").trim().toLowerCase();
    const locked = await isAccountLocked(normalizedEmail || identifier);
    if (locked) {
      await recordLoginAttempt(normalizedEmail || identifier, ipAddress, false, "Account locked");
      return res.json({
        success: false,
        message: "Account locked due to multiple failed login attempts. Please try again later.",
      });
    }

    if (requiresLoginTwoFactor(user.role)) {
      if (user.approval_status === "PENDING") {
        await recordLoginAttempt(normalizedEmail || identifier, ipAddress, false, "Account pending approval");
        return res.json({
          success: false,
          message: "Your account is pending admin approval. Please wait for approval confirmation email.",
          reason: "PENDING_APPROVAL",
        });
      }

      if (user.approval_status === "REJECTED") {
        await recordLoginAttempt(normalizedEmail || identifier, ipAddress, false, "Account rejected");
        return res.json({
          success: false,
          message: user.rejection_reason
            ? `Your registration was not approved. Reason: ${user.rejection_reason}`
            : "Your account registration was not approved. Please contact support.",
          reason: "ACCOUNT_REJECTED",
        });
      }

      if (!user.is_active) {
        await recordLoginAttempt(normalizedEmail || identifier, ipAddress, false, "Account inactive");
        return res.json({
          success: false,
          message: "Your account is currently inactive. Please contact administrator.",
        });
      }
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      await handleFailedLogin(normalizedEmail || identifier, ipAddress);
      await recordLoginAttempt(normalizedEmail || identifier, ipAddress, false, "Invalid password");
      return res.json({
        success: false,
        message: "Invalid login ID or password",
      });
    }

    const loginResult = await finalizeSuccessfulLogin({
      user,
      email: normalizedEmail,
      ipAddress,
      req,
      loginIdentifier: identifier,
    });

    return res.json(loginResult);
  } catch (err) {
    console.error("login 2fa route error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message,
    });
  }
});

router.post("/verify-login-otp", async (req, res) => {
  try {
    const { challengeToken, otp } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress || "unknown";
    const normalizedCode = sanitizeVerificationCode(otp);

    if (!challengeToken || !normalizedCode) {
      return res.status(400).json({
        success: false,
        message: "Challenge token and verification code are required",
      });
    }

    let decoded = null;
    try {
      decoded = jwt.verify(challengeToken, process.env.JWT_SECRET || "default-jwt-secret");
    } catch (_error) {
      return res.status(403).json({
        success: false,
        message: "Login verification has expired. Please sign in again.",
      });
    }

    if (decoded.type !== "LOGIN_2FA_PENDING") {
      return res.status(403).json({
        success: false,
        message: "Invalid login verification token",
      });
    }

    await ensureUserTwoFactorSchema();

    const userResult = await pool.query(
      `SELECT user_id, role, is_active, approval_status, name,
              two_factor_enabled, two_factor_method,
              two_factor_secret, two_factor_temp_secret
       FROM users
       WHERE user_id = $1 AND email = $2
       LIMIT 1`,
      [decoded.userId, String(decoded.email || "").toLowerCase()]
    );

    if (!userResult.rows.length) {
      return res.status(404).json({
        success: false,
        message: "User account no longer exists",
      });
    }

    const user = userResult.rows[0];
    const method = normalizeTwoFactorMethod(user.two_factor_method);
    const activeSecret =
      method === "TOTP" && user.two_factor_enabled && user.two_factor_secret
        ? user.two_factor_secret
        : user.two_factor_temp_secret;

    if (!verifyTotpCode(activeSecret, normalizedCode)) {
      await auditService.writeLog({
        userId: decoded.userId,
        actionType: "LOGIN_2FA_VERIFY",
        targetId: decoded.userId,
        targetType: "USER",
        details: {
          email: decoded.email,
          reason: "INVALID_TOTP",
          method: method === "TOTP" ? "TOTP" : "TOTP_SETUP",
        },
        ipAddress,
        routePath: req.originalUrl,
        httpMethod: req.method,
        status: "FAILED",
      }).catch(() => { });

      return res.json({
        success: false,
        message: "Invalid verification code",
      });
    }

    if (!(method === "TOTP" && user.two_factor_enabled && user.two_factor_secret)) {
      await pool.query(
        `UPDATE users
         SET two_factor_method = 'TOTP',
             two_factor_enabled = TRUE,
             two_factor_secret = COALESCE(two_factor_temp_secret, two_factor_secret),
             two_factor_temp_secret = NULL,
             two_factor_setup_at = COALESCE(two_factor_setup_at, NOW())
         WHERE user_id = $1`,
        [user.user_id]
      );

      user.two_factor_enabled = true;
      user.two_factor_method = "TOTP";
      user.two_factor_secret = activeSecret;
      user.two_factor_temp_secret = null;

      await auditService.writeLog({
        userId: user.user_id,
        actionType: "LOGIN_2FA_ENABLED",
        targetId: user.user_id,
        targetType: "USER",
        details: {
          email: decoded.email,
          method: "TOTP",
        },
        ipAddress,
        routePath: req.originalUrl,
        httpMethod: req.method,
        status: "SUCCESS",
      }).catch(() => { });
    }

    const loginResult = await finalizeSuccessfulLogin({
      user,
      email: String(decoded.email || "").toLowerCase(),
      ipAddress,
      req,
    });

    return res.json(loginResult);
  } catch (err) {
    console.error("verify-login-otp error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message,
    });
  }
});

router.post("/resend-login-otp", async (req, res) => {
  try {
    const { challengeToken } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress || "unknown";

    if (!challengeToken) {
      return res.status(400).json({
        success: false,
        message: "Challenge token is required",
      });
    }

    let decoded = null;
    try {
      decoded = jwt.verify(challengeToken, process.env.JWT_SECRET || "default-jwt-secret");
    } catch (_error) {
      return res.status(403).json({
        success: false,
        message: "Login verification has expired. Please sign in again.",
      });
    }

    if (decoded.type !== "LOGIN_2FA_PENDING") {
      return res.status(403).json({
        success: false,
        message: "Invalid login verification token",
      });
    }

    await ensureUserTwoFactorSchema();

    const userResult = await pool.query(
      `SELECT user_id, role, approval_status, is_active, name,
              two_factor_enabled, two_factor_method, two_factor_secret
       FROM users
       WHERE user_id = $1 AND email = $2
       LIMIT 1`,
      [decoded.userId, String(decoded.email || "").toLowerCase()]
    );

    if (!userResult.rows.length) {
      return res.status(404).json({
        success: false,
        message: "User account no longer exists",
      });
    }

    const user = userResult.rows[0];
    const hasEnrolledTotp =
      normalizeTwoFactorMethod(user.two_factor_method) === "TOTP" &&
      Boolean(user.two_factor_enabled) &&
      Boolean(user.two_factor_secret);

    if (hasEnrolledTotp) {
      return res.status(400).json({
        success: false,
        message:
          "Authenticator app codes refresh automatically every 30 seconds. Open the app and use the current code.",
      });
    }

    const challenge = await issueLoginTotpSetupChallenge({
      user,
      email: String(decoded.email || "").toLowerCase(),
      ipAddress,
      req,
      actionType: "LOGIN_2FA_SETUP_REGENERATED",
    });

    return res.json({
      success: true,
      message: "A fresh authenticator setup key has been generated.",
      ...challenge,
    });
  } catch (err) {
    console.error("resend-login-otp error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message,
    });
  }
});

router.post("/login-legacy-fallback", async (req, res) => {
  try {
    const identifier = normalizeLoginIdentifier(
      req.body.identifier || req.body.email || req.body.userId || req.body.cnic || ""
    );
    const { password } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress || "unknown";

    if (!identifier || !password) {
      return res.status(400).json({
        success: false,
        message: "User ID or CNIC and password required"
      });
    }

    const user = await findUserByLoginIdentifier(identifier);

    if (!user) {
      await recordLoginAttempt(identifier, ipAddress, false, "User not found");
      return res.json({
        success: false,
        message: "Invalid login ID or password"
      });
    }

    if (isEmailLikeIdentifier(identifier) && String(user.role || "").toUpperCase() === "CITIZEN") {
      await recordLoginAttempt(identifier, ipAddress, false, "Citizen email login blocked");
      return res.json({
        success: false,
        message: "Citizens must login with User ID or CNIC only.",
      });
    }

    const email = String(user.email || "").trim();
    const loginEmail = email.toLowerCase() || identifier;

    const locked = await isAccountLocked(loginEmail);
    if (locked) {
      await recordLoginAttempt(loginEmail, ipAddress, false, "Account locked");
      return res.json({
        success: false,
        message: "Account locked due to multiple failed login attempts. Please try again later.",
      });
    }

    console.log("\n========================================");
    console.log("🔐 LOGIN ATTEMPT");
    console.log("========================================");
    console.log("Login Identifier:", identifier);
    console.log("Email:", user.email || "N/A");
    console.log("CNIC:", user.cnic || "N/A");
    console.log("Role:", user.role);
    console.log("Approval Status:", user.approval_status);
    console.log("Is Active:", user.is_active);
    console.log("========================================\n");

    // ✅ CRITICAL: Check approval status for restricted roles
    const restrictedRoles = [
      'LAND RECORD OFFICER',
      'LRO',
      'DC',
      'DEPUTY COMMISSIONER',
      'ADMIN'
    ];

    if (restrictedRoles.includes(user.role.toUpperCase())) {
      // Check if pending approval
      if (user.approval_status === 'PENDING') {
        await recordLoginAttempt(loginEmail, ipAddress, false, "Account pending approval");
        return res.json({
          success: false,
          message: "Your account is pending admin approval. Please wait for approval confirmation email.",
          reason: "PENDING_APPROVAL"
        });
      }

      // Check if rejected
      if (user.approval_status === 'REJECTED') {
        await recordLoginAttempt(loginEmail, ipAddress, false, "Account rejected");
        return res.json({
          success: false,
          message: user.rejection_reason
            ? `Your registration was not approved. Reason: ${user.rejection_reason}`
            : "Your account registration was not approved. Please contact support.",
          reason: "ACCOUNT_REJECTED"
        });
      }

      // Check if account is not active even after approval
      if (!user.is_active) {
        await recordLoginAttempt(loginEmail, ipAddress, false, "Account inactive");
        return res.json({
          success: false,
          message: "Your account is currently inactive. Please contact administrator."
        });
      }
    }

    // Verify password
    const match = await bcrypt.compare(password, user.password_hash);

    if (!match) {
      await handleFailedLogin(loginEmail, ipAddress);
      await recordLoginAttempt(loginEmail, ipAddress, false, "Invalid password");
      return res.json({
        success: false,
        message: "Invalid login ID or password"
      });
    }

    // Reset failed login attempts and update last login
    await pool.query(
      "UPDATE users SET failed_login_attempts = 0, last_login = NOW() WHERE user_id = $1",
      [user.user_id]
    );

    // Generate JWT token
    const token = generateJWT(user.user_id, user.role, user.email || "");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Store JWT session
    await pool.query(
      `INSERT INTO jwt_sessions (user_id, token, expires_at, ip_address, user_agent) 
       VALUES ($1, $2, $3, $4, $5)`,
      [user.user_id, token, expiresAt, ipAddress, req.get("user-agent") || "unknown"]
    );

    // Record successful login
    await recordLoginAttempt(loginEmail, ipAddress, true);
    await auditService.writeLog({
      userId: user.user_id,
      actionType: "LOGIN_SUCCESS",
      targetId: user.user_id,
      targetType: "USER",
      details: {
        loginIdentifier: identifier,
        email: user.email || null,
        cnic: user.cnic || null,
        role: user.role,
        approvalStatus: user.approval_status,
      },
      ipAddress,
      routePath: req.originalUrl,
      httpMethod: req.method,
      status: "SUCCESS",
    }).catch(() => { });

    console.log("\n" + "=".repeat(60));
    console.log("✅  LOGIN SUCCESSFUL");
    console.log("=".repeat(60));
    console.log(`📧 Email: ${email}`);
    console.log(`👤 User ID: ${user.user_id}`);
    console.log(`🎭 Role: ${user.role}`);
    console.log(`✓ Approval Status: ${user.approval_status}`);
    console.log(`🌐 IP Address: ${ipAddress}`);
    console.log(`🕐 Time: ${new Date().toLocaleString()}`);
    console.log("=".repeat(60) + "\n");

    return res.json({
      success: true,
      role: user.role,
      userId: user.user_id,
      token,
      message: "Login successful",
    });

  } catch (err) {
    console.error("❌ Login error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});
// =====================================================
// 4️⃣ REQUEST PASSWORD RESET (SEND OTP)
// =====================================================
router.post("/request-password-reset", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.json({ success: false, message: "Email is required" });
    }

    const user = await pool.query(
      "SELECT user_id, name FROM users WHERE email = $1",
      [email.toLowerCase()]
    );

    if (user.rows.length === 0) {
      return res.json({
        success: true,
        message: "If the account exists, a reset code has been generated",
      });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 15 * 60 * 1000);

    await pool.query("DELETE FROM password_reset_tokens WHERE email = $1", [email]);

    await pool.query(
      "INSERT INTO password_reset_tokens (email, otp, expires_at) VALUES ($1, $2, $3)",
      [email, otp, expires]
    );

    await deliverLocalNotice(
      email,
      "Password Reset Code",
      `Hi ${user.rows[0].name},\n\nYour reset code: ${otp}\nValid for 15 minutes.`
    );

    // ✅ DISPLAY OTP PROMINENTLY IN TERMINAL
    console.log("\n" + "=".repeat(60));
    console.log("🔐  PASSWORD RESET OTP CODE");
    console.log("=".repeat(60));
    console.log(`📧 Email: ${email}`);
    console.log(`👤 Name: ${user.rows[0].name}`);
    console.log("");
    console.log("    ╔════════════════════════════════════╗");
    console.log(`    ║          OTP:  ${otp}          ║`);
    console.log("    ╚════════════════════════════════════╝");
    console.log("");
    console.log(`⏰ Expires in: 15 minutes`);
    console.log(`📱 Type: Password Reset`);
    console.log("=".repeat(60) + "\n");

    // ✅ DEVELOPMENT MODE: Return OTP in response for auto-fill
    const isDevelopment = process.env.NODE_ENV !== 'production';

    return res.json({
      success: true,
      message: "If the account exists, a reset code has been generated",
      ...(isDevelopment && { otp: otp }) // Only include OTP in development
    });
  } catch (err) {
    console.error("❌ reset request error:", err);
    return res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

// =====================================================
// 5️⃣ VERIFY RESET OTP
// =====================================================
router.post("/verify-reset-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.json({ success: false, message: "Email and OTP required" });
    }

    const token = await pool.query(
      "SELECT * FROM password_reset_tokens WHERE email = $1 AND otp = $2 AND used = FALSE",
      [email.toLowerCase(), otp.trim()]
    );

    if (token.rows.length === 0) {
      return res.json({ success: false, message: "Invalid or expired code" });
    }

    if (new Date(token.rows[0].expires_at) < new Date()) {
      await pool.query("DELETE FROM password_reset_tokens WHERE email = $1", [email]);
      return res.json({ success: false, message: "Code has expired" });
    }

    return res.json({
      success: true,
      message: "OTP verified. You can now reset password.",
    });
  } catch (err) {
    console.error("❌ verify reset otp error:", err);
    return res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

// =====================================================
// 6️⃣ RESET PASSWORD (FINAL STEP)
// =====================================================
router.post("/reset-password", async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
      return res.json({
        success: false,
        message: "Email, OTP, and new password required",
      });
    }

    const token = await pool.query(
      "SELECT * FROM password_reset_tokens WHERE email = $1 AND otp = $2 AND used = FALSE",
      [email.toLowerCase(), otp.trim()]
    );

    if (token.rows.length === 0) {
      return res.json({ success: false, message: "Invalid or expired code" });
    }

    if (new Date(token.rows[0].expires_at) < new Date()) {
      await pool.query("DELETE FROM password_reset_tokens WHERE email = $1", [email]);
      return res.json({ success: false, message: "Code has expired" });
    }

    const hash = await bcrypt.hash(newPassword, 10);

    await pool.query(
      "UPDATE users SET password_hash = $1, updated_at = NOW() WHERE email = $2",
      [hash, email]
    );

    await pool.query(
      "UPDATE password_reset_tokens SET used = TRUE WHERE email = $1 AND otp = $2",
      [email, otp]
    );

    await pool.query(
      "UPDATE jwt_sessions SET revoked = TRUE, revoked_at = NOW() WHERE user_id = (SELECT user_id FROM users WHERE email = $1)",
      [email]
    );

    const user = await pool.query("SELECT name FROM users WHERE email = $1", [email]);
    await deliverLocalNotice(
      email,
      "Password Changed",
      `Hi ${user.rows[0].name},\n\nPassword changed successfully.\nIf not you, contact support immediately.`
    );

    return res.json({
      success: true,
      message: "Password reset successful. Please login.",
    });
  } catch (err) {
    console.error("❌ reset password error:", err);
    return res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

// =====================================================
// 7️⃣ GET USER PROFILE
// =====================================================
router.get("/user-profile", authenticateToken, async (req, res) => {
  try {
    await ensureUserTwoFactorSchema();

    const result = await pool.query(
      `SELECT user_id, name, email, cnic, mobile, role, gender, father_name, blockchain_address,
       created_at, last_login, two_factor_enabled, two_factor_method, two_factor_setup_at
       FROM users WHERE user_id = $1`,
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const user = result.rows[0];

    return res.json({
      success: true,
      userId: user.user_id,
      name: user.name,
      email: user.email,
      cnic: user.cnic,
      mobile: user.mobile,
      gender: user.gender,
      father_name: user.father_name,
      role: user.role,
      blockchain_address: user.blockchain_address,
      created_at: user.created_at,
      last_login: user.last_login,
      twoFactorEnabled: Boolean(user.two_factor_enabled),
      twoFactorMethod: normalizeTwoFactorMethod(user.two_factor_method),
      twoFactorSetupAt: user.two_factor_setup_at,
    });
  } catch (err) {
    console.error("❌ Get profile error:", err);
    return res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

// =====================================================
// 8️⃣ LOGOUT
// =====================================================
router.post("/logout", async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.json({ success: false, message: "Token required" });
    }

    await pool.query(
      "UPDATE jwt_sessions SET revoked = TRUE, revoked_at = NOW() WHERE token = $1",
      [token]
    );

    return res.json({ success: true, message: "Logged out successfully" });
  } catch (err) {
    console.error("❌ Logout error:", err);
    return res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

// =====================================================
// ADMIN ROUTES - APPROVAL MANAGEMENT
// =====================================================

// 9️⃣ GET PENDING APPROVALS (ADMIN ONLY)
router.get("/pending-approvals", authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: "Access denied. Admin only."
      });
    }

    const pendingUsers = await pool.query(
      `SELECT 
    user_id, name, email, cnic, mobile, role,
    created_at, requested_at, approval_status
   FROM users
   WHERE approval_status = 'PENDING'
   AND role IN ('LAND RECORD OFFICER', 'LRO', 'DC', 'ADMIN')
   ORDER BY requested_at DESC`
    );

    return res.json({
      success: true,
      totalPending: pendingUsers.rows.length,
      users: pendingUsers.rows
    });

  } catch (err) {
    console.error("❌ Get pending approvals error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

// 🔟 APPROVE USER (ADMIN ONLY)
router.post("/approve-user", authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: "Access denied. Admin only."
      });
    }

    const { userId, notes } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User ID required"
      });
    }

    await pool.query(
      `UPDATE users 
       SET approval_status = 'APPROVED',
           approved_by = $1,
           approved_at = NOW(),
           is_active = TRUE
       WHERE user_id = $2`,
      [req.user.userId, userId]
    );

    await pool.query(
      `UPDATE approval_requests 
       SET status = 'APPROVED',
           reviewed_by = $1,
           reviewed_at = NOW(),
           decision_notes = $2
       WHERE user_id = $3 AND status = 'PENDING'`,
      [req.user.userId, notes || 'Approved by admin', userId]
    );

    const userResult = await pool.query(
      "SELECT name, email, role FROM users WHERE user_id = $1",
      [userId]
    );

    if (userResult.rows.length > 0) {
      const user = userResult.rows[0];

      await deliverLocalNotice(
        user.email,
        "Account Approved - Blockchain Land Records",
        `Dear ${user.name},\n\nYour ${user.role} account has been approved!\n\nYou can now login at: ${process.env.FRONTEND_URL || 'http://localhost:3000'}\n\nBest regards,\nBlockchain Land Records Team`
      );
    }

    await pool.query(
      `INSERT INTO audit_logs (user_id, action_type, target_id, details) 
       VALUES ($1, 'USER_APPROVED', $2, $3)`,
      [req.user.userId, userId, JSON.stringify({ notes })]
    );

    return res.json({
      success: true,
      message: "User approved successfully"
    });

  } catch (err) {
    console.error("❌ Approve user error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

// 1️⃣1️⃣ REJECT USER (ADMIN ONLY)
router.post("/reject-user", authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: "Access denied. Admin only."
      });
    }

    const { userId, reason } = req.body;

    if (!userId || !reason) {
      return res.status(400).json({
        success: false,
        message: "User ID and rejection reason required"
      });
    }

    await pool.query(
      `UPDATE users 
       SET approval_status = 'REJECTED',
           approved_by = $1,
           approved_at = NOW(),
           rejection_reason = $2,
           is_active = FALSE
       WHERE user_id = $3`,
      [req.user.userId, reason, userId]
    );

    await pool.query(
      `UPDATE approval_requests 
       SET status = 'REJECTED',
           reviewed_by = $1,
           reviewed_at = NOW(),
           decision_notes = $2
       WHERE user_id = $3 AND status = 'PENDING'`,
      [req.user.userId, reason, userId]
    );

    const userResult = await pool.query(
      "SELECT name, email, role FROM users WHERE user_id = $1",
      [userId]
    );

    if (userResult.rows.length > 0) {
      const user = userResult.rows[0];

      await deliverLocalNotice(
        user.email,
        "Account Registration Update - Blockchain Land Records",
        `Dear ${user.name},\n\nWe regret to inform you that your ${user.role} account registration was not approved.\n\nReason: ${reason}\n\nIf you believe this is an error, please contact support.\n\nBest regards,\nBlockchain Land Records Team`
      );
    }

    await pool.query(
      `INSERT INTO audit_logs (user_id, action_type, target_id, details) 
       VALUES ($1, 'USER_REJECTED', $2, $3)`,
      [req.user.userId, userId, JSON.stringify({ reason })]
    );

    return res.json({
      success: true,
      message: "User registration rejected"
    });

  } catch (err) {
    console.error("❌ Reject user error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});
// GET USER PROFILE
// =====================================================
router.get("/profile", authenticateToken, async (req, res) => {
  try {
    console.log("\n========================================");
    console.log("👤 GET USER PROFILE REQUEST");
    console.log("========================================");
    console.log("User ID:", req.user.userId);

    // Fetch user details from database
    await ensureUserTwoFactorSchema();

    const result = await pool.query(
      `SELECT user_id, role, name, cnic, email, mobile, gender, father_name, father_cnic,
              blockchain_address, created_at, last_login, is_active,
              two_factor_enabled, two_factor_method, two_factor_setup_at
       FROM users 
       WHERE user_id = $1`,
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const user = result.rows[0];

    console.log("✅ Profile fetched successfully");
    console.log("   Name:", user.name);
    console.log("   Email:", user.email);
    console.log("   Role:", user.role);
    console.log("========================================\n");

    return res.json({
      success: true,
      user: {
        user_id: user.user_id,
        role: user.role,
        name: user.name,
        cnic: user.cnic,
        email: user.email,
        mobile: user.mobile,
        gender: user.gender,
        father_name: user.father_name,
        father_cnic: user.father_cnic,
        blockchain_address: user.blockchain_address,
        created_at: user.created_at,
        last_login: user.last_login,
        is_active: user.is_active,
        two_factor_enabled: Boolean(user.two_factor_enabled),
        two_factor_method: normalizeTwoFactorMethod(user.two_factor_method),
        two_factor_setup_at: user.two_factor_setup_at,
      }
    });

  } catch (err) {
    console.error("❌ Get profile error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

router.patch("/profile", authenticateToken, async (req, res) => {
  try {
    const normalizedGender = normalizeGender(req.body.gender);

    if (!normalizedGender) {
      return res.status(400).json({
        success: false,
        message: "Gender must be MALE or FEMALE",
      });
    }

    const result = await pool.query(
      `
        UPDATE users
        SET gender = $1
        WHERE user_id = $2
        RETURNING user_id, role, name, cnic, email, mobile, gender, father_name, father_cnic,
                  blockchain_address, created_at, last_login, is_active
      `,
      [normalizedGender, req.user.userId]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.json({
      success: true,
      message: "Profile updated successfully",
      user: result.rows[0],
    });
  } catch (err) {
    console.error("❌ Update profile error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});
// Add this new route to your auth.js file (after the existing routes)

// =====================================================
// GET ALL REGISTRATIONS (EXCLUDING CITIZENS) - ADMIN ONLY
// =====================================================
router.get("/all-registrations", authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: "Access denied. Admin only."
      });
    }

    // Fetch PENDING registrations (LRO, NOTARY, ADMIN only - NO CITIZENS)
    const pendingUsers = await pool.query(
      `SELECT 
        u.user_id, u.name, u.email, u.cnic, u.mobile, u.role,
        u.created_at, u.approval_status
       FROM users u
       WHERE u.approval_status = 'PENDING' 
       AND u.role IN ('LAND RECORD OFFICER', 'LRO', 'DC', 'ADMIN')
       ORDER BY u.created_at DESC`
    );

    // Fetch APPROVED registrations (LRO, NOTARY, ADMIN only - NO CITIZENS)
    const approvedUsers = await pool.query(
      `SELECT 
        u.user_id, u.name, u.email, u.cnic, u.mobile, u.role,
        u.created_at, u.approved_at, u.approved_by
       FROM users u
       WHERE u.approval_status = 'APPROVED' 
       AND u.role IN ('LAND RECORD OFFICER', 'LRO', 'DC', 'ADMIN')
       ORDER BY u.approved_at DESC`
    );

    // Fetch REJECTED registrations (LRO, NOTARY, ADMIN only - NO CITIZENS)
    const rejectedUsers = await pool.query(
      `SELECT 
        u.user_id, u.name, u.email, u.cnic, u.mobile, u.role,
        u.created_at, u.approved_at, u.approved_by, u.rejection_reason
       FROM users u
       WHERE u.approval_status = 'REJECTED' 
       AND u.role IN ('LAND RECORD OFFICER', 'LRO', 'DC', 'ADMIN')
       ORDER BY u.approved_at DESC`
    );

    // Count approvals for today
    const approvedToday = await pool.query(
      `SELECT COUNT(*) as count
       FROM users
       WHERE approval_status = 'APPROVED'
       AND DATE(approved_at) = CURRENT_DATE
       AND role IN ('LAND RECORD OFFICER', 'LRO', 'DC', 'ADMIN')`
    );

    // Count rejections for today
    const rejectedToday = await pool.query(
      `SELECT COUNT(*) as count
       FROM users
       WHERE approval_status = 'REJECTED'
       AND DATE(approved_at) = CURRENT_DATE
       AND role IN ('LAND RECORD OFFICER', 'LRO', 'DC', 'ADMIN')`
    );

    return res.json({
      success: true,
      pending: pendingUsers.rows,
      approved: approvedUsers.rows,
      rejected: rejectedUsers.rows,
      approvedToday: parseInt(approvedToday.rows[0].count),
      rejectedToday: parseInt(rejectedToday.rows[0].count)
    });

  } catch (err) {
    console.error("❌ Get all registrations error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});
// =====================================================
// ALSO UPDATE THE EXISTING /pending-approvals ROUTE
// Add this filter to exclude citizens:
// =====================================================
// =====================================================
// UPDATE THE EXISTING /pending-approvals ROUTE IN auth.js
// Replace the existing route with this updated version
// =====================================================

router.get("/pending-approvals", authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: "Access denied. Admin only."
      });
    }

    // Fetch PENDING registrations (LRO and ADMIN only - NO CITIZENS, NO NOTARY)
    const pendingUsers = await pool.query(
      `SELECT 
        u.user_id, u.name, u.email, u.cnic, u.mobile, u.role,
        u.created_at, u.approval_status
       FROM users u
       WHERE u.approval_status = 'PENDING'
       AND u.role IN ('LAND RECORD OFFICER', 'LRO', 'DC', 'ADMIN')
       ORDER BY u.created_at DESC`
    );

    // Count approvals for today
    const approvedToday = await pool.query(
      `SELECT COUNT(*) as count
       FROM users
       WHERE approval_status = 'APPROVED'
       AND DATE(approved_at) = CURRENT_DATE
       AND role IN ('LAND RECORD OFFICER', 'LRO', 'DC', 'ADMIN')`
    );

    // Count rejections for today
    const rejectedToday = await pool.query(
      `SELECT COUNT(*) as count
       FROM users
       WHERE approval_status = 'REJECTED'
       AND DATE(approved_at) = CURRENT_DATE
       AND role IN ('LAND RECORD OFFICER', 'LRO', 'DC', 'ADMIN')`
    );

    return res.json({
      success: true,
      totalPending: pendingUsers.rows.length,
      approvedToday: parseInt(approvedToday.rows[0].count),
      rejectedToday: parseInt(rejectedToday.rows[0].count),
      users: pendingUsers.rows
    });

  } catch (err) {
    console.error("❌ Get pending approvals error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

export default router;