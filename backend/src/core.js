'use strict';
// The brain of the back end: routes an action to the right app's logic against PostgreSQL.
// Serializes writes per-business to prevent races (same promise the script lock gave).

const { getPool } = require('./db');
const { lookupBusiness } = require('./router');
const sales = require('./sales');
const services = require('./services');
const { buildPdf } = require('./pdf');

const PAGES = { sales: true, services: true };
const isRead = fn => /^(get|find|search)/.test(String(fn || ''));

// Map each app's allowed action names -> implementation functions.
const ACTIONS = {
  sales: {
    getProductsList: sales.getProductsList,
    getCustomersList: sales.getCustomersList,
    getExpensesList: sales.getExpensesList,
    addProduct: sales.addProduct,
    updateProduct: sales.updateProduct,
    saveSale: sales.saveSale,
    getSalesHistory: sales.getSalesHistory,
    getCategoriesList: sales.getCategoriesList,
    addRunningExpense: sales.addRunningExpense,
    getRunningExpenses: sales.getRunningExpenses,
    addCategory: sales.addCategory,
    updateCategory: sales.updateCategory,
    generateReceiptPdf: sales.generateReceiptPdf,
    getReceiptPdf: sales.sales_getReceiptPdf,
    getConfig: sales.sales_getConfig,
    addCustomer: sales.sales_addCustomer,
    getReceiptHtml: sales.sales_getReceiptHtml
  },
  services: {
    getInitData: services.svc_getInitData,
    getReportSummary: services.getReportSummary,
    addCustomer: services.svc_addCustomer,
    getReceiptHtml: services.svc_getReceiptHtml,
    searchCustomers: services.searchCustomers,
    findCustomerByPhone: services.findCustomerByPhone,
    getCustomersWithSpend: services.getCustomersWithSpend,
    getCustomerHistory: services.getCustomerHistory,
    recordSale: services.recordSale,
    getReceiptPdf: services.getReceiptPdf,
    addExpense: services.addExpense,
    getExpenses: services.getExpenses,
    updateBusinessSettings: services.updateBusinessSettings,
    getAllServices: services.getAllServices,
    addService: services.addService,
    updateService: services.updateService,
    getAllCategories: services.getAllCategories,
    addCategory: services.addCategory,
    updateCategory: services.updateCategory
  }
};

// Per-business write queue (in-process mutex). A single Node instance is assumed
// (documented in README), same as the original queue in core.js.
const queues = new Map();
function serialize(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  queues.set(key, run.catch(() => {}));
  return run;
}

// Build a context for an action, always with a dedicated client. Write actions do their
// work inside their own transaction (the per-business queue serializes them), and some
// "write" actions (e.g. generateReceiptPdf) also read in the same call.
async function withContext(code, app, needClient, fn) {
  const biz = await lookupBusiness(code, app);
  const tz = process.env.TZ_NAME || 'Africa/Lagos';
  const client = await getPool().connect();
  try {
    return await fn({ biz, bizId: biz.id, tz, client });
  } finally {
    client.release();
  }
}

async function call({ code, app, fn, args }) {
  app = String(app || '').toLowerCase();

  // Cross-app read-only dashboard (aggregates every enabled app for this business code).
  if (fn === 'getDashboard') {
    return require('./dashboard').getDashboard(String(code || ''), (args && args[0]) || {});
  }

  const table = ACTIONS[app];
  if (!table || !Object.prototype.hasOwnProperty.call(table, fn)) {
    throw new Error('Unknown action: ' + fn);
  }
  const impl = table[fn];
  const read = isRead(fn);
  const run = () => withContext(code, app, read, ctx => impl(ctx, ...(Array.isArray(args) ? args : [])));
  const queueKey = app + ':' + String(code || '').trim().toUpperCase();

  let result;
  if (read) {
    result = await run();
  } else {
    result = await serialize(queueKey, run);
  }

  if (result && result.__pdf) {
    const buf = await buildPdf(Object.assign({ tz: process.env.TZ_NAME || 'Africa/Lagos' }, result.__pdf));
    const out = Object.assign({}, result, { base64: buf.toString('base64') });
    delete out.__pdf;
    return out;
  }
  return result;
}

module.exports = { call, ACTIONS };
