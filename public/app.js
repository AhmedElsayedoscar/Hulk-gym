'use strict';

const app = document.getElementById('app');
let ME = { role: 'staff', gymName: '' };

// ---------- التنقل ----------
const NAV = [
  ['#/', 'لوحة التحكم'],
  ['#/members', 'الأعضاء'],
  ['#/private', '⭐ البرايفت (PT)'],
  ['#/attendance', 'الحضور'],
  ['#/expenses', '💸 المصروفات'],
  ['#/daily-report', '📊 التقرير اليومي', 'admin'],
  ['#/monthly-report', '📅 التقفيل الشهري', 'admin'],
  ['#/employees', '👔 الموظفين والمرتبات', 'admin'],
  ['#/plans', 'الباقات', 'admin'],
  ['#/reminders', '🔔 الإشعارات', 'admin'],
  ['#/settings', '⚙️ الإعدادات', 'admin'],
];

function renderNav(current) {
  const nav = document.getElementById('nav');
  nav.replaceChildren(
    ...NAV.filter((n) => !n[2] || ME.role === 'admin').map(([href, label]) => {
      const on = href === '#/' ? current === '#/' : current.startsWith(href);
      return h('a', { href, class: on ? 'active' : '' }, label);
    }),
    h('a', { href: '/scan.html', class: 'scan-link' }, 'شاشة المسح')
  );
}

function todayLocal() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

// ---------- نافذة منبثقة ----------
function openModal(title, bodyEls, onSubmit, submitLabel = 'حفظ') {
  const err = h('div', { class: 'alert bad', hidden: true });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, submitLabel);
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.hidden = true;
        submit.disabled = true;
        try {
          await onSubmit(new FormData(form));
          back.remove();
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
          submit.disabled = false;
        }
      },
    },
    h('h2', null, title),
    bodyEls,
    err,
    h('div', { class: 'actions' }, submit, h('button', { class: 'btn', type: 'button', onclick: () => back.remove() }, 'إلغاء'))
  );
  const back = h('div', { class: 'modal-back', onmousedown: (e) => e.target === back && back.remove() }, h('div', { class: 'modal' }, form));
  document.body.append(back);
  const first = form.querySelector('input, select, textarea');
  if (first) first.focus();
}

function field(label, input) {
  return h('div', { class: 'field' }, h('label', null, label), input);
}

function planOptions(plans, selectedId) {
  return plans.map((p) =>
    h('option', { value: p.id, selected: p.id === selectedId }, `${p.name} — ${p.duration_days} يوم — ${fmtMoney(p.price)} جنيه`)
  );
}

// ---------- لوحة التحكم ----------
async function pageDashboard() {
  const s = await api('GET', '/api/stats');
  const tile = (cls, num, lbl, href) =>
    h(href ? 'a' : 'div', { class: `tile ${cls}`, href, style: href ? 'color:inherit;text-decoration:none' : null }, h('div', { class: 'num' }, num), h('div', { class: 'lbl' }, lbl));

  const warn =
    ME.defaultPasswords &&
    h(
      'div',
      { class: 'alert warn', style: 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px' },
      h('span', null, '⚠️ تنبيه: السيستم يعمل بكلمة مرور افتراضية (المدير أو الموظف). يُنصح بتغييرها للأمان.'),
      h('a', { href: '#/settings', class: 'btn small primary', style: 'text-decoration:none' }, 'تغيير كلمات المرور')
    );

  const expiringRows = s.expiringList.length
    ? s.expiringList.map((m) =>
        h(
          'tr',
          { class: 'clickable', onclick: () => (location.hash = `#/members/${m.id}`) },
          h('td', null, m.name),
          h('td', { class: 'ltr' }, m.phone || '-'),
          h('td', null, ltr(m.end_date)),
          h('td', null, m.days_left === 0 ? 'النهارده' : `${m.days_left} يوم`)
        )
      )
    : [h('tr', null, h('td', { class: 'empty', colspan: 4 }, 'مفيش اشتراكات هتنتهي خلال أسبوع'))];

  const recentRows = s.recent.length
    ? s.recent.map((a) =>
        h(
          'tr',
          { class: 'clickable', onclick: () => (location.hash = `#/members/${a.member_id}`) },
          h('td', null, fmtTime(a.checkin_at)),
          h('td', null, a.name),
          h('td', null, badge(a.result, a.result === 'ok' ? 'دخول' : REASON_LABEL[a.reason] || 'مرفوض'))
        )
      )
    : [h('tr', null, h('td', { class: 'empty', colspan: 3 }, 'لا يوجد حضور مسجل لسه'))];

  app.replaceChildren(
    warn || '',
    h('div', { class: 'page-head' }, h('h1', null, 'لوحة التحكم'), h('span', { class: 'muted' }, ltr(s.today))),
    h(
      'div',
      { class: 'tiles' },
      tile('ok', s.active, 'اشتراكات سارية', '#/members?status=active'),
      tile('warn', s.expiring, 'ينتهي خلال 7 أيام', '#/members?status=expiring'),
      tile('bad', s.expired, 'اشتراكات منتهية', '#/members?status=expired'),
      tile('info', s.todayCount, 'حضور النهارده', '#/attendance'),
      tile('', s.deniedToday, 'محاولات مرفوضة النهارده', '#/attendance'),
      tile('warn', '💸 المصروفات', 'تسجيل وسجل المصروفات اليومية', '#/expenses'),
      ME.role === 'admin' ? tile('gold', '📊 تقرير الوردية', 'التقرير اليومي للاشتراكات', '#/daily-report') : '',
      ME.role === 'admin' ? tile('gold', '📅 التقفيل الشهري', 'إيرادات الشهر والمرتبات', '#/monthly-report') : ''
    ),
    h(
      'div',
      { class: 'grid-2' },
      h(
        'div',
        { class: 'card' },
        h('h2', null, 'اشتراكات قاربت على الانتهاء'),
        h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'الاسم'), h('th', null, 'الموبايل'), h('th', null, 'تاريخ الانتهاء'), h('th', null, 'المتبقي'))), h('tbody', null, expiringRows)))
      ),
      h(
        'div',
        { class: 'card' },
        h('h2', null, 'آخر حركات الحضور'),
        h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'الوقت'), h('th', null, 'العضو'), h('th', null, 'النتيجة'))), h('tbody', null, recentRows)))
      )
    )
  );
}

// ---------- الأعضاء ----------
async function pageMembers(query) {
  const params = new URLSearchParams(query);
  let q = params.get('q') || '';
  let status = params.get('status') || 'all';

  const list = h('div', { class: 'card table-wrap' });
  const search = h('input', { type: 'search', placeholder: 'ابحث بالاسم أو الموبايل أو كود العضو', value: q });
  const statusSel = h(
    'select',
    null,
    ...[
      ['all', 'كل الأعضاء'],
      ['active', 'ساري'],
      ['expiring', 'قارب على الانتهاء'],
      ['expired', 'منتهي'],
      ['none', 'بدون اشتراك'],
      ['upcoming', 'لم يبدأ بعد'],
    ].map(([v, l]) => h('option', { value: v, selected: v === status }, l))
  );

  let timer;
  async function load() {
    const data = await api('GET', `/api/members?q=${encodeURIComponent(q)}&status=${status}`);
    list.replaceChildren(
      data.length
        ? h(
            'table',
            null,
            h('thead', null, h('tr', null, ['الاسم', 'الموبايل', 'الكود', 'الباقة', 'ينتهي في', 'الحالة'].map((t) => h('th', null, t)))),
            h(
              'tbody',
              null,
              data.map((m) =>
                h(
                  'tr',
                  { class: 'clickable', onclick: () => (location.hash = `#/members/${m.id}`) },
                  h('td', null, m.name),
                  h('td', { class: 'ltr' }, m.phone || '-'),
                  h('td', { class: 'mono' }, m.code),
                  h('td', null, m.sub.plan_name || '-'),
                  h('td', null, m.sub.end_date ? ltr(m.sub.end_date) : '-'),
                  h('td', null, m.active ? badge(m.sub.state) : badge('inactive', 'موقوف'))
                )
              )
            )
          )
        : h('div', { class: 'empty' }, 'لا يوجد أعضاء مطابقين')
    );
  }
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      q = search.value.trim();
      load().catch((e) => toast(e.message, true));
    }, 250);
  });
  statusSel.addEventListener('change', () => {
    status = statusSel.value;
    load().catch((e) => toast(e.message, true));
  });

  app.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;' },
        backBtn('#/', 'الرئيسية'),
        h('h1', { style: 'margin:0;' }, 'الأعضاء')
      ),
      h(
        'div',
        { style: 'display:flex;gap:8px;flex-wrap:wrap;' },
        ME.role === 'admin'
          ? h('a', { class: 'btn', href: '/api/export/members.csv', target: '_blank', title: 'تصدير شيت إكسيل لجميع الأعضاء والاشتراكات' }, '📥 تصدير Excel')
          : null,
        h('button', { class: 'btn primary', onclick: () => addMemberModal() }, '+ عضو جديد')
      )
    ),
    h('div', { class: 'toolbar' }, search, statusSel),
    list
  );
  await load();
}

async function addMemberModal() {
  const plans = await api('GET', '/api/plans');
  openModal(
    'عضو جديد',
    [
      field('الاسم', h('input', { name: 'name', required: true, maxlength: 100 })),
      field('كود العضو (أرقام فقط - اتركه فارغاً للتوليد التلقائي)', h('input', { name: 'code', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', placeholder: 'مثال: 1001 (تلقائي لو تُرك فارغاً)' })),
      h('div', { class: 'row' }, field('رقم الموبايل', h('input', { name: 'phone', type: 'tel', inputmode: 'tel', maxlength: 30, class: 'ltr' })), field('السن (اختياري)', h('input', { name: 'age', type: 'number', min: 5, max: 120, placeholder: 'مثال: 25' }))),
      field('الباقة (اختياري)', h('select', { name: 'plan_id' }, h('option', { value: '' }, 'بدون اشتراك دلوقتي'), planOptions(plans))),
      h('div', { class: 'row' }, field('تاريخ البداية', h('input', { name: 'start_date', type: 'date', value: todayLocal() })), field('السعر المدفوع (اختياري)', h('input', { name: 'price', type: 'number', min: 0, step: '0.01', placeholder: 'سعر الباقة' }))),
      field('ملاحظات', h('textarea', { name: 'notes', rows: 2, maxlength: 500 })),
    ],
    async (fd) => {
      const codeVal = fd.get('code')?.trim();
      const ageVal = fd.get('age')?.trim();
      const r = await api('POST', '/api/members', {
        name: fd.get('name'),
        code: codeVal || undefined,
        phone: fd.get('phone'),
        age: ageVal ? Number(ageVal) : null,
        notes: fd.get('notes'),
        plan_id: fd.get('plan_id') || null,
        start_date: fd.get('start_date'),
        price: fd.get('price'),
      });
      toast('تمت إضافة العضو');
      location.hash = `#/members/${r.id}`;
    },
    'إضافة'
  );
}

async function pageMember(id) {
  const d = await api('GET', `/api/members/${id}`);
  const m = d.member;
  const refresh = () => route();

  const infoLine = (k, v) => h('div', { class: 'info-line' }, `${k}: `, h('b', null, v));

  const subRows = d.subscriptions.length
    ? d.subscriptions.map((s) =>
        h(
          'tr',
          null,
          h('td', null, s.plan_name),
          h('td', null, ltr(s.start_date)),
          h('td', null, ltr(s.end_date)),
          h('td', null, fmtMoney(s.price)),
          h('td', null, s.status === 'cancelled' ? badge('cancelled', 'ملغي') : badge('active', 'مسجل')),
          h(
            'td',
            null,
            ME.role === 'admin' && s.status === 'active'
              ? h(
                  'button',
                  {
                    class: 'btn small danger',
                    onclick: async () => {
                      if (!confirm('إلغاء هذا الاشتراك؟')) return;
                      try {
                        await api('DELETE', `/api/subscriptions/${s.id}`);
                        toast('تم إلغاء الاشتراك');
                        refresh();
                      } catch (e) {
                        toast(e.message, true);
                      }
                    },
                  },
                  'إلغاء'
                )
              : null
          )
        )
      )
    : [h('tr', null, h('td', { class: 'empty', colspan: 6 }, 'لا توجد اشتراكات'))];

  const attRows = d.attendance.length
    ? d.attendance.map((a) =>
        h('tr', null, h('td', null, fmtDateTime(a.checkin_at)), h('td', null, badge(a.result, a.result === 'ok' ? 'دخول' : REASON_LABEL[a.reason] || 'مرفوض')))
      )
    : [h('tr', null, h('td', { class: 'empty', colspan: 2 }, 'لا يوجد حضور'))];

  const actions = h(
    'div',
    { class: 'actions', style: 'margin-top:12px' },
    h('button', { class: 'btn primary', onclick: () => renewModal(m, refresh) }, 'تجديد / اشتراك جديد'),
    ME.role === 'admin' && m.active && (m.sub.state === 'active' || m.sub.state === 'expiring')
      ? h('button', { class: 'btn', style: 'border-color:rgba(59,130,246,0.6);color:#93c5fd;font-weight:bold;', onclick: () => freezeModal(m, refresh) }, '❄️ تجميد الاشتراك')
      : null,
    h('button', { class: 'btn', onclick: () => editMemberModal(m, refresh) }, 'تعديل البيانات'),
    h('a', { class: 'btn', href: `/card.html?code=${encodeURIComponent(m.code)}`, target: '_blank', rel: 'noopener' }, 'طباعة الكارت'),
    h('button', { class: 'btn whatsapp', onclick: () => openWhatsAppModal(m) }, '💬 إرسال الكارت عبر واتساب'),
    ME.role === 'admin' &&
      h(
        'button',
        {
          class: 'btn danger',
          onclick: async () => {
            if (!confirm(`حذف العضو "${m.name}" نهائيًا مع كل اشتراكاته وحضوره؟`)) return;
            try {
              await api('DELETE', `/api/members/${m.id}`);
              toast('تم حذف العضو');
              location.hash = '#/members';
            } catch (e) {
              toast(e.message, true);
            }
          },
        },
        'حذف'
      )
  );

  // كارت اشتراك البرايفت (Personal Training) - بنظام المدة والعد التنازلي التلقائي
  const activePt = (d.privateTrainings || []).find((p) => p.state === 'active' || p.state === 'expiring' || p.state === 'upcoming');
  const latestPt = activePt || (d.privateTrainings || [])[0];
  let ptCard = null;

  if (latestPt) {
    const totalDays = latestPt.total_days || 30;
    const daysLeft = latestPt.days_left || 0;
    const elapsedDays = Math.max(0, Math.min(totalDays, totalDays - daysLeft));
    const percent = Math.min(100, Math.round((elapsedDays / totalDays) * 100));
    const balanceDue = Number(latestPt.price) - Number(latestPt.paid);

    let stateBadge = null;
    let countdownText = '';
    if (latestPt.state === 'active') {
      stateBadge = h('span', { class: 'badge ok' }, 'ساري');
      countdownText = `⏳ متبقي ${daysLeft} يوم على انتهاء البرايفت`;
    } else if (latestPt.state === 'expiring') {
      stateBadge = h('span', { class: 'badge warn' }, `ينتهي قريباً (${daysLeft} يوم)`);
      countdownText = `⚠️ ينتهي الاشتراك ${daysLeft === 0 ? 'النهارده!' : `خلال ${daysLeft} يوم`}`;
    } else if (latestPt.state === 'upcoming') {
      stateBadge = h('span', { class: 'badge info' }, 'لم يبدأ بعد');
      countdownText = `📅 يبدأ في ${ltr(latestPt.start_date)}`;
    } else {
      stateBadge = h('span', { class: 'badge bad' }, 'منتهي');
      countdownText = `❌ انتهى الاشتراك في ${ltr(latestPt.end_date)}`;
    }

    const editPtBtn = h(
      'button',
      {
        class: 'btn small',
        onclick: () => privateModal(latestPt, true, refresh),
      },
      'تعديل البرايفت'
    );

    const renewPtBtn = h(
      'button',
      {
        class: 'btn primary small',
        onclick: () => privateModal({ member_id: m.id, member_name: m.name }, false, refresh),
      },
      'تجديد البرايفت ➕'
    );

    ptCard = h(
      'div',
      { class: 'card card-pt', style: 'margin-bottom:20px;' },
      h(
        'div',
        { style: 'display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;' },
        h(
          'div',
          null,
          h(
            'div',
            { style: 'display:flex;align-items:center;gap:8px;margin-bottom:6px;' },
            h('span', { style: 'font-size:1.4rem;' }, '⭐'),
            h('h2', { style: 'margin:0;color:#4ade80;' }, 'اشتراك تدريب خاص (برايفت)'),
            stateBadge
          ),
          h(
            'p',
            { class: 'muted', style: 'margin:0;font-size:0.95rem;' },
            'الكابتن المسئول: ',
            h('b', { style: 'color:#fff;' }, latestPt.trainer_name),
            ' • الباقة: ',
            h('b', { style: 'color:#fff;' }, latestPt.package_name),
            ' • المدة: ',
            h('b', { style: 'color:#4ade80;' }, `${totalDays} يوم`)
          )
        ),
        h('div', { style: 'display:flex;gap:8px;align-items:center;' }, editPtBtn, renewPtBtn)
      ),
      h(
        'div',
        { style: 'margin:16px 0;' },
        h(
          'div',
          { style: 'display:flex;justify-content:space-between;font-size:0.92rem;font-weight:600;' },
          h('span', null, `من: ${ltr(latestPt.start_date)} ← ينتهي في: ${ltr(latestPt.end_date)}`),
          h('span', { style: latestPt.state === 'expired' ? 'color:#ef4444;' : 'color:#10b981;' }, countdownText)
        ),
        h(
          'div',
          { class: 'pt-progress-wrap' },
          h('div', {
            class: 'pt-progress-bar',
            style: `width:${percent}%;background:${latestPt.state === 'expired' ? '#ef4444' : (latestPt.state === 'expiring' ? '#f59e0b' : 'linear-gradient(90deg, #10b981 0%, #34d399 50%, #4ade80 100%)')};`
          })
        )
      ),
      h(
        'div',
        {
          style:
            'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-top:16px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.08);',
        },
        h(
          'div',
          { style: 'display:flex;gap:16px;font-size:0.95rem;' },
          h('span', null, 'السعر: ', h('b', null, fmtMoney(latestPt.price) + ' ج')),
          h('span', null, 'المدفوع: ', h('b', { style: 'color:#10b981;' }, fmtMoney(latestPt.paid) + ' ج')),
          balanceDue > 0
            ? h('span', { style: 'color:#ef4444;font-weight:bold;' }, `متبقي عليه: ${fmtMoney(balanceDue)} ج ⚠️`)
            : h('span', { style: 'color:#10b981;' }, 'خالص بالكامل ✅')
        ),
        latestPt.notes ? h('div', { class: 'muted', style: 'font-size:0.88rem;' }, `ملاحظات: ${latestPt.notes}`) : null
      )
    );
  } else {
    actions.appendChild(
      h(
        'button',
        {
          class: 'btn',
          style: 'border-color:rgba(34, 197, 94,0.6);color:#4ade80;font-weight:bold;',
          onclick: () => privateModal({ member_id: m.id, member_name: m.name }, false, refresh),
        },
        '⭐ اشتراك برايفت جديد'
      )
    );
  }

  app.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;' },
        backBtn('#/members', 'رجوع للأعضاء'),
        h('h1', { style: 'margin:0;' }, m.name),
        activePt ? h('span', { class: 'badge ok', style: 'background:linear-gradient(135deg, #4ade80 0%, #22c55e 100%);color:#0b0c10;font-weight:900;' }, '⭐ VIP Private') : null
      )
    ),
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'member-head' },
        h('div', { class: 'qr-box' }, h('div', { class: 'code mono' }, m.code), h('img', { src: `/api/members/${m.id}/qr.svg`, alt: 'باركود' })),
        h(
          'div',
          { class: 'member-info' },
          h('h1', null, m.name, ' ', m.active ? badge(m.sub.state) : badge('inactive', 'موقوف')),
          infoLine('الموبايل', m.phone || '-'),
          m.age ? infoLine('السن', `${m.age} سنة`) : null,
          infoLine('الباقة الحالية', m.sub.plan_name || '-'),
          infoLine('ينتهي في', m.sub.end_date ? `${ltr(m.sub.end_date)}${m.sub.days_left > 0 ? ` (باقي ${m.sub.days_left} يوم)` : ''}` : '-'),
          infoLine('عدد الزيارات', String(d.totalVisits)),
          m.notes && infoLine('ملاحظات', m.notes),
          actions
        )
      )
    ),
    ptCard || '',
    h(
      'div',
      { class: 'card' },
      h('h2', null, 'سجل الاشتراكات'),
      h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['الباقة', 'من', 'إلى', 'السعر', 'الحالة', ''].map((t) => h('th', null, t)))), h('tbody', null, subRows)))
    ),
    h('div', { class: 'card' }, h('h2', null, 'آخر حضور'), h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null, attRows))))
  );
}

