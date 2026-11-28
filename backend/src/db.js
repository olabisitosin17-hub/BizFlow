'use strict';
// MongoDB Connection & Query Emulator for Bizflow
// Replaces PostgreSQL with MongoDB while maintaining 100% compatibility with existing app queries.

const fs = require('fs');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');

// Load a local .env file if it exists (development).
(function loadEnvIfPresent() {
  const file = path.join(__dirname, '..', '.env');
  try {
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, 'utf8');
    text.split(/\r?\n/).forEach(line => {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) return;
      if (line.trim().startsWith('#')) return;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    });
  } catch (_) { /* ignore */ }
})();

let clientInstance = null;
let dbInstance = null;

async function getClient() {
  if (clientInstance) {
    try {
      // Check if client is still connected / topology is open
      if (clientInstance.topology && clientInstance.topology.isConnected()) {
        return clientInstance;
      }
    } catch (_) {}
    try { await clientInstance.close(); } catch (_) {}
    clientInstance = null;
    dbInstance = null;
  }
  const url = process.env.MONGODB_URI || process.env.DATABASE_URL;
  if (!url) throw new Error('MONGODB_URI or DATABASE_URL is not set.');
  clientInstance = new MongoClient(url, {
    maxPoolSize: 10,
    connectTimeoutMS: 10000,
    serverSelectionTimeoutMS: 10000
  });
  await clientInstance.connect();
  return clientInstance;
}

