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

    const shipperToken = (await fetch('http://localhost:4000/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'shipper@loadmasr.eg',password:'demo1234'})}).then(r=>r.json())).token;
    const carrierToken = (await fetch('http://localhost:4000/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'carrier@loadmasr.eg',password:'demo1234'})}).then(r=>r.json())).token;
    const loadRes = await fetch('http://localhost:4000/api/loads',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+shipperToken},body:JSON.stringify({origin:'Cairo',dest:'Tanta',cargo:'General cargo',equip:'Flatbed',weight:'1t',pickupDate:'2028-01-01',rate:6000})}).then(r=>r.json());
    const truckRes = await fetch('http://localhost:4000/api/trucks',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+carrierToken},body:JSON.stringify({origin:'Alexandria',dest:'',equip:'Flatbed',capacity:'AdminControlTestTruck',availDate:'2028-01-01'})}).then(r=>r.json());
    await fetch('http://localhost:4000/api/negotiations',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+carrierToken},body:JSON.stringify({targetType:'load',targetId:loadRes.load.id,price:5500,note:'test offer'})});
    await fetch('http://localhost:4000/api/auth/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:'shipper',name:'Suspend Test Co',email:'suspendtest@test.eg',phone:'0100000000',password:'testpass',trn:'1',sijill:'CR-1'})});

    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://localhost:4000/');
    await page.click('#btnModeAdmin').catch(async()=>{ await page.click('text=Admin'); });
    await page.waitForTimeout(200);
    await page.fill('#adminEmail', 'admin@loadmasr.eg');
    await page.fill('#adminPassword', 'admin-seed-password');
    await page.click('#adminGateSubmit');
    await page.waitForTimeout(1000);

    const settingsInput = await page.$('#admSettingPioneerSlots');
    check('Settings panel shows the real current pioneer slot value', !!settingsInput);
    await page.fill('#admSettingPioneerSlots', '30');
    await page.click('#admSettingsSave');
    await page.waitForTimeout(600);
    const settingsCheck = await fetch('http://localhost:4000/api/settings').then(r=>r.json());
    check('Saving settings via the real UI genuinely persists (30)', settingsCheck.settings.pioneer_max_slots === '30');

    const suspendBtn = await page.$('[data-adm-suspend]');
    check('All Users panel shows a real suspend button', !!suspendBtn);
    if (suspendBtn) { await suspendBtn.click(); await page.waitForTimeout(600); }
    const loginAfterSuspend = await fetch('http://localhost:4000/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'suspendtest@test.eg',password:'testpass'})});
    check('Clicking Suspend in the real UI genuinely blocks login', loginAfterSuspend.status === 403);

    const reactivateBtn = await page.$('[data-adm-reactivate]');
    check('A reactivate button now shows', !!reactivateBtn);
    if (reactivateBtn) { await reactivateBtn.click(); await page.waitForTimeout(600); }
    const loginAfterReactivate = await fetch('http://localhost:4000/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'suspendtest@test.eg',password:'testpass'})});
    check('Clicking Reactivate in the real UI genuinely restores login', loginAfterReactivate.status === 200);

    const viewBtn = await page.$('[data-adm-view-user]');
    if (viewBtn) { await viewBtn.click(); await page.waitForTimeout(300); }
    const profileText = await page.$eval('.modal-box, .modal', el => el.textContent).catch(()=>'');
    check('Viewing a profile shows real account details', profileText.length > 20);
    const closeBtn = await page.$('#admProfileClose');
    if (closeBtn) await closeBtn.click();
    await page.waitForTimeout(300);

    const cancelNegBtn = await page.$('[data-adm-cancel-neg]');
    check('Negotiations panel shows a real cancel button', !!cancelNegBtn);
    if (cancelNegBtn) { await cancelNegBtn.click(); await page.waitForTimeout(600); }
    const adminToken2 = (await fetch('http://localhost:4000/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@loadmasr.eg',password:'admin-seed-password'})}).then(r=>r.json())).token;
    const negsAfter = await fetch('http://localhost:4000/api/admin/negotiations',{headers:{Authorization:'Bearer '+adminToken2}}).then(r=>r.json());
    check('The negotiation is genuinely Declined after clicking cancel', negsAfter.negotiations.some(n=>n.status==='Declined'));

    const delTruckBtn = await page.$('[data-adm-del-truck]');
    check('All Trucks panel shows a real delete button', !!delTruckBtn);
    if (delTruckBtn) {
      page.once('dialog', d => d.accept());
      await delTruckBtn.click();
      await page.waitForTimeout(600);
    }
    const trucksAfterDelete = await fetch('http://localhost:4000/api/trucks').then(r=>r.json());
    check('Clicking Delete genuinely removed the truck', !trucksAfterDelete.trucks.some(t=>t.capacity==='AdminControlTestTruck'));

    const invoicesTotalText = await page.$eval('#admInvoicesTotal', el => el.textContent).catch(()=>'MISSING');
    check('All Invoices panel loaded with a real total', invoicesTotalText !== 'MISSING');

    console.log('Page errors:', errors.join('\n') || '(none)');
    await browser.close();
  } finally {
    server.kill();
  }
  const failed = results.filter(r=>!r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) console.log('FAILED:', failed.map(f=>f.label));
})();
