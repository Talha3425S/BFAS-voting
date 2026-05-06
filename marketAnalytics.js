// =====================================================
// MARKET ANALYTICS ROUTES
// Location: backend/src/routes/marketAnalytics.js
// Purpose: Real estate market dashboard with trends and insights
// =====================================================

import express from "express";
const router = express.Router();
import pool from "../config/db.js";
import jwt from "jsonwebtoken";

// =====================================================
// MIDDLEWARE - JWT Authentication (Optional for public data)
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
// 1️⃣ MARKET OVERVIEW - Key Statistics
// =====================================================
router.get("/overview", async (req, res) => {
  try {
    console.log("\n========================================");
    console.log("📊 FETCHING MARKET OVERVIEW");
    console.log("========================================");

    // Total registered properties
    const totalPropertiesResult = await pool.query(
      `SELECT COUNT(*) as total FROM properties WHERE status = 'APPROVED'`
    );

    // Total completed transfers
    const totalTransfersResult = await pool.query(
      `SELECT COUNT(*) as total FROM ownership_history`
    );

    // Total transaction value (last 12 months)
    const totalValueResult = await pool.query(
      `SELECT COALESCE(SUM(transfer_amount), 0) as total_value
       FROM ownership_history
       WHERE transfer_date >= NOW() - INTERVAL '12 months'`
    );

    // Average property price by type
    const avgPriceByTypeResult = await pool.query(
      `SELECT 
        p.property_type,
        COUNT(*) as property_count,
        ROUND(AVG(oh.transfer_amount)::numeric, 2) as avg_price,
        ROUND(MIN(oh.transfer_amount)::numeric, 2) as min_price,
        ROUND(MAX(oh.transfer_amount)::numeric, 2) as max_price
       FROM properties p
       INNER JOIN ownership_history oh ON p.property_id = oh.property_id
       WHERE p.status = 'APPROVED' AND oh.transfer_date >= NOW() - INTERVAL '12 months'
       GROUP BY p.property_type
       ORDER BY property_count DESC`
    );

    // Active transfer requests
    const activeTransfersResult = await pool.query(
      `SELECT COUNT(*) as active 
       FROM transfer_requests 
       WHERE status IN ('PENDING', 'PAYMENT_UPLOADED', 'PAYMENT_VERIFIED')`
    );

    // Properties with most transfers (hotspots)
    const hotPropertiesResult = await pool.query(
      `SELECT 
        p.property_id,
        p.district,
        p.tehsil,
        p.mauza,
        p.property_type,
        p.area_marla,
        COUNT(oh.id) as transfer_count,
        MAX(oh.transfer_date) as last_transfer_date
       FROM properties p
       INNER JOIN ownership_history oh ON p.property_id = oh.property_id
       WHERE p.status = 'APPROVED'
       GROUP BY p.property_id
       HAVING COUNT(oh.id) >= 2
       ORDER BY transfer_count DESC
       LIMIT 10`
    );

    console.log("✅ Market overview compiled");
    console.log("========================================\n");

    return res.json({
      success: true,
      overview: {
        total_properties: parseInt(totalPropertiesResult.rows[0].total),
        total_transfers: parseInt(totalTransfersResult.rows[0].total),
        total_transaction_value: parseFloat(totalValueResult.rows[0].total_value),
        active_transfers: parseInt(activeTransfersResult.rows[0].active),
        avg_price_by_type: avgPriceByTypeResult.rows,
        hot_properties: hotPropertiesResult.rows
      }
    });

  } catch (err) {
    console.error("❌ Error fetching market overview:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

// =====================================================
// 2️⃣ TRANSACTION TRENDS - Monthly Volume & Value
// =====================================================
router.get("/trends/monthly", async (req, res) => {
  try {
    const { months = 12 } = req.query;

    console.log("\n========================================");
    console.log("📈 FETCHING MONTHLY TRANSACTION TRENDS");
    console.log(`Period: Last ${months} months`);
    console.log("========================================");

    const trendsResult = await pool.query(
      `SELECT 
        TO_CHAR(transfer_date, 'YYYY-MM') as month,
        COUNT(*) as transaction_count,
        ROUND(SUM(transfer_amount)::numeric, 2) as total_value,
        ROUND(AVG(transfer_amount)::numeric, 2) as avg_transaction_value,
        ROUND(MIN(transfer_amount)::numeric, 2) as min_value,
        ROUND(MAX(transfer_amount)::numeric, 2) as max_value
       FROM ownership_history
       WHERE transfer_date >= NOW() - INTERVAL '${parseInt(months)} months'
       GROUP BY TO_CHAR(transfer_date, 'YYYY-MM')
       ORDER BY month DESC`,
      []
    );

    console.log(`✅ Found data for ${trendsResult.rows.length} months`);
    console.log("========================================\n");

    return res.json({
      success: true,
      period: `${months} months`,
      trends: trendsResult.rows
    });

  } catch (err) {
    console.error("❌ Error fetching trends:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

// =====================================================
// 3️⃣ AVERAGE LAND RATES BY LOCATION
// =====================================================
router.get("/rates/by-location", async (req, res) => {
  try {
    const { district, tehsil } = req.query;

    console.log("\n========================================");
    console.log("💰 FETCHING LAND RATES BY LOCATION");
    if (district) console.log("District:", district);
    if (tehsil) console.log("Tehsil:", tehsil);
    console.log("========================================");

    let query = `
      SELECT 
        p.district,
        p.tehsil,
        p.mauza,
        p.property_type,
        COUNT(DISTINCT p.property_id) as property_count,
        COUNT(oh.id) as transaction_count,
        ROUND(AVG(oh.transfer_amount)::numeric, 2) as avg_rate,
        ROUND(AVG(oh.transfer_amount / NULLIF(p.area_marla, 0))::numeric, 2) as avg_rate_per_marla,
        ROUND(MIN(oh.transfer_amount)::numeric, 2) as min_rate,
        ROUND(MAX(oh.transfer_amount)::numeric, 2) as max_rate,
        MAX(oh.transfer_date) as last_transaction_date
       FROM properties p
       INNER JOIN ownership_history oh ON p.property_id = oh.property_id
       WHERE p.status = 'APPROVED'
    `;

    const params = [];
    let paramCount = 1;

    if (district) {
      query += ` AND p.district ILIKE $${paramCount}`;
      params.push(`%${district}%`);
      paramCount++;
    }

    if (tehsil) {
      query += ` AND p.tehsil ILIKE $${paramCount}`;
      params.push(`%${tehsil}%`);
      paramCount++;
    }

    query += `
       GROUP BY p.district, p.tehsil, p.mauza, p.property_type
       HAVING COUNT(oh.id) > 0
       ORDER BY transaction_count DESC, avg_rate DESC
       LIMIT 50
    `;

    const ratesResult = await pool.query(query, params);

    console.log(`✅ Found rates for ${ratesResult.rows.length} locations`);
    console.log("========================================\n");

    return res.json({
      success: true,
      filters: { district, tehsil },
      total_locations: ratesResult.rows.length,
      rates: ratesResult.rows
    });

  } catch (err) {
    console.error("❌ Error fetching rates:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

// =====================================================
// 4️⃣ PROPERTY TYPE DISTRIBUTION
// =====================================================
router.get("/distribution/property-types", async (req, res) => {
  try {
    console.log("\n========================================");
    console.log("🏘️ FETCHING PROPERTY TYPE DISTRIBUTION");
    console.log("========================================");

    const distributionResult = await pool.query(
      `SELECT 
        property_type,
        COUNT(*) as count,
        ROUND((COUNT(*) * 100.0 / SUM(COUNT(*)) OVER())::numeric, 2) as percentage,
        ROUND(AVG(area_marla)::numeric, 2) as avg_area
       FROM properties
       WHERE status = 'APPROVED'
       GROUP BY property_type
       ORDER BY count DESC`
    );

    console.log(`✅ Found ${distributionResult.rows.length} property types`);
    console.log("========================================\n");

    return res.json({
      success: true,
      distribution: distributionResult.rows
    });

  } catch (err) {
    console.error("❌ Error fetching distribution:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

// =====================================================
// 5️⃣ HOTSPOT ANALYSIS - Most Active Areas
// =====================================================
router.get("/hotspots", async (req, res) => {
  try {
    const { limit = 20 } = req.query;

    console.log("\n========================================");
    console.log("🔥 FETCHING MARKET HOTSPOTS");
    console.log(`Limit: Top ${limit}`);
    console.log("========================================");

    // By District
    const districtHotspotsResult = await pool.query(
      `SELECT 
        p.district,
        COUNT(DISTINCT p.property_id) as property_count,
        COUNT(oh.id) as transaction_count,
        ROUND(SUM(oh.transfer_amount)::numeric, 2) as total_value,
        ROUND(AVG(oh.transfer_amount)::numeric, 2) as avg_transaction_value,
        MAX(oh.transfer_date) as last_transaction
       FROM properties p
       INNER JOIN ownership_history oh ON p.property_id = oh.property_id
       WHERE p.status = 'APPROVED'
       GROUP BY p.district
       ORDER BY transaction_count DESC
       LIMIT $1`,
      [parseInt(limit)]
    );

    // By Tehsil
    const tehsilHotspotsResult = await pool.query(
      `SELECT 
        p.district,
        p.tehsil,
        COUNT(DISTINCT p.property_id) as property_count,
        COUNT(oh.id) as transaction_count,
        ROUND(SUM(oh.transfer_amount)::numeric, 2) as total_value,
        ROUND(AVG(oh.transfer_amount)::numeric, 2) as avg_transaction_value,
        MAX(oh.transfer_date) as last_transaction
       FROM properties p
       INNER JOIN ownership_history oh ON p.property_id = oh.property_id
       WHERE p.status = 'APPROVED'
       GROUP BY p.district, p.tehsil
       ORDER BY transaction_count DESC
       LIMIT $1`,
      [parseInt(limit)]
    );

    // By Mauza (Village)
    const mauzaHotspotsResult = await pool.query(
      `SELECT 
        p.district,
        p.tehsil,
        p.mauza,
        COUNT(DISTINCT p.property_id) as property_count,
        COUNT(oh.id) as transaction_count,
        ROUND(SUM(oh.transfer_amount)::numeric, 2) as total_value,
        ROUND(AVG(oh.transfer_amount)::numeric, 2) as avg_transaction_value,
        MAX(oh.transfer_date) as last_transaction
       FROM properties p
       INNER JOIN ownership_history oh ON p.property_id = oh.property_id
       WHERE p.status = 'APPROVED' AND p.mauza IS NOT NULL
       GROUP BY p.district, p.tehsil, p.mauza
       ORDER BY transaction_count DESC
       LIMIT $1`,
      [parseInt(limit)]
    );

    console.log("✅ Hotspots analysis completed");
    console.log("========================================\n");

    return res.json({
      success: true,
      hotspots: {
        by_district: districtHotspotsResult.rows,
        by_tehsil: tehsilHotspotsResult.rows,
        by_mauza: mauzaHotspotsResult.rows
      }
    });

  } catch (err) {
    console.error("❌ Error fetching hotspots:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

// =====================================================
// 6️⃣ RECENT TRANSACTIONS
// =====================================================
router.get("/transactions/recent", async (req, res) => {
  try {
    const { limit = 50, district, tehsil } = req.query;

    console.log("\n========================================");
    console.log("📋 FETCHING RECENT TRANSACTIONS");
    console.log(`Limit: ${limit}`);
    console.log("========================================");

    let query = `
      SELECT 
        oh.id,
        oh.property_id,
        oh.transfer_date,
        oh.transfer_amount,
        oh.transfer_type,
        
        p.district,
        p.tehsil,
        p.mauza,
        p.property_type,
        p.area_marla,
        ROUND((oh.transfer_amount / NULLIF(p.area_marla, 0))::numeric, 2) as rate_per_marla,
        
        prev_user.name as seller_name,
        new_user.name as buyer_name
        
       FROM ownership_history oh
       INNER JOIN properties p ON oh.property_id = p.property_id
       LEFT JOIN users prev_user ON oh.previous_owner_id = prev_user.user_id
       LEFT JOIN users new_user ON oh.new_owner_id = new_user.user_id
       
       WHERE p.status = 'APPROVED'
    `;

    const params = [];
    let paramCount = 1;

    if (district) {
      query += ` AND p.district ILIKE $${paramCount}`;
      params.push(`%${district}%`);
      paramCount++;
    }

    if (tehsil) {
      query += ` AND p.tehsil ILIKE $${paramCount}`;
      params.push(`%${tehsil}%`);
      paramCount++;
    }

    query += `
       ORDER BY oh.transfer_date DESC
       LIMIT $${paramCount}
    `;
    params.push(parseInt(limit));

    const transactionsResult = await pool.query(query, params);

    console.log(`✅ Found ${transactionsResult.rows.length} transactions`);
    console.log("========================================\n");

    return res.json({
      success: true,
      filters: { limit, district, tehsil },
      total: transactionsResult.rows.length,
      transactions: transactionsResult.rows
    });

  } catch (err) {
    console.error("❌ Error fetching transactions:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

// =====================================================
// 7️⃣ PRICE COMPARISON - By Area Range
// =====================================================
router.get("/comparison/by-area", async (req, res) => {
  try {
    console.log("\n========================================");
    console.log("📏 PRICE COMPARISON BY AREA RANGE");
    console.log("========================================");

    const comparisonResult = await pool.query(
      `SELECT 
        CASE 
          WHEN p.area_marla < 5 THEN '0-5 Marla'
          WHEN p.area_marla >= 5 AND p.area_marla < 10 THEN '5-10 Marla'
          WHEN p.area_marla >= 10 AND p.area_marla < 20 THEN '10-20 Marla'
          WHEN p.area_marla >= 20 AND p.area_marla < 50 THEN '20-50 Marla'
          ELSE '50+ Marla'
        END as area_range,
        COUNT(DISTINCT p.property_id) as property_count,
        COUNT(oh.id) as transaction_count,
        ROUND(AVG(oh.transfer_amount)::numeric, 2) as avg_price,
        ROUND(AVG(oh.transfer_amount / NULLIF(p.area_marla, 0))::numeric, 2) as avg_rate_per_marla,
        ROUND(MIN(oh.transfer_amount)::numeric, 2) as min_price,
        ROUND(MAX(oh.transfer_amount)::numeric, 2) as max_price
       FROM properties p
       INNER JOIN ownership_history oh ON p.property_id = oh.property_id
       WHERE p.status = 'APPROVED' AND oh.transfer_date >= NOW() - INTERVAL '12 months'
       GROUP BY area_range
       ORDER BY 
         CASE area_range
           WHEN '0-5 Marla' THEN 1
           WHEN '5-10 Marla' THEN 2
           WHEN '10-20 Marla' THEN 3
           WHEN '20-50 Marla' THEN 4
           ELSE 5
         END`
    );

    console.log("✅ Price comparison completed");
    console.log("========================================\n");

    return res.json({
      success: true,
      comparison: comparisonResult.rows
    });

  } catch (err) {
    console.error("❌ Error fetching comparison:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

// =====================================================
// 8️⃣ AVAILABLE LOCATIONS - Dropdown Data
// =====================================================
router.get("/locations", async (req, res) => {
  try {
    console.log("\n========================================");
    console.log("📍 FETCHING AVAILABLE LOCATIONS");
    console.log("========================================");

    // Districts
    const districtsResult = await pool.query(
      `SELECT DISTINCT district 
       FROM properties 
       WHERE status = 'APPROVED' AND district IS NOT NULL
       ORDER BY district`
    );

    // Tehsils
    const tehsilsResult = await pool.query(
      `SELECT DISTINCT district, tehsil 
       FROM properties 
       WHERE status = 'APPROVED' AND tehsil IS NOT NULL
       ORDER BY district, tehsil`
    );

    console.log(`✅ Found ${districtsResult.rows.length} districts`);
    console.log("========================================\n");

    return res.json({
      success: true,
      districts: districtsResult.rows,
      tehsils: tehsilsResult.rows
    });

  } catch (err) {
    console.error("❌ Error fetching locations:", err);
    return res.status(500).json({
      success: false,
      message: "Server error: " + err.message
    });
  }
});

export default router;