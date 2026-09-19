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
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 300));
      try { const res = await fetch('http://localhost:4000/api/health'); if (res.ok) break; } catch(e) {}
    }
    const shipperToken = (await api('POST','/api/auth/login',{email:'shipper@loadmasr.eg',password:'demo1234'})).json.token;
    const carrierToken = (await api('POST','/api/auth/login',{email:'carrier@loadmasr.eg',password:'demo1234'})).json.token;
    await deliverLoad(shipperToken, carrierToken, 10000, 200);

    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => console.log('PAGEERROR:', e.message));
    page.on('console', msg => { if(msg.type()==='error'||msg.type()==='warning') console.log('CONSOLE:', msg.text()); });
    await page.goto('http://localhost:4000/');
    await page.click('#btnModeShipper').catch(()=>{});
    await page.fill('#sliEmail', 'shipper@loadmasr.eg');
    await page.fill('#sliPassword', 'demo1234');
    await page.click('#shipperLoginSubmit');
    await page.waitForTimeout(600);
    await page.click('#dashboardShipper [data-view="billing"]');
    await page.waitForTimeout(1200);
    await page.click('#readySelectAll');
    await page.waitForTimeout(200);
    await page.click('#generateFreightInvoiceBtn');
    await page.waitForTimeout(1000);

    // Upload a REAL receipt via the real UI
    const uploadBtn = await page.$('[data-upload-receipt]');
    check('A real Upload Receipt button appears for the new invoice', !!uploadBtn);
    if (uploadBtn) await uploadBtn.click();
    await page.waitForTimeout(400);
    const receiptInput = await page.$('#receiptFile');
    if (receiptInput) await receiptInput.setInputFiles('/home/claude/test_pod_photo.png');
    await page.waitForTimeout(200);
    await page.click('#receiptSubmitBtn');
    await page.waitForTimeout(1000);

    // Verify server-side: settlement status genuinely moved, and a real document was attached
    const mine = await api('GET','/api/invoices/mine',null,shipperToken);
    const inv = mine.json.invoices.find(i=>i.kind==='shipper_freight');
    check('Settlement status genuinely moved to In Verification on the server', inv.settlement_status === 'In Verification');
    check('A real receipt document was attached', !!inv.receipt_document_id);

    // Admin sees and can confirm it
    const adminToken = (await api('POST','/api/auth/login',{email:'admin@loadmasr.eg',password:'admin-seed-password'})).json.token;
    const verifs = await api('GET','/api/admin/payment-verifications',null,adminToken);
    check('Admin sees this real freight invoice awaiting verification', verifs.json.invoices.some(i=>i.id===inv.id));
    const confirm = await api('POST',`/api/admin/invoices/${inv.id}/confirm-settled`,{},adminToken);
    check('Admin can confirm settlement', confirm.status === 200);
    const mineAfter = await api('GET','/api/invoices/mine',null,shipperToken);
    const invAfter = mineAfter.json.invoices.find(i=>i.id===inv.id);
    check('Invoice now genuinely shows Paid/Settled', invAfter.status === 'Paid' && invAfter.settlement_status === 'Settled');

    await browser.close();
  } finally {
    server.kill();
  }
  const failed = results.filter(r=>!r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) console.log('FAILED:', failed.map(f=>f.label));
})();
