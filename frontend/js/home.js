  const BASE = '/';
  const params = new URLSearchParams(location.search);
  const clean = s => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  const PIN = clean(params.get('b'));
  const APP_NAME = (window.APP_CONFIG && window.APP_CONFIG.APP_NAME) || 'Soft Manager';
  let MODE = 'login', APPS = [], BIZ_NAME = '', SERVER_ERROR = '';

  document.title = APP_NAME + ' \u2013 Sales, receipts and customers for your business';
  document.querySelectorAll('[data-app-name]').forEach(function (el) { el.textContent = APP_NAME; });

  // Optional: a link new businesses can use to ask for a PIN (WhatsApp, email, form).
  // Leave empty and "Sign up" / "Get Started Today" simply open the sign-in box.
  var SIGNUP_URL = "";

  const APP_INFO = {
    sales:    { label: 'Sales Tracker', sub: 'Sales and inventory management',
                icon: '<path d="M3 5h2l2 11h11l2-8H6"/><circle cx="9" cy="20" r="1.2"/><circle cx="17" cy="20" r="1.2"/>' },
    services: { label: 'Services', sub: 'Services and expense management',
                icon: '<path d="M8 3 3 6l2 4 2-1v12h10V9l2 1 2-4-5-3a4 4 0 0 1-8 0z"/>' }
  };

  const dlg = document.getElementById('signin');
  const pinEl = document.getElementById('pin');
  const errEl = document.getElementById('err');

  function openLogin(msg) {
    errEl.style.color = '#B3453B';
    errEl.textContent = msg || '';
    if (dlg.showModal) { if (!dlg.open) dlg.showModal(); } else { dlg.setAttribute('open', ''); }
    setTimeout(function () { pinEl.focus(); }, 50);
  }

  // The PIN is checked by the server when the next page loads, so there is no
  // waiting step here that a phone could block or leave hanging.
  function signIn() {
    const pin = pinEl.value.trim();
    errEl.style.color = '#B3453B';
    if (!pin) { errEl.textContent = 'Enter your PIN.'; return; }
    const url = BASE + '?b=' + encodeURIComponent(pin) + '&pick=1';
    errEl.style.color = '#567C8D';
    errEl.textContent = 'Signing in...';
    const a = document.getElementById('open');
    a.href = url;
    setTimeout(function () { a.style.display = 'block'; }, 2500);   // backup if the redirect is blocked
    try { window.location.href = url; } catch (e) { a.style.display = 'block'; }
  }

  document.getElementById('go').addEventListener('click', signIn);
  pinEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') signIn(); });
  document.getElementById('closeSignin').addEventListener('click', function () { dlg.close(); });
  document.getElementById('eye').addEventListener('click', function () {
    const show = pinEl.type === 'password';
    pinEl.type = show ? 'text' : 'password';
    this.textContent = show ? 'Hide' : 'Show';
  });

  document.querySelectorAll('[data-login]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault(); setMenu(false);
      if (window.openOnboard) window.openOnboard('login'); else openLogin('');
    });
  });
  document.querySelectorAll('[data-signup]').forEach(function (a) {
    if (SIGNUP_URL) { a.href = SIGNUP_URL; a.target = '_blank'; a.rel = 'noopener'; return; }
    a.addEventListener('click', function (e) {
      e.preventDefault(); setMenu(false);
      if (window.openOnboard) window.openOnboard('signup'); else openLogin('');
    });
  });

  // Burger menu
  const burger = document.getElementById('burger');
  const links = document.getElementById('links');
  function setMenu(open) {
    links.classList.toggle('open', open);
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }
  burger.addEventListener('click', function () { setMenu(!links.classList.contains('open')); });
  links.addEventListener('click', function (e) { if (e.target.closest('a')) setMenu(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setMenu(false); });


  // Contact details shown in the Contact section. Fill in the ones you want; blank ones are hidden.
  var CONTACT_PHONE = "08024795274";
  var CONTACT_WHATSAPP = "";   // digits only, with country code, e.g. "2348000000000"
  var CONTACT_EMAIL = "oluwatosin.z.olabisi@gmail.com";

  (function buildContact() {
    var box = document.getElementById('contactCards');
    var items = [];
    if (CONTACT_PHONE) items.push(['Call us', CONTACT_PHONE, 'tel:' + CONTACT_PHONE.replace(/[^+\d]/g, ''),
      '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>']);
    if (CONTACT_WHATSAPP) items.push(['WhatsApp', 'Chat with us', 'https://wa.me/' + CONTACT_WHATSAPP.replace(/\D/g, ''),
      '<path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.4L3 20.5l1.7-5.4A8.4 8.4 0 1 1 21 11.5z"/>']);
    if (CONTACT_EMAIL) items.push(['Email', CONTACT_EMAIL, 'mailto:' + CONTACT_EMAIL,
      '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 7L2 7"/>']);
    if (!items.length) return;
    document.getElementById('contactNone').style.display = 'none';
    items.forEach(function (it) {
      var a = document.createElement('a');
      a.className = 'ccard';
      a.href = it[2];
      if (it[2].indexOf('http') === 0) { a.target = '_blank'; a.rel = 'noopener'; }
      a.innerHTML = '<div class="ico"><svg viewBox="0 0 24 24" aria-hidden="true">' + it[3] + '</svg></div><div><small>' + it[0] + '</small><span></span></div>';
      a.querySelector('span').textContent = it[1];
      box.appendChild(a);
    });
  })();

  // Menu buttons: scroll to the section and highlight the one you are on.
  // (Plain #links can misbehave inside Apps Script, so scrolling is done here.)
  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.links a[data-nav]'));
  var spyIds = ['home', 'features', 'about', 'how', 'contact', 'start'];
  var spyMap = { how: 'about', start: 'contact' };      // sections that belong to a menu button
  var navLock = 0;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function setActive(id) {
    navLinks.forEach(function (a) {
      var on = a.getAttribute('data-nav') === id;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
    });
  }

  function spy() {
    if (document.body.classList.contains('select') || Date.now() < navLock) return;
    var y = window.scrollY + 140, cur = 'home';
    spyIds.forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.offsetTop <= y) cur = id;
    });
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) cur = 'start';
    setActive(spyMap[cur] || cur);
  }

  var ticking = false;
  window.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () { ticking = false; spy(); });
  }, { passive: true });
  window.addEventListener('resize', spy);

  document.querySelectorAll('a[href^="#"]').forEach(function (a) {
    if (a.hasAttribute('data-login') || a.hasAttribute('data-signup') || a.id === 'navOut') return;
    a.addEventListener('click', function (e) {
      e.preventDefault();
      var id = (a.getAttribute('href') || '').slice(1);
      var el = id ? document.getElementById(id) : null;
      if (!el) return;
      setMenu(false);
      if (a.getAttribute('data-nav')) { setActive(a.getAttribute('data-nav')); navLock = Date.now() + 900; }
      el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    });
  });
  spy();

  // After a correct PIN: show the choose-an-app page instead of the marketing page
  function showSession() {
    document.documentElement.classList.remove('pending');
    if (MODE === 'select' && APPS.length) {
      document.body.classList.add('select');
      document.getElementById('welcome').textContent = BIZ_NAME ? 'Welcome, ' + BIZ_NAME : 'Welcome';
      document.getElementById('navOut').href = BASE;
      document.getElementById('appLinks').innerHTML = APPS.map(function (a) {
        const i = APP_INFO[a];
        const href = '/' + a + '.html?b=' + encodeURIComponent(PIN);
        return '<a class="opt" href="' + href + '"><span class="ic"><svg viewBox="0 0 24 24" aria-hidden="true">' +
               i.icon + '</svg></span><span>' + i.label + '<small>' + i.sub + '</small></span></a>';
      }).join('');
    } else if (SERVER_ERROR) {
      openLogin(SERVER_ERROR);
    }
  }

  // A link with ?b=PIN (or a saved sign-in) is checked with the server first
  if (PIN) {
    window.apiPost('/api/session', { code: PIN, app: params.get('app') || '', pick: params.get('pick') || '' })
      .then(function (r) {
        if (r.mode === 'app') { location.replace('/' + r.app + '.html?b=' + encodeURIComponent(PIN)); return; }
        MODE = r.mode; APPS = r.apps || []; BIZ_NAME = r.bizName || ''; SERVER_ERROR = r.error || '';
        showSession();
      })
      .catch(function (e) { SERVER_ERROR = (e && e.message) || 'Cannot reach the server.'; showSession(); });
  } else if (params.has('pick')) {
    openLogin('No active application workspace is linked to this account. Please log in again or contact support.');
  }
