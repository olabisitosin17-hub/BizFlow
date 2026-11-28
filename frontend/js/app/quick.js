// Quick Actions hub: bottom sheet with New Customer / Product / Service / Expense forms.
(function () {
  var BZ = window.BZ;
  var apps = BZ.apps();
  var hasSales = apps.indexOf('sales') !== -1;
  var hasServices = apps.indexOf('services') !== -1;

  var sheet = document.getElementById('quickSheet');
  var backdrop = document.getElementById('sheetBackdrop');
  var title = document.getElementById('quickTitle');
  var body = document.getElementById('quickBody');

  function open() { sheet.classList.add('show'); backdrop.classList.add('show'); sheet.setAttribute('aria-hidden', 'false'); }
  function close() { sheet.classList.remove('show'); backdrop.classList.remove('show'); sheet.setAttribute('aria-hidden', 'true'); }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function toast(m) { var t = document.getElementById('toast'); t.textContent = m; t.classList.add('show'); setTimeout(function () { t.classList.remove('show'); }, 2200); }

  function menu() {
    title.textContent = 'Quick actions';
    var items = [];
    items.push({ k: 'customer', ico: '👤', h: 'Add new customer', p: 'Save contact details' });
    if (hasSales) items.push({ k: 'product', ico: '📦', h: 'Add new product', p: 'Sell it from your stock' });
    if (hasServices) items.push({ k: 'service', ico: '🛠️', h: 'Add new service', p: 'Offer it to customers' });
    items.push({ k: 'expense', ico: '💸', h: 'Record expense', p: 'Log a business cost' });
    body.innerHTML = '<div class="qa-list">' + items.map(function (it) {
      return '<button class="qa-item" data-act="' + it.k + '"><span class="qa-ico">' + it.ico + '</span>' +
        '<span><h4>' + it.h + '</h4><p>' + it.p + '</p></span></button>';
    }).join('') + '</div>';
    body.querySelectorAll('[data-act]').forEach(function (b) {
      b.addEventListener('click', function () { route(b.getAttribute('data-act')); });
    });
  }

  function route(k) { if (k === 'customer') formCustomer(); else if (k === 'product') formProduct(); else if (k === 'service') formService(); else if (k === 'expense') formExpense(); }

  function field(label, id, type, ph, extra) { return '<div class="field"><label for="' + id + '">' + label + '</label><input class="input" id="' + id + '" type="' + (type || 'text') + '" placeholder="' + (ph || '') + '" ' + (extra || '') + '></div>'; }

  function formCustomer() {
    title.textContent = 'Add new customer';
    body.innerHTML =
      field('Customer name', 'qcName', 'text', 'e.g. Ada Obi') +
      field('Phone number', 'qcPhone', 'tel', '0801 234 5678') +
      field('Email address', 'qcEmail', 'email', 'optional') +
      field('Address', 'qcAddr', 'text', 'optional') +
      '<div class="field"><label for="qcNotes">Notes</label><textarea class="input" id="qcNotes" placeholder="optional"></textarea></div>' +
      '<div class="error-text" id="qcMsg"></div>' +
      '<button class="btn btn-primary btn-block" id="qcSave">Save customer</button>';
    document.getElementById('qcSave').addEventListener('click', function () {
      var name = document.getElementById('qcName').value.trim();
      var phone = document.getElementById('qcPhone').value.trim();
      var msg = document.getElementById('qcMsg'); msg.textContent = '';
      if (!name && !phone) { msg.textContent = 'Enter a name or phone number.'; return; }
      var b = this; b.disabled = true; b.textContent = 'Saving…';
      var payload = { name: name, phone: phone, email: document.getElementById('qcEmail').value.trim(), address: document.getElementById('qcAddr').value.trim(), notes: document.getElementById('qcNotes').value.trim() };
      var app = hasSales ? 'sales' : 'services';
      BZ.call(app, 'addCustomer', [payload]).then(function () {
        b.disabled = false; b.textContent = 'Save customer';
        close(); toast('Customer saved.');
      }).catch(function (e) { b.disabled = false; b.textContent = 'Save customer'; msg.textContent = e.message || 'Could not save.'; });
    });
  }

  function formProduct() {
    title.textContent = 'Add new product';
    body.innerHTML =
      field('Product name', 'qpName', 'text', 'e.g. Detergent 1kg') +
      field('Category', 'qpCat', 'text', 'e.g. Cleaning') +
      field('Description', 'qpDesc', 'text', 'optional') +
      '<div class="field-row">' + field('Cost price', 'qpCost', 'number', '0') + field('Selling price', 'qpSell', 'number', '0') + '</div>' +
      field('Quantity in stock', 'qpStock', 'number', '0') +
      '<div class="error-text" id="qpMsg"></div>' +
      '<button class="btn btn-primary btn-block" id="qpSave">Save product</button>';
    document.getElementById('qpSave').addEventListener('click', function () {
      var name = document.getElementById('qpName').value.trim();
      var msg = document.getElementById('qpMsg'); msg.textContent = '';
      if (!name) { msg.textContent = 'Enter a product name.'; return; }
      var b = this; b.disabled = true; b.textContent = 'Saving…';
      BZ.call('sales', 'addProduct', [{
        name: name, category: document.getElementById('qpCat').value.trim(),
        costPrice: Number(document.getElementById('qpCost').value) || 0,
        sellingPrice: Number(document.getElementById('qpSell').value) || 0,
        stock: Number(document.getElementById('qpStock').value) || 0, unit: 'pcs'
      }]).then(function () { b.disabled = false; b.textContent = 'Save product'; close(); toast('Product saved.'); })
        .catch(function (e) { b.disabled = false; b.textContent = 'Save product'; msg.textContent = e.message || 'Could not save.'; });
    });
  }

  function formService() {
    title.textContent = 'Add new service';
    body.innerHTML =
      field('Service name', 'qsName', 'text', 'e.g. Home visit') +
      field('Category', 'qsCat', 'text', 'optional') +
      field('Description', 'qsDesc', 'text', 'optional') +
      field('Service price', 'qsPrice', 'number', '0') +
      '<div class="error-text" id="qsMsg"></div>' +
      '<button class="btn btn-primary btn-block" id="qsSave">Save service</button>';
    document.getElementById('qsSave').addEventListener('click', function () {
      var name = document.getElementById('qsName').value.trim();
      var msg = document.getElementById('qsMsg'); msg.textContent = '';
      if (!name) { msg.textContent = 'Enter a service name.'; return; }
      var b = this; b.disabled = true; b.textContent = 'Saving…';
      BZ.call('services', 'addService', [{ name: name, price: Number(document.getElementById('qsPrice').value) || 0 }])
        .then(function () { b.disabled = false; b.textContent = 'Save service'; close(); toast('Service saved.'); })
        .catch(function (e) { b.disabled = false; b.textContent = 'Save service'; msg.textContent = e.message || 'Could not save.'; });
    });
  }

  function formExpense() {
    title.textContent = 'Record expense';
    body.innerHTML =
      field('Expense title', 'qeTitle', 'text', 'e.g. Generator fuel') +
      field('Category', 'qeCat', 'text', 'e.g. Fuel') +
      field('Amount', 'qeAmount', 'number', '0') +
      '<div class="field"><label for="qeMethod">Payment method</label><select class="input" id="qeMethod"><option>Cash</option><option>Transfer</option><option>POS</option><option>Other</option></select></div>' +
      field('Date', 'qeDate', 'date', '') +
      '<div class="field"><label for="qeNotes">Notes</label><textarea class="input" id="qeNotes" placeholder="optional"></textarea></div>' +
      '<div class="error-text" id="qeMsg"></div>' +
      '<button class="btn btn-primary btn-block" id="qeSave">Save expense</button>';
    try { document.getElementById('qeDate').value = new Date().toISOString().slice(0, 10); } catch (e) {}
    document.getElementById('qeSave').addEventListener('click', function () {
      var amount = Number(document.getElementById('qeAmount').value);
      var msg = document.getElementById('qeMsg'); msg.textContent = '';
      if (!(amount > 0)) { msg.textContent = 'Enter an amount.'; return; }
      var b = this; b.disabled = true; b.textContent = 'Saving…';
      var title_ = document.getElementById('qeTitle').value.trim();
      var cat = document.getElementById('qeCat').value.trim() || 'Other';
      var date = document.getElementById('qeDate').value;
      // Services app: addExpense; Sales app: addRunningExpense
      var p = hasServices
        ? BZ.call('services', 'addExpense', [{ category: cat, description: title_, amount: amount, date: date }])
        : BZ.call('sales', 'addRunningExpense', [{ category: cat, description: title_, amount: amount, date: date }]);
      p.then(function () { b.disabled = false; b.textContent = 'Save expense'; close(); toast('Expense recorded.'); })
        .catch(function (e) { b.disabled = false; b.textContent = 'Save expense'; msg.textContent = e.message || 'Could not save.'; });
    });
  }

  document.getElementById('sheetBackdrop').addEventListener('click', close);
  document.getElementById('closeQuick').addEventListener('click', close);

  // Re-open menu each time the sheet is shown empty
  window.openQuick = function () { menu(); open(); };
})();
