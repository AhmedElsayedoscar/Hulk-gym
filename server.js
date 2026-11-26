'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { db, DATA_DIR, restoreDatabase } = require('./db');
const { toBarcode } = require('./qr');

// ---------- الإعدادات ----------
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TZ = process.env.TZ_NAME || 'Africa/Cairo';
const GYM_NAME = process.env.GYM_NAME || 'Hulk GYM';
const SESSION_HOURS = 12;
const DUPLICATE_WINDOW_MIN = 5; // تجاهل تكرار المسح لنفس العضو خلال هذه المدة
const EXPIRING_DAYS = 7;

function getAdminPassword() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password');
  return (row && row.value) || process.env.ADMIN_PASSWORD || 'admin123';
}

function getStaffPassword() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('staff_password');
  return (row && row.value) || process.env.STAFF_PASSWORD || 'staff123';
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// تشفير كلمات المرور والتحقق منها
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derivedKey}`;
}

function verifyPassword(password, storedValue) {
  if (!storedValue || !password) return false;
  if (typeof storedValue === 'string' && storedValue.startsWith('scrypt:')) {
    const parts = storedValue.split(':');
    if (parts.length !== 3) return false;
    const salt = parts[1];
    const hash = parts[2];
    const derivedKey = crypto.scryptSync(password, salt, 64).toString('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(derivedKey, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  return safeEqual(password, storedValue);
}

function verifyPasswordAndUpgrade(password, storedValue, settingKey) {
  if (verifyPassword(password, storedValue)) {
    // في حال كانت كلمة المرور القديمة نصاً عادياً (Plaintext) يتم ترقيتها وتشفيرها فورياً في القاعدة
    if (typeof storedValue === 'string' && !storedValue.startsWith('scrypt:')) {
      try {
        setSetting(settingKey, hashPassword(password));
      } catch {
        /* ignore */
      }
    }
    return true;
  }
  return false;
}

function isDefaultPassword(storedValue, defaultPw) {
  return verifyPassword(defaultPw, storedValue);
}

// سجل العمليات والتدقيق الإداري (Audit Logging)
function logAudit(action, performedBy, details = '', ip = '') {
  try {
    db.prepare('INSERT INTO audit_logs (action, performed_by, details, ip, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(action, performedBy, typeof details === 'object' ? JSON.stringify(details) : String(details), ip, new Date().toISOString());
  } catch (e) {
    console.warn('[Audit Log Error]:', e.message);
  }
}

const SECRET_FILE = path.join(DATA_DIR, 'session.key');
let SECRET;
if (process.env.SESSION_SECRET) SECRET = process.env.SESSION_SECRET;
else if (fs.existsSync(SECRET_FILE)) SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
else {
  SECRET = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 });
}

// ---------- أدوات التاريخ ----------
function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function addDays(s, n) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function diffDays(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
function formatTimeInZone(iso) {
  try {
    return new Date(iso).toLocaleTimeString('ar-EG-u-nu-latn', {
      timeZone: TZ,
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return new Date(iso).toISOString().slice(11, 16);
  }
}

// ---------- أخطاء وردود ----------
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

// ---------- الجلسات ----------
function sign(payload) {
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
  return `${b}.${mac}`;
}
function verify(token) {
  if (typeof token !== 'string') return null;
  const [b, mac] = token.split('.');
  if (!b || !mac) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
  const a = Buffer.from(mac);
  const e = Buffer.from(expected);
  if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) return null;
  try {
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch {
    return null;
  }
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// نظام حماية وتحديد معدل الطلبات (Rate Limiting)
const rateLimits = new Map(); // key -> { count, resetAt }
function checkRateLimit(key, maxRequests, windowMs, errorMsg = 'محاولات كثيرة جداً، يرجى الانتظار قليلاً') {
  const now = Date.now();
  let r = rateLimits.get(key);
  if (!r || r.resetAt <= now) {
    rateLimits.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  r.count++;
  if (r.count > maxRequests) {
    throw new ApiError(429, errorMsg);
  }
}

// تنظيف دوري للذاكرة المؤقتة لمعدل الطلبات كل 10 دقائق
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimits.entries()) {
    if (v.resetAt <= now) rateLimits.delete(k);
  }
}, 10 * 60 * 1000).unref();

function checkLoginAllowed(ip) {
  checkRateLimit(`login:${ip}`, 5, 5 * 60 * 1000, 'محاولات دخول خاطئة متكررة. يرجى الانتظار 5 دقائق والمحاولة مجدداً');
}

function recordFailure(ip) {
  const r = rateLimits.get(`login:${ip}`);
  if (!r || r.resetAt <= Date.now()) {
    rateLimits.set(`login:${ip}`, { count: 1, resetAt: Date.now() + 5 * 60 * 1000 });
  } else {
    r.count++;
  }
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

// ---------- منطق الأعضاء والاشتراكات ----------
function newMemberCode() {
  const rows = db.prepare('SELECT code FROM members').all();
  let max = 1000;
  for (const r of rows) {
    if (/^\d+$/.test(r.code)) {
      const n = parseInt(r.code, 10);
      if (n > max && n < 1000000000) max = n;
    }
  }
  let next = max + 1;
  while (db.prepare('SELECT 1 FROM members WHERE code = ?').get(String(next))) {
    next++;
  }
  return String(next);
}

function toEnglishDigits(str) {
  return String(str || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
}

function cleanMemberCode(val, required = false) {
  if (val === undefined || val === null || val === '') {
    if (required) throw new ApiError(400, 'كود العضو مطلوب');
    return null;
  }
  const s = toEnglishDigits(String(val).trim());
  if (!/^\d+$/.test(s)) {
    throw new ApiError(400, 'كود العضو يجب أن يتكون من أرقام فقط');
  }
  if (s.length > 20) throw new ApiError(400, 'كود العضو طويل جداً (الحد الأقصى 20 رقماً)');
  return s;
}

function subscriptionState(memberId, today) {
  const covering = db
    .prepare(
      `SELECT * FROM subscriptions WHERE member_id = ? AND status = 'active'
       AND start_date <= ? AND end_date >= ? ORDER BY end_date DESC LIMIT 1`
    )
    .get(memberId, today, today);
  const last = db
    .prepare(`SELECT MAX(end_date) AS e FROM subscriptions WHERE member_id = ? AND status = 'active'`)
    .get(memberId).e;
  if (covering) {
    const daysLeft = diffDays(today, last);
    return {
      state: daysLeft <= EXPIRING_DAYS ? 'expiring' : 'active',
      plan_name: covering.plan_name,
      end_date: last,
      days_left: daysLeft,
    };
  }
  if (!last) return { state: 'none', plan_name: null, end_date: null, days_left: null };
  if (last < today) return { state: 'expired', plan_name: null, end_date: last, days_left: diffDays(today, last) };
  return { state: 'upcoming', plan_name: null, end_date: last, days_left: null };
}

function memberView(m, today) {
  return { ...m, active: !!m.active, sub: subscriptionState(m.id, today) };
}

function createSubscription(memberId, planId, startDate, priceOverride) {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
  if (!plan) throw new ApiError(400, 'الباقة غير موجودة');
  const today = todayStr();
  let start = startDate;
  if (start !== undefined && start !== null && start !== '') {
    if (!validDate(start)) throw new ApiError(400, 'تاريخ البداية غير صحيح');
  } else {
    // تجديد: لو فيه اشتراك ساري يبدأ الجديد بعد نهايته، غير كده يبدأ النهارده
    const last = db
      .prepare(`SELECT MAX(end_date) AS e FROM subscriptions WHERE member_id = ? AND status = 'active'`)
      .get(memberId).e;
    start = last && last >= today ? addDays(last, 1) : today;
  }
  const end = addDays(start, plan.duration_days - 1);
  let price = plan.price;
  if (priceOverride !== undefined && priceOverride !== null && priceOverride !== '') {
    price = Number(priceOverride);
    if (!Number.isFinite(price) || price < 0) throw new ApiError(400, 'السعر غير صحيح');
  }
  const r = db
    .prepare(
      `INSERT INTO subscriptions (member_id, plan_id, plan_name, start_date, end_date, price, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(memberId, plan.id, plan.name, start, end, price, new Date().toISOString());
  return Number(r.lastInsertRowid);
}

function cleanStr(v, max, field, required = false) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new ApiError(400, `${field} مطلوب`);
  if (s.length > max) throw new ApiError(400, `${field} أطول من المسموح`);
  return s;
}

function doCheckin(rawCode) {
  const code = toEnglishDigits(String(rawCode || '')).trim().toUpperCase();
  if (!code || code.length > 40) return { ok: false, reason: 'not_found', message: 'كود غير معروف' };
  const m = db.prepare('SELECT * FROM members WHERE code = ?').get(code);
  if (!m) return { ok: false, reason: 'not_found', message: 'كود غير معروف' };

  const today = todayStr();
  const now = new Date();
  const sub = subscriptionState(m.id, today);
  const base = { member: { id: m.id, name: m.name, phone: m.phone }, sub };
  const log = (result, reason) =>
    db
      .prepare('INSERT INTO attendance (member_id, day, checkin_at, result, reason) VALUES (?, ?, ?, ?, ?)')
      .run(m.id, today, now.toISOString(), result, reason);

  if (m.active !== 1) {
    log('denied', 'inactive');
    return { ok: false, reason: 'inactive', message: m.active === -1 ? 'العضوية مؤرشفة' : 'العضوية موقوفة', ...base };
  }
  if (sub.state === 'none' || sub.state === 'expired' || sub.state === 'upcoming') {
    const message =
      sub.state === 'expired'
        ? `الاشتراك منتهي من ${Math.abs(sub.days_left)} يوم`
        : sub.state === 'upcoming'
          ? 'الاشتراك لسه ما بدأش'
          : 'مفيش اشتراك لهذا العضو';
    log('denied', sub.state);
    return { ok: false, reason: sub.state, message, ...base };
  }

  // فحص هل العضو سجل حضور اليوم بالفعل في أي وقت من نفس اليوم
  const todayCheckin = db
    .prepare(
      `SELECT checkin_at FROM attendance WHERE member_id = ? AND day = ? AND result = 'ok' ORDER BY checkin_at ASC LIMIT 1`
    )
    .get(m.id, today);

  if (todayCheckin) {
    const timeFormatted = formatTimeInZone(todayCheckin.checkin_at);
    return {
      ok: true,
      duplicate: true,
      time: timeFormatted,
      firstCheckinAt: todayCheckin.checkin_at,
      message: `تم دخوله اليوم الساعة ${timeFormatted}`,
      ...base,
    };
  }

  log('ok', '');
  const warning = sub.days_left <= 3 ? `الاشتراك ينتهي ${sub.days_left === 0 ? 'النهارده' : `بعد ${sub.days_left} يوم`}` : '';
  return { ok: true, duplicate: false, message: 'أهلاً بيك', warning, ...base };
}

