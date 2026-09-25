(function () {
  const cfg = window.SITE_CONFIG || {};
  const $ = (sel) => document.querySelector(sel);

  // ---------- القائمة في الجوال ----------
  const toggle = $('.nav-toggle');
  const nav = $('#nav');
  if (toggle && nav) {
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    nav.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') nav.classList.remove('open');
    });
  }

  const year = $('#year');
  if (year) year.textContent = new Date().getFullYear();

  // ---------- روابط واتساب والتواصل ----------
  const waMessages = {
    general: 'السلام عليكم، لدي استفسار عن منصة أثر.',
    volunteer: 'السلام عليكم، أرغب في التطوع مع منصة أثر.',
    partner: 'السلام عليكم، نرغب في الشراكة مع منصة أثر كجهة/شركة.',
    beneficiary: 'السلام عليكم، أرغب في تسجيل طلب مساعدة لدى منصة أثر.'
  };
  document.querySelectorAll('[data-wa]').forEach((el) => {
    const text = waMessages[el.dataset.wa] || waMessages.general;
    el.href = `https://wa.me/${cfg.whatsapp}?text=${encodeURIComponent(text)}`;
    el.target = '_blank';
    el.rel = 'noopener';
  });
  const email = $('#footer-email');
  if (email && cfg.email) email.href = `mailto:${cfg.email}`;
  const social = $('#social');
  if (social && cfg.social) {
    const labels = { x: 'X', instagram: 'انستقرام', snapchat: 'سناب', tiktok: 'تيك توك' };
    Object.entries(cfg.social).forEach(([key, url]) => {
      const a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = labels[key] || key;
      social.appendChild(a);
    });
  }

  // ---------- الأرقام الحية ----------
  function countUp(el, target) {
    const start = performance.now();
    const dur = 1200;
    (function tick(now) {
      const p = Math.min((now - start) / dur, 1);
      el.textContent = Math.round(target * p).toLocaleString('ar-SA');
      if (p < 1) requestAnimationFrame(tick);
    })(start);
  }
  if ($('#stat-total')) {
    fetch('/api/stats')
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (!s) return;
        countUp($('#stat-total'), s.total);
        countUp($('#stat-delivered'), s.delivered);
        countUp($('#stat-items'), s.items);
        countUp($('#stat-cities'), s.cities);
      })
      .catch(() => {});
  }

  // ---------- تحديد الموقع ----------
  const form = $('#donate-form');
  if (!form) return;
  const locBtn = $('#locate-btn');
  const locStatus = $('#locate-status');
  locBtn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      locStatus.textContent = 'المتصفح لا يدعم تحديد الموقع، اكتب العنوان يدويًا.';
      return;
    }
    locStatus.textContent = 'جارٍ تحديد موقعك...';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        form.lat.value = pos.coords.latitude.toFixed(6);
        form.lng.value = pos.coords.longitude.toFixed(6);
        locStatus.textContent = '✔ تم تحديد موقعك بنجاح';
        locStatus.classList.add('ok');
      },
      () => { locStatus.textContent = 'تعذّر تحديد الموقع، اكتب العنوان يدويًا.'; },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  });

  // ---------- إرسال الطلب ----------
  const errorEl = $('#form-error');
  const submitBtn = $('#submit-btn');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    const data = new FormData(form);
    const types = data.getAll('type');
    const phone = String(data.get('phone') || '').replace(/\s|-/g, '');

    if (!data.get('name').trim()) return (errorEl.textContent = 'فضلًا اكتب اسمك.');
    if (!/^0?5\d{8}$/.test(phone)) return (errorEl.textContent = 'فضلًا اكتب رقم جوال صحيح يبدأ بـ 05.');
    if (!data.get('city').trim()) return (errorEl.textContent = 'فضلًا اكتب المدينة.');
    if (!types.length) return (errorEl.textContent = 'اختر نوع التبرع (نوع واحد على الأقل).');
    if (!data.get('consent')) return (errorEl.textContent = 'فضلًا وافق على تواصل الفريق معك.');

    const payload = {
      name: data.get('name'),
      phone,
      city: data.get('city'),
      district: data.get('district'),
      address: data.get('address'),
      types,
      details: data.get('details'),
      quantity: data.get('quantity'),
      time: data.get('time'),
      lat: data.get('lat'),
      lng: data.get('lng')
    };

    submitBtn.disabled = true;
    submitBtn.textContent = 'جارٍ الإرسال...';
    try {
      const res = await fetch('/api/donations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || 'تعذّر إرسال الطلب');
      form.hidden = true;
      $('#success-code').textContent = out.code;
      $('#success-track').href = `track.html?code=${encodeURIComponent(out.code)}`;
      $('#donate-success').hidden = false;
      $('#donate-success').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (err) {
      // احتياطي: إذا تعذّر الاتصال بالخادم يُرسل الطلب عبر واتساب حتى لا يضيع التبرع
      errorEl.textContent = `${err.message}. سيتم تحويلك لإرسال الطلب عبر واتساب.`;
      const lines = [
        'طلب استلام تبرع',
        `الاسم: ${payload.name}`, `الجوال: ${payload.phone}`,
        `المدينة: ${payload.city} - ${payload.district || ''}`,
        `النوع: ${types.join('، ')}`, `التفاصيل: ${payload.details || '-'}`,
        payload.lat ? `الموقع: https://maps.google.com/?q=${payload.lat},${payload.lng}` : ''
      ].filter(Boolean);
      setTimeout(() => {
        window.open(`https://wa.me/${cfg.whatsapp}?text=${encodeURIComponent(lines.join('\n'))}`, '_blank');
      }, 1500);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'إرسال طلب الاستلام';
    }
  });

  // ---------- المشاركة ----------
  $('#share-btn').addEventListener('click', async () => {
    const shareData = {
      title: cfg.name,
      text: 'تبرعت بأثاث/ملابس عبر منصة أثر 🌱 شاركني الأجر وتبرع بما لا تحتاجه:',
      url: location.origin
    };
    if (navigator.share) {
      try { await navigator.share(shareData); } catch (_) { /* أُلغيت المشاركة */ }
    } else {
      window.open(`https://wa.me/?text=${encodeURIComponent(`${shareData.text} ${shareData.url}`)}`, '_blank');
    }
  });
})();
