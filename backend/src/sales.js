'use strict';
// SALES app logic — a faithful port of Sales.gs onto PostgreSQL.
// Identical rules: FIFO stock batches, phone-as-unique customer ID, percentage discounts,
// sequential IDs (now database sequences), and the same return shapes.

const { withTransaction } = require('./db');
const { code, phoneKey, round2, iso, daysDate, esc, money } = require('./util');

const SALES_RECEIPT_FONT = 'Arial, Helvetica, sans-serif';

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

// Fetch the next per-business counter value (atomic via row lock on ON CONFLICT).
async function nextNumber(client, bizId, name) {
  const r = await client.query(
    `INSERT INTO counters (business_id, name, value) VALUES ($1, $2, 1)
     ON CONFLICT (business_id, name) DO UPDATE SET value = counters.value + 1
     RETURNING value`,
    [bizId, name]
  );
  return Number(r.rows[0].value);
}

async function getConfig(client, bizId) {
  const r = await client.query('SELECT key, value FROM sales_config WHERE business_id = $1', [bizId]);
  const cfg = {};
  r.rows.forEach(row => { cfg[row.key] = row.value; });
  return cfg;
}

// ---------------------------------------------------------------
// Stock batches (FIFO)
// ---------------------------------------------------------------

// Batches of one product that still have stock, oldest first ("Opening" first).
async function batchesFor(client, bizId, productId) {
  const r = await client.query(
    `SELECT id, type, qty_remaining, selling_price, unit_cost, sort_order
     FROM sales_expenses
     WHERE business_id = $1 AND product_id = $2 AND qty_remaining > 0
     ORDER BY (CASE WHEN type = 'Opening' THEN 0 ELSE 1 END), sort_order, id`,
    [bizId, productId]
  );
  return r.rows.map(x => ({
    id: x.id,
    type: x.type,
    qty: Number(x.qty_remaining),
    price: Number(x.selling_price) || 0,
    cost: Number(x.unit_cost) || 0
  }));
}

// Turn stock that has no batch yet into an "Opening" batch (mirrors ensureOpening_()).
async function ensureOpening(client, bizId) {
  const prods = await client.query(
    'SELECT product_id, name, cost_price, selling_price, stock FROM sales_products WHERE business_id = $1 AND stock > 0',
    [bizId]
  );
  for (const p of prods.rows) {
    const batches = await batchesFor(client, bizId, p.product_id);
    const covered = batches.reduce((s, l) => s + l.qty, 0);
    const stock = Number(p.stock) || 0;
    if (covered < stock) {
      const q = stock - covered;
      const expId = code('exp', await nextNumber(client, bizId, 'exp'));
      const order = await client.query('SELECT COALESCE(MAX(sort_order), 0)::bigint + 1 AS o FROM sales_expenses WHERE business_id = $1', [bizId]);
      await client.query(
        `INSERT INTO sales_expenses
          (business_id, expense_id, date, product_id, product_name, type, qty, unit_cost, total_cost, selling_price, qty_remaining, sort_order)
         VALUES ($1,$2,now(),$3,$4,'Opening',$5,$6,0,$7,$5,$8)`,
        [bizId, expId, p.product_id, p.name, q, Number(p.cost_price) || 0, Number(p.selling_price) || 0, Number(order.rows[0].o)]
      );
    }
  }
}

// ---------------------------------------------------------------
// Lists + config
// ---------------------------------------------------------------

async function getProductsList(ctx) {
  const r = await ctx.client.query(
    'SELECT product_id, name, category, cost_price, selling_price, stock, unit FROM sales_products WHERE business_id = $1',
    [ctx.bizId]
  );
  const products = r.rows.map(p => ({
    ProductID: p.product_id,
    Name: p.name,
    Category: p.category,
    CostPrice: Number(p.cost_price),
    SellingPrice: Number(p.selling_price),
    Stock: Number(p.stock),
    Unit: p.unit
  }));
  for (const p of products) {
    const layers = await batchesFor(ctx.client, ctx.bizId, p.ProductID);
    // Merge adjacent equal prices into tiers (same as the original)
    const tiers = [];
    layers.forEach(l => {
      const last = tiers[tiers.length - 1];
      if (last && last.price === l.price) last.qty += l.qty;
      else tiers.push({ qty: l.qty, price: l.price });
    });
    p.Tiers = tiers;
    if (tiers.length) p.SellingPrice = tiers[0].price;
  }
  return products;
}

