'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª Ø§Ù„ØªÙ†Ø¨ÙŠÙ‡Ø§Øª Ø§Ù„Ø§ÙØªØ±Ø§Ø¶ÙŠØ©
const defaultTemplate = `Ù…Ø±Ø­Ø¨Ø§Ù‹ Ø¨Ùƒ ÙŠØ§ {name} ÙÙŠ {gym} ðŸ‹ï¸â€â™‚ï¸âœ¨

Ù†ÙˆØ¯ ØªØ°ÙƒÙŠØ±Ùƒ Ø¨Ø£Ù† Ø§Ø´ØªØ±Ø§ÙƒÙƒ Ø§Ù„Ø­Ø§Ù„ÙŠ ({plan}) Ø³ÙŠÙ†ØªÙ‡ÙŠ Ù‚Ø±ÙŠØ¨Ø§Ù‹:
ðŸ“… ØªØ§Ø±ÙŠØ® Ø§Ù„Ø§Ù†ØªÙ‡Ø§Ø¡: {end_date}
â³ Ù…ØªØ¨Ù‚ÙŠ: {days_left}

Ù„ØªØ¬Ø¯ÙŠØ¯ Ø§Ù„Ø§Ø´ØªØ±Ø§Ùƒ ÙˆØªØ¬Ù†Ø¨ ØªÙˆÙ‚Ù ÙƒÙˆØ¯ Ø§Ù„Ø¯Ø®ÙˆÙ„ØŒ ÙŠÙ…ÙƒÙ†Ùƒ Ø§Ù„ØªØ¬Ø¯ÙŠØ¯ ÙÙŠ Ø²ÙŠØ§Ø±ØªÙƒ Ø§Ù„Ù‚Ø§Ø¯Ù…Ø© Ø¨Ù…ÙƒØªØ¨ Ø§Ù„Ø§Ø³ØªÙ‚Ø¨Ø§Ù„.

Ù†ØªÙ…Ù†Ù‰ Ù„Ùƒ ÙˆÙ‚ØªØ§Ù‹ Ù…Ù…ØªØ¹Ø§Ù‹ ÙˆØªØ¯Ø±ÙŠØ¨Ø§Ù‹ Ù…ÙˆÙÙ‚Ø§Ù‹! ðŸ’ªðŸ”¥`;

let currentDb = null;

