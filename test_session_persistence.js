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
    const page = await browser.newPage();

    await page.goto('http://localhost:4000/');
    await page.click('#btnModeShipper').catch(()=>{});
    await page.fill('#sliEmail', 'shipper@loadmasr.eg');
    await page.fill('#sliPassword', 'demo1234');
    await page.click('#shipperLoginSubmit');
    await page.waitForTimeout(500);
    const dashBefore = await page.$eval('#dashboardShipper', el => getComputedStyle(el).display);
    check('Logged in normally before reload', dashBefore === 'flex');

    // THE actual test — reload and see if the session survives
    await page.reload();
    await page.waitForTimeout(1200);
    const dashAfter = await page.$eval('#dashboardShipper', el => getComputedStyle(el).display).catch(()=>'MISSING');
    check('Session SURVIVES a page reload (the actual fix)', dashAfter === 'flex');

    // Logout should genuinely clear it
    const logoutBtn = await page.$('#logoutShipperBtn').catch(()=>null);
    if (logoutBtn) await logoutBtn.scrollIntoViewIfNeeded().catch(()=>{});
    if (logoutBtn) {
      await logoutBtn.click();
      await page.waitForTimeout(400);
      await page.reload();
      await page.waitForTimeout(1000);
      const dashAfterLogout = await page.$eval('#dashboardShipper', el => getComputedStyle(el).display).catch(()=>'MISSING');
      check('After logout + reload, session is genuinely gone (not stuck logged in)', dashAfterLogout !== 'flex');
    } else {
      check('Found a logout button to test with', false);
    }

    // Admin session persistence too
    const page2 = await browser.newPage();
    await page2.goto('http://localhost:4000/');
    await page2.click('#btnModeAdmin').catch(async()=>{ await page2.click('text=Admin'); });
    await page2.waitForTimeout(200);
    await page2.fill('#adminEmail', 'admin@loadmasr.eg');
    await page2.fill('#adminPassword', 'admin-seed-password');
    await page2.click('#adminGateSubmit');
    await page2.waitForTimeout(600);
    await page2.reload();
    await page2.waitForTimeout(1200);
    const adminPanelAfter = await page2.$eval('#adminPanel', el => getComputedStyle(el).display).catch(()=>'MISSING');
    check('Admin session also survives a reload', adminPanelAfter === 'block');

    // CARRIER session persistence — the real test of setMode, since shipper is the default mode
    const page3 = await browser.newPage();
    await page3.goto('http://localhost:4000/');
    await page3.click('#btnModeCarrier').catch(()=>{});
    await page3.fill('#cliEmail', 'carrier@loadmasr.eg');
    await page3.fill('#cliPassword', 'demo1234');
    await page3.click('#carrierLoginSubmit');
    await page3.waitForTimeout(600);
    await page3.reload();
    await page3.waitForTimeout(1200);
    const carrierDashAfter = await page3.$eval('#dashboardCarrier', el => getComputedStyle(el).display).catch(()=>'MISSING');
    check('Carrier session survives a reload too (not just shipper, which is the default mode)', carrierDashAfter === 'flex');

    await browser.close();
  } finally {
    server.kill();
  }
  const failed = results.filter(r=>!r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
})();
