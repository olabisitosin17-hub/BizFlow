// Sales tab: record a sale + sales history. Adapts to Sales app, Services app, or both.
(function () {
  var BZ = window.BZ;
  var apps = BZ.apps();
  var hasSales = apps.indexOf('sales') !== -1;
  var hasServices = apps.indexOf('services') !== -1;
  var CUR = '₦';

  var state = { products: [], services: [], customers: [], cart: [] };
  var loaded = false;

  function money(n) { return CUR + (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  function loadData() {
    if (loaded) return Promise.resolve();
    var jobs = [];
    if (hasSales) {
      jobs.push(BZ.call('sales', 'getProductsList').then(function (p) { state.products = p || []; }));
      jobs.push(BZ.call('sales', 'getCustomersList').then(function (c) { state.customers = (c || []).map(function (x) { return { id: x.CustomerID, name: x.Name, src: 'sales' }; }); }));
    }
    if (hasServices) {
      jobs.push(BZ.call('services', 'getAllServices').then(function (s) {
        state.services = (s || []).filter(function (x) { return x.Active !== false; });
      }));
      jobs.push(BZ.call('services', 'getCustomersWithSpend').then(function (c) {
        var existing = {}; state.customers.forEach(function (x) { existing[x.id] = true; });
        (c || []).forEach(function (x) { if (!existing[x.CustomerID]) state.customers.push({ id: x.CustomerID, name: x.Name, src: 'services' }); });
      }));
    }
    return Promise.all(jobs).then(function () {
      loaded = true;
      populateCustomerSelect();
      populateItemSelect();
      loadHistory();
    });
  }

  function populateCustomerSelect() {
    var sel = document.getElementById('nsCustomer');
    if (!sel) return;
    sel.innerHTML = '<option value="">Walk-in / no customer</option>' +
      state.customers.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name || c.id) + '</option>'; }).join('');
  }

  function populateItemSelect() {
    var sel = document.getElementById('nsItem');
    if (!sel) return;
    var opts = [];
    state.products.forEach(function (p) {
      if (Number(p.Stock) < 0) return;
      opts.push({ v: 'p:' + p.ProductID, label: '🛒 ' + p.Name + ' — ' + money(p.SellingPrice) + ' (' + p.Stock + ' in stock)', price: p.SellingPrice, kind: 'product', id: p.ProductID, name: p.Name });
    });
    state.services.forEach(function (s) {
      opts.push({ v: 's:' + s.ServiceID, label: '🛠️ ' + s.Name + ' — ' + money(s.Price), price: s.Price, kind: 'service', id: s.ServiceID, name: s.Name });
    });
    sel._opts = opts;
    sel.innerHTML = '<option value="">Select item…</option>' + opts.map(function (o) { return '<option value="' + o.v + '">' + esc(o.label) + '</option>'; }).join('');
  }

  function renderCart() {
    var el = document.getElementById('nsCart');
    if (!el) return;
    if (!state.cart.length) { el.innerHTML = '<p class="muted" style="margin:6px 0">No items yet. Add products or services above.</p>'; }
    else {
      el.innerHTML = state.cart.map(function (it, i) {
        return '<div class="cart-row"><div class="ci-name">' + esc(it.name) + '</div>' +
          '<div class="ci-qty">' + it.qty + ' × ' + money(it.price) + '</div>' +
          '<div class="strong">' + money(it.qty * it.price) + '</div>' +
          '<button class="btn btn-ghost btn-sm" data-rm="' + i + '">✕</button></div>';
      }).join('');
      el.querySelectorAll('[data-rm]').forEach(function (b) {
        b.addEventListener('click', function () { state.cart.splice(+b.getAttribute('data-rm'), 1); renderCart(); recalc(); });
      });
    }
    recalc();
  }

  function recalc() {
    var subtotal = state.cart.reduce(function (s, it) { return s + it.qty * it.price; }, 0);
    var pct = Math.min(Math.max(Number(document.getElementById('nsDiscount').value) || 0, 0), 100);
    var discount = Math.round(subtotal * pct) / 100;
    var total = Math.max(subtotal - discount, 0);
    document.getElementById('nsSubtotal').textContent = money(subtotal);
    document.getElementById('nsTotal').textContent = money(total);
  }

  function addItem() {
    var sel = document.getElementById('nsItem');
    var v = sel.value; if (!v) return;
    var opt = (sel._opts || []).filter(function (o) { return o.v === v; })[0];
    var qty = Math.max(Number(document.getElementById('nsQty').value) || 1, 1);
    if (!opt) return;
    // merge same item
    var ex = state.cart.filter(function (c) { return c.kind === opt.kind && c.id === opt.id; })[0];
    if (ex) ex.qty += qty;
    else state.cart.push({ kind: opt.kind, id: opt.id, name: opt.name, price: Number(opt.price) || 0, qty: qty });
    sel.value = ''; document.getElementById('nsQty').value = 1;
    renderCart();
  }

  function saveSale() {
    var err = document.getElementById('nsErr'); err.textContent = '';
    if (!state.cart.length) { err.textContent = 'Add at least one item.'; return; }
    var customerId = document.getElementById('nsCustomer').value || '';
    var customer = state.customers.filter(function (c) { return c.id === customerId; })[0];
    var pct = Math.min(Math.max(Number(document.getElementById('nsDiscount').value) || 0, 0), 100);
    var method = document.getElementById('nsPayment').value;
    var btn = document.getElementById('nsSave'); btn.disabled = true; var lbl = btn.textContent; btn.textContent = 'Saving…';

    var jobs = [];
    // Split items by kind: products -> sales app, services -> services app.
    var prods = state.cart.filter(function (c) { return c.kind === 'product'; });
    var svcs = state.cart.filter(function (c) { return c.kind === 'service'; });

    if (prods.length) {
      jobs.push(BZ.call('sales', 'saveSale', [{
        customerId: customerId, customerName: customer ? customer.name : 'Walk-in',
        items: prods.map(function (p) { return { productId: p.id, name: p.name, qty: p.qty, price: p.price }; }),
        discountPercent: pct, paymentMethod: method
      }]));
    }
    if (svcs.length) {
      jobs.push(BZ.call('services', 'recordSale', [{
        customerId: customerId, customerName: customer ? customer.name : '',
        items: svcs.map(function (s) { return { serviceName: s.name, qty: s.qty, unitPrice: s.price }; }),
        discountPercent: pct, paymentMethod: method
      }]));
    }

    Promise.all(jobs).then(function () {
      btn.disabled = false; btn.textContent = lbl;
      state.cart = []; renderCart();
      document.getElementById('nsDiscount').value = 0;
      closeNewSale();
      toast('Sale recorded.');
      loadHistory();
      if (window.BZHome) window.BZHome.reload();
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = lbl;
      err.textContent = e.message || 'Could not save sale.';
    });
  }

  function openNewSale() { document.getElementById('newSaleCard').style.display = 'block'; }
  function closeNewSale() { document.getElementById('newSaleCard').style.display = 'none'; }

  function loadHistory() {
    var jobs = [];
    if (hasSales) jobs.push(BZ.call('sales', 'getSalesHistory', [5000]).then(function (rows) {
      return (rows || []).map(function (r) { return { ref: r.saleId, customer: r.customerName, date: r.date, amount: Number(r.total) || 0, src: 'sales' }; });
    }));
    if (hasServices) jobs.push(BZ.call('services', 'getRecentSales', [5000]).then(function (rows) {
      return (rows || []).map(function (r) { return { ref: r.saleId || r.receiptNo, customer: r.customerName, date: r.date, amount: Number(r.total) || 0, src: 'services' }; });
    }));
    Promise.all(jobs).then(function (groups) {
      var all = [];
      groups.forEach(function (g) { all = all.concat(g); });
      all.sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
      renderHistory(all);
    }).catch(function () { renderHistory([]); });
  }

  var HISTORY = [];
  function renderHistory(rows) {
    HISTORY = rows;
    var q = (document.getElementById('histSearch').value || '').toLowerCase();
    var from = document.getElementById('histFrom').value;
    var tbody = document.querySelector('#histTable tbody');
    var list = rows.filter(function (r) {
      var okQ = !q || (String(r.customer || '').toLowerCase().indexOf(q) !== -1 || String(r.ref || '').toLowerCase().indexOf(q) !== -1);
      var okD = !from || (r.date && r.date.slice(0, 10) >= from);
      return okQ && okD;
    });
    if (!list.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No sales found.</td></tr>'; return; }
    tbody.innerHTML = list.slice(0, 300).map(function (r) {
      var d = r.date ? new Date(r.date).toLocaleDateString() : '';
      return '<tr><td class="strong">' + esc(r.ref) + '</td><td>' + esc(r.customer || 'Walk-in') + '</td><td>' + d + '</td>' +
        '<td class="right strong">' + money(r.amount) + '</td><td class="right"><span class="badge">' + r.src + '</span></td></tr>';
    }).join('');
  }

  function toast(m) { var t = document.getElementById('toast'); if (!t) return; t.textContent = m; t.classList.add('show'); setTimeout(function () { t.classList.remove('show'); }, 2200); }

  // Wire up
  document.getElementById('newSaleBtn').addEventListener('click', function () { loadData().then(openNewSale); });
  document.getElementById('closeNewSale').addEventListener('click', closeNewSale);
  document.getElementById('nsAddItem').addEventListener('click', addItem);
  document.getElementById('nsDiscount').addEventListener('input', recalc);
  document.getElementById('nsSave').addEventListener('click', saveSale);
  document.getElementById('histSearch').addEventListener('input', function () { renderHistory(HISTORY); });
  document.getElementById('histFrom').addEventListener('change', function () { renderHistory(HISTORY); });

  window.BZSales = { reload: function () { loadData(); } };
})();
