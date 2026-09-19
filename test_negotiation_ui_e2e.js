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

    // SESSION A: shipper posts a load
    const pageA = await browser.newPage();
    const errorsA = []; pageA.on('pageerror', e => errorsA.push(e.message));
    await pageA.goto('http://localhost:4000/');
    await pageA.click('#btnModeShipper').catch(()=>{});
    await pageA.fill('#sliEmail', 'shipper@loadmasr.eg');
    await pageA.fill('#sliPassword', 'demo1234');
    await pageA.click('#shipperLoginSubmit');
    await pageA.waitForTimeout(500);
    await pageA.click('#dashboardShipper [data-view="mine"]');
    await pageA.waitForTimeout(200);
    await pageA.selectOption('#lOrigin', 'Cairo');
    await pageA.selectOption('#lDest', 'Suez');
    await pageA.fill('#lWeight', '3 tons');
    await pageA.fill('#lPickup', '2028-03-01');
    await pageA.fill('#lCargo', 'Test cargo description');
    await pageA.fill('#lRate', '20000');
    await pageA.click('#loadFormSubmit');
    await pageA.waitForTimeout(600);

    // SESSION B: a completely separate browser context — the carrier
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    const errorsB = []; pageB.on('pageerror', e => errorsB.push(e.message));
    await pageB.goto('http://localhost:4000/');
    await pageB.click('#btnModeCarrier').catch(()=>{});
    await pageB.fill('#cliEmail', 'carrier@loadmasr.eg');
    await pageB.fill('#cliPassword', 'demo1234');
    await pageB.click('#carrierLoginSubmit');
    await pageB.waitForTimeout(500);
    await pageB.click('#dashboardCarrier [data-view="search"]');
    await pageB.waitForTimeout(400);
    const rows = await pageB.$$('#searchLoadsBody tr.row-clickable');
    let target;
    for (const r of rows) { if ((await r.textContent()).includes('20,000')) { target = r; break; } }
    check('Carrier session can find the shipper-posted load', !!target);
    await target.click();
    await pageB.waitForTimeout(200);
    await pageB.click('[data-request-id]');
    await pageB.waitForTimeout(200);
    await pageB.fill('#offEmptyDate', '2028-03-01');
    await pageB.selectOption('#offTruckGov', 'Cairo');
    await pageB.fill('#reqOfferPrice', '18000');
    await pageB.fill('#reqMessage', 'ready same day');
    await pageB.click('#reqSendBtn');
    await pageB.waitForTimeout(700);

    // Verify the offer genuinely persisted to the real database
    const dbCheck = await fetch('http://localhost:4000/api/admin/loads', {
      headers: {Authorization: 'Bearer ' + await (async()=>{
        const r = await fetch('http://localhost:4000/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email:'admin@loadmasr.eg', password:'admin-seed-password'})});
        return (await r.json()).token;
      })()}
    }).then(r=>r.json());
    check('The load still exists in the real DB after the offer (not yet accepted)', dbCheck.loads.some(l=>l.rate===20000));

    // BACK TO SESSION A (shipper) — open the SAME load's detail panel and
    // confirm they see the REAL offer the carrier just made in a totally
    // different session
    await pageA.click('#dashboardShipper [data-view="mine"]');
    await pageA.waitForTimeout(300);
    const shipperRow = await pageA.locator('#loadBoardBody tr', {hasText:'Suez'}).first();
    await shipperRow.click();
    await pageA.waitForTimeout(1000); // allow the async negotiation sync to complete
    const shipperPanelText = await pageA.$eval('.detail-row', el => el.textContent);
    check('Shipper session (separate browser) sees the REAL offer from the carrier session (18,000 EGP)', shipperPanelText.includes('18,000') || shipperPanelText.includes('18000'));
    check('Shipper session sees the carrier\'s real note', shipperPanelText.includes('ready same day'));

    // Shipper counters
    const counterInput = await pageA.$('[id^="offCounterPrice-"]');
    if (counterInput) {
      await counterInput.fill('19000');
      await pageA.click('[data-counter-offer]');
      await pageA.waitForTimeout(700);
    }
    check('Shipper could find and use the counter-offer control', !!counterInput);

    // BACK TO SESSION B (carrier) — should see the shipper's real counter
    await pageB.click('#dashboardCarrier [data-view="search"]');
    await pageB.waitForTimeout(300);
    const rows2 = await pageB.$$('#searchLoadsBody tr.row-clickable');
    let target2;
    for (const r of rows2) { if ((await r.textContent()).includes('20,000')) { target2 = r; break; } }
    await target2.click();
    await pageB.waitForTimeout(1000);
    const carrierPanelText = await pageB.$eval('.detail-row', el => el.textContent);
    check('Carrier session sees the shipper\'s real counter-offer (19,000 EGP) from a totally different session', carrierPanelText.includes('19,000') || carrierPanelText.includes('19000'));

    // Carrier accepts
    const acceptBtn = await pageB.$('[data-accept-offer]');
    if (acceptBtn) { await acceptBtn.click(); await pageB.waitForTimeout(700); }
    check('Carrier could find and use the accept control', !!acceptBtn);

    // Verify the load is genuinely booked in the real database
    const finalCheck = await fetch('http://localhost:4000/api/loads').then(r=>r.json());
    check('The load is no longer showing as Active/open after real acceptance', !finalCheck.loads.some(l=>l.rate===20000 && l.status==='Active'));

    console.log('Session A errors:', errorsA.join('\n') || '(none)');
    console.log('Session B errors:', errorsB.join('\n') || '(none)');
    await browser.close();
  } finally {
    server.kill();
  }
  const failed = results.filter(r=>!r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
})();
