const { spawn } = require('child_process');
const { chromium } = require('playwright');

(async () => {
  const server = spawn('node', ['src/server.js'], { cwd: '/home/claude/loadmasr-backend', env: { ...process.env, SEED_DEMO_ACCOUNTS: 'true' } });
  const results = [];
  const check = (label, cond) => { results.push({label, pass: !!cond}); console.log((cond?'✅':'❌'), label); };
  try {
    let ready = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 300));
      try { const res = await fetch('http://localhost:4000/api/health'); if (res.ok) { ready = true; break; } } catch(e) {}
    }
    check('Server started', ready);

    const browser = await chromium.launch();

    // Session 1: shipper posts a real load, carrier posts a real truck
    const page1 = await browser.newPage();
    await page1.goto('http://localhost:4000/');
    await page1.click('#btnModeShipper').catch(()=>{});
    await page1.fill('#sliEmail', 'shipper@loadmasr.eg');
    await page1.fill('#sliPassword', 'demo1234');
    await page1.click('#shipperLoginSubmit');
    await page1.waitForTimeout(400);
    await page1.click('#dashboardShipper [data-view="mine"]');
    await page1.waitForTimeout(200);
    await page1.selectOption('#lOrigin', 'Giza');
    await page1.selectOption('#lDest', 'Luxor');
    await page1.fill('#lWeight', '5 tons');
    await page1.fill('#lPickup', '2028-07-01');
    await page1.fill('#lCargo', 'Test cargo description');
    await page1.fill('#lRate', '21000');
    await page1.click('#loadFormSubmit');
    await page1.waitForTimeout(500);

    // Log out first — the signup tab only exists on the logged-out auth screen
    await page1.click('[data-view="dashboard"]').catch(()=>{});
    await page1.evaluate(() => logout('shipper'));
    await page1.waitForTimeout(300);

    // New shipper signup, PENDING verification
    await page1.click('#btnModeShipper');
    await page1.click('#shipperTabSignup');
    await page1.waitForTimeout(200);
    await page1.click('#wizNextBtn');
    await page1.waitForTimeout(150);
    const newEmail = `admin_ui_test_${Date.now()}@test.eg`;
    await page1.fill('#wizCompanyName', 'Admin UI Test Shippers');
    await page1.fill('#wizContactPerson', 'Reviewer Test');
    await page1.fill('#wizWhatsapp', '201055556666');
    await page1.fill('#wizEmail', newEmail);
    await page1.fill('#wizPassword', 'testpass123');
    await page1.fill('#wizTrn', '999888777');
    await page1.fill('#wizSijill', 'CR-99887');
    await page1.click('#wizNextBtn');
    await page1.waitForTimeout(150);
    await page1.click('#wizSubmitBtn');
    await page1.waitForTimeout(1200);

    // Session 2: real admin UI walkthrough
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    const errors2 = []; page2.on('pageerror', e => errors2.push(e.message));
    await page2.goto('http://localhost:4000/');
    await page2.click('#btnModeAdmin').catch(async()=>{ await page2.click('text=Admin'); });
    await page2.waitForTimeout(200);
    await page2.fill('#adminEmail', 'admin@loadmasr.eg');
  await page2.fill('#adminPassword', 'admin-seed-password');
    await page2.click('#adminGateSubmit');
    await page2.waitForTimeout(600);

    const queueText = await page2.$eval('#adminQueueBody', el => el.textContent);
    check('Admin UI queue shows the real pending signup from a totally different session', queueText.includes('Admin UI Test Shippers'));

    const allLoadsText = await page2.$eval('#adminAllLoadsBody', el => el.textContent);
    check('Admin All Loads shows the real load just posted, with real total count', allLoadsText.includes('21,000'));

    // Click Approve via the real UI button
    const approveBtn = page2.locator('[data-adm-approve]').first();
    await approveBtn.click();
    await page2.waitForTimeout(600);
    const approvedAgainText = await page2.$eval('#adminQueueBody', el => el.textContent);
    check('After clicking Approve in the real UI, that account is gone from PENDING', !approvedAgainText.includes('Admin UI Test Shippers'));

    await page2.click('[data-admin-status="APPROVED"]');
    await page2.waitForTimeout(600);
    const approvedTabText = await page2.$eval('#adminQueueBody', el => el.textContent);
    check('And now correctly appears under the APPROVED tab', approvedTabText.includes('Admin UI Test Shippers'));

    // Verify server-side, independent of the UI, that this is real
    const adminToken = (await (await fetch('http://localhost:4000/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email:'admin@loadmasr.eg', password:'admin-seed-password'})})).json()).token;
    const dbCheck = await fetch('http://localhost:4000/api/admin/queue?status=APPROVED', {headers:{Authorization:'Bearer '+adminToken}}).then(r=>r.json());
    check('Confirmed independently against the raw API — approval genuinely persisted', dbCheck.users.some(u=>u.email===newEmail));

    console.log('Admin session errors:', errors2.join('\n') || '(none)');
    await browser.close();
  } finally {
    server.kill();
  }
  const failed = results.filter(r=>!r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
})();
