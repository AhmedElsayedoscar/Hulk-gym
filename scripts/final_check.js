const http = require('http');

function req(method, path, body, token) {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'localhost', port: 3000, path, method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
    };
    const r = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', e => resolve({ status: 0, body: e.message }));
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function main() {
  const checks = [];
  
  // 1. Login admin
  let r = await req('POST', '/api/login', { username: 'admin', password: 'admin123' });
  const adminToken = JSON.parse(r.body).token;
  checks.push({ name: 'Login Admin', ok: r.status === 200 && !!adminToken, detail: `status=${r.status}` });

  // 2. Login staff
  r = await req('POST', '/api/login', { username: 'staff', password: 'staff123' });
  const staffToken = JSON.parse(r.body).token;
  checks.push({ name: 'Login Staff', ok: r.status === 200 && !!staffToken, detail: `status=${r.status}` });

  // 3. Wrong password
  r = await req('POST', '/api/login', { username: 'admin', password: 'wrong' });
  checks.push({ name: 'Wrong Password Rejected', ok: r.status === 401, detail: `status=${r.status}` });

  // 4. Members list
  r = await req('GET', '/api/members', null, adminToken);
  const members = JSON.parse(r.body);
  checks.push({ name: 'Members List Empty (clean DB)', ok: r.status === 200 && members.length === 0, detail: `count=${members.length}` });

  // 5. Plans
  r = await req('GET', '/api/plans', null, adminToken);
  const plans = JSON.parse(r.body);
  checks.push({ name: 'Plans Loaded', ok: r.status === 200 && plans.length >= 4, detail: `count=${plans.length}: ${plans.map(p=>p.name+'('+p.price+')').join(', ')}` });

  // 6. Add member
  r = await req('POST', '/api/members', { name: 'عميل تجريبي', phone: '01000000000', code: 'TEST01' }, adminToken);
  const newMember = JSON.parse(r.body);
  checks.push({ name: 'Add Member', ok: r.status === 201 && newMember.id > 0, detail: `id=${newMember.id}` });

  // 7. Add member duplicate code
  r = await req('POST', '/api/members', { name: 'تكرار', phone: '01111111111', code: 'TEST01' }, adminToken);
  checks.push({ name: 'Duplicate Code Rejected', ok: r.status === 409 || r.status === 400, detail: `status=${r.status}` });

  // 8. Subscribe member
  if (newMember.id) {
    r = await req('POST', `/api/members/${newMember.id}/subscribe`, { plan_id: plans[0].id, start_date: new Date().toISOString().slice(0,10) }, adminToken);
    checks.push({ name: 'Subscribe Member', ok: r.status === 200 || r.status === 201, detail: `status=${r.status}` });
  }

  // 9. Barcode scan (checkin)
  r = await req('POST', '/api/scan', { code: 'TEST01' }, adminToken);
  checks.push({ name: 'Barcode Scan', ok: r.status === 200 || r.status === 201, detail: `status=${r.status} body=${r.body.slice(0,60)}` });

  // 10. Settings page
  r = await req('GET', '/api/settings', null, adminToken);
  checks.push({ name: 'Settings API', ok: r.status === 200, detail: `status=${r.status}` });

  // 11. DB Health
  r = await req('GET', '/api/database/health', null, adminToken);
  const health = JSON.parse(r.body);
  checks.push({ name: 'DB Health', ok: r.status === 200, detail: JSON.stringify(health).slice(0,100) });

  // 12. Reminders
  r = await req('GET', '/api/reminders', null, adminToken);
  checks.push({ name: 'Reminders API', ok: r.status === 200, detail: `status=${r.status}` });

  // 13. Attendance
  r = await req('GET', '/api/attendance', null, adminToken);
  checks.push({ name: 'Attendance API', ok: r.status === 200, detail: `status=${r.status}` });

  // 14. Freeze - staff should be DENIED
  if (newMember.id) {
    r = await req('POST', `/api/members/${newMember.id}/freeze`, { days: 7 }, staffToken);
    checks.push({ name: 'Freeze Blocked for Staff', ok: r.status === 403, detail: `status=${r.status}` });

    // 15. Freeze - admin should PASS
    r = await req('POST', `/api/members/${newMember.id}/freeze`, { days: 7 }, adminToken);
    checks.push({ name: 'Freeze Allowed for Admin', ok: r.status === 200 || r.status === 201, detail: `status=${r.status} body=${r.body.slice(0,60)}` });
  }

  // 16. Audit logs
  r = await req('GET', '/api/audit-logs', null, adminToken);
  checks.push({ name: 'Audit Logs', ok: r.status === 200, detail: `status=${r.status}` });

  // 17. Unauthorized access
  r = await req('GET', '/api/members', null, null);
  checks.push({ name: 'Unauthorized Blocked', ok: r.status === 401, detail: `status=${r.status}` });

  // 18. Export CSV (admin)
  r = await req('GET', '/api/export/members.csv', null, adminToken);
  checks.push({ name: 'CSV Export Admin', ok: r.status === 200, detail: `status=${r.status}` });

  // 19. Export CSV (staff - should be blocked)
  r = await req('GET', '/api/export/members.csv', null, staffToken);
  checks.push({ name: 'CSV Export Staff Blocked', ok: r.status === 403, detail: `status=${r.status}` });

  // Cleanup test member
  if (newMember.id) {
    await req('DELETE', `/api/members/${newMember.id}`, null, adminToken);
  }

  // Print results
  const passed = checks.filter(c => c.ok).length;
  const failed = checks.filter(c => !c.ok).length;
  console.log(`\n========== FINAL SYSTEM CHECK ==========`);
  checks.forEach(c => {
    console.log(`${c.ok ? '✅' : '❌'} ${c.name.padEnd(35)} ${c.detail}`);
  });
  console.log(`========================================`);
  console.log(`PASSED: ${passed}/${checks.length} | FAILED: ${failed}`);
  if (failed > 0) {
    console.log('\n⚠️  ISSUES FOUND - fix before delivery!');
  } else {
    console.log('\n🎉 ALL CHECKS PASSED - Ready for delivery!');
  }
}

main().catch(console.error);
