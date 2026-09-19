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

    await page.fill('#opsDriverName', 'Ahmed Samir');
    await page.click('#opsAddDriverBtn');
    await page.waitForTimeout(600);
    await page.fill('#opsShipperName', 'Delta Cement Co');
    await page.fill('#opsShipperPhone', '0221112222');
    await page.selectOption('#opsDriverSelect', { label: 'Ahmed Samir' });
    await page.fill('#opsOrigin', 'Beni Suef');
    await page.fill('#opsDest', 'Minya');
    await page.fill('#opsCargo', 'Cement bags');
    await page.fill('#opsRate', '9000');
    await page.fill('#opsAdvance', '800');
    await page.click('#opsLogShipmentBtn');
    await page.waitForTimeout(700);

    // Shipper document should be available immediately
    const shipperDocBtn = await page.$('[data-view-shipper-doc]');
    check('A real Shipper Document button appears right after logging', !!shipperDocBtn);
    if (shipperDocBtn) await shipperDocBtn.click();
    await page.waitForTimeout(300);
    const shipperDocText = await page.$eval('.invoice-doc', el => el.textContent).catch(()=>'');
    check('The real shipper document shows the real factory name and amount', shipperDocText.includes('Delta Cement Co') && shipperDocText.includes('9,000'));
    await page.click('#opsDocCloseBtn');
    await page.waitForTimeout(300);

    // Driver settlement should NOT be available yet (no actual tolls recorded)
    const settlementBtnBefore = await page.$('[data-view-driver-settlement]');
    check('Driver Settlement is correctly NOT available before delivery is recorded', !settlementBtnBefore);

    // Advance to delivery
    await page.click('[data-mark-transit]');
    await page.waitForTimeout(500);
    await page.click('[data-record-delivery]');
    await page.waitForTimeout(300);
    await page.fill('#opsActualTolls', '650');
    await page.click('#opsDeliveryConfirm');
    await page.waitForTimeout(700);

    const settlementBtn = await page.$('[data-view-driver-settlement]');
    check('Driver Settlement button now appears after delivery is recorded', !!settlementBtn);
    if (settlementBtn) await settlementBtn.click();
    await page.waitForTimeout(300);
    const settlementText = await page.$eval('.invoice-doc', el => el.textContent).catch(()=>'');
    check('The real driver settlement shows the real driver name, advance, tolls, and correct balance (150 owed back)', 
      settlementText.includes('Ahmed Samir') && settlementText.includes('800') && settlementText.includes('650') && settlementText.includes('150'));

    console.log('Page errors:', errors.join('\n') || '(none)');
    await browser.close();
  } finally {
    server.kill();
  }
  const failed = results.filter(r=>!r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) console.log('FAILED:', failed.map(f=>f.label));
})();
