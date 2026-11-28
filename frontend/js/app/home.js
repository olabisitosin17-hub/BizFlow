// Home dashboard: KPIs, charts, date filters, recent sales — from the getDashboard endpoint.
(function () {
  var BZ = window.BZ;
  var CUR = '₦';

  function money(n) {
    n = Number(n) || 0;
    return CUR + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }
  function rangeFor(val) {
    var now = new Date();
    function at(d, end) { var x = new Date(d); if (end) x.setHours(23,59,59,999); else x.setHours(0,0,0,0); return x; }
    function ymd(d) { return d.toISOString().slice(0,10); }
    var from, to = ymd(now);
    if (val === 'today') from = ymd(now);
    else if (val === 'yesterday') { var y = new Date(now); y.setDate(y.getDate()-1); from = ymd(y); to = ymd(y); }
    else if (val === 'week') { var w = new Date(now); w.setDate(w.getDate()-6); from = ymd(w); }
    else if (val === 'year') { from = ymd(new Date(now.getFullYear(),0,1)); }
    else { from = ymd(new Date(now.getFullYear(), now.getMonth(), 1)); } // month default
    return { from: from, to: to };
  }

  var KPI = [
    { key: 'revenue', label: 'Total revenue', ico: '💰' },
    { key: 'expenses', label: 'Total expenses', ico: '💸' },
    { key: 'profit', label: 'Net profit', ico: '📈' },
    { key: 'sales', label: 'Total sales', ico: '🛒' },
    { key: 'customers', label: 'Customers', ico: '👥' },
    { key: 'outstanding', label: 'Outstanding', ico: '⏳' }
  ];

  function renderKPIs(d) {
    var grid = document.getElementById('kpiGrid');
    var vals = {
      revenue: d.totals.revenue, expenses: d.totals.expenses, profit: d.totals.profit,
      sales: d.counts.sales, customers: d.counts.customers, outstanding: 0
    };
    grid.innerHTML = KPI.map(function (k) {
      var v = k.key === 'sales' || k.key === 'customers' ? Number(vals[k.key]).toLocaleString() : money(vals[k.key]);
      return '<div class="kpi"><div class="k-top"><span class="k-ico">' + k.ico + '</span></div>' +
        '<div class="k-label">' + k.label + '</div><div class="k-value">' + v + '</div></div>';
    }).join('');
  }

  // --- Tiny canvas line chart ---
  function drawLine(canvas, points, color, fill) {
    var ctx = canvas.getContext('2d');
    var W = canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1);
    var H = canvas.height = 220 * (window.devicePixelRatio || 1);
    ctx.clearRect(0, 0, W, H);
    var pad = 24 * (window.devicePixelRatio || 1);
    var max = Math.max.apply(null, points.map(function (p) { return p.y; }).concat([1]));
    var n = points.length;
    if (!n) return;
    var stepX = (W - pad * 2) / Math.max(n - 1, 1);
    var xy = points.map(function (p, i) {
      return { x: pad + i * stepX, y: H - pad - (p.y / max) * (H - pad * 2) };
    });
    // grid
    ctx.strokeStyle = 'rgba(47,65,86,.08)'; ctx.lineWidth = 1;
    for (var g = 0; g <= 4; g++) { var gy = pad + (H - pad*2) * g/4; ctx.beginPath(); ctx.moveTo(pad, gy); ctx.lineTo(W-pad, gy); ctx.stroke(); }
    // fill
    if (fill) {
      ctx.beginPath(); ctx.moveTo(xy[0].x, H - pad);
      xy.forEach(function (p) { ctx.lineTo(p.x, p.y); });
      ctx.lineTo(xy[n-1].x, H - pad); ctx.closePath();
      var grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, 'rgba(86,124,141,.28)'); grad.addColorStop(1, 'rgba(200,217,230,.05)');
      ctx.fillStyle = grad; ctx.fill();
    }
    // line
    ctx.beginPath(); xy.forEach(function (p, i) { i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
    ctx.strokeStyle = color; ctx.lineWidth = 2.4 * (window.devicePixelRatio || 1); ctx.lineJoin = 'round'; ctx.stroke();
    // points
    ctx.fillStyle = color; xy.forEach(function (p) { ctx.beginPath(); ctx.arc(p.x, p.y, 3*(window.devicePixelRatio||1), 0, 7); ctx.fill(); });
  }

  function drawBar(canvas, items) {
    var ctx = canvas.getContext('2d');
    var W = canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1);
    var H = canvas.height = 220 * (window.devicePixelRatio || 1);
    ctx.clearRect(0, 0, W, H);
    if (!items.length) return;
    var pad = 24 * (window.devicePixelRatio || 1);
    var max = Math.max.apply(null, items.map(function (i) { return i.amount; }).concat([1]));
    var n = items.length;
    var bw = (W - pad * 2) / n * 0.55;
    var gap = (W - pad * 2) / n;
    var colors = ['#2F4156', '#567C8D', '#7C9BB0', '#C8D9E6', '#93AEBF'];
    items.forEach(function (it, i) {
      var h = (it.amount / max) * (H - pad * 2);
      var x = pad + i * gap + (gap - bw) / 2;
      ctx.fillStyle = colors[i % colors.length];
      ctx.beginPath();
      var r = 6 * (window.devicePixelRatio || 1);
      roundRect(ctx, x, H - pad - h, bw, h, r); ctx.fill();
    });
    // labels
    ctx.fillStyle = 'rgba(47,65,86,.7)';
    ctx.font = (11 * (window.devicePixelRatio || 1)) + 'px Inter, sans-serif';
    ctx.textAlign = 'center';
    items.forEach(function (it, i) {
      var x = pad + i * gap + gap / 2;
      var label = (it.category || '').slice(0, 10);
      ctx.fillText(label, x, H - pad + 16 * (window.devicePixelRatio || 1));
    });
  }
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, Math.abs(h) / 2);
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
  }

  function renderRecent(list) {
    var el = document.getElementById('recentList');
    if (!list || !list.length) { el.innerHTML = '<p class="muted">No sales yet.</p>'; return; }
    el.innerHTML = list.map(function (r) {
      var d = r.date ? new Date(r.date).toLocaleDateString() : '';
      return '<div class="recent-row"><div class="r-main"><div class="r-ref">' + (r.ref || '—') + '</div>' +
        '<div class="r-sub">' + (r.customer || 'Walk-in') + (r.item ? ' · ' + r.item : '') + '</div></div>' +
        '<div class="r-sub">' + d + '</div><div class="r-amt">' + money(r.amount) + '</div></div>';
    }).join('');
  }

  function load(range) {
    var sub = document.getElementById('dashSub');
    if (sub) sub.textContent = 'Showing ' + (range.from || '') + ' → ' + (range.to || '');
    var cr = document.getElementById('chartRange');
    if (cr) cr.textContent = document.getElementById('fDate').selectedOptions[0].text;
    BZ.dashboard({ from: range.from, to: range.to })
      .then(function (d) {
        renderKPIs(d);
        var series = d.series.byDay || [];
        var pts = series.map(function (p) { return { y: p.revenue }; });
        var se = document.getElementById('chartEmpty'), ee = document.getElementById('expEmpty');
        if (pts.length) { se && se.classList.add('hidden'); drawLine(document.getElementById('salesChart'), pts, '#567C8D', true); }
        else { se && se.classList.remove('hidden'); }
        var exp = d.expenseBreakdown || [];
        if (exp.length) { ee && ee.classList.add('hidden'); drawBar(document.getElementById('expenseChart'), exp); }
        else { ee && ee.classList.remove('hidden'); }
        renderRecent(d.recent);
      })
      .catch(function (e) {
        var g = document.getElementById('kpiGrid');
        if (g) g.innerHTML = '<div class="card card-pad" style="grid-column:1/-1"><p class="muted" style="margin:0">' +
          (e.message || 'Could not load dashboard.') + '</p></div>';
      });
  }

  // Filters
  var sel = document.getElementById('fDate');
  var customBox = document.getElementById('customRange');
  sel.addEventListener('change', function () {
    if (sel.value === 'custom') { customBox.classList.remove('hidden'); return; }
    customBox.classList.add('hidden');
    load(rangeFor(sel.value));
  });
  var apply = document.getElementById('fApply');
  if (apply) apply.addEventListener('click', function () {
    load({ from: document.getElementById('fFrom').value, to: document.getElementById('fTo').value });
  });

  window.BZHome = { reload: function () {
    if (sel.value === 'custom') load({ from: document.getElementById('fFrom').value, to: document.getElementById('fTo').value });
    else load(rangeFor(sel.value));
  } };
})();
