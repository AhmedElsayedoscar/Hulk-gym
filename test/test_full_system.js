'use strict';
const fs = require('fs');

const BASE_URL = 'http://localhost:3000';

async function runTests() {
  console.log('🚀 Starting Full System End-to-End Audit & Verification...\n');
  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log('  ✅ ' + message);
      passed++;
    } else {
      console.error('  ❌ FAIL: ' + message);
      failed++;
    }
  }

  // 1. Static Pages
  console.log('--- 1. Testing Static HTML Pages & Assets ---');
  const staticPaths = ['/', '/login.html', '/scan.html', '/card.html', '/style.css', '/app.js', '/common.js'];
  for (const p of staticPaths) {
    const res = await fetch(BASE_URL + p);
    assert(res.status === 200, `Page ${p} returned HTTP 200`);
  }

  // 2. Authentication
  console.log('\n--- 2. Testing Authentication ---');
  let loginRes = await fetch(BASE_URL + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrongPassword' })
  });
  assert(loginRes.status === 401, 'Wrong password correctly rejected (401)');

  loginRes = await fetch(BASE_URL + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'admin123' })
  });
  assert(loginRes.status === 200, 'Admin login succeeded (200)');
  const adminCookie = loginRes.headers.get('set-cookie');
  const adminHeaders = { 'Cookie': adminCookie, 'Content-Type': 'application/json' };

  // Check /api/me
  const meRes = await fetch(BASE_URL + '/api/me', { headers: adminHeaders });
  const meData = await meRes.json();
  assert(meData.role === 'admin', 'Current session is admin');

  // 3. Stats & Dashboard
  console.log('\n--- 3. Testing Stats & Dashboard ---');
  const statsRes = await fetch(BASE_URL + '/api/stats', { headers: adminHeaders });
  const stats = await statsRes.json();
  assert(statsRes.status === 200 && typeof stats.active === 'number', 'Stats endpoint returned valid counters');
  console.log(`     Active Members: ${stats.active}, Expiring: ${stats.expiring}, Total: ${stats.totalMembers}`);

  // 4. Plans (Packages)
  console.log('\n--- 4. Testing Plans Management ---');
  const plansRes = await fetch(BASE_URL + '/api/plans', { headers: adminHeaders });
  const plans = await plansRes.json();
  assert(Array.isArray(plans) && plans.length >= 4, `Plans loaded successfully (${plans.length} plans)`);

  // Create new test plan
  const newPlanRes = await fetch(BASE_URL + '/api/plans', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ name: 'باقة تجريبية للتحقق', duration_days: 15, price: 150 })
  });
  const createdPlan = await newPlanRes.json();
  assert(newPlanRes.status === 200 && createdPlan.id, 'New plan created successfully');

  // Update plan
  const updatePlanRes = await fetch(BASE_URL + `/api/plans/${createdPlan.id}`, {
    method: 'PUT',
    headers: adminHeaders,
    body: JSON.stringify({ name: 'باقة تجريبية معدلة', duration_days: 20, price: 200, active: 0 })
  });
  assert(updatePlanRes.status === 200, 'Plan updated successfully');

  // 5. Employees Management
  console.log('\n--- 5. Testing Employees Management ---');
  const empRes = await fetch(BASE_URL + '/api/employees', { headers: adminHeaders });
  const empData = await empRes.json();
  assert(empRes.status === 200 && Array.isArray(empData.employees) && empData.employees.length >= 2, `Employees listed (${empData.employees.length} employees)`);

  // Add temporary test employee
  const addEmpRes = await fetch(BASE_URL + '/api/employees', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ name: 'موظف فحص تجريبي', role: 'استقبال', phone: '01122334455', salary: 2000, start_date: '2026-11-22' })
  });
  const addedEmp = await addEmpRes.json();
  assert(addEmpRes.status === 200 && addedEmp.id, 'Employee added successfully');

  // Delete test employee
  const delEmpRes = await fetch(BASE_URL + `/api/employees/${addedEmp.id}`, {
    method: 'DELETE',
    headers: adminHeaders
  });
  assert(delEmpRes.status === 200, 'Employee deleted successfully');

  // 6. Members Management
  console.log('\n--- 6. Testing Members Management ---');
  const membersRes = await fetch(BASE_URL + '/api/members', { headers: adminHeaders });
  const members = await membersRes.json();
  assert(Array.isArray(members) && members.length >= 2, `Members loaded (${members.length} members)`);

  // Add new test member
  const addMemberRes = await fetch(BASE_URL + '/api/members', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ name: 'عضو تجريبي للاختبار', phone: '01099887766', plan_id: plans[0].id, price: 300 })
  });
  const addedMember = await addMemberRes.json();
  assert(addMemberRes.status === 200 && addedMember.id, `Test member created with code: ${addedMember.code}`);

  const testMemberId = addedMember.id;
  const testMemberCode = addedMember.code;

  // Search members
  const searchRes = await fetch(BASE_URL + `/api/members?q=${encodeURIComponent(testMemberCode)}`, { headers: adminHeaders });
  const searchResults = await searchRes.json();
  assert(searchResults.length > 0 && searchResults[0].code === testMemberCode, 'Member search by code working');

  // Member details
  const detailRes = await fetch(BASE_URL + `/api/members/${testMemberId}`, { headers: adminHeaders });
  const detail = await detailRes.json();
  assert(detail.member?.name === 'عضو تجريبي للاختبار' && detail.subscriptions?.length > 0, 'Member details and subscriptions loaded');

  // 7. Check-in & Attendance System
  console.log('\n--- 7. Testing Access Control & Check-in ---');
  let checkinRes = await fetch(BASE_URL + '/api/checkin', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ code: testMemberCode })
  });
  let checkin = await checkinRes.json();
  assert(checkin.ok === true, `Check-in succeeded: ${checkin.message}`);

  // Duplicate check-in within window -> should report duplicate or ok
  checkinRes = await fetch(BASE_URL + '/api/checkin', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ code: testMemberCode })
  });
  checkin = await checkinRes.json();
  assert(checkin.duplicate || checkin.ok === true, 'Duplicate check-in handled correctly');

  // Attendance list
  const attRes = await fetch(BASE_URL + '/api/attendance', { headers: adminHeaders });
  const attList = await attRes.json();
  assert(Array.isArray(attList) && attList.length > 0, `Attendance records retrieved (${attList.length} logs)`);

  // QR Code Generation
  const qrRes = await fetch(BASE_URL + `/api/members/${testMemberId}/qr.svg`, { headers: adminHeaders });
  assert(qrRes.status === 200 && qrRes.headers.get('content-type')?.includes('svg'), 'Member QR Code SVG generated successfully');

  // Public card view
  const cardRes = await fetch(BASE_URL + `/api/public/card/${testMemberCode}`);
  const cardData = await cardRes.json();
  assert(cardData.name === 'عضو تجريبي للاختبار', 'Public member card data retrieved successfully');

  // 8. Subscription Freeze
  console.log('\n--- 8. Testing Subscription Freeze & Management ---');
  const freezeRes = await fetch(BASE_URL + `/api/members/${testMemberId}/freeze`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ days: 7, reason: 'سفر لمدة أسبوع' })
  });
  const freezeData = await freezeRes.json();
  assert(freezeRes.status === 200 && freezeData.ok, 'Subscription frozen for 7 days successfully');

  // 9. Private Trainings (برايفت)
  console.log('\n--- 9. Testing Private Trainings ---');
  const ptRes = await fetch(BASE_URL + '/api/private-trainings', { headers: adminHeaders });
  const ptData = await ptRes.json();
  assert(Array.isArray(ptData.privateTrainings) && ptData.privateTrainings.length > 0, `Private trainings listed (${ptData.privateTrainings.length} sessions)`);

  // 10. Reports
  console.log('\n--- 10. Testing Daily Report ---');
  const reportRes = await fetch(BASE_URL + '/api/reports/daily', { headers: adminHeaders });
  const report = await reportRes.json();
  assert(reportRes.status === 200 && typeof report.totalRevenue === 'number', 'Daily report computed correctly');
  console.log(`      Today Revenue: ${report.totalRevenue} EGP, Attendance count: ${report.attendanceCount}`);

  // 11. Reminders
  console.log('\n--- 11. Testing Reminders ---');
  const remRes = await fetch(BASE_URL + '/api/reminders/expiring', { headers: adminHeaders });
  const remData = await remRes.json();
  assert(Array.isArray(remData.list), `Expiring reminders query functioning (${remData.list.length} expiring soon)`);

  // 12. Settings & Audit Logs
  console.log('\n--- 12. Testing Settings & Audit Logs ---');
  const settingsRes = await fetch(BASE_URL + '/api/settings', { headers: adminHeaders });
  const settings = await settingsRes.json();
  assert(settingsRes.status === 200 && settings.remind_days, 'Settings retrieved correctly');

  const auditRes = await fetch(BASE_URL + '/api/audit-logs', { headers: adminHeaders });
  const auditLogs = await auditRes.json();
  assert(Array.isArray(auditLogs) && auditLogs.length > 0, `Audit logs active (${auditLogs.length} events logged)`);

  // 13. Database Health & Optimization
  console.log('\n--- 13. Testing Database Health & Optimization ---');
  const healthRes = await fetch(BASE_URL + '/api/database/health', { headers: adminHeaders });
  const health = await healthRes.json();
  assert(health.integrity === 'ok', `Database health status: ${health.status} (integrity ok)`);

  const optRes = await fetch(BASE_URL + '/api/database/optimize', { method: 'POST', headers: adminHeaders });
  const optData = await optRes.json();
  assert(optRes.status === 200 && optData.ok, 'Database WAL checkpoint & vacuum optimize succeeded');

  // 14. Export CSV
  console.log('\n--- 14. Testing CSV Export ---');
  const csvRes = await fetch(BASE_URL + '/api/export/members.csv', { headers: adminHeaders });
  const csvText = await csvRes.text();
  assert(csvRes.status === 200 && csvText.includes('كود العضو'), 'Members CSV exported with correct Arabic headers');

  // 15. Backup System & Daily Auto-backup
  console.log('\n--- 15. Testing Backup System ---');
  const backupStatusRes = await fetch(BASE_URL + '/api/backup/status', { headers: adminHeaders });
  const bStatus = await backupStatusRes.json();
  assert(backupStatusRes.status === 200 && bStatus.recentBackups?.length > 0, 'Backup status functioning');
  assert(bStatus.desktopDir && fs.existsSync(bStatus.desktopDir), `Desktop backup directory verified: ${bStatus.desktopDir}`);

  // Clean up: delete test member
  await fetch(BASE_URL + `/api/members/${testMemberId}`, { method: 'DELETE', headers: adminHeaders });
  console.log('  🧹 Cleaned up temporary test member.');

  console.log(`\n========================================`);
  console.log(`🏁 Audit Results: ${passed} Passed, ${failed} Failed`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((e) => {
  console.error('Fatal Test Error:', e);
  process.exit(1);
});
