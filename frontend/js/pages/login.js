// Login page logic.
(function () {
  var BZ = window.BZ;
  var form = document.getElementById('loginForm');
  var btn = document.getElementById('submitBtn');
  var err = document.getElementById('err');
  document.getElementById('yr').textContent = new Date().getFullYear();

  // show/hide password toggles
  document.querySelectorAll('[data-toggle]').forEach(function (t) {
    t.addEventListener('click', function () {
      var i = document.getElementById(t.getAttribute('data-toggle'));
      if (!i) return;
      var show = i.type === 'password';
      i.type = show ? 'text' : 'password';
      t.textContent = show ? 'Hide' : 'Show';
    });
  });

  // If already signed in, skip straight to the app.
  try { if (localStorage.getItem('bizSession')) { location.replace('/app.html'); return; } } catch (e) {}

  function setErr(m) { err.textContent = m || ''; }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    setErr('');
    var email = document.getElementById('email').value.trim();
    var pass = document.getElementById('password').value;
    if (!email || !pass) { setErr('Enter your email and password.'); return; }
    btn.disabled = true; var label = btn.textContent; btn.textContent = 'Signing in…';
    BZ.login(email, pass)
      .then(function (r) {
        BZ.saveSession(r);
        if (document.getElementById('remember').checked) {
          try { localStorage.setItem('bizRemember', email); } catch (e2) {}
        }
        location.replace('/app.html');
      })
      .catch(function (e2) {
        btn.disabled = false; btn.textContent = label;
        setErr(e2.message || 'Login failed.');
      });
  });

  // Prefill remembered email
  try { var r = localStorage.getItem('bizRemember'); if (r) { document.getElementById('email').value = r; document.getElementById('remember').checked = true; } } catch (e) {}

  // ---- Forgot password sheet ----
  var sheet = document.getElementById('resetSheet');
  var backdrop = document.getElementById('sheetBackdrop');
  var toastEl = document.getElementById('toast');
  function toast(m) { toastEl.textContent = m; toastEl.classList.add('show'); setTimeout(function () { toastEl.classList.remove('show'); }, 2400); }
  function openSheet() { sheet.classList.add('show'); backdrop.classList.add('show'); }
  function closeSheet() { sheet.classList.remove('show'); backdrop.classList.remove('show'); }

  document.getElementById('forgot').addEventListener('click', function (e) {
    e.preventDefault();
    document.getElementById('rsEmail').value = document.getElementById('email').value.trim();
    openSheet();
  });
  document.getElementById('closeReset').addEventListener('click', closeSheet);
  backdrop.addEventListener('click', closeSheet);

  document.getElementById('rsSend').addEventListener('click', function () {
    var email = document.getElementById('rsEmail').value.trim();
    var msg = document.getElementById('rsMsg');
    if (!email) { msg.textContent = 'Enter your email.'; return; }
    msg.textContent = '';
    var b = this; b.disabled = true; b.textContent = 'Sending…';
    BZ.resetRequest(email).then(function (r) {
      b.disabled = false; b.textContent = 'Send reset code';
      msg.style.color = 'var(--ok)'; msg.textContent = (r && r.message) || 'If registered, a code was sent.';
      document.getElementById('rsConfirm').classList.remove('hidden');
    }).catch(function (e) {
      b.disabled = false; b.textContent = 'Send reset code';
      msg.style.color = 'var(--err)'; msg.textContent = e.message || 'Could not send code.';
    });
  });

  document.getElementById('rsConfirmBtn').addEventListener('click', function () {
    var payload = {
      email: document.getElementById('rsEmail').value.trim(),
      otp: document.getElementById('rsOtp').value.trim(),
      password: document.getElementById('rsPass').value
    };
    var msg = document.getElementById('rsMsg');
    if (!payload.otp) { msg.style.color = 'var(--err)'; msg.textContent = 'Enter the 6-digit code.'; return; }
    if (payload.password.length < 8) { msg.style.color = 'var(--err)'; msg.textContent = 'Password must be at least 8 characters.'; return; }
    var b = this; b.disabled = true; b.textContent = 'Saving…';
    BZ.resetConfirm(payload).then(function () {
      b.disabled = false; b.textContent = 'Set new password';
      closeSheet(); toast('Password updated. Please log in.');
    }).catch(function (e) {
      b.disabled = false; b.textContent = 'Set new password';
      msg.style.color = 'var(--err)'; msg.textContent = e.message || 'Reset failed.';
    });
  });
})();
