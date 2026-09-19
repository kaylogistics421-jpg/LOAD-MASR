const { spawn } = require('child_process');
(async () => {
  const server = spawn('node', ['src/server.js'], { cwd: '/home/claude/loadmasr-backend' });
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

    // Sign up a NON-pioneer shipper (no promo code)
    const signup = await api('POST', '/api/auth/signup', {
      role:'shipper', name:'Regular Shipper Co', email:'regular@test.eg', phone:'0100000000', password:'testpass123', trn:'123', sijill:'CR-1'
    });
    check('Non-pioneer shipper signs up', signup.status === 201);
    check('Non-pioneer starts UNVERIFIED', !signup.json.user.verified);
    const shipperToken = signup.json.token;
    const shipperId = signup.json.user.id;

    // They can't select-plan their way to verified anymore
    const selectPlan = await api('POST', '/api/auth/select-plan', {plan:'Business'}, shipperToken);
    check('select-plan still records the plan choice', selectPlan.json.user.plan === 'Business');
    check('select-plan no longer auto-verifies (the actual fix)', !selectPlan.json.user.verified);

    const adminLogin = await api('POST', '/api/auth/login', {email:'admin@loadmasr.eg', password:'admin-seed-password'});
    const adminToken = adminLogin.json.token;

    // A carrier or shipper can't set fees
    const badAuth = await api('POST', `/api/admin/users/${shipperId}/set-fee`, {amount: 500}, shipperToken);
    check('Non-admin cannot set a fee (403)', badAuth.status === 403);

    // Admin sets a custom fee
    const setFee = await api('POST', `/api/admin/users/${shipperId}/set-fee`, {amount: 750, note: 'Standard tier'}, adminToken);
    check('Admin can set a custom fee amount', setFee.status === 201);
    check('The fee amount is exactly what the admin chose (750, not a fixed tier)', setFee.json.invoice.amount === 750);
    const invoiceId = setFee.json.invoice.id;

    // Shipper sees it in their own billing
    const myInvoices = await api('GET', '/api/invoices/mine', null, shipperToken);
    check('Shipper sees the real fee invoice in their own billing', myInvoices.json.invoices.some(i => i.id === invoiceId && i.amount === 750));

    // Shipper uploads a receipt (InstaPay proof)
    const fakeReceipt = Buffer.from('fake receipt image bytes').toString('base64');
    const uploadReceipt = await api('POST', `/api/invoices/${invoiceId}/receipt`, {filename:'instapay-receipt.png', mimeType:'image/png', base64Data: fakeReceipt}, shipperToken);
    check('Shipper can upload a real payment receipt', uploadReceipt.status === 200);
    check('Settlement moves to In Verification', uploadReceipt.json.invoice.settlement_status === 'In Verification');

    // Account is STILL not verified — only confirming activates it
    const stillPending = await api('GET', '/api/admin/queue?status=PENDING', null, adminToken);
    check('Account still shows unverified before admin confirms', stillPending.json.users.some(u => u.id === shipperId));

    // Admin sees it in payment verifications
    const paymentQueue = await api('GET', '/api/admin/payment-verifications', null, adminToken);
    check('Admin sees the fee invoice awaiting verification', paymentQueue.json.invoices.some(i => i.id === invoiceId));

    // Admin confirms — THIS is what activates the account
    const confirm = await api('POST', `/api/admin/invoices/${invoiceId}/confirm-settled`, {}, adminToken);
    check('Admin can confirm the payment', confirm.status === 200);
    check('Invoice now shows Paid', confirm.json.invoice.status === 'Paid');

    const finalUser = await api('GET', '/api/auth/me', null, shipperToken);
    check('Shipper account is NOW verified — confirming payment is what activated it', finalUser.json.user.verified === 1 || finalUser.json.user.verified === true);

    // A pioneer should be rejected if someone tries to set a fee on them
    const pioneerSignup = await api('POST', '/api/auth/signup', {
      role:'shipper', name:'Pioneer Co', email:'pio@test.eg', phone:'0100000000', password:'testpass', trn:'1', sijill:'CR-1', promoCode:'PIONEER3'
    });
    const feeOnPioneer = await api('POST', `/api/admin/users/${pioneerSignup.json.user.id}/set-fee`, {amount: 500}, adminToken);
    check('Setting a fee on a pioneer is correctly refused', feeOnPioneer.status === 400);

  } finally {
    server.kill();
  }
  const failed = results.filter(r=>!r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) console.log('FAILED:', failed.map(f=>f.label));
})();