async function freezeModal(m, done) {
  openModal(
    `❄️ تجميد اشتراك — ${m.name}`,
    [
      h('div', { class: 'muted', style: 'font-size:0.92rem;margin-bottom:14px;line-height:1.7;' },
        'تاريخ انتهاء الاشتراك الحالي: ',
        h('b', { style: 'color:#4ade80;' }, ltr(m.sub.end_date)),
        '. سيتم تمديد تاريخ الانتهاء تلقائياً بمقدار عدد أيام التجميد، وتسجيلها في سجل المشترك.'
      ),
      field('عدد أيام التجميد (بالأيام)', h('input', { name: 'days', type: 'number', min: 1, max: 365, value: 7, required: true })),
      field('سبب التجميد (اختياري)', h('input', { name: 'reason', type: 'text', placeholder: 'مثال: ظروف صحية، سفر، امتحانات...' })),
    ],
    async (fd) => {
      const days = parseInt(fd.get('days'), 10);
      const reason = fd.get('reason');
      const res = await api('POST', `/api/members/${m.id}/freeze`, { days, reason });
      toast(res.message || 'تم تجميد وتمديد الاشتراك بنجاح');
      done();
    },
    'تأكيد التجميد ❄️'
  );
}

async function renewModal(m, done) {
  const plans = await api('GET', '/api/plans');
  const hint = m.sub.end_date && m.sub.days_left > 0 ? `الاشتراك الجديد هيبدأ بعد انتهاء الحالي (${ltr(m.sub.end_date)}) لو سبت التاريخ فاضي.` : 'لو سبت التاريخ فاضي هيبدأ النهارده.';
  openModal(
    `تجديد اشتراك — ${m.name}`,
    [
      field('الباقة', h('select', { name: 'plan_id', required: true }, planOptions(plans))),
      h('div', { class: 'row' }, field('تاريخ البداية (اختياري)', h('input', { name: 'start_date', type: 'date' })), field('السعر المدفوع (اختياري)', h('input', { name: 'price', type: 'number', min: 0, step: '0.01', placeholder: 'سعر الباقة' }))),
      h('div', { class: 'muted', style: 'font-size:.9rem' }, hint),
    ],
    async (fd) => {
      await api('POST', `/api/members/${m.id}/subscriptions`, {
        plan_id: fd.get('plan_id'),
        start_date: fd.get('start_date'),
        price: fd.get('price'),
      });
      toast('تم تسجيل الاشتراك');
      done();
    },
    'تسجيل الاشتراك'
  );
}

function editMemberModal(m, done) {
  openModal(
    'تعديل بيانات العضو',
    [
      field('الاسم', h('input', { name: 'name', required: true, maxlength: 100, value: m.name })),
      field('كود العضو (أرقام فقط)', h('input', { name: 'code', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', value: m.code, required: true })),
      h('div', { class: 'row' }, field('رقم الموبايل', h('input', { name: 'phone', type: 'tel', maxlength: 30, class: 'ltr', value: m.phone })), field('السن (اختياري)', h('input', { name: 'age', type: 'number', min: 5, max: 120, value: m.age ?? '' }))),
      field('ملاحظات', h('textarea', { name: 'notes', rows: 2, maxlength: 500 }, m.notes)),
      h('div', { class: 'field' }, h('label', null, h('input', { type: 'checkbox', name: 'active', style: 'width:auto;margin-inline-end:8px', checked: m.active }), 'العضوية فعّالة (لو مش فعّالة الدخول بيترفض)')),
    ],
    async (fd) => {
      const ageVal = fd.get('age')?.trim();
      await api('PUT', `/api/members/${m.id}`, {
        name: fd.get('name'),
        code: fd.get('code')?.trim(),
        phone: fd.get('phone'),
        age: ageVal ? Number(ageVal) : null,
        notes: fd.get('notes'),
        active: fd.get('active') === 'on',
      });
      toast('تم الحفظ');
      done();
    }
  );
}

function openWhatsAppModal(m) {
  const planInfo = m.sub && m.sub.plan_name ? m.sub.plan_name : 'عضوية عامة';
  const endDate = m.sub && m.sub.end_date ? m.sub.end_date : 'غير محدد';
  const gym = ME.gymName || 'Hulk GYM';

  // رسالة الواتساب بدون رابط لوكال هوست إطلاقاً، ومجهزة لإرسال صورة الكارت
  const defaultMsg = `مرحباً بك يا ${m.name} في ${gym} 

تم تسجيل عضويتك بنجاح! تفاصيل الاشتراك:
 كود العضوية: ${m.code}
 نوع الباقة: ${planInfo}
 تاريخ انتهاء الاشتراك: ${endDate}

 مرفق صورة كارت العضوية والبار كود الخاص بك للدخول 
(يرجى حفظ صورة الكارت على هاتفك، وإبراز البار كود عند مكتب الاستقبال لتسجيل حضورك في كل تمرين)
`;

  const phoneInput = h('input', { type: 'tel', value: m.phone || '', placeholder: 'مثال: 01012345678', class: 'ltr' });
  const msgBox = h('textarea', { rows: 7, style: 'font-size:0.85rem;resize:vertical' }, defaultMsg);

  let cachedBlob = null;
  const previewImg = h('img', {
    alt: `كارت عضوية ${m.name}`,
    style: 'max-width:100%;height:auto;border-radius:10px;box-shadow:0 3px 10px rgba(0,0,0,0.12);display:none;border:1px solid #e2e8f0;margin:0 auto;'
  });
  const loadingStatus = h('div', { class: 'muted', style: 'padding:14px;text-align:center;font-size:0.9rem' }, '⏳ جاري توليد صورة الكارت عالية الدقة...');

  // توليد صورة الكارت في الخلفية فور فتح المودال
  renderMemberCardToBlob(m, gym).then((blob) => {
    cachedBlob = blob;
    previewImg.src = URL.createObjectURL(blob);
    previewImg.style.display = 'block';
    loadingStatus.style.display = 'none';
  }).catch((err) => {
    console.error(err);
    loadingStatus.textContent = 'تعذر تجهيز معاينة الصورة: ' + err.message;
  });

  const previewBox = h('div', {
    style: 'background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin-bottom:12px;text-align:center;'
  },
    h('div', { style: 'font-weight:700;margin-bottom:8px;font-size:0.9rem;color:var(--brand-dark)' }, '🖼️ صورة كارت العضوية الرقمي:'),
    loadingStatus,
    previewImg,
    h('div', { style: 'font-size:0.8rem;color:#16a34a;font-weight:600;margin-top:8px' }, '💡 سيتم نسخ هذه الصورة تلقائياً للحافظة لتلصقها في واتساب (Ctrl+V)')
  );

  const canShare = !!(navigator.canShare && window.File);

  openModal(
    'إرسال صورة كارت العضوية عبر واتساب',
    [
      previewBox,
      field('رقم موبايل العضو', phoneInput),
      field('نص الرسالة المصاحبة للكارت', msgBox),
      h(
        'div',
        { class: 'actions', style: 'margin-top:10px;flex-wrap:wrap;gap:8px' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn',
            onclick: async () => {
              if (!cachedBlob) {
                toast('جاري تجهيز الصورة، انتظر ثانية...', true);
                cachedBlob = await renderMemberCardToBlob(m, gym);
              }
              const copied = await copyCardImageToClipboard(cachedBlob);
              if (copied) {
                toast('✅ تم نسخ صورة الكارت! اضغط Ctrl+V في واتساب');
              } else {
                downloadCardBlob(cachedBlob, `card-${m.code}.png`);
                toast('تم تحميل صورة الكارت لجهازك 💾');
              }
            },
          },
          '📋 نسخ صورة الكارت (Ctrl+V)'
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'btn',
            onclick: async () => {
              if (!cachedBlob) cachedBlob = await renderMemberCardToBlob(m, gym);
              downloadCardBlob(cachedBlob, `card-${m.code}.png`);
              toast('تم تحميل صورة الكارت 💾');
            },
          },
          '💾 حفظ الصورة (PNG)'
        ),
        canShare && h(
          'button',
          {
            type: 'button',
            class: 'btn',
            onclick: async () => {
              if (!cachedBlob) cachedBlob = await renderMemberCardToBlob(m, gym);
              const file = new File([cachedBlob], `card-${m.code}.png`, { type: 'image/png' });
              if (navigator.canShare({ files: [file] })) {
                await navigator.share({
                  title: `كارت عضوية ${m.name}`,
                  text: msgBox.value,
                  files: [file],
                });
              }
            },
          },
          '📤 مشاركة الصورة'
        ),
        h(
          'a',
          {
            class: 'btn',
            href: `/card.html?code=${encodeURIComponent(m.code)}`,
            target: '_blank',
            rel: 'noopener',
          },
          '🖨️ صفحة الكارت والطباعة'
        )
      ),
    ],
    async () => {
      const p = formatWhatsAppPhone(phoneInput.value);
      if (!p) throw new Error('يرجى إدخال رقم موبايل صحيح للعضو');

      // 1. نسخ صورة الكارت للحافظة
      if (!cachedBlob) {
        cachedBlob = await renderMemberCardToBlob(m, gym);
      }
      if (cachedBlob) {
        await copyCardImageToClipboard(cachedBlob);
        // حفظ نسخة في مجلد التنزيلات
        downloadCardBlob(cachedBlob, `card-${m.code}.png`);
      }

      // 2. فتح واتساب بالرسالة
      const waUrl = `https://wa.me/${p}?text=${encodeURIComponent(msgBox.value)}`;
      window.open(waUrl, '_blank', 'noopener,noreferrer');
      toast('✅ تم نسخ صورة الكارنيه للحافظة! اضغط Ctrl + V (لصق) في واتساب لإرسال الصورة فوراً 🖼️');
    },
    '💬 فتح واتساب وإرسال صورة الكارت'
  );
}

function shiftDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function manualAttendanceModal(done) {
  const members = await api('GET', '/api/members?status=all');
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const dayStr = todayLocal();

  const memberSelect = h(
    'select',
    { name: 'member_id', required: true },
    h('option', { value: '' }, '-- اختر العضو --'),
    ...members.map((m) =>
      h('option', { value: m.id }, `${m.code} — ${m.name} ${m.phone ? '(' + m.phone + ')' : ''}`)
    )
  );

  const dateInput = h('input', { name: 'date', type: 'date', value: dayStr, required: true });
  const timeInput = h('input', { name: 'time', type: 'time', value: timeStr, required: true });

  openModal(
    'تسجيل حضور يدوي (لتاريخ سابق أو اليوم)',
    [
      field('العضو', memberSelect),
      h('div', { class: 'row' }, field('تاريخ الحضور (اليوم أو يوم سابق)', dateInput), field('وقت الحضور', timeInput)),
      h(
        'div',
        { class: 'muted', style: 'font-size:.85rem;margin-top:6px' },
        '💡 يمكنك اختيار أي يوم سابق لتسجيل حضور العضو فيه في حال لم يتم المسح في ذلك اليوم.'
      ),
    ],
    async (fd) => {
      const memberId = fd.get('member_id');
      if (!memberId) throw new Error('يرجى اختيار العضو');
      await api('POST', '/api/attendance/manual', {
        member_id: memberId,
        date: fd.get('date'),
        time: fd.get('time'),
      });
      toast('تم تسجيل الحضور بنجاح');
      done();
    },
    'تسجيل الحضور'
  );
}

// ---------- الحضور ----------
async function pageAttendance() {
  const today = todayLocal();
  let from = today;
  let to = today;
  let activePreset = 'today';
  let q = '';
  let resultFilter = 'all';

  const box = h('div', { class: 'card table-wrap' });
  const statsBox = h('div', { class: 'att-stats' });

  const fromInput = h('input', { type: 'date', value: from, style: 'max-width:160px' });
  const toInput = h('input', { type: 'date', value: to, style: 'max-width:160px' });
  const searchInput = h('input', { type: 'search', placeholder: 'ابحث بالاسم أو كود العضو أو الموبايل...', style: 'min-width:240px;flex:1' });
  const resSelect = h(
    'select',
    { style: 'max-width:160px' },
    h('option', { value: 'all' }, 'الكل (دخول ومرفوض)'),
    h('option', { value: 'ok' }, 'دخول مقبول فقط'),
    h('option', { value: 'denied' }, 'محاولات مرفوضة فقط')
  );

  const presetContainer = h('div', { class: 'preset-bar' });

  function setPreset(p) {
    activePreset = p;
    if (p === 'today') {
      from = today;
      to = today;
    } else if (p === 'yesterday') {
      const y = shiftDays(today, -1);
      from = y;
      to = y;
    } else if (p === 'week') {
      from = shiftDays(today, -6);
      to = today;
    } else if (p === 'month') {
      from = today.slice(0, 7) + '-01';
      to = today;
    } else if (p === 'all') {
      from = '2024-01-01';
      to = today;
    }
    fromInput.value = from;
    toInput.value = to;
    renderPresets();
    load().catch((e) => toast(e.message, true));
  }

  function renderPresets() {
    const list = [
      ['today', 'اليوم'],
      ['yesterday', 'أمس'],
      ['week', 'آخر 7 أيام'],
      ['month', 'هذا الشهر'],
      ['all', 'كل السجل'],
    ];
    presetContainer.replaceChildren(
      ...list.map(([id, label]) =>
        h(
          'button',
          {
            type: 'button',
            class: `preset-btn ${activePreset === id ? 'active' : ''}`,
            onclick: () => setPreset(id),
          },
          label
        )
      )
    );
  }

  async function load() {
    let url = `/api/attendance?from=${from}&to=${to}&result=${resultFilter}`;
    if (q) url += `&q=${encodeURIComponent(q)}`;

    const rows = await api('GET', url);
    const okCount = rows.filter((r) => r.result === 'ok').length;
    const deniedCount = rows.length - okCount;
    const uniqueMembers = new Set(rows.map((r) => r.member_id)).size;

    statsBox.replaceChildren(
      h('div', { class: 'att-stat-item' }, 'إجمالي الحركات: ', h('b', null, String(rows.length))),
      h('div', { class: 'att-stat-item' }, 'حضور مقبول: ', h('b', { style: 'color:#15803d' }, String(okCount))),
      h('div', { class: 'att-stat-item' }, 'محاولات مرفوضة: ', h('b', { style: 'color:#b91c1c' }, String(deniedCount))),
      h('div', { class: 'att-stat-item' }, 'أعضاء فريدين: ', h('b', null, String(uniqueMembers)))
    );

    box.replaceChildren(
      rows.length
        ? h(
            'table',
            null,
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                ['اليوم والتاريخ', 'الوقت', 'كود العضو', 'اسم العضو', 'الموبايل', 'النتيجة / السبب', ME.role === 'admin' ? 'إجراء' : null]
                  .filter(Boolean)
                  .map((t) => h('th', null, t))
              )
            ),
            h(
              'tbody',
              null,
              rows.map((a) =>
                h(
                  'tr',
                  null,
                  h('td', null, fmtDayArabic(a.day)),
                  h('td', null, fmtTime(a.checkin_at)),
                  h('td', { class: 'mono' }, a.code || '-'),
                  h(
                    'td',
                    { class: 'clickable', onclick: () => (location.hash = `#/members/${a.member_id}`) },
                    h('b', { style: 'color:var(--brand-dark)' }, a.name)
                  ),
                  h('td', { class: 'ltr' }, a.phone || '-'),
                  h('td', null, badge(a.result, a.result === 'ok' ? (a.reason === 'manual' ? 'تسجيل يدوي' : 'دخول') : REASON_LABEL[a.reason] || 'مرفوض')),
                  ME.role === 'admin' &&
                    h(
                      'td',
                      null,
                      h(
                        'button',
                        {
                          class: 'btn danger',
                          style: 'padding:3px 8px;font-size:0.75rem',
                          title: 'حذف هذه الحركة',
                          onclick: async () => {
                            if (!confirm(`هل أنت متأكد من حذف حركة حضور ${a.name} بتاريخ ${a.day}؟`)) return;
                            try {
                              await api('DELETE', `/api/attendance/${a.id}`);
                              toast('تم حذف حركة الحضور');
                              load();
                            } catch (e) {
                              toast(e.message, true);
                            }
                          },
                        },
                        'حذف'
                      )
                    )
                )
              )
            )
          )
        : h('div', { class: 'empty' }, 'لا توجد حركات حضور مسجلة في هذه الفترة')
    );
  }

  fromInput.addEventListener('change', () => {
    from = fromInput.value;
    activePreset = 'custom';
    renderPresets();
    load().catch((e) => toast(e.message, true));
  });

  toInput.addEventListener('change', () => {
    to = toInput.value;
    activePreset = 'custom';
    renderPresets();
    load().catch((e) => toast(e.message, true));
  });

  resSelect.addEventListener('change', () => {
    resultFilter = resSelect.value;
    load().catch((e) => toast(e.message, true));
  });

  let searchTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      q = searchInput.value.trim();
      load().catch((e) => toast(e.message, true));
    }, 250);
  });

  const prevDayBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn',
      title: 'اليوم السابق',
      onclick: () => {
        from = shiftDays(from, -1);
        to = from;
        fromInput.value = from;
        toInput.value = to;
        activePreset = 'custom';
        renderPresets();
        load().catch((e) => toast(e.message, true));
      },
    },
    '◀ يوم سابق'
  );

  const nextDayBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn',
      title: 'اليوم التالي',
      onclick: () => {
        from = shiftDays(from, 1);
        to = from;
        fromInput.value = from;
        toInput.value = to;
        activePreset = 'custom';
        renderPresets();
        load().catch((e) => toast(e.message, true));
      },
    },
    'يوم لاحق ▶'
  );

  renderPresets();

  app.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;' },
        backBtn('#/', 'الرئيسية'),
        h('h1', { style: 'margin:0;' }, 'سجل الحضور')
      ),
      h('button', { class: 'btn primary', onclick: () => manualAttendanceModal(load) }, '+ تسجيل حضور يدوي')
    ),
    presetContainer,
    h(
      'div',
      { class: 'toolbar', style: 'align-items:center;margin-bottom:12px' },
      prevDayBtn,
      h('div', { class: 'date-nav' }, h('span', { class: 'muted' }, 'من:'), fromInput, h('span', { class: 'muted' }, 'إلى:'), toInput),
      nextDayBtn,
      resSelect
    ),
    h('div', { class: 'toolbar' }, searchInput),
    statsBox,
    box
  );

  await load();
}

