(function () {
  'use strict';

  var P = window.EVPlan, CARS = window.EVCars;
  // Dates and numbers in the page's language (assets/js/i18n.js translates the words).
  var I18N = window.I18N || { lang: 'th', locale: 'th-TH', t: function (x) { return x; } };
  var LOC = I18N.locale;

  // server.mjs proxies both; the public services also send CORS headers, so direct calls are the fallback.
  var ROUTE_URLS = ['/api/route', 'https://valhalla1.openstreetmap.de/route'];
  var GEO_URLS = ['/api/geocode?q=', 'https://photon.komoot.io/api/?limit=5&bbox=97.3,5.6,105.7,20.5&q='];
  var MAX_GMAPS_WAYPOINTS = 9;  // Google Maps URL limit (mobile apps may honour only 3)
  var MOBILE_WAYPOINTS = 3;
  var MAX_DESTS = 5;
  var MAX_ROUTE_POINTS = 20;    // public Valhalla's location limit
  var BOLT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>';

  var R = {
    stations: [], operators: {}, ready: null,
    a: null, dests: [null], round: false, car: null, busy: false,
    pinned: [], excluded: {}, result: null, chart: 'soc', reported: {}, reports: {},
  };
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue('--' + name).trim(); }
  function getJSON(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); });
  }
  function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  // ---------- what broke ----------
  // Errors in this page go to the admin page (the message and where, nothing the user typed), at most
  // five different ones per visit. Those before the server's settings arrive wait for them.
  var ERR = { n: 0, seen: {}, queue: [] };
  function reportError(msg, at) {
    msg = String(msg || '').slice(0, 300);
    if (!msg || msg === 'Script error.' || ERR.seen[msg] || ERR.n >= 5) return;
    ERR.seen[msg] = 1;
    ERR.n++;
    var d = { msg: msg, at: at || null, page: document.body.dataset.view || null, lang: I18N.lang, ua: uaShort(), dev: devId() };
    if (R.cfg) send('error', d); else ERR.queue.push(d);
  }
  window.addEventListener('error', function (e) {
    if (e.message) reportError(e.message, (e.filename || '').split('/').pop() + ':' + e.lineno + ':' + e.colno);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    reportError('unhandled: ' + (r && r.message || r), r && r.stack ? String(r.stack).split('\n')[1] : null);
  });

  // Browser and system only, e.g. "Chrome 126 · Android".
  function uaShort() {
    var u = navigator.userAgent, b = u.match(/(Line|FBAN|Instagram|SamsungBrowser|Edg|OPR|CriOS|FxiOS|Firefox|Chrome|Version)\/?\s?(\d+)/);
    var os = /iPhone|iPad/.test(u) ? 'iOS' : /Android/.test(u) ? 'Android' : /Windows/.test(u) ? 'Windows' : /Mac OS/.test(u) ? 'Mac' : /Linux/.test(u) ? 'Linux' : 'other';
    var name = b ? (b[1] === 'Version' ? 'Safari' : b[1] === 'CriOS' ? 'Chrome' : b[1] === 'FxiOS' ? 'Firefox' : b[1] === 'FBAN' ? 'Facebook' : b[1]) + ' ' + b[2] : 'other';
    return name + ' · ' + os;
  }

  // Where this visit came from, for the admin page: a link's ?ref= (or utm_source), else the app or
  // site that sent it. Those parameters come off the address so a link shared on doesn't carry them.
  var ARRIVE = (function () {
    var u = new URL(location.href), q = u.searchParams, ua = navigator.userAgent, src = null;
    var given = (q.get('ref') || q.get('utm_source') || '').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 30);
    if (given) src = given;
    else if (/FBAN|FBAV|FB_IAB/.test(ua) || q.has('fbclid')) src = 'facebook';
    else if (/Instagram/.test(ua)) src = 'instagram';
    else if (/musical_ly|TikTok|BytedanceWebview/i.test(ua) || q.has('ttclid')) src = 'tiktok';
    else if (/\bLine\//.test(ua)) src = 'line';
    else if (document.referrer) {
      var host = '';
      try { host = new URL(document.referrer).hostname.replace(/^www\./, ''); } catch (e) {}
      if (host && host !== location.hostname) {
        src = /facebook\.com|fb\.com/.test(host) ? 'facebook' : /tiktok/.test(host) ? 'tiktok' : /line\.me/.test(host) ? 'line'
          : /instagram/.test(host) ? 'instagram' : /youtube|youtu\.be/.test(host) ? 'youtube' : /pantip/.test(host) ? 'pantip'
          : /google\./.test(host) ? 'google' : /bing\.com/.test(host) ? 'bing' : /(^|\.)(t\.co|x\.com|twitter\.com)$/.test(host) ? 'x' : 'web';
      }
    }
    var had = false;
    ['ref', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'ttclid'].forEach(function (k) { if (q.has(k)) { q.delete(k); had = true; } });
    if (had) history.replaceState(history.state, '', u.pathname + (q.toString() ? '?' + q.toString() : '') + u.hash);
    return src;
  })();

  // A random id per browser, to count how many people use the app ("เริ่มรหัสใหม่" makes a new one).
  function devId() {
    var d = load('dev');
    if (!/^d-[a-z0-9]{8}$/.test(d || '')) {
      var r = '';
      while (r.length < 8) r += Math.random().toString(36).slice(2);
      d = 'd-' + r.slice(0, 8);
      store('dev', d);
    }
    return d;
  }

  function radio(name) { var el = document.querySelector('input[name="' + name + '"]:checked'); return el ? el.value : null; }
  function setRadio(name, v) {
    var el = document.querySelector('input[name="' + name + '"][value="' + v + '"]');
    if (el) el.checked = true;
  }

  // ---------- map ----------
  // Created at start-up by MapView (Leaflet, or Google Maps when Google Places is on).
  var map, routeLayer, candLayer, stopLayer;
  var pins = {};

  // Destinations are lettered from B: dests[0] = B, dests[1] = C ...
  function letter(i) { return String.fromCharCode(66 + i); }
  function pinClass(i) { return i === 'a' ? 'a' : i === 0 ? 'b' : 'd'; }

  function pin(which, p) {
    var key = String(which);
    if (pins[key]) pins[key].remove();
    pins[key] = p ? map.pin(p.lat, p.lng, {
      html: '<span class="pin pin--' + pinClass(which) + '">' + (which === 'a' ? 'A' : letter(which)) + '</span>', z: 1000, tooltip: p.label,
    }) : null;
  }

  // The places the trip visits after A, in order; a round trip ends back at A.
  function trip() {
    var dests = R.dests.filter(Boolean);
    var targets = dests.map(function (p, i) { return { lat: p.lat, lng: p.lng, label: p.label, letter: letter(R.dests.indexOf(p)) }; });
    if (R.round && R.a && dests.length) targets.push({ lat: R.a.lat, lng: R.a.lng, label: R.a.label, letter: 'A', home: true });
    return { dests: dests, targets: targets, end: targets[targets.length - 1] || null, round: R.round };
  }

  // ---------- car ----------
  function brands() {
    var seen = [];
    CARS.forEach(function (c) { if (seen.indexOf(c.brand) < 0) seen.push(c.brand); });
    // A to Z, with "อื่น ๆ" (a model not on the list) last.
    return seen.sort(function (a, b) { return (a === 'อื่น ๆ') - (b === 'อื่น ๆ') || a.localeCompare(b, 'en', { sensitivity: 'base' }); });
  }

  function fillModels(brand, pick) {
    var list = CARS.filter(function (c) { return c.brand === brand; });
    $('model').innerHTML = list.map(function (c) { return '<option value="' + c.id + '">' + esc(c.model) + '</option>'; }).join('');
    if (pick && list.some(function (c) { return c.id === pick; })) $('model').value = pick;
  }

  function setCar(id, tuned) {
    var base = CARS.filter(function (c) { return c.id === id; })[0] || CARS[0];
    $('brand').value = base.brand;
    fillModels(base.brand, base.id);
    var t = tuned && tuned.id === base.id ? tuned : {};
    // "ไม่มีรุ่นของฉัน": the driver's own brand, model and socket.
    var mine = base.id === 'custom' && t.brand && t.model;
    R.car = {
      id: base.id, brand: mine ? t.brand : base.brand, model: mine ? t.model : base.model, ac: base.ac,
      plugs: mine ? (t.plug ? [t.plug] : []) : base.plugs.slice(), named: !!mine,
      kwh: +t.kwh || base.kwh, use: +t.use || base.use, dc: t.dc != null ? +t.dc : base.dc,
      margin: t.margin != null ? +t.margin : MARGIN,
    };
    showSpec();
    showPhoto();
  }

  // Reads the tile inputs while they're open for editing (a draft, kept only when "บันทึก" is
  // pressed); otherwise saves the current car.
  function readTune() {
    var c = R.car, n = function (id, lo, hi, def) { var v = $(id) ? parseFloat($(id).value) : NaN; return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; };
    c.kwh = n('kwh', 10, 200, c.kwh);
    c.use = n('use', 8, 40, c.use);
    c.dc = n('dc', 0, 400, c.dc);
    c.margin = n('margin', 0, 50, c.margin);
    if (!R.tuning) saveCar();
    $('range-km').textContent = Math.round(rangeKm(100));
    syncRange();
  }

  function saveCar() {
    var c = R.car, s = { id: c.id, kwh: c.kwh, use: c.use, dc: c.dc, margin: c.margin };
    if (c.named) { s.brand = c.brand; s.model = c.model; s.plug = c.plugs[0] || ''; }
    store('car', s);
  }

  // The model's own figures, and whether the car has been changed from them.
  var MARGIN = 10;
  function factory() {
    var c = R.car, m = load('mycar');
    // A car entered under "ไม่มีรุ่นของฉัน": the figures the driver typed in are its own.
    if (c.id === 'custom' && c.named && m && m.brand === c.brand && m.model === c.model) return { kwh: m.kwh, use: m.use, dc: m.dc };
    return CARS.filter(function (x) { return x.id === c.id; })[0] || c;
  }
  function isTuned() {
    var c = R.car, f = factory();
    return c.kwh !== f.kwh || c.use !== f.use || c.dc !== f.dc || c.margin !== MARGIN;
  }

  function rangeKm(soc) {
    return soc / 100 * R.car.kwh / (R.car.use / 100 * (1 + R.car.margin / 100));
  }

  var ICONS = {
    bat: '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="16" height="10" rx="2"/><path d="M21 11v2M7 10v4M11 10v4"/></svg>',
    use: '<svg viewBox="0 0 24 24"><path d="M5 18a8 8 0 1 1 14 0"/><path d="M12 14l4-4"/></svg>',
    dc: '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
    road: '<svg viewBox="0 0 24 24"><path d="M8 3 5 21M16 3l3 18M12 5v2M12 11v2M12 17v2"/></svg>',
    time: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>',
    flag: '<svg viewBox="0 0 24 24"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>',
  };

  function tile(color, icon, k, v, unit, sub) {
    return '<div class="tile tile--' + color + '"><span class="tile__ico" aria-hidden="true">' + ICONS[icon] + '</span>' +
      '<span class="tile__k">' + k + '</span><span class="tile__v">' + v + (unit ? '<small>' + unit + '</small>' : '') + '</span>' +
      (sub ? '<span class="tile__sub">' + sub + '</span>' : '') + '</div>';
  }

  // The same tile, adjustable for "ปรับค่ารถ": swipe right to raise the value, left to lower it (or use
  // the arrow keys); a tap types the number instead. The value sits in a hidden input readTune() reads.
  // lo..hi is the stretch the bar covers (the usual values); min..max are the hard limits.
  function editTile(color, icon, k, id, v, unit, min, max, step, sub, drag, lo, hi) {
    return '<div class="tile tile--' + color + ' is-edit is-scrub" role="slider" tabindex="0" aria-label="' + k + ' (ลากแถบ ปัดซ้ายขวา หรือกดลูกศร)" aria-valuemin="' + min + '" aria-valuemax="' + max + '" aria-valuenow="' + v + '"' +
      ' data-for="' + id + '" data-min="' + min + '" data-max="' + max + '" data-lo="' + lo + '" data-hi="' + hi + '" data-step="' + step + '" data-drag="' + drag + '">' +
      '<span class="tile__ico" aria-hidden="true">' + ICONS[icon] + '</span>' +
      '<span class="tile__k">' + k + '</span><span class="tile__v"><b class="tile__num">' + v + '</b><small>' + unit + '</small></span>' +
      (sub ? '<span class="tile__sub">' + sub + '</span>' : '') +
      '<span class="tile__track" aria-hidden="true"><i style="width:' + barPct(v, lo, hi) + '%"></i><b style="left:' + barPct(v, lo, hi) + '%"></b></span>' +
      '<span class="tile__hint" aria-hidden="true">‹ ปัด ›</span><input type="hidden" id="' + id + '" value="' + v + '"></div>';
  }

  function barPct(v, lo, hi) { return (Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * 100).toFixed(1); }

  function scrubSet(el, v) {
    var min = +el.dataset.min, max = +el.dataset.max, step = +el.dataset.step;
    v = +(Math.min(max, Math.max(min, Math.round(v / step) * step))).toFixed(step < 1 ? 1 : 0);
    $(el.dataset.for).value = v;
    var num = el.querySelector('.tile__num');
    if (num) num.textContent = v;
    el.setAttribute('aria-valuenow', v);
    var p = barPct(v, +el.dataset.lo, +el.dataset.hi) + '%';
    el.querySelector('.tile__track i').style.width = p;
    el.querySelector('.tile__track b').style.left = p;
    readTune();
  }

  // Tapping a tile swaps its number for a box to type in.
  function typeIn(el) {
    var num = el.querySelector('.tile__num');
    if (!num) return;
    var box = document.createElement('input');
    box.type = 'number';
    box.inputMode = 'decimal';
    box.className = 'tile__in';
    box.value = $(el.dataset.for).value;
    box.step = el.dataset.step;
    num.replaceWith(box);
    box.focus();
    box.select();
    var done = false, commit = function () {
      if (done) return;
      done = true;
      var b = document.createElement('b');
      b.className = 'tile__num';
      box.replaceWith(b);
      var v = parseFloat(box.value);
      scrubSet(el, isFinite(v) ? v : +$(el.dataset.for).value);
      if (R.result) replan();
    };
    box.addEventListener('blur', commit);
    box.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); box.blur(); } });
  }

  function showSpec() {
    var c = R.car;
    $('car-brand').textContent = c.brand === 'อื่น ๆ' ? 'รถของคุณ' : c.brand;
    $('car-name').textContent = c.id === 'custom' && !c.named ? 'ระบุรุ่นเอง' : c.model;
    var plugs = esc(c.plugs.join(', ') || 'ไม่รองรับ DC'), range = '<span id="range-km">' + Math.round(rangeKm(100)) + '</span>';
    $('spec').innerHTML = R.tuning
      ? editTile('lav', 'bat', 'แบตที่ใช้ได้', 'kwh', c.kwh, 'kWh', 10, 200, 0.1, '', 0.5, 20, 120) +
        editTile('sun', 'use', 'กินไฟ', 'use', c.use, '/100กม.', 8, 40, 0.1, '', 0.1, 10, 30) +
        editTile('mint', 'dc', 'DC สูงสุด', 'dc', c.dc, 'kW', 0, 400, 1, plugs, 5, 0, 350) +
        editTile('sky', 'road', 'เผื่อไว้', 'margin', c.margin, '%', 0, 50, 1, 'วิ่งได้ราว ' + range + ' กม.', 1, 0, 40)
      : tile('lav', 'bat', 'แบตเตอรี่', c.kwh, 'kWh') +
        tile('sun', 'use', 'กินไฟ', c.use, '/100กม.') +
        tile('mint', 'dc', 'DC สูงสุด', c.dc || '–', c.dc ? 'kW' : '', plugs) +
        tile('sky', 'road', 'วิ่งได้ราว', range, 'กม.', 'ต่อแบตเต็ม');
    syncRange();
    showTuneNote();
  }

  // "ปรับค่ารถ" opens the tiles as a draft: "บันทึก" keeps it, "ยกเลิก" puts the saved values back,
  // and "คืนค่าโรงงาน" fills in the model's own figures (still to be saved).
  var TUNED = ['kwh', 'use', 'dc', 'margin'];
  function setTuning(on, keep) {
    var c = R.car, was = R.tuning;
    if (on && !was) R.tuneSnap = TUNED.map(function (k) { return c[k]; });
    var changed = was && R.tuneSnap && TUNED.some(function (k, i) { return c[k] !== R.tuneSnap[i]; });
    if (was && !on) {
      if (keep) { saveCar(); if (changed) toast('✓ บันทึกค่ารถแล้ว'); }
      else TUNED.forEach(function (k, i) { c[k] = R.tuneSnap[i]; });
    }
    R.tuning = on;
    $('tune-btn').setAttribute('aria-expanded', on);
    $('tune-btn').classList.toggle('is-on', on);
    $('tune-btn').querySelector('span').textContent = on ? 'บันทึก' : 'ปรับค่ารถ';
    $('tune-hint').hidden = !on;
    $('tune-cancel').hidden = !on;
    showSpec();
    if (on) document.querySelector('#spec .is-scrub').focus();
    else if (changed && R.result) replan();
  }

  // Outside the editor: say when the car isn't on its factory figures, and offer them back.
  function showTuneNote() {
    var f = factory(), tuned = !R.tuning && isTuned();
    $('tune-reset').hidden = !(R.tuning || tuned);
    $('tune-note').hidden = !tuned;
    if (tuned) {
      $('tune-note').textContent = 'ใช้ค่าที่ปรับเอง · ค่าโรงงาน: แบต ' + f.kwh + ' kWh · กินไฟ ' + f.use + '/100กม. · DC ' + (f.dc || '–') + ' kW · เผื่อไว้ ' + MARGIN + '%';
    }
  }

  function toFactory() {
    var c = R.car, f = factory();
    c.kwh = f.kwh; c.use = f.use; c.dc = f.dc; c.margin = MARGIN;
    if (R.tuning) { showSpec(); toast('ใส่ค่าโรงงานแล้ว · กด "บันทึก" เพื่อใช้ค่านี้'); return; }
    saveCar();
    showSpec();
    toast('✓ กลับไปใช้ค่าโรงงานแล้ว');
    if (R.result) replan();
  }

  // Photo of the chosen model from Wikimedia Commons, with the credit its licence asks for.
  function showPhoto() {
    if (!R.car) return; // the photo list can arrive before the car is chosen
    var img = carPhoto();
    $('photo-btn').querySelector('span').textContent = img && img.own ? 'เปลี่ยนรูปรถ' : 'รูปรถของคุณ';
    $('car-photo').hidden = !img;
    $('car-hero').classList.toggle('has-photo', !!img);
    renderHome();
    if (!img) return;
    $('car-img').src = img.thumb;
    $('car-img').alt = R.car.brand + ' ' + R.car.model;
    if (img.own) {
      $('car-credit').innerHTML = 'รูปของคุณ เก็บในเครื่องนี้เท่านั้น · <button type="button" class="link-btn" id="photo-clear">ใช้รูปมาตรฐาน</button>';
      return;
    }
    $('car-credit').innerHTML = 'ภาพ: <a href="' + esc(img.page) + '" target="_blank" rel="noopener">' + esc(img.artist || 'Wikimedia Commons') + '</a> · ' +
      (img.licenseUrl ? '<a href="' + esc(img.licenseUrl) + '" target="_blank" rel="noopener">' + esc(img.license) + '</a>' : esc(img.license)) + ' · ภาพประกอบ อาจไม่ใช่รุ่นย่อยหรือปีเดียวกัน';
  }

  function unit() { return radio('unit'); }
  function startSoc() {
    var v = parseFloat($('soc').value);
    if (!isFinite(v) || v <= 0) return null;
    return unit() === 'km' ? P.kmToSoc(v, R.car) : Math.min(100, v);
  }

  // ---------- battery gauge ----------
  // A 270° dial from bottom left (0%) round to bottom right (100%), like a speedometer. It shows the
  // battery at departure and the "แวะชาร์จ" / "ชาร์จถึง" levels, and dragging on it sets the battery.
  var G = { cx: 120, cy: 120, r: 92, a0: 135, sweep: 270 };

  function gPoint(f, r) {
    var a = (G.a0 + G.sweep * f) * Math.PI / 180;
    return [G.cx + (r || G.r) * Math.cos(a), G.cy + (r || G.r) * Math.sin(a)];
  }

  function gArc(f) {
    var p0 = gPoint(0), p1 = gPoint(Math.max(0.0001, f));
    return 'M' + p0[0].toFixed(1) + ' ' + p0[1].toFixed(1) + 'A' + G.r + ' ' + G.r + ' 0 ' + (G.sweep * f > 180 ? 1 : 0) + ' 1 ' + p1[0].toFixed(1) + ' ' + p1[1].toFixed(1);
  }

  function gMark(el, f) {
    var a = gPoint(f, G.r - 13), b = gPoint(f, G.r + 13);
    el.setAttribute('x1', a[0]); el.setAttribute('y1', a[1]); el.setAttribute('x2', b[0]); el.setAttribute('y2', b[1]);
  }

  function drawTicks() {
    var html = '';
    for (var i = 0; i <= 20; i++) {
      var f = i / 20, major = i % 4 === 0, a = gPoint(f, G.r + 17), b = gPoint(f, G.r + (major ? 25 : 21));
      html += '<line class="gauge__tick' + (major ? ' is-major' : '') + '" x1="' + a[0].toFixed(1) + '" y1="' + a[1].toFixed(1) + '" x2="' + b[0].toFixed(1) + '" y2="' + b[1].toFixed(1) + '"/>';
      if (major) {
        var t = gPoint(f, G.r - 28);
        html += '<text class="gauge__label" x="' + t[0].toFixed(1) + '" y="' + (t[1] + 4).toFixed(1) + '">' + (i * 5) + '</text>';
      }
    }
    $('gauge-ticks').innerHTML = html;
    $('gauge-track').setAttribute('d', gArc(1));
  }

  // Name kept from the slider it replaced: redraws the gauge from the number box, in either unit.
  function syncRange() {
    var km = unit() === 'km', soc = startSoc(), f = Math.max(0, Math.min(1, (soc || 0) / 100));
    $('gauge-fill').setAttribute('d', gArc(f));
    var k = gPoint(f);
    $('gauge-knob').setAttribute('cx', k[0]);
    $('gauge-knob').setAttribute('cy', k[1]);
    gMark($('gauge-min'), +radio('min') / 100);
    gMark($('gauge-tgt'), +radio('target') / 100);
    $('gauge').setAttribute('aria-valuenow', Math.round(soc || 0));
    $('gauge').setAttribute('aria-valuetext', soc == null ? '' : Math.round(soc) + '% วิ่งได้ราว ' + Math.round(rangeKm(soc)) + ' กม.');
    $('gauge-unit').textContent = km ? 'กม.' : '%';
    $('soc-hint').textContent = soc == null ? 'ใส่แบตที่เหลือ' : km ? '≈ ' + Math.round(soc) + '% ของแบต' : 'วิ่งได้ราว ' + Math.round(rangeKm(soc)) + ' กม.';
    $('gauge').classList.toggle('is-low', soc != null && soc <= +radio('min'));
    if (soc != null) store('soc', Math.round(soc));
  }

  // Sets the battery from a fraction of the dial (5–100%), written in the box's unit.
  function setSocFraction(f) {
    var soc = Math.max(5, Math.min(100, Math.round(f * 100)));
    $('soc').value = unit() === 'km' ? Math.round(rangeKm(soc)) : soc;
    syncRange();
  }

  function wireGauge() {
    var svg = $('gauge'), dragging = false, moved = false;
    var fromEvent = function (e) {
      var box = svg.getBoundingClientRect();
      var x = (e.clientX - box.left) / box.width * 240 - G.cx, y = (e.clientY - box.top) / box.height * 240 - G.cy;
      var rel = (Math.atan2(y, x) * 180 / Math.PI - G.a0 + 720) % 360;
      if (rel > G.sweep) rel = rel > G.sweep + (360 - G.sweep) / 2 ? 0 : G.sweep; // the gap at the bottom: nearest end
      return rel / G.sweep;
    };
    svg.addEventListener('pointerdown', function (e) {
      dragging = true;
      moved = false;
      svg.setPointerCapture(e.pointerId);
      svg.classList.add('is-drag');
      setSocFraction(fromEvent(e));
      e.preventDefault();
    });
    svg.addEventListener('pointermove', function (e) { if (dragging) { moved = true; setSocFraction(fromEvent(e)); } });
    var end = function () {
      if (!dragging) return;
      dragging = false;
      svg.classList.remove('is-drag');
      if (R.result) replan();
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('keydown', function (e) {
      var step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key];
      if (!step) return;
      e.preventDefault();
      setSocFraction(((startSoc() || 0) + step) / 100);
    });
    svg.addEventListener('keyup', function (e) { if (/Arrow|Page/.test(e.key) && R.result) replan(); });
  }


  // ---------- services ----------
  function postRoute(body, i) {
    i = i || 0;
    return fetch(ROUTE_URLS[i], { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (r.ok && d.trip) return d;
          var err = new Error(d.error || ('route ' + r.status));
          err.final = r.status === 400 || !!d.error_code;
          throw err;
        });
      })
      .catch(function (err) {
        if (!err.final && i + 1 < ROUTE_URLS.length) return postRoute(body, i + 1);
        throw err;
      });
  }

  // avoid: flooded points to keep out of (see floodRing).
  function route(points, avoid) {
    var body = {
      locations: points.map(function (p) { return { lat: p.lat, lon: p.lng, type: 'break' }; }),
      costing: 'auto', units: 'kilometers', directions_type: 'maneuvers'
    };
    if (avoid && avoid.length) body.exclude_polygons = avoid.map(floodRing);
    return postRoute(body);
  }

  function geocode(q, i) {
    i = i || 0;
    return getJSON(GEO_URLS[i] + encodeURIComponent(q)).then(function (d) {
      return (d.features || []).map(function (f) {
        var p = f.properties || {};
        var where = [p.district, p.city || p.county, p.state].filter(function (x, k, arr) { return x && x !== p.name && arr.indexOf(x) === k; });
        return { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], label: p.name || where[0] || q, sub: where.join(' · ') };
      });
    }, function (err) {
      if (i + 1 < GEO_URLS.length) return geocode(q, i + 1);
      throw err;
    });
  }

  function loadStations() {
    var ops = getJSON('data/operators.json').then(function (d) { R.operators = d; }, function () {});
    getJSON('data/prices.json').then(function (d) { R.prices = d.prices || {}; R.petrol = d.petrol || null; if (R.result) render(); renderHome(); }, function () {});
    var st = getJSON('/api/stations').then(function (d) {
      R.stations = d.stations || [];
      $('updated').textContent = 'สถานีชาร์จ ' + R.stations.length.toLocaleString(LOC) + ' แห่ง';
      $('live').className = 'live is-fresh';
    }, function (err) {
      console.error(err);
      $('updated').textContent = 'โหลดสถานีไม่สำเร็จ';
      $('live').className = 'live is-stale';
      $('notice').hidden = false;
      $('notice').textContent = 'โหลดข้อมูลสถานีชาร์จไม่สำเร็จ ลองรีเฟรชหน้าอีกครั้ง';
      throw err;
    });
    var reps = getJSON('/api/reports').then(function (d) { R.reports = (d && d.reports) || {}; }, function () {});
    return Promise.all([ops, st, reps]).then(function () { R.stations.forEach(applyReport); });
  }

  // Drivers' charging reports (from "บันทึกการชาร์จจริง"): a socket a driver charged on counts as
  // seen, with the highest power they saw, so the plan stops warning about it.
  function applyReport(st) {
    var r = R.reports[st.id];
    if (!r) return st;
    st.rep = r;
    Object.keys(r.plugs || {}).forEach(function (type) {
      var kw = +r.plugs[type] || 0, dc = type !== 'Type2';
      var p = st.plugs.filter(function (x) { return x.type === type; })[0];
      if (!p) st.plugs.push(p = { type: type, kw: kw || (dc ? 50 : 22), n: 1, dc: dc });
      else if (kw && (st.guess || !p.kw)) p.kw = kw;
      p.seen = true;
    });
    if (st.guess && st.plugs.every(function (p) { return !p.dc || p.seen; })) st.guess = false;
    return st;
  }

  // Whether to warn that this station's plug details are unconfirmed: a guess, unless a driver
  // reported charging on the very socket the plan uses (or on any socket, without one).
  function doubtful(st, plug) {
    if (!st.guess) return false;
    return plug ? !plug.seen : !st.plugs.some(function (p) { return p.seen; });
  }

  function daysAgo(t) {
    var d = Math.floor((Date.now() - t) / 864e5);
    return d <= 0 ? 'วันนี้' : d === 1 ? 'เมื่อวาน' : d + ' วันก่อน';
  }

  function repLines(st) {
    var r = st.rep;
    if (!r) return '';
    return (r.prob ? '<span class="row__warn">⚠ ผู้ใช้รายงาน (' + daysAgo(r.prob.at) + '): ' + esc(problemText(r.prob.problem)) + '</span>' : '') +
      (r.ok ? '<span class="row__good">✓ ผู้ใช้ชาร์จได้จริง ' + r.ok + ' ครั้ง · ล่าสุด ' + daysAgo(r.last) + '</span>' : '');
  }


  // ---------- plan ----------
  // While planning, the button spins and says which step it is on (a long trip takes a few seconds).
  function setBusy(on, step) {
    R.busy = on;
    $('go').disabled = on;
    $('go').classList.toggle('is-busy', on);
    $('go').querySelector('span').textContent = on ? I18N.t(step || 'กำลังวางแผน…') : I18N.t('วางแผนการเดินทาง');
    var bar = $('tripbar').querySelector('.tripbar__main span');
    if (on && bar && document.body.dataset.view === 'result') bar.textContent = I18N.t(step || 'กำลังวางแผน…');
  }
  function busyStep(step) { if (R.busy) setBusy(true, step); }

  function plan() {
    var t = trip();
    if (!R.a || !t.dests.length) { say('เลือกต้นทางและปลายทางก่อน'); return; }
    if (t.targets.length === 1 && P.km(R.a, t.end) < 1) { say('ต้นทางกับปลายทางใกล้กันเกินไป'); return; }
    readTune();
    var soc = startSoc();
    if (soc == null) { say('ใส่แบตที่เหลือตอนออกเดินทาง'); return; }
    var minSoc = +radio('min'), target = +radio('target');
    if (soc <= minSoc) { say('แบตตอนออกเดินทาง (' + Math.round(soc) + '%) ต่ำกว่าหรือเท่ากับระดับที่ตั้งให้แวะชาร์จ (' + minSoc + '%) ควรชาร์จก่อนออกเดินทาง'); return; }

    setBusy(true, 'กำลังหาเส้นทาง…');
    var box = $('result');
    box.hidden = false;
    box.innerHTML = '<span class="sk"></span><span class="sk"></span><span class="sk"></span>';
    shareURL();
    var opts = { startSoc: soc, minSoc: minSoc, targetSoc: target, pinned: R.pinned.slice(), favs: favIds(), avoid: avoidIds(), want: wants(), departClock: localClock(departAt()) };

    var fl = null, ex = R.excluded;
    R.ready.then(function () { return Promise.all([route([R.a].concat(t.targets)), loadFloods()]); }).then(function (x) {
      return avoidFloods([R.a].concat(t.targets), x[0]);
    }).then(function (x) {
      var d = x.d;
      fl = x.fl;
      ex = floodExclude(R.excluded);
      busyStep('กำลังเลือกจุดชาร์จ…');
      var prof = P.profile(d.trip.legs);
      var cands = P.candidates(prof, R.stations, R.car, { exclude: ex });
      var res = P.plan(prof, cands, R.car, opts);
      // Where our own data is thin, ask Google for the stations there and plan again. A plan that
      // still gets stuck asks again further along (up to 5 rounds within GOOGLE_MAX_POINTS searches).
      // A plan that already works only gets a few searches to improve its choices.
      var total = 0, budget = res.ok ? 3 : GOOGLE_MAX_POINTS;
      var round = function (n) {
        if (R.cfg && R.cfg.places) busyStep('กำลังหาสถานีเพิ่ม…');
        return fillGaps(prof, cands, res, opts, Math.min(6, budget)).then(function (g) {
          budget -= g.asked;
          if (!g.added) return;
          total += g.added;
          cands = P.candidates(prof, R.stations, R.car, { exclude: ex = floodExclude(R.excluded) }); // with the stations just added
          res = P.plan(prof, cands, R.car, opts);
          if (!res.ok && n < 5 && budget > 0) return round(n + 1);
        });
      };
      return round(1).then(function () {
        return findBrand(res);
      }).then(function (added) {
        if (added) {
          total += added;
          cands = P.candidates(prof, R.stations, R.car, { exclude: ex = floodExclude(R.excluded) }); // with the stations just added
          var again = P.plan(prof, cands, R.car, opts);
          if (again.ok || !res.ok) res = again;
        }
        if (total) res.googleAdded = total;
        // What stopping for food or coffee costs: the same trip planned without it.
        if (opts.want && res.ok) {
          var plain = P.plan(prof, cands, R.car, Object.assign({}, opts, { want: null }));
          if (plain.ok) res.wantExtra = Math.max(0, res.realMin - plain.realMin);
        }
        return { prof: prof, cands: cands, res: res };
      });
    }).then(function (x) {
      var prof = x.prof, cands = x.cands, res = x.res;
      res.prof = prof;
      res.cands = cands;
      res.opts = opts;
      res.trip = t;
      // Everything the car stops at on the way, in order: charging stops and the user's own destinations.
      var items = res.stops.map(function (s) { return { kind: 'stop', s: s, p: s.st, along: s.along }; })
        .concat(t.targets.slice(0, -1).map(function (p, i) { return { kind: 'dest', p: p, along: prof.cum[prof.legEnds[i]] }; }))
        .sort(function (x, y) { return x.along - y.along; });
      res.items = items;
      var departs = items.map(function (it) { return it.kind === 'stop' ? it.s.depart : null; });
      var settle = function (pr) {
        res.flood = floodResult(fl, pr, ex);
        var legs = P.replay(pr, R.car, soc, departs);
        res.final = pr;
        res.legs = legs;
        items.forEach(function (it, i) {
          it.km = legs[i].km;
          it.arrive = legs[i].arrive;
          if (it.s) { it.s.arriveReal = legs[i].arrive; it.s.kmReal = legs[i].km; }
        });
        res.arriveReal = legs[legs.length - 1].arrive;
        return res;
      };
      res.flood = floodResult(fl, prof, ex);
      if (!res.ok) return res;
      if (!res.stops.length) return settle(prof);
      if (items.length + 2 > MAX_ROUTE_POINTS) return res;
      // Route again through the chosen stations for real distances, times and battery levels.
      busyStep('กำลังคำนวณเวลาและค่าไฟ…');
      return route([R.a].concat(items.map(function (it) { return it.p; }), [t.end]), fl.avoid).then(function (d2) {
        return settle(P.profile(d2.trip.legs));
      }, function (err) {
        console.warn('route via stops failed', err);
        return res;
      });
    }).then(function (res) {
      R.result = res;
      res.pid = newPid();
      render();
      setView('result');
      logPlan(res);
    }).catch(function (err) {
      console.error(err);
      reportError('plan: ' + err.message, 'plan');
      clearResult();
      say(/no path|no suitable/i.test(err.message) ? 'ไม่พบเส้นทางรถยนต์ระหว่าง 2 จุดนี้' : 'บริการหาเส้นทางหรือข้อมูลสถานีไม่ตอบ ลองใหม่อีกครั้ง', 'crit');
    }).then(function () { setBusy(false); });
  }

  // ---------- flooded roads (from medtrackq/roadflood) ----------
  // Department of Highways and Longdo Traffic reports, and Bangkok's road sensors, through
  // /api/floods (lib/floods.mjs grades them; `block` = an EV should not drive through). A trip that
  // runs through a blocked point is routed again with a small area around each such point kept
  // out, and stations next to one are left out of the plan.
  var FLOOD_NEAR_KM = 0.15;     // a report this close to the route is on it (as in roadflood)
  var FLOOD_AREA_KM = 0.15;     // radius of the area the route is kept out of
  var FLOOD_STATION_KM = 0.3;   // a station this close to a blocked point is left out
  var FLOOD_MAX_AVOID = 10;     // public Valhalla's limit on areas to avoid
  var FLOOD_TTL = 5 * 60000;

  function loadFloods() {
    if (R.floodsAt && Date.now() - R.floodsAt < FLOOD_TTL) return Promise.resolve(R.floods);
    return getJSON('/api/floods').then(function (d) {
      R.floods = d.floods || [];
      R.floodsAt = Date.now();
      R.floodsOff = !!d.off; // switched off on the admin page
      if ($('flood-credit')) $('flood-credit').hidden = R.floodsOff;
      floodHome();
      return R.floods;
    }, function () { R.floods = R.floods || []; return R.floods; });
  }

  // A hexagon around a point, as Valhalla wants it: [lon, lat] pairs, closed.
  function floodRing(f) {
    var ring = [];
    for (var i = 0; i <= 6; i++) {
      var a = (i % 6) * Math.PI / 3;
      ring.push([+(f.lng + FLOOD_AREA_KM * Math.cos(a) / (111.32 * Math.cos(f.lat * Math.PI / 180))).toFixed(6), +(f.lat + FLOOD_AREA_KM * Math.sin(a) / 110.57).toFixed(6)]);
    }
    return ring;
  }

  // Reports on this route, in driving order: [{ f, along }].
  function floodHits(prof) {
    if (!R.floods || !R.floods.length) return [];
    var lats = prof.pts.map(function (p) { return p[0]; }), lngs = prof.pts.map(function (p) { return p[1]; });
    var s = Math.min.apply(null, lats) - 0.01, n = Math.max.apply(null, lats) + 0.01, w = Math.min.apply(null, lngs) - 0.01, e = Math.max.apply(null, lngs) + 0.01;
    var out = [];
    R.floods.forEach(function (f) {
      if (f.lat < s || f.lat > n || f.lng < w || f.lng > e) return;
      var near = P.nearest(prof.pts, prof.cum, f);
      if (near.d <= FLOOD_NEAR_KM) out.push({ f: f, along: near.along });
    });
    return out.sort(function (a, b) { return a.along - b.along; });
  }

  // Routes again around the blocked points on the way (twice at most: the way around can meet
  // others). A point at one of the trip's own places can't be avoided and isn't tried.
  // Resolves to { d: Valhalla's answer, fl: { avoid, before (the first route), extraMin, tried } }.
  function avoidFloods(points, d) {
    var fl = { avoid: [], before: null, extraMin: 0, tried: false };
    var done = function (d) {
      if (fl.before && fl.avoid.length) fl.extraMin = Math.max(0, P.profile(d.trip.legs).min - fl.before.min);
      return { d: d, fl: fl };
    };
    var step = function (d, n) {
      var prof = P.profile(d.trip.legs);
      var block = floodHits(prof).filter(function (h) {
        return h.f.block && fl.avoid.indexOf(h.f) < 0 && !points.some(function (p) { return P.km(p, h.f) < FLOOD_STATION_KM; });
      });
      if (!block.length || n >= 2 || fl.avoid.length >= FLOOD_MAX_AVOID) return done(d);
      if (!fl.before) fl.before = prof;
      fl.tried = true;
      busyStep('กำลังหาเส้นเลี่ยงน้ำท่วม…');
      var next = fl.avoid.concat(block.map(function (h) { return h.f; })).slice(0, FLOOD_MAX_AVOID);
      return route(points, next).then(function (d2) {
        fl.avoid = next;
        return step(d2, n + 1);
      }, function (err) {
        console.warn('route around floods failed', err);
        return done(d);
      });
    };
    return step(d, 0);
  }

  // The user's own exclusions plus stations next to a blocked point.
  function floodExclude(own) {
    var block = (R.floods || []).filter(function (f) { return f.block; });
    R.flooded = {};
    if (!block.length) return own;
    var ex = Object.assign({}, own);
    R.stations.forEach(function (st) {
      if (block.some(function (f) { return Math.abs(f.lat - st.lat) < 0.01 && P.km(f, st) < FLOOD_STATION_KM; })) { ex[st.id] = true; R.flooded[st.id] = true; }
    });
    return ex;
  }

  // What the plan's final route meets, for the result card, the map and Google Maps.
  function floodResult(fl, prof, ex) {
    if (!fl || !R.floods || !R.floods.length) return null;
    var hits = floodHits(prof);
    var on = hits.map(function (h) { return h.f; });
    var avoided = fl.avoid.filter(function (f) { return on.indexOf(f) < 0; });
    var skipped = Object.keys(R.flooded || {}).filter(function (id) {
      if (R.excluded[id] || !ex[id]) return false;
      var st = stationById(id);
      return st && P.nearest(prof.pts, prof.cum, st).d < 5;
    }).length;
    if (!hits.length && !avoided.length && !skipped) return null;
    // Points on the way around (well off the first route), so Google Maps takes the same way.
    var via = [];
    if (fl.before && avoided.length) {
      avoided.slice(0, 3).forEach(function (f) {
        var best = null;
        prof.pts.forEach(function (p, i) {
          if (Math.abs(p[0] - f.lat) > 0.05 || Math.abs(p[1] - f.lng) > 0.05) return;
          var off = P.nearest(fl.before.pts, fl.before.cum, { lat: p[0], lng: p[1] }).d;
          if (off > 0.3 && (!best || off > best.off)) best = { lat: p[0], lng: p[1], along: prof.cum[i], off: off, label: 'จุดผ่านเลี่ยงน้ำท่วม' };
        });
        if (best) via.push(best);
      });
    }
    return {
      hits: hits, avoided: avoided, skipped: skipped, failed: fl.tried && !fl.avoid.length, via: via,
      extraMin: fl.extraMin || 0,
    };
  }

  function floodRow(f, along, avoided) {
    var tone = avoided ? 'ok' : f.block ? 'crit' : 'warn';
    var t = Date.parse(f.confirmed);
    return '<li class="flood-row"><span class="chip chip--' + tone + '">' + (avoided ? 'เลี่ยงแล้ว' : esc(f.label)) + '</span>' +
      '<div><b translate="no">' + esc(f.title) + '</b><span translate="no">' + esc(f.place) + '</span>' +
      '<span class="hint">' + (along != null ? '<span>กม. ' + Math.round(along) + ' จากต้นทาง</span> · ' : '') + '<span>' + esc(f.src) + '</span> · <span>ยืนยันล่าสุด</span> ' +
      esc(new Date(t).toLocaleString(LOC, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) + '</span></div></li>';
  }

  function floodNote(res) {
    var f = res.flood;
    if (!f) return '';
    var block = f.hits.filter(function (h) { return h.f.block; }), wet = f.hits.filter(function (h) { return !h.f.block; });
    var html = '';
    if (f.avoided.length) {
      html += '<div class="verdict verdict--ok"><b>🌊 เลี่ยงถนนน้ำท่วมให้แล้ว</b><span>เส้นทางนี้อ้อมจุดที่ผ่านไม่ได้ ' + f.avoided.length + ' จุด</span>' +
        (f.extraMin >= 1 ? '<span>ใช้เวลาเพิ่ม ~' + dur(f.extraMin) + '</span>' : '') + '</div>';
    }
    if (block.length) {
      html += '<div class="verdict verdict--crit"><b>⛔ เส้นทางผ่านจุดน้ำท่วม ' + block.length + ' จุด</b>' +
        '<span>' + (f.failed || f.avoided.length ? 'หาเส้นเลี่ยงไม่ได้' : 'จุดนี้อยู่ใกล้ต้นทาง ปลายทาง หรือจุดแวะของคุณ') + '</span>' +
        '<span>ตรวจสอบก่อนออกเดินทาง สายด่วนกรมทางหลวง 1586 · ทางหลวงชนบท 1146</span></div>';
    }
    if (wet.length) {
      html += '<div class="verdict verdict--warn"><span>⚠️ มีน้ำบนถนน ' + wet.length + ' จุด (ผ่านได้)</span><span>ขับช้า เว้นระยะ รถ EV ไม่ควรลุยน้ำลึกเกินที่คู่มือรถกำหนด</span></div>';
    }
    if (f.skipped) html += '<p class="hint">ไม่แนะนำสถานีชาร์จที่อยู่ติดถนนน้ำท่วม ' + f.skipped + ' แห่ง</p>';
    var rows = f.hits.map(function (h) { return floodRow(h.f, h.along, false); }).concat(f.avoided.map(function (x) { return floodRow(x, null, true); }));
    if (rows.length) html += '<details class="flood-list"><summary>ดูจุดน้ำท่วม ' + rows.length + ' จุด</summary><ol class="flood-rows">' + rows.join('') + '</ol></details>';
    return html;
  }

  // Home: say when there are roads to steer around today.
  function floodHome() {
    var el = $('flood-home');
    if (!el) return;
    var n = (R.floods || []).filter(function (f) { return f.block; }).length;
    el.hidden = !n;
    if (n) el.innerHTML = '<span>🌊 วันนี้มีถนนน้ำท่วมที่ผ่านไม่ได้ ' + n + ' จุด</span> <span>EVROUTE จะพาเลี่ยงให้อัตโนมัติ</span>';
  }

  // ---------- Google gap filling ----------
  var GOOGLE_RADIUS_KM = 25;
  var GOOGLE_MAX_POINTS = 12; // searches per trip plan, across all rounds

  // Asks the server for Google's EV stations around stretches of the route where our data is
  // thin, at most `max` search circles. Each area is asked once per page visit.
  // Resolves to { added: stations added, asked: circles searched }.
  function fillGaps(prof, cands, res, opts, max) {
    var none = { added: 0, asked: 0 };
    if (!R.cfg || !R.cfg.places || max <= 0) return Promise.resolve(none);
    R.gAsked = R.gAsked || [];
    var pts = P.gapPoints(prof, cands, R.car, opts, res, GOOGLE_RADIUS_KM, 20).filter(function (p) {
      return !R.gAsked.some(function (q) { return P.km(p, q) < GOOGLE_RADIUS_KM; });
    }).slice(0, max);
    if (!pts.length) return Promise.resolve(none);
    pts.forEach(function (p) { R.gAsked.push(p); });
    return fetch('/api/google/ev', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: pts.map(function (p) { return { lat: p.lat, lng: p.lng }; }), radius: GOOGLE_RADIUS_KM * 1000 }),
    }).then(function (r) { return r.ok ? r.json() : { stations: [] }; }).then(function (d) {
      if (d.remaining === 0) R.cfg.places = null; // today's allowance is used up
      return { added: addStations(d.stations || []), asked: pts.length };
    }).catch(function () { return { added: 0, asked: pts.length }; });
  }

  // PTT's PluZ network has over a thousand sites but no public list, so ours knows few of them.
  // While testing, Google is asked by name around each planned stop (within today's allowance),
  // and the plan runs again with what it finds.
  var BRAND_RADIUS_KM = 20;
  var BRAND_MAX_POINTS = 4;
  function findBrand(res) {
    if (!R.cfg || !R.cfg.places || !res.stops.length || R.swept) return Promise.resolve(0); // the monthly sweep has them all
    R.bAsked = R.bAsked || [];
    var pts = res.stops.map(function (s) { return { lat: s.st.lat, lng: s.st.lng }; }).filter(function (p) {
      return !R.bAsked.some(function (q) { return P.km(p, q) < BRAND_RADIUS_KM; });
    }).slice(0, BRAND_MAX_POINTS);
    if (!pts.length) return Promise.resolve(0);
    pts.forEach(function (p) { R.bAsked.push(p); });
    return fetch('/api/google/ev', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: pts, radius: BRAND_RADIUS_KM * 1000, brand: 'pluz' }),
    }).then(function (r) { return r.ok ? r.json() : { stations: [] }; }).then(function (d) {
      if (d.remaining === 0) R.cfg.places = null;
      return addStations(d.stations || []);
    }).catch(function () { return 0; });
  }

  // PluZ stations from the server's monthly sweep of Google Places, shown with the Google map only
  // (Google's data may not be shown on another map).
  function loadSwept() {
    R.ready.then(function () { return getJSON('/api/google/swept'); }).then(function (d) {
      var n = addStations(d.stations || []);
      R.swept = (d.stations || []).length;
      if (n && R.result && !R.busy) replan();
      else if (n) renderHome();
    }).catch(function () {});
  }

  // Adds stations for this visit only. One within 120 m of a station we know is the same site:
  // its connector details replace a guessed list, otherwise it's skipped.
  function addStations(list) {
    var added = 0;
    list.forEach(function (st) {
      var same = R.stations.filter(function (o) { return Math.abs(o.lat - st.lat) < 0.002 && P.km(o, st) < 0.12; })[0];
      if (!same) { R.stations.push(applyReport(st)); added++; return; }
      if (same.guess && !st.guess) { same.plugs = st.plugs; same.guess = false; }
      if (st.url && !same.url) same.url = st.url;
    });
    return added;
  }

  // Google asks for a link back to its place page wherever its data is shown.
  function googleLink(st) {
    return st.url ? '<a class="glink" href="' + esc(st.url) + '" target="_blank" rel="noopener">ข้อมูลจาก Google Maps</a>' : '';
  }

  // ---------- favourite stations & saved plans (this browser only, no account) ----------
  var FAV_COLOR = '#f2a900';
  R.favs = load('favs') || {};

  function favIds() {
    var o = {};
    Object.keys(R.favs).forEach(function (id) { o[id] = true; });
    return o;
  }

  // Stations whose newest driver report (last 14 days) says charging failed: the planner avoids them.
  function avoidIds() {
    var o = {};
    Object.keys(R.reports).forEach(function (id) { if (R.reports[id].prob) o[id] = true; });
    return o;
  }

  function favButton(st) {
    var on = !!R.favs[st.id];
    return '<button type="button" class="btn fav-btn' + (on ? ' is-on' : '') + '" data-fav="' + esc(st.id) + '" aria-pressed="' + on + '">' +
      (on ? '★ สถานีโปรด' : '☆ สถานีโปรด') + '</button>';
  }

  function toggleFav(id) {
    if (R.favs[id]) delete R.favs[id];
    else {
      var st = R.stations.filter(function (x) { return x.id === id; })[0];
      R.favs[id] = st ? { name: st.name, lat: st.lat, lng: st.lng } : { name: id };
    }
    store('favs', R.favs);
    if (R.result) replan(); // favourites change which stations the plan prefers
  }

  var MAX_SAVED = 20;
  function savedPlans() { return load('plans') || []; }
  function isSaved() { return savedPlans().some(function (p) { return p.q === location.search; }); }

  function savePlan() {
    var res = R.result;
    if (!res) return;
    shareURL();
    var q = location.search, t = totals(res), route = routeKey(q), dep = $('depart').value;
    // The same trip saved again for a new date replaces its old, past copy; future dates stay separate.
    var list = savedPlans().filter(function (p) { return p.q !== q && !(routeKey(p.q) === route && !upcoming(p)); });
    list.unshift({
      q: q, title: tripTitle(res.trip), from: R.a.label, car: R.car.brand + ' ' + R.car.model,
      km: Math.round(t.km), stops: res.stops.length, at: new Date().toISOString(), dep: dep || '',
      cost: res.cost != null ? Math.round(res.cost) : null, mins: Math.round(t.total),
    });
    store('plans', list.slice(0, MAX_SAVED));
    renderSaved();
    pushTrips();
    var b = $('save-plan');
    if (b) b.textContent = '★ บันทึกแล้ว';
    var card = b && b.closest('.nav-card');
    if (card && !card.querySelector('.nudge')) card.insertAdjacentHTML('beforeend', nudge('save'));
  }

  function routeKey(q) {
    var u = new URLSearchParams(q);
    u.delete('dep');
    return u.toString();
  }

  function upcoming(p) { return !!p.dep && new Date(p.dep).getTime() > Date.now(); }

  // Trips with a date ahead first (soonest first), then the rest, newest saved first.
  function renderSaved() {
    var list = savedPlans().map(function (p, i) { return { p: p, i: i }; }).sort(function (x, y) {
      var a = upcoming(x.p), b = upcoming(y.p);
      if (a !== b) return a ? -1 : 1;
      if (a) return new Date(x.p.dep) - new Date(y.p.dep);
      return x.i - y.i;
    });
    $('saved-btn').hidden = !list.length;
    $('saved-count').textContent = list.length ? '(' + list.length + ')' : '';
    if (!list.length) $('saved-list').hidden = true;
    $('saved-list').innerHTML = list.map(function (x) {
      var p = x.p, ahead = upcoming(p), when = p.dep ? new Date(p.dep).getTime() : NaN;
      var tag = ahead ? '<span class="saved-when is-ahead">เดินทาง ' + esc(thaiDate(when, true)) + '</span>'
        : isFinite(when) ? '<span class="saved-when">เคยเดินทาง ' + esc(thaiDate(when)) + ' · กดเพื่อใช้อีกครั้ง</span>'
        : '<span class="saved-when">ยังไม่ระบุวัน · บันทึก ' + esc(new Date(p.at).toLocaleDateString(LOC, { day: 'numeric', month: 'short' })) + '</span>';
      return '<li><a href="' + esc(p.q) + '"><b>' + esc(p.title) + '</b>' + tag + '<span>จาก ' + esc(p.from) + ' · ' + esc(p.car) + ' · ' + p.km + ' กม. · ชาร์จ ' + p.stops + ' จุด</span></a>' +
        '<button type="button" class="saved-del" data-unsave="' + x.i + '" aria-label="ลบแผนนี้">×</button></li>';
    }).join('') + (list.length && accountsOn() && !signedIn()
      ? '<li class="saved-foot">เก็บในเครื่องนี้ · <button type="button" class="link-btn" data-acct-open="saved">เข้าสู่ระบบเพื่อใช้ทุกเครื่อง</button></li>' : '');
    renderHome();
  }

  function replan() { if (R.a && trip().dests.length && !R.busy) plan(); }

  // ---------- render ----------
  function dur(min) {
    var m = Math.round(min);
    return m < 60 ? m + ' นาที' : Math.floor(m / 60) + ' ชม.' + (m % 60 ? ' ' + (m % 60) + ' นาที' : '');
  }
  function pct(v) { return Math.round(v) + '%'; }
  function km1(v) { return v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString(LOC); }
  // Arrival time, minutes after departure; with the date when that isn't today.
  function clock(minAfterStart) {
    var d = new Date(departAt() + minAfterStart * 60000);
    var t = d.toLocaleTimeString(LOC, { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? t : d.toLocaleDateString(LOC, { weekday: 'short', day: 'numeric', month: 'short' }) + ' ' + t;
  }

  // ---------- what to stop for ----------
  // Food, coffee, toilets, shops: stations that have them are preferred when they cost little
  // extra time (plan.js). Remembered in this browser.
  var WANTS = { food: '🍜 กินข้าว', cafe: '☕ กาแฟ', wc: '🚻 ห้องน้ำ', shop: '🛍 ห้าง/ร้านค้า' };
  R.want = load('want') || {};

  function wants() {
    var w = {}, any = false;
    Object.keys(WANTS).forEach(function (k) { if (R.want[k]) { w[k] = true; any = true; } });
    return any ? w : null;
  }

  function showWants() {
    document.querySelectorAll('[data-want]').forEach(function (b) { b.setAttribute('aria-pressed', R.want[b.dataset.want] ? 'true' : 'false'); });
    $('want-note').textContent = R.want.food
      ? 'ระบบจะเลือกจุดชาร์จที่มีให้ ถ้าไม่ต้องอ้อมไกล · กินข้าว: จุดที่ถึงช่วงมื้ออาหาร (เช้า กลางวัน เย็น) ตามเวลาออกเดินทาง'
      : 'ระบบจะเลือกจุดชาร์จที่มีให้ ถ้าไม่ต้องอ้อมไกล';
  }

  document.querySelectorAll('[data-want]').forEach(function (b) {
    b.addEventListener('click', function () {
      R.want[b.dataset.want] = !R.want[b.dataset.want];
      store('want', R.want);
      showWants();
    });
  });
  showWants();

  // Minutes after midnight on the clock the departure time was picked with.
  function localClock(t) { var d = new Date(t); return d.getHours() * 60 + d.getMinutes(); }

  // What is within a short walk of a station, with a link to restaurants nearby on Wongnai.
  var CAFE_RE = /café|cafe|coffee|amazon|starbucks|inthanin|punthai|กาแฟ|คาเฟ่/i;
  var SHOP_RE = /eleven|lawson|family|lotus|tops|cj|big ?c|mart|เซเว่น/i;

  function amenityLine(st, food) {
    var am = st.am;
    if (!am) return food ? '<span class="row__am">' + wongnaiLink(st) + '</span>' : '';
    var named = function (re, fallback) { return esc(am.names.filter(function (n) { return re.test(n); })[0] || fallback); };
    var parts = [];
    if (am.mall) parts.push('🛍 <b>' + (am.guess ? 'ในห้าง' : esc(am.mall)) + '</b>');
    if (am.food) parts.push('🍜 ร้านอาหาร' + (am.guess || am.food < 2 ? '' : ' ' + am.food + ' ร้าน'));
    if (am.cafe) parts.push('☕ ' + named(CAFE_RE, 'กาแฟ'));
    if (am.shop && !am.mall) parts.push('🏪 ' + named(SHOP_RE, 'ร้านสะดวกซื้อ'));
    if (am.wc) parts.push('🚻 ห้องน้ำ');
    return '<span class="row__am">' + parts.join(' · ') + (am.guess ? ' <span class="hint">(น่าจะมี)</span>' : '') +
      (food ? ' ' + wongnaiLink(st) : '') + '</span>';
  }

  function wongnaiLink(st) {
    return '<a href="' + wongnai(st) + '" target="_blank" rel="noopener">ร้านอาหารแถวนี้ (Wongnai) ›</a>';
  }

  function wongnai(st) {
    return 'https://www.wongnai.com/businesses?domain=1&spatialInfo.coordinate.latitude=' + st.lat.toFixed(5) + '&spatialInfo.coordinate.longitude=' + st.lng.toFixed(5) + '&spatialInfo.radius=1';
  }

  // ---------- departure time ----------
  // Empty box = leaving now. A date ahead prices each stop at the hour the car gets there and
  // shows arrival times for that day.
  function departAt() {
    var t = $('depart').value ? new Date($('depart').value).getTime() : NaN;
    return isFinite(t) && t > Date.now() ? t : Date.now();
  }

  function localInput(t) {
    var d = new Date(t - new Date(t).getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 16);
  }

  function thaiDate(t, withTime) {
    var d = new Date(t);
    return d.toLocaleDateString(LOC, { weekday: 'short', day: 'numeric', month: 'short', year: '2-digit' }) +
      (withTime ? ' ' + d.toLocaleTimeString(LOC, { hour: '2-digit', minute: '2-digit' }) + ' น.' : '');
  }

  function showDepart() {
    var v = $('depart').value, t = v ? new Date(v).getTime() : NaN, ahead = isFinite(t) && t > Date.now();
    $('depart-now').hidden = !v;
    $('depart-note').textContent = !v ? 'ตอนนี้ · เลือกวันเวลาล่วงหน้าได้ ค่าไฟและเวลาถึงจะคิดตามวันนั้น'
      : ahead ? thaiDate(t, true) + ' · อีก ' + aheadText(t - Date.now())
      : 'เวลานี้ผ่านไปแล้ว ระบบคิดเป็นออกตอนนี้ เลือกวันใหม่ได้';
  }

  function aheadText(ms) {
    var h = ms / 36e5;
    return h < 1 ? Math.max(1, Math.round(h * 60)) + ' นาที' : h < 48 ? Math.round(h) + ' ชั่วโมง' : Math.round(h / 24) + ' วัน';
  }

  // Button that opens the operator's app. Android: an intent link launches the installed app
  // and falls back to its Play Store page. iPhone: the operators publish no app links, so it goes
  // to the App Store page, whose "Open" button launches the app when it's installed.
  function appUrl(o) {
    var ua = navigator.userAgent;
    if (/android/i.test(ua) && o.android) {
      var store = 'https://play.google.com/store/apps/details?id=' + encodeURIComponent(o.android);
      return { url: 'intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=' + o.android +
        ';S.browser_fallback_url=' + encodeURIComponent(store) + ';end', blank: false };
    }
    if (/iphone|ipad|ipod/i.test(ua) && o.ios) return { url: o.ios, blank: false };
    return { url: o.web, blank: true };
  }

  function appLink(st) {
    var o = R.operators[st.op];
    if (!o) return '';
    var u = appUrl(o);
    return '<a class="btn btn--soft" href="' + esc(u.url) + '"' + (u.blank ? ' target="_blank" rel="noopener"' : '') + evAttr('app', st) + '>' +
      'เปิดแอป ' + esc(o.app || o.name) + '</a>';
  }

  // Booking a charger in the operator's app. data/operators.json: booking (the app can), bookAhead
  // (calendar days that can be booked, today included: 2 = today and tomorrow), bookNote.
  // A trip further ahead than that gets told when booking opens.
  function bookingInfo(st) {
    var o = R.operators[st.op];
    if (!o || !o.booking) return null;
    var dep = departAt(), today = bkkDay(Date.now()), day = bkkDay(dep);
    var ahead = Math.round((Date.parse(day) - Date.parse(today)) / 864e5);
    var opens = o.bookAhead ? new Date(Date.parse(day + 'T12:00:00+07:00') - (o.bookAhead - 1) * 864e5) : null;
    return { app: o.app || o.name, note: o.bookNote || '', near: !!o.bookNear, later: !!(o.bookAhead && ahead > o.bookAhead - 1), opens: opens };
  }

  function bookLine(st) {
    var b = bookingInfo(st);
    if (!b) return '';
    return b.later
      ? '<span class="row__book is-later">📅 ' + esc(I18N.t('จองล่วงหน้าได้ในแอป')) + ' ' + esc(b.app) + (b.note ? ' (' + esc(I18N.t(b.note)) + ')' : '') +
        ' · ' + esc(I18N.t('ทริปนี้จองได้ตั้งแต่')) + ' ' + esc(b.opens.toLocaleDateString(LOC, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Bangkok' })) + '</span>'
      : '<span class="row__book">📅 ' + esc(I18N.t(b.near ? 'จองได้ในแอป' : 'จองหัวชาร์จล่วงหน้าได้ในแอป')) + ' ' + esc(b.app) + (b.note ? ' (' + esc(I18N.t(b.note)) + ')' : '') + '</span>';
  }

  // At the top of the plan: the stops that can only be booked closer to the day.
  function bookNote(res) {
    var later = res.stops.map(function (s) { return bookingInfo(s.st); }).filter(function (b) { return b && b.later; });
    if (!later.length) return '';
    var b = later.sort(function (x, y) { return x.opens - y.opens; })[0];
    return '<div class="verdict verdict--warn book-note">📅 ' + esc(I18N.t('มีจุดชาร์จที่จองล่วงหน้าได้ใกล้วันเดินทางเท่านั้น')) + ' · ' +
      esc(I18N.t('จองในแอป')) + ' ' + esc(b.app) + ' ' + esc(I18N.t('ได้ตั้งแต่')) + ' ' + esc(b.opens.toLocaleDateString(LOC, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Bangkok' })) + '</div>';
  }

  // Operator apps can't be opened at a given station, so "จองผ่านแอป" copies a search word for the
  // app's search box. Operators name sites their own way ("พีทีทีอาร์เอ็ม สาขาอินทร์บุรี กม.104"),
  // but their names and addresses carry the district, so that finds the site in a few results.
  // "เมือง…" districts are in every province, so there the subdistrict is used instead.
  var BRANDS = /PEA\s*VOLTA|EV\s*Station\s*PluZ|PluZ|PTT|ปตท\.?|EleXA|Elex(\s*by\s*EGAT)?|EGAT|EA\s*Anywhere|E[Vv]olt|Altervim|MEA\s*EV|Sharge|Shell\s*Recharge|Tesla\s*Supercharger|สถานีชาร์จ(ไฟฟ้า)?|ปั๊ม(น้ำมัน)?|(EV\s*)?Charg(ing|e)\s*Station|\bEV\b/gi;

  function placeName(st) {
    var n = String(st.name || '').replace(/\([^)]*\)/g, ' ').replace(BRANDS, ' ').replace(/[·\-–]+/g, ' ').replace(/\s+/g, ' ').trim();
    return n.length >= 2 ? n : '';
  }

  function searchKey(st) {
    var a = String(st.addr || '');
    var amphoe = /(?:อำเภอ|อ\.)\s*([^\s,]+)/.exec(a) || /เขต\s*([^\s,]+)/.exec(a);
    var tambon = /(?:ตำบล|ต\.|แขวง)\s*([^\s,]+)/.exec(a);
    var generic = /^(ใน)?เมือง/, area = st.area || {};
    if (amphoe && !generic.test(amphoe[1])) return amphoe[1];
    if (amphoe && tambon && !generic.test(tambon[1])) return tambon[1];
    // No district in the address: what /api/area found from the station's position, if it's back.
    if (!amphoe && area.amphoe && !generic.test(area.amphoe)) return area.amphoe;
    if (!amphoe && area.sub && !generic.test(area.sub)) return area.sub;
    return placeName(st) || (tambon && tambon[1]) || st.name;
  }


  // Stations in the plan whose address has no district: look it up from their position, so the
  // word copied by "เปิดแอป" is ready by the time it's tapped.
  function fillAreas(res) {
    res.stops.forEach(function (s) {
      var st = s.st;
      if (st.area !== undefined || /(?:อำเภอ|อ\.|เขต)\s*\S/.test(st.addr || '')) return;
      st.area = null;
      getJSON('/api/area?lat=' + st.lat + '&lng=' + st.lng).then(function (a) { st.area = a; }, function () {});
    });
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (ok, fail) {
      var t = document.createElement('textarea');
      t.value = text;
      t.setAttribute('readonly', '');
      t.style.cssText = 'position:fixed;opacity:0;top:0';
      document.body.appendChild(t);
      t.select();
      var done = false;
      try { done = document.execCommand('copy'); } catch (e) {}
      t.remove();
      if (done) ok(); else fail(new Error('copy failed'));
    });
  }

  var toastTimer;
  function toast(html, ms) {
    var el = $('toast');
    el.innerHTML = html;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, ms || 4000);
  }

  // The subdistrict, to tell apart the few stations the search word finds.
  function pickHint(st, key) {
    var m = /(ตำบล|ต\.|แขวง)\s*([^\s,]+)/.exec(st.addr || '');
    if (m && m[2] !== key) return 'เลือกสถานีที่ ' + (m[1] === 'แขวง' ? 'แขวง' : 'ต.') + m[2];
    var place = placeName(st);
    return place && place !== key ? 'เลือกสถานี “' + place + '”' : 'เลือกสถานีที่ตรงกับแผน';
  }

  function openApp(a, st, e) {
    e.preventDefault();
    var name = searchKey(st), href = a.href, pick = pickHint(st, name);
    // A new tab must open inside the tap or the browser blocks it; an app or store link in the same
    // tab waits a moment so the copy finishes and the driver sees what was copied.
    if (a.target === '_blank') window.open(href, '_blank', 'noopener');
    copyText(name).then(function () {
      toast('คัดลอก <b>“' + esc(name) + '”</b> แล้ว<br>ในแอป: แตะช่องค้นหา → วาง → ' + esc(pick), 8000);
    }, function () {
      toast('ในแอป: ค้นหาคำว่า <b>“' + esc(name) + '”</b><br>→ ' + esc(pick), 8000);
    }).then(function () {
      if (a.target !== '_blank') setTimeout(function () { location.href = href; }, 1600); // time to read the toast
    });
  }

  // Map popup for a station: details plus the same actions as its row in the plan.
  function popupActions(st, extra) {
    return '<div class="popup-acts">' + appLink(st) + favButton(st) +
      // No origin: Google Maps starts from where the phone is now.
      '<a class="btn" href="https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + (+st.lat).toFixed(6) + ',' + (+st.lng).toFixed(6) + '" target="_blank" rel="noopener"' + evAttr('nav_stop', st) + '>นำทางไปที่นี่</a>' + (extra || '') + '</div>';
  }

  function plugText(st) {
    if (!st.plugs || !st.plugs.length) return 'ไม่ทราบหัวชาร์จ';
    var dc = st.plugs.filter(function (p) { return p.dc; }).map(function (p) {
      return p.type + (p.kw ? ' ' + p.kw + ' kW' : '') + (p.n > 1 ? ' ×' + p.n : '');
    });
    var ac = st.plugs.filter(function (p) { return !p.dc; }).length ? ' · มี AC' : '';
    return (dc.length ? 'DC ' + dc.join(', ') : 'AC เท่านั้น') + ac;
  }

  function gmapsDir(from, to, via) {
    var ll = function (p) { return (+p.lat).toFixed(6) + ',' + (+p.lng).toFixed(6); };
    var url = 'https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=' + ll(from) + '&destination=' + ll(to);
    if (via && via.length) url += '&waypoints=' + encodeURIComponent(via.map(ll).join('|'));
    return url;
  }

  function totals(res) {
    var drive = res.final ? res.final.min : res.driveMin;
    return {
      km: res.final ? res.final.km : res.km,
      drive: drive,
      // The route through the stations already includes driving into them; the first-pass
      // estimate does not, so add the planner's detour minutes there.
      total: drive + (res.chargeMin || 0) + (res.final ? 0 : res.detourMin || 0),
      arrive: res.arriveReal != null ? res.arriveReal : res.arrive,
      kwh: res.stops.reduce(function (s, x) { return s + x.kwhAdded; }, 0),
    };
  }

  // Two cards above the map: destination + verdict, and a trip track with the stops on it.
  function tripTitle(tr) {
    var first = tr.dests[0].label;
    if (tr.round) return 'ไป-กลับ ' + first + (tr.dests.length > 1 ? ' +' + (tr.dests.length - 1) + ' จุด' : '');
    return tr.end.label + (tr.dests.length > 1 ? ' (ผ่าน ' + (tr.dests.length - 1) + ' จุด)' : '');
  }

  function summary(res) {
    var t = totals(res);
    if (!res.ok) {
      return '<div class="sum-card sum-card--bad"><span class="sum-card__ico">' + BOLT + '</span><div class="sum-card__main">' +
        '<span class="sum-card__title">' + esc(tripTitle(res.trip)) + '</span>' +
        '<span class="sum-card__sub">' + km1(res.km) + ' กม. <span class="chip chip--crit">ไปไม่ถึง</span></span></div></div>' + track(res, t);
    }
    var chip = !res.stops.length ? '<span class="chip">ไม่ต้องแวะชาร์จ</span>'
      : '<span class="chip">' + BOLT.replace('<svg', '<svg width="12" height="12" fill="currentColor"') + ' แวะ ' + res.stops.length + ' จุด</span>';
    return '<div class="sum-card"><span class="sum-card__ico">' + BOLT + '</span><div class="sum-card__main">' +
      '<span class="sum-card__title">' + esc(tripTitle(res.trip)) + '</span>' +
      '<span class="sum-card__sub">' + dur(t.total) + ' · ' + km1(t.km) + ' กม. ' + chip + '</span></div></div>' + track(res, t);
  }

  function track(res, t) {
    var len = res.final ? res.final.km : res.km;
    var stops = res.stops.map(function (s) {
      var k = s.kmReal != null ? s.kmReal : s.along;
      return '<span class="track__stop" style="left:' + (k / len * 100).toFixed(1) + '%" title="' + esc(s.st.name) + '"></span>';
    }).join('') + (res.items || []).filter(function (it) { return it.kind === 'dest'; }).map(function (it) {
      var k = it.km != null ? it.km : it.along;
      return '<span class="track__dest" style="left:' + (k / len * 100).toFixed(1) + '%" title="' + esc(it.p.label) + '"></span>';
    }).join('');
    return '<div class="sum-card track"><div class="track__line"><span class="track__bar"></span>' +
      '<svg class="track__car" viewBox="0 0 30 16" aria-hidden="true"><path fill="currentColor" d="M4 9.5 7 5c.6-.8 1.5-1.2 2.5-1.2h8.2c1 0 2 .4 2.6 1.2L23.5 9H26c1.6 0 3 1.3 3 2.9V13h-2.2a2.8 2.8 0 0 0-5.5 0H9.7a2.8 2.8 0 0 0-5.5 0H1v-1.4C1 10.4 2.4 9.5 4 9.5z"/></svg>' +
      stops +
      '<svg class="track__flag" viewBox="0 0 18 24" aria-hidden="true"><path fill="currentColor" d="M2 0h2v24H2zM4 1h12l-3 4.5L16 10H4z"/></svg></div>' +
      '<div class="track__nums"><span><b>' + km1(t.km) + '</b> กม.</span><span><b>' + dur(t.total) + '</b></span><span>ถึง <b>' + clock(t.total) + '</b></span></div></div>';
  }

  function failText(res) {
    var f = res.fail, c = R.car;
    var where = f.at ? 'หลังชาร์จที่ <b>' + esc(f.at.name) + '</b> (กม. ' + km1(f.along) + ')' : 'จากต้นทาง';
    return '<div class="verdict verdict--crit"><b>ไปไม่ถึงด้วยสถานีชาร์จที่มีข้อมูล</b>' +
      '<span>' + where + ' วิ่งได้ถึงราว กม. ' + km1(f.reach) + ' แต่ไม่มีสถานีชาร์จ DC ที่ใช้กับ ' + esc(c.plugs.join('/') || 'รถคันนี้') + ' ในระยะที่ไปถึง (เส้นทางยาว ' + km1(res.km) + ' กม.)</span>' +
      '<span class="hint">ลองชาร์จให้เต็มกว่านี้ ตั้ง "ชาร์จถึง" สูงขึ้น ลด "แวะชาร์จเมื่อเหลือ" หรือหาสถานีในแอปผู้ให้บริการ (ข้อมูลสถานีของเรายังไม่ครบทุกเครือข่าย)</span>' +
      '<button type="button" class="btn btn--soft" data-addopen>รู้จักสถานีแถวนี้? เพิ่มสถานีชาร์จ</button></div>';
  }

  function stopRow(s, i, res, prev) {
    var st = s.st, arrive = s.arriveReal != null ? s.arriveReal : s.arrive;
    var off = s.c.off < 0.15 ? 'ติดเส้นทาง' : 'ห่าง ' + km1(s.c.off) + ' กม.';
    var a = Math.max(0, Math.min(100, arrive));
    var alts = s.alts.length ? '<details class="alts"><summary>เปลี่ยนสถานี (' + s.alts.length + ')</summary><ul>' +
      s.alts.map(function (x) {
        return '<li><button type="button" class="alt" data-swap="' + i + '" data-id="' + esc(x.c.st.id) + '">' +
          '<b>' + esc(x.c.st.name) + '</b><span>' + esc(x.c.st.op || '') + ' · ' + x.c.kw + ' kW · กม. ' + km1(x.c.along) + ' · ถึงแล้วเหลือ ~' + pct(x.arrive) + (doubtful(x.c.st, x.c.plug) ? ' · ยังไม่ยืนยันหัวชาร์จ' : '') + (x.c.st.rep && x.c.st.rep.prob ? ' · ⚠ มีรายงานปัญหา' : '') + '</span></button></li>';
      }).join('') + '</ul></details>' : '';
    return '<li class="row" data-lat="' + st.lat + '" data-lng="' + st.lng + '">' +
      '<div class="row__top"><span class="row__n">' + (i + 1) + '</span>' +
        '<div class="row__main"><span class="row__name">' + esc(st.name) + (s.meal && res.opts && res.opts.want && res.opts.want.food ? '<span class="tag tag--meal">🍜 ' + esc(s.meal) + '</span>' : '') + (s.pinned ? '<span class="tag">เลือกเอง</span>' : '') + (R.favs[st.id] ? '<span class="tag tag--fav">★ โปรด</span>' : '') + userTag(st) + '</span>' +
        '<span class="row__meta">กม. ' + km1(s.kmReal != null ? s.kmReal : s.along) + ' · ' + off + ' · ' + esc(st.op || 'ไม่ทราบผู้ให้บริการ') + '</span></div>' +
        '<span class="row__kwh"><span class="bolt">' + BOLT + '</span>+' + Math.round(s.kwhAdded) + ' kWh</span></div>' +
      '<div class="row__body">' +
        '<div class="socbar" role="img" aria-label="แบตถึง ' + pct(arrive) + ' ชาร์จถึง ' + pct(s.depart) + '">' +
          '<span class="socbar__a" style="width:' + a + '%"></span><span class="socbar__c" style="left:' + a + '%;width:' + Math.max(0, s.depart - a) + '%"></span></div>' +
        '<span>ถึง <b>' + pct(arrive) + '</b> → ชาร์จถึง <b>' + pct(s.depart) + '</b> · ~' + dur(s.chargeMin + P.PLUG_MIN) + ' (' + Math.round(s.c.kw) + ' kW)' + costText(s.cost) + '</span>' +
        repLines(st) +
        bookLine(st) +
        amenityLine(st, !!(res.opts && res.opts.want && res.opts.want.food)) +
        (st.url ? '<span class="row__addr">' + googleLink(st) + '</span>' : '') + // Google's data shows with its credit
        '<div class="row__acts">' +
          appLink(st) +
          '<a class="btn" href="' + gmapsDir(prev, st) + '" target="_blank" rel="noopener"' + evAttr('nav_stop', st) + '>นำทาง</a>' +
        '</div>' + '<div class="report-slot"></div>' +
        // Details and less used actions fold away so the plan reads as a short timeline.
        '<details class="row__more"><summary>รายละเอียด · ตัวเลือก' + (doubtful(st, s.c.plug) ? ' <span class="row__doubt">ⓘ ยังไม่ยืนยันหัวชาร์จ</span>' : '') + '</summary>' +
          '<span class="row__plug">' + esc(plugText(st)) + '</span>' +
          (doubtful(st, s.c.plug) ? '<span class="row__addr">ข้อมูลหัวชาร์จหรือกำลังไฟยังไม่มีคนยืนยัน ตรวจในแอปผู้ให้บริการก่อน</span>' : '') +
          (st.addr ? '<span class="row__addr">' + esc(st.addr) + '</span>' : '') +
          (st.hours ? '<span class="row__addr">เวลาเปิด: ' + esc(st.hours) + '</span>' : '') +
          '<span class="row__addr">' + wongnaiLink(st) + '</span>' +
          (st.note ? '<span class="row__addr">หมายเหตุ: ' + esc(st.note) + '</span>' : '') +
          '<div class="row__acts">' +
            favButton(st) +
            '<button type="button" class="btn" data-skip="' + esc(st.id) + '">ไม่แวะที่นี่</button>' +
            (R.cfg && R.cfg.stats ? '<button type="button" class="btn report-btn" data-report="' + i + '">' + (R.reported[st.id] ? 'บันทึกการชาร์จแล้ว ✓' : 'บันทึกการชาร์จจริง') + '</button>' : '') +
          '</div>' + alts +
        '</details>' +
      '</div></li>';
  }

  // Charging stops and the user's own destinations, in driving order.
  function itemRows(res) {
    var prev = R.a;
    return (res.items || res.stops.map(function (s) { return { kind: 'stop', s: s, p: s.st }; })).map(function (it) {
      var html = it.kind === 'stop'
        ? stopRow(it.s, res.stops.indexOf(it.s), res, prev)
        : '<li class="row row--dest" data-lat="' + it.p.lat + '" data-lng="' + it.p.lng + '"><span class="pin pin--d">' + it.p.letter + '</span><div><b>' + esc(it.p.label) + '</b>' +
          '<span>จุดหมาย · กม. ' + km1(it.km != null ? it.km : it.along) + (it.arrive != null ? ' · ถึงแล้วแบตเหลือราว ' + pct(it.arrive) : '') + '</span></div></li>';
      prev = it.p;
      return html;
    }).join('');
  }

  function resultCard(res) {
    if (!res.ok && !res.stops.length) return failText(res) + floodNote(res);
    var t = totals(res), o = res.opts;
    var low = res.legs && res.legs.some(function (l) { return l.arrive < o.minSoc - 3; });
    var html = (res.ok ? '' : failText(res)) +
      '<div class="tiles">' +
        (res.chargeMin < 60 ? tile('lav', 'time', 'ชาร์จรวม', Math.round(res.chargeMin || 0), 'นาที')
          : tile('lav', 'time', 'ชาร์จรวม', Math.floor(res.chargeMin / 60) + ':' + String(Math.round(res.chargeMin % 60)).padStart(2, '0'), 'ชม.')) +
        (res.cost != null ? tile('sun', 'dc', 'ค่าไฟโดยประมาณ', '฿' + Math.round(res.cost).toLocaleString(LOC), '', Math.round(t.kwh) + ' kWh')
          : tile('sun', 'dc', 'เติมไฟ', Math.round(t.kwh), 'kWh')) +
        tile('mint', 'flag', 'ถึงปลายทาง', res.ok ? Math.round(t.arrive) : '–', res.ok ? '%' : '') +
      '</div>' +
      floodNote(res) + wantNote(res) + bookNote(res) +
      (res.googleAdded ? '<p class="hint">เพิ่มสถานีจาก Google Maps ' + res.googleAdded + ' แห่งในช่วงที่ข้อมูลเรายังน้อย</p>' : '') +
      (low ? '<div class="verdict verdict--warn">บางช่วงแบตอาจต่ำกว่า ' + o.minSoc + '% เพราะต้องอ้อมเข้าสถานี เผื่อเวลาชาร์จเพิ่มเล็กน้อย</div>' : '') +
      '<div class="list-head"><h2>' + (res.stops.length ? 'แผนการเดินทาง · ชาร์จ ' + res.stops.length + ' จุด' : 'ไม่ต้องแวะชาร์จ') + '</h2><span class="hint">' + km1(t.km) + ' กม. · ขับ ' + dur(t.drive) + '</span></div>' +
      '<ol class="list">' +
        '<li class="row row--end"><span class="pin pin--a">A</span><div><b>' + esc(R.a.label) + '</b><span>ออกเดินทาง แบต ' + pct(o.startSoc) + '</span></div></li>' +
        itemRows(res) +
        (res.ok ? '<li class="row row--end"><span class="pin pin--' + (res.trip.end.home ? 'a' : 'b') + '">' + res.trip.end.letter + '</span><div><b>' + esc(res.trip.end.label) + '</b><span>' + (res.trip.end.home ? 'กลับถึงต้นทาง' : 'ถึงปลายทาง') + ' แบตเหลือราว ' + pct(t.arrive) + '</span></div></li>' : '') +
      '</ol>';
    if (R.pinned.length || Object.keys(R.excluded).length) {
      html += '<button type="button" class="link-btn" id="reset">ล้างการเลือกสถานีเอง แล้วให้ระบบเลือกใหม่</button>';
    }
    return html;
  }

  // How the "อยากแวะ" choices worked out for this plan.
  function wantNote(res) {
    var w = res.opts.want;
    if (!w || !res.stops.length) return '';
    var got = Object.keys(w).filter(function (k) {
      return res.stops.some(function (s) {
        var am = s.st.am;
        return am && (k === 'food' ? s.meal && am.food : k === 'shop' ? am.shop || am.mall : am[k]);
      });
    });
    var miss = Object.keys(w).filter(function (k) { return got.indexOf(k) < 0; });
    var noMeal = miss.indexOf('food') >= 0 && !res.stops.some(function (s) { return P.mealAt(s.clock); });
    if (noMeal) miss.splice(miss.indexOf('food'), 1);
    var extra = res.wantExtra >= 1 ? ' · ใช้เวลาเพิ่ม ~' + dur(res.wantExtra) : got.length ? ' · ไม่เพิ่มเวลา' : '';
    var notes = [];
    if (miss.length) notes.push('ไม่มีจุดชาร์จที่มี ' + miss.map(function (k) { return WANTS[k]; }).join(' ') + (miss.indexOf('food') >= 0 ? ' ช่วงมื้ออาหาร' : '') + ' โดยไม่ต้องอ้อมไกล');
    if (noMeal) notes.push('ทริปนี้ไม่ได้แวะชาร์จตรงช่วงมื้ออาหาร');
    return '<p class="want-res">' + (got.length ? '✓ แวะได้: ' + got.map(function (k) { return WANTS[k]; }).join(' ') + extra : '') +
      (notes.length ? (got.length ? '<br>' : '') + '<span class="hint">' + notes.join(' · ') + '</span>' : '') + '</p>';
  }

  function navCard(res) {
    if (!res.ok) return '';
    // Charging stations and the user's own stops go in as Google Maps waypoints, in driving order.
    var via = (res.items || []).map(function (it) { return it.p; });
    // Points on the way around flooded roads, so Google Maps doesn't take the flooded one.
    var fv = res.flood && res.flood.via.length ? res.flood.via : [];
    if (fv.length && via.length + fv.length <= MAX_GMAPS_WAYPOINTS) {
      via = (res.items || []).map(function (it) { return { p: it.p, k: it.km != null ? it.km : it.along }; })
        .concat(fv.map(function (v) { return { p: v, k: v.along }; }))
        .sort(function (a, b) { return a.k - b.k; }).map(function (x) { return x.p; });
    } else fv = [];
    var end = res.trip.end;
    var name = function (p) { return p.name || p.label; };
    var html = '<section class="card nav-card">';
    if (via.length <= MAX_GMAPS_WAYPOINTS) {
      html += '<a class="btn btn--primary" href="' + gmapsDir(R.a, end, via) + '" target="_blank" rel="noopener" data-ev="nav">' + BOLT + 'เปิดเส้นทางทั้งหมดใน Google Maps</a>' +
        (via.length > fv.length ? '<p class="hint">จุดชาร์จ ' + res.stops.length + ' จุด' + (via.length - fv.length > res.stops.length ? ' และจุดหมายของคุณ' : '') + ' ถูกใส่เป็นจุดแวะ (Add destination) ให้แล้ว ' +
          'โดยส่งเป็นพิกัด Google Maps จึงอาจแสดงชื่อสถานที่ข้าง ๆ แทน เช่น 7-11 หรือร้านในปั๊มเดียวกัน แต่นำทางไปตำแหน่งสถานีชาร์จถูกต้อง</p>' : '') +
        (fv.length ? '<p class="hint">🌊 ใส่จุดผ่านบนเส้นเลี่ยงน้ำท่วม ' + fv.length + ' จุดให้แล้ว เพื่อให้ Google Maps ไม่พาเข้าถนนที่ท่วม</p>' : '');
    }
    if (via.length > MOBILE_WAYPOINTS || via.length > MAX_GMAPS_WAYPOINTS) {
      html += '<p class="hint">' + (via.length > MAX_GMAPS_WAYPOINTS ? 'จุดแวะเกิน ' + MAX_GMAPS_WAYPOINTS + ' จุด ซึ่ง Google Maps รับไม่ได้ ให้นำทางทีละช่วง:' : 'แอป Google Maps บนมือถือบางเครื่องรับจุดแวะได้ไม่เกิน ' + MOBILE_WAYPOINTS + ' จุด ถ้าจุดแวะหายไป ให้นำทางทีละช่วง:') + '</p><ol class="legs">';
      var pts = [R.a].concat(via, [end]);
      for (var i = 0; i + 1 < pts.length; i++) {
        html += '<li><a href="' + gmapsDir(pts[i], pts[i + 1]) + '" target="_blank" rel="noopener" data-ev="nav_leg">' + esc(name(pts[i])) + ' → ' + esc(name(pts[i + 1])) + '</a></li>';
      }
      html += '</ol>';
    }
    html += '<div class="nav-card__row"><button type="button" class="btn" id="save-plan">' + (isSaved() ? '★ บันทึกแล้ว' : '☆ บันทึกแผนนี้') + '</button>' +
      '<button type="button" class="btn" id="share">คัดลอกลิงก์แผนนี้</button></div></section>';
    return html;
  }

  // Estimated cost of each stop, at the operator's price for the hour the car gets there
  // (leaving now): on-peak or off-peak where the operator has both.
  function priceStops(res) {
    var prof = res.final || res.prof, start = departAt(), extra = 0, total = 0;
    res.stops.slice().sort(function (a, b) { return a.along - b.along; }).forEach(function (s) {
      var km = s.kmReal != null ? s.kmReal : s.along;
      var when = new Date(start + (P.at(prof, prof.tm, km) + extra) * 60000);
      s.cost = P.chargeCost(s.kwhAdded, s.st.op, R.prices, when);
      if (s.cost) total += s.cost.baht;
      extra += s.chargeMin + P.PLUG_MIN;
    });
    res.cost = R.prices ? total : null;
  }

  function costText(c) {
    if (!c) return '';
    return ' · <b>~฿' + Math.round(c.baht).toLocaleString(LOC) + '</b> <span class="hint">(' + c.rate + ' ฿/kWh' +
      (c.offPeak ? ' ช่วง Off-Peak' : '') + (c.known ? '' : ' ราคาเฉลี่ย') + ')</span>';
  }

  function render() {
    var res = R.result;
    priceStops(res);
    ['result', 'summary', 'chart-card', 'nav'].forEach(function (id) { $(id).classList.remove('is-stale'); });
    $('result').hidden = false;
    $('result').innerHTML = resultCard(res);
    $('summary').hidden = false;
    $('summary').innerHTML = summary(res);
    $('nav').innerHTML = navCard(res);
    $('chart-card').hidden = !res.ok && !res.stops.length;
    chart();
    draw();
    fillAreas(res);
    if (R.view === 'result') { renderTripbar(); showDock(); }
  }

  function clearResult() {
    R.result = null;
    $('summary').hidden = true;
    $('chart-card').hidden = true;
    $('nav').innerHTML = '';
    routeLayer.clear();
    candLayer.clear();
    stopLayer.clear();
  }

  // ---------- usage statistics ----------
  // Anonymous: car, charging plan, chosen stations and button taps, tied together by a random id per
  // plan. No name, no IP (the server doesn't store it) and trip ends rounded to about 10 km on the server.
  // Sent only when the server has statistics switched on, and not at all after "ไม่ร่วมส่งสถิติ";
  // a charging report is the driver's own choice to send, so it goes either way.
  function send(t, d, always) {
    var off = load('nostats');
    if (!R.cfg || !R.cfg.stats || (!always && off)) return;
    if (!off && R.car) d.cu = carUid(R.car.id); // a report sent after opting out isn't linked to the car
    var body = JSON.stringify({ t: t, d: d });
    // A signed-in driver's charging report goes with their token so it joins their history.
    if (t === 'charge' && accountsOn() && signedIn()) {
      authFetch('/api/log', { method: 'POST', body: body }).catch(function () {});
      return;
    }
    try { if (navigator.sendBeacon && navigator.sendBeacon('/api/log', new Blob([body], { type: 'application/json' }))) return; } catch (e) {}
    fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function () {});
  }

  // One random id per car model in this browser, made the first time it's needed. "เริ่มรหัสใหม่"
  // forgets them, so later records can't be linked to earlier ones.
  function carUid(carId) {
    var ids = load('cuids') || {};
    if (!/^c-[a-z0-9]{8}$/.test(ids[carId] || '')) {
      var r = '';
      while (r.length < 8) r += Math.random().toString(36).slice(2);
      ids[carId] = 'c-' + r.slice(0, 8);
      store('cuids', ids);
    }
    return ids[carId];
  }

  function newPid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function stationById(id) { return R.stations.filter(function (x) { return x.id === id; })[0] || null; }
  function evAttr(kind, st) { return ' data-ev="' + kind + '"' + (st ? ' data-sid="' + esc(st.id) + '"' : ''); }

  function logEvent(kind, st, ctx) {
    send('event', { kind: kind, pid: R.result && R.result.pid, sid: st ? st.id : null, op: st ? st.op : null, car: R.car && R.car.id, ctx: ctx || null });
  }

  function logPlan(res) {
    var c = R.car, base = CARS.filter(function (x) { return x.id === c.id; })[0] || c, t = totals(res), o = res.opts, end = res.trip.end;
    send('plan', {
      pid: res.pid, car: c.id, brand: c.brand, model: c.model, kwh: c.kwh, use: c.use, useBase: base.use, dc: c.dc,
      tuned: c.kwh !== base.kwh || c.use !== base.use || c.dc !== base.dc,
      soc: o.startSoc, min: o.minSoc, target: o.targetSoc,
      fromLat: R.a.lat, fromLng: R.a.lng, toLat: end.lat, toLng: end.lng, dests: res.trip.dests.length, round: !!R.round,
      km: t.km, driveMin: t.drive, chargeMin: res.chargeMin, stops: res.stops.length, kwhTotal: t.kwh, cost: res.cost,
      arrive: res.ok ? t.arrive : null, ok: !!res.ok, google: res.googleAdded || 0,
      stations: res.stops.map(function (s) {
        return {
          id: s.st.id, op: s.st.op, src: s.st.src, kw: s.c.kw, guess: !!s.st.guess, pinned: !!s.pinned,
          arrive: s.arriveReal != null ? s.arriveReal : s.arrive, depart: s.depart, kwh: s.kwhAdded,
          min: s.chargeMin + P.PLUG_MIN, baht: s.cost ? s.cost.baht : null,
        };
      }),
    });
  }

  // ---------- reporting an actual charge ----------
  var PROBLEMS = [['broken', 'ตู้เสีย / ชาร์จไม่เข้า'], ['no_plug', 'ไม่มีหัวชาร์จที่รถใช้ได้'], ['queue', 'คิวยาว'],
    ['slow', 'ชาร์จช้ากว่าที่ระบุมาก'], ['closed', 'สถานีปิด / หาไม่เจอ'], ['blocked', 'มีรถจอดขวาง'], ['app', 'แอปมีปัญหา / จ่ายเงินไม่ได้'], ['other', 'อื่น ๆ']];

  var REPORT_PLUGS = [['CCS2', 'CCS2'], ['CHAdeMO', 'CHAdeMO'], ['GBT', 'GB/T'], ['Type2', 'Type 2 (AC)'], ['Tesla', 'Tesla']];
  function problemText(code) { var p = PROBLEMS.filter(function (x) { return x[0] === code; })[0]; return p ? p[1] : 'อื่น ๆ'; }

  function numField(name, label, unit, val, max) {
    return '<label class="report__f"><span>' + label + '</span><span class="report__in"><input class="field" name="' + name + '" type="number" inputmode="decimal" min="0" max="' + max + '" step="any"' +
      (val != null ? ' value="' + Math.round(val) + '"' : '') + '><em>' + unit + '</em></span></label>';
  }

  function reportForm(s) {
    var st = s.st, arrive = s.arriveReal != null ? s.arriveReal : s.arrive;
    return '<form class="report" data-stop="' + R.result.stops.indexOf(s) + '" novalidate>' +
      '<p class="report__title">บันทึกการชาร์จจริงที่ <b>' + esc(st.name) + '</b></p>' +
      '<div class="report__seg" role="radiogroup"><label><input type="radio" name="ok" value="1" checked><span>ชาร์จได้</span></label>' +
        '<label><input type="radio" name="ok" value="0"><span>ชาร์จไม่ได้</span></label></div>' +
      '<div class="report__grid" data-when="ok">' +
        '<label class="report__f"><span>หัวที่ใช้</span><select class="field" name="plug">' +
          REPORT_PLUGS.map(function (p) { return '<option value="' + p[0] + '"' + (s.c.plug && s.c.plug.type === p[0] ? ' selected' : '') + '>' + p[1] + '</option>'; }).join('') + '</select></label>' +
        numField('socFrom', 'แบตก่อนชาร์จ', '%', Math.max(0, arrive), 100) +
        numField('socTo', 'แบตหลังชาร์จ', '%', s.depart, 100) +
        numField('kwh', 'ไฟที่ได้', 'kWh', null, 250) +
        numField('baht', 'จ่ายไป', '฿', null, 10000) +
        numField('minutes', 'ใช้เวลา', 'นาที', null, 1440) +
        numField('maxKw', 'กำลังสูงสุดที่เห็น', 'kW', null, 500) +
        numField('odo', 'เลขไมล์ (ไม่บังคับ)', 'กม.', null, 2000000) +
      '</div>' +
      '<label class="report__f" data-when="bad" hidden><span>เกิดอะไรขึ้น</span><select class="field" name="problem">' +
        PROBLEMS.map(function (p) { return '<option value="' + p[0] + '">' + p[1] + '</option>'; }).join('') + '</select></label>' +
      '<label class="report__f report__note"><span>หมายเหตุ (ไม่บังคับ)</span><input class="field" name="note" type="text" maxlength="200" placeholder="เช่น หัว CCS2 ตัวซ้ายเสีย"></label>' +
      '<p class="hint">ดูตัวเลขได้ในแอปผู้ให้บริการหลังชาร์จเสร็จ ส่งแบบไม่ระบุตัวตน ช่วยให้ข้อมูลสถานีและแผนของทุกคนแม่นขึ้น</p>' +
      '<p class="report__msg" role="status"></p>' +
      '<div class="row__acts"><button type="submit" class="btn btn--primary">ส่งบันทึก</button><button type="button" class="btn" data-report-close>ยกเลิก</button></div>' +
    '</form>';
  }

  function openReport(btn) {
    var slot = btn.closest('.row').querySelector('.report-slot');
    if (slot.firstChild) { slot.innerHTML = ''; return; }
    slot.innerHTML = reportForm(R.result.stops[+btn.dataset.report]);
  }

  function submitReport(f) {
    var s = R.result && R.result.stops[+f.dataset.stop];
    if (!s) return;
    var v = function (n) { var x = f.elements[n] && f.elements[n].value.trim(); return x === '' || x == null ? null : +x; };
    var ok = f.elements.ok.value === '1', msg = f.querySelector('.report__msg');
    var d = {
      pid: R.result.pid, sid: s.st.id, name: s.st.name, op: s.st.op, src: s.st.src, lat: s.st.lat, lng: s.st.lng,
      plannedKw: s.c.kw, guess: !!s.st.guess, car: R.car.id, batt: R.car.kwh, ok: ok,
      problem: ok ? null : f.elements.problem.value, note: f.elements.note.value.trim(),
    };
    if (ok) {
      ['socFrom', 'socTo', 'kwh', 'baht', 'minutes', 'maxKw', 'odo'].forEach(function (n) { d[n] = v(n); });
      d.plug = f.elements.plug.value;
      if (d.socFrom != null && d.socTo != null && d.socTo <= d.socFrom) { msg.textContent = 'แบตหลังชาร์จต้องมากกว่าก่อนชาร์จ'; return; }
      if (d.kwh == null && d.socTo == null) { msg.textContent = 'ใส่แบตหลังชาร์จ หรือไฟที่ได้ (kWh) อย่างน้อยหนึ่งช่อง'; return; }
    }
    send('charge', d, true);
    R.reported[s.st.id] = true;
    var btn = f.closest('.row').querySelector('[data-report]');
    if (btn) btn.textContent = 'บันทึกการชาร์จแล้ว ✓';
    f.parentNode.innerHTML = '<p class="report__done">ขอบคุณ! บันทึกการชาร์จที่ ' + esc(s.st.name) + ' แล้ว</p>' + nudge('charge');
  }

  // ---------- charts ----------
  var W = 640, H = 230, PAD = { l: 34, r: 12, t: 16, b: 26 };

  function chart() {
    var res = R.result;
    if (!res) return;
    document.querySelectorAll('[data-chart]').forEach(function (b) {
      var on = b.dataset.chart === R.chart;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on);
    });
    if (R.chart === 'kwh' && res.stops.length) kwhChart(res); else socChart(res);
  }

  // Battery level along the trip: falls while driving, jumps at each stop.
  function socChart(res) {
    var t = totals(res), o = res.opts, len = t.km;
    var pts = [[0, o.startSoc]];
    (res.items || []).forEach(function (it) {
      var k = it.km != null ? it.km : it.along;
      if (it.kind === 'stop') {
        var s = it.s, a = s.arriveReal != null ? s.arriveReal : s.arrive;
        pts.push([k, a], [k, s.depart]);
      } else if (it.arrive != null) {
        pts.push([k, it.arrive]);
      }
    });
    if (res.ok) pts.push([len, t.arrive]);
    else pts.push([res.fail.reach, o.minSoc]);
    var xMax = Math.max(len, pts[pts.length - 1][0]);
    var x = function (k) { return PAD.l + k / xMax * (W - PAD.l - PAD.r); };
    var y = function (v) { return PAD.t + (100 - Math.max(0, Math.min(100, v))) / 100 * (H - PAD.t - PAD.b); };
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1); }).join(' ');
    var area = line + ' L' + x(pts[pts.length - 1][0]).toFixed(1) + ' ' + y(0) + ' L' + x(0) + ' ' + y(0) + ' Z';
    var grid = [0, 25, 50, 75, 100].map(function (v) {
      return '<line class="grid" x1="' + PAD.l + '" x2="' + (W - PAD.r) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>' +
        '<text class="axis" x="' + (PAD.l - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + v + '%</text>';
    }).join('');
    var step = xMax > 600 ? 200 : xMax > 250 ? 100 : xMax > 100 ? 50 : 20;
    var ticks = '';
    for (var k = 0; k <= xMax; k += step) ticks += '<text class="axis" x="' + x(k) + '" y="' + (H - 6) + '" text-anchor="middle">' + k + (k ? '' : ' กม.') + '</text>';
    var stops = res.stops.map(function (s, i) {
      var k = s.kmReal != null ? s.kmReal : s.along;
      return '<circle class="stop-dot" cx="' + x(k) + '" cy="' + y(s.depart) + '" r="6"/>' +
        '<text class="val" x="' + x(k) + '" y="' + (y(s.depart) - 11) + '" text-anchor="middle">' + (i + 1) + '</text>';
    }).join('') + (res.items || []).filter(function (it) { return it.kind === 'dest'; }).map(function (it) {
      var k = it.km != null ? it.km : it.along;
      return '<line class="dest-line" x1="' + x(k) + '" x2="' + x(k) + '" y1="' + PAD.t + '" y2="' + y(0) + '"/>' +
        '<text class="dest-label" x="' + x(k) + '" y="' + (PAD.t - 4) + '" text-anchor="middle">' + it.p.letter + '</text>';
    }).join('');
    $('chart-kpi').innerHTML = (res.trip.round ? 'กลับถึงต้นทางเหลือแบต' : 'ถึงปลายทางเหลือแบต') + '<b>' + (res.ok ? pct(t.arrive) : '–') + '<small>จาก ' + pct(o.startSoc) + '</small></b>';
    $('chart').innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="ระดับแบตตลอดเส้นทาง">' +
      '<defs><linearGradient id="g-soc" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="' + css('accent') + '" stop-opacity=".35"/><stop offset="1" stop-color="' + css('accent') + '" stop-opacity="0"/></linearGradient></defs>' +
      grid + ticks +
      '<line class="floor" x1="' + PAD.l + '" x2="' + (W - PAD.r) + '" y1="' + y(o.minSoc) + '" y2="' + y(o.minSoc) + '"/>' +
      '<text class="floor-label" x="' + (PAD.l + 6) + '" y="' + (y(o.minSoc) + 15) + '">แวะชาร์จเมื่อ ' + o.minSoc + '%</text>' +
      '<path d="' + area + '" fill="url(#g-soc)"/><path class="line" d="' + line + '"/>' + stops +
      '<g class="hover" visibility="hidden"><line class="hover-line" y1="' + PAD.t + '" y2="' + y(0) + '"/><circle class="hover-dot" r="5"/></g>' +
      '<rect class="hit" x="' + PAD.l + '" y="0" width="' + (W - PAD.l - PAD.r) + '" height="' + H + '"/></svg><div class="tip" hidden></div>';

    // Crosshair: battery level at the hovered distance.
    var svg = $('chart').querySelector('svg'), hov = svg.querySelector('.hover'), tip = $('chart').querySelector('.tip');
    var at = function (k) {
      for (var i = 1; i < pts.length; i++) {
        if (pts[i][0] >= k && pts[i][0] > pts[i - 1][0]) return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * (k - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]);
      }
      return pts[pts.length - 1][1];
    };
    var move = function (e) {
      var r = svg.getBoundingClientRect(), sx = (e.clientX - r.left) / r.width * W;
      var k = Math.max(0, Math.min(xMax, (sx - PAD.l) / (W - PAD.l - PAD.r) * xMax)), v = at(k);
      hov.setAttribute('visibility', 'visible');
      hov.querySelector('line').setAttribute('x1', x(k));
      hov.querySelector('line').setAttribute('x2', x(k));
      hov.querySelector('circle').setAttribute('cx', x(k));
      hov.querySelector('circle').setAttribute('cy', y(v));
      tip.hidden = false;
      tip.style.left = (x(k) / W * 100) + '%';
      tip.style.top = (y(v) / H * r.height) + 'px';
      tip.innerHTML = 'กม. ' + km1(k) + ' · แบต <b>' + pct(v) + '</b>';
    };
    var hit = svg.querySelector('.hit');
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', function () { hov.setAttribute('visibility', 'hidden'); tip.hidden = true; });
  }

  // kWh added at each stop.
  function kwhChart(res) {
    var t = totals(res), n = res.stops.length;
    var max = Math.max.apply(null, res.stops.map(function (s) { return s.kwhAdded; })) || 1;
    var top = Math.ceil(max / 10) * 10;
    var y = function (v) { return PAD.t + (1 - v / top) * (H - PAD.t - PAD.b); };
    var slot = (W - PAD.l - PAD.r) / n, bw = Math.min(46, slot * 0.6);
    var hi = res.stops.reduce(function (m, s, i) { return s.kwhAdded > res.stops[m].kwhAdded ? i : m; }, 0);
    var grid = [0, 0.5, 1].map(function (f) {
      var v = top * f;
      return '<line class="grid" x1="' + PAD.l + '" x2="' + (W - PAD.r) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>' +
        '<text class="axis" x="' + (PAD.l - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + Math.round(v) + '</text>';
    }).join('');
    var bars = res.stops.map(function (s, i) {
      var cx = PAD.l + slot * (i + 0.5), x0 = cx - bw / 2, top0 = y(s.kwhAdded), h = y(0) - top0;
      return '<g class="b" data-i="' + i + '"><rect class="bar-bg" x="' + x0 + '" y="' + PAD.t + '" width="' + bw + '" height="' + (y(0) - PAD.t) + '" rx="10"/>' +
        '<rect class="bar' + (i === hi ? ' is-hi' : '') + '" x="' + x0 + '" y="' + top0 + '" width="' + bw + '" height="' + Math.max(0, h) + '" rx="10"/>' +
        '<text class="val" x="' + cx + '" y="' + (top0 - 6) + '" text-anchor="middle">' + Math.round(s.kwhAdded) + '</text>' +
        '<text class="axis" x="' + cx + '" y="' + (H - 6) + '" text-anchor="middle">จุด ' + (i + 1) + '</text>' +
        '<rect class="hit" x="' + (cx - slot / 2) + '" y="0" width="' + slot + '" height="' + H + '"/></g>';
    }).join('');
    $('chart-kpi').innerHTML = 'เติมไฟรวม<b>' + Math.round(t.kwh) + '<small>kWh · ' + dur(res.chargeMin) + (res.cost != null ? ' · ~฿' + Math.round(res.cost).toLocaleString(LOC) : '') + '</small></b>';
    $('chart').innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="พลังงานที่เติมแต่ละจุด (kWh)">' + grid + bars +
      '</svg><div class="tip" hidden></div>';
    var svg = $('chart').querySelector('svg'), tip = $('chart').querySelector('.tip');
    svg.querySelectorAll('.b').forEach(function (g) {
      var show = function () {
        var s = res.stops[+g.dataset.i], r = svg.getBoundingClientRect();
        var cx = PAD.l + slot * (+g.dataset.i + 0.5);
        tip.hidden = false;
        tip.style.left = (cx / W * 100) + '%';
        tip.style.top = (y(s.kwhAdded) / H * r.height - 18) + 'px';
        tip.innerHTML = '<b>' + esc(s.st.name) + '</b><br>+' + s.kwhAdded.toFixed(1) + ' kWh · ' + dur(s.chargeMin + P.PLUG_MIN) + (s.cost ? ' · ~฿' + Math.round(s.cost.baht) : '');
      };
      g.addEventListener('pointerenter', show);
      g.addEventListener('pointerdown', show);
      g.addEventListener('pointerleave', function () { tip.hidden = true; });
    });
  }

  // ---------- map drawing ----------
  function draw() {
    var res = R.result;
    routeLayer.clear();
    candLayer.clear();
    stopLayer.clear();
    if (!res) return;
    var pts = (res.final || res.prof).pts;
    map.line(pts, { color: css('accent'), weight: 12, opacity: 0.18, layer: routeLayer });
    map.line(pts, { color: css('accent'), weight: 5, layer: routeLayer });

    var chosen = {};
    res.stops.forEach(function (s) { chosen[s.st.id] = true; });
    res.cands.forEach(function (c) {
      if (chosen[c.st.id]) return;
      map.dot(c.st.lat, c.st.lng, { radius: R.favs[c.st.id] ? 8 : 6, fill: R.favs[c.st.id] ? FAV_COLOR : doubtful(c.st, c.plug) ? css('unk') : css('accent'), popup: stationPopup(c), layer: candLayer });
    });
    res.stops.forEach(function (s, i) {
      map.pin(s.st.lat, s.st.lng, {
        html: '<span class="pin pin--stop">' + (i + 1) + '</span>', z: 900, layer: stopLayer,
        popup: '<b>' + esc(s.st.name) + '</b>' + userTag(s.st) + '<br>' + esc(s.st.op || '') + '<br>' + esc(plugText(s.st)) +
          '<br><span class="hint">จุดแวะที่ ' + (i + 1) + ' · ชาร์จถึง ' + pct(s.depart) + ' · ~' + dur(s.chargeMin + P.PLUG_MIN) + '</span>' +
          googleLink(s.st) + popupActions(s.st),
      });
    });
    if (res.flood) {
      res.flood.hits.map(function (h) { return h.f; }).concat(res.flood.avoided).forEach(function (f) {
        var avoided = res.flood.avoided.indexOf(f) >= 0;
        map.pin(f.lat, f.lng, {
          html: '<span class="pin pin--flood' + (avoided ? ' is-avoided' : f.block ? '' : ' is-wet') + '">🌊</span>', z: 800, layer: stopLayer,
          popup: '<b translate="no">' + esc(f.title) + '</b><br>' + (avoided ? '<b>เลี่ยงแล้ว</b><br>' : '') + '<span>' + esc(f.label) + '</span><br><span class="hint" translate="no">' + esc(f.place) + '</span><br><span class="hint">' + esc(f.src) + '</span>',
        });
      });
    }
    if (res.fail && res.fail.reach) {
      var p = pointAt(res.prof, res.fail.reach);
      if (p) map.dot(p[0], p[1], { radius: 9, fill: css('crit'), tooltip: 'แบตถึงระดับต่ำสุดราวตรงนี้', layer: stopLayer });
    }
    map.fit(pts, 30);
  }

  function pointAt(prof, along) {
    for (var i = 1; i < prof.cum.length; i++) if (prof.cum[i] >= along) return prof.pts[i];
    return null;
  }

  function userTag(st) { return st.src === 'user' ? '<span class="tag tag--user">ผู้ใช้เพิ่ม</span>' : ''; }

  function stationPopup(c) {
    var st = c.st;
    return '<b>' + esc(st.name) + '</b>' + userTag(st) + '<br>' + esc(st.op || 'ไม่ทราบผู้ให้บริการ') + '<br>' + esc(plugText(st)) +
      '<br><span class="hint">กม. ' + km1(c.along) + ' · ' + (c.off < 0.15 ? 'ติดเส้นทาง' : 'ห่างเส้นทาง ' + km1(c.off) + ' กม.') + '</span>' +
      (doubtful(st) ? '<br><span class="hint">ข้อมูลหัวชาร์จยังไม่ยืนยัน</span>' : '') +
      (st.rep && st.rep.prob ? '<br><span class="hint">⚠ ผู้ใช้รายงาน (' + daysAgo(st.rep.prob.at) + '): ' + esc(problemText(st.rep.prob.problem)) + '</span>' : '') +
      (st.rep && st.rep.ok ? '<br><span class="hint">✓ ผู้ใช้ชาร์จได้จริง ' + st.rep.ok + ' ครั้ง</span>' : '') +
      googleLink(st) +
      popupActions(st, '<button type="button" class="btn btn--primary" data-add="' + esc(st.id) + '">แวะชาร์จที่นี่</button>');
  }

  function say(msg, kind) {
    $('result').hidden = false;
    $('result').innerHTML = '<div class="verdict verdict--' + (kind || 'info') + '"><span>' + esc(msg) + '</span></div>';
    // The result panel isn't on screen while the form is: say it where it shows.
    if (document.body.dataset.view !== 'result') toast(esc(msg), 6000);
  }

  // ---------- inputs ----------
  function destInput(i) { return i === 0 ? $('to') : $('dest-' + i); }

  function setPoint(which, p) {
    if (which === 'a') { R.a = p; $('from').value = p ? p.label : ''; }
    else { R.dests[which] = p; destInput(which).value = p ? p.label : ''; }
    pin(which, p);
    if (p && !(R.a && R.dests[0])) map.setView(p.lat, p.lng, Math.max(map.getZoom(), 11));
  }

  // Inputs for destinations C, D ... (B is the fixed "to" field).
  function renderDests() {
    var box = $('dests');
    box.innerHTML = '';
    for (var i = 1; i < R.dests.length; i++) {
      var div = document.createElement('div');
      div.className = 'place';
      div.innerHTML = '<span class="dot dot--c" aria-hidden="true"></span>' +
        '<label class="sr-only" for="dest-' + i + '">จุดหมาย ' + letter(i) + '</label>' +
        '<input id="dest-' + i + '" class="search" type="text" placeholder="จุดหมาย ' + letter(i) + ': จะไปต่อที่ไหน" enterkeyhint="next">' +
        '<button type="button" class="place__del" data-del="' + i + '" aria-label="ลบจุดหมาย ' + letter(i) + '">×</button>' +
        '<ul class="sug" id="dest-' + i + '-sug" role="listbox" hidden></ul>';
      box.appendChild(div);
      $('dest-' + i).value = R.dests[i] ? R.dests[i].label : '';
      suggest($('dest-' + i), $('dest-' + i + '-sug'), i);
    }
    Object.keys(pins).forEach(function (k) { if (k !== 'a') { if (pins[k]) pins[k].remove(); delete pins[k]; } });
    R.dests.forEach(function (p, i) { pin(i, p); });
    $('to').value = R.dests[0] ? R.dests[0].label : ''; // a plan opened from a link fills its first stop here too
    $('to').placeholder = R.dests.length > 1 ? 'จุดหมาย B: แวะที่ไหนก่อน' : 'ปลายทาง: จะไปที่ไหน';
    $('add-dest').hidden = R.dests.length >= MAX_DESTS;
    $('swap').hidden = R.dests.length > 1;
  }

  function nextField(which) {
    if (which === 'a') return $('to');
    var n = destInput(which + 1);
    return n && !R.dests[which + 1] ? n : null;
  }

  function newTrip() { R.pinned = []; R.excluded = {}; markStale(); }

  // The trip was changed after planning: the plan on screen is for the old one, so it fades and
  // says so until "วางแผนการเดินทาง" makes the new one.
  function markStale() {
    if (!R.result || R.busy) return;
    ['result', 'summary', 'chart-card', 'nav'].forEach(function (id) { $(id).classList.add('is-stale'); });
    if (!$('result').querySelector('.stale-note')) {
      $('result').insertAdjacentHTML('afterbegin', '<div class="stale-note"><span>' + esc(I18N.t('เส้นทางเปลี่ยนแล้ว แผนด้านล่างเป็นของเส้นทางเดิม')) + '</span>' +
        '<button type="button" class="btn btn--primary" data-replan>' + esc(I18N.t('วางแผนใหม่')) + '</button></div>');
    }
  }
  document.addEventListener('click', function (e) { if (e.target.closest('[data-replan]')) $('go').click(); });

  function suggest(input, list, which) {
    var timer, last = '';
    input.addEventListener('input', function () {
      if (which === 'a') R.a = null; else R.dests[which] = null;
      markStale();
      pin(which, null);
      var q = input.value.trim();
      clearTimeout(timer);
      if (q.length < 2) { list.hidden = true; return; }
      timer = setTimeout(function () {
        last = q;
        geocode(q).then(function (res) {
          if (q !== last) return;
          list._res = res;
          list.innerHTML = res.length ? res.map(function (p, i) {
            return '<li role="option" data-i="' + i + '"><b>' + esc(p.label) + '</b>' + (p.sub ? '<span>' + esc(p.sub) + '</span>' : '') + '</li>';
          }).join('') : '<li class="sug__none">ไม่พบสถานที่ ลองพิมพ์ชื่ออำเภอหรือจังหวัด หรือแตะบนแผนที่</li>';
          list.hidden = false;
        }).catch(function () { list.hidden = true; });
      }, 350);
    });
    list.addEventListener('mousedown', function (e) {
      var li = e.target.closest('li[data-i]');
      if (!li) return;
      e.preventDefault();
      setPoint(which, list._res[+li.dataset.i]);
      newTrip();
      list.hidden = true;
      var nx = nextField(which);
      if (nx) nx.focus();
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !list.hidden && list._res && list._res.length) {
        e.preventDefault();
        setPoint(which, list._res[0]);
        newTrip();
        list.hidden = true;
        var nx = nextField(which);
        if (nx) nx.focus(); else if (R.a) plan();
      }
      if (e.key === 'Escape') list.hidden = true;
    });
    input.addEventListener('blur', function () { setTimeout(function () { list.hidden = true; }, 150); });
  }

  function gps() {
    var btn = $('from-gps');
    if (!navigator.geolocation) { say('เครื่องนี้หาตำแหน่งไม่ได้'); return; }
    btn.classList.add('is-loading');
    navigator.geolocation.getCurrentPosition(function (pos) {
      btn.classList.remove('is-loading');
      setPoint('a', { lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'ตำแหน่งของฉัน' });
      newTrip();
      $('to').focus();
    }, function (err) {
      btn.classList.remove('is-loading');
      say(err.code === 1 ? 'ไม่ได้รับอนุญาตให้ใช้ตำแหน่ง พิมพ์ต้นทางหรือแตะบนแผนที่แทน' : 'หาตำแหน่งไม่สำเร็จ');
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  }

  function shareURL() {
    try {
      var c = R.car;
      var q = new URLSearchParams({ from: R.a.lat.toFixed(5) + ',' + R.a.lng.toFixed(5), fn: R.a.label });
      R.dests.filter(Boolean).forEach(function (p) {
        q.append('to', p.lat.toFixed(5) + ',' + p.lng.toFixed(5));
        q.append('tn', p.label);
      });
      if (R.round) q.set('rt', '1');
      if ($('depart').value) q.set('dep', $('depart').value);
      [['car', c.id], ['soc', $('soc').value], ['u', unit()], ['min', radio('min')], ['tgt', radio('target')]].forEach(function (kv) { q.set(kv[0], kv[1]); });
      var base = CARS.filter(function (x) { return x.id === c.id; })[0];
      if (c.kwh !== base.kwh || c.use !== base.use || c.dc !== base.dc || c.margin !== 10) q.set('tune', [c.kwh, c.use, c.dc, c.margin].join(','));
      if (R.pinned.length) q.set('pin', R.pinned.join(','));
      var ex = Object.keys(R.excluded);
      if (ex.length) q.set('ex', ex.join(','));
      history.replaceState(null, '', '?' + q);
    } catch (e) {}
  }

  function fromURL() {
    var q = new URLSearchParams(location.search);
    var parse = function (v, label) {
      var m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(v || '');
      return m ? { lat: +m[1], lng: +m[2], label: label || 'จุดที่เลือก' } : null;
    };
    var saved = load('car');
    var carId = q.get('car') || (saved && saved.id) || 'byd-atto3-std';
    var tune = saved;
    if (q.get('tune')) {
      var t = q.get('tune').split(',').map(Number);
      tune = { id: carId, kwh: t[0], use: t[1], dc: t[2], margin: t[3] };
    }
    if (q.get('u') === 'km') setRadio('unit', 'km');
    if (q.get('soc')) $('soc').value = q.get('soc');
    else if (load('soc') && q.get('u') !== 'km') $('soc').value = load('soc'); // the battery last set here
    if (q.get('min')) setRadio('min', q.get('min'));
    if (q.get('tgt')) setRadio('target', q.get('tgt'));
    setCar(carId, tune);
    // First visit: open the car picker so people notice they can choose their model.
    if (!q.get('car') && !saved) togglePicker(true);
    if (q.get('pin')) R.pinned = q.get('pin').split(',').filter(Boolean);
    if (q.get('ex')) q.get('ex').split(',').forEach(function (id) { if (id) R.excluded[id] = true; });
    var a = parse(q.get('from'), q.get('fn'));
    var names = q.getAll('tn');
    var ds = q.getAll('to').map(function (v, i) { return parse(v, names[i]); }).filter(Boolean).slice(0, MAX_DESTS);
    R.round = q.get('rt') === '1';
    $('round').checked = R.round;
    R.dests = ds.length ? ds : [null];
    renderDests();
    if (a) setPoint('a', a);
    // A saved trip whose date has passed opens for leaving now, ready for a new date.
    var dep = q.get('dep'), depT = dep ? new Date(dep).getTime() : NaN;
    $('depart').value = isFinite(depT) && depT > Date.now() ? dep : '';
    showDepart();
    if (isFinite(depT) && depT <= Date.now() && a && ds.length) {
      toast('แผนนี้เคยตั้งไว้วันที่ ' + esc(thaiDate(depT)) + ' <button type="button" class="toast__btn" data-go="plan" data-focus="depart">เลือกวันใหม่</button>', 9000);
    }
    var hasTrip = a && ds.length;
    setView(hasTrip ? 'result' : q.get('from') || q.get('to') ? 'plan' : 'home');
    if (hasTrip) plan();
  }

  function togglePicker(open) {
    var p = $('picker'), btn = $('switch-car');
    p.hidden = open === undefined ? !p.hidden : !open;
    btn.setAttribute('aria-expanded', !p.hidden);
    showMyCar();
  }

  // ---------- events ----------
  $('brand').innerHTML = brands().map(function (b) { return '<option value="' + esc(b) + '">' + esc(b) + '</option>'; }).join(''); // the value stays Thai when the label is translated
  $('switch-car').addEventListener('click', function () { togglePicker(); });
  $('brand').addEventListener('change', function () {
    if (R.tuning) setTuning(false);
    fillModels($('brand').value);
    if ($('model').value === 'custom') {
      var mine = load('mycar'); // the last car entered under "ไม่มีรุ่นของฉัน"
      showMyCar();
      if (!(mine && mine.id === 'custom' && mine.brand)) { $('my-brand').focus(); return; } // used once its name is filled in
      setCar('custom', mine);
    } else {
      $('mycar').hidden = true;
      setCar($('model').value, load('car'));
    }
    readTune();
    if (R.result) replan();
  });
  $('model').addEventListener('change', function () {
    if (R.tuning) setTuning(false);
    if ($('model').value === 'custom') { showMyCar(); $('my-brand').focus(); return; } // used once its name is filled in
    $('mycar').hidden = true;
    setCar($('model').value); readTune(); if (R.result) replan();
  });
  $('my-use-car').addEventListener('click', useMyCar);
  $('mycar').addEventListener('input', function () { $('my-err').textContent = ''; });
  $('photo-btn').addEventListener('click', pickPhoto);
  $('photo-in').addEventListener('change', function () { savePhoto(this.files && this.files[0]); });
  $('car-photo').addEventListener('click', function (e) { if (e.target.id === 'photo-clear') clearPhoto(); });
  $('tune-btn').addEventListener('click', function () { setTuning(!R.tuning, true); });
  $('tune-cancel').addEventListener('click', function () { setTuning(false); });
  $('tune-reset').addEventListener('click', toFactory);
  // Swiping on a tile in "ปรับค่ารถ": every 8 px moves the value one drag step; a tap types instead.
  var scrub = null;
  $('spec').addEventListener('pointerdown', function (e) {
    var el = e.target.closest('.is-scrub');
    if (!el || e.target.closest('.tile__in')) return;
    var bar = e.target.closest('.tile__track');
    scrub = { el: el, x: e.clientX, v: +$(el.dataset.for).value, moved: false, id: e.pointerId, bar: bar };
    if (bar) { // the bar works like a slider: where you touch is the value
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      scrub.moved = true;
      el.classList.add('is-drag');
      barSet(el, bar, e.clientX);
    }
  });
  function barSet(el, bar, x) {
    var r = bar.getBoundingClientRect(), f = Math.max(0, Math.min(1, (x - r.left) / r.width));
    scrubSet(el, +el.dataset.lo + f * (+el.dataset.hi - +el.dataset.lo));
  }
  $('spec').addEventListener('pointermove', function (e) {
    if (!scrub || e.pointerId !== scrub.id) return;
    if (scrub.bar) { barSet(scrub.el, scrub.bar, e.clientX); return; }
    var dx = e.clientX - scrub.x;
    if (!scrub.moved && Math.abs(dx) < 6) return;
    if (!scrub.moved) { scrub.moved = true; scrub.el.setPointerCapture(e.pointerId); scrub.el.classList.add('is-drag'); }
    scrubSet(scrub.el, scrub.v + Math.round(dx / 8) * +scrub.el.dataset.drag);
  });
  $('spec').addEventListener('pointerup', function () {
    if (!scrub) return;
    var s = scrub;
    scrub = null;
    s.el.classList.remove('is-drag');
    if (!s.moved) typeIn(s.el);
    else if (R.result) replan();
  });
  $('spec').addEventListener('pointercancel', function () { if (scrub) scrub.el.classList.remove('is-drag'); scrub = null; });
  $('spec').addEventListener('keydown', function (e) {
    var el = e.target.closest('.is-scrub');
    if (!el || e.target.closest('.tile__in')) return;
    var dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (dir) { e.preventDefault(); scrubSet(el, +$(el.dataset.for).value + dir * +el.dataset.step * (e.shiftKey ? 10 : 1)); return; }
    if (e.key === 'Enter') { e.preventDefault(); typeIn(el); }
  });
  $('spec').addEventListener('keyup', function (e) { if (/Arrow/.test(e.key) && e.target.closest('.is-scrub') && R.result) replan(); });
  getJSON('data/car-images.json').then(function (d) { R.photos = d.images || {}; showPhoto(); }, function () {});

  drawTicks();
  wireGauge();
  $('soc').addEventListener('input', syncRange);
  $('soc').addEventListener('change', function () { if (R.result) replan(); });
  document.querySelectorAll('input[name="unit"]').forEach(function (el) {
    el.addEventListener('change', function () {
      // Convert the number in the box so it keeps meaning the same charge.
      var v = parseFloat($('soc').value);
      if (isFinite(v)) $('soc').value = el.value === 'km' ? Math.round(rangeKm(v)) : Math.round(P.kmToSoc(v, R.car));
      $('soc').max = el.value === 'km' ? 1000 : 100;
      syncRange();
    });
  });
  document.querySelectorAll('input[name="min"], input[name="target"]').forEach(function (el) {
    el.addEventListener('change', function () { syncRange(); if (R.result) replan(); });
  });

  suggest($('from'), $('from-sug'), 'a');
  suggest($('to'), $('to-sug'), 0);
  $('add-dest').addEventListener('click', function () {
    if (R.dests.length >= MAX_DESTS) return;
    R.dests.push(null);
    renderDests();
    destInput(R.dests.length - 1).focus();
  });
  $('dests').addEventListener('click', function (e) {
    var del = e.target.closest('[data-del]');
    if (!del) return;
    R.dests.splice(+del.dataset.del, 1);
    renderDests();
    newTrip();
    if (R.result) replan();
  });
  $('round').addEventListener('change', function () {
    R.round = this.checked;
    newTrip();
    if (R.result) replan();
  });
  $('from-gps').addEventListener('click', gps);
  $('swap').addEventListener('click', function () {
    var a = R.a, b = R.dests[0];
    setPoint('a', b);
    setPoint(0, a);
    newTrip();
    if (R.a && R.dests[0] && R.result) plan();
  });
  $('form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (R.busy) return;
    resolveTyped().then(function (missing) {
      if (missing.length) say(I18N.t('ไม่พบสถานที่') + ' "' + missing[0] + '" · ' + I18N.t('ลองพิมพ์ชื่ออำเภอหรือจังหวัด หรือแตะบนแผนที่'));
      else plan();
    });
  });

  // A place typed but not picked from the list (or before the list came): take the best match, as
  // any search box would, instead of planning as if the box were empty.
  function resolveTyped() {
    var jobs = [], missing = [];
    var need = function (which, input) {
      var q = input ? input.value.trim() : '';
      if ((which === 'a' ? R.a : R.dests[which]) || q.length < 2) return;
      jobs.push(geocode(q).then(function (res) { if (res && res.length) setPoint(which, res[0]); else missing.push(q); }, function () { missing.push(q); }));
    };
    need('a', $('from'));
    R.dests.forEach(function (p, i) { need(i, destInput(i)); });
    if (!jobs.length) return Promise.resolve(missing);
    setBusy(true, 'กำลังค้นหาสถานที่…');
    return Promise.all(jobs).then(function () { setBusy(false); newTrip(); return missing; });
  }
  if (!$('depart').min) $('depart').min = localInput(Date.now());
  $('depart').addEventListener('change', function () {
    showDepart();
    $('depart-nudge').innerHTML = departAt() > Date.now() + 60000 ? nudge('depart') : '';
    if (R.result) { shareURL(); render(); } // same route, new times and prices
  });
  $('depart-now').addEventListener('click', function () {
    $('depart').value = '';
    showDepart();
    if (R.result) { shareURL(); render(); }
  });
  function wireMap() {
  map.onClick(function (lat, lng) {
    if (A.open) { setAddPoint({ lat: lat, lng: lng }); return; }
    if (R.result) return; // with a plan on screen, taps open station popups instead
    var p = { lat: lat, lng: lng, label: 'จุดที่เลือก (' + lat.toFixed(4) + ', ' + lng.toFixed(4) + ')' };
    var free = R.dests.indexOf(null);
    if (R.a && free < 0) return;
    setPoint(!R.a ? 'a' : free, p);
    newTrip();
    if (R.a && R.dests.indexOf(null) < 0 && !R.busy) plan();
  });

  // "แวะชาร์จที่นี่" in a station popup on the map.
  map.container.addEventListener('click', function (e) {
    var f = e.target.closest('[data-fav]');
    if (f) { if (!R.favs[f.dataset.fav]) logEvent('fav', stationById(f.dataset.fav)); map.closePopup(); toggleFav(f.dataset.fav); return; }
    var ev = e.target.closest('[data-ev]');
    if (ev) {
      var evSt = stationById(ev.dataset.sid);
      logEvent(ev.dataset.ev, evSt);
      if (ev.dataset.ev === 'app' && evSt) openApp(ev, evSt, e);
      return;
    }
    var b = e.target.closest('[data-add]');
    if (!b) return;
    var id = b.dataset.add;
    logEvent('pin', stationById(id));
    delete R.excluded[id];
    if (R.pinned.indexOf(id) < 0) R.pinned.push(id);
    map.closePopup();
    replan();
  });
  }

  document.querySelectorAll('[data-chart]').forEach(function (b) {
    b.addEventListener('click', function () { R.chart = b.dataset.chart; chart(); });
  });

  function onResultClick(e) {
    var t;
    if ((t = e.target.closest('[data-swap]'))) {
      var old = R.result.stops[+t.dataset.swap].st.id;
      logEvent('swap', stationById(t.dataset.id));
      R.pinned = R.pinned.filter(function (id) { return id !== old; });
      R.pinned.push(t.dataset.id);
      replan();
      return;
    }
    if ((t = e.target.closest('[data-fav]'))) { if (!R.favs[t.dataset.fav]) logEvent('fav', stationById(t.dataset.fav)); toggleFav(t.dataset.fav); return; }
    if (e.target.closest('#save-plan')) { logEvent('save'); savePlan(); return; }
    if ((t = e.target.closest('[data-report]'))) { openReport(t); return; }
    if ((t = e.target.closest('[data-report-close]'))) { t.closest('.report-slot').innerHTML = ''; return; }
    if ((t = e.target.closest('[data-ev]'))) {
      var evSt = stationById(t.dataset.sid);
      logEvent(t.dataset.ev, evSt);
      if (t.dataset.ev === 'app' && evSt) openApp(t, evSt, e);
      return;
    }
    if ((t = e.target.closest('[data-skip]'))) {
      logEvent('skip', stationById(t.dataset.skip));
      R.excluded[t.dataset.skip] = true;
      R.pinned = R.pinned.filter(function (id) { return id !== t.dataset.skip; });
      replan();
      return;
    }
    if (e.target.closest('#reset')) { newTrip(); replan(); return; }
    if (e.target.closest('[data-addopen]')) { openAdd(true); return; }
    if ((t = e.target.closest('#share'))) {
      logEvent('share');
      shareURL();
      var done = function () { t.textContent = 'คัดลอกแล้ว ✓'; setTimeout(function () { t.textContent = 'คัดลอกลิงก์แผนนี้'; }, 2000); };
      if (navigator.share && /android|iphone|ipad/i.test(navigator.userAgent)) navigator.share({ title: document.title, url: location.href }).catch(function () {});
      else if (navigator.clipboard) navigator.clipboard.writeText(location.href).then(done, function () {});
      return;
    }
    if (e.target.closest('a, button, summary, details')) return;
    var li = e.target.closest('.row[data-lat]');
    if (li) map.setView(+li.dataset.lat, +li.dataset.lng, 15);
  }
  $('result').addEventListener('click', onResultClick);
  $('result').addEventListener('submit', function (e) {
    if (!e.target.matches('.report')) return;
    e.preventDefault();
    submitReport(e.target);
  });
  $('result').addEventListener('change', function (e) {
    if (e.target.name !== 'ok' || !e.target.form) return;
    var ok = e.target.form.elements.ok.value === '1';
    e.target.form.querySelector('[data-when="ok"]').hidden = !ok;
    e.target.form.querySelector('[data-when="bad"]').hidden = ok;
  });
  $('saved-btn').addEventListener('click', function () {
    var l = $('saved-list');
    l.hidden = !l.hidden;
    this.setAttribute('aria-expanded', !l.hidden);
  });
  $('saved-list').addEventListener('click', function (e) {
    var d = e.target.closest('[data-unsave]');
    if (!d) return;
    var list = savedPlans();
    list.splice(+d.dataset.unsave, 1);
    store('plans', list);
    renderSaved();
    pushTrips();
  });
  renderSaved();
  $('nav').addEventListener('click', onResultClick);

  $('lang').value = I18N.lang;
  $('lang').addEventListener('change', function () { I18N.use && I18N.use($('lang').value); });

  $('theme').addEventListener('click', function () {
    var t = document.documentElement.dataset.theme;
    var dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('theme', dark ? 'light' : 'dark'); } catch (e) {}
    if (R.result) { draw(); chart(); }
  });


  // ---------- add a station ----------
  var PLUG_TYPES = [['CCS2', 'CCS2'], ['CHAdeMO', 'CHAdeMO'], ['GB/T', 'GB/T'], ['Type2', 'Type 2 (AC)'], ['Tesla', 'Tesla']];
  var A = { open: false, point: null, marker: null, layer: null }; // layer is made once the map exists

  function plugRow(type) {
    var div = document.createElement('div');
    div.className = 'plug';
    div.innerHTML = '<select class="field" aria-label="ชนิดหัว">' + PLUG_TYPES.map(function (t) {
      return '<option value="' + t[0] + '"' + (t[0] === type ? ' selected' : '') + '>' + t[1] + '</option>';
    }).join('') + '</select>' +
      '<input class="field" type="number" inputmode="decimal" min="1" max="500" placeholder="kW" aria-label="กำลังไฟ kW">' +
      '<input class="field" type="number" inputmode="numeric" min="1" max="30" placeholder="หัว" aria-label="จำนวนหัว">' +
      '<button type="button" class="plug__del" aria-label="ลบหัวชาร์จนี้">×</button>';
    $('add-plugs').appendChild(div);
  }

  function resetAdd() {
    $('add-form').reset();
    $('add-op-other').hidden = true;
    $('add-plugs').innerHTML = '<div class="plug-head"><span>ชนิดหัว</span><span>kW (ถ้ารู้)</span><span>จำนวนหัว</span><span></span></div>';
    plugRow('CCS2');
    setAddPoint(null);
    addMsg('');
  }

  function addMsg(text, kind) {
    var m = $('add-msg');
    m.textContent = text;
    m.className = 'add-msg' + (kind ? ' is-' + kind : '');
  }

  function setAddPoint(p, center) {
    A.point = p;
    if (A.marker) { A.marker.remove(); A.marker = null; }
    var w = $('add-where');
    if (!p) {
      w.textContent = 'แตะบนแผนที่เพื่อปักหมุด (ลากหมุดเพื่อขยับได้)';
      w.classList.remove('is-set');
      return;
    }
    A.marker = map.pin(p.lat, p.lng, {
      html: '<span class="pin pin--new">+</span>', z: 1100, draggable: true,
      onDragEnd: function (lat, lng) { setAddPoint({ lat: lat, lng: lng }); },
    });
    w.textContent = '📍 ' + p.lat.toFixed(5) + ', ' + p.lng.toFixed(5) + nearText(p);
    w.classList.add('is-set');
    if (center) map.setView(p.lat, p.lng, Math.max(map.getZoom(), 15));
  }

  // Say so when the pin sits on a station we already have.
  function nearText(p) {
    var best = null, d = Infinity;
    R.stations.forEach(function (st) {
      if (Math.abs(st.lat - p.lat) > 0.01) return;
      var k = P.km(p, st);
      if (k < d) { d = k; best = st; }
    });
    return best && d < 0.15 ? ' · ใกล้ "' + best.name + '" ที่มีอยู่แล้ว (' + Math.round(d * 1000) + ' ม.) ถ้าเป็นที่เดียวกัน หัวชาร์จที่ใส่จะใช้แทนข้อมูลที่ยังไม่ยืนยัน' : '';
  }

  // Coordinates from a pasted Google Maps link or "lat, lng".
  function parseWhere(text) {
    var t = String(text || '');
    try { t = decodeURIComponent(t); } catch (e) {}
    var pats = [/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, /@(-?\d+\.\d+),(-?\d+\.\d+)/, /[?&](?:q|ll|query|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/, /^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$/];
    for (var i = 0; i < pats.length; i++) {
      var m = pats[i].exec(t);
      if (m) return { lat: +m[1], lng: +m[2] };
    }
    return null;
  }

  // Every known station as a small dot while adding, so people can see what's already there.
  function drawAll() {
    A.layer.clear();
    R.stations.forEach(function (st) {
      map.dot(st.lat, st.lng, { radius: 4, fill: doubtful(st) ? css('unk') : css('accent'), tooltip: st.name + (st.src === 'user' ? ' (ผู้ใช้เพิ่ม)' : ''), layer: A.layer });
    });
  }

  function openAdd(open) {
    A.open = open;
    $('add-card').hidden = !open;
    $('add-form').hidden = false;
    $('add-title').textContent = 'เพิ่มสถานีชาร์จที่ยังไม่มี';
    $('add-open').classList.toggle('is-on', open);
    $('add-open').setAttribute('aria-expanded', open);
    $('map').classList.toggle('is-picking', open);
    if (open) {
      resetAdd();
      drawAll();
      A.layer.show(true);
      $('add-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      setAddPoint(null);
      A.layer.show(false);
    }
  }

  function saveStation(e) {
    e.preventDefault();
    if (!A.point) { addMsg('ปักหมุดตำแหน่งสถานีบนแผนที่ก่อน', 'err'); return; }
    var op = $('add-op').value === 'other' ? $('add-op-other').value.trim() : $('add-op').value;
    var body = {
      lat: A.point.lat, lng: A.point.lng, operator: op, name: $('add-name').value.trim(),
      hours: $('add-hours').value.trim(), note: $('add-note').value.trim(),
      connectors: Array.prototype.map.call($('add-plugs').querySelectorAll('.plug'), function (row) {
        var f = row.querySelectorAll('select, input');
        return { type: f[0].value, kw: f[1].value, count: f[2].value };
      }),
    };
    if (!op) { addMsg('เลือกผู้ให้บริการ', 'err'); return; }
    if (body.name.length < 3) { addMsg('ใส่ชื่อสถานี', 'err'); return; }
    var btn = $('add-save');
    btn.disabled = true;
    btn.textContent = 'กำลังบันทึก…';
    fetch('/api/stations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) throw new Error(d.error || 'บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง');
          return d;
        });
      })
      .then(function (d) {
        R.stations.push(d.station);
        $('updated').textContent = 'สถานีชาร์จ ' + R.stations.length.toLocaleString(LOC) + ' แห่ง';
        openAdd(false);
        // Leave a thank-you in place of the form for a moment.
        $('add-card').hidden = false;
        $('add-form').hidden = true;
        $('add-title').textContent = 'ขอบคุณ! เพิ่ม "' + d.station.name + '" แล้ว';
        setTimeout(function () { if (!A.open) $('add-card').hidden = true; }, 4000);
        if (R.result) replan();
      })
      .catch(function (err) { addMsg(err.message, 'err'); })
      .then(function () { btn.disabled = false; btn.textContent = 'บันทึกสถานี'; });
  }

  $('add-open').addEventListener('click', function () { openAdd(!A.open); });
  $('add-close').addEventListener('click', function () { openAdd(false); });
  $('add-plug').addEventListener('click', function () { if ($('add-plugs').querySelectorAll('.plug').length < 6) plugRow('CCS2'); });
  $('add-plugs').addEventListener('click', function (e) {
    var del = e.target.closest('.plug__del');
    if (del && $('add-plugs').querySelectorAll('.plug').length > 1) del.parentNode.remove();
  });
  $('add-op').addEventListener('change', function () { $('add-op-other').hidden = this.value !== 'other'; });
  $('add-link').addEventListener('input', function () {
    var v = this.value.trim(), p = parseWhere(v);
    if (p) { setAddPoint(p, true); addMsg(''); return; }
    if (!v) { addMsg(''); return; }
    addMsg(/goo\.gl|maps\.app/.test(v) ? 'ลิงก์แบบย่อใช้ไม่ได้ ใน Google Maps กดค้างที่หมุดเพื่อคัดลอกพิกัด แล้ววางที่นี่แทน' : 'อ่านพิกัดจากข้อความนี้ไม่ได้', 'err');
  });
  $('add-gps').addEventListener('click', function () {
    if (!navigator.geolocation) { addMsg('เครื่องนี้หาตำแหน่งไม่ได้', 'err'); return; }
    navigator.geolocation.getCurrentPosition(function (pos) {
      setAddPoint({ lat: pos.coords.latitude, lng: pos.coords.longitude }, true);
    }, function () { addMsg('หาตำแหน่งไม่สำเร็จ ลองแตะบนแผนที่แทน', 'err'); }, { enableHighAccuracy: true, timeout: 10000 });
  });
  $('add-form').addEventListener('submit', saveStation);

  function showStatsNote() {
    $('stats-note').hidden = !(R.cfg && R.cfg.stats);
    $('stats-toggle').textContent = load('nostats') ? 'กลับมาร่วมส่งสถิติ' : 'ไม่ร่วมส่งสถิติ';
  }
  $('stats-reset').addEventListener('click', function () {
    store('cuids', {});
    store('dev', null);
    this.textContent = 'เริ่มรหัสใหม่แล้ว ✓';
  });
  $('stats-toggle').addEventListener('click', function () {
    store('nostats', !load('nostats'));
    showStatsNote();
  });

  // ---------- views: home (widgets) · planning form · results ----------
  // Home is a dashboard of widgets; the form is for setting a trip up; after planning, the form
  // folds into a one-line trip bar so the results come first. The map stays in every view.
  var DEMO = '?from=13.75630,100.50180&fn=' + encodeURIComponent('กรุงเทพฯ') + '&to=18.78830,98.98530&tn=' + encodeURIComponent('เชียงใหม่') + '&soc=90&u=pct&min=20&tgt=80';

  function setView(v) {
    var was = R.view;
    R.view = v;
    document.body.dataset.view = v;
    $('home').hidden = v !== 'home';
    $('tripbar').hidden = v !== 'result';
    if (v === 'home') renderHome();
    if (v === 'result') renderTripbar();
    document.querySelectorAll('[data-tab]').forEach(function (b) { b.classList.toggle('is-on', b.dataset.tab === (v === 'home' ? 'home' : 'plan')); });
    showDock();
    if (was && was !== v) window.scrollTo(0, 0);
  }

  function routeText() {
    var names = [R.a && R.a.label].concat(R.dests.filter(Boolean).map(function (p) { return p.label; }));
    if (R.round) names.push('กลับต้นทาง');
    return names.filter(Boolean).join(' → ');
  }

  function renderTripbar() {
    var soc = startSoc();
    $('tripbar').innerHTML = '<button type="button" class="tripbar__home" data-go="home" aria-label="กลับหน้าแรก">‹</button>' +
      '<div class="tripbar__main"><b>' + esc(routeText()) + '</b><span>' + esc(R.car.brand + ' ' + R.car.model) +
      (soc != null ? ' · แบต ' + Math.round(soc) + '%' : '') + ' · ' + ($('depart').value ? 'ออก ' + esc(thaiDate(departAt(), true)) : 'ออกตอนนี้') + '</span></div>' +
      '<button type="button" class="pill-btn" data-go="plan">แก้ไข</button>';
  }

  // On phones the main actions stay at the bottom of the screen while scrolling the plan.
  function showDock() {
    var link = R.view === 'result' && document.querySelector('#nav .nav-card .btn--primary');
    $('dock').hidden = !link;
    document.body.classList.toggle('has-dock', !!link);
    if (!link) return;
    $('dock').innerHTML = '<a class="btn btn--primary" href="' + esc(link.href) + '" target="_blank" rel="noopener" data-ev="nav">' + BOLT + 'เปิดใน Google Maps</a>' +
      '<button type="button" class="btn" data-dock-save>' + (isSaved() ? '★ บันทึกแล้ว' : '☆ บันทึก') + '</button>';
  }

  function upcomingFirst(list) {
    return list.slice().sort(function (a, b) {
      var x = upcoming(a), y = upcoming(b);
      if (x !== y) return x ? -1 : 1;
      return x ? new Date(a.dep) - new Date(b.dep) : 0;
    });
  }

  function tripFacts(km, stops, cost, mins) {
    return [km != null ? Math.round(km).toLocaleString(LOC) + ' กม.' : '', mins ? dur(mins) : '', stops != null ? (stops ? 'ชาร์จ ' + stops + ' จุด' : 'ไม่ต้องชาร์จ') : '',
      cost != null ? '฿' + Math.round(cost).toLocaleString(LOC) : ''].filter(Boolean).join(' · ');
  }

  function carPhoto() {
    var id = R.car && R.car.id, img = null;
    if (!id) return null;
    var own = ownPhoto();
    if (own) return { thumb: own, own: true };
    Object.keys(R.photos || {}).forEach(function (k) { if (id === k || id.indexOf(k + '-') === 0) img = R.photos[k]; });
    return img;
  }

  // ---------- the driver's own car photo ----------
  // Kept in this browser only, for this brand and model (a rental, or a car not on the list). It is
  // scaled down to 1280 px first so it fits the browser's storage.
  function photoKey() {
    var c = R.car;
    if (c.id !== 'custom') return 'photo:' + c.id;
    return c.named ? 'photo:custom:' + (c.brand + '|' + c.model).toLowerCase() : null;
  }
  function ownPhoto() {
    var k = photoKey();
    if (!k) return null;
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }

  function pickPhoto() {
    if (!photoKey()) {
      openPicker();
      showMyCar();
      $('my-err').textContent = I18N.t('ใส่ยี่ห้อและรุ่นรถก่อน แล้วค่อยใส่รูป');
      $('my-brand').focus();
      return;
    }
    $('photo-in').value = '';
    $('photo-in').click();
  }

  function savePhoto(file) {
    if (!file || !/^image\//.test(file.type)) return;
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      var max = 1280, k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      var cv = document.createElement('canvas');
      cv.width = Math.round(img.naturalWidth * k);
      cv.height = Math.round(img.naturalHeight * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      var data = cv.toDataURL('image/jpeg', 0.82);
      try {
        localStorage.setItem(photoKey(), data);
      } catch (e) {
        toast('เก็บรูปไม่ได้ พื้นที่ในเบราว์เซอร์เต็ม ลองรูปที่เล็กลง', 6000);
        return;
      }
      showPhoto();
      toast('✓ ใช้รูปรถของคุณแล้ว · ' + esc(R.car.brand + ' ' + R.car.model));
    };
    img.onerror = function () { URL.revokeObjectURL(url); toast('เปิดรูปนี้ไม่ได้ ลองรูปอื่น'); };
    img.src = url;
  }

  function clearPhoto() {
    try { localStorage.removeItem(photoKey()); } catch (e) {}
    showPhoto();
    toast('กลับไปใช้รูปมาตรฐานแล้ว');
  }

  // ---------- "ไม่มีรุ่นของฉัน" ----------
  function openPicker() {
    $('picker').hidden = false;
    $('switch-car').setAttribute('aria-expanded', 'true');
    if (R.car.id !== 'custom') { $('brand').value = 'อื่น ๆ'; fillModels('อื่น ๆ', 'custom'); }
  }

  function showMyCar() {
    var on = $('model').value === 'custom' && !$('picker').hidden;
    $('mycar').hidden = !on;
    if (!on) return;
    var m = load('mycar');
    var c = R.car.id === 'custom' ? R.car : m && m.brand ? { named: true, brand: m.brand, model: m.model, kwh: m.kwh, use: m.use, dc: m.dc, plugs: [m.plug] }
      : CARS.filter(function (x) { return x.id === 'custom'; })[0];
    $('my-brand').value = c.named ? c.brand : '';
    $('my-model').value = c.named ? c.model : '';
    $('my-kwh').value = c.kwh;
    $('my-use').value = c.use;
    $('my-dc').value = c.dc;
    $('my-plug').value = c.named ? (c.plugs[0] || '') : 'CCS2';
    $('my-err').textContent = '';
  }

  function useMyCar() {
    var brand = $('my-brand').value.trim().replace(/\s+/g, ' '), model = $('my-model').value.trim().replace(/\s+/g, ' ');
    var num = function (id, lo, hi) { var v = parseFloat($(id).value); return isFinite(v) && v >= lo && v <= hi ? v : null; };
    var kwh = num('my-kwh', 10, 200), use = num('my-use', 8, 40), dc = num('my-dc', 0, 400), plug = $('my-plug').value;
    var err = !brand ? 'ใส่ยี่ห้อรถ' : !model ? 'ใส่รุ่นรถ' : kwh == null ? 'ใส่ขนาดแบตที่ใช้ได้ 10–200 kWh' : use == null ? 'ใส่อัตรากินไฟ 8–40 kWh/100กม.' : dc == null ? 'ใส่กำลังชาร์จ DC สูงสุด 0–400 kW' : '';
    if (err) { $('my-err').textContent = I18N.t(err); return; }
    if (/^(อื่น ๆ|other)$/i.test(brand)) { $('my-err').textContent = I18N.t('ใส่ยี่ห้อจริงของรถ เช่น AVATR'); return; }
    if (R.tuning) setTuning(false);
    setCar('custom', { id: 'custom', brand: brand, model: model, kwh: kwh, use: use, dc: plug ? dc : 0, plug: plug, margin: R.car.margin });
    saveCar();
    store('mycar', load('car'));
    $('picker').hidden = true;
    $('switch-car').setAttribute('aria-expanded', 'false');
    $('mycar').hidden = true;
    toast('✓ ใช้ ' + esc(brand + ' ' + model) + ' แล้ว');
    // The team adds models people ask for to the list (the admin page shows these requests).
    if ($('my-send').checked && R.cfg && R.cfg.stats) {
      fetch('/api/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'car', message: 'ขอเพิ่มรุ่น: ' + brand + ' ' + model + ' · แบต ' + kwh + ' kWh · กินไฟ ' + use + ' · DC ' + dc + ' kW · ' + (plug || 'ไม่มี DC'), lang: I18N.lang, ua: uaShort(), dev: devId(), page: 'car' }),
      }).catch(function () {});
    }
    if (R.result) replan();
  }

  // When the on-peak/off-peak price next changes, looking ahead in half hours.
  function nextPriceSwitch(now) {
    var off = P.isOffPeak(now), t = new Date(now.getTime());
    t.setMinutes(t.getMinutes() < 30 ? 30 : 60, 0, 0);
    for (var i = 0; i < 200 && P.isOffPeak(t) === off; i++) t = new Date(t.getTime() + 30 * 60000);
    return t;
  }

  var TIPS = [
    'ชาร์จถึง 80% ก็พอสำหรับทางไกล ช่วง 80–100% ไฟเข้าช้าลงมาก',
    'ขับ 120 กม./ชม. กินไฟมากกว่า 90 กม./ชม. ราว 30% ลดความเร็วนิดเดียว ไปได้ไกลขึ้นเยอะ',
    'ชาร์จช่วง Off-Peak (หลัง 22:00 และเสาร์–อาทิตย์) ถูกกว่าราว ฿1 ต่อ kWh',
    'ตั้งแอร์ 25°C ประหยัดไฟกว่าตั้งเย็นจัด โดยเฉพาะตอนรถติด',
    'ไปชาร์จแล้วกด “บันทึกการชาร์จจริง” ช่วยยืนยันข้อมูลสถานีให้ทุกคน',
    'สถานีที่มีคนรายงานว่าเสีย ระบบจะเลี่ยงให้เอง ถ้ามีที่อื่นใกล้ ๆ',
  ];

  // ---- greeting header ----
  function bkkNow() { return new Date(Date.now() + 7 * 3600e3); } // read with getUTC*
  function bkkDay(t) { return new Date(t + 7 * 3600e3).toISOString().slice(0, 10); }
  function dayLabel(iso) { return new Date(iso + 'T12:00:00+07:00').toLocaleDateString(LOC, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Bangkok' }); }

  function greeting() {
    var h = bkkNow().getUTCHours();
    return h < 5 ? 'สวัสดีตอนดึก' : h < 11 ? 'สวัสดีตอนเช้า' : h < 13 ? 'สวัสดีตอนเที่ยง' : h < 16 ? 'สวัสดีตอนบ่าย' : h < 19 ? 'สวัสดีตอนเย็น' : 'สวัสดีตอนค่ำ';
  }

  // A short line under the greeting that changes with the time of day and from day to day, in a
  // friendly voice. Nothing about holidays or days off: not everyone gets them.
  var HELLO = [
    ['ยังไม่นอนอีกเหรอ พักผ่อนบ้างนะ', 'เดินทางกลางคืน ง่วงเมื่อไรแวะพักก่อนนะ', 'ดึกแล้ว วางแผนไว้ก่อน พรุ่งนี้ค่อยไปก็ได้'],
    ['เริ่มวันใหม่ วันนี้อยากไปไหน?', 'เช้านี้แบตพร้อมแค่ไหนแล้ว?', 'ขอให้วันนี้เดินทางราบรื่นนะ', 'กาแฟสักแก้ว แล้วออกเดินทางกัน', 'อากาศเช้า ๆ แบบนี้ เหมาะกับการขับรถเล่น'],
    ['ทานข้าวหรือยัง? แวะชาร์จไปด้วยก็ได้นะ', 'พักเที่ยงแล้ว เติมแรงให้ตัวเองกับรถไปพร้อมกัน', 'แดดแรง เปิดแอร์ 25°C ก็เย็นสบายแล้ว'],
    ['บ่ายนี้มีแผนไปไหนต่อ?', 'ง่วงหลังมื้อเที่ยง แวะพักสักครู่ก่อนนะ', 'ขับมาไกลแล้ว ยืดเส้นยืดสายบ้างนะ', 'วางแผนทริปถัดไปไว้ล่วงหน้า สบายใจกว่า'],
    ['กลับบ้านปลอดภัยนะ', 'เย็นนี้ไปไหนต่อ?', 'ชาร์จหลัง 22:00 ถูกกว่า ถ้ารอได้', 'เหนื่อยมาทั้งวัน ให้เราช่วยวางแผนเส้นทางเอง'],
    ['คืนนี้วางแผนทริปถัดไปไว้ก่อนไหม?', 'ชาร์จที่บ้านช่วง Off-Peak คุ้มที่สุด', 'พักผ่อนให้เต็มที่ พรุ่งนี้ค่อยลุยต่อ', 'ขับกลางคืน ระวังสายตาล้านะ'],
  ];

  function helloLine() {
    var h = bkkNow().getUTCHours(), slot = h < 5 ? 0 : h < 11 ? 1 : h < 13 ? 2 : h < 16 ? 3 : h < 19 ? 4 : 5;
    var lines = HELLO[slot], seed = 0, key = bkkDay(Date.now()) + slot;
    for (var i = 0; i < key.length; i++) seed = (seed * 31 + key.charCodeAt(i)) % 9973;
    return lines[seed % lines.length]; // the same line all through this part of the day
  }

  function headWidget() {
    var nick = load('nick'), img = carPhoto();
    var chip = '<p class="h-chip">' + esc(helloLine()) + '</p>';
    return '<header class="w w--wide h-head">' +
      (img ? '<img class="h-head__car" src="' + esc(img.thumb) + '" alt="' + esc(R.car.brand + ' ' + R.car.model) + '" loading="lazy">' : '') +
      '<h1 class="h-head__hi"' + (nick ? ' data-nick title="แตะเพื่อเปลี่ยนชื่อเล่น"' : '') + '>' + esc(greeting()) + (nick ? ',<br>คุณ' + esc(nick) : '') + '</h1>' +
      (nick ? '' : '<button type="button" class="h-head__nick" data-nick>+ ใส่ชื่อเล่น</button>') +
      '<button type="button" class="h-head__car-name" data-go="plan" data-focus="car">' + esc(R.car.brand === 'อื่น ๆ' ? 'รถของคุณ' : R.car.brand) + ' ' + esc(R.car.model) + ' ›</button>' + chip + '</header>';
  }

  // ---- cards ----
  function battWidget() {
    var soc = Math.round(startSoc() || 0), low = soc <= +radio('min');
    return '<button type="button" class="w w-batt" data-go="plan" data-focus="gauge"><span class="w__top"><span class="w__title">แบตเตอรี่</span><span class="w__more">›</span></span>' +
      '<span class="w__sub">ตอนออกเดินทาง</span>' +
      '<span class="w-batt__body"><span class="w-batt__cell' + (low ? ' is-low' : '') + '"><i style="height:' + Math.max(4, soc) + '%"></i></span>' +
      '<span class="w-batt__nums"><b>' + Math.round(rangeKm(soc)) + '<small>km</small></b><b class="w-batt__pct">' + soc + '<small>%</small></b>' +
      '<span class="w__sub">' + esc(R.car.kwh) + ' kWh</span></span></span>' +
      '<span class="w-batt__foot">' + (low ? 'ควรชาร์จก่อนออก' : 'แตะเพื่อปรับ') + '</span></button>';
  }

  var ICON = {
    route: '<svg viewBox="0 0 24 24"><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    saved: '<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
    pin: '<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
    user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
    bolt: '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
    tag: '<svg viewBox="0 0 24 24"><path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>',
    bulb: '<svg viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/></svg>',
  };

  function homeTrip() {
    var cur = R.result && R.result.ok ? R.result : null;
    if (cur) {
      var t = totals(cur), end = cur.trip.end;
      return { label: 'แผนที่เปิดอยู่', title: tripTitle(cur.trip), sub: tripFacts(t.km, cur.stops.length, cur.cost, null), go: 'result', lat: end.lat, lng: end.lng, place: end.label, when: departAt() };
    }
    var list = upcomingFirst(savedPlans()), n = list[0];
    if (!n) return null;
    var q = new URLSearchParams(n.q), tos = q.getAll('to'), names = q.getAll('tn'), m = /^(-?[\d.]+),(-?[\d.]+)$/.exec(tos[tos.length - 1] || '');
    var ahead = upcoming(n), t2 = ahead ? new Date(n.dep).getTime() : null;
    return { label: ahead ? 'ทริปถัดไป' : 'ทริปล่าสุด', title: n.title, sub: (ahead ? 'อีก ' + aheadText(t2 - Date.now()) + ' · ' : '') + tripFacts(n.km, null, null, null),
      href: n.q, lat: m && +m[1], lng: m && +m[2], place: names[names.length - 1] || n.title, when: t2 };
  }

  function tripWidget(tr) {
    if (!tr) {
      return '<button type="button" class="w w-small" data-go="plan" data-focus="from"><span class="w__top"><span class="w__ico">' + ICON.route + '</span><span class="w__more">›</span></span>' +
        '<b class="w__big">วางแผนทริป</b><span class="w__sub">ยังไม่มีทริป</span></button>';
    }
    var attrs = tr.href ? 'href="' + esc(tr.href) + '"' : 'href="#" data-go="' + tr.go + '"';
    return '<a class="w w-small" ' + attrs + '><span class="w__top"><span class="w__ico">' + ICON.route + '</span><span class="w__more">›</span></span>' +
      '<b class="w__big">' + esc(tr.title) + '</b><span class="w__sub">' + esc(tr.label) + ' · ' + esc(tr.sub) + '</span></a>';
  }

  var WX = [[0, '☀️', 'ท้องฟ้าแจ่มใส'], [2, '⛅', 'มีเมฆบางส่วน'], [3, '☁️', 'เมฆมาก'], [48, '🌫️', 'มีหมอก'], [57, '🌦️', 'ฝนปรอย'], [67, '🌧️', 'ฝนตก'],
    [77, '🌨️', 'หิมะ'], [82, '🌦️', 'ฝนตกเป็นช่วง ๆ'], [99, '⛈️', 'พายุฝนฟ้าคะนอง']];
  function wxText(code) { for (var i = 0; i < WX.length; i++) if (code <= WX[i][0]) return WX[i]; return WX[WX.length - 1]; }

  // Weather where the trip ends, on the travel day when the forecast reaches it (16 days).
  function weatherWidget(tr) {
    return '<div class="w w-small w-wx" id="w-wx"><span class="w__top"><span class="w__ico">☁️</span></span><b class="w__big">…</b><span class="w__sub">อากาศที่ ' + esc(tr.place) + '</span></div>';
  }

  function loadWeather(tr) {
    var key = tr.lat.toFixed(2) + ',' + tr.lng.toFixed(2);
    var show = function (d) {
      var el = $('w-wx');
      if (!el || !d || !d.daily) return;
      var day = bkkDay(tr.when || Date.now()), i = d.daily.time.indexOf(day), today = day === bkkDay(Date.now());
      var code, temp, rain, note;
      if (i >= 0) {
        code = today && d.current ? d.current.weather_code : d.daily.weather_code[i];
        temp = today && d.current ? Math.round(d.current.temperature_2m) + '°' : Math.round(d.daily.temperature_2m_max[i]) + '°';
        rain = d.daily.precipitation_probability_max[i];
        note = (today ? 'ตอนนี้' : dayLabel(day)) + ' · ' + Math.round(d.daily.temperature_2m_max[i]) + '°/' + Math.round(d.daily.temperature_2m_min[i]) + '°';
      } else {
        code = d.current.weather_code; temp = Math.round(d.current.temperature_2m) + '°'; rain = null; note = 'ตอนนี้ · พยากรณ์วันเดินทางได้ก่อน 16 วัน';
      }
      var w = wxText(code);
      el.innerHTML = '<span class="w__top"><span class="w__ico w__ico--wx">' + w[1] + '</span></span><b class="w__big">' + temp + ' <small>' + esc(w[2]) + '</small></b>' +
        '<span class="w__sub">' + esc(tr.place) + ' · ' + esc(note) + (rain != null ? ' · ฝน ' + rain + '%' : '') + '</span>' +
        (rain >= 50 ? '<span class="w__hint">ฝนตกกินไฟเพิ่ม เผื่อแบตไว้หน่อย</span>' : '');
    };
    if (R.wx && R.wx.key === key) { show(R.wx.data); return; }
    getJSON('/api/weather?lat=' + tr.lat + '&lng=' + tr.lng).then(function (d) { R.wx = { key: key, data: d }; show(d); }, function () {
      var el = $('w-wx');
      if (el) el.querySelector('.w__big').textContent = '–';
    });
  }

  // ---- charging stations near me ----
  function fastForCar(st) {
    return (st.plugs || []).some(function (p) { return p.dc && (p.type === 'Tesla' ? R.car.brand === 'Tesla' : R.car.plugs.indexOf(p.type) >= 0); });
  }

  function nearList(pos) {
    return R.stations.filter(fastForCar).map(function (st) { return { st: st, km: P.km(pos, st) }; })
      .sort(function (a, b) { return a.km - b.km; }).slice(0, 3);
  }

  function locateMe(quiet) {
    if (!navigator.geolocation) { if (!quiet) toast('เครื่องนี้หาตำแหน่งไม่ได้'); return; }
    if (!quiet) R.nearBusy = true, renderHome();
    navigator.geolocation.getCurrentPosition(function (p) {
      R.near = { lat: p.coords.latitude, lng: p.coords.longitude };
      R.nearBusy = false;
      store('geo', 1);
      renderHome();
    }, function () {
      R.nearBusy = false;
      if (!quiet) { toast('หาตำแหน่งไม่สำเร็จ ตรวจว่าอนุญาตให้เว็บนี้ใช้ตำแหน่งแล้ว'); renderHome(); }
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 5 * 60 * 1000 });
  }

  function nearWidget() {
    if (!R.near) {
      return '<div class="w w--wide w-near"><div class="w-near__text"><b class="w__title">หาสถานีชาร์จใกล้ฉัน</b><span class="w__sub">สถานีที่ ' + esc(R.car.model) + ' ชาร์จเร็วได้ เรียงจากใกล้สุด</span>' +
        '<button type="button" class="btn btn--primary w-near__go" data-near>' + (R.nearBusy ? 'กำลังหาตำแหน่ง…' : 'ใช้ตำแหน่งของฉัน') + '</button></div>' +
        '<div class="w-near__art" aria-hidden="true">' + ICON.pin + '</div></div>';
    }
    var list = nearList(R.near), first = list[0];
    if (!first) return '<div class="w w--wide w-near"><div class="w-near__text"><b class="w__title">สถานีชาร์จใกล้ฉัน</b><span class="w__sub">ไม่พบสถานีที่รถคุณชาร์จเร็วได้ในข้อมูลของเรา</span></div></div>';
    return '<div class="w w--wide w-near"><div class="w-near__text"><b class="w__title">สถานีชาร์จใกล้ฉัน</b>' +
      '<ul class="w-near__list">' + list.map(function (x) {
        var kw = Math.max.apply(null, x.st.plugs.filter(function (p) { return p.dc; }).map(function (p) { return p.kw || 0; }));
        return '<li><b>' + esc(x.st.name) + '</b><span>' + km1(x.km) + ' กม.' + (kw ? ' · ' + kw + ' kW' : '') + '</span></li>';
      }).join('') + '</ul>' +
      '<a class="btn btn--primary w-near__go" href="https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + first.st.lat + ',' + first.st.lng + '" target="_blank" rel="noopener">นำทางไปที่ใกล้สุด</a></div>' +
      '<div class="w-near__map" id="near-map"></div></div>';
  }

  function drawNearMap() {
    if (R.nearMap) { R.nearMap.remove(); R.nearMap = null; }
    var el = $('near-map');
    if (!el || !R.near || !window.L) return;
    var m = L.map(el, { zoomControl: false, attributionControl: true, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false, tap: false });
    m.attributionControl.setPrefix(false);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(m);
    var pts = [[R.near.lat, R.near.lng]];
    nearList(R.near).forEach(function (x, i) {
      pts.push([x.st.lat, x.st.lng]);
      L.circleMarker([x.st.lat, x.st.lng], { radius: i ? 6 : 8, color: '#fff', weight: 2, fillColor: css('ok'), fillOpacity: 1 }).addTo(m);
    });
    L.circleMarker(pts[0], { radius: 7, color: '#fff', weight: 3, fillColor: css('accent'), fillOpacity: 1 }).addTo(m);
    m.fitBounds(pts, { padding: [18, 18], maxZoom: 14 });
    R.nearMap = m;
  }

  function quickWidget() {
    var acct = accountsOn() ? (signedIn() ? ['บัญชี', 'data-acct-open="menu"', ICON.user] : ['เข้าสู่ระบบ', 'data-acct-open="menu"', ICON.user]) : null;
    var items = [['วางแผนใหม่', 'data-go="plan" data-focus="from"', ICON.bolt, true], ['ทริปที่บันทึก', 'data-go="plan" data-open="saved"', ICON.saved],
      ['เพิ่มสถานี', 'data-addopen-home', ICON.plus]].concat(acct ? [acct] : []);
    return '<div class="w w--wide w-quick"><span class="w__title">ทางลัด</span><div class="w-quick__row">' + items.map(function (x) {
      return '<button type="button" class="w-quick__btn' + (x[3] ? ' is-on' : '') + '" ' + x[1] + '><span class="w__ico">' + x[2] + '</span><span>' + x[0] + '</span></button>';
    }).join('') + '</div></div>';
  }

  function priceWidget() {
    var now = new Date(), off = P.isOffPeak(now), sw = nextPriceSwitch(now);
    // On/off-peak hours are Thai time, whatever the device's clock is set to.
    var hm = sw.toLocaleTimeString(LOC, { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' }) + ' น.';
    var when = bkkDay(sw.getTime()) === bkkDay(now.getTime()) ? hm : sw.toLocaleDateString(LOC, { weekday: 'short', timeZone: 'Asia/Bangkok' }) + ' ' + hm;
    var best = Object.keys(R.prices || {}).filter(function (k) { return k !== '_default' && R.prices[k].dc; }).map(function (k) {
      var p = R.prices[k];
      return { op: k, rate: off && p.dcOff ? p.dcOff : p.dc };
    }).sort(function (a, b) { return a.rate - b.rate; })[0];
    return '<div class="w w-small"><span class="w__top"><span class="w__ico' + (off ? ' w__ico--ok' : '') + '">' + ICON.tag + '</span></span>' +
      '<b class="w__big">' + (off ? 'Off-Peak' : 'On-Peak') + '</b><span class="w__sub">' + (off ? 'ค่าไฟถูกกว่า ถึง ' : 'ถูกลงเมื่อ ') + esc(when) +
      (best ? '<br>ถูกสุด ' + esc(best.op) + ' ฿' + best.rate : '') + '</span></div>';
  }

  function tipWidget() {
    var day = Math.floor((Date.now() + 7 * 3600e3) / 864e5);
    return '<div class="w w-small"><span class="w__top"><span class="w__ico w__ico--sun">' + ICON.bulb + '</span></span><span class="w__label">เคล็ดลับ</span>' +
      '<p class="w-tip__text">' + esc(TIPS[day % TIPS.length]) + '</p></div>';
  }

  function savedWidget(list) {
    if (!list.length) return '';
    var rows = list.slice(0, 3).map(function (p) {
      var when = upcoming(p) ? thaiDate(new Date(p.dep).getTime()) : p.dep ? 'เคยไป ' + thaiDate(new Date(p.dep).getTime()) : 'ยังไม่ระบุวัน';
      return '<li><a href="' + esc(p.q) + '"><b>' + esc(p.title) + '</b><span' + (upcoming(p) ? ' class="is-ahead"' : '') + '>' + esc(when) + '</span><span>' + (p.km ? Math.round(p.km).toLocaleString(LOC) + ' กม.' : '') + '</span></a></li>';
    }).join('');
    return '<div class="w w--wide w-saved"><div class="w__top"><span class="w__title">ทริปที่บันทึกไว้</span>' +
      (list.length > 3 ? '<button type="button" class="link-btn" data-go="plan" data-open="saved">ดูทั้งหมด (' + list.length + ')</button>' : '') + '</div>' +
      '<ul class="w-saved__list">' + rows + '</ul>' +
      (accountsOn() && !signedIn() ? '<button type="button" class="link-btn w-saved__acct" data-acct-open="saved">เข้าสู่ระบบเพื่อใช้ทุกเครื่อง</button>' : '') + '</div>';
  }

  // Signed in: this month's charging from the driver's own reports, what the same distance would have
  // cost in petrol, and the car's real consumption from odometer readings.
  function myWidget() {
    if (!accountsOn() || !signedIn() || !A.me) return '';
    var charges = A.me.charges || [], month = bkkDay(Date.now()).slice(0, 7), baht = 0, kwh = 0;
    charges.forEach(function (c) { if (c.ok && bkkDay(Date.parse(c.created_at)).slice(0, 7) === month) { baht += +c.baht || 0; kwh += +c.kwh || 0; } });
    var real = (A.me.use || {})[R.car.id], base = CARS.filter(function (x) { return x.id === R.car.id; })[0] || R.car;
    var use = real ? real.kwh100 : R.car.use, km = kwh / use * 100, pet = R.petrol;
    var save = pet && kwh ? km / pet.kmPerLitre * pet.bahtPerLitre - baht : null;
    var diff = real ? Math.round((real.kwh100 - base.use) / base.use * 100) : null;
    return '<div class="w w--wide w-mine"><div class="w__top"><span class="w__title">รถของฉัน เดือนนี้</span><button type="button" class="link-btn" data-acct-open="menu">ดูประวัติ ›</button></div>' +
      '<div class="w-mine__grid">' +
        '<div><span class="w__sub">ค่าชาร์จ</span><b class="w__big">฿' + Math.round(baht).toLocaleString(LOC) + '</b><span class="w__sub">' + (kwh ? Math.round(kwh) + ' kWh · ~' + Math.round(km).toLocaleString(LOC) + ' กม.' : 'ยังไม่มีบันทึกเดือนนี้') + '</span></div>' +
        '<div><span class="w__sub">ประหยัดกว่ารถน้ำมัน</span><b class="w__big' + (save > 0 ? ' is-good' : '') + '">' + (save != null ? '฿' + Math.round(Math.max(0, save)).toLocaleString(LOC) : '–') + '</b>' +
          '<span class="w__sub">' + (pet ? 'เทียบ ' + pet.kmPerLitre + ' กม./ลิตร ลิตรละ ฿' + pet.bahtPerLitre : '') + '</span></div>' +
        '<div><span class="w__sub">กินไฟจริง</span><b class="w__big">' + (real ? real.kwh100 + ' <small>kWh/100 กม.</small>' : '–') + '</b>' +
          '<span class="w__sub">' + (real ? (diff === 0 ? 'เท่าค่าจากโรงงาน' : (diff < 0 ? 'ดีกว่า' : 'มากกว่า') + 'ค่าโรงงาน ' + Math.abs(diff) + '%') : 'ใส่เลขไมล์ตอนบันทึกการชาร์จ 2 ครั้ง') + '</span>' +
          (real && Math.abs(R.car.use - real.kwh100) >= 0.1 ? '<button type="button" class="link-btn" data-use-real-home="' + real.kwh100 + '">ใช้ค่านี้วางแผน</button>' : '') + '</div>' +
      '</div></div>';
  }

  // "Add to home screen": Android/desktop Chrome offer it through an event; iPhone needs the share menu.
  function standalone() { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
  function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }

  function installWidget() {
    if (standalone() || load('noinstall') || !(R.installEvt || isIOS())) return '';
    return '<div class="w w--wide w-install"><img src="assets/icons/icon-192.png" alt="" width="52" height="52"><div class="w-install__text"><b>เพิ่ม EVROUTE ไปที่หน้าจอโฮม</b>' +
      '<span class="w__sub">' + (R.installEvt ? 'เปิดได้ในแตะเดียวเหมือนแอป เต็มจอ ไม่มีแถบเบราว์เซอร์' : 'ใน Safari แตะปุ่มแชร์ <b>⬆︎</b> แล้วเลือก <b>“เพิ่มไปยังหน้าจอโฮม”</b>') + '</span></div>' +
      '<div class="w-install__acts">' + (R.installEvt ? '<button type="button" class="btn btn--primary" data-install>ติดตั้ง</button>' : '') +
      '<button type="button" class="link-btn" data-noinstall>ไม่ใช่ตอนนี้</button></div></div>';
  }

  function renderHome() {
    if (R.view !== 'home' || !R.car) return;
    var list = upcomingFirst(savedPlans()), tr = homeTrip(), wx = tr && isFinite(tr.lat) && isFinite(tr.lng);
    $('widgets').innerHTML = headWidget() + battWidget() + tripWidget(tr) + (wx ? weatherWidget(tr) : priceWidget()) +
      myWidget() + nearWidget() + quickWidget() + installWidget() + (wx ? priceWidget() : '') + tipWidget() + savedWidget(list) +
      (list.length ? '' : '<div class="w--wide">' + nudge('device') + '</div>');
    if (wx) loadWeather(tr);
    drawNearMap();
    if (!R.near && !R.nearAsked && load('geo') && navigator.permissions) {
      R.nearAsked = true; // already allowed before: find nearby stations without asking again
      navigator.permissions.query({ name: 'geolocation' }).then(function (p) { if (p.state === 'granted') locateMe(true); }, function () {});
    }
  }

  // Buttons that move between views, optionally landing on a field.
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-go]');
    if (t) {
      e.preventDefault();
      setView(t.dataset.go);
      var f = t.dataset.focus;
      if (t.dataset.open === 'saved' && $('saved-list').hidden) $('saved-btn').click();
      if (f === 'car') document.querySelector('.car-card').scrollIntoView({ block: 'start' });
      else if (f) setTimeout(function () { var el = $(f); if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); } }, 50);
      return;
    }
    if (e.target.closest('[data-near]')) { locateMe(false); return; }
    if (e.target.closest('[data-install]') && R.installEvt) {
      R.installEvt.prompt();
      R.installEvt.userChoice.then(function (c) { logEvent(c.outcome === 'accepted' ? 'install' : 'install_no'); R.installEvt = null; renderHome(); }, function () {});
      return;
    }
    if (e.target.closest('[data-noinstall]')) { store('noinstall', 1); renderHome(); return; }
    var useReal = e.target.closest('[data-use-real-home]');
    if (useReal) {
      R.car.use = +useReal.dataset.useRealHome;
      saveCar();
      showSpec();
      renderHome();
      toast('ใช้อัตรากินไฟจริงของรถคุณในการวางแผนแล้ว');
      return;
    }
    if (e.target.closest('[data-addopen-home]')) { setView('plan'); openAdd(true); document.querySelector('.map-card').scrollIntoView({ block: 'center' }); return; }
    if (e.target.closest('[data-nick]')) {
      var n = prompt(I18N.t('ชื่อเล่นที่อยากให้ทักทาย (เว้นว่างเพื่อลบ)'), load('nick') || '');
      if (n !== null) { store('nick', n.trim().slice(0, 20) || null); renderHome(); }
      return;
    }
    if (e.target.closest('[data-gps]')) {
      setView('plan');
      gps();
      setTimeout(function () { $('to').focus(); }, 50);
    }
  });
  $('tabbar').addEventListener('click', function (e) {
    var t = e.target.closest('[data-tab]');
    if (!t) return;
    var tab = t.dataset.tab;
    if (tab === 'home') setView('home');
    else if (tab === 'plan') setView(R.result ? 'result' : 'plan');
    else if (tab === 'map') document.querySelector('.map-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
    else if (tab === 'me') openAcct('menu');
  });
  $('dock').addEventListener('click', function (e) {
    if (e.target.closest('[data-ev]')) logEvent('nav');
    if (e.target.closest('[data-dock-save]')) { logEvent('save'); savePlan(); showDock(); }
  });
  document.querySelector('.brand').addEventListener('click', function (e) { e.preventDefault(); setView('home'); });

  // ---------- optional account ----------
  // Everything works without one. Signing in (email + a one-time code, no password) keeps saved
  // trips on every device and turns charging reports into the driver's own history. Sign-up is
  // offered only right after the user does something worth keeping, once per kind of moment.
  var A = { s: load('auth'), me: null, step: 'email', email: '', from: 'menu', busy: false, shown: {} };

  function signedIn() { return !!(A.s && A.s.access_token); }
  function accountsOn() { return !!(R.cfg && R.cfg.accounts); }

  function saveSession(s) {
    A.s = s && s.access_token ? { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at, user: s.user } : null;
    try { if (A.s) localStorage.setItem('auth', JSON.stringify(A.s)); else localStorage.removeItem('auth'); } catch (e) {}
    showAcctBtn();
  }

  function postJSON(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) { var err = new Error(d.error || 'ลองใหม่อีกครั้ง'); err.status = r.status; throw err; }
        return d;
      });
    });
  }

  var refreshing = null;
  function refreshSession() {
    if (!refreshing) {
      refreshing = postJSON('/api/auth/refresh', { refresh_token: A.s && A.s.refresh_token }).then(saveSession, function (err) {
        if (err.status === 401) saveSession(null); // the session ended: back to using the site without an account
        throw err;
      }).then(function () { refreshing = null; }, function (err) { refreshing = null; throw err; });
    }
    return refreshing;
  }

  // fetch() with the user's token, refreshed when it's about to run out or the server says it has.
  function authFetch(url, opts, retried) {
    if (!signedIn()) return Promise.reject(new Error('signed out'));
    var ready = A.s.expires_at * 1000 - Date.now() < 60000 ? refreshSession() : Promise.resolve();
    return ready.then(function () {
      var o = Object.assign({}, opts);
      o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers, { Authorization: 'Bearer ' + A.s.access_token });
      return fetch(url, o);
    }).then(function (r) {
      if (r.status === 401 && !retried) return refreshSession().then(function () { return authFetch(url, opts, true); });
      if (r.status === 401) saveSession(null);
      return r;
    });
  }

  // Saved trips: the server's list wins when signed in; local ones are merged in on sign-in.
  function pushTrips() {
    if (!signedIn()) return Promise.resolve();
    return authFetch('/api/me/trips', { method: 'PUT', body: JSON.stringify({ trips: savedPlans() }) }).then(function (r) {
      if (!r.ok) throw new Error('trips ' + r.status);
    }).catch(function (err) { console.warn('saving trips', err); });
  }

  function loadMe(merge) {
    if (!signedIn()) return Promise.resolve();
    return authFetch('/api/me', {}).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d) return;
      A.me = d;
      var local = savedPlans(), server = d.trips || [], moved = 0;
      if (merge) {
        var have = {};
        server.forEach(function (t) { have[t.q] = true; });
        local.forEach(function (t) { if (!have[t.q]) { server.push(t); moved++; } });
        server.sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
      }
      store('plans', server.slice(0, 50));
      renderSaved();
      if (merge && moved) pushTrips();
      if (!$('acct').hidden) renderAcct();
      return moved;
    }).catch(function (err) { console.warn('account', err); });
  }

  function showAcctBtn() {
    var b = $('acct-btn');
    b.hidden = !accountsOn();
    $('tab-me').hidden = !accountsOn();
    var email = signedIn() && A.s.user && A.s.user.email || '';
    b.classList.toggle('is-in', !!email);
    b.textContent = email ? email.charAt(0).toUpperCase() : 'เข้าสู่ระบบ';
    b.setAttribute('aria-label', email ? 'บัญชีของฉัน (' + email + ')' : 'เข้าสู่ระบบ');
    b.title = email || 'เข้าสู่ระบบด้วยอีเมล';
    showDeviceNudge();
    renderSaved();
  }

  function openAcct(from) {
    A.from = from || 'menu';
    if (!signedIn()) A.step = 'email';
    $('acct').hidden = false;
    document.body.classList.add('no-scroll');
    renderAcct();
    if (signedIn()) loadMe();
    var f = $('acct-body').querySelector('input');
    if (f) f.focus();
  }

  function closeAcct() {
    A.approval = null;
    $('acct').hidden = true;
    document.body.classList.remove('no-scroll');
  }

  function carName(id) {
    var c = CARS.filter(function (x) { return x.id === id; })[0];
    return c ? c.brand + ' ' + c.model : id;
  }

  function renderAcct() {
    var b = $('acct-body');
    if (signedIn() && A.approval) {
      var mins = Math.max(1, Math.round((Date.now() - A.approval.at) / 60000));
      b.innerHTML = '<h2 class="sheet__title" id="acct-title">ให้อุปกรณ์อื่นเข้าสู่ระบบด้วยไหม?</h2>' +
        '<p class="hint">เมื่อ ' + mins + ' นาทีที่แล้ว มีการขอเข้าสู่ระบบด้วย <b>' + esc(A.s.user && A.s.user.email || '') + '</b> จากอีกเบราว์เซอร์หรือเครื่องหนึ่ง</p>' +
        '<div class="pair"><span>เลขจับคู่</span><b>' + esc(A.approval.pair) + '</b><p>กดยืนยันเฉพาะเมื่ออุปกรณ์ที่คุณเพิ่งขอ แสดงเลขนี้อยู่</p></div>' +
        '<button type="button" class="btn btn--primary btn--block" data-approve="1">ยืนยัน ให้อุปกรณ์นั้นเข้าสู่ระบบ</button>' +
        '<button type="button" class="link-btn sheet__deny" data-approve="0">ไม่ใช่ฉัน / ไม่ได้ขอ</button>';
      return;
    }
    if (!signedIn()) {
      b.innerHTML = A.step === 'email'
        ? '<h2 class="sheet__title" id="acct-title">เก็บทริปของคุณไว้ทุกเครื่อง</h2>' +
          '<ul class="sheet__perks"><li>ทริปที่บันทึกไว้ เปิดได้ทุกเครื่อง ไม่หายเมื่อล้างเบราว์เซอร์</li><li>ประวัติการชาร์จ และอัตรากินไฟจริงของรถคุณ</li></ul>' +
          '<form class="sheet__form" id="acct-email"><label class="opt__label" for="acct-email-in">อีเมล</label>' +
          '<input id="acct-email-in" class="field" type="email" inputmode="email" autocomplete="email" required placeholder="you@example.com" value="' + esc(A.email) + '">' +
          '<p class="sheet__msg" id="acct-msg" role="status"></p>' +
          '<button type="submit" class="btn btn--primary btn--block">ส่งอีเมลเข้าสู่ระบบ</button></form>' +
          '<p class="hint">ฟรีช่วงทดสอบ · ไม่ต้องตั้งรหัสผ่าน · ใช้อีเมลเพื่อเก็บข้อมูลของคุณเท่านั้น · <a href="privacy.html" target="_blank" rel="noopener">นโยบายความเป็นส่วนตัว</a></p>'
        : '<h2 class="sheet__title" id="acct-title">เปิดอีเมลแล้วกดลิงก์</h2>' +
          '<p class="hint">ส่งไปที่ <b>' + esc(A.email) + '</b> แล้ว (ถ้าไม่เห็น ดูในโฟลเดอร์สแปม)</p>' +
          (A.handoff ? '<div class="pair"><span>เลขจับคู่</span><b>' + esc(A.handoff.pair) + '</b>' +
            '<p>กดลิงก์ในอีเมล ถ้าเว็บเปิดในเบราว์เซอร์หรือเครื่องอื่น ให้กดยืนยันเลขนี้ที่นั่น หน้านี้จะเข้าสู่ระบบเอง</p><i class="pair__wait" aria-hidden="true"></i></div>' : '') +
          '<p class="hint">หรือถ้าอีเมลมีรหัส ใส่ที่นี่</p>' +
          '<form class="sheet__form" id="acct-code"><label class="sr-only" for="acct-code-in">รหัส</label>' +
          '<input id="acct-code-in" class="field sheet__code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="10" required placeholder="รหัส 6 หลัก">' +
          '<p class="sheet__msg" id="acct-msg" role="status"></p>' +
          '<button type="submit" class="btn btn--primary btn--block">ยืนยัน</button></form>' +
          '<p class="hint"><button type="button" class="link-btn" data-acct-step="email">เปลี่ยนอีเมล</button> · <button type="button" class="link-btn" data-acct-resend>ส่งอีเมลอีกครั้ง</button></p>';
      return;
    }
    var me = A.me || {}, trips = savedPlans().length, charges = me.charges || [], use = me.use || {};
    var month = new Date().toISOString().slice(0, 7), mBaht = 0, mKwh = 0;
    charges.forEach(function (c) { if (c.ok && String(c.created_at).slice(0, 7) === month) { mBaht += +c.baht || 0; mKwh += +c.kwh || 0; } });
    var useHtml = Object.keys(use).map(function (id) {
      var u = use[id];
      return '<li><b>' + esc(carName(id)) + '</b> กินไฟจริง <b>' + u.kwh100 + '</b> kWh/100 กม. <span class="hint">(จาก ' + u.km.toLocaleString(LOC) + ' กม.)</span>' +
        (R.car && R.car.id === id && Math.abs(R.car.use - u.kwh100) >= 0.1 ? ' <button type="button" class="link-btn" data-use-real="' + u.kwh100 + '">ใช้ค่านี้วางแผน</button>' : '') + '</li>';
    }).join('');
    b.innerHTML = '<h2 class="sheet__title" id="acct-title">บัญชีของฉัน</h2><p class="hint">' + esc(A.s.user && A.s.user.email || '') + '</p>' +
      '<div class="sheet__stats"><div><b>' + trips + '</b><span>ทริปที่บันทึกไว้</span></div><div><b>' + charges.length + '</b><span>บันทึกการชาร์จ</span></div>' +
      '<div><b>฿' + Math.round(mBaht).toLocaleString(LOC) + '</b><span>ค่าชาร์จเดือนนี้' + (mKwh ? ' · ' + Math.round(mKwh) + ' kWh' : '') + '</span></div></div>' +
      '<h3 class="sheet__h">อัตรากินไฟจริงของรถคุณ</h3>' +
      (useHtml ? '<ul class="sheet__list">' + useHtml + '</ul>' : '<p class="hint">ใส่ <b>เลขไมล์</b> ตอน "บันทึกการชาร์จจริง" ตั้งแต่ 2 ครั้งขึ้นไป ระบบจะคำนวณให้ แม่นกว่าค่าจากโรงงาน</p>') +
      '<h3 class="sheet__h">ประวัติการชาร์จ</h3>' +
      (charges.length ? '<ul class="sheet__list sheet__hist">' + charges.slice(0, 20).map(function (c) {
        return '<li><span>' + esc(new Date(c.created_at).toLocaleDateString(LOC, { day: 'numeric', month: 'short', year: '2-digit' })) + '</span><b>' + esc(c.station_name || c.op || 'สถานี') + '</b>' +
          '<span>' + (c.ok ? [c.kwh != null ? c.kwh + ' kWh' : '', c.baht != null ? '฿' + c.baht : '', c.max_kw ? c.max_kw + ' kW' : ''].filter(Boolean).join(' · ') || 'ชาร์จได้' : '⚠ ' + esc(problemText(c.problem))) + '</span></li>';
      }).join('') + '</ul>' : '<p class="hint">ยังไม่มี กด "บันทึกการชาร์จจริง" ที่จุดชาร์จในแผน หลังชาร์จเสร็จ</p>') +
      '<div class="sheet__premium">' + (load('premium') ? '<b>ขอบคุณที่สนใจ!</b> เราจะแจ้งทางอีเมลเมื่อเปิดสมาชิกรุ่นแรก'
        : '<b>สมาชิกรุ่นแรก ฿49/ปี</b> · เปิดเร็ว ๆ นี้ ราคานี้ตลอดไปสำหรับคนที่ลงชื่อไว้ <button type="button" class="btn btn--soft" data-premium>สนใจ</button>') + '</div>' +
      '<div class="row__acts"><button type="button" class="btn" data-signout>ออกจากระบบ</button><button type="button" class="btn sheet__danger" data-delete-acct>ลบบัญชีและข้อมูล</button></div>';
  }

  function acctMsg(text) { var m = $('acct-msg'); if (m) m.textContent = text || ''; }

  function busyBtn(form, on, label) {
    var btn = form.querySelector('button[type=submit]');
    A.busy = on;
    btn.disabled = on;
    if (label) btn.textContent = label;
  }

  function askCode(form) {
    var email = $('acct-email-in').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { acctMsg('อีเมลไม่ถูกต้อง'); return; }
    busyBtn(form, true, 'กำลังส่ง…');
    postJSON('/api/auth/code', { email: email }).then(function (d) {
      A.busy = false;
      A.email = email;
      A.step = 'code';
      waitForHandoff(d);
      renderAcct();
      $('acct-code-in').focus();
    }, function (err) {
      acctMsg(err.message);
      busyBtn(form, false, 'ส่งอีเมลเข้าสู่ระบบ');
    });
  }

  function checkCode(form) {
    var code = $('acct-code-in').value.replace(/\s+/g, '');
    if (!/^\d{6,10}$/.test(code)) { acctMsg('ใส่รหัสตัวเลขจากอีเมล'); return; }
    busyBtn(form, true, 'กำลังตรวจ…');
    postJSON('/api/auth/verify', { email: A.email, code: code }).then(function (s) {
      A.busy = false;
      saveSession(s);
      logEvent('signin', null, A.from);
      return loadMe(true);
    }).then(function (moved) {
      closeAcct();
      toast('✓ เข้าสู่ระบบแล้ว' + (moved ? ' · ย้ายแผน ' + moved + ' แผนจากเครื่องนี้ให้แล้ว' : ''));
      document.querySelectorAll('.nudge').forEach(function (n) { n.remove(); });
    }, function (err) {
      acctMsg(err.message);
      busyBtn(form, false, 'ยืนยัน');
    });
  }

  // ---------- signing in from the email's link on another browser ----------
  // This browser asked for the email: wait for the link to be approved wherever it opened.
  var handoffTimer = null;
  function waitForHandoff(d) {
    clearTimeout(handoffTimer);
    A.handoff = d && d.id ? { id: d.id, pair: d.pair, until: Date.now() + 15 * 60 * 1000 } : null;
    // A tab of this same browser opened by the link knows the request is ours, and that this tab is waiting.
    store('handoff', A.handoff && { id: A.handoff.id, until: A.handoff.until });
    if (A.handoff) handoffTimer = setTimeout(pollHandoff, 3000);
  }

  function pollHandoff() {
    var h = A.handoff;
    if (!h || signedIn()) { A.handoff = null; return; }
    if (Date.now() > h.until) { A.handoff = null; acctMsg('หมดเวลา ขออีเมลใหม่ได้'); return; }
    fetch('/api/auth/handoff?id=' + encodeURIComponent(h.id), { cache: 'no-store' }).then(function (r) { return r.json().catch(function () { return {}; }); }).then(function (d) {
      if (A.handoff !== h) return;
      if (d.state === 'ok' && d.session) {
        A.handoff = null;
        store('handoff', null);
        saveSession(d.session);
        logEvent('signin', null, A.from);
        loadMe(true).then(function (moved) {
          closeAcct();
          toast('✓ เข้าสู่ระบบแล้ว' + (moved ? ' · ย้ายแผน ' + moved + ' แผนจากเครื่องนี้ให้แล้ว' : ''));
        });
        return;
      }
      if (d.state === 'gone') { A.handoff = null; return; }
      handoffTimer = setTimeout(pollHandoff, 3000);
    }, function () { handoffTimer = setTimeout(pollHandoff, 5000); });
  }

  // Signed in here: another browser may be waiting for this email. Ask before letting it in.
  function checkWaiting() {
    if (!signedIn()) return;
    authFetch('/api/auth/approve', {}).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      var mine = myHandoff();
      var w = (d && d.waiting || []).filter(function (x) { return x.id !== mine; })[0];
      if (!w) return;
      A.approval = w;
      $('acct').hidden = false;
      document.body.classList.add('no-scroll');
      renderAcct();
    }).catch(function () {});
  }

  function answerApproval(yes) {
    var w = A.approval;
    A.approval = null;
    authFetch('/api/auth/approve', { method: 'POST', body: JSON.stringify({ id: w.id, approve: yes }) }).then(function (r) {
      closeAcct();
      if (yes) toast(r.ok ? '✓ อนุญาตแล้ว อุปกรณ์นั้นจะเข้าสู่ระบบในไม่กี่วินาที กลับไปที่หน้าเดิมได้เลย' : 'คำขอนี้หมดอายุแล้ว ขออีเมลใหม่จากอุปกรณ์นั้น', 7000);
    }).catch(function () { closeAcct(); });
  }

  function signOut() {
    saveSession(null);
    A.me = null;
    closeAcct();
    toast('ออกจากระบบแล้ว · แผนที่บันทึกไว้ยังอยู่ในเครื่องนี้');
  }

  function deleteAccount() {
    if (!confirm(I18N.t('ลบบัญชี ทริปที่บันทึกไว้บนระบบ และการเชื่อมประวัติการชาร์จกับอีเมลนี้ทั้งหมด?\n\nบันทึกการชาร์จจะยังอยู่แบบไม่ระบุตัวตนเพื่อช่วยข้อมูลสถานี ลบแล้วกู้คืนไม่ได้'))) return;
    authFetch('/api/me', { method: 'DELETE' }).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      saveSession(null);
      A.me = null;
      closeAcct();
      toast('ลบบัญชีแล้ว');
    }).catch(function () { toast('ลบไม่สำเร็จ ลองใหม่อีกครั้ง'); });
  }

  // ---------- contact form ----------
  var FB = { kind: 'bug', busy: false };

  function openFb(kind) {
    FB.kind = kind || 'bug';
    if (!$('acct').hidden) closeAcct();
    showFbKind();
    $('fb-form').hidden = false;
    $('fb-done').hidden = true;
    $('fb-err').textContent = '';
    if (signedIn() && !$('fb-email').value) $('fb-email').value = (A.s.user && A.s.user.email) || '';
    $('fb-contact').textContent = R.cfg && R.cfg.contact ? ' · หรืออีเมลถึง ' + R.cfg.contact : '';
    $('fb').hidden = false;
    document.body.classList.add('no-scroll');
    $('fb-msg').focus();
  }

  function closeFb() {
    $('fb').hidden = true;
    document.body.classList.remove('no-scroll');
  }

  function showFbKind() {
    document.querySelectorAll('[data-fb-kind]').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.fbKind === FB.kind ? 'true' : 'false'); });
  }

  function sendFb(e) {
    e.preventDefault();
    if (FB.busy) return;
    var msg = $('fb-msg').value.trim(), email = $('fb-email').value.trim();
    if (msg.length < 3) { $('fb-err').textContent = I18N.t('เขียนข้อความก่อนส่ง'); $('fb-msg').focus(); return; }
    var body = JSON.stringify({
      kind: FB.kind, message: msg, email: email, page: document.body.dataset.view || null, lang: I18N.lang,
      car: R.car && R.car.id, pid: R.result && R.result.pid, ua: uaShort(), dev: devId(),
    });
    var btn = $('fb-form').querySelector('[type=submit]');
    FB.busy = true;
    btn.disabled = true;
    var go = signedIn() ? authFetch('/api/feedback', { method: 'POST', body: body })
      : fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body });
    go.then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw d;
        $('fb-msg').value = '';
        $('fb-form').hidden = true;
        $('fb-done').innerHTML = '<div class="tabnote__icon" aria-hidden="true">✓</div><h2 class="sheet__title">ได้รับข้อความแล้ว</h2>' +
          '<p>' + (email ? 'ขอบคุณที่ช่วยให้ EVROUTE ดีขึ้น เราจะตอบกลับทาง ' + esc(email) : 'ขอบคุณที่ช่วยให้ EVROUTE ดีขึ้น') + '</p>' +
          '<button type="button" class="btn btn--primary btn--block" data-fb-close>ปิด</button>';
        $('fb-done').hidden = false;
      });
    }).catch(function (d) {
      var contact = (d && d.contact) || (R.cfg && R.cfg.contact);
      $('fb-err').textContent = ((d && d.error) || 'ส่งไม่สำเร็จ ลองใหม่อีกครั้ง') + (contact ? ' · หรืออีเมลถึง ' + contact : '');
    }).then(function () { FB.busy = false; btn.disabled = false; });
  }

  document.addEventListener('click', function (e) {
    var t;
    if (e.target.closest('[data-fb-open]')) { openFb(); return; }
    if (e.target.closest('[data-fb-close]')) { closeFb(); return; }
    if ((t = e.target.closest('[data-fb-kind]'))) { FB.kind = t.dataset.fbKind; showFbKind(); }
  });
  $('fb-form').addEventListener('submit', sendFb);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('fb').hidden) closeFb(); });

  // ---------- sign-up prompts ----------
  var NUDGES = {
    save: '★ บันทึกในเครื่องนี้แล้ว · <b>ใส่อีเมลเพื่อเก็บไว้ถาวร</b> เปิดได้ทุกเครื่อง',
    depart: '🗓 วางแผนล่วงหน้า? <b>ใส่อีเมลเพื่อเก็บทริปนี้</b> ไว้เปิดได้ทุกเครื่อง',
    charge: '<b>เก็บเป็นประวัติของคุณ</b> ดูค่าชาร์จรวม และอัตรากินไฟจริงของรถคุณ',
    device: 'เคยบันทึกแผนไว้ในเครื่องอื่น? <b>เข้าสู่ระบบเพื่อดึงกลับมา</b>',
  };

  function nudge(ctx) {
    if (!accountsOn() || signedIn() || (load('nudged') || {})[ctx]) return '';
    if (!A.shown[ctx]) { A.shown[ctx] = true; logEvent('nudge', null, ctx); }
    return '<div class="nudge" data-nudge="' + ctx + '"><span>' + NUDGES[ctx] + '</span><span class="nudge__acts">' +
      '<button type="button" class="btn btn--primary" data-nudge-go="' + ctx + '">ใส่อีเมล</button>' +
      '<button type="button" class="link-btn" data-nudge-no="' + ctx + '">ไว้ทีหลัง</button></span></div>';
  }

  function showDeviceNudge() {
    $('device-nudge').innerHTML = savedPlans().length ? '' : nudge('device');
  }

  document.addEventListener('click', function (e) {
    var t;
    if ((t = e.target.closest('[data-nudge-go]'))) { logEvent('nudge_go', null, t.dataset.nudgeGo); openAcct(t.dataset.nudgeGo); return; }
    if ((t = e.target.closest('[data-nudge-no]'))) {
      var n = load('nudged') || {};
      n[t.dataset.nudgeNo] = 1;
      store('nudged', n);
      t.closest('.nudge').remove();
      return;
    }
    if ((t = e.target.closest('[data-acct-open]'))) { openAcct(t.dataset.acctOpen); }
  });

  $('acct-btn').addEventListener('click', function () { openAcct('menu'); });
  $('acct').addEventListener('click', function (e) {
    var t;
    if (e.target.closest('[data-acct-close]')) { closeAcct(); return; }
    if ((t = e.target.closest('[data-acct-step]'))) { A.step = t.dataset.acctStep; renderAcct(); return; }
    if (e.target.closest('[data-acct-resend]')) {
      postJSON('/api/auth/code', { email: A.email }).then(function (d) { waitForHandoff(d); renderAcct(); acctMsg('ส่งอีเมลใหม่แล้ว'); }, function (err) { acctMsg(err.message); });
      return;
    }
    if ((t = e.target.closest('[data-approve]'))) { answerApproval(t.dataset.approve === '1'); return; }
    if (e.target.closest('[data-signout]')) { signOut(); return; }
    if (e.target.closest('[data-delete-acct]')) { deleteAccount(); return; }
    if (e.target.closest('[data-premium]')) { store('premium', 1); logEvent('premium', null, 'menu'); renderAcct(); return; }
    if ((t = e.target.closest('[data-use-real]'))) {
      R.car.use = +t.dataset.useReal;
      saveCar();
      showSpec();
      renderAcct();
      toast('ใช้อัตรากินไฟจริงของรถคุณในการวางแผนแล้ว');
      if (R.result) replan();
    }
  });
  $('acct').addEventListener('submit', function (e) {
    e.preventDefault();
    if (A.busy) return;
    if (e.target.id === 'acct-email') askCode(e.target);
    else if (e.target.id === 'acct-code') checkCode(e.target);
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('acct').hidden) closeAcct(); });

  // Supabase's default email (before custom SMTP lets us edit it to show the code) has a link
  // instead; it comes back here with the session in the URL fragment.
  function myHandoff() {
    var h = load('handoff');
    return h && h.id && h.until > Date.now() ? h.id : null;
  }

  function fromEmailLink() {
    var h = new URLSearchParams(location.hash.slice(1));
    if (!h.get('access_token') && !h.get('error_description')) return false;
    history.replaceState(null, '', location.pathname + location.search);
    if (h.get('error_description')) { toast('ลิงก์เข้าสู่ระบบใช้ไม่ได้หรือหมดอายุ ขอรหัสใหม่ได้ที่ปุ่ม “เข้าสู่ระบบ”', 7000); return true; }
    var token = h.get('access_token');
    fetch('/api/me', { headers: { Authorization: 'Bearer ' + token } }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d || !d.user) throw new Error('no user');
      saveSession({
        access_token: token, refresh_token: h.get('refresh_token'),
        expires_at: +h.get('expires_at') || Math.floor(Date.now() / 1000) + (+h.get('expires_in') || 3600), user: d.user,
      });
      logEvent('signin', null, 'menu');
      return otherTab();
    }).then(function (other) {
      // The tab that asked for the email is still open in this browser and has just signed in
      // too: send the user back there rather than leave two copies of the app open.
      if (other) { tabNote('done'); return; }
      return loadMe(true).then(function (moved) {
        toast('✓ เข้าสู่ระบบแล้ว' + (moved ? ' · ย้ายแผน ' + moved + ' แผนจากเครื่องนี้ให้แล้ว' : ''));
        checkWaiting();
      });
    }).catch(function () { toast('เข้าสู่ระบบไม่สำเร็จ ลองใหม่อีกครั้ง'); });
    return true;
  }

  // ---------- one EVROUTE tab at a time ----------
  // The email's link opens a new tab. Tabs of this browser talk over a BroadcastChannel so the new
  // one can tell whether the app is already open; a tab waiting for its email (myHandoff) counts too,
  // since a phone may have paused it in the background and it can't answer.
  var tabs = 'BroadcastChannel' in window ? new BroadcastChannel('evroute') : null;
  if (tabs) tabs.addEventListener('message', function (e) {
    var m = e.data || {};
    if (m.t === 'ping') tabs.postMessage({ t: 'here' });
    if (m.t === 'took' && $('tabnote').hidden) tabNote('moved');
  });

  function otherTab() {
    return new Promise(function (done) {
      if (myHandoff()) { done(true); return; }
      if (!tabs) { done(false); return; }
      var timer = setTimeout(function () { tabs.removeEventListener('message', on); done(false); }, 600);
      function on(e) {
        if (!e.data || e.data.t !== 'here') return;
        clearTimeout(timer);
        tabs.removeEventListener('message', on);
        done(true);
      }
      tabs.addEventListener('message', on);
      tabs.postMessage({ t: 'ping' });
    });
  }

  var TABNOTE = {
    done: ['✓', 'เข้าสู่ระบบแล้ว', 'กลับไปทำต่อที่แท็บ EVROUTE เดิมได้เลย แท็บนั้นเข้าสู่ระบบให้แล้ว แท็บนี้ไม่ต้องใช้', 'ใช้แท็บนี้ต่อแทน'],
    moved: ['⇆', 'EVROUTE เปิดใช้อยู่อีกแท็บหนึ่ง', 'คุณเลือกใช้แท็บใหม่ต่อแล้ว แท็บนี้ไม่ต้องใช้', 'ใช้แท็บนี้แทน'],
  };

  function tabNote(kind) {
    var t = TABNOTE[kind];
    if (!$('acct').hidden) closeAcct();
    $('tabnote-icon').textContent = t[0];
    $('tabnote-title').textContent = t[1];
    $('tabnote-text').textContent = t[2];
    $('tabnote-stay').textContent = t[3];
    $('tabnote-hint').hidden = true;
    $('tabnote').hidden = false;
    document.body.classList.add('no-scroll');
  }

  $('tabnote-close').addEventListener('click', function () {
    window.close();
    // Browsers only let a page close a tab it opened itself; otherwise say how.
    setTimeout(function () { $('tabnote-hint').hidden = false; }, 300);
  });
  $('tabnote-stay').addEventListener('click', function () {
    $('tabnote').hidden = true;
    document.body.classList.remove('no-scroll');
    if (tabs) tabs.postMessage({ t: 'took' });
    if (signedIn()) loadMe(true);
  });

  // Signing in or out in another tab (the email link opens one) applies here too.
  window.addEventListener('storage', function (e) { if (e.key === 'auth') syncAuth(); });
  // A phone may pause this tab in the background and miss the event: check again on return.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && JSON.stringify(load('auth')) !== JSON.stringify(A.s || null)) syncAuth();
  });

  function syncAuth() {
    var was = signedIn();
    A.s = load('auth');
    showAcctBtn();
    if (signedIn() && !was) {
      A.handoff = null;
      store('handoff', null);
      if (!$('acct').hidden) closeAcct();
      loadMe(true).then(function (moved) { toast('✓ เข้าสู่ระบบแล้ว' + (moved ? ' · ย้ายแผน ' + moved + ' แผนจากเครื่องนี้ให้แล้ว' : '')); });
    }
    if (!signedIn()) A.me = null;
  }

  function initAccount() {
    showAcctBtn();
    if (!accountsOn()) return;
    if (!fromEmailLink() && signedIn()) { loadMe(false); checkWaiting(); }
  }

  // Installable app: a service worker for offline use, and the browser's install offer kept for the
  // home screen's "เพิ่มไปที่หน้าจอโฮม" card.
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(function () {});
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); R.installEvt = e; renderHome(); });
  window.addEventListener('appinstalled', function () { R.installEvt = null; renderHome(); });

  // Start: stations load in the background; the map is Google Maps when the server has Google
  // Places switched on (its data must be shown on a Google map), otherwise Leaflet + OpenStreetMap.
  R.ready = loadStations();
  loadFloods();
  getJSON('/api/config').catch(function () { return {}; }).then(function (cfg) {
    R.cfg = cfg || {};
    if (!R.cfg.maps) return MapView.leaflet('map');
    var dark = document.documentElement.dataset.theme === 'dark' ||
      (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    return MapView.google('map', R.cfg.maps, dark).catch(function (err) {
      console.warn('Google Maps unavailable, using OpenStreetMap', err);
      R.cfg.places = null; // without a Google map, Google Places data can't be shown
      return MapView.leaflet('map');
    });
  }).then(function (view) {
    map = view;
    if (view.kind === 'google') loadSwept();
    $('map').classList.add('map--' + view.kind);
    showStatsNote();
    initAccount();
    ERR.queue.splice(0).forEach(function (d) { send('error', d); });
    // One "open" a day per browser: how many people use the app, and in which language.
    var day = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
    if (load('opened') !== day && R.cfg.stats && !load('nostats')) {
      store('opened', day);
      send('event', { kind: 'open', dev: devId(), lang: I18N.lang });
    }
    if (ARRIVE) send('event', { kind: 'arrive', ref: ARRIVE, dev: devId(), lang: I18N.lang });
    if (R.cfg.places) $('sources').insertAdjacentHTML('beforeend', ' · สถานีบางส่วน: <a href="https://www.google.com/maps" target="_blank" rel="noopener">Google Maps</a>');
    routeLayer = map.layer();
    candLayer = map.layer();
    stopLayer = map.layer();
    A.layer = map.layer(false);
    wireMap();
    fromURL();
  });
})();
