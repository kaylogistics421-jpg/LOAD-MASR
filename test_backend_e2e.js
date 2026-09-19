const { spawn } = require('child_process');
const { chromium } = require('playwright');

(async () => {
  const server = spawn('node', ['src/server.js'], { cwd: '/home/claude/loadmasr-backend', env: { ...process.env, SEED_DEMO_ACCOUNTS: 'true' } });
  let serverLog = '';
  server.stdout.on('data', d => serverLog += d);
  server.stderr.on('data', d => serverLog += d);

  const results = [];
  const check = (label, cond) => { results.push({label, pass: !!cond}); console.log((cond?'✅':'❌'), label); };

  try {
    let ready = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 300));
      try { const res = await fetch('http://localhost:4000/api/health'); if (res.ok) { ready = true; break; } } catch(e) {}
    }
    check('Server started', ready);
    if (!ready) { console.log(serverLog); process.exit(1); }

    const browser = await chromium.launch();

    // ---- SESSION A: shipper posts a real load ----
    const pageA = await browser.newPage();
    const errorsA = []; pageA.on('pageerror', e => errorsA.push(e.message));
    await pageA.goto('http://localhost:4000/');
    await pageA.click('#btnModeShipper').catch(()=>{});
    await pageA.fill('#sliEmail', 'shipper@loadmasr.eg');
    await pageA.fill('#sliPassword', 'demo1234');
    await pageA.click('#shipperLoginSubmit');
    await pageA.waitForTimeout(400);
    await pageA.click('#dashboardShipper [data-view="mine"]');
    await pageA.waitForTimeout(200);
    await pageA.selectOption('#lOrigin', 'Cairo');
    await pageA.selectOption('#lDest', 'Suez');
    await pageA.fill('#lWeight', '3 tons');
    await pageA.fill('#lPickup', '2028-06-01');
    await pageA.fill('#lRate', '17500');
    await pageA.click('#loadFormSubmit');
    await pageA.waitForTimeout(600);
    const postMsg = await pageA.$eval('#loadFormMsg', el => el.textContent);
    check('Load post succeeds in the UI', postMsg.includes('is live on the board'));

    // Verify it actually landed in the real database directly (not just local memory)
    const dbCheck = await fetch('http://localhost:4000/api/loads').then(r=>r.json());
    check('Load genuinely exists in the real database (queried directly, not via the browser)', dbCheck.loads.some(l => l.rate === 17500));

    // ---- SESSION B: a completely separate browser context (different carrier) ----
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    const errorsB = []; pageB.on('pageerror', e => errorsB.push(e.message));
    await pageB.goto('http://localhost:4000/');
    await pageB.click('#btnModeCarrier').catch(()=>{});
    await pageB.fill('#cliEmail', 'carrier@loadmasr.eg');
    await pageB.fill('#cliPassword', 'demo1234');
    await pageB.click('#carrierLoginSubmit');
    await pageB.waitForTimeout(400);
    await pageB.click('#dashboardCarrier [data-view="search"]');
    await pageB.waitForTimeout(300);
    const searchText = await pageB.$eval('#searchLoadsBody', el => el.textContent);
    check('A DIFFERENT session (separate browser context) can see the load Session A posted — real shared backend, not per-browser memory', searchText.includes('17,500') || searchText.includes('17500'));

    // ---- Carrier posts a truck; shipper session should see it ----
    await pageB.click('#dashboardCarrier [data-view="mine"]');
    await pageB.waitForTimeout(200);
    await pageB.selectOption('#pOrigin', 'Alexandria');
    await pageB.fill('#pCapacity', 'Cross-Session Test Truck');
    await pageB.fill('#pAvail', '2028-06-05');
    await pageB.click('#truckFormSubmit');
    await pageB.waitForTimeout(600);

    await pageA.click('#dashboardShipper [data-view="search"]');
    await pageA.waitForTimeout(300);
    const truckSearchText = await pageA.$eval('#searchTrucksBody', el => el.textContent);
    check('Shipper session sees the truck the carrier session just posted', truckSearchText.includes('Cross-Session Test Truck'));

    console.log('Session A page errors:', errorsA.join('\n') || '(none)');
    console.log('Session B page errors:', errorsB.join('\n') || '(none)');
    await browser.close();
  } finally {
    server.kill();
  }
  const failed = results.filter(r=>!r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
})();