// ---------- المسارات ----------
const routes = [];
function route(method, pattern, role, handler) {
  const keys = [];
  const re = new RegExp(
    '^' + pattern.replace(/:([a-z]+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$'
  );
  routes.push({ method, re, keys, role, handler });
}
function intParam(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError(400, 'معرّف غير صحيح');
  return n;
}

route('POST', '/api/login', null, (ctx) => {
  checkLoginAllowed(ctx.ip);
  const pw = typeof ctx.body.password === 'string' ? ctx.body.password : '';
  let role = null;
  if (verifyPasswordAndUpgrade(pw, getAdminPassword(), 'admin_password')) role = 'admin';
  else if (verifyPasswordAndUpgrade(pw, getStaffPassword(), 'staff_password')) role = 'staff';
  if (!role) {
    recordFailure(ctx.ip);
    logAudit('login_failed', 'guest', 'محاولة تسجيل دخول فاشلة بكلمة مرور غير صحيحة', ctx.ip);
    throw new ApiError(401, 'كلمة المرور غير صحيحة');
  }
  rateLimits.delete(`login:${ctx.ip}`);
  logAudit('login_success', role, `تسجيل دخول ناجح بصلاحية ${role}`, ctx.ip);
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  const secure = ctx.req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return {
    body: { ok: true, role },
    headers: {
      'Set-Cookie': `sid=${sign({ role, exp })}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`,
    },
  };
});

route('POST', '/api/logout', null, () => ({
  body: { ok: true },
  headers: { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' },
}));

route('GET', '/api/me', 'staff', (ctx) => {
  const isDefaultStaff = isDefaultPassword(getStaffPassword(), 'staff123');
  const isDefaultAdmin = isDefaultPassword(getAdminPassword(), 'admin123');
  return {
    role: ctx.session.role,
    gymName: GYM_NAME,
    defaultPasswords: ctx.session.role === 'admin' ? (isDefaultStaff || isDefaultAdmin) : false,
    isDefaultAdmin: ctx.session.role === 'admin' ? isDefaultAdmin : false,
    isDefaultStaff: ctx.session.role === 'admin' ? isDefaultStaff : false,
  };
});

route('GET', '/api/stats', 'staff', () => {
  const today = todayStr();
  const soon = addDays(today, EXPIRING_DAYS);
  const members = db.prepare('SELECT * FROM members WHERE active = 1').all();
  let active = 0;
  let expiring = 0;
  let expired = 0;
  const expiringList = [];
  for (const m of members) {
    const s = subscriptionState(m.id, today);
    if (s.state === 'active' || s.state === 'expiring') active++;
    if (s.state === 'expiring') {
      expiring++;
      expiringList.push({ id: m.id, name: m.name, phone: m.phone, end_date: s.end_date, days_left: s.days_left });
    }
    if (s.state === 'expired') expired++;
  }
  expiringList.sort((a, b) => a.days_left - b.days_left);
  const todayCount = db
    .prepare(`SELECT COUNT(DISTINCT member_id) AS c FROM attendance WHERE day = ? AND result = 'ok'`)
    .get(today).c;
  const deniedToday = db.prepare(`SELECT COUNT(*) AS c FROM attendance WHERE day = ? AND result = 'denied'`).get(today).c;
  const recent = db
    .prepare(
      `SELECT a.id, a.checkin_at, a.result, a.reason, m.id AS member_id, m.name
       FROM attendance a JOIN members m ON m.id = a.member_id ORDER BY a.id DESC LIMIT 8`
    )
    .all();
  return {
    today,
    totalMembers: members.length,
    active,
    expiring,
    expired,
    todayCount,
    deniedToday,
    expiringList: expiringList.slice(0, 10),
    soon,
    recent,
  };
});

// الباقات
route('GET', '/api/plans', 'staff', (ctx) => {
  const all = ctx.url.searchParams.get('all') === '1' && ctx.session.role === 'admin';
  return db.prepare(`SELECT * FROM plans ${all ? '' : 'WHERE active = 1'} ORDER BY duration_days`).all();
});
route('POST', '/api/plans', 'admin', (ctx) => {
  const name = cleanStr(ctx.body.name, 60, 'اسم الباقة', true);
  const days = Number(ctx.body.duration_days);
  const price = Number(ctx.body.price);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new ApiError(400, 'المدة بالأيام غير صحيحة');
  if (!Number.isFinite(price) || price < 0) throw new ApiError(400, 'السعر غير صحيح');
  const r = db.prepare('INSERT INTO plans (name, duration_days, price) VALUES (?, ?, ?)').run(name, days, price);
  return { id: Number(r.lastInsertRowid) };
});
route('PUT', '/api/plans/:id', 'admin', (ctx) => {
  const id = intParam(ctx.params.id);
  const old = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
  if (!old) throw new ApiError(404, 'الباقة غير موجودة');
  const name = cleanStr(ctx.body.name ?? old.name, 60, 'اسم الباقة', true);
  const days = Number(ctx.body.duration_days ?? old.duration_days);
  const price = Number(ctx.body.price ?? old.price);
  const active = ctx.body.active === undefined ? old.active : ctx.body.active ? 1 : 0;
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new ApiError(400, 'المدة بالأيام غير صحيحة');
  if (!Number.isFinite(price) || price < 0) throw new ApiError(400, 'السعر غير صحيح');
  db.prepare('UPDATE plans SET name = ?, duration_days = ?, price = ?, active = ? WHERE id = ?').run(
    name,
    days,
    price,
    active,
    id
  );
  return { ok: true };
});

// ---------- الموظفين والمرتبات (Admin فقط) ----------
route('GET', '/api/employees', 'admin', (ctx) => {
  const all = db.prepare('SELECT * FROM employees ORDER BY active DESC, id DESC').all();
  const totalSalary = all.filter((e) => e.active).reduce((sum, e) => sum + (Number(e.salary) || 0), 0);
  const activeCount = all.filter((e) => e.active).length;
  return { employees: all, totalSalary, activeCount, totalCount: all.length };
});

route('POST', '/api/employees', 'admin', (ctx) => {
  const name = cleanStr(ctx.body.name, 100, 'اسم الموظف', true);
  const role = cleanStr(ctx.body.role, 60, 'المسمى الوظيفي') || 'موظف';
  const phone = toEnglishDigits(cleanStr(ctx.body.phone, 30, 'الهاتف'));
  const salary = Number(toEnglishDigits(ctx.body.salary ?? 0));
  const startDate = cleanStr(ctx.body.start_date, 20, 'تاريخ التعيين') || todayStr();
  const notes = cleanStr(ctx.body.notes, 500, 'الملاحظات');
  if (!Number.isFinite(salary) || salary < 0) throw new ApiError(400, 'المرتب غير صحيح');

  const r = db.prepare(
    'INSERT INTO employees (name, role, phone, salary, start_date, notes, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)'
  ).run(name, role, phone, salary, startDate, notes, new Date().toISOString());

  logAudit('add_employee', 'admin', `إضافة موظف جديد: ${name} (${role}) بمرتب ${salary} ج`, ctx.ip);
  return { ok: true, id: Number(r.lastInsertRowid) };
});

route('PUT', '/api/employees/:id', 'admin', (ctx) => {
  const id = intParam(ctx.params.id);
  const old = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
  if (!old) throw new ApiError(404, 'الموظف غير موجود');

  const name = cleanStr(ctx.body.name ?? old.name, 100, 'اسم الموظف', true);
  const role = cleanStr(ctx.body.role ?? old.role, 60, 'المسمى الوظيفي') || old.role;
  const phone = toEnglishDigits(cleanStr(ctx.body.phone ?? old.phone, 30, 'الهاتف'));
  const salary = Number(toEnglishDigits(ctx.body.salary ?? old.salary));
  const startDate = cleanStr(ctx.body.start_date ?? old.start_date, 20, 'تاريخ التعيين');
  const notes = cleanStr(ctx.body.notes ?? old.notes, 500, 'الملاحظات');
  const active = ctx.body.active === undefined ? old.active : (ctx.body.active ? 1 : 0);

  if (!Number.isFinite(salary) || salary < 0) throw new ApiError(400, 'المرتب غير صحيح');

  db.prepare(
    'UPDATE employees SET name = ?, role = ?, phone = ?, salary = ?, start_date = ?, notes = ?, active = ? WHERE id = ?'
  ).run(name, role, phone, salary, startDate, notes, active, id);

  logAudit('update_employee', 'admin', `تعديل بيانات الموظف: ${name} (${role})`, ctx.ip);
  return { ok: true };
});

route('DELETE', '/api/employees/:id', 'admin', (ctx) => {
  const id = intParam(ctx.params.id);
  const old = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
  if (!old) throw new ApiError(404, 'الموظف غير موجود');

  // ✅ أرشفة الموظف بدلاً من الحذف النهائي لحماية السجلات والتقارير
  db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(id);
  logAudit('archive_employee', 'admin', `أرشفة الموظف: ${old.name} (${old.role}) - السجلات محفوظة`, ctx.ip);
  return { ok: true, message: 'تم أرشفة الموظف مع الاحتفاظ بجميع سجلاته' };
});

// الأعضاء
route('GET', '/api/members', 'staff', (ctx) => {
  const today = todayStr();
  const q = (ctx.url.searchParams.get('q') || '').trim();
  const status = ctx.url.searchParams.get('status') || 'all';
  let rows;
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    rows = db
      .prepare(`SELECT * FROM members WHERE ${status === 'archived' ? 'active = -1' : 'active != -1'} AND (name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\') ORDER BY name LIMIT 500`)
      .all(like, like, like.toUpperCase());
  } else {
    rows = db.prepare(`SELECT * FROM members WHERE ${status === 'archived' ? 'active = -1' : 'active != -1'} ORDER BY id DESC LIMIT 500`).all();
  }
  let list = rows.map((m) => memberView(m, today));
  if (status !== 'all' && status !== 'archived') {
    list = list.filter((m) => (status === 'active' ? m.sub.state === 'active' || m.sub.state === 'expiring' : m.sub.state === status));
  }
  return list;
});

function parseMemberAge(val) {
  if (val === undefined || val === null || String(val).trim() === '') return null;
  const n = Number(toEnglishDigits(String(val).trim()));
  if (!Number.isInteger(n) || n < 5 || n > 120) {
    throw new ApiError(400, 'السن غير صحيح (يجب أن يكون بين 5 و 120 سنة)');
  }
  return n;
}

route('POST', '/api/members', 'staff', (ctx) => {
  const name = cleanStr(ctx.body.name, 100, 'الاسم', true);
  const phone = toEnglishDigits(cleanStr(ctx.body.phone, 30, 'رقم الموبايل'));
  const age = parseMemberAge(ctx.body.age);
  const notes = cleanStr(ctx.body.notes, 500, 'الملاحظات');
  const planId = ctx.body.plan_id ? intParam(ctx.body.plan_id) : null;
  if (planId && !db.prepare('SELECT 1 FROM plans WHERE id = ? AND active = 1').get(planId)) {
    throw new ApiError(400, 'الباقة غير موجودة');
  }
  const customCode = cleanMemberCode(ctx.body.code, false);
  let code;
  if (customCode) {
    if (db.prepare('SELECT 1 FROM members WHERE code = ?').get(customCode)) {
      throw new ApiError(400, 'كود العضو مستخدم بالفعل لعضو آخر');
    }
    code = customCode;
  } else {
    code = newMemberCode();
  }
  let id;
  db.exec('BEGIN');
  try {
    const r = db
      .prepare('INSERT INTO members (code, name, phone, age, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(code, name, phone, age, notes, new Date().toISOString());
    id = Number(r.lastInsertRowid);
    if (planId) createSubscription(id, planId, ctx.body.start_date, ctx.body.price);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { id, code };
});

route('GET', '/api/members/:id', 'staff', (ctx) => {
  const id = intParam(ctx.params.id);
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!m) throw new ApiError(404, 'العضو غير موجود');
  const subs = db.prepare('SELECT * FROM subscriptions WHERE member_id = ? ORDER BY start_date DESC, id DESC').all(id);
  const att = db
    .prepare('SELECT id, checkin_at, result, reason FROM attendance WHERE member_id = ? ORDER BY id DESC LIMIT 30')
    .all(id);
  const total = db.prepare(`SELECT COUNT(*) AS c FROM attendance WHERE member_id = ? AND result = 'ok'`).get(id).c;
  const today = todayStr();
  const rawPts = db.prepare('SELECT * FROM private_trainings WHERE member_id = ? ORDER BY id DESC').all(id);
  const pts = rawPts.map(p => ({ ...p, ...ptState(p, today) }));
  return { member: memberView(m, today), subscriptions: subs, attendance: att, totalVisits: total, privateTrainings: pts };
});

route('PUT', '/api/members/:id', 'staff', (ctx) => {
  const id = intParam(ctx.params.id);
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!m) throw new ApiError(404, 'العضو غير موجود');
  const name = cleanStr(ctx.body.name ?? m.name, 100, 'الاسم', true);
  const phone = toEnglishDigits(cleanStr(ctx.body.phone ?? m.phone, 30, 'رقم الموبايل'));
  const age = ctx.body.age === undefined ? m.age : parseMemberAge(ctx.body.age);
  const notes = cleanStr(ctx.body.notes ?? m.notes, 500, 'الملاحظات');
  const active = ctx.body.active === undefined ? m.active : ctx.body.active ? 1 : 0;
  let code = m.code;
  if (ctx.body.code !== undefined && ctx.body.code !== '') {
    const customCode = cleanMemberCode(ctx.body.code, true);
    if (customCode !== m.code) {
      if (db.prepare('SELECT 1 FROM members WHERE code = ? AND id != ?').get(customCode, id)) {
        throw new ApiError(400, 'كود العضو مستخدم بالفعل لعضو آخر');
      }
      code = customCode;
    }
  }
  db.prepare('UPDATE members SET code = ?, name = ?, phone = ?, age = ?, notes = ?, active = ? WHERE id = ?').run(
    code,
    name,
    phone,
    age,
    notes,
    active,
    id
  );
  return { ok: true, code };
});

route('DELETE', '/api/members/:id', 'admin', (ctx) => {
  const id = intParam(ctx.params.id);
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!member) throw new ApiError(404, 'العضو غير موجود');
  // ✅ Soft Delete - ارشفة بدل الحذف النهائي لحماية بيانات الحضور والاشتراكات
  db.prepare(`UPDATE members SET active = -1, notes = '[مؤرشف] ' || notes WHERE id = ?`).run(id);
  logAudit('archive_member', ctx.session?.role || 'admin', `ارشفة عضو: ${member.name} (${member.code}) - بيانات الحضور والاشتراكات محفوظة`, ctx.ip);
  return { ok: true, message: 'تم ارشفة العضو - جميع بياناته محفوظة في السجلات' };
});

route('POST', '/api/members/:id/subscriptions', 'staff', (ctx) => {
  const id = intParam(ctx.params.id);
  if (!db.prepare('SELECT 1 FROM members WHERE id = ?').get(id)) throw new ApiError(404, 'العضو غير موجود');
  const planId = intParam(ctx.body.plan_id);
  const plan = db.prepare('SELECT active FROM plans WHERE id = ?').get(planId);
  if (!plan || !plan.active) throw new ApiError(400, 'الباقة غير موجودة');
  return { id: createSubscription(id, planId, ctx.body.start_date, ctx.body.price) };
});

route('DELETE', '/api/subscriptions/:id', 'admin', (ctx) => {
  const id = intParam(ctx.params.id);
  const sub = db.prepare('SELECT s.*, m.name AS member_name FROM subscriptions s LEFT JOIN members m ON m.id = s.member_id WHERE s.id = ?').get(id);
  if (!sub) throw new ApiError(404, 'الاشتراك غير موجود');
  db.prepare(`UPDATE subscriptions SET status = 'cancelled' WHERE id = ?`).run(id);
  logAudit('subscription_cancelled', ctx.session?.role || 'admin', `إلغاء اشتراك #${id} (${sub.plan_name}) للعضو ${sub.member_name || sub.member_id} - السجل محفوظ`, ctx.ip);
  return { ok: true, message: 'تم إلغاء الاشتراك مع الاحتفاظ بسجله للمراجعة' };
});

// ---------- البرايفت / التدريب الخاص (Private Training) ----------
function ptState(pt, today) {
  const start = pt.start_date;
  const days = Number(pt.duration_days) || 30;
  const end = pt.end_date || addDays(start, days - 1);
  const totalDays = days || (diffDays(start, end) + 1) || 30;

  if (pt.status === 'cancelled') {
    return { state: 'cancelled', days_left: 0, total_days: totalDays, elapsed_days: totalDays, end_date: end };
  }

  const daysLeft = diffDays(today, end);
  if (today < start) {
    return { state: 'upcoming', days_left: daysLeft, total_days: totalDays, elapsed_days: 0, end_date: end };
  }
  if (today > end) {
    return { state: 'expired', days_left: 0, total_days: totalDays, elapsed_days: totalDays, end_date: end };
  }

  const elapsedDays = Math.max(0, Math.min(totalDays, totalDays - daysLeft));
  const state = daysLeft <= 3 ? 'expiring' : 'active';
  return { state, days_left: daysLeft, total_days: totalDays, elapsed_days: elapsedDays, end_date: end };
}

route('GET', '/api/private-trainings', 'staff', (ctx) => {
  const today = todayStr();
  const statusFilter = ctx.url.searchParams.get('status') || 'active';

  const rows = db.prepare(`
    SELECT pt.*, m.name AS member_name, m.code AS member_code, m.phone AS member_phone
    FROM private_trainings pt
    JOIN members m ON pt.member_id = m.id
    ORDER BY pt.id DESC
  `).all();

  const list = rows.map((r) => ({ ...r, ...ptState(r, today) }));

  const filtered = list.filter((r) => {
    if (statusFilter === 'active') return r.state === 'active' || r.state === 'expiring' || r.state === 'upcoming';
    if (statusFilter === 'expired') return r.state === 'expired';
    return true; // 'all'
  });

  const totalRevenue = rows.reduce((acc, r) => acc + (Number(r.price) || 0), 0);
  const totalPaid = rows.reduce((acc, r) => acc + (Number(r.paid) || 0), 0);
  const activeCount = list.filter((r) => r.state === 'active' || r.state === 'expiring').length;
  const expiringCount = list.filter((r) => r.state === 'expiring').length;
  const expiredCount = list.filter((r) => r.state === 'expired').length;

  return {
    privateTrainings: filtered,
    activeCount,
    expiringCount,
    expiredCount,
    totalCount: list.length,
    totalRevenue,
    totalPaid
  };
});

route('POST', '/api/members/:id/private-training', 'staff', (ctx) => {
  const memberId = intParam(ctx.params.id);
  const m = db.prepare('SELECT name FROM members WHERE id = ?').get(memberId);
  if (!m) throw new ApiError(404, 'العضو غير موجود');

  const trainerName = cleanStr(ctx.body.trainer_name, 100, 'اسم الكابتن/المدرب', true);
  const trainerId = ctx.body.trainer_id ? Number(ctx.body.trainer_id) : null;
  const packageName = cleanStr(ctx.body.package_name, 100, 'اسم الباقة') || 'شهر تدريب خاص (برايفت)';
  const durationDays = Number(toEnglishDigits(ctx.body.duration_days || 30));

  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650) {
    throw new ApiError(400, 'مدة الاشتراك بالأيام غير صحيحة');
  }

  let startDate = cleanStr(ctx.body.start_date, 20, 'تاريخ البدء') || todayStr();
  if (!validDate(startDate)) throw new ApiError(400, 'تاريخ البدء غير صحيح');

  let endDate = cleanStr(ctx.body.end_date, 20, 'تاريخ الانتهاء');
  if (!endDate || !validDate(endDate)) {
    endDate = addDays(startDate, durationDays - 1);
  }

  const price = Number(toEnglishDigits(ctx.body.price || 0));
  const paid = Number(toEnglishDigits(ctx.body.paid || 0));
  const notes = cleanStr(ctx.body.notes, 500, 'الملاحظات');

  if (!Number.isFinite(price) || price < 0) throw new ApiError(400, 'السعر غير صحيح');
  if (!Number.isFinite(paid) || paid < 0) throw new ApiError(400, 'المبلغ المدفوع غير صحيح');

  const r = db.prepare(`
    INSERT INTO private_trainings (member_id, trainer_id, trainer_name, package_name, duration_days, start_date, end_date, price, paid, notes, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(memberId, trainerId, trainerName, packageName, durationDays, startDate, endDate, price, paid, notes, new Date().toISOString());

  logAudit('add_private_training', ctx.session.role, `تسجيل اشتراك برايفت للعضو: ${m.name} مع الكابتن: ${trainerName} (${durationDays} يوم حتى ${endDate})`, ctx.ip);

  return { ok: true, id: Number(r.lastInsertRowid), end_date: endDate };
});

route('PUT', '/api/private-trainings/:id', 'staff', (ctx) => {
  const ptId = intParam(ctx.params.id);
  const pt = db.prepare('SELECT * FROM private_trainings WHERE id = ?').get(ptId);
  if (!pt) throw new ApiError(404, 'اشتراك البرايفت غير موجود');

  const trainerName = cleanStr(ctx.body.trainer_name ?? pt.trainer_name, 100, 'اسم الكابتن/المدرب', true);
  const packageName = cleanStr(ctx.body.package_name ?? pt.package_name, 100, 'اسم الباقة');
  const durationDays = Number(toEnglishDigits(ctx.body.duration_days ?? pt.duration_days ?? 30));
  let startDate = cleanStr(ctx.body.start_date ?? pt.start_date, 20, 'تاريخ البدء');
  let endDate = cleanStr(ctx.body.end_date ?? pt.end_date, 20, 'تاريخ الانتهاء');

  if (!endDate || !validDate(endDate)) {
    endDate = addDays(startDate, durationDays - 1);
  }

  const price = Number(toEnglishDigits(ctx.body.price ?? pt.price));
  const paid = Number(toEnglishDigits(ctx.body.paid ?? pt.paid));
  const status = ctx.body.status ?? pt.status;
  const notes = cleanStr(ctx.body.notes ?? pt.notes, 500, 'الملاحظات');

  if (!Number.isFinite(price) || price < 0) throw new ApiError(400, 'السعر غير صحيح');
  if (!Number.isFinite(paid) || paid < 0) throw new ApiError(400, 'المبلغ المدفوع غير صحيح');

  db.prepare(`
    UPDATE private_trainings
    SET trainer_name = ?, package_name = ?, duration_days = ?, start_date = ?, end_date = ?, price = ?, paid = ?, status = ?, notes = ?
    WHERE id = ?
  `).run(trainerName, packageName, durationDays, startDate, endDate, price, paid, status, notes, ptId);

  logAudit('update_private_training', ctx.session.role, `تعديل بيانات اشتراك برايفت رقم ${ptId}`, ctx.ip);

  return { ok: true };
});

route('DELETE', '/api/private-trainings/:id', 'admin', (ctx) => {
  const ptId = intParam(ctx.params.id);
  const pt = db.prepare('SELECT id, member_id, trainer_name, package_name FROM private_trainings WHERE id = ?').get(ptId);
  if (!pt) throw new ApiError(404, 'اشتراك البرايفت غير موجود');

  // ✅ أرشفة (إلغاء) اشتراك البرايفت بدلاً من الحذف النهائي
  db.prepare(`UPDATE private_trainings SET status = 'cancelled', notes = '[ملغي/مؤرشف] ' || notes WHERE id = ?`).run(ptId);
  logAudit('archive_private_training', 'admin', `أرشفة اشتراك برايفت #${ptId} (${pt.package_name} - ${pt.trainer_name}) - السجل محفوظ`, ctx.ip);

  return { ok: true, message: 'تم أرشفة اشتراك البرايفت مع الاحتفاظ بسجله' };
});

function memberBarcodeSvg(code) {
  const s = toEnglishDigits(String(code || '').trim());
  // باركود عريض وواضح للسكانر بهامش أمان أبيض قياسي لا يقل عن 12 وحدة لسرعة وسهولة المسح
  const barWidth = s.length <= 4 ? 6 : s.length <= 6 ? 5 : s.length <= 8 ? 4 : 3;
  const quiet = Math.max(barWidth * 12, 45);
  return toBarcode(s, {
    barWidth,
    height: 160,
    quiet,
    fontSize: 22,
  });
}

route('GET', '/api/members/:id/qr.svg', 'staff', (ctx) => {
  const id = intParam(ctx.params.id);
  const m = db.prepare('SELECT code FROM members WHERE id = ?').get(id);
  if (!m) throw new ApiError(404, 'العضو غير موجود');
  return { raw: memberBarcodeSvg(m.code), type: 'image/svg+xml; charset=utf-8' };
});

// المسارات العامة لعرض كارت العضوية والـ QR (متاحة للعضو عبر رابط الواتساب بدون تسجيل دخول)
function maskPhone(p) {
  const s = String(p || '').trim();
  if (s.length < 8) return s;
  return s.slice(0, 4) + '****' + s.slice(-3);
}

function findMemberByIdent(ident, allowNumericId = true) {
  const s = toEnglishDigits(String(ident || '').trim());
  let m = db.prepare('SELECT * FROM members WHERE code = ?').get(s);
  if (!m && allowNumericId && /^\d+$/.test(s)) {
    m = db.prepare('SELECT * FROM members WHERE id = ?').get(Number(s));
  }
  return m;
}

route('GET', '/api/public/card/:ident', null, (ctx) => {
  checkRateLimit(`public_card:${ctx.ip}`, 45, 60 * 1000, 'طلب سريع جداً، يرجى الانتظار قليلاً');
  // منع تخمين المعرفات المتسلسلة (Enumeration attack) للعامة عبر حصر البحث بالكود فقط
  const isAuth = !!ctx.session;
  const m = findMemberByIdent(ctx.params.ident, isAuth);
  if (!m) throw new ApiError(404, 'العضو غير موجود');
  const today = todayStr();
  const sub = subscriptionState(m.id, today);
  return {
    gymName: GYM_NAME,
    id: m.id,
    name: m.name,
    code: m.code,
    // إخفاء منتصف رقم الهاتف للزوار لحماية خصوصية المشترك، وإظهاره فقط للموظفين المسجلين
    phone: isAuth ? m.phone : maskPhone(m.phone),
    active: m.active,
    sub: {
      plan_name: sub.plan_name,
      end_date: sub.end_date,
      days_left: sub.days_left,
      state: m.active ? sub.state : 'inactive',
    },
    qrUrl: `/api/public/card-qr/${encodeURIComponent(m.code)}`,
  };
});

route('GET', '/api/public/card-qr/:ident', null, (ctx) => {
  const m = findMemberByIdent(ctx.params.ident);
  if (!m) throw new ApiError(404, 'العضو غير موجود');
  return { raw: memberBarcodeSvg(m.code), type: 'image/svg+xml; charset=utf-8' };

});

// الحضور
route('POST', '/api/checkin', 'staff', (ctx) => doCheckin(ctx.body.code));

route('GET', '/api/attendance', 'staff', (ctx) => {
  const date = ctx.url.searchParams.get('date');
  const from = ctx.url.searchParams.get('from');
  const to = ctx.url.searchParams.get('to');
  const q = (ctx.url.searchParams.get('q') || '').trim();
  const resFilter = ctx.url.searchParams.get('result') || 'all';
  const memberId = ctx.url.searchParams.get('member_id');

  const conditions = [];
  const params = [];

  if (date) {
    if (!validDate(date)) throw new ApiError(400, 'التاريخ غير صحيح');
    conditions.push('a.day = ?');
    params.push(date);
  } else if (from || to) {
    if (from) {
      if (!validDate(from)) throw new ApiError(400, 'تاريخ البداية غير صحيح');
      conditions.push('a.day >= ?');
      params.push(from);
    }
    if (to) {
      if (!validDate(to)) throw new ApiError(400, 'تاريخ النهاية غير صحيح');
      conditions.push('a.day <= ?');
      params.push(to);
    }
  } else {
    // الافتراضي هو اليوم
    conditions.push('a.day = ?');
    params.push(todayStr());
  }

  if (resFilter === 'ok' || resFilter === 'denied') {
    conditions.push('a.result = ?');
    params.push(resFilter);
  }

  if (memberId) {
    conditions.push('a.member_id = ?');
    params.push(intParam(memberId));
  }

  if (q) {
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    conditions.push(`(m.name LIKE ? ESCAPE '\\' OR m.phone LIKE ? ESCAPE '\\' OR m.code LIKE ? ESCAPE '\\')`);
    params.push(like, like, like);
  }

  const includeArchived = ctx.url.searchParams.get('archived') === '1';
  if (!includeArchived) {
    conditions.push('COALESCE(a.archived, 0) = 0');
  }

  const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const sql = `
    SELECT a.id, a.day, a.checkin_at, a.result, a.reason, COALESCE(a.archived, 0) AS archived, m.id AS member_id, m.name, m.phone, m.code
    FROM attendance a
    JOIN members m ON m.id = a.member_id
    ${whereClause}
    ORDER BY a.checkin_at DESC, a.id DESC
    LIMIT 2000
  `;
  return db.prepare(sql).all(...params);
});

// تسجيل حضور يدوي لتاريخ سابق أو اليوم
route('POST', '/api/attendance/manual', 'staff', (ctx) => {
  const memberId = intParam(ctx.body.member_id);
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
  if (!m) throw new ApiError(404, 'العضو غير موجود');
  const day = ctx.body.date ? String(ctx.body.date).trim() : todayStr();
  if (!validDate(day)) throw new ApiError(400, 'التاريخ غير صحيح');
  const time = ctx.body.time && /^\d{2}:\d{2}$/.test(ctx.body.time) ? ctx.body.time.trim() : '12:00';
  const checkinAt = `${day}T${time}:00`;
  const r = db
    .prepare('INSERT INTO attendance (member_id, day, checkin_at, result, reason) VALUES (?, ?, ?, ?, ?)')
    .run(m.id, day, new Date(checkinAt).toISOString(), 'ok', 'manual');
  return { ok: true, id: Number(r.lastInsertRowid) };
});

// أرشفة حركة حضور (محمي - لا حذف نهائي لضمان أمان السجلات)
route('DELETE', '/api/attendance/:id', 'admin', (ctx) => {
  const id = intParam(ctx.params.id);
  const rec = db.prepare('SELECT * FROM attendance WHERE id = ?').get(id);
  if (!rec) throw new ApiError(404, 'سجل الحضور غير موجود');
  // ✅ لا يُحذف نهائياً - يُؤرشف عبر عمود archived مع تسجيل في audit_logs
  db.prepare(`UPDATE attendance SET archived = 1, reason = CASE WHEN reason LIKE '[مؤرشف]%' THEN reason ELSE '[مؤرشف] ' || reason END WHERE id = ?`).run(id);
  logAudit('archive_attendance', ctx.session?.role || 'admin', `أرشفة سجل حضور #${id} للعضو ${rec.member_id} بتاريخ ${rec.day}`, ctx.ip);
  return { ok: true, message: 'تم أرشفة سجل الحضور - لا يمكن الحذف النهائي لأمان البيانات' };
});

// ---------- المصروفات اليومية (سجل دائم لا يُحذف — متاح للمدير والموظف) ----------
route('GET', '/api/expenses', 'staff', (ctx) => {
  const dateParam = (ctx.url.searchParams.get('date') || '').trim();
  const monthParam = (ctx.url.searchParams.get('month') || '').trim();
  const category = (ctx.url.searchParams.get('category') || '').trim();
  const q = (ctx.url.searchParams.get('q') || '').trim().toLowerCase();

  const where = [];
  const args = [];

  if (dateParam) {
    if (!validDate(dateParam)) throw new ApiError(400, 'التاريخ غير صحيح');
    where.push('expense_date = ?');
    args.push(dateParam);
  } else if (monthParam) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam)) throw new ApiError(400, 'الشهر غير صحيح');
    const monthStart = `${monthParam}-01`;
    const nextMonthStart = `${shiftMonthStr(monthParam, 1)}-01`;
    where.push('expense_date >= ? AND expense_date < ?');
    args.push(monthStart, nextMonthStart);
  }

  if (category && category !== 'all') {
    where.push('category = ?');
    args.push(category);
  }

  const sql = `SELECT * FROM expenses ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY expense_date DESC, id DESC LIMIT 500`;
  let rows = db.prepare(sql).all(...args);
  if (q) {
    rows = rows.filter(
      (r) =>
        (r.title || '').toLowerCase().includes(q) ||
        (r.category || '').toLowerCase().includes(q) ||
        (r.notes || '').toLowerCase().includes(q) ||
        (r.recorded_by || '').toLowerCase().includes(q)
    );
  }

  const today = todayStr();
  const curMonth = today.slice(0, 7);
  const monthStart = `${curMonth}-01`;
  const nextMonthStart = `${shiftMonthStr(curMonth, 1)}-01`;

  const todayTotal = db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM expenses WHERE expense_date = ?').get(today).s;
  const monthTotal = db
    .prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM expenses WHERE expense_date >= ? AND expense_date < ?')
    .get(monthStart, nextMonthStart).s;
  const filteredTotal = rows.reduce((acc, r) => acc + (Number(r.amount) || 0), 0);

  return {
    today,
    currentMonth: curMonth,
    todayTotal: Number(todayTotal) || 0,
    monthTotal: Number(monthTotal) || 0,
    filteredTotal,
    count: rows.length,
    list: rows.map((r) => ({ ...r, time: formatTimeInZone(r.created_at) })),
  };
});

