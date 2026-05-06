import pool from './src/config/db.js';
import crypto from 'crypto';

const client = await pool.connect();
try {
  // How many users have NO bank account?
  const missing = await client.query(`
    SELECT u.user_id, u.name, u.role
    FROM users u
    WHERE NOT EXISTS (
      SELECT 1 FROM bank_accounts ba WHERE ba.user_id = u.user_id
    )
    ORDER BY u.created_at
  `);
  console.log(`Users WITHOUT bank accounts: ${missing.rows.length}`);
  missing.rows.forEach(u => console.log(' ', u.user_id, u.name, `(${u.role})`));

  // How many have accounts?
  const hasAcct = await client.query(`SELECT COUNT(*) FROM bank_accounts`);
  const totalUsers = await client.query(`SELECT COUNT(*) FROM users`);
  console.log(`\nTotal users: ${totalUsers.rows[0].count}`);
  console.log(`Has bank account: ${hasAcct.rows[0].count}`);
  console.log(`Missing: ${missing.rows.length}`);

  // Show sample of existing account format
  const samples = await client.query(`
    SELECT user_id, account_no, account_title, bank_name, branch_code, branch_city, balance
    FROM bank_accounts LIMIT 3
  `);
  console.log('\nExisting account format:');
  samples.rows.forEach(r => console.log(' ', JSON.stringify(r)));

} finally {
  client.release();
  process.exit(0);
}
