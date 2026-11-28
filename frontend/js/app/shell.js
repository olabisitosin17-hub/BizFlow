// App shell: session guard, tab routing, version badge, logout.
(function () {
  var BZ = window.BZ;
  if (!BZ || !BZ.requireAuth()) return;   // redirects to login if no session

  var apps = BZ.apps();                    // ['sales','services'] (lowercase)
  var has = function (a) { return apps.indexOf(a) !== -1; };

  var TITLES = { home: 'Home', sales: 'Sales', records: 'Records', profile: 'Profile', quick: 'Quick Actions' };

  function setTab(tab) {
    document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.add('hidden'); });
    var panel = document.getElementById('tab-' + tab);
    if (panel) panel.classList.remove('hidden');
    document.querySelectorAll('.snav, .bn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
    var t = document.getElementById('tabTitle'); if (t) t.textContent = TITLES[tab] || '';
    location.hash = tab === 'home' ? '' : tab;
    if (tab === 'quick') { openQuick(); return; }
    if (tab === 'home' && window.BZHome) window.BZHome.reload();
    if (tab === 'sales' && window.BZSales) window.BZSales.reload();
    if (tab === 'records' && window.BZRecords) window.BZRecords.reload();
    if (tab === 'profile' && window.BZProfile) window.BZProfile.reload();
  }

  // Wire nav buttons
  document.querySelectorAll('[data-tab]').forEach(function (b) {
    b.addEventListener('click', function () { setTab(b.getAttribute('data-tab')); });
  });
  document.querySelectorAll('[data-goto]').forEach(function (b) {
    b.addEventListener('click', function () { setTab(b.getAttribute('data-goto')); });
  });

  // Version badge + business name
  var badge = document.getElementById('versionBadge');
  var planText = !apps.length ? 'Workspace'
    : (has('sales') && has('services')) ? 'Complete Suite'
    : has('sales') ? 'Sales Plan' : 'Services Plan';
  if (badge) badge.textContent = planText;
  var name = BZ.bizName() || 'Business';
  var sideBiz = document.getElementById('sideBiz'); if (sideBiz) sideBiz.textContent = name;
  var hello = document.getElementById('bizHello'); if (hello) hello.textContent = 'Welcome, ' + name;
  var av = document.getElementById('avatar'); if (av) av.textContent = (name[0] || 'B').toUpperCase();

  // Hide modules the business doesn't have
  document.querySelectorAll('[data-rec]').forEach(function (b) {
    var m = b.getAttribute('data-rec');
    if ((m === 'products') && !has('sales')) b.classList.add('hidden');
    if ((m === 'services') && !has('services')) b.classList.add('hidden');
  });

  // Logout
  function logout() { BZ.clearSession(); location.replace('/login.html'); }
  var lo = document.getElementById('logoutSide'); if (lo) lo.addEventListener('click', logout);
  var pl = document.getElementById('pLogout'); if (pl) pl.addEventListener('click', logout);

  // Start on hash
  var start = (location.hash || '').replace('#', '') || 'home';
  window.BZShell = { setTab: setTab, apps: apps, has: has };
  setTab(['home', 'sales', 'records', 'profile'].indexOf(start) !== -1 ? start : 'home');
})();