async function getExpensesList(ctx) {
  const r = await ctx.client.query(
    `SELECT expense_id, date, product_id, product_name, type, qty, unit_cost, total_cost, selling_price, qty_remaining
     FROM sales_expenses WHERE business_id = $1 ORDER BY sort_order DESC, id DESC`,
    [ctx.bizId]
  );
  return r.rows.map(x => ({
    id: x.expense_id,
    date: iso(x.date),
    productId: x.product_id,
    name: x.product_name,
    type: x.type,
    qty: Number(x.qty) || 0,
    unitCost: Number(x.unit_cost) || 0,
    total: Number(x.total_cost) || 0,
    sellingPrice: Number(x.selling_price) || 0,
    remaining: Number(x.qty_remaining) || 0
  }));
}

async function getCustomersList(ctx) {
  const r = await ctx.client.query(
    `SELECT customer_id, name, phone, email, address, total_purchases, date_added
     FROM sales_customers WHERE business_id = $1 ORDER BY id`,
    [ctx.bizId]
  );
  return r.rows.map(x => ({
    CustomerID: x.customer_id,
    Name: x.name,
    Phone: x.phone,
    Email: x.email,
    Address: x.address,
    TotalPurchases: Number(x.total_purchases) || 0,
    DateAdded: iso(x.date_added)
  }));
}

async function sales_getConfig(ctx) {
  return getConfig(ctx.client, ctx.bizId);
}

// ---------------------------------------------------------------
// Categories + running expenses
// ---------------------------------------------------------------

const DEFAULT_EXPENSE_CATEGORIES = ['Fuel', 'Transport', 'Rent', 'Electricity / Utilities', 'Staff Wages',
  'Domestic / Household', 'Equipment / Maintenance', 'Other'];

// Seed starter categories the first time a business has none (mirrors getCategoriesSheet_()):
// expense defaults + any product categories already typed on products.
async function ensureCategories(client, bizId) {
  const existing = await client.query('SELECT id FROM sales_categories WHERE business_id = $1 LIMIT 1', [bizId]);
  if (existing.rows.length > 0) return;
  const seen = {};
  const rows = [];
  const prods = await client.query('SELECT DISTINCT category FROM sales_products WHERE business_id = $1', [bizId]);
  prods.rows.forEach(r => {
    const c = String(r.category || '').trim().replace(/\s+/g, ' ');
    if (c && !seen[c.toLowerCase()]) { seen[c.toLowerCase()] = true; rows.push(['Product', c]); }
  });
  DEFAULT_EXPENSE_CATEGORIES.forEach(n => rows.push(['Expense', n]));
  for (const [type, name] of rows) {
    const id = code('cat', await nextNumber(client, bizId, 'cat'));
    await client.query(
      `INSERT INTO sales_categories (business_id, category_id, name, type, active)
       VALUES ($1,$2,$3,$4,TRUE) ON CONFLICT (business_id, type, lower(name)) DO NOTHING`,
      [bizId, id, name, type]
    );
  }
}

async function getCategoriesList(ctx) {
  await ensureCategories(ctx.client, ctx.bizId);
  const r = await ctx.client.query(
    'SELECT category_id, name, type, active FROM sales_categories WHERE business_id = $1 ORDER BY id',
    [ctx.bizId]
  );
  return r.rows.map(x => ({
    CategoryID: x.category_id,
    Name: String(x.name),
    Type: x.type,
    Active: x.active === true
  }));
}

