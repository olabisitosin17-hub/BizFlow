// Quick Actions tab: lists registered customers / products / services / expenses,
// with search + detail, and a "+ New record" sheet to create more.
(function () {
  var BZ = window.BZ;
  var apps = BZ.apps();
  var hasSales = apps.indexOf('sales') !== -1;
  var hasServices = apps.indexOf('services') !== -1;
  var CUR = '₦';

  var current = 'customers';
  var data = { customers: [], products: [], services: [], expenses: [] };
  var loadedOnce = false;

  var sheet = document.getElementById('quickSheet');
  var backdrop = document.getElementById('sheetBackdrop');
  var title = document.getElementById('quickTitle');
  var body = document.getElementById('quickBody');

  function money(n) { return CUR + (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function toast(m) { var t = document.getElementById('toast'); t.textContent = m; t.classList.add('show'); setTimeout(function () { t.classList.remove('show'); }, 2200); }

  // -------- Load --------
  function load() {
    var jobs = [];
    jobs.push(BZ.call(hasSales ? 'sales' : 'services', 'getCustomersList').then(function (r) {
      data.customers = (r || []).map(function (x) { return { name: x.Name, phone: x.Phone, email: x.Email, address: x.Address, src: hasSales ? 'sales' : 'services' }; });
    }).catch(function () { data.customers = []; }));
    if (hasServices) {
      jobs.push(BZ.call('services', 'getCustomersWithSpend').then(function (r) {
        var seen = {}; data.customers.forEach(function (c) { seen[(c.phone || '') + c.name] = true; });
        (r || []).forEach(function (x) {
          var k = (x.Phone || '') + x.Name;
          if (!seen[k]) { seen[k] = true; data.customers.push({ name: x.Name, phone: x.Phone, address: x.Address, src: 'services' }); }
        });
      }).catch(function () {}));
    }
    if (hasSales) {
      jobs.push(BZ.call('sales', 'getProductsList').then(function (r) {
        data.products = (r || []).map(function (x) { return { name: x.Name, cat: x.Category, price: Number(x.SellingPrice) || 0, cost: Number(x.CostPrice) || 0, stock: Number(x.Stock) || 0 }; });
      }).catch(function () { data.products = []; }));
    }
    if (hasServices) {
      jobs.push(BZ.call('services', 'getAllServices').then(function (r) {
        data.services = (r || []).map(function (x) { return { name: x.Name, price: Number(x.Price) || 0, active: x.Active }; });
      }).catch(function () { data.services = []; }));
    }
    jobs.push(
      Promise.all([
        hasServices ? BZ.call('services', 'getExpenses', [null, null]).catch(function () { return []; }) : Promise.resolve([]),
        hasSales ? BZ.call('sales', 'getExpensesList').catch(function () { return []; }) : Promise.resolve([]),
        hasSales ? BZ.call('sales', 'getRunningExpenses').catch(function () { return []; }) : Promise.resolve([])
      ]).then(function (rr) {
        var out = [];
        (rr[0] || []).forEach(function (x) { out.push({ name: x.Description || x.Category, cat: x.Category, amount: Number(x.Amount) || 0, date: x.Date, src: 'services' }); });
        (rr[1] || []).forEach(function (x) { out.push({ name: x.name, cat: x.type, amount: Number(x.total) || 0, date: x.date, src: 'purchase' }); });
        (rr[2] || []).forEach(function (x) { out.push({ name: x.description || x.category, cat: x.category, amount: Number(x.amount) || 0, date: x.date, src: 'running' }); });
        data.expenses = out.sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
      })
    );
    return Promise.all(jobs).then(function () { loadedOnce = true; });
  }

  // -------- Render --------
  function rowsFor(kind) {
    var q = (document.getElementById('quickSearch').value || '').toLowerCase();
    var list = data[kind] || [];
    if (!q) return list;
    return list.filter(function (r) { return Object.keys(r).some(function (k) { return String(r[k] || '').toLowerCase().indexOf(q) !== -1; }); });
  }

  function render() {
    var list = rowsFor(current);
    var cnt = document.getElementById('quickCount'); if (cnt) cnt.textContent = list.length + ' item' + (list.length === 1 ? '' : 's');
    var el = document.getElementById('quickList');
    if (!list.length) { el.innerHTML = '<p class="muted" style="text-align:center;padding:26px">No ' + current + ' yet. Tap “＋ New record”.</p>'; return; }

    el.innerHTML = list.map(function (r, i) {
      if (current === 'customers') {
        return '<div class="qrec" data-i="' + i + '"><div class="qrec-main"><b>' + esc(r.name || 'Customer') + '</b>' +
          '<span>' + esc(r.phone || 'No phone') + (r.email ? ' · ' + esc(r.email) : '') + '</span></div>' +
          '<span class="badge">' + esc(r.src) + '</span></div>';
      }
      if (current === 'products') {
        return '<div class="qrec" data-i="' + i + '"><div class="qrec-main"><b>' + esc(r.name) + '</b>' +
          '<span>' + esc(r.cat || 'Uncategorised') + ' · Stock ' + r.stock + '</span></div>' +
          '<div class="qrec-amt">' + money(r.price) + '</div></div>';
      }
      if (current === 'services') {
        return '<div class="qrec" data-i="' + i + '"><div class="qrec-main"><b>' + esc(r.name) + '</b>' +
          '<span>' + (r.active === false ? 'Inactive' : 'Active') + '</span></div>' +
          '<div class="qrec-amt">' + money(r.price) + '</div></div>';
      }
      return '<div class="qrec" data-i="' + i + '"><div class="qrec-main"><b>' + esc(r.name || r.cat) + '</b>' +
        '<span>' + esc(r.cat) + ' · ' + (r.date ? new Date(r.date).toLocaleDateString() : '') + '</span></div>' +
        '<div class="qrec-amt">' + money(r.amount) + '</div></div>';
    }).join('');

    // Record detail on tap
    el.querySelectorAll('.qrec').forEach(function (row) {
      row.addEventListener('click', function () {
        var r = list[+row.getAttribute('data-i')];
        showDetail(current, r);
      });
    });
  }

  function showDetail(kind, r) {
    title.textContent = 'Details';
    var lines = Object.keys(r).filter(function (k) { return k !== 'src'; }).map(function (k) {
      return '<div class="row between" style="padding:8px 0;border-top:1px solid var(--line)"><span class="muted">' + esc(k) + '</span><b>' + esc(r[k]) + '</b></div>';
    }).join('');
    body.innerHTML = '<div>' + lines + '</div>';
    open();
  }

  function switchTab(kind) {
    current = kind;
    document.querySelectorAll('#quickSeg .seg-btn').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-qk') === kind); });
    render();
  }

  // -------- Create forms (reuse the sheet) --------
  function open() { sheet.classList.add('show'); backdrop.classList.add('show'); sheet.setAttribute('aria-hidden', 'false'); }
  function close() { sheet.classList.remove('show'); backdrop.classList.remove('show'); sheet.setAttribute('aria-hidden', 'true'); }

  function field(label, id, type, ph) { return '<div class="field"><label for="' + id + '">' + label + '</label><input class="input" id="' + id + '" type="' + (type || 'text') + '" placeholder="' + (ph || '') + '"></div>'; }

  function menu() {
    title.textContent = 'New record';
    var items = [{ k: 'customer', ico: '👤', h: 'Add customer' }];
    if (hasSales) items.push({ k: 'product', ico: '📦', h: 'Add product' });
    if (hasServices) items.push({ k: 'service', ico: '🛠️', h: 'Add service' });
    items.push({ k: 'expense', ico: '💸', h: 'Record expense' });
    body.innerHTML = '<div class="qa-list">' + items.map(function (it) {
      return '<button class="qa-item" data-act="' + it.k + '"><span class="qa-ico">' + it.ico + '</span><span><h4>' + it.h + '</h4></span></button>';
    }).join('') + '</div>';
    body.querySelectorAll('[data-act]').forEach(function (b) { b.addEventListener('click', function () { route(b.getAttribute('data-act')); }); });
  }
  function route(k) { if (k === 'customer') formCustomer(); else if (k === 'product') formProduct(); else if (k === 'service') formService(); else formExpense(); }

  function formCustomer() {
    title.textContent = 'Add customer';
    body.innerHTML = field('Customer name', 'qcName', 'text', 'e.g. Ada Obi') + field('Phone number', 'qcPhone', 'tel', '0801 234 5678') +
      field('Email', 'qcEmail', 'email', 'optional') + field('Address', 'qcAddr', 'text', 'optional') +
      '<div class="error-text" id="qcMsg"></div><button class="btn btn-primary btn-block" id="qcSave">Save customer</button>';
    document.getElementById('qcSave').addEventListener('click', function () {
      var name = document.getElementById('qcName').value.trim(), phone = document.getElementById('qcPhone').value.trim();
      var msg = document.getElementById('qcMsg'); msg.textContent = '';
      if (!name && !phone) { msg.textContent = 'Enter a name or phone.'; return; }
      var b = this; b.disabled = true; b.textContent = 'Saving…';
      BZ.call(hasSales ? 'sales' : 'services', 'addCustomer', [{ name: name, phone: phone, email: document.getElementById('qcEmail').value.trim(), address: document.getElementById('qcAddr').value.trim() }])
        .then(function () { b.disabled = false; b.textContent = 'Save customer'; close(); toast('Customer saved.'); refresh(); })
        .catch(function (e) { b.disabled = false; b.textContent = 'Save customer'; msg.textContent = e.message || 'Could not save.'; });
    });
  }

  function formProduct() {
    title.textContent = 'Add product';
    body.innerHTML = field('Product name', 'qpName', 'text', 'e.g. Detergent') + field('Category', 'qpCat', 'text', 'optional') +
      '<div class="field-row">' + field('Cost price', 'qpCost', 'number', '0') + field('Selling price', 'qpSell', 'number', '0') + '</div>' +
      field('Quantity in stock', 'qpStock', 'number', '0') +
      '<div class="error-text" id="qpMsg"></div><button class="btn btn-primary btn-block" id="qpSave">Save product</button>';
    document.getElementById('qpSave').addEventListener('click', function () {
      var name = document.getElementById('qpName').value.trim(), msg = document.getElementById('qpMsg'); msg.textContent = '';
      if (!name) { msg.textContent = 'Enter a product name.'; return; }
      var b = this; b.disabled = true; b.textContent = 'Saving…';
      BZ.call('sales', 'addProduct', [{ name: name, category: document.getElementById('qpCat').value.trim(), costPrice: Number(document.getElementById('qpCost').value) || 0, sellingPrice: Number(document.getElementById('qpSell').value) || 0, stock: Number(document.getElementById('qpStock').value) || 0, unit: 'pcs' }])
        .then(function () { b.disabled = false; b.textContent = 'Save product'; close(); toast('Product saved.'); refresh(); })
        .catch(function (e) { b.disabled = false; b.textContent = 'Save product'; msg.textContent = e.message || 'Could not save.'; });
    });
  }

  function formService() {
    title.textContent = 'Add service';
    body.innerHTML = field('Service name', 'qsName', 'text', 'e.g. Home visit') + field('Category', 'qsCat', 'text', 'optional') +
      field('Service price', 'qsPrice', 'number', '0') +
      '<div class="error-text" id="qsMsg"></div><button class="btn btn-primary btn-block" id="qsSave">Save service</button>';
    document.getElementById('qsSave').addEventListener('click', function () {
      var name = document.getElementById('qsName').value.trim(), msg = document.getElementById('qsMsg'); msg.textContent = '';
      if (!name) { msg.textContent = 'Enter a service name.'; return; }
      var b = this; b.disabled = true; b.textContent = 'Saving…';
      BZ.call('services', 'addService', [{ name: name, price: Number(document.getElementById('qsPrice').value) || 0 }])
        .then(function () { b.disabled = false; b.textContent = 'Save service'; close(); toast('Service saved.'); refresh(); })
        .catch(function (e) { b.disabled = false; b.textContent = 'Save service'; msg.textContent = e.message || 'Could not save.'; });
    });
  }

  function formExpense() {
    title.textContent = 'Record expense';
    body.innerHTML = field('Expense title', 'qeTitle', 'text', 'e.g. Generator fuel') + field('Category', 'qeCat', 'text', 'e.g. Fuel') +
      field('Amount', 'qeAmount', 'number', '0') + field('Date', 'qeDate', 'date', '') +
      '<div class="error-text" id="qeMsg"></div><button class="btn btn-primary btn-block" id="qeSave">Save expense</button>';
    try { document.getElementById('qeDate').value = new Date().toISOString().slice(0, 10); } catch (e) {}
    document.getElementById('qeSave').addEventListener('click', function () {
      var amount = Number(document.getElementById('qeAmount').value), msg = document.getElementById('qeMsg'); msg.textContent = '';
      if (!(amount > 0)) { msg.textContent = 'Enter an amount.'; return; }
      var b = this; b.disabled = true; b.textContent = 'Saving…';
      var cat = document.getElementById('qeCat').value.trim() || 'Other';
      var desc = document.getElementById('qeTitle').value.trim();
      var date = document.getElementById('qeDate').value;
      var p = hasServices ? BZ.call('services', 'addExpense', [{ category: cat, description: desc, amount: amount, date: date }])
        : BZ.call('sales', 'addRunningExpense', [{ category: cat, description: desc, amount: amount, date: date }]);
      p.then(function () { b.disabled = false; b.textContent = 'Save expense'; close(); toast('Expense recorded.'); refresh(); })
        .catch(function (e) { b.disabled = false; b.textContent = 'Save expense'; msg.textContent = e.message || 'Could not save.'; });
    });
  }

  // -------- Wire --------
  document.querySelectorAll('#quickSeg .seg-btn').forEach(function (b) {
    b.addEventListener('click', function () { switchTab(b.getAttribute('data-qk')); });
  });
  var qs = document.getElementById('quickSearch'); if (qs) qs.addEventListener('input', render);
  var qn = document.getElementById('quickNewBtn'); if (qn) qn.addEventListener('click', function () { menu(); open(); });
  document.getElementById('closeQuick').addEventListener('click', close);
  backdrop.addEventListener('click', close);

  function refresh() { return load().then(function(){ if (!currentVisible()) current = 'customers'; render(); }); }
  function currentVisible() {
    var btn = document.querySelector('#quickSeg .seg-btn[data-qk="' + current + '"]');
    return btn && !btn.classList.contains('hidden');
  }

  window.BZQuick = { reload: function () {
    var firstVisible = document.querySelector('#quickSeg .seg-btn:not(.hidden)');
    if (!currentVisible() && firstVisible) current = firstVisible.getAttribute('data-qk');
    refresh();
  } };
})();