// ---------- التقرير اليومي وتقفيل الوردية (للمدير) ----------
async function pageDailyReport(query) {
  if (ME.role !== 'admin') {
    app.replaceChildren(h('div', { class: 'alert bad' }, 'الصفحة دي للمدير فقط'));
    return;
  }

  const params = new URLSearchParams(query);
  const today = todayLocal();
  let selectedDate = params.get('date') || today;
  let q = '';
  let typeFilter = 'all'; // all, new, renew
  let reportData = null;

  // عناصر الرأس وشريط التنقل بين الأيام
  const dateDisplay = h('span', { class: 'muted', style: 'font-weight:700;font-size:1.05rem' });
  const dateInput = h('input', {
    type: 'date',
    value: selectedDate,
    style: 'max-width:160px;font-weight:700',
    onchange: (e) => {
      if (e.target.value) setDay(e.target.value);
    },
  });

  const presetContainer = h('div', { class: 'preset-bar no-print' });
  const summaryBox = h('div', { class: 'tiles' });
  const tableWrap = h('div', { class: 'card table-wrap' });
  const dailyExpensesCard = h('div', { class: 'card', style: 'margin-top:18px' });
  const historyCard = h('div', { class: 'card no-print', style: 'margin-top:22px' });

  // حقول التصفية والبحث في جدول اليوم
  const searchInput = h('input', {
    type: 'search',
    placeholder: 'ابحث في حركات اليوم بالاسم، كود العضو، الموبايل، أو الباقة...',
    style: 'min-width:250px;flex:2',
    oninput: (e) => {
      q = e.target.value.trim().toLowerCase();
      renderTable();
    },
  });

  const typeSelect = h(
    'select',
    {
      style: 'max-width:200px;flex:1',
      onchange: (e) => {
        typeFilter = e.target.value;
        renderTable();
      },
    },
    h('option', { value: 'all' }, 'الكل (اشتراكات وتجديدات)'),
    h('option', { value: 'new' }, '🟢 اشتراكات جديدة فقط'),
    h('option', { value: 'renew' }, '🔄 تجديدات فقط')
  );

  function setDay(day) {
    selectedDate = day;
    dateInput.value = day;
    try {
      history.replaceState(null, '', `#/daily-report?date=${day}`);
    } catch {
      /* ignore */
    }
    load(day).catch((e) => toast(e.message, true));
  }

  function renderPresets() {
    const isToday = selectedDate === today;
    const yesterday = shiftDays(today, -1);
    const isYesterday = selectedDate === yesterday;

    presetContainer.replaceChildren(
      h(
        'button',
        {
          type: 'button',
          class: `preset-btn ${isToday ? 'active' : ''}`,
          onclick: () => setDay(today),
        },
        '📅 اليوم'
      ),
      h(
        'button',
        {
          type: 'button',
          class: `preset-btn ${isYesterday ? 'active' : ''}`,
          onclick: () => setDay(yesterday),
        },
        '⏪ أمس'
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'preset-btn',
          title: 'اليوم السابق',
          onclick: () => setDay(shiftDays(selectedDate, -1)),
        },
        '◀ اليوم السابق'
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'preset-btn',
          title: 'اليوم التالي',
          onclick: () => setDay(shiftDays(selectedDate, 1)),
        },
        'اليوم التالي ▶'
      )
    );
  }

  function renderSummary() {
    if (!reportData) return;
    const tile = (cls, num, lbl) =>
      h('div', { class: `tile ${cls}` }, h('div', { class: 'num' }, num), h('div', { class: 'lbl' }, lbl));

    summaryBox.replaceChildren(
      tile('gold', `${fmtMoney(reportData.totalRevenue)} ج.م`, '💰 إجمالي إيراد اليوم (خزينة الوردية)'),
      tile('warn', `${fmtMoney(reportData.totalExpenses || 0)} ج.م`, `💸 مصروفات اليوم (${reportData.expenseCount || 0})`),
      tile((reportData.netRevenue || 0) >= 0 ? 'ok' : 'bad', `${fmtMoney(reportData.netRevenue ?? reportData.totalRevenue)} ج.م`, '✅ صافي الوردية (الإيراد - المصروفات)'),
      tile('info', reportData.totalCount, '🧾 إجمالي حركات الاشتراك'),
      tile('ok', `${reportData.newCount} (${fmtMoney(reportData.newRevenue)} ج.م)`, '🟢 اشتراكات جديدة'),
      tile('', `${reportData.renewCount} (${fmtMoney(reportData.renewRevenue)} ج.م)`, '🔄 تجديد اشتراك'),
      tile('info', `${reportData.attendanceCount} زيارة`, '🏋️‍♂️ حضور الأعضاء اليوم')
    );
  }

  function renderDailyExpenses() {
    if (!reportData) return;
    const exRows = reportData.expensesList || [];
    const tbody = h('tbody');
    if (!exRows.length) {
      tbody.append(h('tr', null, h('td', { class: 'empty', colspan: 6 }, 'لا توجد مصروفات مسجلة في هذا اليوم')));
    } else {
      exRows.forEach((ex, i) => {
        tbody.append(
          h(
            'tr',
            null,
            h('td', { class: 'muted mono' }, String(i + 1)),
            h('td', { class: 'ltr muted' }, ex.time || '-'),
            h('td', { style: 'font-weight:700' }, ex.title),
            h('td', null, badge('warn', ex.category)),
            h('td', { style: 'font-weight:800;color:#f59e0b' }, `${fmtMoney(ex.amount)} ج.م`),
            h('td', null, ex.recorded_by === 'admin' ? 'مدير' : 'استقبال')
          )
        );
      });
    }
    dailyExpensesCard.replaceChildren(
      h(
        'div',
        { style: 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px' },
        h('h2', { style: 'margin:0;' }, '💸 مصروفات اليوم (تُخصم من إيراد الوردية)'),
        h('a', { href: '#/expenses', class: 'btn small no-print' }, '+ تسجيل مصروف')
      ),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          null,
          h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'الوقت'), h('th', null, 'البند'), h('th', null, 'التصنيف'), h('th', null, 'المبلغ'), h('th', null, 'بواسطة'))),
          tbody,
          exRows.length
            ? h('tfoot', null, h('tr', { style: 'background:rgba(255,255,255,0.03);font-weight:900;' }, h('td', { colspan: 4, style: 'text-align:left;padding-left:16px;' }, 'إجمالي مصروفات اليوم:'), h('td', { colspan: 2, style: 'color:#f59e0b;font-size:1.1rem;' }, `${fmtMoney(reportData.totalExpenses || 0)} ج.م`)))
            : null
        )
      )
    );
  }

  function renderTable() {
    if (!reportData) return;
    const rows = (reportData.list || []).filter((r) => {
      if (typeFilter === 'new' && r.type !== 'new') return false;
      if (typeFilter === 'renew' && r.type !== 'renew') return false;
      if (q) {
        const text = `${r.member_name} ${r.member_code} ${r.member_phone} ${r.plan_name}`.toLowerCase();
        if (!text.includes(q)) return false;
      }
      return true;
    });

    const totalFilteredCash = rows.reduce((acc, r) => (r.status !== 'cancelled' ? acc + (Number(r.price) || 0) : acc), 0);

    const tbody = h('tbody');
    if (!rows.length) {
      tbody.append(
        h(
          'tr',
          null,
          h(
            'td',
            { class: 'empty', colspan: 10 },
            reportData.list.length === 0
              ? 'مفيش أي اشتراكات أو تجديدات مسجلة في هذا اليوم.'
              : 'لا توجد نتائج مطابقة للبحث أو التصفية.'
          )
        )
      );
    } else {
      rows.forEach((r, idx) => {
        const isCancelled = r.status === 'cancelled';
        const typeBadge =
          r.type === 'new'
            ? h('span', { class: 'badge sub-new' }, '🟢 جديد')
            : h('span', { class: 'badge sub-renew' }, '🔄 تجديد');

        const statusBadge = isCancelled
          ? h('span', { class: 'badge sub-cancelled' }, 'ملغي')
          : h('span', { class: 'badge active' }, 'ساري');

        const tr = h(
          'tr',
          {
            style: isCancelled ? 'opacity:0.6;' : '',
          },
          h('td', { class: 'muted' }, String(idx + 1)),
          h('td', null, r.time || '-'),
          h('td', { class: 'mono', style: 'font-weight:bold;color:#4ade80' }, r.member_code),
          h(
            'td',
            null,
            h(
              'a',
              {
                href: `#/members/${r.member_id}`,
                style: 'font-weight:700;color:#fff;',
                title: 'فتح ملف العضو',
              },
              r.member_name
            )
          ),
          h(
            'td',
            { class: 'ltr' },
            r.member_phone
              ? h(
                  'a',
                  {
                    href: `https://wa.me/${formatWhatsAppPhone(r.member_phone)}`,
                    target: '_blank',
                    rel: 'noopener',
                    style: 'color:#cbd5e1;font-size:0.9rem',
                    title: 'مراسلة عبر واتساب',
                  },
                  r.member_phone
                )
              : '-'
          ),
          h('td', null, typeBadge),
          h('td', { style: 'font-weight:600' }, r.plan_name),
          h('td', { class: 'muted', style: 'font-size:0.85rem' }, `${ltr(r.start_date)} إلى ${ltr(r.end_date)}`),
          h(
            'td',
            { style: 'font-weight:800;color:#4ade80;font-size:1.05rem' },
            `${fmtMoney(r.price)} ج.م`
          ),
          h('td', null, statusBadge)
        );
        tbody.append(tr);
      });
    }

    const tfoot = h(
      'tfoot',
      null,
      h(
        'tr',
        { style: 'background:#181c28;border-top:2px solid var(--brand);font-weight:800;font-size:1rem;' },
        h('td', { colspan: 5, style: 'color:#fff;' }, `عدد العمليات المعروضة: ${rows.length}`),
        h('td', { colspan: 3, style: 'text-align:end;color:#cbd5e1;' }, 'إجمالي المبلغ المعروض:'),
        h('td', { colspan: 2, style: 'color:#4ade80;font-size:1.15rem;' }, `${fmtMoney(totalFilteredCash)} ج.م`)
      )
    );

    tableWrap.replaceChildren(
      h(
        'table',
        null,
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', { style: 'width:40px' }, '#'),
            h('th', null, 'الوقت'),
            h('th', null, 'كود العضو'),
            h('th', null, 'اسم المشترك'),
            h('th', null, 'رقم الموبايل'),
            h('th', null, 'نوع الحركة'),
            h('th', null, 'الباقة'),
            h('th', null, 'المدة'),
            h('th', null, 'المبلغ المدفوع'),
            h('th', null, 'الحالة')
          )
        ),
        tbody,
        tfoot
      )
    );
  }

  function renderHistory() {
    if (!reportData || !reportData.recentHistory) return;
    const items = reportData.recentHistory.map((item) => {
      const isSel = item.date === selectedDate;
      const isTd = item.date === today;
      const dObj = new Date(item.date + 'T00:00:00Z');
      const dayName = dObj.toLocaleDateString('ar-EG', { weekday: 'short', timeZone: 'UTC' });
      const dateDisplayStr = item.date.slice(5); // MM-DD

      return h(
        'div',
        {
          class: `history-item ${isSel ? 'active' : ''}`,
          onclick: () => setDay(item.date),
          title: `عرض تقرير ${item.date}`,
        },
        h('div', { class: 'd-title' }, isTd ? 'اليوم' : `${dayName} (${dateDisplayStr})`),
        h('div', { class: 'd-rev' }, `${fmtMoney(item.revenue)} ج.م`),
        h('div', { class: 'd-cnt' }, `${item.count} اشتراك`)
      );
    });

    historyCard.replaceChildren(
      h(
        'div',
        { style: 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:6px' },
        h('h2', { style: 'margin:0;' }, '🗓️ سجل تقفيل الوردية للأيام السابقة (آخر أسبوعين)'),
        h('span', { class: 'muted', style: 'font-size:0.85rem' }, 'اضغط على أي يوم لعرض اشتراكاته وإيراده بالكامل')
      ),
      h('div', { class: 'history-grid' }, ...items)
    );
  }

  async function load(day) {
    reportData = await api('GET', `/api/reports/daily?date=${encodeURIComponent(day)}`);
    const dateFormatted = fmtDayArabic(day);
    dateDisplay.textContent = dateFormatted;
    renderPresets();
    renderSummary();
    renderTable();
    renderDailyExpenses();
    renderHistory();
  }

  // ورقة مطبوعة لتقفيل الوردية (تظهر فقط عند الطباعة)
  const printHeader = h(
    'div',
    { class: 'print-only', style: 'margin-bottom:20px;text-align:center;border-bottom:2px solid #000;padding-bottom:12px' },
    h('h1', { style: 'margin:0 0 6px 0;font-size:1.8rem;color:#000' }, `${ME.gymName || 'Hulk GYM'} — تقرير إيراد الوردية اليومي`),
    h('div', { style: 'font-size:1.1rem;font-weight:bold;color:#333' }, `تاريخ اليوم: ${selectedDate} (${fmtDayArabic(selectedDate)})`),
    h('div', { style: 'font-size:0.9rem;color:#666;margin-top:4px' }, `وقت استخراج التقرير: ${new Date().toLocaleString('ar-EG', { timeZone: TZ })}`)
  );

  const printSignatures = h(
    'div',
    { class: 'print-only-flex', style: 'justify-content:space-between;margin-top:40px;padding-top:20px;border-top:1px dashed #444;font-size:1rem;color:#000' },
    h('div', null, h('b', null, 'مسؤول الوردية (الاستقبال):'), ' ................................'),
    h('div', null, h('b', null, 'المشرف / الإدارة:'), ' ................................'),
    h('div', null, h('b', null, 'الخزينة المستلمة:'), ' ................................ ج.م')
  );

  app.replaceChildren(
    printHeader,
    h(
      'div',
      { class: 'page-head no-print' },
      h(
        'div',
        null,
        h(
          'div',
          { style: 'display:flex;align-items:center;gap:12px;margin-bottom:4px;flex-wrap:wrap;' },
          backBtn('#/', 'الرئيسية'),
          h('h1', { style: 'display:flex;align-items:center;gap:10px;margin:0;' }, '📊 التقرير اليومي للوردية')
        ),
        h('div', { class: 'muted', style: 'font-size:0.95rem;margin-top:2px' }, 'متابعة كافة الاشتراكات والتجديدات اليومية ومطابقة إيراد الخزينة')
      ),
      h(
        'div',
        { class: 'actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn primary',
            onclick: () => window.print(),
          },
          '🖨️ طباعة تقرير الوردية'
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'btn',
            onclick: () => setDay(selectedDate),
          },
          '🔄 تحديث'
        )
      )
    ),
    h(
      'div',
      { class: 'card no-print', style: 'padding:14px 18px;margin-bottom:16px;' },
      h(
        'div',
        { style: 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px' },
        h('div', { class: 'date-nav' }, h('span', { style: 'font-weight:700' }, 'تاريخ الوردية:'), dateInput, dateDisplay),
        presetContainer
      )
    ),
    summaryBox,
    h(
      'div',
      { class: 'toolbar no-print', style: 'margin-top:20px;margin-bottom:12px' },
      searchInput,
      typeSelect
    ),
    tableWrap,
    dailyExpensesCard,
    printSignatures,
    historyCard
  );

  await load(selectedDate);
}