// Adds a category, or returns/re-activates one with that name. Runs inside the caller's transaction.
async function addCategoryUnlocked(ctx, name, type) {
  name = String(name || '').trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Category name is required.');
  if (type !== 'Product' && type !== 'Expense') throw new Error('Unknown category type.');
  await ensureCategories(ctx.client, ctx.bizId);
  const existing = await ctx.client.query(
    'SELECT category_id, name, active FROM sales_categories WHERE business_id = $1 AND type = $2 AND lower(name) = lower($3)',
    [ctx.bizId, type, name]
  );
  if (existing.rows.length) {
    const e = existing.rows[0];
    if (!e.active) await ctx.client.query('UPDATE sales_categories SET active = TRUE WHERE business_id = $1 AND category_id = $2', [ctx.bizId, e.category_id]);
    return { CategoryID: e.category_id, Name: String(e.name), Type: type, Active: true, existing: true };
  }
  const id = code('cat', await nextNumber(ctx.client, ctx.bizId, 'cat'));
  await ctx.client.query(
    'INSERT INTO sales_categories (business_id, category_id, name, type, active) VALUES ($1,$2,$3,$4,TRUE)',
    [ctx.bizId, id, name, type]
  );
  return { CategoryID: id, Name: name, Type: type, Active: true, existing: false };
}

async function addCategory(ctx, data) {
  return withTransaction(async client => {
    return addCategoryUnlocked({ client, bizId: ctx.bizId }, data && data.name, data && data.type);
  });
}

async function updateCategory(ctx, categoryId, data) {
  return withTransaction(async client => {
    const r = await client.query('SELECT id, name, type FROM sales_categories WHERE business_id = $1 AND category_id = $2', [ctx.bizId, categoryId]);
    if (!r.rows.length) throw new Error('Category not found.');
    const cur = r.rows[0];
    const oldName = String(cur.name);
    if (data && data.name !== undefined && data.name !== null) {
      const name = String(data.name).trim().replace(/\s+/g, ' ');
      if (!name) throw new Error('Category name is required.');
      const clash = await client.query(
        'SELECT 1 FROM sales_categories WHERE business_id = $1 AND type = $2 AND lower(name) = lower($3) AND category_id <> $4',
        [ctx.bizId, cur.type, name, categoryId]
      );
      if (clash.rows.length) throw new Error('That category already exists.');
      if (name !== oldName) {
        await client.query('UPDATE sales_categories SET name = $1 WHERE id = $2', [name, cur.id]);
        // rename uses: Products for 'Product' type, RunningExpenses for 'Expense' type
        if (cur.type === 'Product') {
          await client.query('UPDATE sales_products SET category = $1 WHERE business_id = $2 AND category = $3', [name, ctx.bizId, oldName]);
        } else {
          await client.query('UPDATE sales_running_expenses SET category = $1 WHERE business_id = $2 AND category = $3', [name, ctx.bizId, oldName]);
        }
      }
    }
    if (data && data.active !== undefined && data.active !== null) {
      await client.query('UPDATE sales_categories SET active = $1 WHERE id = $2', [!!data.active, cur.id]);
    }
    return true;
  });
}

async function getRunningExpenses(ctx) {
  const r = await ctx.client.query(
    'SELECT expense_id, date, category, description, amount FROM sales_running_expenses WHERE business_id = $1 ORDER BY date DESC, id DESC',
    [ctx.bizId]
  );
  return r.rows.map(x => ({
    id: x.expense_id,
    date: iso(x.date),
    category: String(x.category || ''),
    description: String(x.description || ''),
    amount: Number(x.amount) || 0
  }));
}

async function addRunningExpense(ctx, data) {
  const amount = Number(data && data.amount);
  if (!(amount > 0)) throw new Error('Enter an amount.');
  const category = String((data && data.category) || '').trim().replace(/\s+/g, ' ') || 'Other';
  const description = String((data && data.description) || '').trim();
  return withTransaction(async client => {
    const c = { client, bizId: ctx.bizId };
    await addCategoryUnlocked(c, category, 'Expense');
    const id = code('rex', await nextNumber(client, ctx.bizId, 'rex'));
    const date = daysDate(data && data.date) || new Date();
    await client.query(
      'INSERT INTO sales_running_expenses (business_id, expense_id, date, category, description, amount) VALUES ($1,$2,$3,$4,$5,$6)',
      [ctx.bizId, id, date, category, description, amount]
    );
    return { id, date: iso(date), category, description, amount };
  });
}

