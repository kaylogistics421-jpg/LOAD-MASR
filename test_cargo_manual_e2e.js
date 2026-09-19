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
    await page.goto('http://localhost:4000/');
    await page.click('#btnModeShipper').catch(()=>{});
    await page.fill('#sliEmail', 'shipper@loadmasr.eg');
    await page.fill('#sliPassword', 'demo1234');
    await page.click('#shipperLoginSubmit');
    await page.waitForTimeout(500);
    await page.click('#dashboardShipper [data-view="mine"]');
    await page.waitForTimeout(200);

    // Cargo field is a real text input now, not a dropdown
    const tagName = await page.$eval('#lCargo', el => el.tagName);
    check('Cargo field is now an INPUT, not a SELECT', tagName === 'INPUT');

    // Empty cargo should be rejected
    await page.selectOption('#lOrigin', 'Cairo');
    await page.selectOption('#lDest', 'Suez');
    await page.fill('#lWeight', '3 tons');
    await page.fill('#lPickup', '2028-07-01');
    await page.click('#loadFormSubmit');
    await page.waitForTimeout(300);
    const emptyMsg = await page.$eval('#loadFormMsg', el => el.textContent);
    check('Submitting with no cargo description is correctly rejected', emptyMsg.toLowerCase().includes('describe') || emptyMsg.toLowerCase().includes('cargo'));

    // Now with a real, custom manual description (+ rate, since the demo shipper is Contract-tier and requires one)
    const customCargo = 'Prefabricated steel roof trusses, 12m span, 4 units';
    await page.fill('#lCargo', customCargo);
    await page.fill('#lRate', '15000');
    await page.click('#loadFormSubmit');
    await page.waitForTimeout(700);
    const successMsg = await page.$eval('#loadFormMsg', el => el.textContent);
    check('Submitting WITH a manual cargo description succeeds', successMsg.includes('live on the board'));

    // Confirm the exact custom text saved to the real database
    const loadsCheck = await fetch('http://localhost:4000/api/loads').then(r=>r.json());
    check('The exact manually-typed cargo description is saved to the real database', loadsCheck.loads.some(l=>l.cargo===customCargo));

    // Confirm it displays correctly in Search (a different session/role)
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await page2.goto('http://localhost:4000/');
    await page2.click('#btnModeCarrier').catch(()=>{});
    await page2.fill('#cliEmail', 'carrier@loadmasr.eg');
    await page2.fill('#cliPassword', 'demo1234');
    await page2.click('#carrierLoginSubmit');
    await page2.waitForTimeout(500);
    await page2.click('#dashboardCarrier [data-view="search"]');
    await page2.waitForTimeout(500);
    const searchText = await page2.$eval('#searchLoadsBody', el =>
      [...el.querySelectorAll('[title]')].some(el2 => el2.title.includes('Prefabricated steel roof trusses, 12m span, 4 units'))
    );
    check('The custom cargo description displays correctly to a carrier browsing Search (separate session)', searchText);

    await browser.close();
  } finally {
    server.kill();
  }
  const failed = results.filter(r=>!r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) console.log('FAILED:', failed.map(f=>f.label));
})();
