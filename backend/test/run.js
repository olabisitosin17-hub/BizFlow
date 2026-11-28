'use strict';
// End-to-end tests against a real PostgreSQL database (set DATABASE_URL).
// Creates an isolated test business (code with a random suffix) and cleans up after itself,
// so it is safe to run against a dev database.
//
// Run: npm test   (reads .env via --env-file)
const assert = require('node:assert/strict');
const { getPool, query, close } = require('../src/db');
const { setupServices } = require('../src/setup');
const router = require('../src/router');
const core = require('../src/core');

// Isolated unique code so repeated runs don't collide.
const CODE = 'T' + Math.random().toString(36).slice(2, 8).toUpperCase();
const BIZNAME = 'Test Shop ' + CODE;
let BIZ_ID;

async function seedBusiness() {
  await query('DELETE FROM businesses WHERE code = $1', [CODE]);
  const ins = await query(
    `INSERT INTO businesses (code, name, app, active) VALUES ($1,$2,'SALES',TRUE) RETURNING id`,
    [CODE, BIZNAME]
  );
  BIZ_ID = ins.rows[0].id;
  await query(
    `INSERT INTO businesses (code, name, app, active) VALUES ($1,$2,'SERVICES',TRUE) RETURNING id`,
    [CODE, BIZNAME]
  );
  await setupServices(CODE, BIZNAME);
}