function initDbSchema(conn) {
  conn.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -64000;');

  conn.exec(`
  CREATE TABLE IF NOT EXISTS plans (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    duration_days INTEGER NOT NULL CHECK (duration_days > 0),
    price         REAL NOT NULL DEFAULT 0,
    active        INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS members (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    code       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    phone      TEXT NOT NULL DEFAULT '',
    age        INTEGER,
    notes      TEXT NOT NULL DEFAULT '',
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    plan_id    INTEGER REFERENCES plans(id),
    plan_name  TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date   TEXT NOT NULL,
    price      REAL NOT NULL DEFAULT 0,
    status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sub_member ON subscriptions(member_id, status, end_date);
  CREATE INDEX IF NOT EXISTS idx_sub_created ON subscriptions(created_at);

  CREATE TABLE IF NOT EXISTS attendance (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    day        TEXT NOT NULL,
    checkin_at TEXT NOT NULL,
    result     TEXT NOT NULL CHECK (result IN ('ok','denied')),
    reason     TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_att_day ON attendance(day);
  CREATE INDEX IF NOT EXISTS idx_att_member ON attendance(member_id, checkin_at);

  CREATE TABLE IF NOT EXISTS reminders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    sent_at    TEXT NOT NULL,
    days_left  INTEGER NOT NULL,
    phone      TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'sent'
  );
  CREATE INDEX IF NOT EXISTS idx_rem_member ON reminders(member_id, sent_at);

  CREATE TABLE IF NOT EXISTS audit_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    action       TEXT NOT NULL,
    performed_by TEXT NOT NULL DEFAULT 'admin',
    details      TEXT NOT NULL DEFAULT '',
    ip           TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS employees (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'Ø§Ø³ØªÙ‚Ø¨Ø§Ù„',
    phone       TEXT NOT NULL DEFAULT '',
    salary      REAL NOT NULL DEFAULT 0,
    start_date  TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_emp_active ON employees(active);

  CREATE TABLE IF NOT EXISTS private_trainings (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id         INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    trainer_id        INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    trainer_name      TEXT NOT NULL,
    package_name      TEXT NOT NULL DEFAULT 'Ø´Ù‡Ø± ØªØ¯Ø±ÙŠØ¨ Ø®Ø§Øµ (Ø¨Ø±Ø§ÙŠÙØª)',
    duration_days     INTEGER NOT NULL DEFAULT 30,
    start_date        TEXT NOT NULL,
    end_date          TEXT NOT NULL DEFAULT '',
    total_sessions    INTEGER DEFAULT 0,
    attended_sessions INTEGER DEFAULT 0,
    price             REAL NOT NULL DEFAULT 0,
    paid              REAL NOT NULL DEFAULT 0,
    notes             TEXT NOT NULL DEFAULT '',
    status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled','expired')),
    created_at        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pt_member ON private_trainings(member_id, status, end_date);
  CREATE INDEX IF NOT EXISTS idx_pt_status ON private_trainings(status);

  CREATE TABLE IF NOT EXISTS expenses (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT NOT NULL,
    category     TEXT NOT NULL DEFAULT 'Ø£Ø®Ø±Ù‰',
    amount       REAL NOT NULL CHECK (amount > 0),
    expense_date TEXT NOT NULL,
    notes        TEXT NOT NULL DEFAULT '',
    recorded_by  TEXT NOT NULL DEFAULT 'staff',
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_exp_date ON expenses(expense_date DESC, id DESC);
  `);

  try {
    conn.exec('ALTER TABLE members ADD COLUMN age INTEGER');
  } catch {
    /* Ø§Ù„Ø¹Ù…ÙˆØ¯ Ù…ÙˆØ¬ÙˆØ¯ Ø¨Ø§Ù„ÙØ¹Ù„ */
  }

  try {
    conn.exec('ALTER TABLE attendance ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
  } catch {
    /* العمود موجود بالفعل */
  }

  const setIns = conn.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  setIns.run('remind_days', '3');
  setIns.run('remind_template', defaultTemplate);

  // Ø¨Ø§Ù‚Ø§Øª Ø§ÙØªØ±Ø§Ø¶ÙŠØ© Ø¥Ø°Ø§ ÙƒØ§Ù†Øª ÙØ§Ø±ØºØ©
  if (conn.prepare('SELECT COUNT(*) AS c FROM plans').get().c === 0) {
    const ins = conn.prepare('INSERT INTO plans (name, duration_days, price) VALUES (?, ?, ?)');
    ins.run('Ø´Ù‡Ø±ÙŠ', 30, 300);
    ins.run('Ø±Ø¨Ø¹ Ø³Ù†ÙˆÙŠ (3 Ø´Ù‡ÙˆØ±)', 90, 800);
    ins.run('Ù†ØµÙ Ø³Ù†ÙˆÙŠ (6 Ø´Ù‡ÙˆØ±)', 180, 1500);
    ins.run('Ø³Ù†ÙˆÙŠ', 365, 2800);
  }
}

function openDb() {
  const dbFile = path.join(DATA_DIR, 'gym.db');
  currentDb = new DatabaseSync(dbFile);
  initDbSchema(currentDb);
  return currentDb;
}

openDb();

// Ø¨Ø±ÙˆÙƒØ³ÙŠ ÙŠØ¶Ù…Ù† Ø£Ù† Ø£ÙŠ Ø§Ø³ØªØ¯Ø¹Ø§Ø¡ Ù„Ù€ db ÙÙŠ Ø§Ù„Ø³ÙŠØ±ÙØ± ÙŠØªÙˆØ¬Ù‡ Ø¯Ø§Ø¦Ù…Ø§Ù‹ Ø¥Ù„Ù‰ Ø§Ù„Ø§ØªØµØ§Ù„ Ø§Ù„ÙØ¹Ù‘Ø§Ù„ Ø­ØªÙ‰ Ø¨Ø¹Ø¯ Ø§Ù„Ø§Ø³ØªØ±Ø¬Ø§Ø¹
const db = new Proxy({}, {
  get(target, prop) {
    if (!currentDb) openDb();
    const val = currentDb[prop];
    if (typeof val === 'function') {
      return val.bind(currentDb);
    }
    return val;
  }
});

/**
 * Ø§Ø³ØªØ±Ø¬Ø§Ø¹ Ù‚Ø§Ø¹Ø¯Ø© Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øª Ù…Ù† Ø¨Ø§ÙØ± Ø£Ùˆ Ù…Ø³Ø§Ø± Ù…Ù„Ù
 * ÙŠÙ‚ÙˆÙ… Ø¨Ø¥ØºÙ„Ø§Ù‚ Ø§Ù„Ø§ØªØµØ§Ù„ Ø§Ù„Ø­Ø§Ù„ÙŠØŒ ØªØ­Ø±ÙŠØ± Ø£Ù‚ÙØ§Ù„ Ø§Ù„Ù…Ù„ÙØ§ØªØŒ Ø­Ø°Ù Ù…Ù„ÙØ§Øª WAL/SHM Ø§Ù„Ù‚Ø¯ÙŠÙ…Ø©ØŒ
 * ÙƒØªØ§Ø¨Ø© Ø§Ù„Ù…Ù„Ù Ø§Ù„Ø¬Ø¯ÙŠØ¯ØŒ ÙˆØ¥Ø¹Ø§Ø¯Ø© ÙØªØ­ Ø§Ù„Ø§ØªØµØ§Ù„ ÙˆØªØ¬Ù‡ÙŠØ² Ø§Ù„Ø¬Ø¯Ø§ÙˆÙ„ ÙÙˆØ±Ø§Ù‹.
 */
function restoreDatabase(input) {
  let buf;
  if (Buffer.isBuffer(input)) {
    buf = input;
  } else if (typeof input === 'string') {
    buf = fs.readFileSync(input);
  } else {
    throw new Error('Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ù…Ù…Ø±Ø±Ø© Ù„Ù„Ø§Ø³ØªØ±Ø¬Ø§Ø¹ ØºÙŠØ± ØµØ­ÙŠØ­Ø©');
  }

  if (!buf || buf.length < 100) {
    throw new Error('Ø§Ù„Ù…Ù„Ù ÙØ§Ø±Øº Ø£Ùˆ ØºÙŠØ± ØµØ§Ù„Ø­');
  }

  const header = buf.slice(0, 16).toString('utf8');
  if (!header.startsWith('SQLite format 3')) {
    throw new Error('Ø§Ù„Ù…Ù„Ù Ù„ÙŠØ³ Ù‚Ø§Ø¹Ø¯Ø© Ø¨ÙŠØ§Ù†Ø§Øª SQLite ØµØ­ÙŠØ­Ø©');
  }

  const curDbPath = path.join(DATA_DIR, 'gym.db');
  const walPath = curDbPath + '-wal';
  const shmPath = curDbPath + '-shm';
  const safetyCopy = path.join(DATA_DIR, `gym.db.safety-${Date.now()}`);

  // 1. ØªÙØ±ÙŠØº Ø§Ù„Ù€ WAL ÙˆØ¥ØºÙ„Ø§Ù‚ Ø§Ù„Ø§ØªØµØ§Ù„ Ø§Ù„Ø­Ø§Ù„ÙŠ ØªÙ…Ø§Ù…Ø§Ù‹ Ù„ØªØ­Ø±ÙŠØ± Ø§Ù„Ù…Ù„Ù Ø¹Ù„Ù‰ ÙˆÙŠÙ†Ø¯ÙˆØ²
  if (currentDb) {
    try {
      currentDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch (e) {
      console.warn('[Restore] wal_checkpoint warning:', e.message);
    }
    try {
      currentDb.close();
    } catch (e) {
      console.warn('[Restore] db.close warning:', e.message);
    }
    currentDb = null;
  }

  // 2. Ø¹Ù…Ù„ Ù†Ø³Ø®Ø© Ø£Ù…Ø§Ù† Ø§Ø­ØªÙŠØ§Ø·ÙŠØ© Ù‚Ø¨Ù„ Ø§Ù„Ø§Ø³ØªØ¨Ø¯Ø§Ù„
  if (fs.existsSync(curDbPath)) {
    try {
      fs.copyFileSync(curDbPath, safetyCopy);
    } catch (e) {
      console.warn('[Restore] Failed safety copy:', e.message);
    }
  }

  // 3. Ø­Ø°Ù Ù…Ù„ÙØ§Øª WAL Ùˆ SHM Ø§Ù„Ù‚Ø¯ÙŠÙ…Ø© Ù„Ù…Ù†Ø¹ Ø§Ù„ØªØ¯Ø§Ø®Ù„ Ø£Ùˆ ØªÙ„Ù Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øª
  try { if (fs.existsSync(walPath)) fs.unlinkSync(walPath); } catch (e) {}
  try { if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath); } catch (e) {}

  // 4. ÙƒØªØ§Ø¨Ø© Ù…Ù„Ù Ù‚Ø§Ø¹Ø¯Ø© Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ø¬Ø¯ÙŠØ¯
  fs.writeFileSync(curDbPath, buf);

  // 5. Ø¥Ø¹Ø§Ø¯Ø© ÙØªØ­ Ø§Ù„Ø§ØªØµØ§Ù„ ÙˆØªØ­Ø¯ÙŠØ« Ø§Ù„Ø¬Ø¯Ø§ÙˆÙ„ ØªÙ„Ù‚Ø§Ø¦ÙŠØ§Ù‹ Ø¥Ù† ÙƒØ§Ù†Øª Ù†Ø§Ù‚ØµØ© ÙÙŠ Ø§Ù„Ù†Ø³Ø®Ø© Ø§Ù„Ù‚Ø¯ÙŠÙ…Ø©
  openDb();

  // 6. ÙØ­Øµ Ø³Ù„Ø§Ù…Ø© Ù‚Ø§Ø¹Ø¯Ø© Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øª
  try {
    const check = currentDb.prepare('PRAGMA quick_check(1)').get();
    const checkVal = Object.values(check || {})[0];
    if (checkVal !== 'ok') {
      throw new Error('ÙØ­Øµ Ø³Ù„Ø§Ù…Ø© Ù‚Ø§Ø¹Ø¯Ø© Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øª ÙØ´Ù„: ' + checkVal);
    }
  } catch (err) {
    if (fs.existsSync(safetyCopy)) {
      try {
        if (currentDb) currentDb.close();
        fs.copyFileSync(safetyCopy, curDbPath);
        openDb();
      } catch (rErr) {}
    }
    throw err;
  }

  return { safetyCopy };
}

module.exports = { db, DATA_DIR, restoreDatabase };

