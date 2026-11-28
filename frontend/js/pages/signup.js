// Signup / business registration.
(function () {
  var BZ = window.BZ;
  document.getElementById('yr').textContent = new Date().getFullYear();

  // show/hide password
  document.querySelectorAll('[data-toggle]').forEach(function (t) {
    t.addEventListener('click', function () {
      var i = document.getElementById(t.getAttribute('data-toggle'));
      var show = i.type === 'password';
      i.type = show ? 'text' : 'password';
      t.textContent = show ? 'Hide' : 'Show';
    });
  });

  // version cards
  var cards = Array.prototype.slice.call(document.querySelectorAll('#versionCards .vcard'));
  function selectCard(card) {
    cards.forEach(function (c) { c.classList.toggle('selected', c === card); });
    card.querySelector('input').checked = true;
  }
  cards.forEach(function (c) {
    c.addEventListener('click', function (e) { e.preventDefault(); selectCard(c); });
  });

  // Preselect from ?v= (sales|svc|both) or default to BOTH
  var q = new URLSearchParams(location.search).get('v');
  var want = q === 'sales' ? 'SALES' : q === 'svc' ? 'SVC' : q === 'both' ? 'BOTH' : 'BOTH';
  var preset = cards.filter(function (c) { return c.getAttribute('data-v') === want; })[0] || cards[2];
  selectCard(preset);

  var form = document.getElementById('signupForm');
  var btn = document.getElementById('submitBtn');
  var err = document.getElementById('err');

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    err.textContent = '';
    var payload = {
      businessName: document.getElementById('bizName').value.trim(),
      email: document.getElementById('email').value.trim(),
      password: document.getElementById('password').value,
      appVersion: (document.querySelector('#versionCards input:checked') || {}).value
    };
    if (!payload.businessName) { err.textContent = 'Enter your business name.'; return; }
    if (!payload.email) { err.textContent = 'Enter your business email.'; return; }
    if (payload.password.length < 8) { err.textContent = 'Password must be at least 8 characters.'; return; }
    if (!payload.appVersion) { err.textContent = 'Select an application version.'; return; }

    btn.disabled = true; var label = btn.textContent; btn.textContent = 'Creating…';
    BZ.register(payload)
      .then(function (r) {
        btn.disabled = false; btn.textContent = label;
        if (r && r.status === 'active') {
          // Verification disabled: log straight in and enter the workspace.
          return BZ.login(payload.email, payload.password).then(function (s) {
            BZ.saveSession(s);
            location.replace('/app.html');
          });
        }
        // Verification required: tell them to check email, then go to login.
        var t = document.getElementById('toast');
        t.textContent = (r && r.message) || 'Check your email to verify your account.';
        t.classList.add('show');
        setTimeout(function () { location.replace('/login.html'); }, 2600);
      })
      .catch(function (e2) {
        btn.disabled = false; btn.textContent = label;
        err.textContent = e2.message || 'Could not create your workspace.';
      });
  });
})();
