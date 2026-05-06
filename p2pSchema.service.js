import pool from "../config/db.js";

const ALLOWED_MESSAGE_TYPES = [
  "TEXT",
  "SYSTEM",
  "PRICE_OFFER",
  "IMAGE",
  "IMAGE_MESSAGE",
  "VOICE_MESSAGE",
  "FILE",
  "AGREEMENT",
  "PAYMENT",
  "RECEIPT",
  "RECEIPT_PROPOSAL",
  "CHALLAN",
  "HASH_ANNOUNCEMENT",
  "PAYMENT_PROOF",
  "SELLER_PROOF",
  "DEADLINE_NOTICE",
  "SCREENSHOT",
  "VOICE_NOTE",
  "CALL_EVENT",
  "VIDEO_CALL",
  "AUDIO_CALL",
];

const CHANNEL_PARTICIPANTS_SQL = `
  CREATE TABLE IF NOT EXISTS channel_participants (
    participant_id SERIAL PRIMARY KEY,
    channel_id VARCHAR(120) NOT NULL,
    user_id VARCHAR(60) NOT NULL,
    role VARCHAR(20),
    is_online BOOLEAN DEFAULT FALSE,
    last_seen TIMESTAMP,
    joined_at TIMESTAMP DEFAULT NOW()
  )
`;

const CHANNEL_MESSAGES_SQL = `
  CREATE TABLE IF NOT EXISTS channel_messages (
    message_id SERIAL PRIMARY KEY,
    channel_id VARCHAR(120) NOT NULL,
    sender_id VARCHAR(60),
    sender_role VARCHAR(40),
    message_type VARCHAR(40) DEFAULT 'TEXT',
    message_content TEXT,
    price_offer NUMERIC,
    timestamp TIMESTAMP DEFAULT NOW(),
    read_by_other BOOLEAN DEFAULT FALSE,
    is_system_message BOOLEAN DEFAULT FALSE,
    transfer_id VARCHAR(120),
    is_read BOOLEAN DEFAULT FALSE,
    read_at TIMESTAMPTZ,
    file_url TEXT,
    file_name TEXT,
    file_size BIGINT,
    file_hash TEXT,
    expires_at TIMESTAMPTZ,
    payload JSONB
  )
`;

let schemaReady = false;

class P2PSchemaService {
  async ensureSchema() {
    if (schemaReady) {
      return;
    }

    await pool.query(CHANNEL_PARTICIPANTS_SQL);
    await pool.query(CHANNEL_MESSAGES_SQL);

    await pool.query(`
      ALTER TABLE channel_messages
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS transfer_request_id VARCHAR(120)
    `);

    await pool.query(`
      ALTER TABLE channel_messages
        DROP CONSTRAINT IF EXISTS chk_message_type
    `);

    await pool.query(`
      ALTER TABLE channel_messages
        ADD CONSTRAINT chk_message_type
        CHECK (message_type IN (${ALLOWED_MESSAGE_TYPES.map((type) => `'${type}'`).join(", ")}))
    `);

    schemaReady = true;
  }

  async getSchemaStatus() {
    const result = await pool.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [["channel_participants", "channel_messages", "transfer_requests"]]
    );

    const present = new Set(result.rows.map((row) => row.table_name));

    return {
      channelParticipants: present.has("channel_participants"),
      channelMessages: present.has("channel_messages"),
      transferRequests: present.has("transfer_requests"),
      complete:
        present.has("channel_participants") &&
        present.has("channel_messages") &&
        present.has("transfer_requests"),
    };
  }
}

export default new P2PSchemaService();
