'use strict';
// Read-only dashboard aggregation across the business's enabled apps (Sales and/or Services).
// Reuses the existing per-app read functions; no new queries, no writes.

const { query } = require('./db');
const { round2, iso } = require('./util');
const salesApp = require('./sales');
const servicesApp = require('./services');

// Resolve every active business row (one per app) that shares this code.
async function businessRows(code) {
  const r = await query(
    "SELECT id, code, name, app FROM businesses WHERE code = $1 AND active = TRUE",
    [code]
  );
  return r.rows;
}

// Give each app's read function a per-app context (its own business id + client).
async function ctxFor(code, app) {
  const rows = await businessRows(code);
  const row = rows.find(x => String(x.app).toUpperCase() === app);
  if (!row) return null;
  return { code, app: app.toLowerCase(), biz: row, bizId: row.id };
}

function dateKey(d) {
  const x = new Date(d);
  return isNaN(x.getTime()) ? '' : x.toISOString().slice(0, 10);
}

/**
 * getDashboard(code, opts)
 *   opts.from / opts.to = 'yyyy-MM-dd' (inclusive) — optional
 *   opts.customer = id/name filter (applied to sales/customer lists where possible)
 * Returns combined totals, series, recent sales, top items, counts.
 */
async function getDashboard(code, opts) {
  opts = opts || {};
  const rows = await businessRows(code);
  const apps = rows.map(r => String(r.app).toUpperCase());
  const hasSales = apps.includes('SALES');
  const hasServices = apps.includes('SERVICES');

  const from = opts.from ? new Date(opts.from + 'T00:00:00') : null;
  const to = opts.to ? new Date(opts.to + 'T23:59:59') : null;
  const inRange = v => {
    const d = new Date(v);
    if (isNaN(d.getTime())) return true;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  };

  const result = {
    business: { name: (rows[0] && rows[0].name) || '', apps },
    range: { from: opts.from || '', to: opts.to || '' },
    totals: { revenue: 0, expenses: 0, profit: 0 },
    counts: { sales: 0, customers: 0, products: 0, services: 0 },
    series: { byDay: [] },          // [{ date, revenue, expenses }]
    recent: [],                     // unified recent transactions
    topItems: [],                   // [{ name, qty, revenue }]
    expenseBreakdown: []            // [{ category, amount }]
  };

  const dayMap = new Map();          // date -> {revenue, expenses}
  const addDay = (date, revenue, expenses) => {
    const k = dateKey(date);
    if (!k) return;
    const cur = dayMap.get(k) || { revenue: 0, expenses: 0 };
    cur.revenue += revenue || 0;
    cur.expenses += expenses || 0;
    dayMap.set(k, cur);
  };
  const itemMap = new Map();         // name -> {qty, revenue}
  const expenseCat = new Map();      // category -> amount

  // ---- SALES app ----
  if (hasSales) {
    const ctx = await ctxFor(code, 'SALES');
    const [history, products, customers] = await Promise.all([
      salesApp.getSalesHistory(ctx, 10000),
      salesApp.getProductsList(ctx),
      salesApp.getCustomersList(ctx)
    ]);

    result.counts.products = products.length;
    result.counts.customers += customers.length;

    for (const s of history) {
      if (!inRange(s.date)) continue;
      result.counts.sales += 1;
      result.totals.revenue += Number(s.total) || 0;
      addDay(s.date, Number(s.total) || 0, 0);
      result.recent.push({
        source: 'sales', ref: s.saleId, customer: s.customerName || 'Walk-in',
        item: null, date: s.date, amount: Number(s.total) || 0
      });
    }

    // Expenses: purchases (stock batches) + running expenses
    const purchases = await salesApp.getExpensesList(ctx);
    for (const e of purchases) {
      if (!inRange(e.date)) continue;
      const amt = Number(e.total) || 0;
      result.totals.expenses += amt;
      addDay(e.date, 0, amt);
      expenseCat.set(e.type || 'Stock', (expenseCat.get(e.type || 'Stock') || 0) + amt);
    }
    const running = await salesApp.getRunningExpenses(ctx);
    for (const r of running) {
      if (!inRange(r.date)) continue;
      const amt = Number(r.amount) || 0;
      result.totals.expenses += amt;
      addDay(r.date, 0, amt);
      expenseCat.set(r.category || 'Other', (expenseCat.get(r.category || 'Other') || 0) + amt);
    }
  }

  // ---- SERVICES app ----
  if (hasServices) {
    const ctx = await ctxFor(code, 'SERVICES');
    const [recentSales, expenses, customers, services] = await Promise.all([
      servicesApp.getRecentSales(ctx, 1000),
      servicesApp.getExpenses(ctx, opts.from || null, opts.to || null),
      servicesApp.getCustomersWithSpend(ctx),
      servicesApp.getAllServices(ctx)
    ]);

    result.counts.customers += customers.length;
    result.counts.services = services.length;

    for (const s of recentSales) {
      if (!inRange(s.date)) continue;
      result.counts.sales += 1;
      const amt = Number(s.total) || 0;
      result.totals.revenue += amt;
      addDay(s.date, amt, 0);
      result.recent.push({
        source: 'services', ref: s.saleId || s.receiptNo, customer: s.customerName || 'Walk-in',
        item: null, date: s.date, amount: amt
      });
    }

    for (const e of expenses) {
      const amt = Number(e.Amount || e.amount) || 0;
      result.totals.expenses += amt;
      addDay(e.Date || e.date, 0, amt);
      const cat = e.Category || e.category || 'Other';
      expenseCat.set(cat, (expenseCat.get(cat) || 0) + amt);
    }
  }

  // ---- Assemble ----
  result.totals.revenue = round2(result.totals.revenue);
  result.totals.expenses = round2(result.totals.expenses);
  result.totals.profit = round2(result.totals.revenue - result.totals.expenses);

  result.series.byDay = Array.from(dayMap.entries())
    .map(([date, v]) => ({ date, revenue: round2(v.revenue), expenses: round2(v.expenses) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  result.recent = result.recent
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 10);

  result.expenseBreakdown = Array.from(expenseCat.entries())
    .map(([category, amount]) => ({ category, amount: round2(amount) }))
    .sort((a, b) => b.amount - a.amount);

  result.topItems = Array.from(itemMap.entries())
    .map(([name, v]) => ({ name, qty: v.qty, revenue: round2(v.revenue) }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  return result;
}

module.exports = { getDashboard };
