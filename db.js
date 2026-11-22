'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// إعدادات التنبيهات الافتراضية
const defaultTemplate = `مرحباً بك يا {name} في {gym} 🏋️‍♂️✨

نود تذكيرك بأن اشتراكك الحالي ({plan}) سينتهي قريباً:
📅 تاريخ الانتهاء: {end_date}
⏳ متبقي: {days_left}

لتجديد الاشتراك وتجنب توقف كود الدخول، يمكنك التجديد في زيارتك القادمة بمكتب الاستقبال.

نتمنى لك وقتاً ممتعاً وتدريباً موفقاً! 💪🔥`;

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
    role        TEXT NOT NULL DEFAULT 'استقبال',
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
    package_name      TEXT NOT NULL DEFAULT 'شهر تدريب خاص (برايفت)',
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
  `);

  const setIns = conn.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  setIns.run('remind_days', '3');
  setIns.run('remind_template', defaultTemplate);

  // باقات افتراضية إذا كانت فارغة
  if (conn.prepare('SELECT COUNT(*) AS c FROM plans').get().c === 0) {
    const ins = conn.prepare('INSERT INTO plans (name, duration_days, price) VALUES (?, ?, ?)');
    ins.run('شهري', 30, 300);
    ins.run('ربع سنوي (3 شهور)', 90, 800);
    ins.run('نصف سنوي (6 شهور)', 180, 1500);
    ins.run('سنوي', 365, 2800);
  }
}

function openDb() {
  const dbFile = path.join(DATA_DIR, 'gym.db');
  currentDb = new DatabaseSync(dbFile);
  initDbSchema(currentDb);
  return currentDb;
}

openDb();

// بروكسي يضمن أن أي استدعاء لـ db في السيرفر يتوجه دائماً إلى الاتصال الفعّال حتى بعد الاسترجاع
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
 * استرجاع قاعدة البيانات من بافر أو مسار ملف
 * يقوم بإغلاق الاتصال الحالي، تحرير أقفال الملفات، حذف ملفات WAL/SHM القديمة،
 * كتابة الملف الجديد، وإعادة فتح الاتصال وتجهيز الجداول فوراً.
 */
function restoreDatabase(input) {
  let buf;
  if (Buffer.isBuffer(input)) {
    buf = input;
  } else if (typeof input === 'string') {
    buf = fs.readFileSync(input);
  } else {
    throw new Error('البيانات الممررة للاسترجاع غير صحيحة');
  }

  if (!buf || buf.length < 100) {
    throw new Error('الملف فارغ أو غير صالح');
  }

  const header = buf.slice(0, 16).toString('utf8');
  if (!header.startsWith('SQLite format 3')) {
    throw new Error('الملف ليس قاعدة بيانات SQLite صحيحة');
  }

  const curDbPath = path.join(DATA_DIR, 'gym.db');
  const walPath = curDbPath + '-wal';
  const shmPath = curDbPath + '-shm';
  const safetyCopy = path.join(DATA_DIR, `gym.db.safety-${Date.now()}`);

  // 1. تفريغ الـ WAL وإغلاق الاتصال الحالي تماماً لتحرير الملف على ويندوز
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

  // 2. عمل نسخة أمان احتياطية قبل الاستبدال
  if (fs.existsSync(curDbPath)) {
    try {
      fs.copyFileSync(curDbPath, safetyCopy);
    } catch (e) {
      console.warn('[Restore] Failed safety copy:', e.message);
    }
  }

  // 3. حذف ملفات WAL و SHM القديمة لمنع التداخل أو تلف البيانات
  try { if (fs.existsSync(walPath)) fs.unlinkSync(walPath); } catch (e) {}
  try { if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath); } catch (e) {}

  // 4. كتابة ملف قاعدة البيانات الجديد
  fs.writeFileSync(curDbPath, buf);

  // 5. إعادة فتح الاتصال وتحديث الجداول تلقائياً إن كانت ناقصة في النسخة القديمة
  openDb();

  // 6. فحص سلامة قاعدة البيانات
  try {
    const check = currentDb.prepare('PRAGMA quick_check(1)').get();
    const checkVal = Object.values(check || {})[0];
    if (checkVal !== 'ok') {
      throw new Error('فحص سلامة قاعدة البيانات فشل: ' + checkVal);
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
