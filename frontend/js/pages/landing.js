// Landing page interactions.
(function () {
  var burger = document.getElementById('burger');
  var links = document.getElementById('navLinks');
  if (burger && links) {
    burger.addEventListener('click', function () {
      var open = links.classList.toggle('open');
      burger.setAttribute('aria-expanded', String(open));
    });
    links.addEventListener('click', function (e) { if (e.target.closest('a')) links.classList.remove('open'); });
  }
  var yr = document.getElementById('yr');
  if (yr) yr.textContent = new Date().getFullYear();

  // Smooth section scroll + active nav
  document.querySelectorAll('a[href^="#"]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      var id = a.getAttribute('href').slice(1);
      var el = id && document.getElementById(id);
      if (!el) return;
      e.preventDefault();
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // If already logged in, offer to jump straight to the app.
  try {
    if (localStorage.getItem('bizSession')) {
      var nav = document.getElementById('navLinks');
      if (nav) {
        var goto = document.createElement('a');
        goto.className = 'btn btn-navy btn-sm';
        goto.href = '/app.html';
        goto.textContent = 'Open Workspace';
        nav.appendChild(goto);
      }
    }
  } catch (e) {}
})();
