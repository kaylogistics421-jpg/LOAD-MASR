const { seedDemoAccountsIfEmpty } = require('./src/seed-demo-accounts');
const result = seedDemoAccountsIfEmpty();
if (result.seeded && result.demoAccountsCreated) {
  console.log('Seeded admin, carrier@loadmasr.eg, shipper@loadmasr.eg (all password: demo1234, admin: admin-seed-password)');
  console.log('carrierId:', result.carrierId, 'shipperId:', result.shipperId);
} else if (result.seeded) {
  console.log('Seeded admin only (admin@loadmasr.eg). Set SEED_DEMO_ACCOUNTS=true first to also get the demo shipper/carrier accounts.');
} else {
  console.log('Database already has accounts — nothing to seed. (Delete data/loadmasr.db to start fresh.)');
}
