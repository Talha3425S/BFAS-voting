// // =====================================================
// // ADMIN ROUTES - User Management & Role Assignment
// // Location: backend/routes/admin.js
// // =====================================================

// const express = require("express");
// const router = express.Router();
// const pool = require("../config/db");
// const jwt = require("jsonwebtoken");

// // =====================================================
// // MIDDLEWARE - Verify Admin Access
// // =====================================================
// const verifyAdmin = async (req, res, next) => {
//   try {
//     const authHeader = req.headers.authorization;
//     if (!authHeader || !authHeader.startsWith("Bearer ")) {
//       return res.status(401).json({ success: false, message: "No token provided" });
//     }

//     const token = authHeader.split(" ")[1];
//     const decoded = jwt.verify(token, process.env.JWT_SECRET || "default-jwt-secret");

//     // Check if user is admin
//     if (decoded.role !== "ADMIN") {
//       // Log unauthorized attempt
//       await pool.query(
//         `INSERT INTO security_alerts (user_id, alert_type, description, ip_address, severity) 
//          VALUES ($1, $2, $3, $4, $5)`,
//         [
//           decoded.userId,
//           "UNAUTHORIZED_ACCESS",
//           `User attempted to access admin endpoint: ${req.path}`,
//           req.ip || req.connection.remoteAddress,
//           "HIGH"
//         ]
//       );

//       // Notify admin
//       await sendAdminAlert(
//         "UNAUTHORIZED_ACCESS",
//         `User ${decoded.userId} attempted admin access`,
//         "HIGH"
//       );

//       return res.status(403).json({ success: false, message: "Access denied. Admin only." });
//     }

//     req.user = decoded;
//     next();
//   } catch (err) {
//     console.error("❌ Admin verification error:", err);
//     return res.status(401).json({ success: false, message: "Invalid token" });
//   }
// };

// // =====================================================
// // UTILITY - Send Admin Alert
// // =====================================================
// async function sendAdminAlert(type, message, severity) {
//   try {
//     const adminEmail = process.env.ADMIN_EMAIL || "admin@landrecords.gov.pk";
//     console.log("\n🚨 ============ ADMIN ALERT ============");
//     console.log(`Type: ${type}`);
//     console.log(`Severity: ${severity}`);
//     console.log(`Message: ${message}`);
//     console.log(`Time: ${new Date().toISOString()}`);
//     console.log("======================================\n");

//     // In production, send actual email/SMS
//     // await sendEmail(adminEmail, `Alert: ${type}`, message);
//   } catch (err) {
//     console.error("Error sending admin alert:", err);
//   }
// }

// // =====================================================
// // UTILITY - Send User Notification
// // =====================================================
// async function notifyUser(email, name, subject, message) {
//   try {
//     console.log("\n📧 ============ USER NOTIFICATION ============");
//     console.log(`To: ${email}`);
//     console.log(`Name: ${name}`);
//     console.log(`Subject: ${subject}`);
//     console.log(`Message: ${message}`);
//     console.log("==========================================\n");

//     // In production, send actual email
//     // await sendEmail(email, subject, message);
//   } catch (err) {
//     console.error("Error sending user notification:", err);
//   }
// }

// // =====================================================
// // 1️⃣ GET ALL USERS (with filters)
// // =====================================================
// router.get("/users", verifyAdmin, async (req, res) => {
//   try {
//     const { role, search, page = 1, limit = 50 } = req.query;
//     const offset = (page - 1) * limit;

//     let query = `
//       SELECT user_id, name, email, cnic, mobile, role, 
//              account_locked, created_at, last_login, blockchain_address
//       FROM users 
//       WHERE 1=1
//     `;
//     const params = [];
//     let paramCount = 1;

//     if (role) {
//       query += ` AND role = $${paramCount}`;
//       params.push(role.toUpperCase());
//       paramCount++;
//     }

//     if (search) {
//       query += ` AND (name ILIKE $${paramCount} OR email ILIKE $${paramCount} OR cnic ILIKE $${paramCount})`;
//       params.push(`%${search}%`);
//       paramCount++;
//     }

//     query += ` ORDER BY created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
//     params.push(limit, offset);

//     const result = await pool.query(query, params);

