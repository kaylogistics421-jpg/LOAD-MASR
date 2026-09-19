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

    // SESSION A: carrier posts a truck
    const pageA = await browser.newPage();
    const errorsA = []; pageA.on('pageerror', e => errorsA.push(e.message));
    await pageA.goto('http://localhost:4000/');
    await pageA.click('#btnModeCarrier').catch(()=>{});
    await pageA.fill('#cliEmail', 'carrier@loadmasr.eg');
    await pageA.fill('#cliPassword', 'demo1234');
    await pageA.click('#carrierLoginSubmit');
    await pageA.waitForTimeout(500);
    await pageA.click('#dashboardCarrier [data-view="mine"]');
    await pageA.waitForTimeout(200);
    await pageA.selectOption('#pOrigin', 'Alexandria');
    await pageA.fill('#pCapacity', 'Negotiation Test Truck');
    await pageA.fill('#pAvail', '2028-04-01');
    await pageA.click('#truckFormSubmit');
    await pageA.waitForTimeout(600);

    // SESSION B: shipper requests it
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    const errorsB = []; pageB.on('pageerror', e => errorsB.push(e.message));
    await pageB.goto('http://localhost:4000/');
    await pageB.click('#btnModeShipper').catch(()=>{});
    await pageB.fill('#sliEmail', 'shipper@loadmasr.eg');
    await pageB.fill('#sliPassword', 'demo1234');
    await pageB.click('#shipperLoginSubmit');
    await pageB.waitForTimeout(500);
    await pageB.click('#dashboardShipper [data-view="search"]');
    await pageB.waitForTimeout(400);
    const rows = await pageB.$$('#searchTrucksBody tr.row-clickable');
    let target;
    for (const r of rows) { if ((await r.textContent()).includes('Negotiation Test Truck')) { target = r; break; } }
    check('Shipper session can find the carrier-posted truck', !!target);
    await target.click();
    await pageB.waitForTimeout(200);
    await pageB.click('[data-request-truck-id]');
    await pageB.waitForTimeout(200);
    await pageB.fill('#reqPickupDate', '2028-04-01');
    await pageB.selectOption('#reqDeliveryGov', 'Cairo');
    await pageB.fill('#reqOfferPrice', '14000');
    await pageB.fill('#reqMessage', 'need it Thursday');
    await pageB.click('#reqSendBtn');
    await pageB.waitForTimeout(700);

    // BACK TO SESSION A (carrier) — sees the real request from a different session
    await pageA.click('#dashboardCarrier [data-view="mine"]');
    await pageA.waitForTimeout(300);
    const carrierRows = await pageA.$$('#truckBoardBody tr');
    let carrierTarget;
    for (const r of carrierRows) { if ((await r.textContent()).includes('Negotiation Test Truck')) { carrierTarget = r; break; } }
    await carrierTarget.click();
    await pageA.waitForTimeout(1000);
    const carrierPanelText = await pageA.$eval('.detail-row', el => el.textContent);
    check('Carrier session sees the REAL request from a totally different shipper session (14,000 EGP)', carrierPanelText.includes('14,000') || carrierPanelText.includes('14000'));
    check('Carrier session sees the shipper\'s real note', carrierPanelText.includes('need it Thursday'));

    // Carrier accepts
    const acceptBtn = await pageA.$('[data-accept-bid]');
    check('Carrier could find the accept control', !!acceptBtn);
    if (acceptBtn) { await acceptBtn.click(); await pageA.waitForTimeout(800); }

    // Verify a REAL linked load now exists in the database
    const adminToken = (await (await fetch('http://localhost:4000/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email:'admin@loadmasr.eg', password:'admin-seed-password'})})).json()).token;
    const allLoads = await fetch('http://localhost:4000/api/admin/loads', {headers:{Authorization:'Bearer '+adminToken}}).then(r=>r.json());
    const linkedLoad = allLoads.loads.find(l => l.rate === 14000 && l.tracking_stage === 'Booked');
    check('Accepting the truck request created a REAL, persisted, trackable load', !!linkedLoad);
    check('The linked load correctly shows the shipper as its owner', linkedLoad && linkedLoad.shipper_email === 'shipper@loadmasr.eg');

    console.log('Session A errors:', errorsA.join('\n') || '(none)');
    console.log('Session B errors:', errorsB.join('\n') || '(none)');
    await browser.close();
  } finally {
    server.kill();
  }
  const failed = results.filter(r=>!r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
})();
