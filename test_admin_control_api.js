const { spawn } = require('child_process');
(async () => {
  const server = spawn('node', ['src/server.js'], { cwd: '/home/claude/loadmasr-backend', env: { ...process.env, SEED_DEMO_ACCOUNTS: 'true' } });
  const results = [];
  const check = (label, cond) => { results.push({label, pass: !!cond}); console.log((cond?'✅':'❌'), label); };
  const api = (method, path, body, token) => fetch(`http://localhost:4000${path}`, {
    method, headers: {'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{})},
    body: body ? JSON.stringify(body) : undefined
  }).then(async r => ({status:r.status, json: await r.json().catch(()=>null)}));

  try {
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 300));
      try { const res = await fetch('http://localhost:4000/api/health'); if (res.ok) break; } catch(e) {}
    }
    const adminToken = (await api('POST','/api/auth/login',{email:'admin@loadmasr.eg',password:'admin-seed-password'})).json.token;
    const shipperLogin = await api('POST','/api/auth/login',{email:'shipper@loadmasr.eg',password:'demo1234'});
    const shipperToken = shipperLogin.json.token;
    const carrierLogin = await api('POST','/api/auth/login',{email:'carrier@loadmasr.eg',password:'demo1234'});
    const carrierToken = carrierLogin.json.token;

    // Settings
    const settings0 = await api('GET', '/api/settings', null);
    check('Settings endpoint returns pioneer_max_slots (17)', settings0.json.settings.pioneer_max_slots === '17');
    await api('POST', '/api/admin/settings', {key:'pioneer_max_slots', value:'25'}, adminToken);
    const pioneerStatus = await api('GET', '/api/pioneer-status', null);
    check('pioneer-status uses the new setting (25)', pioneerStatus.json.maxSlots === 25);

    // Load/truck removal
    const load1 = await api('POST','/api/loads',{origin:'Cairo',dest:'Giza',cargo:'General',equip:'Flatbed',weight:'1t',pickupDate:'2028-01-01',rate:5000},shipperToken);
    const delLoad = await api('DELETE', `/api/admin/loads/${load1.json.load.id}`, null, adminToken);
    check('Admin can delete an uninvoiced load', delLoad.status === 200);
    const truck1 = await api('POST','/api/trucks',{origin:'Alexandria',dest:'',equip:'Flatbed',capacity:'5t',availDate:'2028-01-01'},carrierToken);
    const delTruck = await api('DELETE', `/api/admin/trucks/${truck1.json.truck.id}`, null, adminToken);
    check('Admin can delete a truck', delTruck.status === 200);

    // Negotiations
    const load2 = await api('POST','/api/loads',{origin:'Cairo',dest:'Suez',cargo:'General',equip:'Flatbed',weight:'1t',pickupDate:'2028-01-01',rate:8000},shipperToken);
    const neg = await api('POST','/api/negotiations',{targetType:'load',targetId:load2.json.load.id,price:7000,note:'test'},carrierToken);
    const allNegs = await api('GET','/api/admin/negotiations',null,adminToken);
    check('Admin sees the negotiation with real party names', allNegs.json.negotiations.some(n=>n.id===neg.json.negotiation.id && n.shipper_email==='shipper@loadmasr.eg'));
    const cancelNeg = await api('POST',`/api/admin/negotiations/${neg.json.negotiation.id}/cancel`,{},adminToken);
    check('Admin can force-cancel a negotiation', cancelNeg.status === 200 && cancelNeg.json.negotiation.status === 'Declined');

    // Full invoices
    const allInvoices = await api('GET','/api/admin/invoices',null,adminToken);
    check('Admin sees all invoices', allInvoices.status === 200);

    // Carrier fee toggle
    await api('POST','/api/admin/settings',{key:'carrier_requires_fee',value:'true'},adminToken);
    const newCarrier = await api('POST','/api/auth/signup',{role:'carrier',name:'Fee Test Carrier',email:'feecarrier@test.eg',phone:'0100000000',password:'testpass'});
    check('New carrier starts unverified after toggle on', !newCarrier.json.user.verified);
    const carrierFee = await api('POST',`/api/admin/users/${newCarrier.json.user.id}/set-fee`,{amount:400,note:'Pay via InstaPay'},adminToken);
    check('Admin can set a fee for a carrier', carrierFee.status === 201);
    const carrierReceipt = await api('POST',`/api/invoices/${carrierFee.json.invoice.id}/receipt`,{filename:'r.png',mimeType:'image/png',base64Data:Buffer.from('x').toString('base64')},newCarrier.json.token);
    check('Carrier can upload their own receipt', carrierReceipt.status === 200);
    const confirmCarrierFee = await api('POST',`/api/admin/invoices/${carrierFee.json.invoice.id}/confirm-settled`,{},adminToken);
    const carrierMe = await api('GET','/api/auth/me',null,newCarrier.json.token);
    check('Carrier account verified with Pro plan after confirm', carrierMe.json.user.verified && carrierMe.json.user.plan === 'Pro');
    await api('POST','/api/admin/settings',{key:'carrier_requires_fee',value:'false'},adminToken);
    const normalCarrier = await api('POST','/api/auth/signup',{role:'carrier',name:'Normal Carrier',email:'normalcarrier@test.eg',phone:'0100000000',password:'testpass'});
    check('With toggle off, carriers get free trial as before', normalCarrier.json.user.verified);

    // User suspend/reactivate/delete
    const testUser = await api('POST','/api/auth/signup',{role:'shipper',name:'Suspend Test',email:'suspendtest@test.eg',phone:'0100000000',password:'testpass',trn:'1',sijill:'CR-1'});
    const suspend = await api('POST',`/api/admin/users/${testUser.json.user.id}/suspend`,{},adminToken);
    check('Admin can suspend', suspend.status === 200);
    const useOldToken = await api('GET','/api/auth/me',null,testUser.json.token);
    check('Suspended session immediately rejected', useOldToken.status === 401);
    const loginSuspended = await api('POST','/api/auth/login',{email:'suspendtest@test.eg',password:'testpass'});
    check('Suspended login refused with clear reason', loginSuspended.status === 403 && loginSuspended.json.error.includes('suspended'));
    await api('POST',`/api/admin/users/${testUser.json.user.id}/reactivate`,{},adminToken);
    const loginReactivated = await api('POST','/api/auth/login',{email:'suspendtest@test.eg',password:'testpass'});
    check('Reactivated login works again', loginReactivated.status === 200);
    const profile = await api('GET', `/api/admin/users/${testUser.json.user.id}`, null, adminToken);
    check('Admin can view full profile', profile.status === 200);
    const deleteUser = await api('DELETE', `/api/admin/users/${testUser.json.user.id}`, null, adminToken);
    check('Clean account can be deleted', deleteUser.status === 200);

  } finally {
    server.kill();
  }
  const failed = results.filter(r=>!r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) console.log('FAILED:', failed.map(f=>f.label));
})();