//     // Get total count
//     let countQuery = "SELECT COUNT(*) FROM users WHERE 1=1";
//     const countParams = [];
//     let countParamCount = 1;

//     if (role) {
//       countQuery += ` AND role = $${countParamCount}`;
//       countParams.push(role.toUpperCase());
//       countParamCount++;
//     }

//     if (search) {
//       countQuery += ` AND (name ILIKE $${countParamCount} OR email ILIKE $${countParamCount} OR cnic ILIKE $${countParamCount})`;
//       countParams.push(`%${search}%`);
//     }

//     const countResult = await pool.query(countQuery, countParams);

//     return res.json({
//       success: true,
//       users: result.rows,
//       total: parseInt(countResult.rows[0].count),
//       page: parseInt(page),
//       pages: Math.ceil(countResult.rows[0].count / limit)
//     });
//   } catch (err) {
//     console.error("❌ Get users error:", err);
//     return res.status(500).json({ success: false, message: "Server error: " + err.message });
//   }
// });

// // =====================================================
// // 2️⃣ GET SINGLE USER DETAILS
// // =====================================================
// router.get("/users/:userId", verifyAdmin, async (req, res) => {
//   try {
//     const { userId } = req.params;

//     const result = await pool.query(
//       `SELECT user_id, name, email, cnic, mobile, role, 
//               account_locked, lock_until, failed_login_attempts,
//               created_at, updated_at, last_login, blockchain_address,
//               public_key
//        FROM users 
//        WHERE user_id = $1`,
//       [userId]
//     );

//     if (result.rows.length === 0) {
//       return res.status(404).json({ success: false, message: "User not found" });
//     }

//     // Get role history
//     const roleHistory = await pool.query(
//       `SELECT old_role, new_role, changed_by, changed_at, reason 
//        FROM role_change_history 
//        WHERE user_id = $1 
//        ORDER BY changed_at DESC 
//        LIMIT 10`,
//       [userId]
//     );

//     return res.json({
//       success: true,
//       user: result.rows[0],
//       roleHistory: roleHistory.rows
//     });
//   } catch (err) {
//     console.error("❌ Get user details error:", err);
//     return res.status(500).json({ success: false, message: "Server error: " + err.message });
//   }
// });

// // =====================================================
// // 3️⃣ UPDATE USER ROLE (REQ 17)
// // =====================================================
// router.patch("/users/:userId/role", verifyAdmin, async (req, res) => {
//   try {
//     const { userId } = req.params;
//     const { newRole, reason } = req.body;

//     // Validate role
//     const validRoles = ["CITIZEN", "OFFICER", "ADMIN", "TEHSILDAR"];
//     if (!validRoles.includes(newRole.toUpperCase())) {
//       return res.status(400).json({ 
//         success: false, 
//         message: "Invalid role. Must be: CITIZEN, OFFICER, ADMIN, or TEHSILDAR" 
//       });
//     }

//     // Get current user info
//     const userResult = await pool.query(
//       "SELECT user_id, name, email, role FROM users WHERE user_id = $1",
//       [userId]
//     );

//     if (userResult.rows.length === 0) {
//       return res.status(404).json({ success: false, message: "User not found" });
//     }

//     const user = userResult.rows[0];
//     const oldRole = user.role;

//     // Prevent self-demotion from admin
//     if (req.user.userId === userId && newRole.toUpperCase() !== "ADMIN") {
//       return res.status(400).json({ 
//         success: false, 
//         message: "Cannot change your own admin role" 
//       });
//     }

//     // Update role
//     await pool.query(
//       "UPDATE users SET role = $1, updated_at = NOW() WHERE user_id = $2",
//       [newRole.toUpperCase(), userId]
//     );

//     // Log role change in history (REQ 18)
//     await pool.query(
//       `INSERT INTO role_change_history 
//        (user_id, old_role, new_role, changed_by, reason) 
//        VALUES ($1, $2, $3, $4, $5)`,
//       [userId, oldRole, newRole.toUpperCase(), req.user.userId, reason || "Admin update"]
//     );

//     // Revoke all active sessions for this user
//     await pool.query(
//       "UPDATE jwt_sessions SET revoked = TRUE, revoked_at = NOW() WHERE user_id = $1 AND revoked = FALSE",
//       [userId]
//     );

