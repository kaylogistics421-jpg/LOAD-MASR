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
    const carrierToken = (await api('POST','/api/auth/login',{email:'carrier@loadmasr.eg',password:'demo1234'})).json.token;
    const shipperToken = (await api('POST','/api/auth/login',{email:'shipper@loadmasr.eg',password:'demo1234'})).json.token;

    // Only carriers can use this
    const shipperTry = await api('POST','/api/drivers',{name:'Test Driver'},shipperToken);
    check('A shipper cannot create a driver (carrier-only)', shipperTry.status === 403);

    // Add a real driver
    const driver = await api('POST','/api/drivers',{name:'Mahmoud Fathy',phone:'01099998888'},carrierToken);
    check('Carrier can add a real driver', driver.status === 201);
    const driverId = driver.json.driver.id;

    const myDrivers = await api('GET','/api/drivers/mine',null,carrierToken);
    check('Driver appears in the real roster', myDrivers.json.drivers.some(d=>d.id===driverId));

    // Log a shipment from the factory email, assign the driver, give a cash advance
    const shipment = await api('POST','/api/carrier-shipments',{
      shipperName:'Al-Nasr Steel Factory', shipperPhone:'0223456789',
      origin:'6th of October', dest:'Port Said', cargo:'Steel coils', weight:'20 tons',
      pickupDate:'2028-03-01', rate:18000, driverId, advanceAmount:1500
    },carrierToken);
    check('Carrier can log a real off-platform shipment', shipment.status === 201);
    const shipmentId = shipment.json.shipment.id;
    check('Shipment starts as Assigned', shipment.json.shipment.status === 'Assigned');
    check('Advance amount recorded correctly (1500)', shipment.json.shipment.advance_amount === 1500);

    const mine = await api('GET','/api/carrier-shipments/mine',null,carrierToken);
    const found = mine.json.shipments.find(s=>s.id===shipmentId);
    check('Shipment appears in the real list, with the real driver name attached', found && found.driver_name === 'Mahmoud Fathy');
    check('No reconciliation yet (actual tolls not recorded)', found.driver_balance === null);

    // Driver returns — mark delivered, record actual tolls SPENT LESS than the advance (driver owes back)
    const deliver = await api('PATCH',`/api/carrier-shipments/${shipmentId}`,{status:'Delivered', actualTolls:1200},carrierToken);
    check('Marking delivered + recording actual tolls works', deliver.status === 200);
    check('Reconciliation computed correctly: driver owes back 300 EGP (1500 advance - 1200 spent)', deliver.json.shipment.driver_balance === 300);
    check('delivered_at was set automatically', !!deliver.json.shipment.delivered_at);

    // A DIFFERENT shipment where the driver spent MORE than the advance (carrier owes driver more)
    const shipment2 = await api('POST','/api/carrier-shipments',{
      shipperName:'Al-Nasr Steel Factory', origin:'Cairo', dest:'Aswan', rate:22000, driverId, advanceAmount:1000
    },carrierToken);
    const deliver2 = await api('PATCH',`/api/carrier-shipments/${shipment2.json.shipment.id}`,{status:'Delivered', actualTolls:1400},carrierToken);
    check('Negative balance correctly computed when driver spent MORE than the advance (-400)', deliver2.json.shipment.driver_balance === -400);

    // Mark settled
    const settle = await api('PATCH',`/api/carrier-shipments/${shipmentId}`,{status:'Settled'},carrierToken);
    check('Shipment can be marked Settled', settle.json.shipment.status === 'Settled');
    check('settled_at was set automatically', !!settle.json.shipment.settled_at);

    // A carrier cannot see another carrier's shipments (basic isolation check — reuse shipper login as a stand-in unauthorized party)
    const wrongRole = await api('GET','/api/carrier-shipments/mine',null,shipperToken);
    check('A shipper cannot access carrier-shipments endpoints', wrongRole.status === 403);

    // Deactivate a driver
    const deactivate = await api('PATCH',`/api/drivers/${driverId}`,{active:false},carrierToken);
    check('Driver can be deactivated', deactivate.json.driver.active === 0);

  } finally {
    server.kill();
  }
  const failed = results.filter(r=>!r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) console.log('FAILED:', failed.map(f=>f.label));
})();
