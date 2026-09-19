const { spawn } = require('child_process');
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
    const adminToken = (await api('POST','/api/auth/login',{email:'admin@loadmasr.eg',password:'admin-seed-password'})).json.token;

    // Two real, fully-delivered loads with real rates and real tolls
    const load1 = await deliverLoad(shipperToken, carrierToken, 10000, 200);
    const load2 = await deliverLoad(shipperToken, carrierToken, 8000, 150);

    // Ready-to-invoice / ready-for-tolls lists
    const ready = await api('GET','/api/loads/ready-to-invoice',null,shipperToken);
    check('Both delivered loads appear in ready-to-invoice', ready.json.loads.some(l=>l.id===load1) && ready.json.loads.some(l=>l.id===load2));
    const readyTolls = await api('GET','/api/loads/ready-for-tolls',null,shipperToken);
    check('Both delivered loads appear in ready-for-tolls (both have tolls > 0)', readyTolls.json.loads.some(l=>l.id===load1) && readyTolls.json.loads.some(l=>l.id===load2));

    // Generate ONE consolidated freight invoice covering BOTH loads
    const genFreight = await api('POST','/api/invoices/generate-freight',{loadIds:[load1,load2]},shipperToken);
    check('Consolidated freight invoice created', genFreight.status === 201);
    // linehaul 10000+8000=18000, vat 14% = 1400+1120=2520, total = 20520
    check('The consolidated amount is correct (18,000 + 14% VAT = 20,520, tolls excluded)', genFreight.json.invoice.amount === 20520);
    check('Invoice correctly includes both load IDs', JSON.parse(genFreight.json.invoice.included_load_ids_json).length === 2);

    // Can't invoice the same load twice
    const dupe = await api('POST','/api/invoices/generate-freight',{loadIds:[load1]},shipperToken);
    check('The same load cannot be included in a second freight invoice', dupe.status === 400);

    // Ready-to-invoice list is now empty (both loads consumed)
    const readyAfter = await api('GET','/api/loads/ready-to-invoice',null,shipperToken);
    check('Both loads are now gone from ready-to-invoice', !readyAfter.json.loads.some(l=>l.id===load1 || l.id===load2));
    // But they're STILL in ready-for-tolls (freight and tolls are billed independently)
    const readyTollsAfter = await api('GET','/api/loads/ready-for-tolls',null,shipperToken);
    check('Loads are STILL in ready-for-tolls (freight and tolls billed separately)', readyTollsAfter.json.loads.some(l=>l.id===load1) && readyTollsAfter.json.loads.some(l=>l.id===load2));

    // Generate the tolls sheet — separate, no VAT
    const genTolls = await api('POST','/api/invoices/generate-tolls',{loadIds:[load1,load2]},shipperToken);
    check('Tolls sheet created', genTolls.status === 201);
    check('Tolls total is correct (200+150=350, no VAT)', genTolls.json.invoice.amount === 350);

    // Shipper sees both real invoices in their own billing
    const mine = await api('GET','/api/invoices/mine',null,shipperToken);
    check('Shipper sees the real freight invoice', mine.json.invoices.some(i=>i.id===genFreight.json.invoice.id));
    check('Shipper sees the real tolls sheet', mine.json.invoices.some(i=>i.id===genTolls.json.invoice.id));

    // Admin cannot delete an invoiced load
    const delAttempt = await api('DELETE', `/api/admin/loads/${load1}`, null, adminToken);
    check('Admin cannot delete a load that is part of a consolidated invoice', delAttempt.status === 409);

    // Admin sees these in the full invoices list
    const allInv = await api('GET','/api/admin/invoices',null,adminToken);
    check('Admin sees both consolidated invoices in full oversight', allInv.json.invoices.some(i=>i.kind==='shipper_freight') && allInv.json.invoices.some(i=>i.kind==='shipper_tolls'));

  } finally {
    server.kill();
  }
  const failed = results.filter(r=>!r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) console.log('FAILED:', failed.map(f=>f.label));
})();
