const { spawn } = require('child_process');
const { chromium } = require('playwright');
(async () => {
  const server = spawn('node', ['src/server.js'], { cwd: '/home/claude/loadmasr-backend' });
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

    // SESSION A: a non-pioneer shipper signs up through the real wizard
    const pageA = await browser.newPage();
    const errorsA = []; pageA.on('pageerror', e => errorsA.push(e.message));
    await pageA.goto('http://localhost:4000/');
    await pageA.click('#btnModeShipper').catch(()=>{});
    await pageA.click('#shipperTabSignup');
    await pageA.waitForTimeout(200);
    await pageA.click('#wizNextBtn'); // skip promo code
    await pageA.waitForTimeout(150);
    await pageA.fill('#wizCompanyName', 'FeeTest Shipping Co');
    await pageA.fill('#wizContactPerson', 'Fee Tester');
    await pageA.fill('#wizWhatsapp', '201077778888');
    await pageA.fill('#wizEmail', 'feetest@test.eg');
    await pageA.fill('#wizPassword', 'testpass123');
    await pageA.fill('#wizTrn', '111222333');
    await pageA.fill('#wizSijill', 'CR-9988');
    await pageA.click('#wizNextBtn');
    await pageA.waitForTimeout(150);
    await pageA.click('#wizSubmitBtn');
    await pageA.waitForTimeout(1200);
    await pageA.click('#wizDoneBtn').catch(()=>{});
    await pageA.waitForTimeout(500);

    // They land on pricing, unverified — pick Standard
    const chooseBtn = await pageA.$('#chooseStandardShipperPlan');
    check('New shipper reaches the pricing/pending screen', !!chooseBtn);
    if (chooseBtn) { await chooseBtn.click(); await pageA.waitForTimeout(700); }

    const feePanelText = await pageA.$eval('#shipperFeeStatusPanel', el => el.textContent).catch(()=>'');
    check('Shows "pending" status before any fee has been set', feePanelText.includes('pending') || feePanelText.toLowerCase().includes('pending'));

    // SESSION B: admin sets a real custom fee
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    const errorsB = []; pageB.on('pageerror', e => errorsB.push(e.message));
    await pageB.goto('http://localhost:4000/');
    await pageB.click('#btnModeAdmin').catch(async()=>{ await pageB.click('text=Admin'); });
    await pageB.waitForTimeout(200);
    await pageB.fill('#adminEmail', 'admin@loadmasr.eg');
    await pageB.fill('#adminPassword', 'admin-seed-password');
    await pageB.click('#adminGateSubmit');
    await pageB.waitForTimeout(700);

    const setFeeBtn = await pageB.$('[data-adm-setfee]');
    check('Admin sees a real Set Fee button for the new shipper', !!setFeeBtn);
    if (setFeeBtn) await setFeeBtn.click();
    await pageB.waitForTimeout(300);
    await pageB.fill('#admFeeAmount', '650');
    await pageB.fill('#admFeeNote', 'Pay via InstaPay to 01099998888');
    await pageB.click('#admFeeConfirm');
    await pageB.waitForTimeout(700);

    // BACK TO SESSION A — the shipper should now see the REAL fee amount and instructions
    await pageA.reload();
    await pageA.waitForTimeout(1000);
    const feePanelText2 = await pageA.$eval('#shipperFeeStatusPanel', el => el.textContent).catch(()=>'');
    check('Shipper (separate session) sees the REAL fee amount (650 EGP) the admin just set', feePanelText2.includes('650'));
    check('Shipper sees the real InstaPay instructions the admin wrote', feePanelText2.includes('01099998888'));

    // Shipper uploads a real receipt file
    const receiptInput = await pageA.$('#feeReceiptFile');
    check('Receipt upload field exists', !!receiptInput);
    if (receiptInput) {
      await receiptInput.setInputFiles('/home/claude/test_pod_photo.png');
      await pageA.click('#feeReceiptSubmit');
      await pageA.waitForTimeout(800);
    }
    const feePanelText3 = await pageA.$eval('#shipperFeeStatusPanel', el => el.textContent).catch(()=>'');
    check('Shows "verifying" status after receipt upload', feePanelText3.toLowerCase().includes('verif') || feePanelText3.toLowerCase().includes('received'));

    // BACK TO SESSION B (admin) — sees the real receipt and confirms.
    // The admin session now persists across a reload (just fixed), so this
    // is simply a fresh reload landing back on the already-logged-in panel.
    await pageB.reload();
    await pageB.waitForTimeout(1200);

    const confirmBtn = await pageB.$('[data-confirm-fee]');
    check('Admin sees the real receipt awaiting confirmation', !!confirmBtn);
    if (confirmBtn) { await confirmBtn.click(); await pageB.waitForTimeout(700); }

    // BACK TO SESSION A — the account should now be genuinely active
    await pageA.reload();
    await pageA.waitForTimeout(1000);
    const dashVisible = await pageA.$eval('#dashboardShipper', el => getComputedStyle(el).display).catch(()=>null);
    check('Shipper account is NOW active — confirming the payment is what activated it, proven cross-session', dashVisible === 'flex');

    console.log('Session A errors:', errorsA.join('\n') || '(none)');
    console.log('Session B errors:', errorsB.join('\n') || '(none)');
    await browser.close();
  } finally {
    server.kill();
  }
  const failed = results.filter(r=>!r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) console.log('FAILED:', failed.map(f=>f.label));
})();