// ---------- التقفيل الشهري للإيرادات (للمدير) ----------
function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function fmtMonthArabic(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleDateString('ar-EG', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

async function pageMonthlyReport(query) {
  if (ME.role !== 'admin') {
    app.replaceChildren(h('div', { class: 'alert bad' }, 'الصفحة دي للمدير فقط'));
    return;
  }

  const params = new URLSearchParams(query);
  const currentMonth = todayLocal().slice(0, 7);
  let selectedMonth = params.get('month') || currentMonth;
  let q = '';
  let typeFilter = 'all'; // all, new, renew, pt
  let reportData = null;

  const monthDisplay = h('span', { class: 'muted', style: 'font-weight:700;font-size:1.05rem' });
  const printMonthLabel = h('div', { style: 'font-size:1.1rem;font-weight:bold;color:#333' });
  const monthInput = h('input', {
    type: 'month',
    value: selectedMonth,
    style: 'max-width:170px;font-weight:700',
    onchange: (e) => {
      if (e.target.value) setMonth(e.target.value);
    },
  });

  const presetContainer = h('div', { class: 'preset-bar no-print' });
  const summaryBox = h('div', { class: 'tiles' });
  const breakdownGrid = h('div', { class: 'grid-2', style: 'margin-top:20px' });
  const tableWrap = h('div', { class: 'card table-wrap' });
  const monthlyExpensesCard = h('div', { class: 'card', style: 'margin-top:20px' });
  const historyCard = h('div', { class: 'card no-print', style: 'margin-top:22px' });

  const searchInput = h('input', {
    type: 'search',
    placeholder: 'ابحث في حركات الشهر بالاسم، كود العضو، الموبايل، أو الباقة...',
    style: 'min-width:250px;flex:2',
    oninput: (e) => {
      q = e.target.value.trim().toLowerCase();
      renderTable();
    },
  });

  const typeSelect = h(
    'select',
    {
      style: 'max-width:220px;flex:1',
      onchange: (e) => {
        typeFilter = e.target.value;
        renderTable();
      },
    },
    h('option', { value: 'all' }, 'الكل (اشتراكات + برايفت)'),
    h('option', { value: 'new' }, '🟢 اشتراكات جديدة فقط'),
    h('option', { value: 'renew' }, '🔄 تجديدات فقط'),
    h('option', { value: 'pt' }, '⭐ برايفت (PT) فقط')
  );

  function setMonth(ym) {
    selectedMonth = ym;
    monthInput.value = ym;
    try {
      history.replaceState(null, '', `#/monthly-report?month=${ym}`);
    } catch {
      /* ignore */
    }
    load(ym).catch((e) => toast(e.message, true));
  }

  function renderPresets() {
    const prevMonth = shiftMonth(currentMonth, -1);
    presetContainer.replaceChildren(
      h(
        'button',
        { type: 'button', class: `preset-btn ${selectedMonth === currentMonth ? 'active' : ''}`, onclick: () => setMonth(currentMonth) },
        '📅 الشهر الحالي'
      ),
      h(
        'button',
        { type: 'button', class: `preset-btn ${selectedMonth === prevMonth ? 'active' : ''}`, onclick: () => setMonth(prevMonth) },
        '⏪ الشهر السابق'
      ),
      h(
        'button',
        { type: 'button', class: 'preset-btn', onclick: () => setMonth(shiftMonth(selectedMonth, -1)) },
        '◀ السابق'
      ),
      h(
        'button',
        { type: 'button', class: 'preset-btn', onclick: () => setMonth(shiftMonth(selectedMonth, 1)) },
        'التالي ▶'
      )
    );
  }

  function renderSummary() {
    if (!reportData) return;
    const tile = (cls, num, lbl) =>
      h('div', { class: `tile ${cls}` }, h('div', { class: 'num' }, num), h('div', { class: 'lbl' }, lbl));

    summaryBox.replaceChildren(
      tile('gold', `${fmtMoney(reportData.totalRevenue)} ج.م`, '💰 إجمالي إيراد الشهر'),
      tile('warn', `${fmtMoney(reportData.totalExpenses || 0)} ج.م`, `💸 إجمالي مصروفات الشهر (${reportData.expenseCount || 0})`),
      tile((reportData.netAfterExpenses || 0) >= 0 ? 'ok' : 'bad', `${fmtMoney(reportData.netAfterExpenses ?? reportData.totalRevenue)} ج.م`, '✅ صافي الإيراد (الإيراد - المصروفات)'),
      tile('info', `${fmtMoney(reportData.subRevenue)} ج.م`, `🧾 الاشتراكات (${reportData.subCount})`),
      tile('ok', `${reportData.newCount} (${fmtMoney(reportData.newRevenue)} ج.م)`, '🟢 اشتراكات جديدة'),
      tile('', `${reportData.renewCount} (${fmtMoney(reportData.renewRevenue)} ج.م)`, '🔄 تجديد اشتراك'),
      tile('info', `${reportData.ptCount} (${fmtMoney(reportData.ptRevenue)} ج.م)`, '⭐ إيراد البرايفت (PT)'),
      tile('warn', `${fmtMoney(reportData.totalSalaries)} ج.م`, `👔 رواتب الموظفين (${reportData.employeeCount})`),
      tile(reportData.netAfterSalaries >= 0 ? 'ok' : 'bad', `${fmtMoney(reportData.netAfterSalaries)} ج.م`, '📈 الصافي النهائي (بعد المصروفات والرواتب)'),
      tile('', `${reportData.attendanceCount} زيارة`, '🏋️‍♂️ إجمالي حضور الشهر')
    );
  }

  function renderBreakdowns() {
    if (!reportData) return;
    const planRows = (reportData.planBreakdown || []).length
      ? reportData.planBreakdown.map((p) =>
          h('tr', null, h('td', null, p.name), h('td', null, p.count), h('td', { style: 'font-weight:700;color:#4ade80' }, `${fmtMoney(p.revenue)} ج.م`))
        )
      : [h('tr', null, h('td', { class: 'empty', colspan: 3 }, 'لا توجد إيرادات مسجلة في هذا الشهر'))];

    const dailyRows = (reportData.dailyBreakdown || []).length
      ? reportData.dailyBreakdown.map((d) =>
          h(
            'tr',
            { class: 'clickable', onclick: () => (location.hash = `#/daily-report?date=${d.date}`) },
            h('td', { class: 'ltr' }, d.date),
            h('td', null, `${fmtMoney(d.totalRevenue)} ج.م`),
            h('td', { style: 'color:#f59e0b' }, d.expenses ? `${fmtMoney(d.expenses)} ج.م` : '—'),
            h('td', { style: `font-weight:700;color:${(d.netRevenue || 0) >= 0 ? '#4ade80' : '#f87171'}` }, `${fmtMoney(d.netRevenue ?? d.totalRevenue)} ج.م`)
          )
        )
      : [h('tr', null, h('td', { class: 'empty', colspan: 4 }, 'لا توجد حركات يومية في هذا الشهر'))];

    breakdownGrid.replaceChildren(
      h(
        'div',
        { class: 'card' },
        h('h2', null, '📦 توزيع الإيراد حسب الباقة'),
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            null,
            h('thead', null, h('tr', null, h('th', null, 'الباقة'), h('th', null, 'العدد'), h('th', null, 'الإجمالي'))),
            h('tbody', null, planRows)
          )
        )
      ),
      h(
        'div',
        { class: 'card' },
        h('h2', null, '📆 التفصيل اليومي للشهر (اضغط على اليوم للتفاصيل)'),
        h(
          'div',
          { class: 'table-wrap', style: 'max-height:360px;overflow-y:auto' },
          h(
            'table',
            null,
            h('thead', null, h('tr', null, h('th', null, 'التاريخ'), h('th', null, 'الإيراد'), h('th', null, 'المصروفات'), h('th', null, 'الصافي'))),
            h('tbody', null, dailyRows)
          )
        )
      )
    );
  }

  function renderMonthlyExpenses() {
    if (!reportData) return;
    const exRows = reportData.expensesList || [];
    const tbody = h('tbody');
    if (!exRows.length) {
      tbody.append(h('tr', null, h('td', { class: 'empty', colspan: 6 }, 'لا توجد مصروفات مسجلة في هذا الشهر')));
    } else {
      exRows.forEach((ex, i) => {
        tbody.append(
          h(
            'tr',
            null,
            h('td', { class: 'muted mono' }, String(i + 1)),
            h('td', { class: 'ltr muted' }, `${ex.expense_date} ${ex.time || ''}`),
            h('td', { style: 'font-weight:700' }, ex.title),
            h('td', null, badge('warn', ex.category)),
            h('td', { style: 'font-weight:800;color:#f59e0b' }, `${fmtMoney(ex.amount)} ج.م`),
            h('td', null, ex.recorded_by === 'admin' ? 'مدير' : 'استقبال')
          )
        );
      });
    }
    monthlyExpensesCard.replaceChildren(
      h(
        'div',
        { style: 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px' },
        h('h2', { style: 'margin:0;' }, '💸 سجل مصروفات الشهر'),
        h('a', { href: '#/expenses', class: 'btn small no-print' }, 'فتح سجل المصروفات الكامل')
      ),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          null,
          h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'التاريخ والوقت'), h('th', null, 'البند'), h('th', null, 'التصنيف'), h('th', null, 'المبلغ'), h('th', null, 'بواسطة'))),
          tbody,
          exRows.length
            ? h('tfoot', null, h('tr', { style: 'background:rgba(255,255,255,0.03);font-weight:900;' }, h('td', { colspan: 4, style: 'text-align:left;padding-left:16px;' }, 'إجمالي مصروفات الشهر:'), h('td', { colspan: 2, style: 'color:#f59e0b;font-size:1.1rem;' }, `${fmtMoney(reportData.totalExpenses || 0)} ج.م`)))
            : null
        )
      )
    );
  }

  function renderTable() {
    if (!reportData) return;
    const rows = (reportData.list || []).filter((r) => {
      if (typeFilter !== 'all' && r.type !== typeFilter) return false;
      if (q) {
        const text = `${r.member_name} ${r.member_code} ${r.member_phone} ${r.plan_name}`.toLowerCase();
        if (!text.includes(q)) return false;
      }
      return true;
    });

    const totalFilteredCash = rows.reduce((acc, r) => (r.status !== 'cancelled' ? acc + (Number(r.price) || 0) : acc), 0);
    const tbody = h('tbody');

    if (!rows.length) {
      tbody.append(
        h(
          'tr',
          null,
          h('td', { class: 'empty', colspan: 7 }, reportData.list.length === 0 ? 'لا توجد حركات مالية مسجلة في هذا الشهر' : 'لا توجد نتائج مطابقة للبحث')
        )
      );
    } else {
      rows.forEach((r, idx) => {
        const isCancelled = r.status === 'cancelled';
        const typeBadge =
          r.type === 'pt'
            ? badge('info', '⭐ برايفت')
            : r.type === 'new'
            ? badge('ok', '🟢 جديد')
            : badge('info', '🔄 تجديد');
        tbody.append(
          h(
            'tr',
            {
              class: 'clickable',
              style: isCancelled ? 'opacity:0.55;text-decoration:line-through;' : '',
              onclick: () => (location.hash = `#/members/${r.member_id}`),
            },
            h('td', { class: 'muted mono' }, String(idx + 1)),
            h('td', { class: 'ltr muted' }, `${r.date} ${r.time}`),
            h('td', { class: 'mono', style: 'font-weight:bold;color:#4ade80' }, r.member_code),
            h('td', { style: 'font-weight:700' }, r.member_name),
            h('td', null, r.plan_name),
            h('td', null, typeBadge),
            h(
              'td',
              { style: 'font-weight:800;color:#4ade80;font-size:1.05rem' },
              isCancelled ? `${fmtMoney(r.price)} ج.م (ملغى)` : `${fmtMoney(r.price)} ج.م`
            )
          )
        );
      });
    }

    tableWrap.replaceChildren(
      h(
        'table',
        null,
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, '#'),
            h('th', null, 'التاريخ والوقت'),
            h('th', null, 'الكود'),
            h('th', null, 'اسم العضو'),
            h('th', null, 'الباقة'),
            h('th', null, 'النوع'),
            h('th', null, 'المبلغ')
          )
        ),
        tbody,
        rows.length
          ? h(
              'tfoot',
              null,
              h(
                'tr',
                { style: 'background:rgba(255,255,255,0.03);font-weight:900;' },
                h('td', { colspan: 6, style: 'text-align:left;padding-left:16px;' }, `الإجمالي (${rows.length} حركة):`),
                h('td', { style: 'color:#4ade80;font-size:1.15rem;' }, `${fmtMoney(totalFilteredCash)} ج.م`)
              )
            )
          : null
      )
    );
  }

  function renderHistory() {
    if (!reportData || !reportData.recentMonths) return;
    historyCard.replaceChildren(
      h(
        'div',
        { style: 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:6px' },
        h('h2', { style: 'margin:0;' }, '🗓️ سجل التقفيل الشهري للشهور السابقة (آخر 12 شهر)'),
        h('span', { class: 'muted', style: 'font-size:0.85rem' }, 'اضغط على أي شهر لعرض إيراداته وتفاصيله بالكامل')
      ),
      h(
        'div',
        { class: 'history-grid' },
        reportData.recentMonths.map((item) => {
          const isCurrent = item.month === selectedMonth;
          return h(
            'div',
            {
              class: `history-item ${isCurrent ? 'active' : ''}`,
              onclick: () => setMonth(item.month),
              title: `عرض تقفيل ${fmtMonthArabic(item.month)}`,
            },
            h('div', { class: 'd-title' }, fmtMonthArabic(item.month)),
            h('div', { class: 'd-rev' }, `${fmtMoney(item.revenue)} ج.م`),
            h('div', { class: 'd-cnt' }, item.count === 0 ? 'لا توجد حركات' : `${item.count} حركة`)
          );
        })
      )
    );
  }

  async function load(ym) {
    const label = fmtMonthArabic(ym);
    monthDisplay.textContent = label;
    printMonthLabel.textContent = `الشهر: ${label} (${ym})`;
    renderPresets();
    reportData = await api('GET', `/api/reports/monthly?month=${encodeURIComponent(ym)}`);
    renderSummary();
    renderBreakdowns();
    renderTable();
    renderMonthlyExpenses();
    renderHistory();
  }

  const printHeader = h(
    'div',
    { class: 'print-only', style: 'margin-bottom:20px;text-align:center;border-bottom:2px solid #000;padding-bottom:12px' },
    h('h1', { style: 'margin:0 0 6px 0;font-size:1.8rem;color:#000' }, `${ME.gymName || 'Hulk GYM'} — التقفيل الشهري للإيرادات`),
    printMonthLabel,
    h('div', { style: 'font-size:0.9rem;color:#666;margin-top:4px' }, `وقت استخراج التقرير: ${new Date().toLocaleString('ar-EG', { timeZone: TZ })}`)
  );

  const printSignatures = h(
    'div',
    { class: 'print-only-flex', style: 'justify-content:space-between;margin-top:40px;padding-top:20px;border-top:1px dashed #444;font-size:1rem;color:#000' },
    h('div', null, h('b', null, 'المحاسب / الاستقبال:'), ' ................................'),
    h('div', null, h('b', null, 'مدير الجيم:'), ' ................................'),
    h('div', null, h('b', null, 'صافي الإيراد المعتمد:'), ' ................................ ج.م')
  );

  app.replaceChildren(
    printHeader,
    h(
      'div',
      { class: 'page-head no-print' },
      h(
        'div',
        null,
        h(
          'div',
          { style: 'display:flex;align-items:center;gap:12px;margin-bottom:4px;flex-wrap:wrap;' },
          backBtn('#/', 'الرئيسية'),
          h('h1', { style: 'display:flex;align-items:center;gap:10px;margin:0;' }, '📅 التقفيل الشهري للإيرادات')
        ),
        h('div', { class: 'muted', style: 'font-size:0.95rem;margin-top:2px' }, 'إجمالي إيرادات الاشتراكات والبرايفت (PT) ومقارنتها برواتب الموظفين')
      ),
      h(
        'div',
        { class: 'actions' },
        h('button', { type: 'button', class: 'btn primary', onclick: () => window.print() }, '🖨️ طباعة التقفيل الشهري'),
        h('button', { type: 'button', class: 'btn', onclick: () => setMonth(selectedMonth) }, '🔄 تحديث')
      )
    ),
    h(
      'div',
      { class: 'card no-print', style: 'padding:14px 18px;margin-bottom:16px;' },
      h(
        'div',
        { style: 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px' },
        h('div', { class: 'date-nav' }, h('span', { style: 'font-weight:700' }, 'الشهر:'), monthInput, monthDisplay),
        presetContainer
      )
    ),
    summaryBox,
    breakdownGrid,
    h('div', { class: 'toolbar no-print', style: 'margin-top:20px;margin-bottom:12px' }, searchInput, typeSelect),
    tableWrap,
    monthlyExpensesCard,
    printSignatures,
    historyCard
  );

  await load(selectedMonth);
}

// ---------- المصروفات اليومية والسجل الدائم (للمدير والموظف) ----------
const EXPENSE_CATEGORIES = ['صيانة', 'كهرباء ومياه', 'نظافة', 'مشتريات', 'سلف/رواتب', 'ضيافة', 'أخرى'];

async function pageExpenses() {
  const today = todayLocal();
  const currentMonth = today.slice(0, 7);
  let q = '';
  let filterMonth = currentMonth;
  let filterDate = '';
  let filterCat = 'all';
  let data = null;

  const summaryBox = h('div', { class: 'tiles' });
  const tableWrap = h('div', { class: 'card table-wrap' });

  const titleInput = h('input', { type: 'text', placeholder: 'مثال: فاتورة كهرباء، صيانة تريدميل، أدوات نظافة...', required: true, maxlength: 150 });
  const amountInput = h('input', { type: 'number', step: 'any', min: '1', placeholder: 'المبلغ بالجنيه', required: true, class: 'ltr' });
  const catSelect = h('select', null, EXPENSE_CATEGORIES.map((c) => h('option', { value: c }, c)));
  const dateInput = h('input', { type: 'date', value: today, required: true });
  const notesInput = h('input', { type: 'text', placeholder: 'ملاحظات إضافية (اختياري)', maxlength: 300 });
  const submitBtn = h('button', { type: 'submit', class: 'btn primary' }, '💾 تسجيل المصروف');

  const addForm = h(
    'form',
    {
      class: 'card',
      style: 'margin-bottom:20px;',
      onsubmit: async (e) => {
        e.preventDefault();
        submitBtn.disabled = true;
        try {
          await api('POST', '/api/expenses', {
            title: titleInput.value.trim(),
            amount: Number(amountInput.value),
            category: catSelect.value,
            expense_date: dateInput.value || today,
            notes: notesInput.value.trim(),
          });
          titleInput.value = '';
          amountInput.value = '';
          notesInput.value = '';
          toast('تم تسجيل المصروف في السجل الدائم');
          await load();
        } catch (err) {
          toast(err.message, true);
        } finally {
          submitBtn.disabled = false;
        }
      },
    },
    h(
      'div',
      { style: 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:12px' },
      h('h2', { style: 'margin:0;' }, '➕ تسجيل مصروف يومي جديد'),
      h('span', { class: 'badge warn' }, '🔒 سجل دائم لا يُحذف — يُخصم تلقائياً من التقفيل اليومي والشهري')
    ),
    h(
      'div',
      { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;' },
      field('بيان / اسم المصروف *', titleInput),
      field('المبلغ (ج.م) *', amountInput),
      field('التصنيف', catSelect),
      field('التاريخ', dateInput),
      field('ملاحظات', notesInput)
    ),
    h('div', { class: 'actions', style: 'margin-top:10px;' }, submitBtn)
  );

  const searchInput = h('input', {
    type: 'search',
    placeholder: 'ابحث في سجل المصروفات (البيان، التصنيف، الملاحظات)...',
    style: 'min-width:220px;flex:2',
    oninput: (e) => {
      q = e.target.value.trim().toLowerCase();
      load().catch((err) => toast(err.message, true));
    },
  });
  const monthFilterInput = h('input', {
    type: 'month',
    value: filterMonth,
    style: 'max-width:165px',
    onchange: (e) => {
      filterMonth = e.target.value;
      filterDate = '';
      dateFilterInput.value = '';
      load().catch((err) => toast(err.message, true));
    },
  });
  const dateFilterInput = h('input', {
    type: 'date',
    value: '',
    style: 'max-width:165px',
    onchange: (e) => {
      filterDate = e.target.value;
      load().catch((err) => toast(err.message, true));
    },
  });
  const catFilterSelect = h(
    'select',
    {
      style: 'max-width:170px',
      onchange: (e) => {
        filterCat = e.target.value;
        load().catch((err) => toast(err.message, true));
      },
    },
    h('option', { value: 'all' }, 'كل التصنيفات'),
    ...EXPENSE_CATEGORIES.map((c) => h('option', { value: c }, c))
  );

  function renderSummary() {
    if (!data) return;
    const tile = (cls, num, lbl) =>
      h('div', { class: `tile ${cls}` }, h('div', { class: 'num' }, num), h('div', { class: 'lbl' }, lbl));
    summaryBox.replaceChildren(
      tile('warn', `${fmtMoney(data.todayTotal)} ج.م`, '💸 مصروفات اليوم'),
      tile('gold', `${fmtMoney(data.monthTotal)} ج.م`, '📅 مصروفات الشهر الحالي'),
      tile('info', `${fmtMoney(data.filteredTotal)} ج.م`, '🔍 إجمالي نتائج الفلتر الحالي'),
      tile('', `${data.count} سجل`, '📑 عدد المصروفات المعروضة')
    );
  }

  function renderTable() {
    if (!data) return;
    const rows = data.list || [];
    const tbody = h('tbody');
    if (!rows.length) {
      tbody.append(h('tr', null, h('td', { class: 'empty', colspan: 8 }, 'لا توجد مصروفات مسجلة مطابقة للبحث')));
    } else {
      rows.forEach((ex, idx) => {
        tbody.append(
          h(
            'tr',
            null,
            h('td', { class: 'muted mono' }, String(idx + 1)),
            h('td', { class: 'ltr' }, ex.expense_date),
            h('td', { class: 'ltr muted' }, ex.time || '-'),
            h('td', { style: 'font-weight:700' }, ex.title),
            h('td', null, badge('warn', ex.category)),
            h('td', { style: 'font-weight:800;color:#f59e0b;font-size:1.05rem' }, `${fmtMoney(ex.amount)} ج.م`),
            h('td', { class: 'muted' }, ex.notes || '—'),
            h('td', null, badge(ex.recorded_by === 'admin' ? 'ok' : 'info', ex.recorded_by === 'admin' ? 'مدير' : 'استقبال'))
          )
        );
      });
    }

    tableWrap.replaceChildren(
      h(
        'table',
        null,
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, '#'),
            h('th', null, 'التاريخ'),
            h('th', null, 'الوقت'),
            h('th', null, 'بيان المصروف'),
            h('th', null, 'التصنيف'),
            h('th', null, 'المبلغ'),
            h('th', null, 'ملاحظات'),
            h('th', null, 'سُجل بواسطة')
          )
        ),
        tbody,
        rows.length
          ? h(
              'tfoot',
              null,
              h(
                'tr',
                { style: 'background:rgba(255,255,255,0.03);font-weight:900;' },
                h('td', { colspan: 5, style: 'text-align:left;padding-left:16px;' }, `الإجمالي (${rows.length} سجل):`),
                h('td', { colspan: 3, style: 'color:#f59e0b;font-size:1.15rem;' }, `${fmtMoney(data.filteredTotal)} ج.م`)
              )
            )
          : null
      )
    );
  }

  async function load() {
    const qs = new URLSearchParams();
    if (filterDate) qs.set('date', filterDate);
    else if (filterMonth) qs.set('month', filterMonth);
    if (filterCat !== 'all') qs.set('category', filterCat);
    if (q) qs.set('q', q);
    data = await api('GET', `/api/expenses?${qs.toString()}`);
    renderSummary();
    renderTable();
  }

  app.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;' },
        backBtn('#/', 'الرئيسية'),
        h('h1', { style: 'margin:0;' }, '💸 المصروفات اليومية وسجل المصروفات')
      ),
      h(
        'div',
        { class: 'actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => load().catch((e) => toast(e.message, true)) }, '🔄 تحديث')
      )
    ),
    addForm,
    summaryBox,
    h(
      'div',
      { class: 'toolbar', style: 'margin-top:20px;margin-bottom:12px' },
      searchInput,
      monthFilterInput,
      dateFilterInput,
      catFilterSelect,
      h(
        'button',
        {
          type: 'button',
          class: 'btn small',
          onclick: () => {
            q = '';
            searchInput.value = '';
            filterMonth = '';
            monthFilterInput.value = '';
            filterDate = '';
            dateFilterInput.value = '';
            filterCat = 'all';
            catFilterSelect.value = 'all';
            load().catch((e) => toast(e.message, true));
          },
        },
        'عرض كل السجل'
      )
    ),
    tableWrap
  );

  await load();
}

