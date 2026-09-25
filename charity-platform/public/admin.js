(function () {
  const $ = (s, root = document) => root.querySelector(s);
  const TOKEN_KEY = 'athar_admin_token';
  let token = null;
  try { token = sessionStorage.getItem(TOKEN_KEY); } catch (_) {}

  let state = { donations: [], counts: {}, cities: [], statuses: [], selectedId: null };
  const fmt = (iso) => new Date(iso).toLocaleString('ar-SA-u-ca-gregory', { dateStyle: 'medium', timeStyle: 'short' });
  const statusLabel = (key) => (state.statuses.find((s) => s.key === key) || {}).label || key;

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) }
    });
    if (res.status === 401 && path !== '/api/admin/login') { logout(); throw new Error('انتهت الجلسة'); }
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : res;
    if (!res.ok) throw new Error(data.error || 'حدث خطأ');
    return data;
  }

  // ---------- الدخول والخروج ----------
  function showApp(on) {
    $('#login-view').hidden = on;
    $('#app-view').hidden = !on;
  }
  function logout() {
    if (token) fetch('/api/admin/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    token = null;
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (_) {}
    showApp(false);
  }
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    try {
      const out = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: e.target.password.value }) });
      token = out.token;
      try { sessionStorage.setItem(TOKEN_KEY, token); } catch (_) {}
      e.target.reset();
      showApp(true);
      load();
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  });
  $('#logout-btn').addEventListener('click', logout);
  $('#refresh-btn').addEventListener('click', () => load());

  $('#export-btn').addEventListener('click', async () => {
    try {
      const res = await api('/api/admin/export.csv');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `تبرعات-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) { alert(err.message); }
  });

  // ---------- التحميل والفلاتر ----------
  let searchTimer;
  $('#f-q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(load, 300); });
  $('#f-status').addEventListener('change', load);
  $('#f-city').addEventListener('change', load);

  async function load() {
    const params = new URLSearchParams();
    if ($('#f-q').value.trim()) params.set('q', $('#f-q').value.trim());
    if ($('#f-status').value) params.set('status', $('#f-status').value);
    if ($('#f-city').value) params.set('city', $('#f-city').value);
    try {
      const data = await api(`/api/admin/donations?${params}`);
      state = { ...state, ...data };
      renderFilters();
      renderKpis();
      renderList();
      if (state.selectedId) renderDetail(state.donations.find((d) => d.id === state.selectedId));
    } catch (err) {
      if (token) $('#list').innerHTML = `<p class="empty">${err.message}</p>`;
    }
  }

  function fillSelect(sel, items, current) {
    const first = sel.options[0];
    sel.replaceChildren(first);
    items.forEach(({ value, label }) => sel.add(new Option(label, value, false, value === current)));
  }
  function renderFilters() {
    fillSelect($('#f-status'), state.statuses.map((s) => ({ value: s.key, label: s.label })), $('#f-status').value);
    fillSelect($('#f-city'), state.cities.map((c) => ({ value: c, label: c })), $('#f-city').value);
  }

  function renderKpis() {
    const box = $('#kpis');
    box.replaceChildren();
    const total = Object.values(state.counts).reduce((a, b) => a + b, 0);
    const cards = [{ key: '', label: 'كل الطلبات', n: total }, ...state.statuses.map((s) => ({ key: s.key, label: s.label, n: state.counts[s.key] || 0 }))];
    cards.forEach((c) => {
      const b = document.createElement('button');
      b.className = 'kpi' + ($('#f-status').value === c.key ? ' active' : '');
      b.innerHTML = '<strong></strong><span></span>';
      b.querySelector('strong').textContent = c.n.toLocaleString('ar-SA');
      b.querySelector('span').textContent = c.label;
      b.addEventListener('click', () => { $('#f-status').value = c.key; load(); });
      box.appendChild(b);
    });
  }

  function renderList() {
    const list = $('#list');
    list.replaceChildren();
    if (!state.donations.length) {
      list.innerHTML = '<p class="empty">لا توجد طلبات مطابقة</p>';
      return;
    }
    state.donations.forEach((d) => {
      const el = document.createElement('button');
      el.className = 'item' + (d.id === state.selectedId ? ' selected' : '');
      el.innerHTML = '<b></b><span class="badge"></span><small class="meta"></small><small class="date"></small>';
      el.querySelector('b').textContent = d.name;
      const badge = el.querySelector('.badge');
      badge.textContent = statusLabel(d.status);
      badge.classList.add(`badge--${d.status}`);
      el.querySelector('.meta').textContent = `${d.code} · ${d.city}${d.district ? ' - ' + d.district : ''} · ${d.types.join('، ')}`;
      el.querySelector('.date').textContent = fmt(d.createdAt);
      el.addEventListener('click', () => {
        state.selectedId = d.id;
        list.querySelectorAll('.item').forEach((x) => x.classList.remove('selected'));
        el.classList.add('selected');
        renderDetail(d);
      });
      list.appendChild(el);
    });
  }

  // ---------- تفاصيل الطلب ----------
  function renderDetail(d) {
    const panel = $('#detail');
    if (!d) { panel.classList.remove('open'); return; }
    panel.replaceChildren($('#detail-tpl').content.cloneNode(true));
    panel.classList.add('open');
    const f = (name) => $(`[data-f="${name}"]`, panel);
    const intl = `966${d.phone.slice(1)}`;

    f('name').textContent = d.name;
    f('code').textContent = d.code;
    f('phone').textContent = d.phone;
    f('area').textContent = [d.city, d.district].filter(Boolean).join(' - ');
    f('address').textContent = d.address || '—';
    f('types').textContent = d.types.join('، ');
    f('quantity').textContent = d.quantity || '—';
    f('details').textContent = d.details || '—';
    f('preferredTime').textContent = d.preferredTime || '—';
    f('createdAt').textContent = fmt(d.createdAt);
    f('call').href = `tel:${d.phone}`;
    f('wa').href = `https://wa.me/${intl}`;
    const mapQuery = d.location ? `${d.location.lat},${d.location.lng}` : [d.address, d.district, d.city].filter(Boolean).join(' ');
    f('map').href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}`;
    if (!d.location) f('map').textContent = '📍 بحث بالعنوان';

    $('[data-close]', panel).addEventListener('click', () => panel.classList.remove('open'));

    const form = $('[data-form="update"]', panel);
    state.statuses.forEach((s) => form.status.add(new Option(s.label, s.key, false, s.key === d.status)));
    form.pickupDate.value = d.pickupDate || '';
    form.assignee.value = d.assignee || '';
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      f('error').textContent = '';
      const body = {
        status: form.status.value,
        pickupDate: form.pickupDate.value,
        assignee: form.assignee.value,
        message: form.message.value,
        note: form.note.value,
        notify: form.notify.checked
      };
      try {
        const out = await api(`/api/admin/donations/${d.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        state.selectedId = d.id;
        await load();
        if (out.notification) showNotice(out.notification);
      } catch (err) {
        f('error').textContent = err.message;
      }
    });

    const tl = f('history');
    d.history.forEach((h) => {
      const li = document.createElement('li');
      li.className = 'done';
      li.textContent = statusLabel(h.status);
      const s = document.createElement('small');
      s.textContent = fmt(h.at);
      li.appendChild(s);
      tl.appendChild(li);
    });
    tl.lastElementChild?.classList.add('current');

    fillNotes(f('notes'), d.notes.map((n) => ({ text: n.text, at: n.at })), 'لا توجد ملاحظات');
    fillNotes(f('notifications'), d.notifications.map((n) => ({ text: `${statusLabel(n.status)} — ${n.info}`, at: n.at })), 'لم تُرسل إشعارات بعد');
  }

  function fillNotes(ul, items, emptyText) {
    if (!items.length) { ul.innerHTML = `<li class="muted">${emptyText}</li>`; return; }
    [...items].reverse().forEach((n) => {
      const li = document.createElement('li');
      li.textContent = n.text;
      const s = document.createElement('small');
      s.textContent = fmt(n.at);
      li.appendChild(s);
      ul.appendChild(li);
    });
  }

  function showNotice(n) {
    const box = $('[data-f="notice"]', $('#detail'));
    if (!box) return;
    box.hidden = false;
    box.replaceChildren();
    const p = document.createElement('p');
    p.textContent = n.ok ? '✅ تم إشعار المتبرع تلقائيًا عبر واتساب.' : `ℹ️ ${n.info}.`;
    box.appendChild(p);
    if (!n.ok) {
      const a = document.createElement('a');
      a.className = 'btn btn--primary btn--sm';
      a.href = n.manualLink; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = '💬 إرسال الإشعار عبر واتساب';
      box.appendChild(a);
    }
  }

  if (token) { showApp(true); load(); } else { showApp(false); }
})();
