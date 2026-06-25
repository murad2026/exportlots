const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set — Postgres connection will fail.');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && !DATABASE_URL.includes('localhost') ? { rejectUnauthorized: false } : false,
});

pool.on('error', (e) => console.error('Postgres pool error:', e.message));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vehicles (
      lot TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS vehicles_private (
      lot TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS dealers (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS pending (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS photos (
      lot TEXT PRIMARY KEY,
      data BYTEA NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      dealer_id TEXT,
      lot TEXT,
      type TEXT NOT NULL,
      meta JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS events_dealer_idx ON events (dealer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS events_lot_idx ON events (lot);
    CREATE INDEX IF NOT EXISTS events_created_idx ON events (created_at DESC);
  `);
  const { rows } = await pool.query('SELECT count(*) FROM vehicles');
  console.log(`Postgres connected. vehicles table has ${rows[0].count} row(s).`);
  // Clean up orphaned photos on every startup
  const cleanup = await pool.query(`DELETE FROM photos WHERE lot NOT IN (SELECT lot FROM vehicles)`);
  if (cleanup.rowCount > 0) console.log(`Cleaned up ${cleanup.rowCount} orphaned photo(s).`);
}

// ---- generic document-table helpers ----
// Each table stores one JSON "document" per row, keyed by idCol, mirroring
// the shape the app already works with (arrays of plain objects).

async function allDocs(table) {
  const { rows } = await pool.query(`SELECT data FROM ${table} ORDER BY created_at DESC NULLS LAST`);
  return rows.map(r => r.data);
}

async function getDoc(table, idCol, id) {
  const { rows } = await pool.query(`SELECT data FROM ${table} WHERE ${idCol} = $1`, [id]);
  return rows[0] ? rows[0].data : null;
}

async function insertDoc(table, idCol, id, data) {
  await pool.query(`INSERT INTO ${table} (${idCol}, data) VALUES ($1, $2)`, [id, data]);
}

async function updateDoc(table, idCol, id, data) {
  const { rowCount } = await pool.query(`UPDATE ${table} SET data = $2 WHERE ${idCol} = $1`, [id, data]);
  return rowCount > 0;
}

async function deleteDoc(table, idCol, id) {
  await pool.query(`DELETE FROM ${table} WHERE ${idCol} = $1`, [id]);
}

// Generates the next lot number atomically: takes a Postgres advisory
// transaction lock so two concurrent inserts can never compute the same
// number, then inserts the vehicle (and private record) in the same
// transaction. Replaces the old in-process file-lock + JSON array rewrite.
async function withNextLotInsert(year, vehicleFn, privateFn, photoBuffer) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(727271)');
    const { rows: vrows } = await client.query(
      `SELECT lot FROM vehicles WHERE lot LIKE $1`,
      [`EL-${year}-%`]
    );
    const { rows: prows } = await client.query(
      `SELECT lot FROM photos WHERE lot LIKE $1`,
      [`EL-${year}-%`]
    );
    const allLots = [...vrows, ...prows];
    const nums = allLots
      .map(r => parseInt(r.lot.split('-')[2]))
      .filter(n => !isNaN(n));
    const next = nums.length ? Math.max(...nums) + 1 : 1;
    const lot = `EL-${year}-${String(next).padStart(4, '0')}`;

    const vehicle = vehicleFn(lot);
    await client.query('INSERT INTO vehicles (lot, data) VALUES ($1, $2)', [lot, vehicle]);
    const priv = privateFn(lot);
    await client.query('INSERT INTO vehicles_private (lot, data) VALUES ($1, $2)', [lot, priv]);
    if (photoBuffer) {
      await client.query('INSERT INTO photos (lot, data) VALUES ($1, $2) ON CONFLICT (lot) DO UPDATE SET data = $2', [lot, photoBuffer]);
    } else {
      await client.query('DELETE FROM photos WHERE lot = $1', [lot]);
    }

    await client.query('COMMIT');
    return { lot, vehicle };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function getPhoto(lot) {
  const { rows } = await pool.query('SELECT data FROM photos WHERE lot = $1', [lot]);
  return rows[0] ? rows[0].data : null;
}

// ---- dealer activity events ----
// Records what a logged-in dealer does (opened a car, clicked WhatsApp,
// searched). Identity comes from the server-side session, never the client.
async function logEvent(dealerId, lot, type, meta) {
  await pool.query(
    `INSERT INTO events (dealer_id, lot, type, meta) VALUES ($1, $2, $3, $4)`,
    [dealerId || null, lot || null, type, meta ? JSON.stringify(meta) : null]
  );
}

// Returns recent events (default last 30 days), newest first.
async function getEvents(sinceDays = 30, limit = 5000) {
  const { rows } = await pool.query(
    `SELECT dealer_id, lot, type, meta, created_at
       FROM events
      WHERE created_at > now() - ($1 || ' days')::interval
      ORDER BY created_at DESC
      LIMIT $2`,
    [String(sinceDays), limit]
  );
  return rows;
}

async function findLotByVin(vin_full) {
  const { rows } = await pool.query(
    `SELECT lot FROM vehicles_private WHERE data->>'vin_full' = $1 LIMIT 1`,
    [vin_full]
  );
  return rows[0] ? rows[0].lot : null;
}

module.exports = { pool, initDb, allDocs, getDoc, insertDoc, updateDoc, deleteDoc, withNextLotInsert, getPhoto, findLotByVin, logEvent, getEvents };