// ---------- مشتركي التدريب الخاص (البرايفت - PT) ----------
async function pagePrivateTrainings(query = '') {
  const params = new URLSearchParams(query);
  const statusFilter = params.get('status') || 'active';

  const data = await api('GET', `/api/private-trainings?status=${statusFilter}`);
  const pts = data.privateTrainings || [];

  const tiles = h(
    'div',
    { class: 'tiles', style: 'margin-bottom:20px;' },
    tile('ok', data.activeCount, 'اشتراكات سارية', '#/private?status=active'),
    tile('warn', data.expiringCount, 'تنتهي خلال 3 أيام', '#/private?status=active'),
    tile('bad', data.expiredCount, 'اشتراكات منتهية', '#/private?status=expired'),
    tile('info', ltr(Number(data.totalRevenue || 0).toLocaleString('ar-EG')) + ' ج', 'إجمالي الإيرادات')
  );

  const filterTabs = h(
    'div',
    { class: 'row', style: 'margin-bottom:16px;gap:8px;align-items:center;flex-wrap:wrap;' },
    h('span', { class: 'muted', style: 'font-weight:bold;' }, 'تصفية:'),
    h('a', { class: `btn small ${statusFilter === 'active' ? 'primary' : ''}`, href: '#/private?status=active' }, 'الساري حالياً'),
    h('a', { class: `btn small ${statusFilter === 'expired' ? 'primary' : ''}`, href: '#/private?status=expired' }, 'المنتهي'),
    h('a', { class: `btn small ${statusFilter === 'all' ? 'primary' : ''}`, href: '#/private?status=all' }, 'كل الاشتراكات')
  );

  const searchInput = h('input', {
    type: 'search',
    placeholder: 'بحث باسم العضو أو الكابتن أو الكود...',
    style: 'margin-bottom:16px;',
  });

  const tbody = h('tbody');

  function renderTable(list) {
    if (list.length === 0) {
      tbody.replaceChildren(
        h('tr', null, h('td', { colspan: 7, class: 'muted', style: 'text-align:center;padding:30px;' }, 'لا توجد اشتراكات برايفت مطابقة.'))
      );
      return;
    }

    tbody.replaceChildren(
      ...list.map((pt) => {
        const totalDays = pt.total_days || 30;
        const daysLeft = pt.days_left || 0;
        const elapsedDays = Math.max(0, Math.min(totalDays, totalDays - daysLeft));
        const percent = Math.min(100, Math.round((elapsedDays / totalDays) * 100));
        const balanceDue = Number(pt.price) - Number(pt.paid);

        const memberLink = h(
          'a',
          { href: `#/members/${pt.member_id}`, style: 'font-weight:bold;color:var(--brand-light);text-decoration:none;' },
          pt.member_name,
          h('span', { class: 'code mono', style: 'margin-inline-start:6px;font-size:0.85rem;' }, pt.member_code)
        );

        let countdownLabel = '';
        let barColor = 'linear-gradient(90deg, #10b981 0%, #34d399 50%, #4ade80 100%)';
        let statusBadge = null;

        if (pt.state === 'active') {
          statusBadge = h('span', { class: 'badge ok' }, 'ساري');
          countdownLabel = `باقي ${daysLeft} يوم`;
        } else if (pt.state === 'expiring') {
          statusBadge = h('span', { class: 'badge warn' }, 'ينتهي قريباً');
          countdownLabel = daysLeft === 0 ? 'ينتهي اليوم!' : `باقي ${daysLeft} يوم`;
          barColor = '#f59e0b';
        } else if (pt.state === 'upcoming') {
          statusBadge = h('span', { class: 'badge info' }, 'لم يبدأ');
          countdownLabel = `يبدأ ${ltr(pt.start_date)}`;
        } else {
          statusBadge = h('span', { class: 'badge bad' }, 'منتهي');
          countdownLabel = 'منتهي';
          barColor = '#ef4444';
        }

        const editBtn = h(
          'button',
          {
            class: 'btn small',
            onclick: () => privateModal(pt, true, () => route()),
          },
          'تعديل'
        );

        const deleteBtn = ME.role === 'admin'
          ? h(
              'button',
              {
                class: 'btn small danger',
                onclick: async () => {
                  if (!confirm(`هل أنت متأكد من حذف اشتراك البرايفت للعضو ${pt.member_name}؟`)) return;
                  try {
                    await api('DELETE', `/api/private-trainings/${pt.id}`);
                    toast('تم الحذف');
                    route();
                  } catch (err) {
                    toast(err.message, true);
                  }
                },
              },
              'حذف'
            )
          : null;

        return h(
          'tr',
          null,
          h('td', null, memberLink),
          h('td', null, h('b', null, pt.trainer_name)),
          h('td', null, pt.package_name),
          h(
            'td',
            { style: 'min-width:160px;' },
            h('div', { style: 'font-size:0.88rem;display:flex;justify-content:space-between;margin-bottom:4px;' },
              h('span', { style: 'font-weight:600;' }, countdownLabel),
              h('span', { class: 'muted', style: 'font-size:0.8rem;' }, `${ltr(pt.end_date)}`)
            ),
            h('div', { class: 'pt-progress-wrap', style: 'margin:0;height:8px;' },
              h('div', { class: 'pt-progress-bar', style: `width:${percent}%;background:${barColor};` })
            )
          ),
          h(
            'td',
            null,
            h('div', null, fmtMoney(pt.price) + ' ج'),
            balanceDue > 0
              ? h('div', { style: 'color:#ef4444;font-size:0.82rem;font-weight:bold;' }, `باقي: ${fmtMoney(balanceDue)}`)
              : h('div', { style: 'color:#10b981;font-size:0.82rem;' }, 'خالص')
          ),
          h('td', null, statusBadge),
          h('td', { style: 'white-space:nowrap;display:flex;gap:6px;' }, editBtn, deleteBtn)
        );
      })
    );
  }

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) {
      renderTable(pts);
      return;
    }
    const filtered = pts.filter((p) =>
      (p.member_name || '').toLowerCase().includes(q) ||
      (p.trainer_name || '').toLowerCase().includes(q) ||
      (p.member_code || '').toLowerCase().includes(q)
    );
    renderTable(filtered);
  });

  renderTable(pts);

  app.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;' },
        backBtn('#/', 'الرئيسية'),
        h('h1', { style: 'margin:0;' }, '⭐ مشتركي التدريب الخاص (البرايفت)')
      ),
      h('button', { class: 'btn primary', onclick: () => privateModal(null, false, () => route()) }, '➕ اشتراك برايفت جديد')
    ),
    tiles,
    h('div', { class: 'card' }, filterTabs, searchInput),
    h(
      'div',
      { class: 'card table-wrap' },
      h(
        'table',
        null,
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            ['العضو', 'الكابتن 🏋️', 'الباقة', 'العد التنازلي والانتهاء', 'المبلغ', 'الحالة', 'إجراءات'].map((t) => h('th', null, t))
          )
        ),
        tbody
      )
    )
  );
}