route('POST', '/api/expenses', 'staff', (ctx) => {
  const b = ctx.body || {};
  const title = cleanStr(b.title, 150, 'بيان المصروف', true);
  const category = cleanStr(b.category, 60, 'التصنيف') || 'أخرى';
  const amount = Number(toEnglishDigits(b.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ApiError(400, 'المبلغ يجب أن يكون رقم أكبر من صفر');
  }
  const expenseDate = cleanStr(b.expense_date, 20, 'تاريخ المصروف') || todayStr();
  if (!validDate(expenseDate)) throw new ApiError(400, 'تاريخ المصروف غير صحيح');
  const notes = cleanStr(b.notes, 300, 'الملاحظات');
  const createdAt = new Date().toISOString();
  const recordedBy = ctx.session.role === 'admin' ? 'admin' : 'staff';

  const info = db
    .prepare(
      `INSERT INTO expenses (title, category, amount, expense_date, notes, recorded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(title, category, amount, expenseDate, notes, recordedBy, createdAt);

  const id = Number(info.lastInsertRowid);
  logAudit('add_expense', ctx.session.role, `تسجيل مصروف: ${title} (${category}) بقيمة ${amount} ج.م بتاريخ ${expenseDate}`, ctx.ip);
  const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
  return { ...row, time: formatTimeInZone(row.created_at) };
});

// ---------- تقرير الوردية / التقرير اليومي للاشتراكات والتجديدات ----------
route('GET', '/api/reports/daily', 'admin', (ctx) => {
  const dateParam = ctx.url.searchParams.get('date');
  const targetDate = dateParam ? String(dateParam).trim() : todayStr();
  if (!validDate(targetDate)) {
    throw new ApiError(400, 'التاريخ غير صحيح');
  }

  // نافذة أمان لتغطية فرق التوقيت (Africa/Cairo) مقارنة بـ UTC
  const windowStart = addDays(targetDate, -1);
  const windowEnd = addDays(targetDate, 2);

  const rawRows = db
    .prepare(
      `SELECT s.id, s.member_id, s.plan_id, s.plan_name, s.start_date, s.end_date, s.price, s.status, s.created_at,
              m.name AS member_name, m.phone AS member_phone, m.code AS member_code,
              (SELECT COUNT(*) FROM subscriptions s_prev 
               WHERE s_prev.member_id = s.member_id 
                 AND (s_prev.created_at < s.created_at OR (s_prev.created_at = s.created_at AND s_prev.id < s.id))
              ) AS prev_subs_count
       FROM subscriptions s
       JOIN members m ON m.id = s.member_id
       WHERE s.created_at >= ? AND s.created_at < ?
       ORDER BY s.created_at DESC, s.id DESC`
    )
    .all(windowStart, windowEnd);

  const list = [];
  let totalRevenue = 0;
  let newCount = 0;
  let newRevenue = 0;
  let renewCount = 0;
  let renewRevenue = 0;
  let cancelledCount = 0;
  let cancelledRevenue = 0;

  for (const row of rawRows) {
    const rowDate = new Date(row.created_at).toLocaleDateString('en-CA', { timeZone: TZ });
    if (rowDate !== targetDate) continue;

    const isRenewal = row.prev_subs_count > 0;
    const isCancelled = row.status === 'cancelled';
    const price = Number(row.price) || 0;

    if (isCancelled) {
      cancelledCount++;
      cancelledRevenue += price;
    } else {
      totalRevenue += price;
      if (isRenewal) {
        renewCount++;
        renewRevenue += price;
      } else {
        newCount++;
        newRevenue += price;
      }
    }

    list.push({
      id: row.id,
      member_id: row.member_id,
      member_name: row.member_name,
      member_phone: row.member_phone,
      member_code: row.member_code,
      plan_name: row.plan_name,
      price: price,
      start_date: row.start_date,
      end_date: row.end_date,
      status: row.status,
      created_at: row.created_at,
      time: formatTimeInZone(row.created_at),
      type: isRenewal ? 'renew' : 'new',
      type_label: isRenewal ? 'تجديد اشتراك' : 'اشتراك جديد',
    });
  }

  // عدد الحضور في هذا اليوم
  const attendanceCount = db
    .prepare(`SELECT COUNT(DISTINCT member_id) AS c FROM attendance WHERE day = ? AND result = 'ok'`)
    .get(targetDate).c;

  // جلب ملخص آخر 14 يوم لسرعة التنقل وسجل الأيام السابقة
  const recentMap = {};
  const today = todayStr();
  for (let i = 0; i < 14; i++) {
    const d = addDays(today, -i);
    recentMap[d] = { date: d, count: 0, revenue: 0 };
  }
  const subRecent = db
    .prepare(`SELECT price, status, created_at FROM subscriptions WHERE created_at >= ?`)
    .all(addDays(today, -16));

  for (const s of subRecent) {
    if (s.status !== 'cancelled') {
      const d = new Date(s.created_at).toLocaleDateString('en-CA', { timeZone: TZ });
      if (recentMap[d]) {
        recentMap[d].count++;
        recentMap[d].revenue += Number(s.price) || 0;
      }
    }
  }
  const recentHistory = Object.values(recentMap).sort((a, b) => b.date.localeCompare(a.date));

  const expensesRows = db
    .prepare(`SELECT id, title, category, amount, expense_date, notes, recorded_by, created_at FROM expenses WHERE expense_date = ? ORDER BY id DESC`)
    .all(targetDate);
  const totalExpenses = expensesRows.reduce((acc, r) => acc + (Number(r.amount) || 0), 0);
  const netRevenue = totalRevenue - totalExpenses;

  return {
    date: targetDate,
    today,
    gymName: GYM_NAME,
    totalRevenue,
    totalExpenses,
    expenseCount: expensesRows.length,
    netRevenue,
    totalCount: newCount + renewCount,
    newCount,
    newRevenue,
    renewCount,
    renewRevenue,
    cancelledCount,
    cancelledRevenue,
    attendanceCount,
    recentHistory,
    expensesList: expensesRows.map((r) => ({ ...r, time: formatTimeInZone(r.created_at) })),
    list,
  };
});

// ---------- التقفيل الشهري للإيرادات (للمدير) ----------
function shiftMonthStr(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

route('GET', '/api/reports/monthly', 'admin', (ctx) => {
  const monthParam = ctx.url.searchParams.get('month');
  const currentMonth = todayStr().slice(0, 7);
  const targetMonth = monthParam ? String(monthParam).trim() : currentMonth;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(targetMonth)) {
    throw new ApiError(400, 'الشهر غير صحيح');
  }

  const monthStart = `${targetMonth}-01`;
  const nextMonthStart = `${shiftMonthStr(targetMonth, 1)}-01`;
  const windowStart = addDays(monthStart, -1);
  const windowEnd = addDays(nextMonthStart, 2);

  const rawSubs = db
    .prepare(
      `SELECT s.id, s.member_id, s.plan_name, s.start_date, s.end_date, s.price, s.status, s.created_at,
              m.name AS member_name, m.phone AS member_phone, m.code AS member_code,
              (SELECT COUNT(*) FROM subscriptions s_prev
               WHERE s_prev.member_id = s.member_id
                 AND (s_prev.created_at < s.created_at OR (s_prev.created_at = s.created_at AND s_prev.id < s.id))
              ) AS prev_subs_count
       FROM subscriptions s
       JOIN members m ON m.id = s.member_id
       WHERE s.created_at >= ? AND s.created_at < ?
       ORDER BY s.created_at DESC, s.id DESC`
    )
    .all(windowStart, windowEnd);

  const rawPt = db
    .prepare(
      `SELECT p.id, p.member_id, p.trainer_name, p.package_name, p.start_date, p.end_date, p.price, p.paid, p.status, p.created_at,
              m.name AS member_name, m.phone AS member_phone, m.code AS member_code
       FROM private_trainings p
       JOIN members m ON m.id = p.member_id
       WHERE p.created_at >= ? AND p.created_at < ?
       ORDER BY p.created_at DESC, p.id DESC`
    )
    .all(windowStart, windowEnd);

  const list = [];
  const dailyMap = {};
  const planMap = {};
  let subRevenue = 0;
  let newCount = 0;
  let newRevenue = 0;
  let renewCount = 0;
  let renewRevenue = 0;
  let cancelledCount = 0;
  let cancelledRevenue = 0;
  let ptCount = 0;
  let ptRevenue = 0;
  let ptPaid = 0;

  const ensureDay = (d) => {
    if (!dailyMap[d]) dailyMap[d] = { date: d, subCount: 0, subRevenue: 0, ptCount: 0, ptRevenue: 0, totalRevenue: 0, expenses: 0, netRevenue: 0 };
    return dailyMap[d];
  };
  const addPlanStat = (name, price) => {
    if (!planMap[name]) planMap[name] = { name, count: 0, revenue: 0 };
    planMap[name].count++;
    planMap[name].revenue += price;
  };

  for (const row of rawSubs) {
    const rowDate = new Date(row.created_at).toLocaleDateString('en-CA', { timeZone: TZ });
    if (!rowDate.startsWith(targetMonth)) continue;

    const isRenewal = row.prev_subs_count > 0;
    const isCancelled = row.status === 'cancelled';
    const price = Number(row.price) || 0;

    if (isCancelled) {
      cancelledCount++;
      cancelledRevenue += price;
    } else {
      subRevenue += price;
      if (isRenewal) {
        renewCount++;
        renewRevenue += price;
      } else {
        newCount++;
        newRevenue += price;
      }
      const dObj = ensureDay(rowDate);
      dObj.subCount++;
      dObj.subRevenue += price;
      dObj.totalRevenue += price;
      addPlanStat(row.plan_name, price);
    }

    list.push({
      kind: 'sub',
      id: row.id,
      member_id: row.member_id,
      member_name: row.member_name,
      member_phone: row.member_phone,
      member_code: row.member_code,
      plan_name: row.plan_name,
      price,
      date: rowDate,
      time: formatTimeInZone(row.created_at),
      status: row.status,
      created_at: row.created_at,
      type: isRenewal ? 'renew' : 'new',
      type_label: isRenewal ? 'تجديد اشتراك' : 'اشتراك جديد',
    });
  }

  for (const row of rawPt) {
    const rowDate = new Date(row.created_at).toLocaleDateString('en-CA', { timeZone: TZ });
    if (!rowDate.startsWith(targetMonth)) continue;
    if (row.status === 'cancelled') continue;

    const price = Number(row.price) || 0;
    const paid = Number(row.paid) || 0;
    ptCount++;
    ptRevenue += price;
    ptPaid += paid;

    const dObj = ensureDay(rowDate);
    dObj.ptCount++;
    dObj.ptRevenue += price;
    dObj.totalRevenue += price;
    addPlanStat(`⭐ ${row.package_name}`, price);

    list.push({
      kind: 'pt',
      id: row.id,
      member_id: row.member_id,
      member_name: row.member_name,
      member_phone: row.member_phone,
      member_code: row.member_code,
      plan_name: `${row.package_name} (${row.trainer_name})`,
      price,
      date: rowDate,
      time: formatTimeInZone(row.created_at),
      status: row.status,
      created_at: row.created_at,
      type: 'pt',
      type_label: 'برايفت (PT)',
    });
  }

  list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  const totalRevenue = subRevenue + ptRevenue;

  const expensesRows = db
    .prepare(`SELECT id, title, category, amount, expense_date, notes, recorded_by, created_at FROM expenses WHERE expense_date >= ? AND expense_date < ? ORDER BY expense_date DESC, id DESC`)
    .all(monthStart, nextMonthStart);
  let totalExpenses = 0;
  for (const ex of expensesRows) {
    const amt = Number(ex.amount) || 0;
    totalExpenses += amt;
    const dObj = ensureDay(ex.expense_date);
    dObj.expenses += amt;
  }
  for (const dObj of Object.values(dailyMap)) {
    dObj.netRevenue = dObj.totalRevenue - dObj.expenses;
  }

  const empStats = db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(salary), 0) AS s FROM employees WHERE active = 1`).get();
  const totalSalaries = Number(empStats.s) || 0;
  const employeeCount = Number(empStats.c) || 0;
  const netAfterExpenses = totalRevenue - totalExpenses;
  const netAfterSalaries = netAfterExpenses - totalSalaries;

  const attendanceCount = db
    .prepare(`SELECT COUNT(*) AS c FROM attendance WHERE day >= ? AND day < ? AND result = 'ok'`)
    .get(monthStart, nextMonthStart).c;

  const dailyBreakdown = Object.values(dailyMap).sort((a, b) => b.date.localeCompare(a.date));
  const planBreakdown = Object.values(planMap).sort((a, b) => b.revenue - a.revenue);

  // ملخص آخر 12 شهر لسرعة التنقل
  const recentMonthsMap = {};
  for (let i = 0; i < 12; i++) {
    const m = shiftMonthStr(currentMonth, -i);
    recentMonthsMap[m] = { month: m, count: 0, revenue: 0, expenses: 0, netRevenue: 0 };
  }
  const oldestMonthStart = `${shiftMonthStr(currentMonth, -11)}-01`;
  const oldestWindow = addDays(oldestMonthStart, -1);
  for (const s of db.prepare(`SELECT price, status, created_at FROM subscriptions WHERE created_at >= ?`).all(oldestWindow)) {
    if (s.status === 'cancelled') continue;
    const m = new Date(s.created_at).toLocaleDateString('en-CA', { timeZone: TZ }).slice(0, 7);
    if (recentMonthsMap[m]) {
      recentMonthsMap[m].count++;
      recentMonthsMap[m].revenue += Number(s.price) || 0;
    }
  }
  for (const p of db.prepare(`SELECT price, status, created_at FROM private_trainings WHERE created_at >= ?`).all(oldestWindow)) {
    if (p.status === 'cancelled') continue;
    const m = new Date(p.created_at).toLocaleDateString('en-CA', { timeZone: TZ }).slice(0, 7);
    if (recentMonthsMap[m]) {
      recentMonthsMap[m].count++;
      recentMonthsMap[m].revenue += Number(p.price) || 0;
    }
  }
  for (const ex of db.prepare(`SELECT amount, expense_date FROM expenses WHERE expense_date >= ?`).all(oldestMonthStart)) {
    const m = (ex.expense_date || '').slice(0, 7);
    if (recentMonthsMap[m]) {
      recentMonthsMap[m].expenses += Number(ex.amount) || 0;
    }
  }
  for (const rm of Object.values(recentMonthsMap)) {
    rm.netRevenue = rm.revenue - rm.expenses;
  }
  const recentMonths = Object.values(recentMonthsMap).sort((a, b) => b.month.localeCompare(a.month));

  return {
    month: targetMonth,
    currentMonth,
    gymName: GYM_NAME,
    totalRevenue,
    totalExpenses,
    expenseCount: expensesRows.length,
    netAfterExpenses,
    subRevenue,
    subCount: newCount + renewCount,
    newCount,
    newRevenue,
    renewCount,
    renewRevenue,
    cancelledCount,
    cancelledRevenue,
    ptCount,
    ptRevenue,
    ptPaid,
    totalSalaries,
    employeeCount,
    netAfterSalaries,
    attendanceCount,
    dailyBreakdown,
    planBreakdown,
    recentMonths,
    expensesList: expensesRows.map((r) => ({ ...r, time: formatTimeInZone(r.created_at) })),
    list,
  };
});

// ---------- إعدادات النظام وتنبيهات الواتساب ----------
function getSetting(key, fallback = '') {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?'
  ).run(key, String(value), String(value));
}