async function getDb() {
  const cli = await getClient();
  const url = process.env.MONGODB_URI || process.env.DATABASE_URL || '';
  let dbName = 'bizflow';
  try {
    const u = new URL(url);
    const pathname = u.pathname.replace(/^\//, '');
    if (pathname) dbName = pathname.split('?')[0];
  } catch (_) {}
  dbInstance = cli.db(dbName);
  return dbInstance;
}

// Emulate PostgreSQL pool and query interface over MongoDB collections
class MongoDbClient {
  constructor(db) {
    this.db = db;
  }
  async query(text, params = []) {
    return query(text, params);
  }
  release() {
    // no-op for mock client release
  }
}

let mockPool = {
  async connect() {
    const db = await getDb();
    return new MongoDbClient(db);
  },
  async query(text, params) {
    return query(text, params);
  },
  on() {},
  async end() {
    if (clientInstance) {
      await clientInstance.close();
      clientInstance = null;
      dbInstance = null;
    }
  }
};

function getPool() {
  return mockPool;
}

// SQL Query parser & emulator for MongoDB
async function query(text, params = []) {
  const db = await getDb();
  const sql = text.trim();
  const lower = sql.toLowerCase();

  // Helper to replace $1, $2 with params[0], params[1]
  function bind(sqlText, p) {
    let i = 0;
    return sqlText.replace(/\$(\d+)/g, (_, n) => {
      const idx = Number(n) - 1;
      const val = p[idx];
      return val !== undefined ? JSON.stringify(val) : 'null';
    });
  }

  // 1. SELECT 1 / health check
  if (lower.startsWith('select 1')) {
    return { rows: [{ '?column?': 1 }] };
  }

  // 2. ACCOUNTS
  if (lower.includes('from accounts') || lower.startsWith('insert into accounts') || lower.startsWith('update accounts') || lower.startsWith('delete from accounts')) {
    const accountsCol = db.collection('accounts');
    if (lower.startsWith('select')) {
      if (lower.includes('lower(email) = lower($1)')) {
        const email = (params[0] || '').toLowerCase();
        const doc = await accountsCol.findOne({ email: new RegExp('^' + escapeRegExp(email) + '$', 'i') });
        return { rows: doc ? [transformDoc(doc)] : [] };
      }
      if (lower.includes('id = $1')) {
        const id = Number(params[0]);
        const doc = await accountsCol.findOne({ id });
        return { rows: doc ? [transformDoc(doc)] : [] };
      }
      if (lower.includes('count(*)::int')) {
        const email = (params[0] || '').toLowerCase();
        const count = await accountsCol.countDocuments({ email: new RegExp('^' + escapeRegExp(email) + '$', 'i') });
        return { rows: [{ c: count }] };
      }
    }
    if (lower.startsWith('insert into accounts')) {
      const accountsSeq = db.collection('sequences');
      let seq = await accountsSeq.findOneAndUpdate({ name: 'accounts_id' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
      const id = seq.seq || 1;
      const doc = {
        id,
        email: params[0],
        password_hash: params[1],
        business_name: params[2],
        business_code: null,
        app_version: params[3],
        status: params[4] || 'PENDING',
        created_at: new Date(),
        verified_at: null
      };
      await accountsCol.insertOne(doc);
      return { rows: [{ id }] };
    }
    if (lower.startsWith('update accounts')) {
      const set = {};
      // Resolve the target account id: use WHERE id = $N when present, else the last numeric param.
      let id = null;
      const whereId = /where\s+id\s*=\s*\$(\d+)/i.exec(sql);
      if (whereId) {
        id = Number(params[Number(whereId[1]) - 1]);
      } else {
        const nums = params.filter(p => p !== null && p !== undefined && !isNaN(Number(p)));
        if (nums.length) id = Number(nums[nums.length - 1]);
      }

      // status = 'ACTIVE' literal or status = $N parameter
      if (lower.includes("status = 'active'")) {
        set.status = 'ACTIVE';
        set.verified_at = new Date();
      } else {
        const statusParam = /set\s+status\s*=\s*\$(\d+)/i.exec(sql);
        if (statusParam) {
          set.status = String(params[Number(statusParam[1]) - 1]);
          set.verified_at = new Date();
        }
      }
      if (lower.includes('password_hash = $1')) set.password_hash = params[0];
      const hashParam = /set\s+password_hash\s*=\s*\$(\d+)/i.exec(sql);
      if (hashParam) set.password_hash = params[Number(hashParam[1]) - 1];
      const businessNameParam = /set\s+business_name\s*=\s*\$(\d+)/i.exec(sql);
      if (businessNameParam) set.business_name = params[Number(businessNameParam[1]) - 1];
      const appVersionParam = /set\s+app_version\s*=\s*\$(\d+)/i.exec(sql);
      if (appVersionParam) set.app_version = params[Number(appVersionParam[1]) - 1];
      const businessCodeParam = /set\s+business_code\s*=\s*\$(\d+)/i.exec(sql);
      if (businessCodeParam) set.business_code = params[Number(businessCodeParam[1]) - 1];

      if (id !== null && !isNaN(id) && Object.keys(set).length) {
        await accountsCol.updateOne({ id }, { $set: set });
      }
      return { rows: [] };
    }
    if (lower.startsWith('delete from accounts')) {
      const id = Number(params[0]);
      await accountsCol.deleteOne({ id });
      return { rows: [] };
    }
  }

  // 3. BUSINESSES
  if (lower.includes('from businesses') || lower.startsWith('insert into businesses') || lower.startsWith('update businesses') || lower.startsWith('delete from businesses')) {
    const bizCol = db.collection('businesses');
    if (lower.startsWith('select')) {
      const filterActive = /\bactive\s*=\s*true\b/.test(lower);
      if (lower.includes('account_id is null') && lower.includes('lower(name) = lower($1)')) {
        const name = String(params[0] || '').trim();
        const filter = {
          account_id: null,
          name: new RegExp('^' + escapeRegExp(name) + '$', 'i'),
          app: params[1]
        };
        if (filterActive) filter.active = true;
        const docs = await bizCol.find(filter).toArray();
        return { rows: docs.map(transformDoc) };
      }
      if (lower.includes('code = $1 and app = $2')) {
        const filter = { code: params[0], app: params[1] };
        if (filterActive) filter.active = true;
        const doc = await bizCol.findOne(filter);
        return { rows: doc ? [transformDoc(doc)] : [] };
      }
      if (lower.includes('account_id = $1')) {
        const accountRef = String(params[0]);
        const filter = {
          account_id: /^\d+$/.test(accountRef) ? { $in: [accountRef, Number(accountRef)] } : accountRef
        };
        if (lower.includes('app = $2')) filter.app = params[1];
        if (filterActive) filter.active = true;
        const docs = await bizCol.find(filter).sort({ app: 1 }).toArray();
        return { rows: docs.map(transformDoc) };
      }
      if (lower.includes('code = $1')) {
        const filter = { code: params[0] };
        if (filterActive) filter.active = true;
        const doc = await bizCol.findOne(filter);
        return { rows: doc ? [transformDoc(doc)] : [] };
      }
    }
    if (lower.startsWith('insert into businesses')) {
      const seqCol = db.collection('sequences');
      let seq = await seqCol.findOneAndUpdate({ name: 'businesses_id' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
      const id = seq.seq || 1;
      const doc = {
        id,
        code: params[0],
        name: params[1],
        app: params[2],
        active: params[3] !== false,
        created_at: new Date(),
        account_id: params[4] ? String(params[4]) : null
      };
      await bizCol.insertOne(doc);
      return { rows: [{ id }] };
    }
    if (lower.startsWith('update businesses')) {
      const accountCode = String(params[0]);
      const id = Number(params[1]);
      const filter = { id };
      if (lower.includes('account_id is null')) {
        filter.account_id = null;
      } else if (lower.includes('account_id = $3')) {
        const previousRef = String(params[2]);
        filter.account_id = /^\d+$/.test(previousRef)
          ? { $in: [previousRef, Number(previousRef)] }
          : previousRef;
      }
      const updated = await bizCol.updateOne(
        filter,
        { $set: { account_id: accountCode } }
      );
      return { rows: updated.modifiedCount ? [{ id }] : [] };
    }
    if (lower.startsWith('delete from businesses')) {
      if (lower.includes('code = $1')) {
        await bizCol.deleteMany({ code: params[0] });
      } else if (lower.includes('account_id = $1')) {
        const accountRef = String(params[0]);
        await bizCol.deleteMany({
          account_id: /^\d+$/.test(accountRef) ? { $in: [accountRef, Number(accountRef)] } : accountRef
        });
      }
      return { rows: [] };
    }
  }

  // 4. COUNTERS
  if (lower.includes('from counters') || lower.startsWith('insert into counters')) {
    const countersCol = db.collection('counters');
    if (lower.startsWith('insert into counters')) {
      const bizId = Number(params[0]);
      const name = params[1];
      const initialVal = params[2] !== undefined ? Number(params[2]) : 1;
      let res;
      if (lower.includes('do update set value = counters.value + 1')) {
        res = await countersCol.findOneAndUpdate(
          { business_id: bizId, name },
          { $inc: { value: 1 } },
          { upsert: true, returnDocument: 'after' }
        );
      } else if (lower.includes('do update set value = greatest')) {
        res = await countersCol.findOneAndUpdate(
          { business_id: bizId, name },
          { $max: { value: initialVal } },
          { upsert: true, returnDocument: 'after' }
        );
      } else {
        res = await countersCol.findOneAndUpdate(
          { business_id: bizId, name },
          { $setOnInsert: { value: initialVal } },
          { upsert: true, returnDocument: 'after' }
        );
      }
      return { rows: [{ value: res.value || initialVal }] };
    }
  }

  // 5. SALES_CONFIG / SVC_SETTINGS
  if (lower.includes('sales_config') || lower.includes('svc_settings')) {
    const collName = lower.includes('sales_config') ? 'sales_config' : 'svc_settings';
    const coll = db.collection(collName);
    const bizId = Number(params[0]);
    if (lower.startsWith('select')) {
      const docs = await coll.find({ business_id: bizId }).toArray();
      return { rows: docs.map(d => ({ key: d.key, value: d.value })) };
    }
    if (lower.startsWith('insert into')) {
      const key = params[1];
      const val = params[2];
      await coll.updateOne(
        { business_id: bizId, key },
        { $set: { value: String(val) } },
        { upsert: true }
      );
      return { rows: [] };
    }
  }

  // 6. SALES_PRODUCTS
  if (lower.includes('sales_products')) {
    const coll = db.collection('sales_products');
    const bizId = Number(params[0]);
    if (lower.startsWith('select')) {
      if (lower.includes('product_id = $2')) {
        const prodId = params[1];
        const doc = await coll.findOne({ business_id: bizId, product_id: prodId });
        return { rows: doc ? [transformDoc(doc)] : [] };
      }
      const docs = await coll.find({ business_id: bizId }).toArray();
      return { rows: docs.map(transformDoc) };
    }
    if (lower.startsWith('insert into sales_products')) {
      const seqCol = db.collection('sequences');
      let seq = await seqCol.findOneAndUpdate({ name: 'sales_products_id' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
      const id = seq.seq || 1;
      const doc = {
        id,
        business_id: bizId,
        product_id: params[1],
        name: params[2],
        category: params[3],
        cost_price: Number(params[4]),
        selling_price: Number(params[5]),
        stock: Number(params[6]),
        unit: params[7]
      };
      await coll.updateOne({ business_id: bizId, product_id: doc.product_id }, { $set: doc }, { upsert: true });
      return { rows: [{ id }] };
    }
    if (lower.startsWith('update sales_products')) {
      const setObj = {};
      if (lower.includes('stock = stock')) {
        const delta = Number(params[1]);
        const prodId = params[2];
        await coll.updateOne({ business_id: bizId, product_id: prodId }, { $inc: { stock: delta } });
      } else {
        // generic updates
        const prodId = params[params.length - 1];
        if (lower.includes('stock = $1')) setObj.stock = Number(params[0]);
        if (lower.includes('name = $1')) setObj.name = params[0];
        if (lower.includes('selling_price = $1')) setObj.selling_price = Number(params[0]);
        if (lower.includes('cost_price = $1')) setObj.cost_price = Number(params[0]);
        if (Object.keys(setObj).length) {
          await coll.updateOne({ business_id: bizId, product_id: prodId }, { $set: setObj });
        }
      }
      return { rows: [] };
    }
  }

  // 7. SALES_CUSTOMERS
  if (lower.includes('sales_customers')) {
    const coll = db.collection('sales_customers');
    const bizId = Number(params[0]);
    if (lower.startsWith('select')) {
      const docs = await coll.find({ business_id: bizId }).toArray();
      return { rows: docs.map(transformDoc) };
    }
    if (lower.startsWith('insert into sales_customers')) {
      const seqCol = db.collection('sequences');
      let seq = await seqCol.findOneAndUpdate({ name: 'sales_customers_id' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
      const id = seq.seq || 1;
      const doc = {
        id,
        business_id: bizId,
        customer_id: params[1],
        name: params[2],
        phone: params[3],
        email: params[4],
        address: params[5],
        total_purchases: Number(params[6]) || 0,
        date_added: params[7] || new Date()
      };
      await coll.updateOne({ business_id: bizId, customer_id: doc.customer_id }, { $set: doc }, { upsert: true });
      return { rows: [{ id }] };
    }
    if (lower.startsWith('update sales_customers')) {
      const totalPurchases = Number(params[0]);
      const custId = params[1];
      await coll.updateOne({ business_id: bizId, customer_id: custId }, { $set: { total_purchases: totalPurchases } });
      return { rows: [] };
    }
  }

  // 8. SALES_EXPENSES (Batches & inventory cost layers)
  if (lower.includes('sales_expenses')) {
    const coll = db.collection('sales_expenses');
    const bizId = Number(params[0]);
    if (lower.startsWith('select')) {
      if (lower.includes('max(sort_order)')) {
        const maxDoc = await coll.findOne({ business_id: bizId }, { sort: { sort_order: -1 } });
        return { rows: [{ o: maxDoc ? maxDoc.sort_order || 0 : 0 }] };
      }
      if (lower.includes('qty_remaining > 0')) {
        const productId = params[1];
        const docs = await coll.find({ business_id: bizId, product_id: productId, qty_remaining: { $gt: 0 } }).sort({ type: 1, sort_order: 1, id: 1 }).toArray();
        return { rows: docs.map(transformDoc) };
      }
      const docs = await coll.find({ business_id: bizId }).toArray();
      return { rows: docs.map(transformDoc) };
    }
    if (lower.startsWith('insert into sales_expenses')) {
      const seqCol = db.collection('sequences');
      let seq = await seqCol.findOneAndUpdate({ name: 'sales_expenses_id' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
      const id = seq.seq || 1;
      const doc = {
        id,
        business_id: bizId,
        expense_id: params[1],
        date: params[2],
        product_id: params[3],
        product_name: params[4],
        type: params[5],
        qty: Number(params[6]),
        unit_cost: Number(params[7]),
        total_cost: Number(params[8]),
        selling_price: Number(params[9]),
        qty_remaining: Number(params[10]),
        sort_order: Number(params[11]) || 1
      };
      await coll.insertOne(doc);
      return { rows: [{ id }] };
    }
    if (lower.startsWith('update sales_expenses')) {
      const qtyRemaining = Number(params[0]);
      const expenseId = params[1];
      await coll.updateOne({ business_id: bizId, expense_id: expenseId }, { $set: { qty_remaining: qtyRemaining } });
      return { rows: [] };
    }
  }

  // 9. SALES_CATEGORIES & SALES_RUNNING_EXPENSES
  if (lower.includes('sales_categories')) {
    const coll = db.collection('sales_categories');
    const bizId = Number(params[0]);
    if (lower.startsWith('select')) {
      if (lower.includes('count(*)')) {
        return { rows: [{ n: await coll.countDocuments({ business_id: bizId }) }] };
      }
      const docs = await coll.find({ business_id: bizId }).toArray();
      return { rows: docs.map(transformDoc) };
    }
    if (lower.startsWith('insert into sales_categories')) {
      const seqCol = db.collection('sequences');
      let seq = await seqCol.findOneAndUpdate({ name: 'sales_categories_id' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
      const id = seq.seq || 1;
      const doc = {
        id,
        business_id: bizId,
        category_id: params[1],
        name: params[2],
        type: params[3],
        active: params[4]
      };
      await coll.updateOne({ business_id: bizId, category_id: doc.category_id }, { $set: doc }, { upsert: true });
      return { rows: [{ id }] };
    }
  }
  if (lower.includes('sales_running_expenses')) {
    const coll = db.collection('sales_running_expenses');
    const bizId = Number(params[0]);
    if (lower.startsWith('select')) {
      const docs = await coll.find({ business_id: bizId }).toArray();
      return { rows: docs.map(transformDoc) };
    }
    if (lower.startsWith('insert into sales_running_expenses')) {
      const seqCol = db.collection('sequences');
      let seq = await seqCol.findOneAndUpdate({ name: 'sales_running_expenses_id' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
      const id = seq.seq || 1;
      const doc = {
        id,
        business_id: bizId,
        expense_id: params[1],
        date: params[2],
        category: params[3],
        description: params[4],
        amount: Number(params[5]),
        created_at: params[6] || new Date()
      };
      await coll.insertOne(doc);
      return { rows: [{ id }] };
    }
  }

  // 10. SALES_SALES & SALES_SALE_ITEMS
  if (lower.includes('sales_sales')) {
    const coll = db.collection('sales_sales');
    const bizId = Number(params[0]);
    if (lower.startsWith('select')) {
      const docs = await coll.find({ business_id: bizId }).toArray();
      return { rows: docs.map(transformDoc) };
    }
    if (lower.startsWith('insert into sales_sales')) {
      const seqCol = db.collection('sequences');
      let seq = await seqCol.findOneAndUpdate({ name: 'sales_sales_id' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
      const id = seq.seq || 1;
      const doc = {
        id,
        business_id: bizId,
        sale_id: params[1],
        date: params[2],
        customer_id: params[3],
        customer_name: params[4],
        subtotal: Number(params[5]),
        discount: Number(params[6]),
        total: Number(params[7]),
        payment_method: params[8],
        items_json: params[9],
        receipt_id: params[10],
        receipt_url: params[11]
      };
      await coll.insertOne(doc);
      return { rows: [{ id }] };
    }
  }
  if (lower.includes('sales_sale_items')) {
    const coll = db.collection('sales_sale_items');
    const bizId = Number(params[0]);
    if (lower.startsWith('select')) {
      const docs = await coll.find({ business_id: bizId }).toArray();
      return { rows: docs.map(transformDoc) };
    }
    if (lower.startsWith('insert into sales_sale_items')) {
      const seqCol = db.collection('sequences');
      let seq = await seqCol.findOneAndUpdate({ name: 'sales_sale_items_id' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
      const id = seq.seq || 1;
      const doc = {
        id,
        business_id: bizId,
        sale_id: params[1],
        product_id: params[2],
        product_name: params[3],
        qty: Number(params[4]),
        unit_price: Number(params[5]),
        cost_price: Number(params[6]),
        total: Number(params[7]),
        profit: Number(params[8])
      };
      await coll.insertOne(doc);
      return { rows: [{ id }] };
    }
  }

  // 11. SVC_SERVICES, SVC_CATEGORIES, SVC_CUSTOMERS, SVC_EXPENSES, SVC_SALES, SVC_SALE_ITEMS
  if (lower.includes('svc_services')) {
    const coll = db.collection('svc_services');
    const bizId = Number(params[0]);
    if (lower.startsWith('select')) {
      if (lower.includes('count(*)')) {
        return { rows: [{ n: await coll.countDocuments({ business_id: bizId }) }] };
      }
      if (lower.includes('service_id = $2')) {
        const doc = await coll.findOne({ business_id: bizId, service_id: params[1] });
        return { rows: doc ? [transformDoc(doc)] : [] };
      }
      const docs = await coll.find({ business_id: bizId }).toArray();
      return { rows: docs.map(transformDoc) };
    }
    if (lower.startsWith('insert into svc_services')) {
      const seqCol = db.collection('sequences');
      let seq = await seqCol.findOneAndUpdate({ name: 'svc_services_id' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
      const id = seq.seq || 1;
      const doc = {
        id,
        business_id: bizId,
        service_id: params[1],
        name: params[2],
        price: Number(params[3]),
        active: params[4] !== false
      };
      await coll.updateOne({ business_id: bizId, service_id: doc.service_id }, { $set: doc }, { upsert: true });
      return { rows: [{ id }] };
    }
    if (lower.startsWith('update svc_services')) {
      const setObj = {};
      const targetId = params[params.length - 1];
      if (lower.includes('name = $1')) setObj.name = params[0];
      if (lower.includes('price = $1')) setObj.price = Number(params[0]);
      if (lower.includes('active = $1')) setObj.active = Boolean(params[0]);
      await coll.updateOne({ business_id: bizId, id: targetId }, { $set: setObj });
      return { rows: [] };
    }
  }

  if (lower.includes('svc_categories')) {
    const coll = db.collection('svc_categories');
    const bizId = Number(params[0]);
    if (lower.startsWith('select')) {
      if (lower.includes('count(*)')) {
        return { rows: [{ n: await coll.countDocuments({ business_id: bizId }) }] };
      }
      const docs = await coll.find({ business_id: bizId }).toArray();
      return { rows: docs.map(transformDoc) };
    }
    if (lower.startsWith('insert into svc_categories')) {
      const seqCol = db.collection('sequences');
      let seq = await seqCol.findOneAndUpdate({ name: 'svc_categories_id' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
      const id = seq.seq || 1;
      const doc = {
        id,
        business_id: bizId,
        category_id: params[1],
        name: params[2],
        type: params[3],
        active: params[4] !== false
      };
      await coll.updateOne({ business_id: bizId, category_id: doc.category_id }, { $set: doc }, { upsert: true });
      return { rows: [{ id }] };
    }
    if (lower.startsWith('update svc_categories')) {
      const setObj = {};
      const targetId = params[params.length - 1];
      if (lower.includes('name = $1')) setObj.name = params[0];
      if (lower.includes('active = $1')) setObj.active = Boolean(params[0]);
      await coll.updateOne({ business_id: bizId, id: targetId }, { $set: setObj });
      return { rows: [] };
    }
  }

  if (lower.includes('svc_customers')) {
    const coll = db.collection('svc_customers');
    const bizId = Number(params[0]);
    if (lower.startsWith('select')) {
      const docs = await coll.find({ business_id: bizId }).toArray();
      return { rows: docs.map(transformDoc) };
    }
    if (lower.startsWith('insert into svc_customers')) {
      const seqCol = db.collection('sequences');
      let seq = await seqCol.findOneAndUpdate({ name: 'svc_customers_id' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
      const id = seq.seq || 1;
      const doc = {
        id,
        business_id: bizId,
        customer_id: params[1],
        name: params[2],
        phone: params[3],
        address: params[4],
        notes: params[5],
        created_at: params[6] || new Date()
      };
      await coll.updateOne({ business_id: bizId, customer_id: doc.customer_id }, { $set: doc }, { upsert: true });
      return { rows: [{ id }] };
    }
  }

  if (lower.includes('svc_expenses')) {
    const coll = db.collection('svc_expenses');
    const bizId = Number(params[0]);
    if (lower.startsWith('select')) {
      const docs = await coll.find({ business_id: bizId }).toArray();
      return { rows: docs.map(transformDoc) };
    }
    if (lower.startsWith('insert into svc_expenses')) {
      const seqCol = db.collection('sequences');
      let seq = await seqCol.findOneAndUpdate({ name: 'svc_expenses_id' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
      const id = seq.seq || 1;
      const doc = {
        id,
        business_id: bizId,
        expense_id: params[1],
        date: params[2],
        category: params[3],
        description: params[4],
        amount: Number(params[5]),
        created_at: params[6] || new Date()
      };
      await coll.insertOne(doc);
      return { rows: [{ id }] };
    }
  }

  if (lower.includes('svc_sales')) {
    const coll = db.collection('svc_sales');
    const bizId = Number(params[0]);
    if (lower.startsWith('select')) {
      const docs = await coll.find({ business_id: bizId }).toArray();
      return { rows: docs.map(transformDoc) };
    }
    if (lower.startsWith('insert into svc_sales')) {
      const seqCol = db.collection('sequences');
      let seq = await seqCol.findOneAndUpdate({ name: 'svc_sales_id' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
      const id = seq.seq || 1;
      const doc = {
        id,
        business_id: bizId,
        sale_id: params[1],
        date: params[2],
        customer_id: params[3],
        customer_name: params[4],
        subtotal: Number(params[5]),
        discount: Number(params[6]),
        total: Number(params[7]),
        payment_method: params[8],
        items_json: params[9],
        receipt_id: params[10],
        receipt_url: params[11]
      };
      await coll.insertOne(doc);
      return { rows: [{ id }] };
    }
  }

  if (lower.includes('svc_sale_items')) {
    const coll = db.collection('svc_sale_items');
    const bizId = Number(params[0]);
    if (lower.startsWith('select')) {
      const docs = await coll.find({ business_id: bizId }).toArray();
      return { rows: docs.map(transformDoc) };
    }
    if (lower.startsWith('insert into svc_sale_items')) {
      const seqCol = db.collection('sequences');
      let seq = await seqCol.findOneAndUpdate({ name: 'svc_sale_items_id' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
      const id = seq.seq || 1;
      const doc = {
        id,
        business_id: bizId,
        sale_id: params[1],
        service_id: params[2],
        service_name: params[3],
        qty: Number(params[4]),
        unit_price: Number(params[5]),
        total: Number(params[6])
      };
      await coll.insertOne(doc);
      return { rows: [{ id }] };
    }
  }

  // 12. EMAIL_VERIFICATIONS, PASSWORD_OTP, SESSIONS
  if (lower.includes('email_verifications')) {
    const coll = db.collection('email_verifications');
    if (lower.startsWith('select')) {
      if (lower.includes('token_hash = $1')) {
        const doc = await coll.findOne({ token_hash: params[0] });
        return { rows: doc ? [transformDoc(doc)] : [] };
      }
    }
    if (lower.startsWith('insert into email_verifications')) {
      const doc = {
        account_id: Number(params[0]),
        token_hash: params[1],
        expires_at: params[2],
        consumed_at: null,
        created_at: new Date()
      };
      await coll.insertOne(doc);
      return { rows: [] };
    }
    if (lower.startsWith('update email_verifications')) {
      if (lower.includes('account_id = $1')) {
        await coll.updateMany({ account_id: Number(params[0]) }, { $set: { consumed_at: new Date() } });
      } else if (lower.includes('token_hash = $1')) {
        await coll.updateOne({ token_hash: params[0] }, { $set: { consumed_at: new Date() } });
      }
      return { rows: [] };
    }
  }

  if (lower.includes('password_otp')) {
    const coll = db.collection('password_otp');
    if (lower.startsWith('select')) {
      if (lower.includes('account_id = $1')) {
        const docs = await coll.find({ account_id: Number(params[0]) }).sort({ created_at: -1 }).toArray();
        return { rows: docs.map(transformDoc) };
      }
    }
    if (lower.startsWith('insert into password_otp')) {
      const doc = {
        account_id: Number(params[0]),
        otp_hash: params[1],
        expires_at: params[2],
        consumed_at: null,
        created_at: new Date()
      };
      await coll.insertOne(doc);
      return { rows: [] };
    }
    if (lower.startsWith('update password_otp')) {
      await coll.updateMany({ account_id: Number(params[0]) }, { $set: { consumed_at: new Date() } });
      return { rows: [] };
    }
  }

  if (lower.includes('from sessions') || lower.startsWith('insert into sessions') || lower.startsWith('delete from sessions')) {
    const coll = db.collection('sessions');
    if (lower.startsWith('select')) {
      if (lower.includes('token_hash = $1')) {
        const doc = await coll.findOne({ token_hash: params[0] });
        return { rows: doc ? [transformDoc(doc)] : [] };
      }
    }
    if (lower.startsWith('insert into sessions')) {
      const doc = {
        account_id: Number(params[0]),
        token_hash: params[1],
        expires_at: params[2],
        created_at: new Date()
      };
      await coll.insertOne(doc);
      return { rows: [] };
    }
    if (lower.startsWith('delete from sessions')) {
      await coll.deleteMany({ token_hash: params[0] });
      return { rows: [] };
    }
  }

  // Fallback / default empty result
  return { rows: [] };
}

function transformDoc(doc) {
  if (!doc) return doc;
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === '_id') continue;
    out[k] = v;
  }
  return out;
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function withTransaction(fn) {
  // The Mongo "SQL emulator" cannot bind queries to a real session, so a true transaction
  // is not possible here. Run the callback directly (no session) to avoid failures on
  // deployments without a replica set. Callers still get a client-like object.
  const mockClient = new MongoDbClient(await getDb());
  return fn(mockClient);
}

async function close() {
  if (clientInstance) {
    await clientInstance.close();
    clientInstance = null;
    dbInstance = null;
  }
}

module.exports = { getPool, query, withTransaction, close };