//     // Send notification to user (REQ 19)
//     await notifyUser(
//       user.email,
//       user.name,
//       "Role Update - Action Required",
//       `Dear ${user.name},

// Your account role has been updated:
// Previous Role: ${oldRole}
// New Role: ${newRole.toUpperCase()}

// Reason: ${reason || "Administrative update"}
// Changed By: Admin (${req.user.userId})
// Date: ${new Date().toLocaleString()}

// All your active sessions have been logged out for security. Please login again with your credentials.

// If you have any questions, contact the administrator.

// Best regards,
// Punjab Land Records Authority`
//     );

//     // Log this action in audit trail
//     await pool.query(
//       `INSERT INTO audit_logs 
//        (action_type, performed_by, target_user, description, ip_address) 
//        VALUES ($1, $2, $3, $4, $5)`,
//       [
//         "ROLE_CHANGE",
//         req.user.userId,
//         userId,
//         `Changed role from ${oldRole} to ${newRole.toUpperCase()}. Reason: ${reason || "N/A"}`,
//         req.ip || req.connection.remoteAddress
//       ]
//     );

//     return res.json({
//       success: true,
//       message: "Role updated successfully. User has been logged out and notified.",
//       oldRole,
//       newRole: newRole.toUpperCase()
//     });
//   } catch (err) {
//     console.error("❌ Update role error:", err);
//     return res.status(500).json({ success: false, message: "Server error: " + err.message });
//   }
// });

// // =====================================================
// // 4️⃣ UPDATE ROLE PERMISSIONS (REQ 18)
// // =====================================================
// router.patch("/roles/:role/permissions", verifyAdmin, async (req, res) => {
//   try {
//     const { role } = req.params;
//     const { permissions } = req.body;

//     // Validate role
//     const validRoles = ["CITIZEN", "OFFICER", "ADMIN", "TEHSILDAR"];
//     if (!validRoles.includes(role.toUpperCase())) {
//       return res.status(400).json({ success: false, message: "Invalid role" });
//     }

//     // Validate permissions structure
//     if (!permissions || typeof permissions !== "object") {
//       return res.status(400).json({ 
//         success: false, 
//         message: "Permissions must be an object with permission keys and boolean values" 
//       });
//     }

//     // Update or insert role permissions
//     const existingRole = await pool.query(
//       "SELECT id FROM role_permissions WHERE role_name = $1",
//       [role.toUpperCase()]
//     );

//     if (existingRole.rows.length > 0) {
//       await pool.query(
//         `UPDATE role_permissions 
//          SET permissions = $1, updated_at = NOW(), updated_by = $2 
//          WHERE role_name = $3`,
//         [JSON.stringify(permissions), req.user.userId, role.toUpperCase()]
//       );
//     } else {
//       await pool.query(
//         `INSERT INTO role_permissions (role_name, permissions, updated_by) 
//          VALUES ($1, $2, $3)`,
//         [role.toUpperCase(), JSON.stringify(permissions), req.user.userId]
//       );
//     }

//     // Log permission change
//     await pool.query(
//       `INSERT INTO audit_logs 
//        (action_type, performed_by, description, ip_address) 
//        VALUES ($1, $2, $3, $4)`,
//       [
//         "PERMISSION_UPDATE",
//         req.user.userId,
//         `Updated permissions for role: ${role.toUpperCase()}`,
//         req.ip || req.connection.remoteAddress
//       ]
//     );

//     // Notify all users with this role
//     const usersWithRole = await pool.query(
//       "SELECT user_id, name, email FROM users WHERE role = $1",
//       [role.toUpperCase()]
//     );

//     for (const user of usersWithRole.rows) {
//       await notifyUser(
//         user.email,
//         user.name,
//         "Role Permissions Updated",
//         `Dear ${user.name},

// The permissions for your role (${role.toUpperCase()}) have been updated by the administrator.

// Please logout and login again for the changes to take effect.

// If you experience any issues, contact support.

// Best regards,
// Punjab Land Records Authority`
//       );
//     }

//     return res.json({
//       success: true,
//       message: `Permissions updated for role: ${role.toUpperCase()}. ${usersWithRole.rows.length} users notified.`,
//       affectedUsers: usersWithRole.rows.length
//     });
//   } catch (err) {
//     console.error("❌ Update permissions error:", err);
//     return res.status(500).json({ success: false, message: "Server error: " + err.message });
//   }
// });

