import pool from './src/config/db.js';
import successionRuleService from './src/services/successionRule.service.js';
import crypto from 'crypto';

const userId = 'USR726722';
const propertyId = 'PROP-1776504026584-3203';

const client = await pool.connect();
try {
  const propR = await client.query(
    `SELECT p.*, u.gender AS owner_gender FROM properties p LEFT JOIN users u ON u.user_id = p.owner_id WHERE p.property_id=$1 AND p.owner_id=$2 AND p.status='APPROVED' LIMIT 1`,
    [propertyId, userId]
  );
  const property = propR.rows[0];
  const famR = await client.query(
    `SELECT * FROM family_members WHERE owner_user_id=$1 AND COALESCE(is_active, TRUE)=TRUE`,
    [userId]
  );
  const familyMembers = famR.rows;
  const ownerGender = (property.owner_gender || '').trim().toUpperCase();
  const preview = successionRuleService.buildIslamicFamilyPreview({ ownerGender, familyMembers });

  const heir = preview.allocations[0];
  
  // The date as-is from DB
  console.log('dateOfBirth type:', Object.prototype.toString.call(heir.dateOfBirth));
  console.log('dateOfBirth value:', heir.dateOfBirth);
  
  // Proper conversion: if it's a Date object, use toISOString().substring(0,10)
  // if it's already a string, handle it too
  function safeDateOnly(d) {
    if (!d) return null;
    if (d instanceof Date) return d.toISOString().substring(0, 10);
    const s = String(d).trim();
    if (!s) return null;
    // If already YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // If ISO string
    return new Date(s).toISOString().substring(0, 10);
  }
  
  console.log('safeDateOnly:', safeDateOnly(heir.dateOfBirth));
  
  // Test the exact route INSERT using the real succession_request_id
  const successionRequestId = crypto.randomUUID();
  
  await client.query('BEGIN');
  try {
    // First insert the succession_request  
    await client.query(
      `INSERT INTO succession_requests (succession_request_id, request_no, property_id, requester_user_id, owner_user_id, request_type, owner_gender, death_certificate_reference, notes, status, lro_status, blockchain_status, dc_status, total_allocated_percent, total_heirs, share_snapshot, submitted_at, created_at, updated_at, share_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,NULL,'PENDING','PENDING','NOT_SUBMITTED','PENDING',$8,$9,$10::jsonb,NOW(),NOW(),NOW(),$11)`,
      [successionRequestId, 'TEST-' + Date.now(), propertyId, userId, property.owner_id,
       'ISLAMIC_FAMILY_DIVISION', ownerGender, preview.totalAllocatedPercent,
       preview.totalHeirs, JSON.stringify(preview.shareSnapshot), 'testhash']
    );
    console.log('✅ succession_requests INSERT OK');
    
    // Now test heir INSERT with safe date
    for (const h of preview.allocations) {
      const safeDate = safeDateOnly(h.dateOfBirth);
      await client.query(
        `INSERT INTO succession_heirs (heir_id, succession_request_id, family_member_id, linked_user_id, relation_type, full_name, cnic, date_of_birth, is_minor, share_numerator, share_denominator, share_percent, share_fraction_text, share_basis, allocation_kind, created_at)
         VALUES ($1, $2, $3::uuid, $4, $5, $6, NULLIF($7,''), $8::date, $9, $10, $11, $12, $13, $14, $15, NOW())`,
        [
          crypto.randomUUID(), successionRequestId, h.familyMemberId,
          h.linkedUserId, h.relationType, h.fullName,
          h.cnic || '', safeDate, h.isMinor,
          h.shareNumerator, h.shareDenominator, h.sharePercent,
          h.shareFractionText, h.shareBasis, h.allocationKind,
        ]
      );
      console.log('✅ Heir INSERT OK:', h.fullName);
    }
  } catch(e) {
    console.log('❌ INSERT error:', e.message);
  }
  await client.query('ROLLBACK');

} catch(e) {
  console.error('ERROR:', e.message);
} finally {
  client.release();
  process.exit(0);
}
