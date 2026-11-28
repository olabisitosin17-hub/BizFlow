// Bizinflow API client — thin wrapper over the existing backend endpoints.
// Uses the bearer session token stored at login. Never exposes credentials.
(function () {
  var cfg = window.APP_CONFIG || {};
  var API = String(cfg.API_BASE || '').replace(/\/+$/, '');

  function token() { try { return localStorage.getItem('bizSession') || ''; } catch (e) { return ''; } }
  function authCode() { try { return localStorage.getItem('bizCode') || ''; } catch (e) { return ''; } }
  function bizName() { try { return localStorage.getItem('bizName') || ''; } catch (e) { return ''; } }
  function apps() {
    try { return JSON.parse(localStorage.getItem('bizApps') || '[]'); } catch (e) { return []; }
  }

  function post(path, body, withAuth) {
    var headers = { 'Content-Type': 'application/json' };
    if (withAuth && token()) headers['Authorization'] = 'Bearer ' + token();
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 70000);
    return fetch(API + path, { method: 'POST', headers: headers, body: JSON.stringify(body || {}), signal: ctrl.signal })
      .then(function (r) {
        return r.json().catch(function () { return { ok: false, error: 'Server error (' + r.status + ')' }; })
          .then(function (j) { j.__status = r.status; return j; });
      })
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || 'Request failed');
        return j.result;
      })
      .catch(function (e) {
        if (e && e.name === 'AbortError') throw new Error('The server took too long. Please try again.');
        if (e instanceof TypeError) throw new Error('Cannot reach the server. Check your connection.');
        throw e;
      })
      .finally(function () { clearTimeout(timer); });
  }

  // Call an app action: api('sales','getProductsList',[...])
  function call(app, fn, args) {
    return post('/api/call', { app: app, fn: fn, args: args || [] }, true);
  }

  // Cross-app dashboard (no app required).
  function dashboard(opts) {
    return post('/api/call', { fn: 'getDashboard', args: [opts || {}] }, true);
  }

  function login(email, password) { return post('/api/onboard/login', { email: email, password: password }, false); }
  function register(payload) { return post('/api/onboard/register', payload, false); }
  function resetRequest(email) { return post('/api/onboard/reset/request', { email: email }, false); }
  function resetConfirm(payload) { return post('/api/onboard/reset/confirm', payload, false); }

  function saveSession(r) {
    try {
      localStorage.setItem('bizSession', r.session || '');
      localStorage.setItem('bizCode', r.code || '');
      localStorage.setItem('bizName', r.bizName || '');
      localStorage.setItem('bizEmail', r.email || '');
      localStorage.setItem('bizApps', JSON.stringify(r.apps || []));
    } catch (e) {}
  }

  function clearSession() {
    try {
      ['bizSession', 'bizCode', 'bizName', 'bizEmail', 'bizApps'].forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) {}
  }

  function requireAuth() {
    if (!token()) { location.replace('/login.html'); return false; }
    return true;
  }

  window.BZ = {
    API: API, token: token, code: authCode, bizName: bizName, apps: apps,
    call: call, dashboard: dashboard,
    login: login, register: register, resetRequest: resetRequest, resetConfirm: resetConfirm,
    saveSession: saveSession, clearSession: clearSession, requireAuth: requireAuth
  };
})();