// // =====================================================
// // 5️⃣ GET ROLE PERMISSIONS
// // =====================================================
// router.get("/roles/:role/permissions", verifyAdmin, async (req, res) => {
//   try {
//     const { role } = req.params;

//     const result = await pool.query(
//       "SELECT * FROM role_permissions WHERE role_name = $1",
//       [role.toUpperCase()]
//     );

//     if (result.rows.length === 0) {
//       // Return default permissions if not set
//       const defaultPermissions = getDefaultPermissions(role.toUpperCase());
//       return res.json({
//         success: true,
//         role: role.toUpperCase(),
//         permissions: defaultPermissions,
//         isDefault: true
//       });
//     }

//     return res.json({
//       success: true,
//       role: role.toUpperCase(),
//       permissions: result.rows[0].permissions,
//       updatedAt: result.rows[0].updated_at,
//       updatedBy: result.rows[0].updated_by,
//       isDefault: false
//     });
//   } catch (err) {
//     console.error("❌ Get permissions error:", err);
//     return res.status(500).json({ success: false, message: "Server error: " + err.message });
//   }
// });

// // =====================================================
// // 6️⃣ LOCK/UNLOCK USER ACCOUNT
// // =====================================================
// router.patch("/users/:userId/lock", verifyAdmin, async (req, res) => {
//   try {
//     const { userId } = req.params;
//     const { lock, reason } = req.body;

//     const user = await pool.query(
//       "SELECT user_id, name, email FROM users WHERE user_id = $1",
//       [userId]
//     );

//     if (user.rows.length === 0) {
//       return res.status(404).json({ success: false, message: "User not found" });
//     }

//     if (lock) {
//       await pool.query(
//         "UPDATE users SET account_locked = TRUE, lock_until = NULL WHERE user_id = $1",
//         [userId]
//       );
//     } else {
//       await pool.query(
//         `UPDATE users SET account_locked = FALSE, lock_until = NULL, 
//          failed_login_attempts = 0 WHERE user_id = $1`,
//         [userId]
//       );
//     }

//     // Notify user
//     await notifyUser(
//       user.rows[0].email,
//       user.rows[0].name,
//       lock ? "Account Locked" : "Account Unlocked",
//       `Dear ${user.rows[0].name},

// Your account has been ${lock ? "locked" : "unlocked"} by the administrator.

// Reason: ${reason || "Administrative action"}
// Date: ${new Date().toLocaleString()}

// ${lock ? "Please contact support to resolve this issue." : "You can now login to your account."}

// Best regards,
// Punjab Land Records Authority`
//     );

//     // Log action
//     await pool.query(
//       `INSERT INTO audit_logs 
//        (action_type, performed_by, target_user, description, ip_address) 
//        VALUES ($1, $2, $3, $4, $5)`,
//       [
//         lock ? "ACCOUNT_LOCKED" : "ACCOUNT_UNLOCKED",
//         req.user.userId,
//         userId,
//         reason || "Admin action",
//         req.ip || req.connection.remoteAddress
//       ]
//     );

//     return res.json({
//       success: true,
//       message: `Account ${lock ? "locked" : "unlocked"} successfully`
//     });
//   } catch (err) {
//     console.error("❌ Lock/unlock error:", err);
//     return res.status(500).json({ success: false, message: "Server error: " + err.message });
//   }
// });

// // =====================================================
// // 7️⃣ GET SECURITY ALERTS (REQ 6)
// // =====================================================
// router.get("/security-alerts", verifyAdmin, async (req, res) => {
//   try {
//     const { severity, limit = 100, offset = 0 } = req.query;

//     let query = `
//       SELECT sa.*, u.name, u.email, u.role 
//       FROM security_alerts sa
//       LEFT JOIN users u ON sa.user_id = u.user_id
//       WHERE 1=1
//     `;
//     const params = [];
//     let paramCount = 1;

//     if (severity) {
//       query += ` AND sa.severity = $${paramCount}`;
//       params.push(severity.toUpperCase());
//       paramCount++;
//     }

//     query += ` ORDER BY sa.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
//     params.push(limit, offset);

//     const result = await pool.query(query, params);