function formatReminderMessage(template, member, sub, gymName) {
  const days = sub.days_left;
  let daysStr = `${days} يوم`;
  if (days === 0) daysStr = 'اليوم';
  else if (days === 1) daysStr = 'غداً';
  else if (days === 2) daysStr = 'يومين';
  else if (days < 0) daysStr = `منتهي منذ ${Math.abs(days)} يوم`;

  const origin = process.env.BASE_URL || `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  const cardUrl = `${origin}/card.html?code=${encodeURIComponent(member.code)}`;

  return (template || '')
    .replace(/{name}/g, member.name)
    .replace(/{code}/g, member.code)
    .replace(/{gym}/g, gymName)
    .replace(/{plan}/g, sub.plan_name || 'عضوية')
    .replace(/{end_date}/g, sub.end_date || '')
    .replace(/{days_left}/g, daysStr)
    .replace(/{card_url}/g, cardUrl);
}


// قائمة الأعضاء للتذكير بالواتساب
route('GET', '/api/reminders/expiring', 'staff', (ctx) => {
  const today = todayStr();
  const daysAhead = Number(ctx.url.searchParams.get('days') || getSetting('remind_days', '3'));
  const members = db.prepare('SELECT * FROM members WHERE active = 1 ORDER BY name').all();
  const list = [];
  for (const m of members) {
    const sub = subscriptionState(m.id, today);
    if ((sub.days_left !== null && sub.days_left >= 0 && sub.days_left <= daysAhead) || (sub.state === 'expired' && sub.days_left >= -3)) {
      const lastRem = db
        .prepare('SELECT * FROM reminders WHERE member_id = ? ORDER BY sent_at DESC LIMIT 1')
        .get(m.id);
      list.push({
        id: m.id,
        code: m.code,
        name: m.name,
        phone: m.phone,
        plan_name: sub.plan_name || 'عضوية',
        end_date: sub.end_date,
        days_left: sub.days_left,
        state: sub.state,
        lastReminder: lastRem || null,
        remindedToday: lastRem ? lastRem.sent_at.slice(0, 10) === today : false,
      });
    }
  }
  list.sort((a, b) => a.days_left - b.days_left);
  return {
    today,
    daysAhead,
    list,
    template: getSetting('remind_template'),
    gymName: GYM_NAME,
  };
});

// تسجيل إرسال تذكير
route('POST', '/api/reminders/log', 'staff', (ctx) => {
  const memberId = intParam(ctx.body.member_id);
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
  if (!m) throw new ApiError(404, 'العضو غير موجود');
  const today = todayStr();
  const sub = subscriptionState(m.id, today);
  const r = db
    .prepare('INSERT INTO reminders (member_id, sent_at, days_left, phone, status) VALUES (?, ?, ?, ?, ?)')
    .run(m.id, new Date().toISOString(), sub.days_left || 0, m.phone, 'sent');
  return { ok: true, id: Number(r.lastInsertRowid) };
});

// قراءة الإعدادات
route('GET', '/api/settings', 'admin', () => {
  const rows = db.prepare('SELECT * FROM settings').all();
  const obj = {};
  rows.forEach((r) => {
    // عدم إرسال كلمات المرور في رد الـ settings العادي للأمان
    if (r.key !== 'staff_password' && r.key !== 'admin_password') {
      obj[r.key] = r.value;
    }
  });
  obj.hasCustomStaffPassword = !!db.prepare("SELECT 1 FROM settings WHERE key = 'staff_password'").get();
  obj.hasCustomAdminPassword = !!db.prepare("SELECT 1 FROM settings WHERE key = 'admin_password'").get();
  return obj;
});

// حفظ الإعدادات العامة
route('POST', '/api/settings', 'admin', (ctx) => {
  for (const [k, v] of Object.entries(ctx.body)) {
    if (k !== 'staff_password' && k !== 'admin_password') {
      setSetting(k, v);
    }
  }
  return { ok: true };
});

// تغيير كلمة مرور الـ Staff (الموظف)
route('POST', '/api/settings/change-staff-password', 'admin', (ctx) => {
  const newPw = typeof ctx.body.newPassword === 'string' ? ctx.body.newPassword.trim() : '';
  if (!newPw || newPw.length < 4) {
    throw new ApiError(400, 'كلمة المرور يجب ألا تقل عن 4 حروف أو أرقام');
  }
  setSetting('staff_password', hashPassword(newPw));
  logAudit('change_staff_password', ctx.session?.role || 'admin', 'تم تغيير كلمة مرور الموظفين');
  return { ok: true, message: 'تم تغيير كلمة مرور الموظفين (Staff) بنجاح' };
});

// تغيير كلمة مرور المدير (Admin)
route('POST', '/api/settings/change-admin-password', 'admin', (ctx) => {
  const currentPw = typeof ctx.body.currentPassword === 'string' ? ctx.body.currentPassword : '';
  const newPw = typeof ctx.body.newPassword === 'string' ? ctx.body.newPassword.trim() : '';
  if (!currentPw) {
    throw new ApiError(400, 'يرجى إدخال كلمة المرور الحالية للمدير');
  }
  if (!verifyPassword(currentPw, getAdminPassword())) {
    throw new ApiError(400, 'كلمة المرور الحالية للمدير غير صحيحة');
  }
  if (!newPw || newPw.length < 4) {
    throw new ApiError(400, 'كلمة المرور الجديدة يجب ألا تقل عن 4 حروف أو أرقام');
  }
  if (currentPw === newPw) {
    throw new ApiError(400, 'كلمة المرور الجديدة مطابقة للكلمة الحالية، يرجى كتابة كلمة مرور مختلفة');
  }
  setSetting('admin_password', hashPassword(newPw));
  logAudit('change_admin_password', ctx.session?.role || 'admin', 'تم تغيير كلمة مرور المدير');
  return { ok: true, message: 'تم تغيير كلمة مرور المدير (Admin) بنجاح' };
});

// ---------- نظام النسخ الاحتياطي وحماية البيانات ----------
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

// دالة تحديد مسار البارتشن الآمن (خارج C: تماماً لحماية البيانات عند سقوط الويندوز)
function getSafePartitionDir() {
  const customPath = getSetting('backup_external_dir', '').trim();
  if (customPath && fs.existsSync(customPath)) return customPath;

  // البحث عن بارتشن آمن خارج C: بالترتيب (الأولوية لـ F: ثم N: ثم A: ثم غيرها)
  const candidateDrives = ['F:', 'N:', 'A:', 'D:', 'E:', 'G:', 'H:'];
  for (const drv of candidateDrives) {
    const root = drv + '\\';
    try {
      if (fs.existsSync(root)) {
        const target = path.join(root, 'gym-backups');
        if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
        return target;
      }
    } catch {}
  }

  for (let code = 68; code <= 90; code++) {
    const root = String.fromCharCode(code) + ':\\';
    try {
      if (fs.existsSync(root)) {
        const target = path.join(root, 'gym-backups');
        if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
        return target;
      }
    } catch {}
  }

  return null;
}

function cleanupOldBackups(dir, keepCount = 30) {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.db'))
      .map((f) => {
        const fp = path.join(dir, f);
        return { name: f, path: fp, time: fs.statSync(fp).mtimeMs };
      })
      .sort((a, b) => b.time - a.time);

    if (files.length > keepCount) {
      for (const f of files.slice(keepCount)) {
        try {
          fs.unlinkSync(f.path);
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

function createLocalBackup(prefix = 'gym-backup') {
  // تفريغ الـ WAL لحظياً إلى ملف gym.db لضمان نسخ أحدث العمليات
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
  const filename = `${prefix}-${dateStr}.db`;

  const srcDb = path.join(DATA_DIR, 'gym.db');
  const destPrimary = path.join(BACKUP_DIR, filename);

  fs.copyFileSync(srcDb, destPrimary);

  // حفظ نسخة في البارتشن الآمن خارج C: (مثل F:\gym-backups)
  let safePath = null;
  const safeDir = getSafePartitionDir();
  if (safeDir) {
    try {
      if (!fs.existsSync(safeDir)) fs.mkdirSync(safeDir, { recursive: true });
      safePath = path.join(safeDir, filename);
      fs.copyFileSync(srcDb, safePath);
    } catch (e) {
      console.warn('Failed safe partition backup:', e.message);
    }
  }

  // حفظ نسخة إضافية على بارتشن A: (A:\gym-backups) لزيادة الأمان والتكرار
  const aDir = 'A:\\gym-backups';
  if (safeDir && !safeDir.toUpperCase().startsWith('A:')) {
    try {
      if (!fs.existsSync(aDir)) fs.mkdirSync(aDir, { recursive: true });
      fs.copyFileSync(srcDb, path.join(aDir, filename));
    } catch (e) {}
  }

  cleanupOldBackups(BACKUP_DIR, 60);
  if (safeDir) cleanupOldBackups(safeDir, 60);
  if (fs.existsSync(aDir)) cleanupOldBackups(aDir, 60);

  return {
    filename,
    primary: destPrimary,
    safeDir: safePath,
    size: fs.statSync(destPrimary).size,
  };
}

let lastAutoBackupDay = '';
function checkAndRunAutoBackup() {
  const today = todayStr();
  try {
    const todayFile = path.join(BACKUP_DIR, `gym-backup-${today}.db`);
    if (lastAutoBackupDay !== today || !fs.existsSync(todayFile)) {
      const res = createLocalBackup('gym-backup');
      lastAutoBackupDay = today;
      console.log(`[Backup] تم إنشاء وتحديث النسخة الاحتياطية على البارتشن الآمن ليوم ${today}: ${res.filename}`);
    }
  } catch (e) {
    console.error('[Backup Error]:', e.message);
  }
}

// تنزيل ملف قاعدة البيانات الحالي مباشرة (للحفظ على فلاشة أو هاتف) باسم تاريخ اليوم
route('GET', '/api/backup/download', 'admin', () => {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  const srcDb = path.join(DATA_DIR, 'gym.db');
  const buf = fs.readFileSync(srcDb);
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: TZ });
  const filename = `gym-backup-${dateStr}.db`;

  return {
    raw: buf,
    type: 'application/octet-stream',
    headers: {
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': Buffer.byteLength(buf),
    },
  };
});

// أخذ نسخة احتياطية وحفظها محلياً الآن
route('POST', '/api/backup/now', 'admin', (ctx) => {
  const res = createLocalBackup('gym-backup');
  logAudit('backup_created', ctx.session?.role || 'admin', `نسخة احتياطية فورية: ${res.filename}`, ctx.ip);
  return {
    ok: true,
    message: 'تم عمل نسخة احتياطية بنجاح وحفظها في البارتشن الآمن باسم تاريخ اليوم',
    ...res,
  };
});

// نسخة احتياطية شاملة (قاعدة البيانات كاملة + تقرير CSV شامل لكل الجداول)
route('POST', '/api/backup/full', 'admin', (ctx) => {
  const { execSync } = require('child_process');
  try {
    execSync(`"${process.execPath}" "${path.join(__dirname, 'scripts', 'full_backup.js')}"`, {
      timeout: 60000,
      cwd: __dirname,
    });
  } catch (e) {
    console.error('[FullBackup Error]:', e.message);
    throw new ApiError(500, 'فشل إنشاء النسخة الاحتياطية الشاملة: ' + e.message);
  }
  const REPORTS_DIR = path.join(DATA_DIR, 'reports');
  const reports = fs.existsSync(REPORTS_DIR)
    ? fs.readdirSync(REPORTS_DIR).filter((f) => f.endsWith('.csv')).sort().reverse().slice(0, 5)
    : [];
  logAudit('backup_created', ctx.session?.role || 'admin', `إنشاء نسخة احتياطية شاملة + تقرير CSV (${reports[0] || ''})`, ctx.ip);
  return {
    ok: true,
    message: 'تم إنشاء النسخة الاحتياطية الشاملة + تقرير Excel/CSV بنجاح',
    lastReports: reports,
  };
});

// تحميل أحدث تقرير CSV شامل
route('GET', '/api/backup/report', 'admin', () => {
  const REPORTS_DIR = path.join(DATA_DIR, 'reports');
  if (!fs.existsSync(REPORTS_DIR)) throw new ApiError(404, 'لا توجد تقارير محفوظة بعد');
  const files = fs.readdirSync(REPORTS_DIR).filter((f) => f.endsWith('.csv')).sort().reverse();
  if (!files.length) throw new ApiError(404, 'لا توجد تقارير محفوظة بعد — اضغط "نسخة شاملة + تقرير Excel" أولاً');
  const content = fs.readFileSync(path.join(REPORTS_DIR, files[0]));
  return {
    raw: content,
    type: 'text/csv; charset=utf-8',
    headers: {
      'Content-Disposition': `attachment; filename="${files[0]}"`,
      'Content-Length': Buffer.byteLength(content),
    },
  };
});

// تصدير ملف PDF منظم يحتوي على جميع الأعضاء وبياناتهم
function escHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function findPdfBrowser() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

route('GET', '/api/export/members.pdf', 'staff', (ctx) => {
  const browserPath = findPdfBrowser();
  if (!browserPath) {
    throw new ApiError(500, 'تعذر العثور على Microsoft Edge أو Chrome لتوليد ملف PDF');
  }

  const gymName = getSetting('gym_name', 'Hulk Gym');
  const today = todayStr();
  const rows = db.prepare('SELECT * FROM members ORDER BY id ASC').all();
  const list = rows.map((m) => {
    const view = memberView(m, today);
    const attCount = db.prepare("SELECT COUNT(*) AS c FROM attendance WHERE member_id = ? AND result = 'ok' AND COALESCE(archived, 0) = 0").get(m.id).c;
    return { ...view, rawActive: m.active, attCount };
  });

  const statusText = (m) => {
    if (m.rawActive === -1) return 'مؤرشف';
    if (!m.rawActive) return 'موقوف';
    switch (m.sub.state) {
      case 'active': return `نشط (${m.sub.days_left} يوم)`;
      case 'expiring': return `قارب على الانتهاء (${m.sub.days_left} يوم)`;
      case 'expired': return 'منتهي';
      case 'upcoming': return 'لم يبدأ بعد';
      default: return 'بدون اشتراك';
    }
  };

  const statusColor = (m) => {
    if (m.rawActive === -1 || !m.rawActive) return '#64748b';
    switch (m.sub.state) {
      case 'active': return '#16a34a';
      case 'expiring': return '#d97706';
      case 'expired': return '#dc2626';
      default: return '#475569';
    }
  };

  const activeCount = list.filter((m) => m.rawActive === 1 && (m.sub.state === 'active' || m.sub.state === 'expiring')).length;
  const expiredCount = list.filter((m) => m.rawActive === 1 && m.sub.state === 'expired').length;
  const archivedCount = list.filter((m) => m.rawActive === -1).length;

  const tableRowsHtml = list.map((m, i) => `
    <tr>
      <td class="center">${i + 1}</td>
      <td class="mono center">${escHtml(m.code)}</td>
      <td class="bold">${escHtml(m.name)}</td>
      <td class="mono">${escHtml(m.phone || '—')}</td>
      <td class="center">${m.age != null ? escHtml(m.age) : '—'}</td>
      <td>${escHtml(m.sub.plan_name || '—')}</td>
      <td class="mono center">${escHtml(m.sub.start_date || '—')}</td>
      <td class="mono center">${escHtml(m.sub.end_date || '—')}</td>
      <td class="center"><span class="badge" style="color:${statusColor(m)};border-color:${statusColor(m)}">${escHtml(statusText(m))}</span></td>
      <td class="center">${m.attCount}</td>
      <td class="notes">${escHtml((m.notes || '').replace(/\n/g, ' | ') || '—')}</td>
    </tr>
  `).join('');

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<title>تقرير الأعضاء - ${escHtml(gymName)}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; color: #0f172a; margin: 0; padding: 0; font-size: 11px; }
  .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #16a34a; padding-bottom: 10px; margin-bottom: 12px; }
  .header h1 { margin: 0; font-size: 20px; color: #15803d; }
  .header .meta { font-size: 11px; color: #475569; text-align: left; }
  .stats { display: flex; gap: 12px; margin-bottom: 12px; }
  .stat { flex: 1; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px 12px; text-align: center; }
  .stat b { display: block; font-size: 16px; color: #0f172a; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th { background: #1e293b; color: #fff; padding: 7px 6px; text-align: right; font-size: 10.5px; border: 1px solid #334155; }
  td { padding: 6px; border: 1px solid #cbd5e1; vertical-align: middle; font-size: 10.5px; }
  tbody tr:nth-child(even) { background: #f8fafc; }
  .center { text-align: center; }
  .bold { font-weight: 700; }
  .mono { font-family: Consolas, monospace; direction: ltr; unicode-bidi: embed; }
  .notes { max-width: 170px; word-wrap: break-word; color: #334155; font-size: 9.5px; }
  .badge { display: inline-block; padding: 2px 6px; border: 1px solid; border-radius: 4px; font-weight: 600; font-size: 9.5px; background: #fff; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <h1>🏋️ سجل الأعضاء الشامل — ${escHtml(gymName)}</h1>
      <div style="color:#475569;margin-top:3px;">قائمة منظمة بجميع الأعضاء المسجلين وبيانات اشتراكاتهم</div>
    </div>
    <div class="meta">
      <div>تاريخ التقرير: <b>${escHtml(today)}</b></div>
      <div>وقت الإصدار: ${escHtml(new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }))}</div>
    </div>
  </div>

  <div class="stats">
    <div class="stat">إجمالي الأعضاء<b>${list.length}</b></div>
    <div class="stat">اشتراكات سارية<b style="color:#16a34a">${activeCount}</b></div>
    <div class="stat">اشتراكات منتهية<b style="color:#dc2626">${expiredCount}</b></div>
    <div class="stat">أعضاء مؤرشفون<b style="color:#64748b">${archivedCount}</b></div>
  </div>

  <table>
    <thead>
      <tr>
        <th class="center">#</th>
        <th class="center">الكود</th>
        <th>الاسم</th>
        <th>الموبايل</th>
        <th class="center">السن</th>
        <th>الباقة الحالية</th>
        <th class="center">تاريخ البدء</th>
        <th class="center">تاريخ الانتهاء</th>
        <th class="center">الحالة</th>
        <th class="center">الحضور</th>
        <th>الملاحظات</th>
      </tr>
    </thead>
    <tbody>
      ${tableRowsHtml || '<tr><td colspan="11" class="center">لا يوجد أعضاء مسجلون بعد.</td></tr>'}
    </tbody>
  </table>
</body>
</html>`;

  const os = require('os');
  const { execFileSync } = require('child_process');
  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const tmpHtml = path.join(os.tmpdir(), `hulk-members-${stamp}.html`);
  const tmpPdf = path.join(os.tmpdir(), `hulk-members-${stamp}.pdf`);
  const tmpProfile = path.join(os.tmpdir(), `hulk-edge-${stamp}`);

  try {
    fs.writeFileSync(tmpHtml, html, 'utf8');
    const fileUrl = 'file:///' + tmpHtml.replace(/\\/g, '/');
    execFileSync(
      browserPath,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        `--user-data-dir=${tmpProfile}`,
        '--no-pdf-header-footer',
        `--print-to-pdf=${tmpPdf}`,
        fileUrl,
      ],
      { timeout: 30000, windowsHide: true }
    );
    if (!fs.existsSync(tmpPdf)) {
      throw new Error('لم يتم توليد ملف PDF');
    }
    const pdfBuf = fs.readFileSync(tmpPdf);
    logAudit('export_members_pdf', ctx.session?.role || 'staff', `تصدير ملف PDF لعدد ${list.length} عضو`, ctx.ip);
    return {
      raw: pdfBuf,
      type: 'application/pdf',
      headers: {
        'Content-Disposition': `attachment; filename="hulk-gym-members-${today}.pdf"`,
        'Content-Length': Buffer.byteLength(pdfBuf),
      },
    };
  } finally {
    try { if (fs.existsSync(tmpHtml)) fs.unlinkSync(tmpHtml); } catch {}
    try { if (fs.existsSync(tmpPdf)) fs.unlinkSync(tmpPdf); } catch {}
    try { if (fs.existsSync(tmpProfile)) fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch {}
  }
});

