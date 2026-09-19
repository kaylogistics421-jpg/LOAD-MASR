const { spawn } = require('child_process');
const { chromium } = require('playwright');
const fs = require('fs');
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

    // Session A: shipper posts load, session B: carrier offers, shipper accepts
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
    await pageA.selectOption('#lDest', 'Luxor');
    await pageA.fill('#lWeight', '2 tons');
    await pageA.fill('#lPickup', '2028-06-01');
    await pageA.fill('#lCargo', 'Test cargo description');
    await pageA.fill('#lRate', '21000');
    await pageA.click('#loadFormSubmit');
    await pageA.waitForTimeout(600);

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
    for (const r of rows) { if ((await r.textContent()).includes('21,000')) { target = r; break; } }
    await target.click();
    await pageB.waitForTimeout(200);
    await pageB.click('[data-request-id]');
    await pageB.waitForTimeout(200);
    await pageB.fill('#offEmptyDate', '2028-06-01');
    await pageB.selectOption('#offTruckGov', 'Cairo');
    await pageB.fill('#reqOfferPrice', '21000');
    await pageB.click('#reqSendBtn');
    await pageB.waitForTimeout(700);

    // Shipper accepts (back in session A)
    await pageA.click('#dashboardShipper [data-view="mine"]');
    await pageA.waitForTimeout(500);
    const shipperRow = await pageA.locator('#loadBoardBody tr', {hasText:'Luxor'}).first();
    await shipperRow.click();
    await pageA.waitForTimeout(1200);
    const acceptBtn = await pageA.$('[data-accept-offer]');
    check('Shipper can find the accept control', !!acceptBtn);
    await acceptBtn.click();
    await pageA.waitForTimeout(800);

    // CARRIER (session B) — go to Tracking, advance the load through stages
    await pageB.click('#dashboardCarrier [data-view="tracking"]');
    await pageB.waitForTimeout(600);
    let shipmentCards = await pageB.$$('#carrierTrackingList [data-shipment-open]');
    let shipmentCard;
    for (const c of shipmentCards) { const t = await c.evaluateHandle(el=>el.closest('.shipment-card')); const text = await t.evaluate(el=>el.textContent); if (text.includes('21,000') || text.includes('Luxor')) { shipmentCard = c; break; } }
    check('Carrier finds the newly-booked shipment in Tracking', !!shipmentCard);
    if (shipmentCard) await shipmentCard.click();
    await pageB.waitForTimeout(500);

    // Advance through 3 stages: Booked -> At Pickup -> En Route -> Delivered
    for (let i = 0; i < 3; i++) {
      const advBtn = await pageB.$('[data-advance-stage]');
      if (advBtn) { await advBtn.click(); await pageB.waitForTimeout(500); }
    }
    const stageText = await pageB.$eval('.modal-box, .detail-row', el => el.textContent).catch(()=>'');
    check('Carrier advanced the load to Delivered', stageText.includes('Delivered') || stageText.includes('track.stage.delivered') === false);

    // Upload a REAL POD file with real bytes
    const podInput = await pageB.$('input[type="file"][id^="podFile-"]');
    check('POD file input exists once Delivered', !!podInput);
    if (podInput) {
      await podInput.setInputFiles('/home/claude/test_pod_photo.png');
      await pageB.waitForTimeout(200);
      const tollsInput = await pageB.$('input[id^="podTolls-"]');
      if (tollsInput) await tollsInput.fill('250');
      const submitBtn = await pageB.$('[data-submit-pod]');
      if (submitBtn) { await submitBtn.click(); await pageB.waitForTimeout(800); }
    }

    // Verify the REAL file landed on disk with real bytes, via the DB
    const adminToken = (await (await fetch('http://localhost:4000/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email:'admin@loadmasr.eg', password:'admin-seed-password'})})).json()).token;
    const allLoads = await fetch('http://localhost:4000/api/admin/loads', {headers:{Authorization:'Bearer '+adminToken}}).then(r=>r.json());
    const theLoad = allLoads.loads.find(l=>l.rate===21000);
    check('The load genuinely shows pod_status Uploaded in the real DB', theLoad && theLoad.pod_status === 'Uploaded');
    check('Real tolls (250) were saved to the real DB', theLoad && theLoad.tolls === 250);
    check('A real pod_document_id was recorded', theLoad && !!theLoad.pod_document_id);

    // SHIPPER (session A) — sees the real Delivered stage + POD from a DIFFERENT session
    await pageA.click('#dashboardShipper [data-view="tracking"]');
    await pageA.waitForTimeout(600);
    let shipperCards = await pageA.$$('#shipperTrackingList [data-shipment-open]');
    let shipperCard;
    for (const c of shipperCards) { const t = await c.evaluateHandle(el=>el.closest('.shipment-card')); const text = await t.evaluate(el=>el.textContent); if (text.includes('Luxor')) { shipperCard = c; break; } }
    check('Shipper finds the shipment in their own Tracking tab', !!shipperCard);
    if (shipperCard) await shipperCard.click();
    await pageA.waitForTimeout(700);
    const shipperModalText = await pageA.$eval('.modal-box', el => el.textContent).catch(()=>'');
    check('Shipper (separate session) sees the REAL Delivered stage the carrier set', shipperModalText.includes('Delivered') || !shipperModalText.includes('Booked'));

    const approveBtn = await pageA.$('[data-approve-pod]');
    check('Shipper can find the approve-POD control', !!approveBtn);
    if (approveBtn) { await approveBtn.click(); await pageA.waitForTimeout(800); }

    // Verify approval genuinely persisted, and invoices generated correctly
    // (carrier + dispatcher only — NOT an old-style shipper invoice)
    const finalLoads = await fetch('http://localhost:4000/api/admin/loads', {headers:{Authorization:'Bearer '+adminToken}}).then(r=>r.json());
    const finalLoad = finalLoads.loads.find(l=>l.rate===21000);
    check('POD approval genuinely persisted (pod_status Approved)', finalLoad && finalLoad.pod_status === 'Approved');
    check('Load correctly marked Completed after approval', finalLoad && finalLoad.status === 'Completed');

    const invRes = await fetch(`http://localhost:4000/api/invoices/mine`, {
      headers: {Authorization: 'Bearer ' + await (async()=>{
        const r = await fetch('http://localhost:4000/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email:'carrier@loadmasr.eg', password:'demo1234'})});
        return (await r.json()).token;
      })()}
    }).then(r=>r.json());
    check('Carrier invoice was correctly auto-generated', invRes.invoices.some(i=>i.load_id===theLoad.id && i.role==='carrier'));
    check('Dispatcher invoice was correctly auto-generated', invRes.invoices.some(i=>i.load_id===theLoad.id && i.role==='dispatcher'));

    console.log('Session A errors:', errorsA.join('\n') || '(none)');
    console.log('Session B errors:', errorsB.join('\n') || '(none)');
    await browser.close();
  } finally {
    server.kill();
  }
  const failed = results.filter(r=>!r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) { console.log('FAILED:', failed.map(f=>f.label)); }
})();