//     return res.json({
//       success: true,
//       alerts: result.rows,
//       count: result.rows.length
//     });
//   } catch (err) {
//     console.error("❌ Get alerts error:", err);
//     return res.status(500).json({ success: false, message: "Server error: " + err.message });
//   }
// });

// // =====================================================
// // 8️⃣ GET AUDIT LOGS
// // =====================================================
// router.get("/audit-logs", verifyAdmin, async (req, res) => {
//   try {
//     const { actionType, userId, startDate, endDate, limit = 100, offset = 0 } = req.query;

//     let query = `
//       SELECT al.*, 
//              u1.name as performer_name, u1.email as performer_email,
//              u2.name as target_name, u2.email as target_email
//       FROM audit_logs al
//       LEFT JOIN users u1 ON al.performed_by = u1.user_id
//       LEFT JOIN users u2 ON al.target_user = u2.user_id
//       WHERE 1=1
//     `;
//     const params = [];
//     let paramCount = 1;

//     if (actionType) {
//       query += ` AND al.action_type = $${paramCount}`;
//       params.push(actionType.toUpperCase());
//       paramCount++;
//     }

//     if (userId) {
//       query += ` AND (al.performed_by = $${paramCount} OR al.target_user = $${paramCount})`;
//       params.push(userId);
//       paramCount++;
//     }

//     if (startDate) {
//       query += ` AND al.created_at >= $${paramCount}`;
//       params.push(startDate);
//       paramCount++;
//     }

//     if (endDate) {
//       query += ` AND al.created_at <= $${paramCount}`;
//       params.push(endDate);
//       paramCount++;
//     }

//     query += ` ORDER BY al.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
//     params.push(limit, offset);

//     const result = await pool.query(query, params);

//     return res.json({
//       success: true,
//       logs: result.rows,
//       count: result.rows.length
//     });
//   } catch (err) {
//     console.error("❌ Get audit logs error:", err);
//     return res.status(500).json({ success: false, message: "Server error: " + err.message });
//   }
// });

// // =====================================================
// // HELPER FUNCTION - Default Permissions
// // =====================================================
// function getDefaultPermissions(role) {
//   const permissions = {
//     CITIZEN: {
//       viewOwnProperties: true,
//       requestTransfer: true,
//       uploadDocuments: true,
//       viewTransactionHistory: true,
//       downloadDocuments: true,
//       initiateTransfer: false,
//       approveTransfer: false,
//       manageUsers: false,
//       viewAllProperties: false,
//       manageNodes: false
//     },
//     OFFICER: {
//       viewOwnProperties: true,
//       requestTransfer: false,
//       uploadDocuments: true,
//       viewTransactionHistory: true,
//       downloadDocuments: true,
//       initiateTransfer: false,
//       approveTransfer: true,
//       manageUsers: false,
//       viewAllProperties: true,
//       manageNodes: false,
//       enterFardRecords: true,
//       verifyDocuments: true,
//       viewPendingTransfers: true
//     },
//     TEHSILDAR: {
//       viewOwnProperties: true,
//       requestTransfer: false,
//       uploadDocuments: true,
//       viewTransactionHistory: true,
//       downloadDocuments: true,
//       initiateTransfer: false,
//       approveTransfer: true,
//       manageUsers: false,
//       viewAllProperties: true,
//       manageNodes: false,
//       enterFardRecords: true,
//       verifyDocuments: true,
//       viewPendingTransfers: true,
//       finalApproval: true,
//       attestDocuments: true,
//       overrideOfficerDecision: true
//     },
//     ADMIN: {
//       viewOwnProperties: true,
//       requestTransfer: true,
//       uploadDocuments: true,
//       viewTransactionHistory: true,
//       downloadDocuments: true,
//       initiateTransfer: true,
//       approveTransfer: true,
//       manageUsers: true,
//       viewAllProperties: true,
//       manageNodes: true,
//       enterFardRecords: true,
//       verifyDocuments: true,
//       viewPendingTransfers: true,
//       finalApproval: true,
//       attestDocuments: true,
//       overrideOfficerDecision: true,
//       manageRoles: true,
//       viewAuditLogs: true,
//       manageSystemSettings: true
//     }
//   };

//   return permissions[role] || permissions.CITIZEN;
// }

// module.exports = router;