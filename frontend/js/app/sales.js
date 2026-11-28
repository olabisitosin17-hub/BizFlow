// Sales tab: searchable customer/item pickers, qty steppers, save + receipt.
// Adapts to Sales app (products), Services app (services) or both. Modules stay separate.
(function () {
  var BZ = window.BZ;
  var apps = BZ.apps();
  var hasSales = apps.indexOf('sales') !== -1;
  var hasServices = apps.indexOf('services') !== -1;
  var CUR = '₦';

  var state = { items: [], customers: [], cart: [], selectedCustomer: null };
  var loaded = false;
  var saving = false;

  function money(n) { return CUR + (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function toast(m) { var t = document.getElementById('toast'); t.textContent = m; t.classList.add('show'); setTimeout(function () { t.classList.remove('show'); }, 2200); }
  function digits(s) { return String(s || '').replace(/\D/g, ''); }

  // ---------- Load catalogue ----------
  function loadData() {
    if (loaded) return Promise.resolve();
    var jobs = [];
    if (hasSales) {
      jobs.push(BZ.call('sales', 'getProductsList').then(function (p) {
        (p || []).forEach(function (x) {
          state.items.push({ kind: 'product', id: x.ProductID, name: x.Name, cat: x.Category || '', price: Number(x.SellingPrice) || 0, stock: Number(x.Stock) || 0 });
        });
      }).catch(function () {}));
      jobs.push(BZ.call('sales', 'getCustomersList').then(function (c) {
        (c || []).forEach(function (x) { state.customers.push({ id: x.CustomerID, name: x.Name, phone: x.Phone, src: 'sales' }); });
      }).catch(function () {}));
    }
    if (hasServices) {
      jobs.push(BZ.call('services', 'getAllServices').then(function (s) {
        (s || []).filter(function (x) { return x.Active !== false; }).forEach(function (x) {
          state.items.push({ kind: 'service', id: x.ServiceID, name: x.Name, cat: '', price: Number(x.Price) || 0, stock: Infinity });
        });
      }).catch(function () {}));
      jobs.push(BZ.call('services', 'getCustomersWithSpend').then(function (c) {
        var seen = {}; state.customers.forEach(function (x) { seen[x.id] = true; });
        (c || []).forEach(function (x) { if (!seen[x.CustomerID]) state.customers.push({ id: x.CustomerID, name: x.Name, phone: x.Phone, src: 'services' }); });
      }).catch(function () {}));
    }
    return Promise.all(jobs).then(function () { loaded = true; });
  }

  // ---------- Customer search ----------
  var custSearch = document.getElementById('nsCustSearch');
  var custResults = document.getElementById('nsCustResults');
  custSearch.addEventListener('input', function () {
    var q = custSearch.value.trim().toLowerCase();
    var qd = digits(q);
    if (!q) { custResults.innerHTML = ''; return; }
    var matches = state.customers.filter(function (c) {
      return (c.name || '').toLowerCase().indexOf(q) !== -1 || (qd && digits(c.phone).indexOf(qd) !== -1);
    }).slice(0, 6);
    custResults.innerHTML = matches.map(function (c, i) {
      return '<button class="pick" data-i="' + i + '"><b>' + esc(c.name || 'Customer') + '</b><span>' + esc(c.phone || '') + '</span></button>';
    }).join('') + (matches.length ? '' : '<div class="pick-empty">No match. Leave blank for Walk-in.</div>');
    custResults.querySelectorAll('.pick').forEach(function (b) {
      b.addEventListener('click', function () {
        var c = matches[+b.getAttribute('data-i')];
        state.selectedCustomer = c;
        custSearch.value = c.name + (c.phone ? ' · ' + c.phone : '');
        custResults.innerHTML = '';
      });
    });
  });

  // ---------- Item search ----------
  var itemSearch = document.getElementById('nsItemSearch');
  var itemResults = document.getElementById('nsItemResults');
  itemSearch.addEventListener('input', function () {
    var q = itemSearch.value.trim().toLowerCase();
    if (!q) { itemResults.innerHTML = ''; return; }
    var matches = state.items.filter(function (it) {
      return (it.name || '').toLowerCase().indexOf(q) !== -1 || (it.cat || '').toLowerCase().indexOf(q) !== -1;
    }).slice(0, 8);
    itemResults.innerHTML = matches.map(function (it, i) {
      var meta = it.kind === 'product' ? ('Stock ' + it.stock + ' · ' + money(it.price)) : money(it.price);
      return '<button class="pick" data-i="' + i + '"><b>' + esc(it.name) + '</b><span>' + esc(meta) + '</span></button>';
    }).join('') + (matches.length ? '' : '<div class="pick-empty">No matching product or service.</div>');
    itemResults.querySelectorAll('.pick').forEach(function (b) {
      b.addEventListener('click', function () {
        addToCart(matches[+b.getAttribute('data-i')]);
        itemSearch.value = ''; itemResults.innerHTML = '';
      });
    });
  });

  // ---------- Cart ----------
  function addToCart(it) {
    var ex = state.cart.filter(function (c) { return c.kind === it.kind && c.id === it.id; })[0];
    if (ex) { if (ex.qty < (it.stock === Infinity ? Infinity : it.stock)) ex.qty++; }
    else state.cart.push({ kind: it.kind, id: it.id, name: it.name, price: it.price, stock: it.stock, qty: 1 });
    renderCart();
  }

  function renderCart() {
    var el = document.getElementById('nsCart');
    if (!state.cart.length) { el.innerHTML = '<p class="muted" style="margin:6px 0">No items yet. Search above to add products or services.</p>'; recalc(); return; }
    el.innerHTML = state.cart.map(function (it, i) {
      var maxed = it.stock !== Infinity && it.qty >= it.stock;
      return '<div class="cart-row"><div class="ci-name">' + esc(it.name) + '</div>' +
        '<div class="qty-step"><button class="qs-btn" data-dec="' + i + '">−</button><span>' + it.qty + '</span>' +
        '<button class="qs-btn" data-inc="' + i + '"' + (maxed ? ' disabled' : '') + '>+</button></div>' +
        '<div class="strong">' + money(it.qty * it.price) + '</div>' +
        '<button class="btn btn-ghost btn-sm" data-rm="' + i + '">✕</button></div>';
    }).join('');
    el.querySelectorAll('[data-inc]').forEach(function (b) { b.addEventListener('click', function () { var it = state.cart[+b.getAttribute('data-inc')]; if (it.stock === Infinity || it.qty < it.stock) { it.qty++; renderCart(); } }); });
    el.querySelectorAll('[data-dec]').forEach(function (b) { b.addEventListener('click', function () { var it = state.cart[+b.getAttribute('data-dec')]; if (it.qty > 1) it.qty--; else state.cart.splice(+b.getAttribute('data-dec'), 1); renderCart(); }); });
    el.querySelectorAll('[data-rm]').forEach(function (b) { b.addEventListener('click', function () { state.cart.splice(+b.getAttribute('data-rm'), 1); renderCart(); }); });
    recalc();
  }

  function recalc() {
    var subtotal = state.cart.reduce(function (s, it) { return s + it.qty * it.price; }, 0);
    var pct = Math.min(Math.max(Number(document.getElementById('nsDiscount').value) || 0, 0), 100);
    var discount = Math.round(subtotal * pct) / 100;
    document.getElementById('nsSubtotal').textContent = money(subtotal);
    document.getElementById('nsTotal').textContent = money(Math.max(subtotal - discount, 0));
  }

  // ---------- Save ----------
  function saveSale() {
    if (saving) return;                       // prevent duplicate transactions
    var err = document.getElementById('nsErr'); err.textContent = '';
    if (!state.cart.length) { err.textContent = 'Add at least one item.'; return; }
    saving = true;
    var btn = document.getElementById('nsSave'); btn.disabled = true; var lbl = btn.textContent; btn.textContent = 'Saving…';
    var cust = state.selectedCustomer;
    var pct = Math.min(Math.max(Number(document.getElementById('nsDiscount').value) || 0, 0), 100);
    var method = document.getElementById('nsPayment').value;

    var prods = state.cart.filter(function (c) { return c.kind === 'product'; });
    var svcs = state.cart.filter(function (c) { return c.kind === 'service'; });
    var jobs = [];
    if (prods.length) jobs.push(BZ.call('sales', 'saveSale', [{
      customerId: cust ? cust.id : '', customerName: cust ? cust.name : 'Walk-in',
      items: prods.map(function (p) { return { productId: p.id, name: p.name, qty: p.qty, price: p.price }; }),
      discountPercent: pct, paymentMethod: method
    }]));
    if (svcs.length) jobs.push(BZ.call('services', 'recordSale', [{
      customerId: cust ? cust.id : '', customerName: cust ? cust.name : '',
      items: svcs.map(function (s) { return { serviceName: s.name, qty: s.qty, unitPrice: s.price }; }),
      discountPercent: pct, paymentMethod: method
    }]));

    Promise.all(jobs).then(function (res) {
      saving = false; btn.disabled = false; btn.textContent = lbl;
      var receipt = res[0] || {};
      showReceipt(receipt, cust);
      state.cart = []; state.selectedCustomer = null; custSearch.value = ''; renderCart();
      document.getElementById('nsDiscount').value = 0;
      document.getElementById('newSaleCard').style.display = 'none';
      loadHistory();
      if (window.BZHome) window.BZHome.reload();
      if (window.BZQuick) window.BZQuick.reload();
    }).catch(function (e) {
      saving = false; btn.disabled = false; btn.textContent = lbl;
      err.textContent = e.message || 'Could not save sale.';
    });
  }

  // ---------- Receipt ----------
  function showReceipt(r, cust) {
    var items = r.items || state.cart.map(function (c) { return { name: c.name, qty: c.qty, price: c.price }; });
    var when = new Date().toLocaleString();
    var bizName = BZ.bizName() || 'Business';
    var ref = r.receiptId || r.receiptNo || r.saleId || '';
    var rows = items.map(function (it) {
      return '<tr><td>' + esc(it.name) + '<br><small>' + it.qty + ' × ' + money(it.price) + '</small></td><td class="right">' + money(it.qty * it.price) + '</td></tr>';
    }).join('');
    document.getElementById('receiptBody').innerHTML =
      '<div id="receiptPrintArea" style="font-family:var(--sans)">' +
      '<div style="text-align:center"><h3 style="margin:0">' + esc(bizName) + '</h3><small>' + esc(when) + '</small></div>' +
      '<hr><div class="row between"><span>Ref</span><b>' + esc(ref) + '</b></div>' +
      '<div class="row between"><span>Customer</span><b>' + esc(cust ? cust.name : 'Walk-in') + '</b></div>' +
      '<hr><table style="width:100%">' + rows + '</table><hr>' +
      '<div class="row between"><span>Subtotal</span><b>' + money(r.subtotal) + '</b></div>' +
      (Number(r.discount) ? '<div class="row between"><span>Discount</span><b>-' + money(r.discount) + '</b></div>' : '') +
      '<div class="row between" style="font-size:1.15rem"><span><b>Total</b></span><b>' + money(r.total) + '</b></div>' +
      '<div class="row between"><span>Payment</span><b>' + esc(r.paymentMethod || 'Cash') + '</b></div>' +
      '</div>';
    var dlg = document.getElementById('receiptDialog');
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }

  document.getElementById('closeReceipt').addEventListener('click', function () {
    var d = document.getElementById('receiptDialog'); d.close ? d.close() : d.removeAttribute('open');
  });
  document.getElementById('receiptPrint').addEventListener('click', function () {
    var content = document.getElementById('receiptPrintArea').innerHTML;
    var w = window.open('', '_blank');
    w.document.write('<html><head><title>Receipt</title><style>body{font-family:Arial,sans-serif;max-width:320px;margin:20px auto;font-size:13px}table{width:100%;border-collapse:collapse}td{padding:4px 0}.right{text-align:right}.row{display:flex;justify-content:space-between}hr{border:0;border-top:1px dashed #999;margin:10px 0}</style></head><body>' + content + '</body></html>');
    w.document.close();
    w.focus();
    setTimeout(function () { w.print(); }, 250);
  });

  // ---------- History ----------
  var HISTORY = [];
  function loadHistory() {
    var jobs = [];
    if (hasSales) jobs.push(BZ.call('sales', 'getSalesHistory', [5000]).then(function (rows) { return (rows || []).map(function (r) { return { ref: r.saleId, customer: r.customerName, date: r.date, amount: Number(r.total) || 0, src: 'sales' }; }); }));
    if (hasServices) jobs.push(BZ.call('services', 'getRecentSales', [5000]).then(function (rows) { return (rows || []).map(function (r) { return { ref: r.saleId || r.receiptNo, customer: r.customerName, date: r.date, amount: Number(r.total) || 0, src: 'services' }; }); }));
    Promise.all(jobs).then(function (g) { var a = []; g.forEach(function (x) { a = a.concat(x); }); a.sort(function (x, y) { return new Date(y.date) - new Date(x.date); }); HISTORY = a; renderHistory(); }).catch(function () { renderHistory(); });
  }
  function renderHistory() {
    var q = (document.getElementById('histSearch').value || '').toLowerCase();
    var from = document.getElementById('histFrom').value;
    var list = HISTORY.filter(function (r) {
      return (!q || String(r.customer || '').toLowerCase().indexOf(q) !== -1 || String(r.ref || '').toLowerCase().indexOf(q) !== -1) && (!from || (r.date && r.date.slice(0, 10) >= from));
    });
    var tb = document.querySelector('#histTable tbody');
    if (!list.length) { tb.innerHTML = '<tr class="empty-row"><td colspan="5">No sales found.</td></tr>'; return; }
    tb.innerHTML = list.slice(0, 300).map(function (r) {
      var d = r.date ? new Date(r.date).toLocaleDateString() : '';
      return '<tr><td class="strong">' + esc(r.ref) + '</td><td>' + esc(r.customer || 'Walk-in') + '</td><td>' + d + '</td><td class="right strong">' + money(r.amount) + '</td><td class="right"><span class="badge">' + r.src + '</span></td></tr>';
    }).join('');
  }

  // ---------- Wire ----------
  document.getElementById('newSaleBtn').addEventListener('click', function () {
    loadData().then(function () { document.getElementById('newSaleCard').style.display = 'block'; });
  });
  document.getElementById('closeNewSale').addEventListener('click', function () { document.getElementById('newSaleCard').style.display = 'none'; });
  document.getElementById('nsDiscount').addEventListener('input', recalc);
  document.getElementById('nsSave').addEventListener('click', saveSale);
  document.getElementById('histSearch').addEventListener('input', renderHistory);
  document.getElementById('histFrom').addEventListener('change', renderHistory);

  window.BZSales = { reload: function () { loadData().then(loadHistory); } };
})();
