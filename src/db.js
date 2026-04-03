const postgres = require('postgres');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const sql = postgres(DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
  transform: { undefined: null },
});

async function checkConnection() {
  try {
    const [{ now }] = await sql`SELECT NOW() as now`;
    return { connected: true, timestamp: now };
  } catch (err) {
    return { connected: false, error: err.message };
  }
}

module.exports = { sql, checkConnection };