// ---------------------------------------------------------------
// Products (buy / restock)
// ---------------------------------------------------------------

async function addProduct(ctx, product) {
  return withTransaction(async client => {
    const name = String((product && product.name) || '').trim().replace(/\s+/g, ' ');
    if (!name) throw new Error('Product name is required.');
    const qty = Number(product && product.stock);
    if (!(qty > 0)) throw new Error('Enter the quantity bought.');
    const has = v => v !== undefined && v !== null && v !== '';
    const c = { client, bizId: ctx.bizId };

    await ensureOpening(client, ctx.bizId);

    const existing = await client.query(
      'SELECT product_id, name, category, cost_price, selling_price, stock, unit FROM sales_products WHERE business_id = $1 AND lower(name) = lower($2)',
      [ctx.bizId, name]
    );

    if (!existing.rows.length) {
      // brand-new product
      const sell = Number(product && product.sellingPrice) || 0;
      if (!(sell > 0)) throw new Error('Enter a selling price for a new product.');
      const cost = Number(product && product.costPrice) || 0;
      const prodId = code('prd', await nextNumber(client, ctx.bizId, 'prd'));
      const category = String((product && product.category) || '').trim().replace(/\s+/g, ' ');
      if (category) await addCategoryUnlocked(c, category, 'Product');
      const unit = (product && product.unit) || 'pcs';
      await client.query(
        'INSERT INTO sales_products (business_id, product_id, name, category, cost_price, selling_price, stock, unit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [ctx.bizId, prodId, name, category, cost, sell, qty, unit]
      );
      const expId = code('exp', await nextNumber(client, ctx.bizId, 'exp'));
      const order = await client.query('SELECT COALESCE(MAX(sort_order),0)::bigint+1 AS o FROM sales_expenses WHERE business_id=$1', [ctx.bizId]);
      await client.query(
        `INSERT INTO sales_expenses (business_id, expense_id, date, product_id, product_name, type, qty, unit_cost, total_cost, selling_price, qty_remaining, sort_order)
         VALUES ($1,$2,now(),$3,$4,'New',$5,$6,$7,$8,$5,$9)`,
        [ctx.bizId, expId, prodId, name, qty, cost, qty * cost, sell, Number(order.rows[0].o)]
      );
      return { id: prodId, existing: false, name, category, costPrice: cost, sellingPrice: sell, stock: qty, unit };
    }

    // restock
    const row = existing.rows[0];
    const layers = await batchesFor(client, ctx.bizId, row.product_id);
    const newest = layers.length ? layers[layers.length - 1] : null;
    const cost = has(product && product.costPrice) ? Number(product.costPrice) : (newest ? newest.cost : Number(row.cost_price) || 0);
    const sell = has(product && product.sellingPrice) ? Number(product.sellingPrice) : (newest ? newest.price : Number(row.selling_price) || 0);
    if (!(sell > 0)) throw new Error('Enter a selling price.');

    // Higher new price lifts the stock still on hand
    for (const l of layers) {
      if (sell > l.price) {
        await client.query('UPDATE sales_expenses SET selling_price = $1 WHERE id = $2', [sell, l.id]);
        l.price = sell;
      }
    }
    const expId = code('exp', await nextNumber(client, ctx.bizId, 'exp'));
    const order = await client.query('SELECT COALESCE(MAX(sort_order),0)::bigint+1 AS o FROM sales_expenses WHERE business_id=$1', [ctx.bizId]);
    await client.query(
      `INSERT INTO sales_expenses (business_id, expense_id, date, product_id, product_name, type, qty, unit_cost, total_cost, selling_price, qty_remaining, sort_order)
       VALUES ($1,$2,now(),$3,$4,'Restock',$5,$6,$7,$8,$5,$9)`,
      [ctx.bizId, expId, row.product_id, row.name, qty, cost, qty * cost, sell, Number(order.rows[0].o)]
    );

    layers.push({ qty, price: sell, cost });
    const front = layers[0];
    const newStock = (Number(row.stock) || 0) + qty;
    await client.query(
      'UPDATE sales_products SET cost_price = $1, selling_price = $2, stock = $3 WHERE product_id = $4 AND business_id = $5',
      [front.cost, front.price, newStock, row.product_id, ctx.bizId]
    );
    return { id: row.product_id, existing: true, name: row.name, category: row.category, costPrice: front.cost, sellingPrice: front.price, stock: newStock, unit: row.unit };
  });
}