async function privateModal(ptOrMember, isEdit, onDone) {
  let members = [];
  let coaches = [];

  try {
    const empData = await api('GET', '/api/employees');
    coaches = empData.employees || [];
  } catch {}

  let memberId = ptOrMember ? (ptOrMember.member_id || ptOrMember.id) : null;
  let memberName = ptOrMember ? (ptOrMember.member_name || ptOrMember.name) : '';

  let memberSelectEl = null;
  if (!memberId) {
    try {
      members = await api('GET', '/api/members?status=all');
    } catch {}
    memberSelectEl = h(
      'select',
      { name: 'member_id', required: true },
      h('option', { value: '' }, '-- اختر العضو المشترك --'),
      ...members.map((m) => h('option', { value: m.id }, `${m.name} (${m.code})`))
    );
  }

  const coachOptions = [
    h('option', { value: '' }, '-- اكتب اسم الكابتن بالأسفل أو اختر من هنا --'),
    ...coaches.map((c) => h('option', { value: c.name }, `${c.name} (${c.role || 'مدرب'})`))
  ];

  const coachSelect = h('select', null, coachOptions);
  const trainerInput = h('input', {
    name: 'trainer_name',
    required: true,
    placeholder: 'مثلاً: كابتن أحمد محمود',
    value: isEdit ? ptOrMember.trainer_name : ''
  });

  coachSelect.addEventListener('change', () => {
    if (coachSelect.value) trainerInput.value = coachSelect.value;
  });

  const durationOptions = [
    { label: 'شهر (30 يوم)', days: 30, name: 'شهر تدريب خاص' },
    { label: 'شهرين (60 يوم)', days: 60, name: 'شهرين تدريب خاص' },
    { label: '3 شهور (90 يوم)', days: 90, name: '3 شهور تدريب خاص' },
    { label: '6 شهور (180 يوم)', days: 180, name: '6 شهور تدريب خاص' },
    { label: 'سنة (365 يوم)', days: 365, name: 'سنة تدريب خاص' },
    { label: 'أيام مخصصة...', days: 0, name: 'تدريب خاص مخصص' }
  ];

  const durationSelect = h(
    'select',
    null,
    ...durationOptions.map(d => h('option', { value: d.days, selected: isEdit ? (ptOrMember.duration_days === d.days) : (d.days === 30) }, d.label))
  );

  const durationDaysInput = h('input', {
    name: 'duration_days',
    type: 'number',
    min: 1,
    max: 3650,
    required: true,
    value: isEdit ? (ptOrMember.duration_days || 30) : 30
  });

  const packageInput = h('input', {
    name: 'package_name',
    placeholder: 'مثلاً: شهر تدريب خاص / كورس تأهيل',
    value: isEdit ? ptOrMember.package_name : 'شهر تدريب خاص (برايفت)'
  });

  const startDateInput = h('input', {
    name: 'start_date',
    type: 'date',
    value: isEdit ? ptOrMember.start_date : todayLocal()
  });

  const endDateInput = h('input', {
    name: 'end_date',
    type: 'date',
    value: isEdit ? ptOrMember.end_date : ''
  });

  function updateEndDate() {
    const start = startDateInput.value;
    const days = Number(durationDaysInput.value) || 30;
    if (start) {
      const d = new Date(start + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + days - 1);
      endDateInput.value = d.toISOString().slice(0, 10);
    }
  }

  if (!isEdit) updateEndDate();

  durationSelect.addEventListener('change', () => {
    const days = Number(durationSelect.value);
    if (days > 0) {
      durationDaysInput.value = days;
      const opt = durationOptions.find(o => o.days === days);
      if (opt && !isEdit) packageInput.value = opt.name;
    }
    updateEndDate();
  });

  durationDaysInput.addEventListener('input', updateEndDate);
  startDateInput.addEventListener('change', updateEndDate);

  const priceInput = h('input', {
    name: 'price',
    type: 'number',
    min: 0,
    step: '50',
    required: true,
    placeholder: 'السعر الإجمالي بالجنيه',
    value: isEdit ? ptOrMember.price : 1500
  });

  const paidInput = h('input', {
    name: 'paid',
    type: 'number',
    min: 0,
    step: '50',
    required: true,
    placeholder: 'المبلغ المدفوع بالجنيه',
    value: isEdit ? ptOrMember.paid : 1500
  });

  const statusSelect = isEdit
    ? h(
        'select',
        { name: 'status' },
        h('option', { value: 'active', selected: ptOrMember.status === 'active' }, 'ساري'),
        h('option', { value: 'cancelled', selected: ptOrMember.status === 'cancelled' }, 'ملغي')
      )
    : null;

  const notesInput = h('textarea', {
    name: 'notes',
    rows: 2,
    placeholder: 'ملاحظات خاصة بالتدريب أو المواعيد...',
    value: isEdit ? ptOrMember.notes : ''
  });

  const formFields = [
    memberSelectEl ? field('العضو المشترك *', memberSelectEl) : h('div', { class: 'field' }, h('label', null, 'العضو المشترك'), h('b', { style: 'color:#4ade80;font-size:1.1rem;' }, memberName)),
    coaches.length > 0 ? field('اختيار سريع للمدرب', coachSelect) : null,
    field('اسم الكابتن / المدرب المسئول *', trainerInput),
    h('div', { class: 'row' }, field('المدة بالشهور', durationSelect), field('المدة بالأيام *', durationDaysInput)),
    field('اسم الباقة / الوصف', packageInput),
    h('div', { class: 'row' }, field('تاريخ البداية *', startDateInput), field('تاريخ الانتهاء (تلقائي) *', endDateInput)),
    h('div', { class: 'row' }, field('سعر البرايفت (ج.م) *', priceInput), field('المبلغ المدفوع (ج.م) *', paidInput)),
    isEdit ? field('حالة الاشتراك', statusSelect) : null,
    field('ملاحظات إضافية', notesInput)
  ].filter(Boolean);

  openModal(
    isEdit ? 'تعديل اشتراك البرايفت' : 'اشتراك برايفت جديد',
    formFields,
    async () => {
      const selectedMemberId = memberId || (memberSelectEl ? memberSelectEl.value : null);
      const trainerName = trainerInput.value.trim();
      const packageName = packageInput.value.trim() || 'شهر تدريب خاص (برايفت)';
      const durationDays = Number(durationDaysInput.value) || 30;
      const startDate = startDateInput.value || todayLocal();
      const endDate = endDateInput.value;
      const price = Number(priceInput.value) || 0;
      const paid = Number(paidInput.value) || 0;
      const notes = notesInput.value.trim();

      if (!selectedMemberId) {
        alert('يرجى اختيار العضو المشترك');
        return false;
      }
      if (!trainerName) {
        alert('اسم الكابتن مطلوب');
        return false;
      }
      if (durationDays < 1) {
        alert('المدة يجب أن تكون يوماً واحداً على الأقل');
        return false;
      }

      if (isEdit) {
        const status = statusSelect ? statusSelect.value : 'active';
        await api('PUT', `/api/private-trainings/${ptOrMember.id}`, {
          trainer_name: trainerName,
          package_name: packageName,
          duration_days: durationDays,
          start_date: startDate,
          end_date: endDate,
          price,
          paid,
          status,
          notes
        });
        toast('تم حفظ التعديلات بنجاح');
      } else {
        await api('POST', `/api/members/${selectedMemberId}/private-training`, {
          trainer_name: trainerName,
          package_name: packageName,
          duration_days: durationDays,
          start_date: startDate,
          end_date: endDate,
          price,
          paid,
          notes
        });
        toast('تم تسجيل اشتراك البرايفت بنجاح! ⭐');
      }

      if (onDone) await onDone();
      return true;
    },
    isEdit ? 'حفظ التعديلات' : 'تسجيل الاشتراك'
  );
}

// ---------- الموظفين والمرتبات (للمدير) ----------
async function pageEmployees() {
  if (ME.role !== 'admin') {
    app.replaceChildren(h('div', { class: 'alert bad' }, 'هذه الصفحة للمدير فقط'));
    return;
  }

  async function load() {
    const tile = (cls, num, lbl, href) =>
      h(
        href ? 'a' : 'div',
        { class: `tile ${cls}`, href, style: href ? 'color:inherit;text-decoration:none' : null },
        h('div', { class: 'num' }, num),
        h('div', { class: 'lbl' }, lbl)
      );
    const data = await api('GET', '/api/employees');
    const employees = data.employees || [];
    const totalSalary = Number(data.totalSalary) || 0;
    const activeCount = Number(data.activeCount) || 0;
    const totalCount = Number(data.totalCount) || 0;

    const tiles = h(
      'div',
      { class: 'tiles', style: 'margin-bottom:20px;' },
      tile('info', totalCount, 'إجمالي الموظفين'),
      tile('ok', activeCount, 'على رأس العمل'),
      tile('warn', ltr(totalSalary.toLocaleString('ar-EG')) + ' ج', 'إجمالي المرتبات الشهرية')
    );

    const tbody = h('tbody');
    if (employees.length === 0) {
      tbody.appendChild(
        h(
          'tr',
          null,
          h(
            'td',
            { colspan: 7, class: 'muted', style: 'text-align:center;padding:30px;' },
            'لا يوجد موظفون مسجلون حالياً. اضغط على "+ إضافة موظف جديد" للبدء.'
          )
        )
      );
    } else {
      employees.forEach((emp) => {
        const phoneLink = emp.phone
          ? h('a', { href: `tel:${emp.phone}`, style: 'direction:ltr;display:inline-block;' }, ltr(emp.phone))
          : h('span', { class: 'muted' }, '—');

        const statusBadge = emp.active
          ? h('span', { class: 'badge ok' }, 'نشط')
          : h('span', { class: 'badge', style: 'opacity:0.6;' }, 'متوقف');

        const editBtn = h(
          'button',
          {
            class: 'btn small',
            onclick: () => employeeModal(emp, load),
          },
          'تعديل'
        );

        const deleteBtn = h(
          'button',
          {
            class: 'btn small danger',
            onclick: async () => {
              if (!confirm(`هل أنت متأكد من حذف الموظف "${emp.name}"؟`)) return;
              try {
                await api('DELETE', `/api/employees/${emp.id}`);
                await load();
              } catch (err) {
                alert(err.message || 'فشل حذف الموظف');
              }
            },
          },
          'حذف'
        );

        tbody.appendChild(
          h(
            'tr',
            { style: emp.active ? '' : 'opacity:0.65;background:rgba(0,0,0,0.1);' },
            h('td', { style: 'font-weight:600;' }, emp.name),
            h('td', null, h('span', { class: 'badge info' }, emp.role || 'موظف')),
            h('td', null, phoneLink),
            h(
              'td',
              { style: 'font-weight:bold;color:#10b981;' },
              ltr(Number(emp.salary || 0).toLocaleString('ar-EG')) + ' ج'
            ),
            h('td', { class: 'muted' }, emp.start_date || '—'),
            h('td', null, statusBadge),
            h('td', { style: 'white-space:nowrap;display:flex;gap:6px;' }, editBtn, deleteBtn)
          )
        );
      });
    }

    const tableWrap = h(
      'div',
      { class: 'card table-wrap' },
      h(
        'table',
        null,
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            ['اسم الموظف', 'الوظيفة', 'الهاتف', 'المرتب الشهري', 'تاريخ التعيين', 'الحالة', 'إجراءات'].map((t) =>
              h('th', null, t)
            )
          )
        ),
        tbody
      )
    );

    app.replaceChildren(
      h(
        'div',
        { class: 'page-head' },
        h(
          'div',
          { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;' },
          backBtn('#/', 'الرئيسية'),
          h('h1', { style: 'margin:0;' }, '👔 إدارة الموظفين والمرتبات')
        ),
        h('button', { class: 'btn primary', onclick: () => employeeModal(null, load) }, '➕ إضافة موظف جديد')
      ),
      tiles,
      tableWrap
    );
  }

  await load();
}