// مراجعة شاملة لسجل العمليات (Audit Trail) مع بحث وفلاتر
route('GET', '/api/audit/full', 'admin', (ctx) => {
  const limit = Math.min(Math.max(parseInt(ctx.url.searchParams.get('limit') || '200', 10) || 200, 1), 2000);
  const page = Math.max(parseInt(ctx.url.searchParams.get('page') || '1', 10) || 1, 1);
  const offset = (page - 1) * limit;
  const q = (ctx.url.searchParams.get('q') || '').trim();
  const action = (ctx.url.searchParams.get('action') || '').trim();
  const dateFrom = (ctx.url.searchParams.get('from') || '').trim();
  const dateTo = (ctx.url.searchParams.get('to') || '').trim();

  const where = [];
  const params = [];
  if (q) {
    where.push('(details LIKE ? OR performed_by LIKE ? OR ip LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (action) {
    where.push('action = ?');
    params.push(action);
  }
  if (dateFrom) {
    where.push('created_at >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    where.push('created_at <= ?');
    params.push(dateTo + 'T23:59:59');
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs ${whereClause}`).get(...params).c;
  const logs = db.prepare(`SELECT * FROM audit_logs ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  const actions = db.prepare('SELECT DISTINCT action FROM audit_logs ORDER BY action').all().map((r) => r.action);

  return { ok: true, total, page, limit, pages: Math.ceil(total / limit), actions, logs };
});

// تحديد وتخصيص مسار البارتشن الآمن للنسخ الاحتياطي
route('POST', '/api/backup/set-dir', 'admin', (ctx) => {
  const customDir = cleanStr(ctx.body.dir || '', 300, 'مسار البارتشن');
  if (customDir && !fs.existsSync(customDir)) {
    try {
      fs.mkdirSync(customDir, { recursive: true });
    } catch (e) {
      throw new ApiError(400, 'تعذر إنشاء أو الوصول للمجلد: ' + e.message);
    }
  }
  setSetting('backup_external_dir', customDir);
  logAudit('update_backup_dir', ctx.session?.role || 'admin', `تحديث مسار البارتشن الآمن إلى: ${customDir || 'الافتراضي'}`);
  return { ok: true, message: 'تم حفظ وتحديث مسار البارتشن الآمن بنجاح' };
});

// حالة النسخ الاحتياطي وسجل النسخ الموجودة
route('GET', '/api/backup/status', 'admin', () => {
  const safeDir = getSafePartitionDir();
  let files = [];
  try {
    files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith('.db'))
      .map((f) => {
        const p = path.join(BACKUP_DIR, f);
        const st = fs.statSync(p);
        return {
          name: f,
          size: st.size,
          mtime: new Date(st.mtimeMs).toISOString(),
        };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime))
      .slice(0, 15);
  } catch {
    /* ignore */
  }

  const dbPath = path.join(DATA_DIR, 'gym.db');
  const currentDbSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;

  return {
    primaryDir: BACKUP_DIR,
    safeDir: safeDir,
    currentDbSize,
    recentBackups: files,
    lastBackup: files[0] || null,
  };
});

// استرجاع نسخة احتياطية من ملف مرفوع
route('POST', '/api/backup/restore', 'admin', (ctx) => {
  const buf = ctx.body._rawBuffer;
  if (!buf || buf.length < 100) {
    throw new ApiError(400, 'الملف المرفوع فارغ أو غير صحيح');
  }

  try {
    const { safetyCopy } = restoreDatabase(buf);
    logAudit(
      'backup_restored',
      ctx.session?.role || 'admin',
      `استرجاع قاعدة البيانات من ملف مرفوع (${Math.round(buf.length / 1024)} كيلوبايت)`
    );
    return {
      ok: true,
      message: 'تم استرجاع قاعدة البيانات بنجاح! تم حفظ البيانات وتحديث السيستم.',
    };
  } catch (err) {
    throw new ApiError(400, err.message || 'فشل استرجاع قاعدة البيانات');
  }
});

// استرجاع نسخة احتياطية سابقة من قائمة النسخ المحفوظة محلياً
route('POST', '/api/backup/restore-saved', 'admin', (ctx) => {
  const filename = cleanStr(ctx.body.filename || '', 200, 'اسم الملف');
  if (!filename || !filename.endsWith('.db') || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    throw new ApiError(400, 'اسم الملف غير صالح');
  }
  const filePath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filePath)) {
    throw new ApiError(404, 'ملف النسخة الاحتياطية غير موجود');
  }

  try {
    const { safetyCopy } = restoreDatabase(filePath);
    logAudit(
      'backup_restored',
      ctx.session?.role || 'admin',
      `استرجاع قاعدة البيانات من النسخة المحفوظة: ${filename}`
    );
    return {
      ok: true,
      message: `تم استرجاع النسخة الاحتياطية (${filename}) بنجاح وتحديث السيستم.`,
    };
  } catch (err) {
    throw new ApiError(400, err.message || 'فشل استرجاع قاعدة البيانات');
  }
});


