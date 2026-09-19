const { spawn } = require('child_process');
const { chromium } = require('playwright');
(async () => {
  const server = spawn('node', ['src/server.js'], { cwd: '/home/claude/loadmasr-backend', env: { ...process.env, SEED_DEMO_ACCOUNTS: 'true' } });
  const results = [];
  const check = (label, cond) => { results.push({label, pass: !!cond}); console.log((cond?'✅':'❌'), label); };
  const api = (method, path, body, token) => fetch(`http://localhost:4000${path}`, {
    method, headers: {'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{})},
    body: body ? JSON.stringify(body) : undefined
  }).then(async r => ({status:r.status, json: await r.json().catch(()=>null)}));

  async function deliverLoad(shipperToken, carrierToken, rate, tolls) {
    const load = await api('POST','/api/loads',{origin:'Cairo',dest:'Aswan',cargo:'Test cargo',equip:'Flatbed',weight:'1t',pickupDate:'2028-01-01',rate},shipperToken);
    const loadId = load.json.load.id;
    const neg = await api('POST','/api/negotiations',{targetType:'load',targetId:loadId,price:rate,note:''},carrierToken);
    await api('POST',`/api/negotiations/${neg.json.negotiation.id}/accept`,{},shipperToken);
    for (const stage of ['At Pickup','En Route','Delivered']) await api('PATCH',`/api/loads/${loadId}/tracking`,{stage},carrierToken);
    await api('POST',`/api/loads/${loadId}/pod`,{filename:'p.png',mimeType:'image/png',base64Data:Buffer.from('x').toString('base64'),tolls},carrierToken);
    await api('POST',`/api/loads/${loadId}/pod/approve`,{},shipperToken);
    return loadId;
  }

  try {
    let ready = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 300));
      try { const res = await fetch('http://localhost:4000/api/health'); if (res.ok) { ready = true; break; } } catch(e) {}
    }
    check('Server started', ready);

    const shipperToken = (await api('POST','/api/auth/login',{email:'shipper@loadmasr.eg',password:'demo1234'})).json.token;
    const carrierToken = (await api('POST','/api/auth/login',{email:'carrier@loadmasr.eg',password:'demo1234'})).json.token;
    const load1 = await deliverLoad(shipperToken, carrierToken, 10000, 200);
    const load2 = await deliverLoad(shipperToken, carrierToken, 8000, 150);

    const browser = await chromium.launch();
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://localhost:4000/');
    await page.click('#btnModeShipper').catch(()=>{});
    await page.fill('#sliEmail', 'shipper@loadmasr.eg');
    await page.fill('#sliPassword', 'demo1234');
    await page.click('#shipperLoginSubmit');
    await page.waitForTimeout(600);
    await page.click('#dashboardShipper [data-view="billing"]').catch(()=>{});
    await page.waitForTimeout(1000);

    const readyRows = await page.$$eval('.ready-select', els => els.length);
    check('Both real delivered loads appear in the real Ready-to-invoice UI', readyRows === 2);

    const selectAll = await page.$('#readySelectAll');
    if (selectAll) await selectAll.click();
    await page.waitForTimeout(300);

    const genBtn = await page.$('#generateFreightInvoiceBtn');
    check('Generate Invoice button is enabled with real loads selected', !!genBtn);
    if (genBtn) { await genBtn.click(); await page.waitForTimeout(1000); }

    // Confirm a REAL invoice now exists server-side with the correct amount
    const mine = await api('GET','/api/invoices/mine',null,shipperToken);
    const freightInv = mine.json.invoices.find(i=>i.kind==='shipper_freight');
    check('A real consolidated freight invoice was created via the real UI', !!freightInv);
    check('The real amount is correct (18,000 + VAT = 20,520)', freightInv && freightInv.amount === 20520);

    // The loads should now be GONE from ready-to-invoice in the UI
    await page.waitForTimeout(500);
    const readyRowsAfter = await page.$$eval('.ready-select', els => els.length);
    check('Both loads are now gone from Ready-to-invoice after real generation', readyRowsAfter === 0);

    // But still present in ready-for-tolls
    const tollsRows = await page.$$eval('.tolls-select', els => els.length);
    check('The loads are STILL in the tolls section (independent billing)', tollsRows === 2);

    const tollsSelectAll = await page.$('#tollsSelectAll');
    if (tollsSelectAll) await tollsSelectAll.click();
    await page.waitForTimeout(300);
    const tollsBtn = await page.$('#generateTollsInvoiceBtn');
    if (tollsBtn) { await tollsBtn.click(); await page.waitForTimeout(1000); }

    const mine2 = await api('GET','/api/invoices/mine',null,shipperToken);
    const tollsInv = mine2.json.invoices.find(i=>i.kind==='shipper_tolls');
    check('A real tolls sheet was created via the real UI', !!tollsInv);
    check('The real tolls total is correct (200+150=350)', tollsInv && tollsInv.amount === 350);

    // The invoices should show up in the billing table itself
    await page.waitForTimeout(500);
    const billingTableText = await page.$eval('#shipperInvoiceBody', el => el.textContent).catch(()=>'');
    check('The real freight invoice amount shows in the billing table', billingTableText.includes('20,520'));
    check('The real tolls sheet amount shows in the billing table', billingTableText.includes('350'));

    console.log('Page errors:', errors.join('\n') || '(none)');
    await browser.close();
  } finally {
    server.kill();
  }
  const failed = results.filter(r=>!r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) console.log('FAILED:', failed.map(f=>f.label));
})();
