'use strict';
/**
 * ====================================================
 * HULK GYM - نظام النسخ الاحتياطي الشامل والمتكامل
 * ====================================================
 * يحفظ كل شيء: أعضاء، اشتراكات، حضور، مصروفات،
 * موظفين، برايفت، سجلات المراجعة، الإعدادات
 * + يصدر تقرير Excel/CSV كامل
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');

fs.mkdirSync(BACKUP_DIR, { recursive: true });
fs.mkdirSync(REPORTS_DIR, { recursive: true });

const now = new Date();
const dateStr = now.toLocaleDateString('en-CA'); // YYYY-MM-DD
const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '-'); // HH-MM-SS
const stamp = `${dateStr}_${timeStr}`;

console.log(`\n🏋️ HULK GYM - بدء النسخ الاحتياطي الشامل: ${stamp}`);
console.log('='.repeat(55));

// ============ 1. نسخة قاعدة البيانات الكاملة ============
const srcDb = path.join(DATA_DIR, 'gym.db');
const backupFile = path.join(BACKUP_DIR, `gym-full-backup-${stamp}.db`);
const aBackupDir = 'A:\\gym-backups';

try {
  // checkpoint WAL أولاً
  const tmpDb = new DatabaseSync(srcDb);
  tmpDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  tmpDb.close();

  fs.copyFileSync(srcDb, backupFile);
  console.log(`✅ قاعدة البيانات: ${backupFile}`);

  // نسخة على A: أيضاً
  try {
    if (!fs.existsSync(aBackupDir)) fs.mkdirSync(aBackupDir, { recursive: true });
    fs.copyFileSync(srcDb, path.join(aBackupDir, `gym-full-backup-${stamp}.db`));
    console.log(`✅ نسخة A:\\gym-backups محفوظة`);
  } catch (e) { console.warn('⚠️ فشل نسخ A:', e.message); }
} catch (e) {
  console.error('❌ فشل نسخ قاعدة البيانات:', e.message);
  process.exit(1);
}

// ============ 2. تصدير تقرير CSV شامل ============
const db = new DatabaseSync(srcDb);

function toCsv(rows, columns) {
  if (!rows.length) return columns.join(',') + '\n(لا توجد بيانات)\n';
  const header = columns.join(',');
  const body = rows.map(r =>
    columns.map(c => {
      const v = r[c] ?? '';
      const s = String(v).replace(/"/g, '""');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
    }).join(',')
  ).join('\n');
  return header + '\n' + body + '\n';
}

const sections = [];

// ---- الأعضاء ----
const members = db.prepare(`
  SELECT id, code, name, phone, age, notes,
    CASE active WHEN 1 THEN 'نشط' WHEN -1 THEN 'مؤرشف' ELSE 'غير نشط' END AS الحالة,
    created_at
  FROM members ORDER BY id
`).all();
sections.push({ title: 'الأعضاء', data: toCsv(members, ['id','code','name','phone','age','notes','الحالة','created_at']) });
console.log(`📋 الأعضاء: ${members.length} سجل`);

// ---- الاشتراكات ----
const subscriptions = db.prepare(`
  SELECT s.id, m.name AS member_name, m.code, s.plan_name,
    s.start_date, s.end_date, s.price,
    CASE s.status WHEN 'active' THEN 'نشط' WHEN 'cancelled' THEN 'ملغي' ELSE s.status END AS الحالة,
    s.created_at
  FROM subscriptions s
  JOIN members m ON m.id = s.member_id
  ORDER BY s.id
`).all();
sections.push({ title: 'الاشتراكات', data: toCsv(subscriptions, ['id','member_name','code','plan_name','start_date','end_date','price','الحالة','created_at']) });
console.log(`📋 الاشتراكات: ${subscriptions.length} سجل`);

// ---- سجلات الحضور ----
const hasArchivedCol = db.prepare(`PRAGMA table_info(attendance)`).all().some(c => c.name === 'archived');
const attendance = db.prepare(`
  SELECT a.id, m.name AS member_name, m.code, a.day, a.checkin_at,
    CASE
      ${hasArchivedCol ? "WHEN COALESCE(a.archived, 0) = 1 THEN 'مؤرشف'" : ''}
      WHEN a.result = 'ok' THEN 'دخول مقبول'
      WHEN a.result = 'denied' THEN 'مرفوض'
      ELSE a.result
    END AS النتيجة,
    a.reason
  FROM attendance a
  JOIN members m ON m.id = a.member_id
  ORDER BY a.id
`).all();
sections.push({ title: 'سجلات_الحضور', data: toCsv(attendance, ['id','member_name','code','day','checkin_at','النتيجة','reason']) });
console.log(`📋 سجلات الحضور: ${attendance.length} سجل`);

// ---- المصروفات ----
const expenses = db.prepare(`
  SELECT id, title, category, amount, expense_date, notes, recorded_by, created_at
  FROM expenses ORDER BY expense_date DESC, id DESC
`).all();
sections.push({ title: 'المصروفات', data: toCsv(expenses, ['id','title','category','amount','expense_date','notes','recorded_by','created_at']) });
const totalExpenses = expenses.reduce((s, r) => s + (Number(r.amount) || 0), 0);
console.log(`📋 المصروفات: ${expenses.length} سجل | الإجمالي: ${totalExpenses.toFixed(2)} ج.م`);

// ---- الموظفين ----
const employees = db.prepare(`
  SELECT id, name, role, phone, salary, start_date, notes,
    CASE active WHEN 1 THEN 'نشط' ELSE 'غير نشط' END AS الحالة,
    created_at
  FROM employees ORDER BY id
`).all();
sections.push({ title: 'الموظفين', data: toCsv(employees, ['id','name','role','phone','salary','start_date','notes','الحالة','created_at']) });
console.log(`📋 الموظفين: ${employees.length} سجل`);

// ---- التدريب الخاص (برايفت) ----
const privates = db.prepare(`
  SELECT pt.id, m.name AS member_name, m.code, pt.trainer_name,
    pt.package_name, pt.start_date, pt.end_date,
    pt.total_sessions, pt.attended_sessions, pt.price, pt.paid,
    pt.status, pt.notes, pt.created_at
  FROM private_trainings pt
  JOIN members m ON m.id = pt.member_id
  ORDER BY pt.id
`).all();
sections.push({ title: 'التدريب_الخاص', data: toCsv(privates, ['id','member_name','code','trainer_name','package_name','start_date','end_date','total_sessions','attended_sessions','price','paid','status','notes','created_at']) });
console.log(`📋 التدريب الخاص: ${privates.length} سجل`);

// ---- سجل المراجعة (Audit Log) ----
const auditLogs = db.prepare(`
  SELECT id, action, performed_by, details, ip, created_at
  FROM audit_logs ORDER BY id DESC LIMIT 5000
`).all();
sections.push({ title: 'سجل_المراجعة', data: toCsv(auditLogs, ['id','action','performed_by','details','ip','created_at']) });
console.log(`📋 سجل المراجعة: ${auditLogs.length} سجل`);

// ---- الإعدادات ----
const settings = db.prepare(`SELECT key, value FROM settings ORDER BY key`).all();
sections.push({ title: 'الإعدادات', data: toCsv(settings, ['key','value']) });

// ---- ملخص مالي ----
const totalRevenue = db.prepare(`
  SELECT COALESCE(SUM(price),0) AS t FROM subscriptions WHERE status='active'
`).get().t;
const totalPtRevenue = db.prepare(`
  SELECT COALESCE(SUM(paid),0) AS t FROM private_trainings
`).get().t;
const activeMembers = db.prepare(`SELECT COUNT(*) AS c FROM members WHERE active=1`).get().c;
const totalSalaries = db.prepare(`SELECT COALESCE(SUM(salary),0) AS t FROM employees WHERE active=1`).get().t;

const summary = `ملخص مالي شامل - ${dateStr}
,
البند,القيمة
إجمالي أعضاء نشطين,${activeMembers}
إجمالي إيرادات الاشتراكات,${totalRevenue.toFixed(2)} ج.م
إجمالي إيرادات البرايفت,${totalPtRevenue.toFixed(2)} ج.م
إجمالي الإيرادات,${(totalRevenue + totalPtRevenue).toFixed(2)} ج.م
إجمالي المصروفات,${totalExpenses.toFixed(2)} ج.م
إجمالي الرواتب,${totalSalaries.toFixed(2)} ج.م
صافي الربح,${(totalRevenue + totalPtRevenue - totalExpenses - totalSalaries).toFixed(2)} ج.م
`;
sections.push({ title: 'الملخص_المالي', data: summary });

db.close();

// ============ 3. كتابة ملف التقرير الشامل ============
const reportFile = path.join(REPORTS_DIR, `gym-report-${stamp}.csv`);
let reportContent = `\uFEFF`; // BOM for Arabic Excel
reportContent += `تقرير شامل - نادي Hulk Gym\n`;
reportContent += `تاريخ التقرير: ${dateStr} | الوقت: ${now.toTimeString().slice(0,8)}\n\n`;

for (const section of sections) {
  reportContent += `\n========== ${section.title} ==========\n`;
  reportContent += section.data;
  reportContent += '\n';
}

fs.writeFileSync(reportFile, reportContent, 'utf8');
console.log(`\n📊 تقرير CSV الشامل: ${reportFile}`);

// نسخة التقرير على A: أيضاً
try {
  const aRepDir = path.join(aBackupDir, 'reports');
  if (!fs.existsSync(aRepDir)) fs.mkdirSync(aRepDir, { recursive: true });
  fs.copyFileSync(reportFile, path.join(aRepDir, `gym-report-${stamp}.csv`));
  console.log(`✅ نسخة التقرير على A:\\gym-backups\\reports`);
} catch (e) {}

// ============ 4. تنظيف النسخ القديمة (أحتفظ بـ 90 نسخة) ============
function cleanOld(dir, keepCount) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.db') || f.endsWith('.csv')).sort().reverse();
  files.slice(keepCount).forEach(f => { try { fs.unlinkSync(path.join(dir, f)); } catch {} });
}
cleanOld(BACKUP_DIR, 90);
cleanOld(REPORTS_DIR, 90);

console.log('\n' + '='.repeat(55));
console.log('✅ اكتملت عملية النسخ الاحتياطي الشامل بنجاح!');
console.log(`📁 مجلد النسخ: ${BACKUP_DIR}`);
console.log(`📊 مجلد التقارير: ${REPORTS_DIR}`);
console.log('='.repeat(55) + '\n');
