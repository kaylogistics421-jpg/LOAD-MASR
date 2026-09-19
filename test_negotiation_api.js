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
    let ready = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 300));
      try { const res = await fetch('http://localhost:4000/api/health'); if (res.ok) { ready = true; break; } } catch(e) {}
    }
    check('Server started', ready);

    const shipperLogin = await api('POST','/api/auth/login',{email:'shipper@loadmasr.eg',password:'demo1234'});
    const carrierLogin = await api('POST','/api/auth/login',{email:'carrier@loadmasr.eg',password:'demo1234'});
    const shipperToken = shipperLogin.json.token, carrierToken = carrierLogin.json.token;

    // Shipper posts a load
    const loadRes = await api('POST','/api/loads',{origin:'Cairo',dest:'Suez',cargo:'General cargo',equip:'Flatbed',weight:'3 tons',pickupDate:'2028-01-01',rate:20000},shipperToken);
    const loadId = loadRes.json.load.id;

    // Carrier proposes an offer on that load
    const propose = await api('POST','/api/negotiations',{targetType:'load',targetId:loadId,price:18000,note:'first offer'},carrierToken);
    check('Carrier can propose an offer on a load', propose.status === 201);
    const negId = propose.json.negotiation.id;

    // Shipper fetches it and sees the real offer
    const fetched = await api('GET',`/api/negotiations/load/${loadId}`,null,shipperToken);
    check('Shipper can see the real offer the carrier made', fetched.json.negotiation.offers_json ? JSON.parse(fetched.json.negotiation.offers_json)[0].price === 18000 : false);

    // Shipper declines (stays open)
    const decline = await api('POST',`/api/negotiations/${negId}/decline`,{},shipperToken);
    check('Decline keeps the negotiation open (status still Pending)', decline.json.negotiation.status === 'Pending');
    check('Decline correctly flags who declined', decline.json.negotiation.declined_by === 'shipper');

    // Carrier counters
    const counter = await api('POST',`/api/negotiations/${negId}/offers`,{price:19000,note:'counter'},carrierToken);
    check('Carrier can counter after a decline', counter.status === 200);
    check('Countering clears the declined flag', counter.json.negotiation.declined_by === null);

    // Shipper accepts
    const accept = await api('POST',`/api/negotiations/${negId}/accept`,{},shipperToken);
    check('Shipper can accept the negotiation', accept.json.negotiation.status === 'Accepted');

    // Confirm the load is now Pending (booked)
    const loadCheck = await fetch('http://localhost:4000/api/loads').then(r=>r.json());
    const bookedLoad = loadCheck.loads.find(l=>l.id===loadId);
    check('The load itself is no longer Active (booked) after acceptance', !bookedLoad || bookedLoad.status !== 'Active');

    // --- Now test the TRUCK direction ---
    const truckRes = await api('POST','/api/trucks',{origin:'Alexandria',dest:'',equip:'Flatbed',capacity:'5 tons',availDate:'2028-02-01'},carrierToken);
    const truckId = truckRes.json.truck.id;
    const truckReq = await api('POST','/api/negotiations',{
      targetType:'truck', targetId:truckId, price:15000, note:'shipper request',
      pickupDate:'2028-02-01', pickupGov:'Alexandria', deliveryGov:'Cairo', cargo:'Containers', weight:'2 tons'
    }, shipperToken);
    check('Shipper can request a truck', truckReq.status === 201);
    const truckNegId = truckReq.json.negotiation.id;

    const truckAccept = await api('POST',`/api/negotiations/${truckNegId}/accept`,{},carrierToken);
    check('Carrier can accept a truck request', truckAccept.json.negotiation.status === 'Accepted');
    check('Accepting a truck request creates a REAL linked, trackable load', !!truckAccept.json.linkedLoadId);

    const linkedLoad = await fetch('http://localhost:4000/api/loads').then(r=>r.json())
      .then(d => d.loads.find(l=>l.id===truckAccept.json.linkedLoadId));
    // it won't be in /api/loads since it's status Pending (booked), check via admin
    const adminLogin = await api('POST','/api/auth/login',{email:'admin@loadmasr.eg',password:'admin-seed-password'});
    const allLoads = await api('GET','/api/admin/loads',null,adminLogin.json.token);
    const foundLinked = allLoads.json.loads.find(l=>l.id===truckAccept.json.linkedLoadId);
    check('The linked load genuinely exists with tracking_stage Booked', foundLinked && foundLinked.tracking_stage === 'Booked');
    check('The linked load correctly carries the negotiated rate (15000)', foundLinked && foundLinked.rate === 15000);

  } finally {
    server.kill();
  }
  const failed = results.filter(r=>!r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
})();