async function updateProduct(ctx, product) {
  await ctx.client.query(
    `UPDATE sales_products SET name=$1, category=$2, cost_price=$3, selling_price=$4, stock=$5, unit=$6
     WHERE business_id=$7 AND product_id=$8`,
    [product.name, product.category || '', Number(product.costPrice) || 0, Number(product.sellingPrice) || 0,
     Number(product.stock) || 0, product.unit || 'pcs', ctx.bizId, product.id]
  );
  return { success: true };
}

// ---------------------------------------------------------------
// Customers
// ---------------------------------------------------------------

async function sales_addCustomer(ctx, customer) {
  if (!customer || typeof customer.name !== 'string' || !customer.name.trim()) {
    throw new Error('Customer name is required.');
  }
  const normalize = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const str = v => (v == null ? '' : String(v).trim());
  const nameKey = normalize(customer.name);
  const newPhoneKey = phoneKey(customer.phone);

  return withTransaction(async client => {
    const all = await client.query(
      'SELECT customer_id, name, phone, email, address, total_purchases FROM sales_customers WHERE business_id = $1',
      [ctx.bizId]
    );
    for (const row of all.rows) {
      const rowPhoneKey = phoneKey(row.phone);
      const isMatch = newPhoneKey
        ? rowPhoneKey === newPhoneKey
        : (!rowPhoneKey && normalize(row.name) === nameKey);
      if (isMatch) {
        const phone = str(row.phone) || str(customer.phone);
        const email = str(customer.email) || str(row.email);
        const address = str(customer.address) || str(row.address);
        await client.query(
          'UPDATE sales_customers SET phone=$1, email=$2, address=$3 WHERE customer_id=$4 AND business_id=$5',
          [phone, email, address, row.customer_id, ctx.bizId]
        );
        return { id: row.customer_id, existing: true, name: row.name, phone, email, address, totalPurchases: Number(row.total_purchases) || 0 };
      }
    }
    const id = code('cus', await nextNumber(client, ctx.bizId, 'cus'));
    const name = customer.name.trim().replace(/\s+/g, ' ');
    const phone = str(customer.phone), email = str(customer.email), address = str(customer.address);
    await client.query(
      'INSERT INTO sales_customers (business_id, customer_id, name, phone, email, address, total_purchases, date_added) VALUES ($1,$2,$3,$4,$5,$6,0,now())',
      [ctx.bizId, id, name, phone, email, address]
    );
    return { id, existing: false, name, phone, email, address, totalPurchases: 0 };
  });
}

// ---------------------------------------------------------------
// Sales
// ---------------------------------------------------------------

async function findProductByRef(client, bizId, productId, name) {
  if (productId) {
    const r = await client.query('SELECT * FROM sales_products WHERE business_id=$1 AND product_id=$2', [bizId, productId]);
    if (r.rows.length) return r.rows[0];
  }
  const nameLower = (name || '').trim().toLowerCase();
  if (nameLower) {
    const r = await client.query('SELECT * FROM sales_products WHERE business_id=$1 AND lower(name)=$2', [bizId, nameLower]);
    if (r.rows.length) return r.rows[0];
  }
  return null;
}

