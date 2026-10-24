// admin.html: who uses the app, what broke, and what users wrote (GET /api/admin/summary).
// Signs in with the app's own session (localStorage "auth"); the server checks ADMIN_EMAILS.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  };
  var num = function (n) { return Number(n || 0).toLocaleString('th-TH'); };
  var when = function (t) {
    return t ? new Date(t).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' }) : '–';
  };
  var dayLabel = function (d) { return new Date(d + 'T12:00:00+07:00').toLocaleDateString('th-TH', { day: 'numeric', month: 'short', timeZone: 'Asia/Bangkok' }); };

  var KINDS = { bug: '🐞 ใช้งานไม่ได้', station: '📍 ข้อมูลสถานีผิด', idea: '💡 อยากให้มี', other: '💬 อื่น ๆ' };
  var ACTIONS = {
    app: 'เปิดแอปผู้ให้บริการ', nav: 'นำทางทั้งเส้น', nav_leg: 'นำทางทีละช่วง', nav_stop: 'นำทางไปจุดชาร์จ', skip: 'ไม่แวะสถานี',
    swap: 'เปลี่ยนสถานี', fav: 'กดสถานีโปรด', save: 'บันทึกแผน', share: 'แชร์ลิงก์', pin: 'เลือกสถานีเอง', nudge: 'เห็นชวนสมัคร',
    nudge_go: 'กดชวนสมัคร', signin: 'เข้าสู่ระบบ', premium: 'สนใจสมาชิก', install: 'ติดตั้งบนหน้าจอ', install_no: 'ไม่ติดตั้ง',
  };
  var PROBLEMS = { broken: 'เครื่องเสีย', no_plug: 'ไม่มีหัวที่ใช้ได้', queue: 'คิวยาว', slow: 'ชาร์จช้า', closed: 'ปิด', blocked: 'รถอื่นจอดขวาง', app: 'แอปมีปัญหา', other: 'อื่น ๆ' };
  var LANGS = { th: 'ไทย', en: 'English', zh: '中文' };
  var SOURCES = { curated: 'สถานีที่รวบรวมเอง', osm: 'OpenStreetMap', ocm: 'Open Charge Map', places: 'ร้าน/ห้องน้ำรอบสถานี', user: 'สถานีที่ผู้ใช้เพิ่ม' };

  function session() { try { return JSON.parse(localStorage.getItem('auth')); } catch (e) { return null; } }

  // The app's session lasts an hour; renew it the way the app does.
  function fresh() {
    var s = session();
    if (!s || !s.access_token) return Promise.resolve(null);
    if (s.expires_at * 1000 - Date.now() > 60000) return Promise.resolve(s);
    return fetch('/api/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: s.refresh_token }) })
      .then(function (r) { return r.ok ? r.json() : null; }).then(function (n) {
        if (!n || !n.access_token) return null;
        var keep = { access_token: n.access_token, refresh_token: n.refresh_token, expires_at: n.expires_at, user: n.user || s.user };
        try { localStorage.setItem('auth', JSON.stringify(keep)); } catch (e) {}
        return keep;
      });
  }

  function api(path, opts) {
    return fresh().then(function (s) {
      if (!s) { var e = new Error('signin'); e.status = 401; throw e; }
      var o = Object.assign({}, opts);
      o.headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.access_token };
      return fetch(path, o).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) { var e = new Error(d.error || r.status); e.status = r.status; throw e; }
          return d;
        });
      });
    });
  }

  function stat(label, value, sub, tone) {
    return '<div class="adm-stat' + (tone ? ' is-' + tone : '') + '"><span>' + label + '</span><b>' + value + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</div>';
  }

  // People per day: one series, so no legend; hover or tap a bar for the day's numbers.
  function chart(daily) {
    var W = 720, H = 200, pad = { l: 34, r: 8, t: 12, b: 26 }, n = daily.length;
    var max = Math.max(4, Math.max.apply(null, daily.map(function (d) { return d.people; })));
    var step = Math.pow(10, Math.floor(Math.log10(max))), top = Math.ceil(max / step) * step;
    if (top / step > 5) step *= 2;
    var bw = (W - pad.l - pad.r) / n, y = function (v) { return pad.t + (H - pad.t - pad.b) * (1 - v / top); };
    var grid = '';
    for (var v = 0; v <= top; v += step) {
      grid += '<line x1="' + pad.l + '" x2="' + (W - pad.r) + '" y1="' + y(v) + '" y2="' + y(v) + '" class="adm-grid"/>' +
        '<text x="' + (pad.l - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end" class="adm-axis">' + v + '</text>';
    }
    var bars = daily.map(function (d, i) {
      var x = pad.l + i * bw, h = Math.max(0, y(0) - y(d.people)), bx = x + bw * 0.18, w = bw * 0.64;
      var r = Math.min(4, w / 2, h);
      // Rounded at the data end only, square on the baseline.
      var path = h ? 'M' + bx + ',' + y(0) + 'V' + (y(0) - h + r) + 'Q' + bx + ',' + (y(0) - h) + ' ' + (bx + r) + ',' + (y(0) - h) +
        'H' + (bx + w - r) + 'Q' + (bx + w) + ',' + (y(0) - h) + ' ' + (bx + w) + ',' + (y(0) - h + r) + 'V' + y(0) + 'Z' : '';
      var label = (n - 1 - i) % 5 === 0 ? '<text x="' + (x + bw / 2) + '" y="' + (H - 8) + '" text-anchor="middle" class="adm-axis">' + esc(dayLabel(d.day)) + '</text>' : '';
      return '<g class="adm-bar" data-i="' + i + '"><rect x="' + x + '" y="' + pad.t + '" width="' + bw + '" height="' + (H - pad.t - pad.b) + '" class="adm-hit"/>' +
        (path ? '<path d="' + path + '" class="adm-fill"/>' : '') + label + '</g>';
    }).join('');
    return '<div class="adm-chart"><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="จำนวนคนใช้ต่อวัน 30 วันล่าสุด">' + grid +
      '<line x1="' + pad.l + '" x2="' + (W - pad.r) + '" y1="' + y(0) + '" y2="' + y(0) + '" class="adm-base"/>' + bars + '</svg>' +
      '<div class="adm-tip" id="adm-tip" hidden></div></div>';
  }

  function table(head, rows) {
    return '<div class="adm-table"><table><thead><tr>' + head.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
  }

  function counts(list, labels) {
    if (!list.length) return '<p class="hint">ยังไม่มีข้อมูล</p>';
    var max = list[0].count;
    return '<ul class="adm-counts">' + list.map(function (x) {
      return '<li><span>' + esc(labels ? labels[x.key] || x.key : x.key) + '</span><i style="width:' + Math.max(2, x.count / max * 100) + '%"></i><b>' + num(x.count) + '</b></li>';
    }).join('') + '</ul>';
  }

  function render(d) {
    var langs = Object.keys(d.langs).map(function (k) { return { key: k, count: d.langs[k] }; }).sort(function (a, b) { return b.count - a.count; });
    var h = d.health || {};
    var html =
      '<section class="adm-stats">' +
        stat('คนใช้วันนี้', num(d.people.today)) +
        stat('คนใช้ 7 วัน', num(d.people.week)) +
        stat('คนใช้ 30 วัน', num(d.people.month), 'กลับมาใช้ซ้ำ ' + num(d.people.returning) + ' คน') +
        stat('วางแผน 30 วัน', num(d.plans.month), 'วันนี้ ' + num(d.plans.today) + (d.plans.failed ? ' · ไปไม่ถึง ' + num(d.plans.failed) : '')) +
        stat('บัญชีผู้ใช้', num(d.accounts.total), 'สมัครใหม่ 30 วัน ' + num(d.accounts.month)) +
        stat('ข้อความใหม่', num(d.feedbackNew), '', d.feedbackNew ? 'warn' : '') +
        stat('ข้อผิดพลาดวันนี้', num(d.errorsToday), '', d.errorsToday ? 'crit' : 'ok') +
        stat('บันทึกการชาร์จ 30 วัน', num(d.charges.month), d.charges.failed ? 'ชาร์จไม่ได้ ' + num(d.charges.failed) : '') +
      '</section>' +
      '<section class="card adm-card"><h2>คนใช้ต่อวัน <small>30 วันล่าสุด · นับเบราว์เซอร์ที่เปิดแอป (ไม่นับคนที่ปิดการส่งสถิติ)</small></h2>' + chart(d.daily) +
        '<details><summary>ดูเป็นตาราง</summary>' + table(['วัน', 'คนใช้', 'วางแผน', 'สมัครใหม่'], d.daily.slice().reverse().map(function (x) {
          return [esc(dayLabel(x.day)), num(x.people), num(x.plans), num(x.signups)];
        })) + '</details></section>' +
      '<section class="card adm-card" id="fb"><h2>ข้อความจากผู้ใช้ <small>' + num(d.feedbackNew) + ' ข้อความยังไม่เสร็จ</small></h2>' +
        (d.feedback.length ? '<ul class="adm-list">' + d.feedback.map(function (f) {
          return '<li class="' + (f.status === 'done' ? 'is-done' : '') + '"><div class="adm-list__top"><span class="adm-tag">' + esc(KINDS[f.kind] || f.kind) + '</span>' +
            '<span class="hint">' + esc(when(f.created_at)) + '</span>' +
            '<button type="button" class="btn adm-done" data-id="' + f.id + '" data-status="' + (f.status === 'done' ? 'new' : 'done') + '">' + (f.status === 'done' ? 'ทำใหม่' : '✓ เสร็จแล้ว') + '</button></div>' +
            '<p>' + esc(f.message) + '</p>' +
            '<span class="hint">' + [f.email ? '<a href="mailto:' + esc(f.email) + '">' + esc(f.email) + '</a>' : 'ไม่ได้ใส่อีเมล', f.page && 'หน้า ' + esc(f.page), f.lang && esc(LANGS[f.lang] || f.lang), f.car_id && esc(f.car_id), f.ua && esc(f.ua)].filter(Boolean).join(' · ') + '</span></li>';
        }).join('') + '</ul>' : '<p class="hint">ยังไม่มีข้อความ ผู้ใช้ส่งได้จากปุ่ม "ติดต่อเรา / แจ้งปัญหา" ท้ายหน้าแอปและในเมนูบัญชี</p>') + '</section>' +
      '<section class="card adm-card"><h2>ข้อผิดพลาดของโปรแกรม <small>14 วันล่าสุด รวมข้อความเดียวกันเป็นแถวเดียว</small></h2>' +
        (d.errors.length ? table(['ล่าสุด', 'ที่', 'ข้อความ', 'ครั้ง', 'คน', 'เครื่องล่าสุด'], d.errors.map(function (e) {
          return [esc(when(e.last)), '<span class="adm-tag' + (e.src === 'server' ? ' is-server' : '') + '">' + (e.src === 'server' ? 'เซิร์ฟเวอร์' : 'หน้าเว็บ') + '</span>',
            '<code>' + esc(e.msg) + '</code>' + (e.at ? '<br><span class="hint">' + esc(e.at) + (e.page ? ' · หน้า ' + esc(e.page) : '') + '</span>' : ''),
            num(e.count), e.src === 'server' ? '–' : num(e.people), esc(e.ua || '')];
        })) : '<p class="hint">ไม่มีข้อผิดพลาด 👍</p>') + '</section>' +
      '<section class="card adm-card"><h2>สถานีที่ผู้ใช้แจ้งว่าชาร์จไม่ได้ <small>14 วันล่าสุด</small></h2>' +
        (d.problems.length ? table(['เมื่อ', 'สถานี', 'ปัญหา', 'หมายเหตุ'], d.problems.map(function (p) {
          return [esc(when(p.created_at)), esc(p.station_name || '') + '<br><span class="hint">' + esc(p.op || '') + '</span>', esc(PROBLEMS[p.problem] || p.problem || ''), esc(p.note || '')];
        })) : '<p class="hint">ไม่มี</p>') + '</section>' +
      '<div class="adm-grid2">' +
        '<section class="card adm-card"><h2>ภาษาที่ใช้</h2>' + counts(langs, LANGS) + '</section>' +
        '<section class="card adm-card"><h2>รุ่นรถที่วางแผนมากที่สุด</h2>' + counts(d.cars) + '</section>' +
        '<section class="card adm-card"><h2>เปิดแอปผู้ให้บริการ</h2>' + counts(d.apps) + '</section>' +
        '<section class="card adm-card"><h2>ปุ่มที่กด</h2>' + counts(d.actions, ACTIONS) + '</section>' +
      '</div>' +
      '<section class="card adm-card"><h2>สถานะระบบ</h2>' + table(['', ''], [
        ['เซิร์ฟเวอร์ทำงานมาแล้ว', num(h.up) + ' นาที' + (h.commit ? ' · เวอร์ชัน ' + esc(h.commit) : '') + ' · หน่วยความจำ ' + num(h.memoryMb) + ' MB'],
        ['โควต้า Google วันนี้', h.google ? 'ใช้ ' + num(h.google.used) + ' · เหลือ ' + num(h.google.left) : 'ไม่ได้เปิด Google'],
      ].concat(Object.keys(h.stations || {}).map(function (k) {
        var s = h.stations[k];
        return [esc(SOURCES[k] || k), num(s.count) + ' แห่ง · ' + (s.at ? 'อัปเดต ' + esc(when(s.at)) : '–') + (s.note ? ' · ' + esc(s.note) : '')];
      }))) + '</section>';
    $('adm-body').innerHTML = html;
    $('adm-when').textContent = 'ข้อมูล ณ ' + when(Date.now()) + ' · อัปเดตทุก 1 นาที';
    tips(d.daily);
  }

  function tips(daily) {
    var tip = $('adm-tip'), box = tip.parentNode;
    box.addEventListener('pointermove', show);
    box.addEventListener('pointerdown', show);
    box.addEventListener('pointerleave', function () { tip.hidden = true; mark(-1); });
    function mark(i) { box.querySelectorAll('.adm-bar').forEach(function (g) { g.classList.toggle('is-on', +g.dataset.i === i); }); }
    function show(e) {
      var g = e.target.closest && e.target.closest('.adm-bar');
      if (!g) return;
      var d = daily[+g.dataset.i], rb = box.getBoundingClientRect(), rg = g.getBoundingClientRect();
      tip.innerHTML = '<b>' + esc(dayLabel(d.day)) + '</b><span>คนใช้ <b>' + num(d.people) + '</b></span><span>วางแผน ' + num(d.plans) + '</span><span>สมัครใหม่ ' + num(d.signups) + '</span>';
      tip.hidden = false;
      var x = rg.left - rb.left + rg.width / 2;
      tip.style.left = Math.max(70, Math.min(rb.width - 70, x)) + 'px';
      mark(+g.dataset.i);
    }
  }

  function fail(err) {
    var msg = err.status === 401 ? 'เข้าสู่ระบบด้วยอีเมลผู้ดูแลที่หน้าแอปก่อน (เมนู "เข้าสู่ระบบ") แล้วกลับมาที่หน้านี้'
      : err.status === 403 ? 'อีเมลนี้ยังไม่ได้เป็นผู้ดูแล: ใส่อีเมลใน Render → Environment ชื่อ ADMIN_EMAILS แล้วรอ deploy'
      : 'โหลดข้อมูลไม่ได้: ' + err.message;
    $('adm-body').innerHTML = '<section class="card adm-card"><p>' + esc(msg) + '</p>' + (err.status === 401 ? '<a class="btn btn--primary" href="./">ไปหน้าแอป</a>' : '') + '</section>';
    $('adm-when').textContent = '';
  }

  function loadAll() {
    $('adm-when').textContent = 'กำลังโหลด…';
    api('/api/admin/summary').then(render, fail);
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest('.adm-done');
    if (!b) return;
    b.disabled = true;
    api('/api/admin/feedback', { method: 'POST', body: JSON.stringify({ id: +b.dataset.id, status: b.dataset.status }) }).then(loadAll, function (err) { b.disabled = false; alert(err.message); });
  });
  $('adm-reload').addEventListener('click', loadAll);
  loadAll();
  setInterval(function () { if (!document.hidden) loadAll(); }, 60000);
})();
