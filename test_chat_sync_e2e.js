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
    const browser = await chromium.launch();

    // Session A: shipper posts a load, session B (carrier) makes an offer —
    // entirely via the UI, matching how a real negotiation starts
    const pageA = await browser.newPage();
    await pageA.goto('http://localhost:4000/');
    await pageA.click('#btnModeShipper').catch(()=>{});
    await pageA.fill('#sliEmail', 'shipper@loadmasr.eg');
    await pageA.fill('#sliPassword', 'demo1234');
    await pageA.click('#shipperLoginSubmit');
    await pageA.waitForTimeout(500);
    await pageA.click('#dashboardShipper [data-view="mine"]');
    await pageA.waitForTimeout(200);
    await pageA.selectOption('#lOrigin', 'Cairo');
    await pageA.selectOption('#lDest', 'Aswan');
    await pageA.fill('#lWeight', '2 tons');
    await pageA.fill('#lPickup', '2028-05-01');
    await pageA.fill('#lCargo', 'Test cargo description');
    await pageA.fill('#lRate', '22000');
    await pageA.click('#loadFormSubmit');
    await pageA.waitForTimeout(600);

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await pageB.goto('http://localhost:4000/');
    await pageB.click('#btnModeCarrier').catch(()=>{});
    await pageB.fill('#cliEmail', 'carrier@loadmasr.eg');
    await pageB.fill('#cliPassword', 'demo1234');
    await pageB.click('#carrierLoginSubmit');
    await pageB.waitForTimeout(500);
    await pageB.click('#dashboardCarrier [data-view="search"]');
    await pageB.waitForTimeout(400);
    const rows = await pageB.$$('#searchLoadsBody tr.row-clickable');
    let target;
    for (const r of rows) { if ((await r.textContent()).includes('22,000')) { target = r; break; } }
    await target.click();
    await pageB.waitForTimeout(200);
    await pageB.click('[data-request-id]');
    await pageB.waitForTimeout(200);
    await pageB.fill('#offEmptyDate', '2028-05-01');
    await pageB.selectOption('#offTruckGov', 'Cairo');
    await pageB.fill('#reqOfferPrice', '19500');
    await pageB.click('#reqSendBtn');
    await pageB.waitForTimeout(700);

    // Session A: go DIRECTLY to Chat tab — NOT the load detail panel first —
    // and confirm the real offer already shows up there
    await pageA.click('#dashboardShipper [data-view="chat"]');
    await pageA.waitForTimeout(1000);
    const chatListText = await pageA.$eval('#shipperChatList', el => el.textContent);
    check('Chat tab shows a real thread without ever visiting the load detail panel first', chatListText.includes('19,500') || chatListText.includes('19500'));

    await browser.close();
  } finally {
    server.kill();
  }
  const failed = results.filter(r=>!r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
})();