const sales = (fn, ...args) => core.call({ code: CODE, app: 'sales', fn, args });
const svc = (fn, ...args) => core.call({ code: CODE, app: 'services', fn, args });

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failures.push(name + ': ' + (e.stack || e.message)); console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — tests need a PostgreSQL database.');
    process.exit(2);
  }
  try { await getPool().query('SELECT 1'); }
  catch (e) { console.error('Cannot reach DATABASE_URL: ' + e.message); process.exit(2); }

  await seedBusiness();

  console.log('Router');
  await test('session: two apps -> choose-an-app', async () => {
    const r = await router.session({ code: CODE });
    assert.equal(r.mode, 'select');
    assert.deepEqual(r.apps, ['sales', 'services']);
    assert.equal(r.bizName, BIZNAME);
  });
  await test('session: wrong PIN', async () => {
    assert.equal((await router.session({ code: 'NOPE-X' })).mode, 'login');
  });
  await test('session: direct app link', async () => {
    assert.equal((await router.session({ code: CODE, app: 'sales' })).mode, 'app');
  });
  await test('check: right and wrong app', async () => {
    assert.equal(await router.check({ code: CODE, app: 'sales' }), BIZNAME);
    await assert.rejects(router.check({ code: 'NOPE-X', app: 'sales' }), /Invalid business code/);
  });
  await test('unknown action is refused', async () => {
    await assert.rejects(core.call({ code: CODE, app: 'sales', fn: 'deleteEverything', args: [] }), /Unknown action/);
  });

  console.log('Sales app');
  let prodId, custId;
  await test('add product, then restock the same name', async () => {
    const p = await sales('addProduct', { name: 'Soap', category: 'Care', costPrice: 100, sellingPrice: 150, stock: 10, unit: 'pcs' });
    prodId = p.id; assert.equal(p.existing, false); assert.match(prodId, /^prd0001$/);
    const again = await sales('addProduct', { name: 'soap', stock: 5 });
    assert.equal(again.existing, true); assert.equal(again.stock, 15);
  });
  await test('customers: phone keeps leading zero, same phone = same customer', async () => {
    const c = await sales('addCustomer', { name: 'Ada', phone: '08024795274' });
    custId = c.id; assert.equal(c.phone, '08024795274');
    const same = await sales('addCustomer', { name: 'Ada O', phone: '+234 802 479 5274' });
    assert.equal(same.existing, true); assert.equal(same.id, custId);
    const list = await sales('getCustomersList');
    assert.equal(list.length, 1); assert.equal(String(list[0].Phone), '08024795274');
    assert.equal(typeof list[0].DateAdded, 'string');
  });
  await test('save a sale: totals, stock, sale items, customer total', async () => {
    const s = await sales('saveSale', { customerId: custId, customerName: 'Ada', items: [{ productId: prodId, name: 'Soap', qty: 2, price: 150 }], discountPercent: 10, paymentMethod: 'Cash' });
    assert.equal(s.subtotal, 300); assert.equal(s.total, 270); assert.match(s.receiptId, /^rec0001$/);
    const prod = await query('SELECT stock FROM sales_products WHERE business_id=$1 AND product_id=$2', [BIZ_ID, prodId]);
    assert.equal(Number(prod.rows[0].stock), 13);
    const items = await query('SELECT COUNT(*)::int AS n FROM sales_sale_items WHERE business_id=$1', [BIZ_ID]);
    assert.equal(items.rows[0].n, 1);
    assert.equal((await sales('getCustomersList'))[0].TotalPurchases, 270);
  });
  await test('stock can not go below zero', async () => {
    await assert.rejects(sales('saveSale', { items: [{ productId: prodId, name: 'Soap', qty: 99, price: 150 }] }), /left in stock|out of stock/);
    const prod = await query('SELECT stock FROM sales_products WHERE business_id=$1 AND product_id=$2', [BIZ_ID, prodId]);
    assert.equal(Number(prod.rows[0].stock), 13);
  });
  await test('history, receipt page and PDF data', async () => {
    const h = await sales('getSalesHistory', 10);
    assert.equal(h.length, 1); assert.equal(h[0].total, 270); assert.ok(!isNaN(new Date(h[0].date)));
    const html = await sales('getReceiptHtml', h[0].saleId);
    assert.match(html, new RegExp(BIZNAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); assert.match(html, /rec0001/);
    const pdf = await sales('getReceiptPdf', h[0].saleId);
    assert.equal(pdf.name, 'rec0001.pdf'); assert.ok(pdf.base64.length > 0);
  });
  await test('three people saving at the same moment never clash', async () => {
    const jobs = [1, 2, 3].map(i => sales('saveSale', { customerName: 'Walk-in ' + i, items: [{ productId: prodId, name: 'Soap', qty: 1, price: 150 }], discount: 0, paymentMethod: 'Cash' }));
    const out = await Promise.all(jobs);
    const ids = out.map(o => o.saleId).concat(out.map(o => o.receiptId));
    assert.equal(new Set(ids).size, 6);
    const prod = await query('SELECT stock FROM sales_products WHERE business_id=$1 AND product_id=$2', [BIZ_ID, prodId]);
    assert.equal(Number(prod.rows[0].stock), 10);
  });
  await test('categories and running expenses', async () => {
    const cats = await sales('getCategoriesList');
    assert.ok(cats.length > 0);
    await sales('addRunningExpense', { category: 'Fuel', description: 'Diesel', amount: 5000, date: '2026-11-20' });
    const exp = await sales('getRunningExpenses');
    assert.equal(exp.length, 1);
  });

  console.log('Services app');
  await test('setup created starter services', async () => {
    assert.ok((await svc('getAllServices')).length >= 5);
  });
  await test('record a service sale with a new customer and 10% discount', async () => {
    const services = await svc('getAllServices');
    const first = services[0];
    const sale = await svc('recordSale', {
      newCustomer: { name: 'Bola', phone: '08031234567' },
      items: [{ serviceName: first.Name, qty: 2, unitPrice: Number(first.Price) }],
      discountPercent: 10, paymentMethod: 'Cash'
    });
    const id = sale.saleId || sale.SaleID;
    assert.ok(id);
    const html = await svc('getReceiptHtml', id);
    assert.match(html, /REC0001/); assert.match(html, /Discount/);
    const pdf = await svc('getReceiptPdf', id);
    assert.equal(pdf.name, 'REC0001.pdf');
    const init = await svc('getInitData');
    assert.ok(init);
  });
  await test('expenses, reports and settings', async () => {
    await svc('addExpense', { category: 'Fuel', description: 'Generator', amount: 2500 });
    const ex = await svc('getExpenses');
    assert.equal(ex.length, 1); assert.equal(typeof ex[0].Date, 'string');
    const rep = await svc('getReportSummary', '', '');
    assert.ok(rep);
    const s = await svc('updateBusinessSettings', { BusinessName: 'Renamed Shop' });
    assert.equal(s.BusinessName, 'Renamed Shop');
  });
  await test('customer spend aggregates', async () => {
    const list = await svc('getCustomersWithSpend');
    assert.ok(list.some(c => c.Name === 'Bola'));
  });

  console.log('Onboarding');
  const onboarding = require('../src/onboarding');
  const { createHash } = require('node:crypto');
  const EMAIL = 'owner+' + CODE.toLowerCase() + '@example.com';
  const PASSWORD = 'correct horse battery';

  await test('register creates a PENDING account (no email provider needed)', async () => {
    const r = await onboarding.register({ businessName: 'Onboard Co', email: EMAIL, password: PASSWORD, appVersion: 'BOTH' });
    assert.equal(r.status, 'pending_verification');
    const acc = await query('SELECT status FROM accounts WHERE lower(email) = lower($1)', [EMAIL]);
    assert.equal(acc.rows[0].status, 'PENDING');
  });
  await test('duplicate email is rejected while pending (resends, not duplicates)', async () => {
    await onboarding.register({ businessName: 'Other Co', email: EMAIL, password: PASSWORD, appVersion: 'SALES' });
    const n = await query('SELECT COUNT(*)::int AS c FROM accounts WHERE lower(email) = lower($1)', [EMAIL]);
    assert.equal(n.rows[0].c, 1);
  });
  await test('login is refused until email is verified', async () => {
    await assert.rejects(onboarding.login({ email: EMAIL, password: PASSWORD }), /verify your email/i);
  });
  await test('verify provisions business(es), activates account, allows login + isolation', async () => {
    // Read the raw token from the DB row is impossible (hashed); instead mint a fresh one via register
    // and read its hash back to confirm storage, then verify by direct call using the token we can't know.
    // To verify end-to-end we recompute: we can't reverse a hash, so insert a known token.
    const acc = (await query('SELECT id FROM accounts WHERE lower(email)=lower($1)', [EMAIL])).rows[0];
    const raw = 'testtoken-' + CODE;
    const hash = createHash('sha256').update(raw).digest('hex');
    await query('UPDATE email_verifications SET consumed_at = now() WHERE account_id = $1', [acc.id]);
    await query('INSERT INTO email_verifications (account_id, token_hash, expires_at) VALUES ($1,$2,$3)', [acc.id, hash, new Date(Date.now() + 3600000)]);

    const v = await onboarding.verifyEmail(raw);
    assert.equal(v.status, 'active');
    const st = await query('SELECT status FROM accounts WHERE id = $1', [acc.id]);
    assert.equal(st.rows[0].status, 'ACTIVE');

    const account = await query('SELECT business_code FROM accounts WHERE id = $1', [acc.id]);
    const businessCode = account.rows[0].business_code;
    const biz = await query('SELECT code, app, account_id FROM businesses WHERE account_id = $1 ORDER BY app', [businessCode]);
    assert.equal(biz.rows.length, 2);                          // BOTH -> SALES + SERVICES
    assert.ok(biz.rows[0].code && biz.rows[0].code === biz.rows[1].code);   // same code
    assert.ok(biz.rows.every(row => row.account_id === businessCode));

    const login = await onboarding.login({ email: EMAIL, password: PASSWORD });
    assert.ok(login.session && login.code);
    assert.deepEqual(login.apps, ['sales', 'services']);

    // Session resolves to the same code (used to scope /api/call)
    const sess = await onboarding.sessionFor(login.session);
    assert.equal(sess.code, login.code);

    // Login app access follows the selected version in the account record.
    await query("UPDATE accounts SET app_version = 'SALES' WHERE id = $1", [acc.id]);
    const salesOnlyLogin = await onboarding.login({ email: EMAIL, password: PASSWORD });
    assert.deepEqual(salesOnlyLogin.apps, ['sales']);
    assert.deepEqual((await onboarding.sessionFor(login.session)).apps, ['sales']);

    // The provisioned Sales workspace works and is independent
    const code = login.code;
    const list = await core.call({ code, app: 'sales', fn: 'getProductsList', args: [] });
    assert.ok(Array.isArray(list));
  });
  await test('login links orphaned workspaces and provisions when none match', async () => {
    const acc = (await query('SELECT id, business_code FROM accounts WHERE lower(email)=lower($1)', [EMAIL])).rows[0];
    await query('DELETE FROM businesses WHERE account_id = $1', [acc.business_code]);
    await query('UPDATE accounts SET business_code = NULL WHERE id = $1', [acc.id]);
    await query(
      'INSERT INTO businesses (code, name, app, active, account_id) VALUES ($1,$2,$3,$4,$5)',
      ['ORPHAN-' + CODE, 'Onboard Co', 'SALES', true, null]
    );

    const recovered = await onboarding.login({ email: EMAIL, password: PASSWORD });
    assert.equal(recovered.code, 'ORPHAN-' + CODE);
    assert.deepEqual(recovered.apps, ['sales']);

    const linked = await query('SELECT app, account_id FROM businesses WHERE account_id = $1 AND active = TRUE', [recovered.code]);
    assert.deepEqual(linked.rows.map(row => row.app), ['SALES']);
    assert.ok(linked.rows.every(row => row.account_id === recovered.code));

    await query('DELETE FROM businesses WHERE account_id = $1', [recovered.code]);
    await query('UPDATE accounts SET business_code = NULL WHERE id = $1', [acc.id]);
    const provisioned = await onboarding.login({ email: EMAIL, password: PASSWORD });
    assert.ok(provisioned.code);
    assert.deepEqual(provisioned.apps, ['sales']);
  });
  await test('wrong password and unknown email give the same generic error', async () => {
    await assert.rejects(onboarding.login({ email: EMAIL, password: 'wrongwrong' }), /Incorrect email or password/);
    await assert.rejects(onboarding.login({ email: 'nobody@example.com', password: 'whatever1' }), /Incorrect email or password/);
  });
  await test('password reset via OTP works and invalidates sessions', async () => {
    const acc = (await query('SELECT id FROM accounts WHERE lower(email)=lower($1)', [EMAIL])).rows[0];
    const otp = '123456';
    const hash = createHash('sha256').update(otp).digest('hex');
    await query('UPDATE password_otp SET consumed_at = now() WHERE account_id = $1', [acc.id]);
    await query('INSERT INTO password_otp (account_id, otp_hash, expires_at) VALUES ($1,$2,$3)', [acc.id, hash, new Date(Date.now() + 600000)]);
    // create a session first so we can assert it is cleared
    const before = await onboarding.login({ email: EMAIL, password: PASSWORD });
    assert.ok(await onboarding.sessionFor(before.session));
    await onboarding.resetPassword({ email: EMAIL, otp, password: 'brand new pass' });
    assert.equal(await onboarding.sessionFor(before.session), null);
    const relog = await onboarding.login({ email: EMAIL, password: 'brand new pass' });
    assert.ok(relog.session);
  });
  await test('login rejects accounts without an active application workspace', async () => {
    const acc = (await query('SELECT id, business_code FROM accounts WHERE lower(email)=lower($1)', [EMAIL])).rows[0];
    await query('DELETE FROM businesses WHERE account_id = $1', [acc.business_code]);
    await query(
      'INSERT INTO businesses (code, name, app, active, account_id) VALUES ($1,$2,$3,$4,$5)',
      [acc.business_code, 'Onboard Co', 'SALES', false, acc.business_code]
    );
    await assert.rejects(
      onboarding.login({ email: EMAIL, password: 'brand new pass' }),
      /No active application workspace is linked/
    );
  });

  console.log('\n' + passed + ' passed' + (failures.length ? ', ' + failures.length + ' FAILED' : '') + ' (code ' + CODE + ')');

  // Cleanup the isolated test data
  try {
    await query('DELETE FROM businesses WHERE code = $1', [CODE]);
    // Delete any onboarding businesses (they use generated codes) linked to the test email's account.
    const accs = await query('SELECT id, business_code FROM accounts WHERE lower(email) = lower($1)', [EMAIL]);
    for (const a of accs.rows) {
      if (a.business_code) await query('DELETE FROM businesses WHERE account_id = $1', [a.business_code]);
      await query('DELETE FROM accounts WHERE id = $1', [a.id]);
    }
  } catch (e) {}
  await close();

  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(' - ' + f));
    process.exit(1);
  }
  process.exit(0);
})();