// ---------- ميزة تجميد الاشتراك (Freeze Subscription) ----------
route('POST', '/api/members/:id/freeze', 'admin', (ctx) => {
  const id = intParam(ctx.params.id);
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!m) throw new ApiError(404, 'العضو غير موجود');

  const days = intParam(ctx.body.days);
  if (days < 1 || days > 365) throw new ApiError(400, 'عدد أيام التجميد يجب أن يكون بين 1 و 365');
  const reason = cleanStr(ctx.body.reason || 'طلب من العضو', 200, 'سبب التجميد');

  const today = todayStr();
  const sub = db
    .prepare(
      `SELECT * FROM subscriptions WHERE member_id = ? AND status = 'active'
       AND end_date >= ? ORDER BY end_date DESC LIMIT 1`
    )
    .get(id, today);

  if (!sub) throw new ApiError(400, 'لا يوجد اشتراك نشط وساري لهذا العضو لتجميده');

  const oldEnd = sub.end_date;
  const newEnd = addDays(oldEnd, days);

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE subscriptions SET end_date = ? WHERE id = ?').run(newEnd, sub.id);
    const freezeNote = `[تجميد ${days} يوم حتى ${newEnd} - ${reason}]`;
    const updatedNotes = m.notes ? `${m.notes}\n${freezeNote}` : freezeNote;
    db.prepare('UPDATE members SET notes = ? WHERE id = ?').run(updatedNotes, id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  logAudit(
    'subscription_frozen',
    ctx.session.role,
    `تجميد اشتراك العضو "${m.name}" (${m.code}) لمدة ${days} يوم (تاريخ الانتهاء الجديد: ${newEnd}). السبب: ${reason}`,
    ctx.ip
  );

  return {
    ok: true,
    message: `تم تجميد الاشتراك وتمديده ${days} يوماً حتى ${newEnd} بنجاح`,
    newEndDate: newEnd,
  };
});

