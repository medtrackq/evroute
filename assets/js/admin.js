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

  var KINDS = { bug: '🐞 ใช้งานไม่ได้', station: '📍 ข้อมูลสถานีผิด', idea: '💡 อยากให้มี', car: '🚗 ขอเพิ่มรุ่นรถ', other: '💬 อื่น ๆ' };
  var ACTIONS = {
    app: 'เปิดแอปผู้ให้บริการ', nav: 'นำทางทั้งเส้น', nav_leg: 'นำทางทีละช่วง', nav_stop: 'นำทางไปจุดชาร์จ', skip: 'ไม่แวะสถานี',
    swap: 'เปลี่ยนสถานี', fav: 'กดสถานีโปรด', save: 'บันทึกแผน', share: 'แชร์ลิงก์', pin: 'เลือกสถานีเอง', nudge: 'เห็นชวนสมัคร',
    nudge_go: 'กดชวนสมัคร', signin: 'เข้าสู่ระบบ', premium: 'สนใจสมาชิก', install: 'ติดตั้งบนหน้าจอ', install_no: 'ไม่ติดตั้ง',
  };
  var PROBLEMS = { broken: 'เครื่องเสีย', no_plug: 'ไม่มีหัวที่ใช้ได้', queue: 'คิวยาว', slow: 'ชาร์จช้า', closed: 'ปิด', blocked: 'รถอื่นจอดขวาง', app: 'แอปมีปัญหา', other: 'อื่น ๆ' };
  var LANGS = { th: 'ไทย', en: 'English', zh: '中文' };
  var SOURCE_NAMES = { tiktok: 'TikTok', facebook: 'Facebook', 'fb-group': 'กลุ่ม Facebook', line: 'LINE', youtube: 'YouTube', instagram: 'Instagram', pantip: 'Pantip', google: 'Google ค้นหา', bing: 'Bing', x: 'X (Twitter)', web: 'เว็บอื่น' };
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
            (f.kind === 'car' && f.status !== 'done' ? '<button type="button" class="btn btn--soft adm-addcar" data-msg="' + esc(f.message) + '">🚗 เพิ่มรุ่นนี้ในรายชื่อ</button>' : '') +
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
      '<section class="card adm-card"><h2>คนมาจากช่องทางไหน <small>30 วันล่าสุด · นับคน (เบราว์เซอร์) ที่เข้ามาจากลิงก์ ?ref= หรือจากแอป/เว็บนั้น · คนที่พิมพ์ชื่อเว็บเองไม่นับ</small></h2>' +
        counts(d.sources || [], SOURCE_NAMES) +
        '<details><summary>ลิงก์สำหรับโพสต์แต่ละช่องทาง</summary><p class="hint">ใช้ลิงก์เหล่านี้ในโพสต์หรือ bio จะรู้ว่าแต่ละช่องทางพาคนมากี่คน ตั้งชื่อเองได้ เช่น ?ref=fb-group-byd</p><ul class="adm-links">' +
          ['tiktok', 'facebook', 'fb-group', 'line', 'youtube', 'instagram', 'pantip'].map(function (k) {
            var link = location.origin + '/?ref=' + k;
            return '<li><span>' + esc(SOURCE_NAMES[k] || k) + '</span><code>' + esc(link) + '</code><button type="button" class="btn adm-copy" data-copy="' + esc(link) + '">คัดลอก</button></li>';
          }).join('') + '</ul></details></section>' +
      '<div class="adm-grid2">' +
        '<section class="card adm-card"><h2>ภาษาที่ใช้</h2>' + counts(langs, LANGS) + '</section>' +
        '<section class="card adm-card"><h2>รุ่นรถที่วางแผนมากที่สุด</h2>' + counts(d.cars) + '</section>' +
        '<section class="card adm-card"><h2>เปิดแอปผู้ให้บริการ</h2>' + counts(d.apps) + '</section>' +
        '<section class="card adm-card"><h2>ปุ่มที่กด</h2>' + counts(d.actions, ACTIONS) + '</section>' +
      '</div>' +
      '<section class="card adm-card"><h2>สถานะระบบ</h2>' + table(['', ''], [
        ['เซิร์ฟเวอร์ทำงานมาแล้ว', num(h.up) + ' นาที' + (h.commit ? ' · เวอร์ชัน ' + esc(h.commit) : '') + ' · หน่วยความจำ ' + num(h.memoryMb) + ' MB'],
        ['โควต้า Google วันนี้', h.google ? 'ใช้ ' + num(h.google.used) + ' · เหลือ ' + num(h.google.left) : 'ไม่ได้เปิด Google'],
        ['กวาดหา PTT PluZ ทั่วประเทศ', sweepText(h.sweep)],
      ].concat(Object.keys(h.stations || {}).map(function (k) {
        var s = h.stations[k];
        return [esc(SOURCES[k] || k), num(s.count) + ' แห่ง · ' + (s.at ? 'อัปเดต ' + esc(when(s.at)) : '–') + (s.note ? ' · ' + esc(s.note) : '')];
      }))) + '</section>';
    $('adm-body').innerHTML = html;
    $('adm-when').textContent = 'ข้อมูล ณ ' + when(Date.now()) + ' · อัปเดตทุก 1 นาที';
    tips(d.daily);
  }

  var SWEEP = { running: 'กำลังกวาด', done: 'เสร็จ', capped: 'หยุดที่เพดาน', failed: 'ไม่สำเร็จ' };
  function sweepText(w) {
    if (!w) return 'ต้องเปิด Google Places และ Supabase';
    var l = w.last, next = l && l.finished_at ? new Date(Date.parse(l.finished_at) + w.everyDays * 864e5) : null;
    return (w.running ? '⏳ กำลังกวาดอยู่' + (l ? ' · ' + num(l.cursor) + '/' + num(l.cells) + ' ช่อง · ใช้ ' + num(l.calls) + ' ครั้ง' : '')
      : l ? (SWEEP[l.status] || l.status) + ' ' + esc(when(l.finished_at || l.updated_at)) + ' · ใช้ Google ' + num(l.calls) + ' ครั้ง (เพดาน ' + num(w.cap) + ')' : 'ยังไม่เคยกวาด') +
      '<br>มีสถานีจากการกวาด ' + num(w.places) + ' แห่ง (PTT PluZ ' + num(w.pluz) + ')' + (next && !w.running ? ' · รอบถัดไปราว ' + esc(when(next)) : '') +
      (w.running ? '' : ' <button type="button" class="btn adm-sweep">เริ่มกวาดตอนนี้</button>');
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
    var c = e.target.closest('.adm-copy');
    if (c) {
      navigator.clipboard.writeText(c.dataset.copy).then(function () { c.textContent = 'คัดลอกแล้ว ✓'; setTimeout(function () { c.textContent = 'คัดลอก'; }, 1500); });
      return;
    }
    var sw = e.target.closest('.adm-sweep');
    if (sw) {
      if (!confirm('เริ่มกวาดหา PTT PluZ ทั่วประเทศตอนนี้? ใช้ Google ราว 400–1,000 ครั้ง (อยู่ในโควต้าฟรี 5,000/เดือน) ใช้เวลาราว 5–10 นาที')) return;
      sw.disabled = true;
      api('/api/admin/sweep', { method: 'POST' }).then(function () { setTimeout(loadAll, 1500); }, function (err) { sw.disabled = false; alert(err.message); });
      return;
    }
    var b = e.target.closest('.adm-done');
    if (!b) return;
    b.disabled = true;
    api('/api/admin/feedback', { method: 'POST', body: JSON.stringify({ id: +b.dataset.id, status: b.dataset.status }) }).then(loadAll, function (err) { b.disabled = false; alert(err.message); });
  });
  // ---------- car models ----------
  // The list in assets/js/cars.js (loaded on this page as window.EVCars) plus the cars table: a row
  // with a listed id corrects that model, a new id adds one, "hidden" takes one off the list.
  var BUILT = (window.EVCars || []).filter(function (c) { return c.id !== 'custom'; });
  var CF = { rows: [], editing: null };

  function carList() {
    var byId = {};
    BUILT.forEach(function (c) { byId[c.id] = { car: c, src: 'code' }; });
    CF.rows.forEach(function (r) {
      var was = byId[r.id];
      byId[r.id] = { car: r.hidden && was ? was.car : r, row: r, src: r.hidden ? 'hidden' : was ? 'edited' : 'added' };
    });
    return Object.keys(byId).map(function (k) { return byId[k]; }).sort(function (a, b) {
      return a.car.brand.localeCompare(b.car.brand, 'en', { sensitivity: 'base' }) || a.car.model.localeCompare(b.car.model, 'en');
    });
  }

  var SRC = { code: '', edited: '<span class="adm-tag">แก้ในหลังบ้าน</span>', added: '<span class="adm-tag is-new">เพิ่มในหลังบ้าน</span>', hidden: '<span class="adm-tag is-server">ซ่อนอยู่</span>' };

  function renderCars() {
    var all = carList(), q = $('car-q').value.trim().toLowerCase();
    var list = q ? all.filter(function (x) { return (x.car.brand + ' ' + x.car.model + ' ' + x.car.id).toLowerCase().indexOf(q) >= 0; }) : all;
    var shown = all.filter(function (x) { return x.src !== 'hidden'; }).length;
    $('car-count').textContent = shown + ' รุ่นที่ผู้ใช้เห็น · เพิ่มหรือแก้ที่นี่ ผู้ใช้เห็นทันที ไม่ต้องแก้โค้ดหรือ deploy';
    $('cf-brands').innerHTML = all.map(function (x) { return x.car.brand; }).filter(function (b, i, a) { return a.indexOf(b) === i; }).map(function (b) { return '<option value="' + esc(b) + '">'; }).join('');
    $('car-list').innerHTML = table(['ยี่ห้อ', 'รุ่น', 'แบต kWh', 'กินไฟ', 'DC kW', 'AC kW', 'หัวชาร์จ', '', ''], list.map(function (x) {
      var c = x.car;
      return [esc(c.brand), esc(c.model) + '<br><span class="hint">' + esc(c.id) + '</span>', esc(c.kwh), esc(c.use), esc(c.dc), esc(c.ac), esc((c.plugs || []).join(', ') || '–'),
        SRC[x.src], '<button type="button" class="btn adm-editcar" data-id="' + esc(c.id) + '">แก้ไข</button>'];
    }));
  }

  function loadCars() {
    return api('/api/admin/cars').then(function (d) { CF.rows = d.cars || []; $('adm-cars').hidden = false; renderCars(); }, function () {});
  }

  function carForm(item, fill) {
    var c = (item && item.car) || fill || {};
    CF.editing = item || null;
    $('car-form-title').textContent = item ? 'แก้ไข ' + c.brand + ' ' + c.model : 'เพิ่มรุ่นรถ';
    $('cf-brand').value = c.brand || '';
    $('cf-model').value = c.model || '';
    $('cf-id').value = item ? c.id : '';
    $('cf-id').readOnly = !!item;
    $('cf-kwh').value = c.kwh != null ? c.kwh : '';
    $('cf-use').value = c.use != null ? c.use : '';
    $('cf-dc').value = c.dc != null ? c.dc : '';
    $('cf-ac').value = c.ac != null ? c.ac : '';
    $('cf-note').value = (item && item.row && item.row.note) || (fill && fill.note) || '';
    var plugs = c.plugs || ['CCS2'];
    $('car-form').querySelectorAll('.adm-plugs input').forEach(function (b) { b.checked = plugs.indexOf(b.value) >= 0; });
    $('cf-hide').hidden = !item || item.src === 'hidden';
    $('cf-hide').textContent = item && item.src === 'added' ? 'ลบรุ่นนี้' : 'ซ่อนรุ่นนี้';
    $('cf-revert').hidden = !item || !(item.src === 'edited' || item.src === 'hidden');
    $('cf-revert').textContent = item && item.src === 'hidden' ? 'แสดงรุ่นนี้อีกครั้ง' : 'ลบการแก้ไข (กลับไปใช้ค่าเดิม)';
    $('cf-err').textContent = '';
    $('car-form').hidden = false;
    $('car-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('cf-brand').focus();
  }

  function saveCarRow(body) {
    $('cf-err').textContent = '';
    return api('/api/admin/cars', { method: 'POST', body: JSON.stringify(body) }).then(function (d) {
      CF.rows = d.cars || [];
      $('car-form').hidden = true;
      renderCars();
    }, function (err) { $('cf-err').textContent = err.message; });
  }

  function removeRow(id) {
    return api('/api/admin/cars?id=' + encodeURIComponent(id), { method: 'DELETE' }).then(function (d) {
      CF.rows = d.cars || [];
      $('car-form').hidden = true;
      renderCars();
    }, function (err) { $('cf-err').textContent = err.message; });
  }

  // "ขอเพิ่มรุ่น: AVATR 12 Long Range · แบต 89 kWh · กินไฟ 17.5 · DC 240 kW · CCS2" from the app.
  function fromRequest(msg) {
    var m = /^ขอเพิ่มรุ่น: (.+?) · แบต ([\d.]+) kWh · กินไฟ ([\d.]+) · DC ([\d.]+) kW · (.+)$/.exec(msg) || [];
    var name = (m[1] || '').split(' ');
    return { brand: name.shift() || '', model: name.join(' '), kwh: m[2], use: m[3], dc: m[4], plugs: [/GB/.test(m[5] || '') ? 'GBT' : m[5] === 'CHAdeMO' ? 'CHAdeMO' : 'CCS2'], note: 'จากคำขอผู้ใช้ ตรวจสเปกก่อนบันทึก' };
  }

  $('car-q').addEventListener('input', renderCars);
  $('car-new').addEventListener('click', function () { carForm(null); });
  $('cf-cancel').addEventListener('click', function () { $('car-form').hidden = true; });
  $('car-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var it = CF.editing;
    saveCarRow({
      id: $('cf-id').value.trim(), brand: $('cf-brand').value, model: $('cf-model').value,
      kwh: $('cf-kwh').value, use: $('cf-use').value, dc: $('cf-dc').value, ac: $('cf-ac').value, note: $('cf-note').value,
      plugs: [].map.call($('car-form').querySelectorAll('.adm-plugs input:checked'), function (b) { return b.value; }),
      hidden: false, _was: it && it.src,
    });
  });
  $('cf-hide').addEventListener('click', function () {
    var it = CF.editing;
    if (!it) return;
    if (it.src === 'added') { if (confirm('ลบ ' + it.car.brand + ' ' + it.car.model + ' ออกจากรายชื่อ?')) removeRow(it.car.id); return; }
    if (confirm('ซ่อน ' + it.car.brand + ' ' + it.car.model + ' จากรายชื่อ? (เช่น เลิกขายแล้ว) ผู้ที่เลือกรุ่นนี้ไว้จะกลับไปที่รุ่นแรกของรายชื่อ')) {
      saveCarRow({ id: it.car.id, brand: it.car.brand, model: it.car.model, hidden: true });
    }
  });
  $('cf-revert').addEventListener('click', function () { if (CF.editing) removeRow(CF.editing.car.id); });
  document.addEventListener('click', function (e) {
    var b = e.target.closest('.adm-editcar');
    if (b) { carForm(carList().filter(function (x) { return x.car.id === b.dataset.id; })[0]); return; }
    var r = e.target.closest('.adm-addcar');
    if (r) carForm(null, fromRequest(r.dataset.msg));
  });

  $('adm-reload').addEventListener('click', loadAll);
  loadAll();
  loadCars();
  setInterval(function () { if (!document.hidden) loadAll(); }, 60000);
})();
