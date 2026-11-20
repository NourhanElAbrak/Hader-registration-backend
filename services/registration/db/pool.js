// One shared connection pool to the Supabase database.
// The connection string comes ONLY from the DATABASE_URL environment variable.
const fs = require('fs');
const { Pool } = require('pg');

// TLS: if the Supabase CA certificate is provided (DB_CA_PATH), the server's identity
// is fully verified. Otherwise the connection is still encrypted, but not verified.
let ssl = { rejectUnauthorized: false };
if (process.env.DB_CA_PATH) {
  ssl = { ca: fs.readFileSync(process.env.DB_CA_PATH, 'utf8') };
} else if (process.env.DB_SSL === 'off') {
  ssl = false; // only for a local test database
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
  max: 3 // small: every Lambda copy opens its own pool
});

module.exports = pool;