async function saveSale(ctx, sale) {
  return withTransaction(async client => {
    const c = { client, bizId: ctx.bizId };
    const reqItems = (sale && sale.items) || [];
    if (!reqItems.length) throw new Error('No items in sale.');

    await ensureOpening(client, ctx.bizId);

    // 1. Total quantity wanted per product
    const wanted = new Map(); // product_id -> { product, qty }
    for (const it of reqItems) {
      const p = await findProductByRef(client, ctx.bizId, it.productId, it.name);
      if (!p) throw new Error('Product not found: ' + (it.name || it.productId));
      const q = Number(it.qty);
      if (!(q > 0)) throw new Error('Invalid quantity for ' + (it.name || it.productId));
      const key = p.product_id;
      if (!wanted.has(key)) wanted.set(key, { product: p, qty: 0 });
      wanted.get(key).qty += q;
    }

    // 2. Check stock and split across FIFO batches. Nothing written yet.
    const items = [];
    const batchWrites = []; // { id, remaining }
    const productWrites = []; // { product_id, cost, price, stock }
    for (const [pid, want] of wanted) {
      const row = want.product;
      const need = want.qty;
      const stock = Number(row.stock) || 0;
      if (need > stock) {
        throw new Error(row.name + ': ' + (stock <= 0 ? 'out of stock' : 'only ' + stock + ' left in stock'));
      }
      const layers = await batchesFor(client, ctx.bizId, pid);
      let left = need;
      for (const l of layers) {
        if (left <= 0) break;
        const take = Math.min(left, l.qty);
        items.push({ productId: pid, name: row.name, qty: take, price: l.price, cost: l.cost });
        if (l.id) batchWrites.push({ id: l.id, remaining: l.qty - take });
        l.qty -= take;
        left -= take;
      }
      if (left > 0) throw new Error(row.name + ': not enough stock');
      const front = layers.find(l => l.qty > 0);
      productWrites.push({ pid, cost: front ? front.cost : Number(row.cost_price) || 0, price: front ? front.price : Number(row.selling_price) || 0, stock: stock - need });
    }

    // 3. Totals
    const subtotal = round2(items.reduce((sum, it) => sum + it.qty * it.price, 0));
    let pct = Number(sale && sale.discountPercent);
    if (isNaN(pct)) pct = 0;
    pct = Math.min(Math.max(pct, 0), 100);
    const discount = Math.round(subtotal * pct) / 100;
    const total = Math.max(subtotal - discount, 0);
    const saleId = code('sal', await nextNumber(client, ctx.bizId, 'sal'));
    const receiptId = code('rec', await nextNumber(client, ctx.bizId, 'rec'));
    const receiptItems = items.map(it => ({ productId: it.productId, name: it.name, qty: it.qty, price: it.price }));

    // 4. Write everything (all within this transaction)
    await client.query(
      `INSERT INTO sales_sales (business_id, sale_id, date, customer_id, customer_name, subtotal, discount, total, payment_method, items_json, receipt_id)
       VALUES ($1,$2,now(),$3,$4,$5,$6,$7,$8,$9,$10)`,
      [ctx.bizId, saleId, (sale && sale.customerId) || '', (sale && sale.customerName) || 'Walk-in',
       subtotal, pct, total, (sale && sale.paymentMethod) || 'Cash', JSON.stringify(receiptItems), receiptId]
    );
    for (const it of items) {
      const lineTotal = round2(it.qty * it.price);
      await client.query(
        `INSERT INTO sales_sale_items (business_id, sale_id, product_id, product_name, qty, price, line_total, cost_price, profit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [ctx.bizId, saleId, it.productId, it.name, it.qty, it.price, lineTotal, it.cost, lineTotal - it.qty * it.cost]
      );
    }
    for (const w of batchWrites) {
      await client.query('UPDATE sales_expenses SET qty_remaining = $1 WHERE id = $2', [w.remaining, w.id]);
    }
    for (const w of productWrites) {
      await client.query('UPDATE sales_products SET cost_price=$1, selling_price=$2, stock=$3 WHERE product_id=$4 AND business_id=$5',
        [w.cost, w.price, w.stock, w.pid, ctx.bizId]);
    }

    // 5. Customer running total
    if ((sale && sale.customerId)) {
      await client.query(
        'UPDATE sales_customers SET total_purchases = total_purchases + $1 WHERE business_id = $2 AND customer_id = $3',
        [total, ctx.bizId, sale.customerId]
      );
    }

    return {
      saleId, receiptId,
      date: iso(new Date()),
      customerName: (sale && sale.customerName) || 'Walk-in',
      items: receiptItems,
      subtotal, discount, total,
      paymentMethod: (sale && sale.paymentMethod) || 'Cash'
    };
  });
}

async function getSalesHistory(ctx, limitCount) {
  const r = await ctx.client.query(
    'SELECT sale_id, date, customer_name, total, payment_method FROM sales_sales WHERE business_id=$1 ORDER BY date DESC LIMIT $2',
    [ctx.bizId, limitCount ? Math.min(Number(limitCount), 10000) : 100000]
  );
  return r.rows.map(x => ({
    saleId: x.sale_id,
    date: iso(x.date),
    customerName: x.customer_name,
    total: Number(x.total),
    paymentMethod: x.payment_method
  }));
}

async function getSaleById(ctx, saleId) {
  const r = await ctx.client.query(
    'SELECT * FROM sales_sales WHERE business_id=$1 AND sale_id=$2',
    [ctx.bizId, saleId]
  );
  const row = r.rows[0];
  if (!row) throw new Error('Sale not found: ' + saleId);
  const subtotal = Number(row.subtotal) || 0;
  const total = Number(row.total) || 0;
  const discountAmt = Math.max(Math.round((subtotal - total) * 100) / 100, 0);
  const discountPct = subtotal > 0 ? Math.round(discountAmt / subtotal * 10000) / 100 : 0;
  return {
    saleId: row.sale_id,
    receiptId: row.receipt_id || '',
    date: iso(row.date),
    customerName: row.customer_name,
    items: row.items_json || [],
    subtotal, discount: discountAmt, discountPercent: discountPct,
    total, paymentMethod: row.payment_method
  };
}

async function ensureReceiptId(ctx, sale) {
  if (sale.receiptId) return sale.receiptId;
  return withTransaction(async client => {
    const receiptId = code('rec', await nextNumber(client, ctx.bizId, 'rec'));
    await client.query('UPDATE sales_sales SET receipt_id = $1 WHERE business_id = $2 AND sale_id = $3', [receiptId, ctx.bizId, sale.saleId]);
    sale.receiptId = receiptId;
    return receiptId;
  });
}

// ---------------------------------------------------------------
// Receipt HTML / PDF
// ---------------------------------------------------------------

function buildReceiptHtml(sale, config, tzLabel) {
  const currency = config.Currency || '';
  const when = new Date(sale.date).toLocaleString('en-GB', { timeZone: tzLabel, day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const itemsHtml = sale.items.map(it => {
    const line = Number(it.qty) * Number(it.price);
    return '<table class="item">' +
      '<tr><td colspan="2" class="item-name">' + esc(it.name) + '</td></tr>' +
      '<tr><td class="item-calc">' + esc(it.qty) + ' &times; ' + money(it.price, currency) + '</td>' +
      '<td class="amt">' + money(line, currency) + '</td></tr>' +
      '</table>';
  }).join('');
  const css = [
    '@page{margin:8mm}',
    'body{font-family:' + SALES_RECEIPT_FONT + ';font-size:13px;line-height:1.5;color:#111;max-width:300px;margin:0 auto;padding:16px 14px;}',
    'table{width:100%;border-collapse:collapse;}',
    'h2{font-size:20px;margin:0 0 6px;text-align:center;}',
    '.sub{font-size:12px;color:#444;text-align:center;margin:2px 0;}',
    '.divider{border-top:1px dashed #888;margin:14px 0;}',
    '.meta td{padding:4px 0;font-size:12.5px;vertical-align:top;}',
    '.meta td.k{color:#555;width:38%;}',
    '.meta td.v{text-align:right;font-weight:bold;}',
    '.item{border-bottom:1px dotted #bbb;margin-bottom:2px;}',
    '.item td{padding:3px 0;}',
    '.item-name{font-weight:bold;font-size:13.5px;padding-top:8px !important;}',
    '.item-calc{font-size:12.5px;color:#333;padding-bottom:8px !important;}',
    '.amt{text-align:right;font-size:13px;padding-bottom:8px !important;}',
    '.totals td{padding:4px 0;font-size:13px;}',
    '.totals td.amt{padding-bottom:4px !important;}',
    '.grand td{font-size:17px;font-weight:bold;border-top:2px solid #111;padding-top:10px;}',
    '.footer{text-align:center;font-size:12px;color:#444;margin-top:20px;line-height:1.6;}'
  ].join('');
  return (
    '<html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>' + css + '</style></head><body>' +
    '<h2>' + esc(config.BusinessName || 'Sales Receipt') + '</h2>' +
    (config.Address ? '<div class="sub">' + esc(config.Address) + '</div>' : '') +
    (config.Phone ? '<div class="sub">' + esc(config.Phone) + '</div>' : '') +
    '<div class="divider"></div>' +
    '<table class="meta">' +
      '<tr><td class="k">Receipt No</td><td class="v">' + esc(sale.receiptId) + '</td></tr>' +
      '<tr><td class="k">Date</td><td class="v">' + esc(when) + '</td></tr>' +
      '<tr><td class="k">Customer</td><td class="v">' + esc(sale.customerName || 'Walk-in') + '</td></tr>' +
      '<tr><td class="k">Payment</td><td class="v">' + esc(sale.paymentMethod) + '</td></tr>' +
    '</table>' +
    '<div class="divider"></div>' +
    itemsHtml +
    '<div class="divider"></div>' +
    '<table class="totals">' +
      '<tr><td>Subtotal</td><td class="amt">' + money(sale.subtotal, currency) + '</td></tr>' +
      (Number(sale.discount) ? '<tr><td>Discount' + (Number(sale.discountPercent) ? ' (' + Number(sale.discountPercent) + '%)' : '') + '</td><td class="amt">-' + money(sale.discount, currency) + '</td></tr>' : '') +
      '<tr class="grand"><td>TOTAL</td><td class="amt">' + money(sale.total, currency) + '</td></tr>' +
    '</table>' +
    '<div class="footer">' + esc(config.Footer || 'Thank you!') + '</div>' +
    '</body></html>'
  );
}

async function sales_getReceiptHtml(ctx, saleId) {
  const sale = await getSaleById(ctx, saleId);
  await ensureReceiptId(ctx, sale);
  const config = await getConfig(ctx.client, ctx.bizId);
  return buildReceiptHtml(sale, config, ctx.tz);
}

async function sales_getReceiptPdf(ctx, saleId) {
  const sale = await getSaleById(ctx, saleId);
  await ensureReceiptId(ctx, sale);
  const config = await getConfig(ctx.client, ctx.bizId);
  const html = buildReceiptHtml(sale, config, ctx.tz);
  return { name: sale.receiptId + '.pdf', __pdf: { sale, config, html } };
}

async function generateReceiptPdf(ctx, saleId) {
  const r = await sales_getReceiptPdf(ctx, saleId);
  r.receiptId = r.__pdf.sale.receiptId;
  r.url = '';
  delete r.__pdf;
  return r;
}

module.exports = {
  getProductsList, getExpensesList, getCustomersList, sales_getConfig, getCategoriesList,
  addCategory, updateCategory, getRunningExpenses, addRunningExpense,
  addProduct, updateProduct, sales_addCustomer,
  saveSale, getSalesHistory, getSaleById, sales_getReceiptHtml, sales_getReceiptPdf, generateReceiptPdf,
  buildReceiptHtml
};
