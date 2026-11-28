// Onboarding UI: sign up, log in, password reset. Uses the existing backend and the
// same ?b=CODE session flow the app already understands after a successful login.
(function () {
  if (window.__onboardReady) return;
  window.__onboardReady = true;

  var cfg = window.APP_CONFIG || {};
  var API = String(cfg.API_BASE || '').replace(/\/+$/, '');

  var dlg = document.getElementById('onboard');
  if (!dlg) return;

  function apiPost(path, body) {
    return fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'Server error (' + r.status + ')' }; });
    }).then(function (j) {
      if (!j.ok) throw new Error(j.error || 'Request failed');
      return j.result;
    });
  }

  function show(view) {
    dlg.querySelectorAll('.ob-view').forEach(function (v) {
      v.hidden = v.getAttribute('data-view') !== view;
    });
    if (!dlg.open) dlg.showModal ? dlg.showModal() : dlg.setAttribute('open', '');
  }
  window.openOnboard = show;

  function msg(id, text, ok) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || '';
    el.style.color = ok ? '#2E7D32' : '#B3453B';
  }

  function busy(btn, on, label) {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Please wait...'; btn.disabled = true; }
    else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
  }

  function continueToWorkspace(r) {
    var supportedApps = ['sales', 'services'];
    var apps = r && Array.isArray(r.apps)
      ? r.apps.filter(function (app) { return supportedApps.indexOf(app) !== -1; })
      : [];
    if (!r || !r.code || !apps.length) {
      throw new Error('No active application workspace is linked to this account. Please contact support.');
    }

    try {
      localStorage.setItem('bizCode', r.code);
      if (r.session) localStorage.setItem('bizSession', r.session);
      if (r.bizName) localStorage.setItem('bizName', r.bizName);
    } catch (e) {}

    var businessCode = encodeURIComponent(r.code);
    if (apps.length === 1) {
      window.location.href = '/' + apps[0] + '.html?b=' + businessCode;
    } else if (apps.indexOf('sales') !== -1 && apps.indexOf('services') !== -1) {
      window.location.href = '/?b=' + businessCode + '&pick=1';
    } else {
      throw new Error('This account has an unsupported application selection. Please contact support.');
    }
  }

  // Toggle password visibility
  dlg.querySelectorAll('[data-toggle]').forEach(function (b) {
    b.addEventListener('click', function () {
      var inp = document.getElementById(b.getAttribute('data-toggle'));
      if (!inp) return;
      var showPw = inp.type === 'password';
      inp.type = showPw ? 'text' : 'password';
      b.textContent = showPw ? 'Hide' : 'Show';
    });
  });

  // Navigate between views
  dlg.querySelectorAll('[data-goto]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      show(a.getAttribute('data-goto'));
    });
  });

  document.getElementById('closeOnboard').addEventListener('click', function () { dlg.close(); });

  // ---- Log in ----
  document.getElementById('doLogin').addEventListener('click', function () {
    var btn = this;
    var email = document.getElementById('loginEmail').value.trim();
    var password = document.getElementById('loginPassword').value;
    msg('loginMsg', '');
    if (!email || !password) { msg('loginMsg', 'Enter your email and password.'); return; }
    busy(btn, true, 'Logging in...');
    apiPost('/api/onboard/login', { email: email, password: password })
      .then(continueToWorkspace)
      .catch(function (e) { busy(btn, false); msg('loginMsg', e.message || 'Log in failed.'); });
  });

  // ---- Sign up ----
  document.getElementById('doSignup').addEventListener('click', function () {
    var btn = this;
    var payload = {
      businessName: document.getElementById('suName').value.trim(),
      email: document.getElementById('suEmail').value.trim(),
      password: document.getElementById('suPassword').value,
      appVersion: document.getElementById('suVersion').value
    };
    msg('signupMsg', '');
    if (!payload.businessName) { msg('signupMsg', 'Enter your business name.'); return; }
    if (!payload.email) { msg('signupMsg', 'Enter your business email.'); return; }
    if (payload.password.length < 8) { msg('signupMsg', 'Password must be at least 8 characters.'); return; }
    busy(btn, true, 'Creating account...');
    apiPost('/api/onboard/register', payload)
      .then(function (r) {
        busy(btn, false);
        // Automatically log in after successful signup
        return apiPost('/api/onboard/login', { email: payload.email, password: payload.password });
      })
      .then(continueToWorkspace)
      .catch(function (e) { busy(btn, false); msg('signupMsg', e.message || 'Sign up failed.'); });
  });

  // ---- Password reset: request code ----
  document.getElementById('doResetRequest').addEventListener('click', function () {
    var btn = this;
    var email = document.getElementById('rsEmail').value.trim();
    msg('resetMsg', '');
    if (!email) { msg('resetMsg', 'Enter your email.'); return; }
    busy(btn, true, 'Sending...');
    apiPost('/api/onboard/reset/request', { email: email })
      .then(function (r) {
        busy(btn, false);
        msg('resetMsg', r.message || 'If registered, a code was sent.', true);
        document.getElementById('resetConfirm').hidden = false;
      })
      .catch(function (e) { busy(btn, false); msg('resetMsg', e.message || 'Could not send code.'); });
  });

  // ---- Password reset: confirm ----
  document.getElementById('doResetConfirm').addEventListener('click', function () {
    var btn = this;
    var payload = {
      email: document.getElementById('rsEmail').value.trim(),
      otp: document.getElementById('rsOtp').value.trim(),
      password: document.getElementById('rsPassword').value
    };
    msg('resetMsg', '');
    if (!payload.otp) { msg('resetMsg', 'Enter the 6-digit code.'); return; }
    if (payload.password.length < 8) { msg('resetMsg', 'New password must be at least 8 characters.'); return; }
    busy(btn, true, 'Saving...');
    apiPost('/api/onboard/reset/confirm', payload)
      .then(function () {
        busy(btn, false);
        document.getElementById('noticeTitle').textContent = 'Password updated';
        document.getElementById('noticeText').textContent = 'Your password has been reset. Please log in.';
        show('notice');
      })
      .catch(function (e) { busy(btn, false); msg('resetMsg', e.message || 'Reset failed.'); });
  });

  // ---- Handle post-verification redirect (?verified=1|0) ----
  var q = new URLSearchParams(location.search);
  if (q.has('verified')) {
    var ok = q.get('verified') === '1';
    document.getElementById('noticeTitle').textContent = ok ? 'Email verified' : 'Verification failed';
    document.getElementById('noticeText').textContent = ok
      ? 'Your workspace is ready. Log in to get started.'
      : 'That link is invalid or expired. Register again or request a new link.';
    show(ok ? 'notice' : 'login');
    // Clean the query string so a refresh does not repeat it.
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
  }
})();
