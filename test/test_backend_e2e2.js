const { spawn } = require('child_process');
const { chromium } = require('playwright');

function startServer() {
  return spawn('node', ['src/server.js'], { cwd: '/home/claude/loadmasr-backend' });
}
async function waitForServer() {
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 300));
    try { const res = await fetch('http://localhost:4000/api/health'); if (res.ok) return true; } catch(e) {}
  }
  return false;
}

(async () => {
  const results = [];
  const check = (label, cond) => { results.push({label, pass: !!cond}); console.log((cond?'✅':'❌'), label); };

  let server = startServer();
  try {
    check('Server started', await waitForServer());

    const browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));

    // ---- Real shipper wizard signup, WITHOUT a pioneer code ----
    await page.goto('http://localhost:4000/');
    await page.click('#btnModeShipper').catch(()=>{});
    await page.click('#shipperTabSignup');
    await page.waitForTimeout(200);
    await page.click('#wizNextBtn'); // skip code
    await page.waitForTimeout(150);
    const uniqueEmail = `e2e_shipper_${Date.now()}@test.eg`;
    await page.fill('#wizCompanyName', 'E2E Test Shippers Co');
    await page.fill('#wizContactPerson', 'Test Person');
    await page.fill('#wizWhatsapp', '201099998888');
    await page.fill('#wizEmail', uniqueEmail);
    await page.fill('#wizPassword', 'testpass123');
    await page.fill('#wizTrn', '111222333');
    await page.fill('#wizSijill', 'CR-11223');
    await page.click('#wizNextBtn');
    await page.waitForTimeout(200);
    await page.click('#wizSubmitBtn');
    await page.waitForTimeout(1200);
    const step4Title = await page.$eval('.modal-title', el => el.textContent).catch(()=>'MISSING');
    check('Real shipper signup (no pioneer code) reaches account-created step', step4Title.includes('Account created'));

    // Verify it's genuinely in the DB
    const dbUsers = await fetch('http://localhost:4000/api/admin/queue?status=PENDING', {
      headers: { Authorization: 'Bearer ' + await (async()=>{
        const r = await fetch('http://localhost:4000/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email:'admin@loadmasr.eg', password:'admin-seed-password'})});
        return (await r.json()).token;
      })() }
    }).then(r=>r.json());
    check('New shipper genuinely exists in the real DB, PENDING verification', dbUsers.users.some(u=>u.email===uniqueEmail));

    // ---- Pioneer code path ----
    await page.click('#wizDoneBtn').catch(()=>{});
    await page.waitForTimeout(200);
    await page.click('.plan-card .btn-primary >> nth=0').catch(()=>{});
    await page.waitForTimeout(300);

    const pioneerStatusBefore = await fetch('http://localhost:4000/api/pioneer-status').then(r=>r.json());
    check('Real pioneer-slot counter is queryable and starts with slots available', pioneerStatusBefore.slotsRemaining > 0);

    // ---- Admin approves the pending shipper ----
    const adminToken = (await (await fetch('http://localhost:4000/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email:'admin@loadmasr.eg', password:'admin-seed-password'})})).json()).token;
    const pendingUser = dbUsers.users.find(u=>u.email===uniqueEmail);
    const approveRes = await fetch(`http://localhost:4000/api/admin/users/${pendingUser.id}/approve`, {method:'POST', headers:{Authorization:'Bearer '+adminToken}}).then(r=>r.json());
    check('Admin approve endpoint genuinely updates verification_status', approveRes.user.verification_status === 'APPROVED');

    console.log('Page errors:', pageErrors.join('\n') || '(none)');
    await browser.close();
  } finally {
    server.kill();
  }

  // ---- THE ULTIMATE TEST: kill server, restart it, verify data survived ----
  await new Promise(r => setTimeout(r, 500));
  server = startServer();
  check('Server restarted', await waitForServer());
  const afterRestart = await fetch('http://localhost:4000/api/admin/queue?status=APPROVED', {
    headers: { Authorization: 'Bearer ' + await (async()=>{
      const r = await fetch('http://localhost:4000/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email:'admin@loadmasr.eg', password:'admin-seed-password'})});
      return (await r.json()).token;
    })() }
  }).then(r=>r.json());
  check('Approved account SURVIVED a full server restart (real persistence, not memory)', afterRestart.users.some(u=>u.email.includes('e2e_shipper_')));
  server.kill();

  const failed = results.filter(r=>!r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
})();
