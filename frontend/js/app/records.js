// Records: sales / customers / products / services / expenses with search.
(function () {
  var BZ = window.BZ;
  var apps = BZ.apps();
  var hasSales = apps.indexOf('sales') !== -1;
  var hasServices = apps.indexOf('services') !== -1;
  var CUR = '₦';
  var current = 'sales';
  var cache = {};

  function money(n) { return CUR + (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function d(iso) { return iso ? new Date(iso).toLocaleDateString() : ''; }

  var LOADERS = {
    sales: function () {
      var jobs = [];
      if (hasSales) jobs.push(BZ.call('sales', 'getSalesHistory', [5000]).then(function (r) { return (r || []).map(function (x) { return { ref: x.saleId, customer: x.customerName, date: x.date, amount: Number(x.total) || 0, src: 'sales' }; }); }));
      if (hasServices) jobs.push(BZ.call('services', 'getRecentSales', [1000]).then(function (r) { return (r || []).map(function (x) { return { ref: x.saleId || x.receiptNo, customer: x.customerName, date: x.date, amount: Number(x.total) || 0, src: 'services' }; }); }));
      return Promise.all(jobs).then(function (g) { var a = []; g.forEach(function (x) { a = a.concat(x); }); return a.sort(function (x, y) { return new Date(y.date) - new Date(x.date); }); });
    },
    customers: function () {
      var jobs = [];
      if (hasSales) jobs.push(BZ.call('sales', 'getCustomersList').then(function (r) { return (r || []).map(function (x) { return { name: x.Name, phone: x.Phone, extra: x.Email || '', src: 'sales' }; }); }));
      if (hasServices) jobs.push(BZ.call('services', 'getCustomersWithSpend').then(function (r) { return (r || []).map(function (x) { return { name: x.Name, phone: x.Phone, extra: money(x.TotalSpent), src: 'services' }; }); }));
      return Promise.all(jobs).then(function (g) { var a = []; g.forEach(function (x) { a = a.concat(x); }); return a; });
    },
    products: function () {
      if (!hasSales) return Promise.resolve([]);
      return BZ.call('sales', 'getProductsList').then(function (r) { return (r || []).map(function (x) { return { name: x.Name, cat: x.Category, price: Number(x.SellingPrice) || 0, stock: Number(x.Stock) || 0 }; }); });
    },
    services: function () {
      if (!hasServices) return Promise.resolve([]);
      return BZ.call('services', 'getAllServices').then(function (r) { return (r || []).map(function (x) { return { name: x.Name, price: Number(x.Price) || 0, active: x.Active }; }); });
    },
    expenses: function () {
      var jobs = [];
      if (hasServices) jobs.push(BZ.call('services', 'getExpenses', [null, null]).then(function (r) { return (r || []).map(function (x) { return { name: x.Description || x.Category, cat: x.Category, date: x.Date, amount: Number(x.Amount) || 0, src: 'services' }; }); }));
      if (hasSales) jobs.push(Promise.all([BZ.call('sales', 'getExpensesList'), BZ.call('sales', 'getRunningExpenses')]).then(function (rr) {
        var out = [];
        (rr[0] || []).forEach(function (x) { out.push({ name: x.name, cat: x.type, date: x.date, amount: Number(x.total) || 0, src: 'purchase' }); });
        (rr[1] || []).forEach(function (x) { out.push({ name: x.description || x.category, cat: x.category, date: x.date, amount: Number(x.amount) || 0, src: 'running' }); });
        return out;
      }));
      return Promise.all(jobs).then(function (g) { var a = []; g.forEach(function (x) { a = a.concat(x); }); return a.sort(function (x, y) { return new Date(y.date) - new Date(x.date); }); });
    }
  };

  var HEADS = {
    sales: ['Ref', 'Customer', 'Date', 'Amount', 'Source'],
    customers: ['Name', 'Phone', 'Extra', 'Source'],
    products: ['Product', 'Category', 'Price', 'Stock'],
    services: ['Service', 'Price', 'Active'],
    expenses: ['Description', 'Category', 'Date', 'Amount', 'Source']
  };

  function renderRows(kind, rows) {
    var q = (document.getElementById('recSearch').value || '').toLowerCase();
    var list = (rows || []).filter(function (r) {
      if (!q) return true;
      return Object.keys(r).some(function (k) { return String(r[k] || '').toLowerCase().indexOf(q) !== -1; });
    });
    var thead = document.querySelector('#recTable thead');
    var tbody = document.querySelector('#recTable tbody');
    thead.innerHTML = '<tr>' + HEADS[kind].map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr>';
    if (!list.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="' + HEADS[kind].length + '">No records found.</td></tr>'; return; }
    tbody.innerHTML = list.slice(0, 400).map(function (r) {
      if (kind === 'sales') return '<tr><td class="strong">' + esc(r.ref) + '</td><td>' + esc(r.customer || 'Walk-in') + '</td><td>' + d(r.date) + '</td><td class="strong">' + money(r.amount) + '</td><td><span class="badge">' + esc(r.src) + '</span></td></tr>';
      if (kind === 'customers') return '<tr><td class="strong">' + esc(r.name) + '</td><td>' + esc(r.phone) + '</td><td>' + esc(r.extra) + '</td><td><span class="badge">' + esc(r.src) + '</span></td></tr>';
      if (kind === 'products') return '<tr><td class="strong">' + esc(r.name) + '</td><td>' + esc(r.cat) + '</td><td>' + money(r.price) + '</td><td>' + r.stock + '</td></tr>';
      if (kind === 'services') return '<tr><td class="strong">' + esc(r.name) + '</td><td>' + money(r.price) + '</td><td>' + (r.active === false ? 'Inactive' : 'Active') + '</td></tr>';
      return '<tr><td class="strong">' + esc(r.name) + '</td><td>' + esc(r.cat) + '</td><td>' + d(r.date) + '</td><td class="strong">' + money(r.amount) + '</td><td><span class="badge">' + esc(r.src) + '</span></td></tr>';
    }).join('');
  }

  function show(kind) {
    current = kind;
    document.querySelectorAll('#recSeg .seg-btn').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-rec') === kind); });
    if (cache[kind]) { renderRows(kind, cache[kind]); return; }
    LOADERS[kind]().then(function (rows) { cache[kind] = rows; renderRows(kind, rows); })
      .catch(function (e) { cache[kind] = []; renderRows(kind, []); });
  }

  document.querySelectorAll('#recSeg .seg-btn').forEach(function (b) {
    b.addEventListener('click', function () { show(b.getAttribute('data-rec')); });
  });
  document.getElementById('recSearch').addEventListener('input', function () { renderRows(current, cache[current] || []); });

  window.BZRecords = {
    reload: function () { cache = {}; var first = document.querySelector('#recSeg .seg-btn:not(.hidden)'); show((first && first.getAttribute('data-rec')) || 'sales'); }
  };
})();
