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
    const page = await browser.newPage();
    const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));

    await page.goto('http://localhost:4000/');
    await page.click('#btnModeCarrier').catch(()=>{});
    await page.click('#carrierTabSignup');
    await page.waitForTimeout(200);
    const uniqueEmail = `e2e_carrier_${Date.now()}@test.eg`;
    await page.fill('#cwFleetName', 'E2E Backend Test Fleet');
    await page.fill('#cwManagerName', 'Test Manager');
    await page.fill('#cwWhatsapp', '201044443333');
    await page.fill('#cwEmail', uniqueEmail);
    await page.fill('#cwPassword', 'carrierpass123');
    await page.click('#cwNextBtn');
    await page.waitForTimeout(200);
    await page.check('.cwCat >> nth=0');
    await page.fill('#cwFleetCount', '6');
    await page.selectOption('#cwGovs', ['Cairo']);
    await page.click('#cwNextBtn');
    await page.waitForTimeout(200);
    await page.fill('#cwNationalId', '29001011234567');
    await page.fill('#cwLicenseNo', 'LIC-E2E-1');
    await page.click('#cwSubmitBtn');
    await page.waitForTimeout(1200);
    const step4Title = await page.$eval('.modal-title', el => el.textContent).catch(()=>'MISSING');
    check('Carrier wizard reaches activation step against the real backend', step4Title.includes('Activated'));

    await page.click('#cwDoneBtn');
    await page.waitForTimeout(300);
    const dashVisible = await page.$eval('#dashboardCarrier', el => getComputedStyle(el).display).catch(()=>null);
    check('Lands on a real, working dashboard immediately (30-day trial auto-verified)', dashVisible === 'flex');

    // Post a truck as this brand-new carrier, confirm it persists server-side
    await page.click('#dashboardCarrier [data-view="mine"]');
    await page.waitForTimeout(200);
    await page.selectOption('#pOrigin', 'Alexandria');
    await page.fill('#pCapacity', 'New Carrier Test Truck');
    await page.fill('#pAvail', '2028-08-01');
    await page.click('#truckFormSubmit');
    await page.waitForTimeout(600);
    const dbCheck = await fetch('http://localhost:4000/api/trucks').then(r=>r.json());
    check('New carrier can immediately post a real truck that persists to the DB', dbCheck.trucks.some(t=>t.capacity==='New Carrier Test Truck'));

    console.log('Page errors:', pageErrors.join('\n') || '(none)');
    await browser.close();
  } finally {
    server.kill();
  }
  const failed = results.filter(r=>!r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
})();
