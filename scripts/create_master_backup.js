'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const masterPath = path.join(DATA_DIR, 'gym_complete_master.db');

if (fs.existsSync(masterPath)) fs.unlinkSync(masterPath);
if (fs.existsSync(masterPath + '-wal')) fs.unlinkSync(masterPath + '-wal');
if (fs.existsSync(masterPath + '-shm')) fs.unlinkSync(masterPath + '-shm');

const master = new DatabaseSync(masterPath);
master.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');

master.exec(`
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

// 1. الباقات (Plans)
const octDb = new DatabaseSync('C:/Users/France Tech/Downloads/gym-backup-2026-10-29_20-58.db');
for (const p of octDb.prepare('SELECT * FROM plans').all()) {
  master.prepare('INSERT OR REPLACE INTO plans (id, name, duration_days, price, active) VALUES (?, ?, ?, ?, ?)').run(p.id, p.name, p.duration_days, p.price, p.active);
}

// 2. الأعضاء (Members)
for (const m of octDb.prepare('SELECT * FROM members').all()) {
  master.prepare('INSERT OR REPLACE INTO members (id, code, name, phone, notes, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(m.id, m.code, m.name, m.phone, m.notes, m.active, m.created_at);
}

// 3. الاشتراكات (Subscriptions)
for (const s of octDb.prepare('SELECT * FROM subscriptions').all()) {
  master.prepare('INSERT OR REPLACE INTO subscriptions (id, member_id, plan_id, plan_name, start_date, end_date, price, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(s.id, s.member_id, s.plan_id, s.plan_name, s.start_date, s.end_date, s.price, s.status, s.created_at);
}

// 4. الحضور وسجلات الدخول (Attendance & Daily Reports)
for (const a of octDb.prepare('SELECT * FROM attendance').all()) {
  master.prepare('INSERT OR REPLACE INTO attendance (id, member_id, day, checkin_at, result, reason) VALUES (?, ?, ?, ?, ?, ?)').run(a.id, a.member_id, a.day, a.checkin_at, a.result, a.reason);
}

// 5. الموظفين (Employees)
master.prepare('INSERT INTO employees (id, name, role, phone, salary, start_date, notes, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .run(1, 'كابتن محمد', 'مدرب', '01018761843', 3000, '2026-10-01', 'مدرب اللياقة والتدريب الخاص', 1, '2026-10-01T10:00:00.000Z');
master.prepare('INSERT INTO employees (id, name, role, phone, salary, start_date, notes, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .run(2, 'أحمد مصطفى', 'استقبال', '01012345678', 2500, '2026-10-01', 'موظف الاستقبال وشؤون الأعضاء', 1, '2026-10-01T10:00:00.000Z');

// 6. التدريب الخاص البرايفت (Private Trainings)
master.prepare('INSERT INTO private_trainings (id, member_id, trainer_id, trainer_name, package_name, duration_days, start_date, end_date, total_sessions, attended_sessions, price, paid, notes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .run(1, 1, 1, 'كابتن محمد', '12 حصة تدريب خاص (برايفت)', 30, '2026-11-20', '2026-12-20', 12, 6, 1500, 1500, 'تدريب خاص مع كابتن محمد', 'active', '2026-11-19T22:37:59.117Z');

// 7. سجل العمليات والإعدادات (Audit Logs & Settings)
const curDb = new DatabaseSync(path.join(DATA_DIR, 'gym.db'));
for (const l of curDb.prepare('SELECT * FROM audit_logs').all()) {
  master.prepare('INSERT OR REPLACE INTO audit_logs (id, action, performed_by, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(l.id, l.action, l.performed_by, l.details, l.ip, l.created_at);
}
for (const st of curDb.prepare('SELECT * FROM settings').all()) {
  master.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(st.key, st.value);
}

master.exec('PRAGMA wal_checkpoint(TRUNCATE);');
master.close();

console.log('✅ تم إنشاء قاعدة البيانات الشاملة بنجاح.');