// ---------- صحة وأداء قاعدة البيانات ----------
route('GET', '/api/database/health', 'admin', () => {
  const startTime = Date.now();
  const check = db.prepare('PRAGMA quick_check(1)').get();
  const integrity = check && (check.quick_check === 'ok' || check.integrity_check === 'ok') ? 'ok' : 'warning';

  const memberCount = db.prepare('SELECT COUNT(*) AS c FROM members').get().c;
  const subCount = db.prepare('SELECT COUNT(*) AS c FROM subscriptions').get().c;
  const attCount = db.prepare('SELECT COUNT(*) AS c FROM attendance').get().c;
  const planCount = db.prepare('SELECT COUNT(*) AS c FROM plans').get().c;
  const auditCount = db.prepare('SELECT COUNT(*) AS c FROM audit_logs').get().c;

  const dbPath = path.join(DATA_DIR, 'gym.db');
  const walPath = path.join(DATA_DIR, 'gym.db-wal');
  const dbSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
  const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;

  const queryDurationMs = Date.now() - startTime;

  return {
    integrity,
    status: integrity === 'ok' ? 'سليمة 100% ومحمية' : 'تحتاج فحص وصيانة',
    queryDurationMs,
    stats: {
      members: memberCount,
      subscriptions: subCount,
      attendance: attCount,
      plans: planCount,
      auditLogs: auditCount,
    },
    sizes: {
      dbSizeKb: Math.round(dbSize / 1024),
      walSizeKb: Math.round(walSize / 1024),
      totalMb: ((dbSize + walSize) / (1024 * 1024)).toFixed(2),
    },
  };
});