function employeeModal(emp, onSaved) {
  const isEdit = !!emp;
  const nameInput = h('input', {
    name: 'name',
    required: true,
    maxlength: 100,
    placeholder: 'مثلاً: كابتن محمد علي',
    value: emp ? emp.name : '',
  });

  const roleInput = h('input', {
    name: 'role',
    maxlength: 60,
    placeholder: 'مثلاً: مدرب صالة، استقبال، كابتن، نظافة',
    value: emp ? emp.role : 'مدرب',
  });

  const phoneInput = h('input', {
    name: 'phone',
    type: 'tel',
    maxlength: 30,
    placeholder: '01xxxxxxxxx',
    style: 'direction:ltr',
    value: emp ? emp.phone : '',
  });

  const salaryInput = h('input', {
    name: 'salary',
    type: 'number',
    min: 0,
    step: '50',
    required: true,
    placeholder: 'المرتب الشهري بالجنيه',
    value: emp ? emp.salary : '',
  });

  const startDateInput = h('input', {
    name: 'start_date',
    type: 'date',
    value: emp ? emp.start_date : todayLocal(),
  });

  const notesInput = h('textarea', {
    name: 'notes',
    rows: 2,
    placeholder: 'أي ملاحظات أو مواعيد شيفتات...',
    value: emp ? emp.notes : '',
  });

  const activeCheck = h('input', {
    type: 'checkbox',
    name: 'active',
    style: 'width:auto;margin-inline-end:8px;',
    checked: emp ? !!emp.active : true,
  });

  const formFields = [
    field('اسم الموظف *', nameInput),
    h('div', { class: 'row' }, field('المسمى الوظيفي', roleInput), field('رقم الهاتف', phoneInput)),
    h('div', { class: 'row' }, field('المرتب الشهري (ج.م) *', salaryInput), field('تاريخ بدء العمل', startDateInput)),
    field('ملاحظات', notesInput),
  ];

  if (isEdit) {
    formFields.push(h('div', { class: 'field' }, h('label', null, activeCheck, 'الموظف على رأس العمل (نشط)')));
  }

  openModal(
    isEdit ? 'تعديل بيانات موظف' : 'إضافة موظف جديد',
    formFields,
    async () => {
      const name = nameInput.value.trim();
      const role = roleInput.value.trim() || 'موظف';
      const phone = phoneInput.value.trim();
      const salary = Number(salaryInput.value) || 0;
      const startDate = startDateInput.value || todayLocal();
      const notes = notesInput.value.trim();
      const active = isEdit ? activeCheck.checked : true;

      if (!name) {
        alert('اسم الموظف مطلوب');
        return false;
      }
      if (salary < 0) {
        alert('المرتب لا يمكن أن يكون سالباً');
        return false;
      }

      const payload = { name, role, phone, salary, start_date: startDate, notes, active };

      if (isEdit) {
        await api('PUT', `/api/employees/${emp.id}`, payload);
      } else {
        await api('POST', '/api/employees', payload);
      }

      if (onSaved) await onSaved();
      return true;
    },
    isEdit ? 'حفظ التعديلات' : 'إضافة الموظف'
  );
}

// ---------- الباقات (للمدير) ----------
async function pagePlans() {
  if (ME.role !== 'admin') {
    app.replaceChildren(h('div', { class: 'alert bad' }, 'الصفحة دي للمدير فقط'));
    return;
  }
  const plans = await api('GET', '/api/plans?all=1');
  app.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;' },
        backBtn('#/', 'الرئيسية'),
        h('h1', { style: 'margin:0;' }, 'الباقات')
      ),
      h('button', { class: 'btn primary', onclick: () => planModal(null) }, '+ باقة جديدة')
    ),
    h(
      'div',
      { class: 'card table-wrap' },
      h(
        'table',
        null,
        h('thead', null, h('tr', null, ['الباقة', 'المدة (يوم)', 'السعر', 'الحالة', ''].map((t) => h('th', null, t)))),
        h(
          'tbody',
          null,
          plans.map((p) =>
            h(
              'tr',
              null,
              h('td', null, p.name),
              h('td', null, p.duration_days),
              h('td', null, fmtMoney(p.price)),
              h('td', null, p.active ? badge('active', 'متاحة') : badge('cancelled', 'مخفية')),
              h('td', null, h('button', { class: 'btn small', onclick: () => planModal(p) }, 'تعديل'))
            )
          )
        )
      )
    )
  );
}

function planModal(p) {
  openModal(
    p ? 'تعديل الباقة' : 'باقة جديدة',
    [
      field('اسم الباقة', h('input', { name: 'name', required: true, maxlength: 60, value: p ? p.name : '' })),
      h('div', { class: 'row' }, field('المدة بالأيام', h('input', { name: 'duration_days', type: 'number', min: 1, max: 3650, required: true, value: p ? p.duration_days : 30 })), field('السعر', h('input', { name: 'price', type: 'number', min: 0, step: '0.01', required: true, value: p ? p.price : 0 }))),
      p && h('div', { class: 'field' }, h('label', null, h('input', { type: 'checkbox', name: 'active', style: 'width:auto;margin-inline-end:8px', checked: !!p.active }), 'متاحة للاشتراك')),
      h('div', { class: 'muted', style: 'font-size:.9rem' }, 'تعديل السعر أو المدة لا يؤثر على الاشتراكات المسجلة قبل كده.'),
    ],
    async (fd) => {
      const body = { name: fd.get('name'), duration_days: Number(fd.get('duration_days')), price: Number(fd.get('price')) };
      if (p) {
        body.active = fd.get('active') === 'on';
        await api('PUT', `/api/plans/${p.id}`, body);
      } else await api('POST', '/api/plans', body);
      toast('تم الحفظ');
      route();
    }
  );
}

