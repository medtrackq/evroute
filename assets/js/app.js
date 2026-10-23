(function () {
  'use strict';

  var P = window.EVPlan, CARS = window.EVCars;

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
    return seen;
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
    R.car = {
      id: base.id, brand: base.brand, model: base.model, plugs: base.plugs.slice(), ac: base.ac,
      kwh: +t.kwh || base.kwh, use: +t.use || base.use, dc: t.dc != null ? +t.dc : base.dc,
      margin: t.margin != null ? +t.margin : 10,
    };
    showSpec();
    showPhoto();
  }

  // Reads the tile inputs while they're open for editing; otherwise just saves the current car.
  function readTune() {
    var c = R.car, n = function (id, lo, hi, def) { var v = $(id) ? parseFloat($(id).value) : NaN; return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; };
    c.kwh = n('kwh', 10, 200, c.kwh);
    c.use = n('use', 8, 40, c.use);
    c.dc = n('dc', 0, 400, c.dc);
    c.margin = n('margin', 0, 50, c.margin);
    store('car', { id: c.id, kwh: c.kwh, use: c.use, dc: c.dc, margin: c.margin });
    $('range-km').textContent = Math.round(rangeKm(100));
    syncRange();
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

  // The same tile with its number as an input, for "ปรับค่ารถ".
  function editTile(color, icon, k, id, v, unit, min, max, step, sub) {
    return '<label class="tile tile--' + color + ' is-edit"><span class="tile__ico" aria-hidden="true">' + ICONS[icon] + '</span>' +
      '<span class="tile__k">' + k + '</span><span class="tile__v"><input id="' + id + '" class="tile__in" type="number" inputmode="decimal" min="' + min + '" max="' + max + '" step="' + step + '" value="' + v + '">' +
      '<small>' + unit + '</small></span>' + (sub ? '<span class="tile__sub">' + sub + '</span>' : '') + '</label>';
  }

  function showSpec() {
    var c = R.car;
    $('car-brand').textContent = c.brand === 'อื่น ๆ' ? 'รถของคุณ' : c.brand;
    $('car-name').textContent = c.id === 'custom' ? 'กำหนดเอง' : c.model;
    var plugs = esc(c.plugs.join(', ') || 'ไม่รองรับ DC'), range = '<span id="range-km">' + Math.round(rangeKm(100)) + '</span>';
    $('spec').innerHTML = R.tuning
      ? editTile('lav', 'bat', 'แบตที่ใช้ได้', 'kwh', c.kwh, 'kWh', 10, 200, 0.1) +
        editTile('sun', 'use', 'กินไฟ', 'use', c.use, '/100กม.', 8, 40, 0.1) +
        editTile('mint', 'dc', 'DC สูงสุด', 'dc', c.dc, 'kW', 0, 400, 1, plugs) +
        editTile('sky', 'road', 'เผื่อไว้', 'margin', c.margin, '%', 0, 50, 1, 'วิ่งได้ราว ' + range + ' กม.')
      : tile('lav', 'bat', 'แบตเตอรี่', c.kwh, 'kWh') +
        tile('sun', 'use', 'กินไฟ', c.use, '/100กม.') +
        tile('mint', 'dc', 'DC สูงสุด', c.dc || '–', c.dc ? 'kW' : '', plugs) +
        tile('sky', 'road', 'วิ่งได้ราว', range, 'กม.', 'ต่อแบตเต็ม');
    syncRange();
  }

  function setTuning(on) {
    R.tuning = on;
    $('tune-btn').setAttribute('aria-expanded', on);
    $('tune-btn').classList.toggle('is-on', on);
    $('tune-btn').querySelector('span').textContent = on ? 'เสร็จ' : 'ปรับค่ารถ';
    $('tune-hint').hidden = !on;
    showSpec();
    if (on) $('kwh').focus();
  }

  // Photo of the chosen model from Wikimedia Commons, with the credit its licence asks for.
  function showPhoto() {
    if (!R.car) return; // the photo list can arrive before the car is chosen
    var id = R.car.id, img = null;
    Object.keys(R.photos || {}).forEach(function (k) { if (id === k || id.indexOf(k + '-') === 0) img = R.photos[k]; });
    $('car-photo').hidden = !img;
    $('car-hero').classList.toggle('has-photo', !!img);
    if (!img) return;
    $('car-img').src = img.thumb;
    $('car-img').alt = R.car.brand + ' ' + R.car.model;
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

  function route(points) {
    return postRoute({
      locations: points.map(function (p) { return { lat: p.lat, lon: p.lng, type: 'break' }; }),
      costing: 'auto', units: 'kilometers', directions_type: 'maneuvers'
    });
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
    getJSON('data/prices.json').then(function (d) { R.prices = d.prices || {}; if (R.result) render(); }, function () {});
    var st = getJSON('/api/stations').then(function (d) {
      R.stations = d.stations || [];
      $('updated').textContent = 'สถานีชาร์จ ' + R.stations.length.toLocaleString('th-TH') + ' แห่ง';
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
  function setBusy(on) {
    R.busy = on;
    $('go').disabled = on;
    $('go').querySelector('span').textContent = on ? 'กำลังวางแผน…' : 'วางแผนการเดินทาง';
  }

  function plan() {
    var t = trip();
    if (!R.a || !t.dests.length) { say('เลือกต้นทางและปลายทางก่อน'); return; }
    if (t.targets.length === 1 && P.km(R.a, t.end) < 1) { say('ต้นทางกับปลายทางใกล้กันเกินไป'); return; }
    readTune();
    var soc = startSoc();
    if (soc == null) { say('ใส่แบตที่เหลือตอนออกเดินทาง'); return; }
    var minSoc = +radio('min'), target = +radio('target');
    if (soc <= minSoc) { say('แบตตอนออกเดินทาง (' + Math.round(soc) + '%) ต่ำกว่าหรือเท่ากับระดับที่ตั้งให้แวะชาร์จ (' + minSoc + '%) ควรชาร์จก่อนออกเดินทาง'); return; }

    setBusy(true);
    var box = $('result');
    box.hidden = false;
    box.innerHTML = '<span class="sk"></span><span class="sk"></span><span class="sk"></span>';
    shareURL();
    var opts = { startSoc: soc, minSoc: minSoc, targetSoc: target, pinned: R.pinned.slice(), favs: favIds(), avoid: avoidIds() };

    R.ready.then(function () { return route([R.a].concat(t.targets)); }).then(function (d) {
      var prof = P.profile(d.trip.legs);
      var cands = P.candidates(prof, R.stations, R.car, { exclude: R.excluded });
      var res = P.plan(prof, cands, R.car, opts);
      // Where our own data is thin, ask Google for the stations there and plan again. A plan that
      // still gets stuck asks again further along (up to 5 rounds within GOOGLE_MAX_POINTS searches).
      // A plan that already works only gets a few searches to improve its choices.
      var total = 0, budget = res.ok ? 3 : GOOGLE_MAX_POINTS;
      var round = function (n) {
        return fillGaps(prof, cands, res, opts, Math.min(6, budget)).then(function (g) {
          budget -= g.asked;
          if (!g.added) return;
          total += g.added;
          cands = P.candidates(prof, R.stations, R.car, { exclude: R.excluded });
          res = P.plan(prof, cands, R.car, opts);
          if (!res.ok && n < 5 && budget > 0) return round(n + 1);
        });
      };
      return round(1).then(function () {
        if (total) res.googleAdded = total;
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
      if (!res.ok) return res;
      if (!res.stops.length) return settle(prof);
      if (items.length + 2 > MAX_ROUTE_POINTS) return res;
      // Route again through the chosen stations for real distances, times and battery levels.
      return route([R.a].concat(items.map(function (it) { return it.p; }), [t.end])).then(function (d2) {
        return settle(P.profile(d2.trip.legs));
      }, function (err) {
        console.warn('route via stops failed', err);
        return res;
      });
    }).then(function (res) {
      R.result = res;
      res.pid = newPid();
      render();
      logPlan(res);
    }).catch(function (err) {
      console.error(err);
      clearResult();
      say(/no path|no suitable/i.test(err.message) ? 'ไม่พบเส้นทางรถยนต์ระหว่าง 2 จุดนี้' : 'บริการหาเส้นทางหรือข้อมูลสถานีไม่ตอบ ลองใหม่อีกครั้ง', 'crit');
    }).then(function () { setBusy(false); });
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
        : '<span class="saved-when">ยังไม่ระบุวัน · บันทึก ' + esc(new Date(p.at).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })) + '</span>';
      return '<li><a href="' + esc(p.q) + '"><b>' + esc(p.title) + '</b>' + tag + '<span>จาก ' + esc(p.from) + ' · ' + esc(p.car) + ' · ' + p.km + ' กม. · ชาร์จ ' + p.stops + ' จุด</span></a>' +
        '<button type="button" class="saved-del" data-unsave="' + x.i + '" aria-label="ลบแผนนี้">×</button></li>';
    }).join('') + (list.length && accountsOn() && !signedIn()
      ? '<li class="saved-foot">เก็บในเครื่องนี้ · <button type="button" class="link-btn" data-acct-open="saved">เข้าสู่ระบบเพื่อใช้ทุกเครื่อง</button></li>' : '');
  }

  function replan() { if (R.a && trip().dests.length && !R.busy) plan(); }

  // ---------- render ----------
  function dur(min) {
    var m = Math.round(min);
    return m < 60 ? m + ' นาที' : Math.floor(m / 60) + ' ชม.' + (m % 60 ? ' ' + (m % 60) + ' นาที' : '');
  }
  function pct(v) { return Math.round(v) + '%'; }
  function km1(v) { return v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString('th-TH'); }
  // Arrival time, minutes after departure; with the date when that isn't today.
  function clock(minAfterStart) {
    var d = new Date(departAt() + minAfterStart * 60000);
    var t = d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? t : d.toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short' }) + ' ' + t;
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
    return d.toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short', year: '2-digit' }) +
      (withTime ? ' ' + d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) + ' น.' : '');
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
        '<div class="row__main"><span class="row__name">' + esc(st.name) + (s.pinned ? '<span class="tag">เลือกเอง</span>' : '') + (R.favs[st.id] ? '<span class="tag tag--fav">★ โปรด</span>' : '') + userTag(st) + '</span>' +
        '<span class="row__meta">กม. ' + km1(s.kmReal != null ? s.kmReal : s.along) + ' · ' + off + ' · ' + esc(st.op || 'ไม่ทราบผู้ให้บริการ') + '</span></div>' +
        '<span class="row__kwh"><span class="bolt">' + BOLT + '</span>+' + Math.round(s.kwhAdded) + ' kWh</span></div>' +
      '<div class="row__body">' +
        '<span class="row__plug">' + esc(plugText(st)) + '</span>' +
        (doubtful(st, s.c.plug) ? '<span class="row__warn">ข้อมูลหัวชาร์จ/กำลังไฟยังไม่ยืนยัน ตรวจในแอปก่อน</span>' : '') +
        repLines(st) +
        (st.addr ? '<span class="row__addr">' + esc(st.addr) + '</span>' : '') +
        (st.hours ? '<span class="row__addr">เวลาเปิด: ' + esc(st.hours) + '</span>' : '') +
        (st.note ? '<span class="row__addr">หมายเหตุ: ' + esc(st.note) + '</span>' : '') +
        (st.url ? '<span class="row__addr">' + googleLink(st) + '</span>' : '') +
        '<div class="socbar" role="img" aria-label="แบตถึง ' + pct(arrive) + ' ชาร์จถึง ' + pct(s.depart) + '">' +
          '<span class="socbar__a" style="width:' + a + '%"></span><span class="socbar__c" style="left:' + a + '%;width:' + Math.max(0, s.depart - a) + '%"></span></div>' +
        '<span>ถึง <b>' + pct(arrive) + '</b> → ชาร์จถึง <b>' + pct(s.depart) + '</b> · ~' + dur(s.chargeMin + P.PLUG_MIN) + ' (' + Math.round(s.c.kw) + ' kW)' + costText(s.cost) + '</span>' +
        '<div class="row__acts">' +
          '<a class="btn" href="' + gmapsDir(prev, st) + '" target="_blank" rel="noopener"' + evAttr('nav_stop', st) + '>นำทางมาที่นี่</a>' +
          appLink(st) +
          favButton(st) +
          '<button type="button" class="btn" data-skip="' + esc(st.id) + '">ไม่แวะที่นี่</button>' +
          (R.cfg && R.cfg.stats ? '<button type="button" class="btn report-btn" data-report="' + i + '">' + (R.reported[st.id] ? 'บันทึกการชาร์จแล้ว ✓' : 'บันทึกการชาร์จจริง') + '</button>' : '') +
        '</div>' + '<div class="report-slot"></div>' + alts +
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
    if (!res.ok && !res.stops.length) return failText(res);
    var t = totals(res), o = res.opts;
    var low = res.legs && res.legs.some(function (l) { return l.arrive < o.minSoc - 3; });
    var html = (res.ok ? '' : failText(res)) +
      '<div class="tiles">' +
        (res.chargeMin < 60 ? tile('lav', 'time', 'ชาร์จรวม', Math.round(res.chargeMin || 0), 'นาที')
          : tile('lav', 'time', 'ชาร์จรวม', Math.floor(res.chargeMin / 60) + ':' + String(Math.round(res.chargeMin % 60)).padStart(2, '0'), 'ชม.')) +
        (res.cost != null ? tile('sun', 'dc', 'ค่าไฟโดยประมาณ', '฿' + Math.round(res.cost).toLocaleString('th-TH'), '', Math.round(t.kwh) + ' kWh')
          : tile('sun', 'dc', 'เติมไฟ', Math.round(t.kwh), 'kWh')) +
        tile('mint', 'flag', 'ถึงปลายทาง', res.ok ? Math.round(t.arrive) : '–', res.ok ? '%' : '') +
      '</div>' +
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

  function navCard(res) {
    if (!res.ok) return '';
    // Charging stations and the user's own stops go in as Google Maps waypoints, in driving order.
    var via = (res.items || []).map(function (it) { return it.p; });
    var end = res.trip.end;
    var name = function (p) { return p.name || p.label; };
    var html = '<section class="card nav-card">';
    if (via.length <= MAX_GMAPS_WAYPOINTS) {
      html += '<a class="btn btn--primary" href="' + gmapsDir(R.a, end, via) + '" target="_blank" rel="noopener" data-ev="nav">' + BOLT + 'เปิดเส้นทางทั้งหมดใน Google Maps</a>' +
        (via.length ? '<p class="hint">จุดชาร์จ ' + res.stops.length + ' จุด' + (via.length > res.stops.length ? ' และจุดหมายของคุณ' : '') + ' ถูกใส่เป็นจุดแวะ (Add destination) ให้แล้ว ' +
          'โดยส่งเป็นพิกัด Google Maps จึงอาจแสดงชื่อสถานที่ข้าง ๆ แทน เช่น 7-11 หรือร้านในปั๊มเดียวกัน แต่นำทางไปตำแหน่งสถานีชาร์จถูกต้อง</p>' : '');
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
    return ' · <b>~฿' + Math.round(c.baht).toLocaleString('th-TH') + '</b> <span class="hint">(' + c.rate + ' ฿/kWh' +
      (c.offPeak ? ' ช่วง Off-Peak' : '') + (c.known ? '' : ' ราคาเฉลี่ย') + ')</span>';
  }

  function render() {
    var res = R.result;
    priceStops(res);
    $('result').hidden = false;
    $('result').innerHTML = resultCard(res);
    $('summary').hidden = false;
    $('summary').innerHTML = summary(res);
    $('nav').innerHTML = navCard(res);
    $('chart-card').hidden = !res.ok && !res.stops.length;
    chart();
    draw();
    fillAreas(res);
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
    $('chart-kpi').innerHTML = 'เติมไฟรวม<b>' + Math.round(t.kwh) + '<small>kWh · ' + dur(res.chargeMin) + (res.cost != null ? ' · ~฿' + Math.round(res.cost).toLocaleString('th-TH') : '') + '</small></b>';
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

  function newTrip() { R.pinned = []; R.excluded = {}; }

  function suggest(input, list, which) {
    var timer, last = '';
    input.addEventListener('input', function () {
      if (which === 'a') R.a = null; else R.dests[which] = null;
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
      toast('แผนนี้เคยตั้งไว้วันที่ ' + esc(thaiDate(depT)) + '<br>เลือกวันเดินทางใหม่ได้ที่ช่อง “ออกเดินทาง”', 7000);
    }
    if (a && ds.length) plan();
  }

  function togglePicker(open) {
    var p = $('picker'), btn = $('switch-car');
    p.hidden = open === undefined ? !p.hidden : !open;
    btn.setAttribute('aria-expanded', !p.hidden);
  }

  // ---------- events ----------
  $('brand').innerHTML = brands().map(function (b) { return '<option>' + esc(b) + '</option>'; }).join('');
  $('switch-car').addEventListener('click', function () { togglePicker(); });
  $('brand').addEventListener('change', function () {
    fillModels($('brand').value);
    setCar($('model').value);
    readTune();
    if (R.result) replan();
  });
  $('model').addEventListener('change', function () { setCar($('model').value); readTune(); if (R.result) replan(); });
  $('tune-btn').addEventListener('click', function () { setTuning(!R.tuning); });
  $('spec').addEventListener('input', function (e) { if (e.target.matches('.tile__in')) readTune(); });
  $('spec').addEventListener('change', function (e) { if (e.target.matches('.tile__in') && R.result) replan(); });
  $('spec').addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.matches('.tile__in')) { e.preventDefault(); setTuning(false); } });
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
  $('form').addEventListener('submit', function (e) { e.preventDefault(); if (!R.busy) plan(); });
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
        $('updated').textContent = 'สถานีชาร์จ ' + R.stations.length.toLocaleString('th-TH') + ' แห่ง';
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
    this.textContent = 'เริ่มรหัสใหม่แล้ว ✓';
  });
  $('stats-toggle').addEventListener('click', function () {
    store('nostats', !load('nostats'));
    showStatsNote();
  });

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
    $('acct').hidden = true;
    document.body.classList.remove('no-scroll');
  }

  function carName(id) {
    var c = CARS.filter(function (x) { return x.id === id; })[0];
    return c ? c.brand + ' ' + c.model : id;
  }

  function renderAcct() {
    var b = $('acct-body');
    if (!signedIn()) {
      b.innerHTML = A.step === 'email'
        ? '<h2 class="sheet__title" id="acct-title">เก็บทริปของคุณไว้ทุกเครื่อง</h2>' +
          '<ul class="sheet__perks"><li>ทริปที่บันทึกไว้ เปิดได้ทุกเครื่อง ไม่หายเมื่อล้างเบราว์เซอร์</li><li>ประวัติการชาร์จ และอัตรากินไฟจริงของรถคุณ</li></ul>' +
          '<form class="sheet__form" id="acct-email"><label class="opt__label" for="acct-email-in">อีเมล</label>' +
          '<input id="acct-email-in" class="field" type="email" inputmode="email" autocomplete="email" required placeholder="you@example.com" value="' + esc(A.email) + '">' +
          '<p class="sheet__msg" id="acct-msg" role="status"></p>' +
          '<button type="submit" class="btn btn--primary btn--block">ส่งอีเมลเข้าสู่ระบบ</button></form>' +
          '<p class="hint">ฟรีช่วงทดสอบ · ไม่ต้องตั้งรหัสผ่าน · ใช้อีเมลเพื่อเก็บข้อมูลของคุณเท่านั้น · <a href="privacy.html" target="_blank" rel="noopener">นโยบายความเป็นส่วนตัว</a></p>'
        : '<h2 class="sheet__title" id="acct-title">ใส่รหัสจากอีเมล</h2>' +
          '<p class="hint">ส่งอีเมลไปที่ <b>' + esc(A.email) + '</b> แล้ว (ถ้าไม่เห็น ดูในโฟลเดอร์สแปม) ใส่รหัสในอีเมล หรือ<b>กดลิงก์ในอีเมล</b>บนเครื่องนี้</p>' +
          '<form class="sheet__form" id="acct-code"><label class="sr-only" for="acct-code-in">รหัส</label>' +
          '<input id="acct-code-in" class="field sheet__code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="10" required placeholder="รหัส 6 หลัก">' +
          '<p class="sheet__msg" id="acct-msg" role="status"></p>' +
          '<button type="submit" class="btn btn--primary btn--block">ยืนยัน</button></form>' +
          '<p class="hint"><button type="button" class="link-btn" data-acct-step="email">เปลี่ยนอีเมล</button> · <button type="button" class="link-btn" data-acct-resend>ส่งรหัสอีกครั้ง</button></p>';
      return;
    }
    var me = A.me || {}, trips = savedPlans().length, charges = me.charges || [], use = me.use || {};
    var month = new Date().toISOString().slice(0, 7), mBaht = 0, mKwh = 0;
    charges.forEach(function (c) { if (c.ok && String(c.created_at).slice(0, 7) === month) { mBaht += +c.baht || 0; mKwh += +c.kwh || 0; } });
    var useHtml = Object.keys(use).map(function (id) {
      var u = use[id];
      return '<li><b>' + esc(carName(id)) + '</b> กินไฟจริง <b>' + u.kwh100 + '</b> kWh/100 กม. <span class="hint">(จาก ' + u.km.toLocaleString('th-TH') + ' กม.)</span>' +
        (R.car && R.car.id === id && Math.abs(R.car.use - u.kwh100) >= 0.1 ? ' <button type="button" class="link-btn" data-use-real="' + u.kwh100 + '">ใช้ค่านี้วางแผน</button>' : '') + '</li>';
    }).join('');
    b.innerHTML = '<h2 class="sheet__title" id="acct-title">บัญชีของฉัน</h2><p class="hint">' + esc(A.s.user && A.s.user.email || '') + '</p>' +
      '<div class="sheet__stats"><div><b>' + trips + '</b><span>ทริปที่บันทึกไว้</span></div><div><b>' + charges.length + '</b><span>บันทึกการชาร์จ</span></div>' +
      '<div><b>฿' + Math.round(mBaht).toLocaleString('th-TH') + '</b><span>ค่าชาร์จเดือนนี้' + (mKwh ? ' · ' + Math.round(mKwh) + ' kWh' : '') + '</span></div></div>' +
      '<h3 class="sheet__h">อัตรากินไฟจริงของรถคุณ</h3>' +
      (useHtml ? '<ul class="sheet__list">' + useHtml + '</ul>' : '<p class="hint">ใส่ <b>เลขไมล์</b> ตอน "บันทึกการชาร์จจริง" ตั้งแต่ 2 ครั้งขึ้นไป ระบบจะคำนวณให้ แม่นกว่าค่าจากโรงงาน</p>') +
      '<h3 class="sheet__h">ประวัติการชาร์จ</h3>' +
      (charges.length ? '<ul class="sheet__list sheet__hist">' + charges.slice(0, 20).map(function (c) {
        return '<li><span>' + esc(new Date(c.created_at).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' })) + '</span><b>' + esc(c.station_name || c.op || 'สถานี') + '</b>' +
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
    postJSON('/api/auth/code', { email: email }).then(function () {
      A.busy = false;
      A.email = email;
      A.step = 'code';
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

  function signOut() {
    saveSession(null);
    A.me = null;
    closeAcct();
    toast('ออกจากระบบแล้ว · แผนที่บันทึกไว้ยังอยู่ในเครื่องนี้');
  }

  function deleteAccount() {
    if (!confirm('ลบบัญชี ทริปที่บันทึกไว้บนระบบ และการเชื่อมประวัติการชาร์จกับอีเมลนี้ทั้งหมด?\n\nบันทึกการชาร์จจะยังอยู่แบบไม่ระบุตัวตนเพื่อช่วยข้อมูลสถานี ลบแล้วกู้คืนไม่ได้')) return;
    authFetch('/api/me', { method: 'DELETE' }).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      saveSession(null);
      A.me = null;
      closeAcct();
      toast('ลบบัญชีแล้ว');
    }).catch(function () { toast('ลบไม่สำเร็จ ลองใหม่อีกครั้ง'); });
  }

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
      postJSON('/api/auth/code', { email: A.email }).then(function () { acctMsg('ส่งรหัสใหม่แล้ว'); }, function (err) { acctMsg(err.message); });
      return;
    }
    if (e.target.closest('[data-signout]')) { signOut(); return; }
    if (e.target.closest('[data-delete-acct]')) { deleteAccount(); return; }
    if (e.target.closest('[data-premium]')) { store('premium', 1); logEvent('premium', null, 'menu'); renderAcct(); return; }
    if ((t = e.target.closest('[data-use-real]'))) {
      R.car.use = +t.dataset.useReal;
      store('car', { id: R.car.id, kwh: R.car.kwh, use: R.car.use, dc: R.car.dc, margin: R.car.margin });
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
      return loadMe(true);
    }).then(function (moved) {
      toast('✓ เข้าสู่ระบบแล้ว' + (moved ? ' · ย้ายแผน ' + moved + ' แผนจากเครื่องนี้ให้แล้ว' : ''));
    }, function () { toast('เข้าสู่ระบบไม่สำเร็จ ลองใหม่อีกครั้ง'); });
    return true;
  }

  function initAccount() {
    showAcctBtn();
    if (!accountsOn()) return;
    if (!fromEmailLink() && signedIn()) loadMe(false);
  }

  // Start: stations load in the background; the map is Google Maps when the server has Google
  // Places switched on (its data must be shown on a Google map), otherwise Leaflet + OpenStreetMap.
  R.ready = loadStations();
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
    $('map').classList.add('map--' + view.kind);
    showStatsNote();
    initAccount();
    if (R.cfg.places) $('sources').insertAdjacentHTML('beforeend', ' · สถานีบางส่วน: <a href="https://www.google.com/maps" target="_blank" rel="noopener">Google Maps</a>');
    routeLayer = map.layer();
    candLayer = map.layer();
    stopLayer = map.layer();
    A.layer = map.layer(false);
    wireMap();
    fromURL();
  });
})();