route('POST', '/api/database/optimize', 'admin', (ctx) => {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  db.exec('PRAGMA optimize;');
  logAudit('database_optimized', ctx.session.role, 'صيانة وضغط قاعدة البيانات وتحديث الفهارس', ctx.ip);
  return { ok: true, message: 'تم تحسين وصيانة قاعدة البيانات بنجاح' };
});

// ---------- سجل الحركات والتدقيق (Audit Logs) ----------
route('GET', '/api/audit-logs', 'admin', () => {
  return db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100').all();
});

// ---------- تصدير البيانات إلى Excel / CSV ----------
function toCsvRow(arr) {
  return arr
    .map((val) => {
      const s = String(val === undefined || val === null ? '' : val).replace(/"/g, '""');
      return `"${s}"`;
    })
    .join(',');
}

route('GET', '/api/export/members.csv', 'admin', () => {
  const today = todayStr();
  const members = db.prepare('SELECT * FROM members ORDER BY id ASC').all();
  const headers = ['كود العضو', 'الاسم', 'الموبايل', 'الحالة', 'الباقة الحالية', 'تاريخ الانتهاء', 'الأيام المتبقية', 'تاريخ التسجيل', 'ملاحظات'];
  const rows = [toCsvRow(headers)];

  for (const m of members) {
    const sub = subscriptionState(m.id, today);
    const stateLabel = !m.active ? 'موقوف' : sub.state === 'active' ? 'ساري' : sub.state === 'expiring' ? 'أوشك على الانتهاء' : sub.state === 'expired' ? 'منتهي' : 'بدون اشتراك';
    rows.push(
      toCsvRow([
        m.code,
        m.name,
        m.phone,
        stateLabel,
        sub.plan_name || '-',
        sub.end_date || '-',
        sub.days_left !== null ? sub.days_left : '-',
        m.created_at ? m.created_at.slice(0, 10) : '-',
        m.notes || '',
      ])
    );
  }

  const csvContent = '\uFEFF' + rows.join('\r\n');
  const filename = `gym-members-${today}.csv`;

  logAudit('export_members_csv', 'admin', 'تصدير بيانات الأعضاء إلى ملف Excel/CSV');

  return {
    raw: Buffer.from(csvContent, 'utf8'),
    type: 'text/csv; charset=utf-8',
    headers: {
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  };
});

// ---------- الملفات الثابتة ----------
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

// الملفات المتاحة للعموم (العضو) بدون تسجيل دخول — كارنيه + تسجيل دخول فقط
const CARD_PUBLIC_FILES = new Set([
  'card.html',   // صفحة الكارنيه (للمشترك)
  'card.js',     // سكريبت الكارنيه
  'common.js',   // مشترك بين الصفحات
  'style.css',   // التنسيق
  'login.html',  // صفحة تسجيل الدخول (لازم تكون متاحة)
  'login.js',    // سكريبت تسجيل الدخول
  'hulkgym-logo.jpg', // شعار الجيم وخلفية الكارنيه
]);

function serveStatic(req, res, pathname, session) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let file;
  try {
    file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(rel)));
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }

  // الملف في قائمة الكارنيه العامة؟ متاح للجميع
  const basename = path.basename(file);
  const isPublicCardFile = CARD_PUBLIC_FILES.has(basename);

  if (!isPublicCardFile && !session) {
    // المستخدم لا يملك جلسة صالحة ويحاول الوصول لصفحة مقيدة
    res.writeHead(302, { Location: '/login.html' }).end();
    return;
  }

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('غير موجود');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(buf);
  });
}

// ---------- السيرفر ----------
function readBody(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new ApiError(413, 'الطلب كبير جدًا'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const rawBuf = Buffer.concat(chunks);
      const ct = (req.headers['content-type'] || '').toLowerCase();
      if (
        ct.includes('application/octet-stream') ||
        ct.includes('application/x-sqlite3') ||
        ct.includes('multipart/form-data')
      ) {
        return resolve({ _rawBuffer: rawBuf });
      }
      try {
        const v = JSON.parse(rawBuf.toString('utf8'));
        resolve(v && typeof v === 'object' ? v : {});
      } catch {
        resolve({ _rawBuffer: rawBuf });
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self)');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; frame-ancestors 'none'"
  );
  try {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new ApiError(405, 'غير مسموح');
      // نحسب الجلسة هنا عشان نمررها لـ serveStatic لتحديد الصلاحية
      const pageSession = verify(parseCookies(req).sid);
      return serveStatic(req, res, url.pathname, pageSession);
    }
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) throw new ApiError(404, 'غير موجود');
    const m = url.pathname.match(r.re);
    const params = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));

    let session = null;
    if (r.role) {
      session = verify(parseCookies(req).sid);
      if (!session) throw new ApiError(401, 'سجّل دخول الأول');
      if (r.role === 'admin' && session.role !== 'admin') throw new ApiError(403, 'الصلاحية للمدير فقط');
    }
    const isRestore = url.pathname === '/api/backup/restore';
    const bodyLimit = isRestore ? 50 * 1024 * 1024 : 100 * 1024;
    const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req, bodyLimit);
    const ip = getClientIp(req);
    const out = await r.handler({ req, url, params, body, session, ip });
    if (out && out.raw !== undefined) {
      res.writeHead(200, {
        'Content-Type': out.type,
        'Cache-Control': 'no-store',
        ...(out.headers || {}),
      });
      return res.end(out.raw);
    }
    if (out && out.body !== undefined) return sendJson(res, 200, out.body, out.headers);
    sendJson(res, 200, out);
  } catch (e) {
    if (e instanceof ApiError) return sendJson(res, e.status, { error: e.message });
    console.error(e);
    sendJson(res, 500, { error: 'حصل خطأ في السيرفر' });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`السيستم شغال على http://localhost:${PORT}`);
    if (isDefaultPassword(getStaffPassword(), 'staff123')) {
      console.log('ملاحظة: كلمة مرور الموظف الافتراضية هي staff123 (يمكن تغييرها من شاشة الإعدادات).');
    }
    if (isDefaultPassword(getAdminPassword(), 'admin123')) {
      console.log('ملاحظة: كلمة مرور المدير الافتراضية هي admin123 (يمكن تغييرها من شاشة الإعدادات).');
    }
    // تشغيل النسخ الاحتياطي التلقائي عند بدء السيرفر وفحصه دورياً
    try {
      checkAndRunAutoBackup();
      setInterval(checkAndRunAutoBackup, 30 * 60 * 1000); // فحص وتحديث تلقائي كل 30 دقيقة
    } catch (e) {
      console.error('[Backup Init Error]:', e.message);
    }
  });
}

module.exports = { server, doCheckin };