// ---------- صفحة الإشعارات وتنبيهات الواتساب ----------
async function pageReminders() {
  if (ME.role !== 'admin') {
    app.replaceChildren(h('div', { class: 'alert bad' }, 'هذه الصفحة للمدير فقط'));
    return;
  }

  const [data, settings] = await Promise.all([
    api('GET', '/api/reminders/expiring'),
    api('GET', '/api/settings'),
  ]);

  let editingTemplate = data.template || '';
  let editingDays = settings.remind_days || '3';

  const tableBox = h('div', { class: 'table-wrap' });

  function buildReminderTable(list, template, gymName) {
    if (!list.length) {
      tableBox.replaceChildren(h('div', { class: 'empty' }, 'لا يوجد أعضاء اشتراكاتهم على وشك الانتهاء'));
      return;
    }
    tableBox.replaceChildren(
      h(
        'table',
        null,
        h(
          'thead', null,
          h('tr', null,
            h('th', null, 'كود'),
            h('th', null, 'الاسم'),
            h('th', null, 'الموبايل'),
            h('th', null, 'الباقة'),
            h('th', null, 'ينتهي في'),
            h('th', null, 'المتبقي'),
            h('th', null, 'آخر تذكير'),
            h('th', null, 'إجراء')
          )
        ),
        h('tbody', null,
          ...list.map((m) => {
            const daysStr = m.days_left === null ? '-' : m.days_left === 0 ? 'النهارده' : m.days_left > 0 ? `${m.days_left} يوم` : `منتهي منذ ${Math.abs(m.days_left)} يوم`;
            const phone = m.phone || '';

            function makeWhatsAppMsg() {
              const days = m.days_left;
              let dStr = `${days} يوم`;
              if (days === 0) dStr = 'اليوم';
              else if (days === 1) dStr = 'غداً';
              else if (days === 2) dStr = 'يومين';
              else if (days < 0) dStr = `منتهي منذ ${Math.abs(days)} يوم`;
              const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
              const cardUrl = isLocal ? '' : `${location.origin}/card.html?code=${encodeURIComponent(m.code)}`;
              let resMsg = (template || '')
                .replace(/{name}/g, m.name)
                .replace(/{code}/g, m.code)
                .replace(/{gym}/g, gymName)
                .replace(/{plan}/g, m.plan_name)
                .replace(/{end_date}/g, m.end_date || '-')
                .replace(/{days_left}/g, dStr);
              if (cardUrl) {
                resMsg = resMsg.replace(/{card_url}/g, cardUrl);
              } else {
                resMsg = resMsg.replace(/\n?📲 كارت العضوية والبار كود الخاص بك:\n?{card_url}/g, '').replace(/{card_url}/g, '');
              }
              return resMsg;
            }

            async function logAndMark(btn) {
              try {
                await api('POST', '/api/reminders/log', { member_id: m.id });
                btn.textContent = '✅ تم التسجيل';
                btn.disabled = true;
                toast(`تم تسجيل إرسال التذكير لـ ${m.name}`);
              } catch (e) {
                toast(e.message, true);
              }
            }

            const waBtn = h(
              'button',
              {
                class: 'btn whatsapp',
                style: 'font-size:0.8rem;padding:4px 10px;margin-inline-end:4px',
                onclick: async (e) => {
                  if (!phone) { toast('العضو ليس له رقم موبايل', true); return; }
                  let p = phone.replace(/[\s\-\(\)\+]/g, '');
                  if (p.startsWith('00')) p = p.slice(2);
                  if (/^01[0125]\d{8}$/.test(p)) p = '2' + p;
                  const msg = makeWhatsAppMsg();
                  window.open(`https://wa.me/${p}?text=${encodeURIComponent(msg)}`, '_blank', 'noopener');
                  await logAndMark(e.currentTarget);
                }
              },
              m.remindedToday ? '✅ تم اليوم' : '💬 واتساب'
            );
            if (m.remindedToday) waBtn.disabled = true;

            const previewBtn = h(
              'button',
              {
                class: 'btn',
                style: 'font-size:0.8rem;padding:4px 8px',
                onclick: () => {
                  const msg = makeWhatsAppMsg();
                  openModal(`معاينة رسالة ${m.name}`,
                    [h('pre', { style: 'white-space:pre-wrap;font-size:0.85rem;direction:rtl;text-align:right;background:#141724;color:#f1f5f9;padding:14px;border-radius:10px;border:1px solid rgba(34, 197, 94,0.25);max-height:320px;overflow-y:auto' }, msg)],
                    async () => {}, 'إغلاق'
                  );
                }
              }, '👁️ معاينة'
            );

            return h('tr', null,
              h('td', { class: 'mono' }, m.code),
              h('td', { class: 'clickable', onclick: () => (location.hash = `#/members/${m.id}`) }, h('b', { style: 'color:var(--brand-light)' }, m.name)),
              h('td', { class: 'ltr' }, phone || '-'),
              h('td', null, m.plan_name),
              h('td', null, m.end_date ? ltr(m.end_date) : '-'),
              h('td', null, h('b', { style: m.days_left <= 0 ? 'color:#f87171' : m.days_left <= 2 ? 'color:#fbbf24' : 'color:#4ade80' }, daysStr)),
              h('td', { class: 'muted', style: 'font-size:0.8rem' }, m.lastReminder ? fmtDateTime(m.lastReminder.sent_at) : '-'),
              h('td', null, waBtn, previewBtn)
            );
          })
        )
      )
    );
  }

  buildReminderTable(data.list, data.template, data.gymName);

  const templateBox = h('textarea', { rows: 9, style: 'font-size:0.88rem;resize:vertical;direction:rtl;text-align:right;width:100%' }, editingTemplate);
  const daysInput = h('input', { type: 'number', min: 1, max: 30, value: editingDays, style: 'max-width:90px' });

  const saveSettingsBtn = h('button', { class: 'btn primary', onclick: async () => {
    try {
      await api('POST', '/api/settings', {
        remind_days: daysInput.value,
        remind_template: templateBox.value,
      });
      toast('تم حفظ إعدادات الرسائل بنجاح');
      route();
    } catch (e) { toast(e.message, true); }
  }}, '💾 حفظ إعدادات التذكير');

app.replaceChildren(
    h('div', { class: 'page-head' },
      h(
        'div',
        { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;' },
        backBtn('#/', 'الرئيسية'),
        h('h1', { style: 'margin:0;' }, '🔔 إشعارات تجديد الاشتراكات')
      )
    ),
    h('div', { class: 'alert warn', style: 'margin-bottom:14px' },
      `📋 قائمة الأعضاء الذين اشتراكاتهم ستنتهي خلال ${data.daysAhead} يوم أو انتهت مؤخراً (${data.list.length} عضو)`
    ),
    h('div', { class: 'card table-wrap', style: 'margin-bottom:18px' }, tableBox),

    h('div', { class: 'card' },
      h('h2', null, '⚙️ إعدادات قالب رسالة التذكير'),
      h('div', { class: 'row', style: 'margin-bottom:14px;align-items:center;gap:12px' },
        h('label', { style: 'font-weight:600' }, 'التذكير قبل الانتهاء بـ:'),
        daysInput,
        h('span', { class: 'muted' }, 'يوم')
      ),
      field('نص الرسالة (يمكنك استخدام {name} {gym} {plan} {end_date} {days_left} {card_url})', templateBox),
      h('div', { class: 'actions', style: 'margin-top:16px' }, saveSettingsBtn)
    )
  );
}

// ---------- صفحة الإعدادات وتغيير كلمات المرور ----------
async function pageSettings() {
  if (ME.role !== 'admin') {
    app.replaceChildren(h('div', { class: 'alert bad' }, 'هذه الصفحة للمدير فقط'));
    return;
  }

  const settings = await api('GET', '/api/settings');

  // كارت تغيير باسوورد المدير (Admin)
  const adminCurrentPw = h('input', {
    type: 'password',
    placeholder: 'كلمة المرور الحالية للمدير',
    autocomplete: 'current-password',
    style: 'direction:ltr',
  });
  const adminNewPw = h('input', {
    type: 'password',
    placeholder: 'كلمة المرور الجديدة للمدير (4 خانات فأكثر)',
    autocomplete: 'new-password',
    style: 'direction:ltr',
  });
  const adminConfirmPw = h('input', {
    type: 'password',
    placeholder: 'تأكيد كلمة المرور الجديدة',
    autocomplete: 'new-password',
    style: 'direction:ltr',
  });

  const showAdminPwCheck = h('input', {
    type: 'checkbox',
    id: 'show-admin-pw',
    style: 'width:auto;margin:0',
  });
  showAdminPwCheck.addEventListener('change', () => {
    const t = showAdminPwCheck.checked ? 'text' : 'password';
    adminCurrentPw.type = t;
    adminNewPw.type = t;
    adminConfirmPw.type = t;
  });

  const adminErr = h('div', { class: 'alert bad', hidden: true, style: 'margin-top:10px' });
  const adminSuccess = h('div', { class: 'alert ok', hidden: true, style: 'margin-top:10px' });
  const changeAdminBtn = h('button', { class: 'btn primary' }, '💾 حفظ كلمة مرور المدير');

  changeAdminBtn.addEventListener('click', async () => {
    adminErr.hidden = true;
    adminSuccess.hidden = true;
    const current = adminCurrentPw.value;
    const next = adminNewPw.value.trim();
    const confirm = adminConfirmPw.value.trim();

    if (!current) {
      adminErr.textContent = 'يرجى إدخال كلمة المرور الحالية للمدير';
      adminErr.hidden = false;
      adminCurrentPw.focus();
      return;
    }
    if (!next || next.length < 4) {
      adminErr.textContent = 'كلمة المرور الجديدة يجب ألا تقل عن 4 خانات';
      adminErr.hidden = false;
      adminNewPw.focus();
      return;
    }
    if (next !== confirm) {
      adminErr.textContent = 'كلمة المرور الجديدة وتأكيدها غير متطابقين';
      adminErr.hidden = false;
      adminConfirmPw.focus();
      return;
    }
    changeAdminBtn.disabled = true;
    try {
      const res = await api('POST', '/api/settings/change-admin-password', {
        currentPassword: current,
        newPassword: next,
      });
      adminSuccess.textContent = res.message || 'تم تحديث كلمة مرور المدير بنجاح';
      adminSuccess.hidden = false;
      adminCurrentPw.value = '';
      adminNewPw.value = '';
      adminConfirmPw.value = '';
      toast('تم تحديث كلمة مرور المدير بنجاح');
      ME = await api('GET', '/api/me');
    } catch (e) {
      adminErr.textContent = e.message;
      adminErr.hidden = false;
    } finally {
      changeAdminBtn.disabled = false;
    }
  });

  const adminCard = h('div', { class: 'card', style: 'margin-bottom:20px' },
    h('h2', null, '🛡️ تغيير كلمة مرور المدير (Admin)'),
    h('p', { class: 'muted', style: 'font-size:0.9rem;margin-bottom:14px' },
      'تمنحك هذه الكلمة صلاحيات الإدارة الكاملة (حذف وتعديل الأعضاء والاشتراكات، إدارة الأسعار والباقات، والوصول لكافة الإعدادات).'
    ),
    h('div', { class: 'row', style: 'align-items:flex-end;gap:12px;margin-bottom:8px' },
      field('كلمة المرور الحالية', adminCurrentPw),
      field('كلمة المرور الجديدة', adminNewPw),
      field('تأكيد الكلمة الجديدة', adminConfirmPw)
    ),
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-top:8px' },
      h('label', { for: 'show-admin-pw', style: 'cursor:pointer;font-weight:normal;font-size:0.85rem;display:inline-flex;align-items:center;gap:6px;user-select:none;margin:0' },
        showAdminPwCheck,
        'إظهار كلمات المرور'
      ),
      changeAdminBtn
    ),
    adminErr,
    adminSuccess
  );

  // كارت تغيير باسوورد الموظف
  const staffPwInput = h('input', {
    type: 'text',
    placeholder: 'أدخل كلمة مرور جديدة للموظف (مثال: staff2026)',
    autocomplete: 'new-password',
    style: 'direction:ltr',
  });
  const staffErr = h('div', { class: 'alert bad', hidden: true, style: 'margin-top:10px' });
  const staffSuccess = h('div', { class: 'alert ok', hidden: true, style: 'margin-top:10px' });
  const changeStaffBtn = h('button', { class: 'btn primary' }, '💾 حفظ كلمة مرور الموظف');

  changeStaffBtn.addEventListener('click', async () => {
    staffErr.hidden = true;
    staffSuccess.hidden = true;
    const val = staffPwInput.value.trim();
    if (!val || val.length < 4) {
      staffErr.textContent = 'كلمة المرور يجب ألا تقل عن 4 خانات';
      staffErr.hidden = false;
      return;
    }
    changeStaffBtn.disabled = true;
    try {
      const res = await api('POST', '/api/settings/change-staff-password', { newPassword: val });
      staffSuccess.textContent = res.message || 'تم تحديث كلمة المرور بنجاح';
      staffSuccess.hidden = false;
      staffPwInput.value = '';
      toast('تم تحديث كلمة مرور الموظفين بنجاح');
      ME = await api('GET', '/api/me');
    } catch (e) {
      staffErr.textContent = e.message;
      staffErr.hidden = false;
    } finally {
      changeStaffBtn.disabled = false;
    }
  });

  const staffCard = h('div', { class: 'card', style: 'margin-bottom:20px' },
    h('h2', null, '🔑 تغيير كلمة مرور الموظفين (Staff)'),
    h('p', { class: 'muted', style: 'font-size:0.9rem;margin-bottom:14px' },
      'تُستخدم هذه الكلمة لتسجيل دخول موظفي الاستقبال (صلاحيات تسجيل الحضور، إضافة الأعضاء والاشتراكات، دون صلاحية حذف الأعضاء أو تعديل الأسعار أو تغيير كلمات المرور).'
    ),
    h('div', { class: 'row', style: 'align-items:flex-end;gap:12px' },
      field('كلمة المرور الجديدة للموظف', staffPwInput),
      h('div', { class: 'field' }, changeStaffBtn)
    ),
    staffErr,
    staffSuccess
  );

  // دالة فتح سجل العمليات الإدارية (عند الطلب فقط)
  function openAuditModal() {
    const container = h('div', { style: 'max-height:380px;overflow-y:auto;min-height:100px;' },
      h('div', { class: 'muted', style: 'padding:20px;text-align:center;' }, 'جاري تحميل السجل...')
    );

    openModal(
      '📋 سجل العمليات الإدارية',
      [
        h('p', { class: 'muted', style: 'font-size:0.88rem;margin-bottom:12px;line-height:1.6;' },
          'يسجل السيستم كافة الحركات الحساسة (تجميد أو إلغاء الاشتراكات، حذف الأعضاء، تعديل كلمات المرور، والنسخ الاحتياطي) لضمان الشفافية ومتابعة العمليات بدقة.'
        ),
        container
      ],
      () => {},
      'إغلاق'
    );

    api('GET', '/api/audit-logs').then(logs => {
      const actionLabels = {
        login_success: 'تسجيل دخول ناجح',
        login_failed: 'محاولة دخول فاشلة',
        subscription_created: 'إضافة اشتراك',
        subscription_cancelled: 'إلغاء اشتراك',
        subscription_frozen: 'تجميد اشتراك',
        member_deleted: 'أرشفة عضو',
        archive_member: 'أرشفة عضو',
        archive_attendance: 'أرشفة حضور',
        archive_employee: 'أرشفة موظف',
        archive_private_training: 'أرشفة برايفت',
        add_expense: 'تسجيل مصروف',
        manual_attendance: 'تسجيل حضور يدوي',
        change_admin_password: 'تغيير كلمة مرور المدير',
        change_staff_password: 'تغيير كلمة مرور الموظف',
        backup_created: 'نسخة احتياطية',
        backup_restored: 'استرجاع قاعدة بيانات',
        database_optimized: 'صيانة قاعدة البيانات',
        export_members_csv: 'تصدير إكسيل',
      };

      const tableRows = logs && logs.length
        ? logs.slice(0, 100).map(l =>
            h('tr', null,
              h('td', null, h('span', { class: 'badge', style: l.action.includes('delete') || l.action.includes('cancelled') ? 'background:rgba(239,68,68,0.15);color:#f87171;' : l.action.includes('frozen') ? 'background:rgba(59,130,246,0.15);color:#93c5fd;' : 'background:rgba(34, 197, 94,0.15);color:#4ade80;' }, actionLabels[l.action] || l.action)),
              h('td', null, h('b', { style: l.performed_by === 'admin' ? 'color:#4ade80;' : 'color:#93c5fd;' }, l.performed_by)),
              h('td', { style: 'max-width:320px;white-space:normal;font-size:0.86rem;color:#cbd5e1;' }, l.details),
              h('td', { class: 'muted', style: 'font-size:0.82rem;' }, fmtDateTime(l.created_at))
            )
          )
        : [h('tr', null, h('td', { class: 'empty', colspan: 4 }, 'لا توجد حركات مسجلة بعد.'))];

      container.replaceChildren(
        h('div', { class: 'table-wrap' },
          h('table', null,
            h('thead', null,
              h('tr', null,
                h('th', null, 'العملية'),
                h('th', null, 'المنفذ'),
                h('th', null, 'التفاصيل'),
                h('th', null, 'الوقت')
              )
            ),
            h('tbody', null, tableRows)
          )
        )
      );
    }).catch(e => {
      container.replaceChildren(h('div', { class: 'alert bad' }, 'تعذر تحميل السجل: ' + e.message));
    });
  }

  // كارت النسخ الاحتياطي وحماية البيانات
  const backupCard = h('div', { class: 'card', style: 'margin-bottom:20px;' });
  async function renderBackupSection() {
    try {
      const status = await api('GET', '/api/backup/status');
      const backupBtn = h('button', { class: 'btn primary' }, '⚡ أخذ نسخة احتياطية الآن');
      const downloadBtn = h('a', { class: 'btn', href: '/api/backup/download', target: '_blank', download: '' }, '💾 تحميل نسخة لجهازك / فلاشة');
      const membersPdfBtn = h('a', { class: 'btn', href: '/api/export/members.pdf', target: '_blank', download: '', style: 'background:linear-gradient(135deg,#059669,#047857);color:#fff;border:none;' }, '📄 تحميل ملف PDF للأعضاء');
      const restoreInput = h('input', { type: 'file', accept: '.db,.sqlite', style: 'display:none' });
      const restoreBtn = h('button', { class: 'btn danger' }, '🔄 استرجاع نسخة احتياطية');
      const optBtn = h('button', { class: 'btn' }, '🚀 تسريع وتنظيف النظام');
      const auditBtn = h('button', { class: 'btn' }, '📋 سجل العمليات');

      optBtn.onclick = async () => {
        optBtn.disabled = true;
        try {
          await api('POST', '/api/database/optimize', {});
          toast('تم تسريع وتنظيف ملفات النظام وقاعدة البيانات بنجاح 🚀');
        } catch (e) {
          toast(e.message, true);
        } finally {
          optBtn.disabled = false;
        }
      };

      auditBtn.onclick = () => openAuditModal();

      backupBtn.onclick = async () => {
        backupBtn.disabled = true;
        try {
          const res = await api('POST', '/api/backup/now', {});
          toast(res.message || 'تم عمل نسخة احتياطية بنجاح');
          renderBackupSection();
        } catch (e) {
          toast(e.message, true);
        } finally {
          backupBtn.disabled = false;
        }
      };



      restoreBtn.onclick = () => restoreInput.click();

      restoreInput.onchange = async () => {
        const file = restoreInput.files[0];
        if (!file) return;
        if (!confirm("⚠️ تحذير هـام جداً:\n\nاسترجاع ملف النسخة الاحتياطية (" + file.name + ") سيستبدل جميع بيانات الجيم الحالية بالبيانات الموجودة في الملف.\n\nهل أنت متأكد من المتابعة والاسترجاع؟")) {
          restoreInput.value = '';
          return;
        }
        toast('جاري استرجاع قاعدة البيانات...');
        try {
          const buf = await file.arrayBuffer();
          const res = await fetch('/api/backup/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            credentials: 'same-origin',
            body: buf,
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'فشل الاسترجاع');
          alert('✅ ' + (data.message || 'تم استرجاع قاعدة البيانات بنجاح!'));
          location.reload();
        } catch (e) {
          alert('❌ ' + e.message);
        } finally {
          restoreInput.value = '';
        }
      };

      const backupsTable = status.recentBackups && status.recentBackups.length
        ? h('div', { class: 'table-wrap', style: 'margin-top:14px;max-height:280px;overflow-y:auto;' },
            h('table', null,
              h('thead', null,
                h('tr', null,
                  h('th', null, 'اسم النسخة'),
                  h('th', null, 'الحجم'),
                  h('th', null, 'تاريخ ووقت الحفظ'),
                  h('th', { style: 'text-align:center' }, 'إجراء')
                )
              ),
              h('tbody', null,
                status.recentBackups.map(b => {
                  const restoreSavedBtn = h('button', {
                    class: 'btn small danger',
                    style: 'font-size:0.8rem;padding:4px 10px;',
                    onclick: async () => {
                      if (!confirm(`⚠️ تأكيد استرجاع النسخة المحفوظة:\n\n(${b.name})\n\nسيتم استبدال البيانات الحالية ببيانات هذه النسخة، هل تريد المتابعة؟`)) return;
                      restoreSavedBtn.disabled = true;
                      toast('جاري استرجاع النسخة الاحتياطية...');
                      try {
                        const res = await api('POST', '/api/backup/restore-saved', { filename: b.name });
                        alert('✅ ' + (res.message || 'تم استرجاع قاعدة البيانات بنجاح!'));
                        location.reload();
                      } catch (err) {
                        alert('❌ ' + err.message);
                      } finally {
                        restoreSavedBtn.disabled = false;
                      }
                    }
                  }, '🔄 استرجاع هذه النسخة');

                  return h('tr', null,
                    h('td', { class: 'mono', style: 'color:#4ade80;font-size:0.88rem' }, b.name),
                    h('td', null, Math.round(b.size / 1024) + ' كيلوبايت'),
                    h('td', { class: 'muted', style: 'font-size:0.85rem' }, fmtDateTime(b.mtime)),
                    h('td', { style: 'text-align:center' }, restoreSavedBtn)
                  );
                })
              )
            )
          )
        : h('div', { class: 'muted', style: 'margin-top:10px;font-size:0.9rem' }, 'لا توجد نسخ احتياطية مسجلة بعد.');

      backupCard.replaceChildren(
        h('h2', { style: 'color:#4ade80;display:flex;align-items:center;gap:8px;' }, '💾 النسخ الاحتياطي وحماية البيانات من الضياع'),
        h('p', { class: 'muted', style: 'font-size:0.92rem;margin-bottom:14px;line-height:1.7' },
          'السيستم يحفظ نسخة احتياطية تلقائياً يومياً، وجميع سجلات الحضور والاشتراكات والمصروفات محمية ضد الحذف النهائي (تُؤرشف فقط). يمكنك تحميل ملف PDF منظم يحتوي على جميع الأعضاء وبياناتهم بضغطة زر.'
        ),
        h('div', { class: 'row', style: 'gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap;' },
          backupBtn,
          downloadBtn,
          membersPdfBtn,
          restoreBtn,
          optBtn,
          auditBtn,
          restoreInput
        ),
        h('div', { style: 'background:rgba(20,24,35,0.7);border:1px solid rgba(34, 197, 94,0.2);border-radius:10px;padding:12px 16px;margin-bottom:12px;font-size:0.9rem;' },
          status.safeDir
            ? h('div', { style: 'margin-bottom:6px' }, h('b', { style: 'color:#4ade80' }, '🛡️ مسار الحفظ في البارتشن الآمن (خارج C تماماً): '), h('code', { class: 'mono', style: 'color:#4ade80' }, status.safeDir))
            : '',
          h('div', null, h('b', { style: 'color:#cbd5e1' }, '📁 مسار النسخ الاحتياطي الداخلي للنظام: '), h('code', { class: 'mono', style: 'color:#4ade80' }, status.primaryDir))
        ),
        h('h3', { style: 'font-size:0.95rem;margin:14px 0 6px;' }, '🕒 آخر النسخ الاحتياطية المحفوظة تلقائياً:'),
        backupsTable
      );
    } catch (e) {
      backupCard.replaceChildren(h('div', { class: 'alert bad' }, 'تعذر تحميل حالة النسخ الاحتياطي: ' + e.message));
    }
  }

  // كارت شؤون الموظفين والمرتبات
  const empCard = h(
    'div',
    { class: 'card', style: 'margin-bottom:20px;' },
    h(
      'div',
      { style: 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;' },
      h(
        'div',
        null,
        h('h2', { style: 'margin:0 0 6px 0;' }, '👔 شؤون الموظفين والمرتبات'),
        h(
          'p',
          { class: 'muted', style: 'margin:0;font-size:0.9rem;' },
          'إضافة ومتابعة الموظفين والمدربين، وتحديد المرتبات الشهرية وحساب إجمالي المصروفات.'
        )
      ),
      h('a', { class: 'btn primary', href: '#/employees' }, 'فتح صفحة الموظفين 👈')
    )
  );

  renderBackupSection();

  app.replaceChildren(
    h('div', { class: 'page-head' },
      h(
        'div',
        { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;' },
        backBtn('#/', 'الرئيسية'),
        h('h1', { style: 'margin:0;' }, '⚙️ الإعدادات وحماية البيانات')
      )
    ),
    empCard,
    backupCard,
    adminCard,
    staffCard
  );
}

// ---------- الراوتر ----------
async function route() {
  const full = location.hash || '#/';
  const [pathPart, query = ''] = full.split('?');
  renderNav(pathPart);
  try {
    let m;
    if (pathPart === '#/' || pathPart === '#') await pageDashboard();
    else if (pathPart === '#/members') await pageMembers(query);
    else if ((m = pathPart.match(/^#\/members\/(\d+)$/))) await pageMember(m[1]);
    else if (pathPart === '#/private') await pagePrivateTrainings(query);
    else if (pathPart === '#/attendance') await pageAttendance();
    else if (pathPart === '#/expenses') await pageExpenses(query);
    else if (pathPart === '#/daily-report') await pageDailyReport(query);
    else if (pathPart === '#/monthly-report') await pageMonthlyReport(query);
    else if (pathPart === '#/employees') await pageEmployees();
    else if (pathPart === '#/plans') await pagePlans();
    else if (pathPart === '#/reminders') await pageReminders();
    else if (pathPart === '#/settings') await pageSettings();
    else app.replaceChildren(h('div', { class: 'empty' }, 'الصفحة غير موجودة'));
  } catch (e) {
    app.replaceChildren(h('div', { class: 'alert bad' }, e.message));
  }
}

(async function init() {
  try {
    ME = await api('GET', '/api/me');
  } catch {
    return; // api() بيحوّل لصفحة الدخول
  }
  if (ME.gymName) {
    document.title = `${ME.gymName} — نظام الإدارة`;
    const brandEl = document.getElementById('brand');
    if (brandEl) {
      brandEl.replaceChildren(
        h('img', { src: '/hulkgym-logo.jpg', alt: ME.gymName, class: 'brand-logo' }),
        h('span', null, ME.gymName)
      );
    }
  }
  document.getElementById('logout').addEventListener('click', logout);
  window.addEventListener('hashchange', route);
  route();
})();

