// require("dotenv").config();
// const { Pool } = require("pg");
// const bcrypt = require("bcrypt");
// const { v4: uuidv4 } = require("uuid");

// // PostgreSQL connection
// const pool = new Pool({
//     user: process.env.DB_USER || "postgres",
//     host: process.env.DB_HOST || "localhost",
//     database: process.env.DB_NAME || "landdb",
//     password: process.env.DB_PASSWORD || "6700",
//     port: process.env.DB_PORT || 5432,
// });

// (async () => {
//     try {
//         await pool.connect();
//         console.log("✅ Connected to DB");

//         // Sample data
//         const name = "Talha Jameel";
//         const cnic = "1234512345671";
//         const email = "talha@test.com";
//         const mobile = "03001234567";
//         const password = "Password123";

//         // Hash password
//         const hash = await bcrypt.hash(password, 10);

//         // Generate IDs
//         const id = uuidv4();
//         let userID;
//         while (true) {
//             userID = "USR" + Math.floor(100000 + Math.random() * 900000);
//             const existing = await pool.query("SELECT * FROM users WHERE user_id=$1", [userID]);
//             if (existing.rows.length === 0) break;
//         }

//         // Insert user
//         const queryText = `
//             INSERT INTO users (id, user_id, role, name, cnic, email, mobile, password_hash)
//             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
//         `;
//         const params = [id, userID, "CITIZEN", name, cnic, email, mobile, hash];

//         await pool.query(queryText, params);

//         console.log("✅ User inserted successfully:", userID);

//         process.exit(0);
//     } catch (err) {
//         console.error("🔥 ERROR inserting user:", err);
//         process.exit(1);
//     }
// })();
