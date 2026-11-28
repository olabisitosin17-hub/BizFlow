// Profile & settings: business info, plan, account.
(function () {
  var BZ = window.BZ;
  var apps = BZ.apps();
  var hasSales = apps.indexOf('sales') !== -1;
  var hasServices = apps.indexOf('services') !== -1;
  var plan = (hasSales && hasServices) ? 'Complete Business Suite' : hasSales ? 'Sales Management' : hasServices ? 'Service Management' : '—';
  var loaded = false;
  var config = {};

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  function fill() {
    document.getElementById('pEmail').value = (function () { try { return localStorage.getItem('bizEmail') || ''; } catch (e) { return ''; } })();
    document.getElementById('pCode').value = BZ.code() || '';
    document.getElementById('pPlan').value = plan;
    document.getElementById('pName').value = config.BusinessName || BZ.bizName() || '';
    document.getElementById('pPhone').value = config.Phone || '';
    document.getElementById('pCurrency').value = config.Currency || '₦';
    document.getElementById('pAddress').value = config.Address || '';
    document.getElementById('pFooter').value = config.Footer || config.ReceiptFooter || '';
  }

  function load() {
    if (loaded) { fill(); return; }
    var p;
    if (hasServices) p = BZ.call('services', 'getInitData').then(function (d) { return d.settings || {}; });
    else if (hasSales) p = BZ.call('sales', 'getConfig').then(function (c) { return c || {}; });
    else p = Promise.resolve({});
    p.then(function (cfg) { config = cfg || {}; loaded = true; fill(); })
      .catch(function () { loaded = true; fill(); });
  }

  function save() {
    var msg = document.getElementById('pMsg'); msg.textContent = '';
    var payload = {
      BusinessName: document.getElementById('pName').value.trim(),
      Phone: document.getElementById('pPhone').value.trim(),
      Currency: document.getElementById('pCurrency').value.trim(),
      Address: document.getElementById('pAddress').value.trim()
    };
    var btn = document.getElementById('pSave'); btn.disabled = true; var lbl = btn.textContent; btn.textContent = 'Saving…';
    var job = hasServices
      ? BZ.call('services', 'updateBusinessSettings', [Object.assign({ ReceiptFooter: document.getElementById('pFooter').value.trim() }, payload)])
      : Promise.resolve({}); // Sales app has no settings update action; keep read-only there.
    job.then(function (r) {
      btn.disabled = false; btn.textContent = lbl;
      if (r && (r.BusinessName || r.Currency)) config = Object.assign(config, r);
      try { localStorage.setItem('bizName', payload.BusinessName); } catch (e) {}
      msg.style.color = 'var(--ok)';
      msg.textContent = hasServices ? 'Saved.' : 'Saved locally (Sales plan settings are read-only).';
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = lbl;
      msg.style.color = 'var(--err)'; msg.textContent = e.message || 'Could not save.';
    });
  }

  document.getElementById('pSave').addEventListener('click', save);

  window.BZProfile = { reload: function () { load(); } };
})();
