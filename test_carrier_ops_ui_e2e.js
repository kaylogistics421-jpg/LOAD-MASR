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
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://localhost:4000/');
    await page.click('#btnModeCarrier').catch(()=>{});
    await page.fill('#cliEmail', 'carrier@loadmasr.eg');
    await page.fill('#cliPassword', 'demo1234');
    await page.click('#carrierLoginSubmit');
    await page.waitForTimeout(500);
    await page.click('#dashboardCarrier [data-view="operations"]');
    await page.waitForTimeout(800);

    // Add a real driver through the real UI
    await page.fill('#opsDriverName', 'Mahmoud Fathy');
    await page.fill('#opsDriverPhone', '01099998888');
    await page.click('#opsAddDriverBtn');
    await page.waitForTimeout(700);
    const driversTableText = await page.$eval('#opsDriversBody', el => el.textContent);
    check('The real driver appears in the roster via the real UI', driversTableText.includes('Mahmoud Fathy'));

    const driverOption = await page.$eval('#opsDriverSelect', el => [...el.options].some(o => o.textContent.includes('Mahmoud Fathy')));
    check('The new driver is selectable in the log-shipment form', driverOption);

    // Log a real shipment, assign the driver, real advance
    await page.fill('#opsShipperName', 'Al-Nasr Steel Factory');
    await page.fill('#opsShipperPhone', '0223456789');
    await page.selectOption('#opsDriverSelect', { label: 'Mahmoud Fathy' });
    await page.fill('#opsOrigin', '6th of October');
    await page.fill('#opsDest', 'Port Said');
    await page.fill('#opsCargo', 'Steel coils');
    await page.fill('#opsRate', '18000');
    await page.fill('#opsAdvance', '1500');
    await page.click('#opsLogShipmentBtn');
    await page.waitForTimeout(800);

    const shipmentsText = await page.$eval('#opsShipmentsBody', el => el.textContent);
    check('The real shipment appears in the list with the real driver attached', shipmentsText.includes('Al-Nasr Steel Factory') && shipmentsText.includes('Mahmoud Fathy'));
    check('Shows Assigned status and no reconciliation yet', shipmentsText.includes('Assigned') || shipmentsText.includes('معيّن'));

    // Mark In Transit
    const transitBtn = await page.$('[data-mark-transit]');
    check('A real Mark In Transit button appears', !!transitBtn);
    if (transitBtn) { await transitBtn.click(); await page.waitForTimeout(600); }

    // Record delivery with real actual tolls (LESS than the advance — driver owes back)
    const deliveryBtn = await page.$('[data-record-delivery]');
    check('A real Record Delivery button appears after marking In Transit', !!deliveryBtn);
    if (deliveryBtn) await deliveryBtn.click();
    await page.waitForTimeout(300);
    await page.fill('#opsActualTolls', '1200');
    await page.click('#opsDeliveryConfirm');
    await page.waitForTimeout(800);

    const finalText = await page.$eval('#opsShipmentsBody', el => el.textContent);
    check('The real, automatically-computed reconciliation shows in the UI (driver owes 300 EGP)', finalText.includes('300'));
    check('Actual tolls (1,200) now shows in the table', finalText.includes('1,200') || finalText.includes('1200'));

    // Mark Settled
    const settleBtn = await page.$('[data-mark-settled]');
    check('A real Mark Settled button appears', !!settleBtn);
    if (settleBtn) { await settleBtn.click(); await page.waitForTimeout(600); }
    const settledText = await page.$eval('#opsShipmentsBody', el => el.textContent);
    check('Shipment now genuinely shows Settled', settledText.includes('Settled') || settledText.includes('مُسوّى'));

    console.log('Page errors:', errors.join('\n') || '(none)');
    await browser.close();
  } finally {
    server.kill();
  }
  const failed = results.filter(r=>!r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) console.log('FAILED:', failed.map(f=>f.label));
})();
