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
    const page = await browser.newPage({viewport:{width:1000,height:600}});
    await page.goto('http://localhost:4000/');
    await page.click('#btnModeShipper').catch(()=>{});
    await page.waitForTimeout(700);

    const pageText = await page.content();
    check('The real slot number (17) never appears anywhere on the shipper landing page', !pageText.includes('>17<') && !/\b17\s+(of|registered|Founding)/i.test(pageText));

    const heroStatText = await page.$eval('#authHeroPioneerSlots', el => el.textContent);
    check('The hero stat shows "Limited", not a number', heroStatText === 'Limited' && !/\d/.test(heroStatText));

    const bannerText = await page.$eval('#pioneerBannerText', el => el.textContent);
    check('The banner text has no specific slot count (ignoring "100%")', !/\b\d+\b/.test(bannerText.replace('100%','')));

    // Sign up with the pioneer code — validation logic must still genuinely work
    await page.click('#shipperTabSignup');
    await page.waitForTimeout(200);
    await page.fill('#wizPromo', 'PIONEER3');
    await page.click('#wizNextBtn');
    await page.waitForTimeout(300);
    const promoValidText = await page.$eval('.modal-box, [class*="wiz"]', el => el.innerText).catch(()=>'');
    check('The promo-code acceptance screen also has no visible slot count', !/\b17\b/.test(promoValidText));

    // Admin settings panel SHOULD still show the real number — it's not shipper-facing
    const page2 = await browser.newPage();
    await page2.goto('http://localhost:4000/');
    await page2.click('#btnModeAdmin').catch(async()=>{ await page2.click('text=Admin'); });
    await page2.waitForTimeout(200);
    await page2.fill('#adminEmail', 'admin@loadmasr.eg');
    await page2.fill('#adminPassword', 'admin-seed-password');
    await page2.click('#adminGateSubmit');
    await page2.waitForTimeout(800);
    const adminSettingValue = await page2.$eval('#admSettingPioneerSlots', el => el.value).catch(()=>'MISSING');
    check('The ADMIN settings panel still shows the real, editable number (17) — this is not shipper-facing', adminSettingValue === '17');

    await browser.close();
  } finally {
    server.kill();
  }
  const failed = results.filter(r=>!r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) console.log('FAILED:', failed.map(f=>f.label));
})();
