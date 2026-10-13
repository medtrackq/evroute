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
    pinned: [], excluded: {}, result: null, chart: 'soc',
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
  var map = L.map('map', { zoomControl: false }).setView([13.4, 101.0], 6);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
  var routeLayer = L.layerGroup().addTo(map);
  var candLayer = L.layerGroup().addTo(map);
  var stopLayer = L.layerGroup().addTo(map);
  var pins = { a: null, b: null };

  // Destinations are lettered from B: dests[0] = B, dests[1] = C ...
  function letter(i) { return String.fromCharCode(66 + i); }
  function pinClass(i) { return i === 'a' ? 'a' : i === 0 ? 'b' : 'd'; }

  function pin(which, p) {
    var key = String(which);
    if (pins[key]) map.removeLayer(pins[key]);
    pins[key] = p ? L.marker([p.lat, p.lng], {
      icon: L.divIcon({ className: '', html: '<span class="pin pin--' + pinClass(which) + '">' + (which === 'a' ? 'A' : letter(which)) + '</span>', iconSize: [30, 30], iconAnchor: [15, 15] }),
      zIndexOffset: 1000, keyboard: false
    }).bindTooltip(esc(p.label)).addTo(map) : null;
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
    $('kwh').value = R.car.kwh;
    $('use').value = R.car.use;
    $('dc').value = R.car.dc;
    $('margin').value = R.car.margin;
    showSpec();
  }

  function readTune() {
    var c = R.car, n = function (id, lo, hi, def) { var v = parseFloat($(id).value); return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; };
    c.kwh = n('kwh', 10, 200, c.kwh);
    c.use = n('use', 8, 40, c.use);
    c.dc = n('dc', 0, 400, c.dc);
    c.margin = n('margin', 0, 50, c.margin);
    store('car', { id: c.id, kwh: c.kwh, use: c.use, dc: c.dc, margin: c.margin });
    showSpec();
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

  function showSpec() {
    var c = R.car;
    $('car-brand').textContent = c.brand === 'อื่น ๆ' ? 'รถของคุณ' : c.brand;
    $('car-name').textContent = c.id === 'custom' ? 'กำหนดเอง' : c.model;
    $('spec').innerHTML =
      tile('lav', 'bat', 'แบตเตอรี่', c.kwh, 'kWh') +
      tile('sun', 'use', 'กินไฟ', c.use, '/100กม.') +
      tile('mint', 'dc', 'DC สูงสุด', c.dc || '–', c.dc ? 'kW' : '', esc(c.plugs.join(', ') || 'ไม่รองรับ DC')) +
      tile('sky', 'road', 'วิ่งได้ราว', Math.round(rangeKm(100)), 'กม.', 'ต่อแบตเต็ม');
    syncRange();
  }

  function unit() { return radio('unit'); }
  function startSoc() {
    var v = parseFloat($('soc').value);
    if (!isFinite(v) || v <= 0) return null;
    return unit() === 'km' ? P.kmToSoc(v, R.car) : Math.min(100, v);
  }

  // The slider mirrors the number box in whichever unit is selected.
  function syncRange() {
    var r = $('soc-range'), km = unit() === 'km';
    var max = km ? Math.round(rangeKm(100)) : 100;
    r.min = km ? 5 : 5;
    r.max = max;
    var v = parseFloat($('soc').value);
    if (isFinite(v)) r.value = Math.min(max, v);
    r.style.setProperty('--p', ((r.value - r.min) / (r.max - r.min) * 100) + '%');
    var soc = startSoc();
    $('soc-hint').textContent = soc == null ? 'แบตตอนออกเดินทาง'
      : km ? 'แบตตอนออกเดินทาง ≈ ' + Math.round(soc) + '%'
      : 'แบตตอนออกเดินทาง · วิ่งได้ราว ' + Math.round(rangeKm(soc)) + ' กม.';
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
    return Promise.all([ops, st]);
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
    var opts = { startSoc: soc, minSoc: minSoc, targetSoc: target, pinned: R.pinned.slice() };

    R.ready.then(function () { return route([R.a].concat(t.targets)); }).then(function (d) {
      var prof = P.profile(d.trip.legs);
      var cands = P.candidates(prof, R.stations, R.car, { exclude: R.excluded });
      var res = P.plan(prof, cands, R.car, opts);
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
      render();
    }).catch(function (err) {
      console.error(err);
      clearResult();
      say(/no path|no suitable/i.test(err.message) ? 'ไม่พบเส้นทางรถยนต์ระหว่าง 2 จุดนี้' : 'บริการหาเส้นทางหรือข้อมูลสถานีไม่ตอบ ลองใหม่อีกครั้ง', 'crit');
    }).then(function () { setBusy(false); });
  }

  function replan() { if (R.a && trip().dests.length && !R.busy) plan(); }

  // ---------- render ----------
  function dur(min) {
    var m = Math.round(min);
    return m < 60 ? m + ' นาที' : Math.floor(m / 60) + ' ชม.' + (m % 60 ? ' ' + (m % 60) + ' นาที' : '');
  }
  function pct(v) { return Math.round(v) + '%'; }
  function km1(v) { return v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString('th-TH'); }
  function clock(minFromNow) {
    var d = new Date(Date.now() + minFromNow * 60000);
    return d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  }

  function appLink(op) {
    var o = R.operators[op];
    if (!o) return '';
    var ua = navigator.userAgent, url = o.web;
    if (/android/i.test(ua) && o.android) url = 'https://play.google.com/store/apps/details?id=' + encodeURIComponent(o.android);
    else if (/iphone|ipad|ipod/i.test(ua) && o.ios) url = o.ios;
    return '<a class="btn btn--soft" href="' + esc(url) + '" target="_blank" rel="noopener">' +
      (o.booking ? 'จองผ่านแอป ' : 'เปิดแอป ') + esc(o.app || o.name) + '</a>';
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
      total: drive + (res.chargeMin || 0),
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
          '<b>' + esc(x.c.st.name) + '</b><span>' + esc(x.c.st.op || '') + ' · ' + x.c.kw + ' kW · กม. ' + km1(x.c.along) + ' · ถึงแล้วเหลือ ~' + pct(x.arrive) + (x.c.st.guess ? ' · ยังไม่ยืนยันหัวชาร์จ' : '') + '</span></button></li>';
      }).join('') + '</ul></details>' : '';
    return '<li class="row" data-lat="' + st.lat + '" data-lng="' + st.lng + '">' +
      '<div class="row__top"><span class="row__n">' + (i + 1) + '</span>' +
        '<div class="row__main"><span class="row__name">' + esc(st.name) + (s.pinned ? '<span class="tag">เลือกเอง</span>' : '') + userTag(st) + '</span>' +
        '<span class="row__meta">กม. ' + km1(s.kmReal != null ? s.kmReal : s.along) + ' · ' + off + ' · ' + esc(st.op || 'ไม่ทราบผู้ให้บริการ') + '</span></div>' +
        '<span class="row__kwh"><span class="bolt">' + BOLT + '</span>+' + Math.round(s.kwhAdded) + ' kWh</span></div>' +
      '<div class="row__body">' +
        '<span class="row__plug">' + esc(plugText(st)) + '</span>' +
        (st.guess ? '<span class="row__warn">ข้อมูลหัวชาร์จ/กำลังไฟยังไม่ยืนยัน ตรวจในแอปก่อน</span>' : '') +
        (st.addr ? '<span class="row__addr">' + esc(st.addr) + '</span>' : '') +
        (st.hours ? '<span class="row__addr">เวลาเปิด: ' + esc(st.hours) + '</span>' : '') +
        (st.note ? '<span class="row__addr">หมายเหตุ: ' + esc(st.note) + '</span>' : '') +
        '<div class="socbar" role="img" aria-label="แบตถึง ' + pct(arrive) + ' ชาร์จถึง ' + pct(s.depart) + '">' +
          '<span class="socbar__a" style="width:' + a + '%"></span><span class="socbar__c" style="left:' + a + '%;width:' + Math.max(0, s.depart - a) + '%"></span></div>' +
        '<span>ถึง <b>' + pct(arrive) + '</b> → ชาร์จถึง <b>' + pct(s.depart) + '</b> · ~' + dur(s.chargeMin + P.PLUG_MIN) + ' (' + Math.round(s.c.kw) + ' kW)</span>' +
        '<div class="row__acts">' +
          '<a class="btn" href="' + gmapsDir(prev, st) + '" target="_blank" rel="noopener">นำทางมาที่นี่</a>' +
          appLink(st.op) +
          '<button type="button" class="btn" data-skip="' + esc(st.id) + '">ไม่แวะที่นี่</button>' +
        '</div>' + alts +
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
        tile('sun', 'dc', 'เติมไฟ', Math.round(t.kwh), 'kWh') +
        tile('mint', 'flag', 'ถึงปลายทาง', res.ok ? Math.round(t.arrive) : '–', res.ok ? '%' : '') +
      '</div>' +
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
      html += '<a class="btn btn--primary" href="' + gmapsDir(R.a, end, via) + '" target="_blank" rel="noopener">' + BOLT + 'เปิดเส้นทางทั้งหมดใน Google Maps</a>' +
        (via.length ? '<p class="hint">จุดชาร์จ ' + res.stops.length + ' จุด' + (via.length > res.stops.length ? ' และจุดหมายของคุณ' : '') + ' ถูกใส่เป็นจุดแวะ (Add destination) ให้แล้ว</p>' : '');
    }
    if (via.length > MOBILE_WAYPOINTS || via.length > MAX_GMAPS_WAYPOINTS) {
      html += '<p class="hint">' + (via.length > MAX_GMAPS_WAYPOINTS ? 'จุดแวะเกิน ' + MAX_GMAPS_WAYPOINTS + ' จุด ซึ่ง Google Maps รับไม่ได้ ให้นำทางทีละช่วง:' : 'แอป Google Maps บนมือถือบางเครื่องรับจุดแวะได้ไม่เกิน ' + MOBILE_WAYPOINTS + ' จุด ถ้าจุดแวะหายไป ให้นำทางทีละช่วง:') + '</p><ol class="legs">';
      var pts = [R.a].concat(via, [end]);
      for (var i = 0; i + 1 < pts.length; i++) {
        html += '<li><a href="' + gmapsDir(pts[i], pts[i + 1]) + '" target="_blank" rel="noopener">' + esc(name(pts[i])) + ' → ' + esc(name(pts[i + 1])) + '</a></li>';
      }
      html += '</ol>';
    }
    html += '<button type="button" class="btn" id="share">คัดลอกลิงก์แผนนี้</button></section>';
    return html;
  }

  function render() {
    var res = R.result;
    $('result').hidden = false;
    $('result').innerHTML = resultCard(res);
    $('summary').hidden = false;
    $('summary').innerHTML = summary(res);
    $('nav').innerHTML = navCard(res);
    $('chart-card').hidden = !res.ok && !res.stops.length;
    chart();
    draw();
  }

  function clearResult() {
    R.result = null;
    $('summary').hidden = true;
    $('chart-card').hidden = true;
    $('nav').innerHTML = '';
    routeLayer.clearLayers();
    candLayer.clearLayers();
    stopLayer.clearLayers();
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
    $('chart-kpi').innerHTML = 'เติมไฟรวม<b>' + Math.round(t.kwh) + '<small>kWh · ' + dur(res.chargeMin) + '</small></b>';
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
        tip.innerHTML = '<b>' + esc(s.st.name) + '</b><br>+' + s.kwhAdded.toFixed(1) + ' kWh · ' + dur(s.chargeMin + P.PLUG_MIN);
      };
      g.addEventListener('pointerenter', show);
      g.addEventListener('pointerdown', show);
      g.addEventListener('pointerleave', function () { tip.hidden = true; });
    });
  }

  // ---------- map drawing ----------
  function draw() {
    var res = R.result;
    routeLayer.clearLayers();
    candLayer.clearLayers();
    stopLayer.clearLayers();
    if (!res) return;
    var pts = (res.final || res.prof).pts;
    L.polyline(pts, { color: css('accent'), weight: 12, opacity: 0.18, interactive: false }).addTo(routeLayer);
    L.polyline(pts, { color: css('accent'), weight: 5, opacity: 1, interactive: false, lineCap: 'round' }).addTo(routeLayer);

    var chosen = {};
    res.stops.forEach(function (s) { chosen[s.st.id] = true; });
    res.cands.forEach(function (c) {
      if (chosen[c.st.id]) return;
      L.circleMarker([c.st.lat, c.st.lng], {
        radius: 6, color: '#fff', weight: 2, fillColor: c.st.guess ? css('unk') : css('accent'), fillOpacity: 0.95
      }).bindPopup(stationPopup(c), { maxWidth: 280 }).addTo(candLayer);
    });
    res.stops.forEach(function (s, i) {
      L.marker([s.st.lat, s.st.lng], {
        icon: L.divIcon({ className: '', html: '<span class="pin pin--stop">' + (i + 1) + '</span>', iconSize: [30, 30], iconAnchor: [15, 15] }),
        zIndexOffset: 900
      }).bindPopup('<b>' + esc(s.st.name) + '</b><br>' + esc(s.st.op || '') + '<br>' + esc(plugText(s.st)), { maxWidth: 280 }).addTo(stopLayer);
    });
    if (res.fail && res.fail.reach) {
      var p = pointAt(res.prof, res.fail.reach);
      if (p) L.circleMarker(p, { radius: 9, color: '#fff', weight: 2.5, fillColor: css('crit'), fillOpacity: 1 })
        .bindTooltip('แบตถึงระดับต่ำสุดราวตรงนี้', { direction: 'top' }).addTo(stopLayer);
    }
    map.fitBounds(L.latLngBounds(pts), { padding: [30, 30] });
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
      (st.guess ? '<br><span class="hint">ข้อมูลหัวชาร์จยังไม่ยืนยัน</span>' : '') +
      '<br><button type="button" class="btn btn--soft popup-add" data-add="' + esc(st.id) + '">แวะชาร์จที่นี่</button>';
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
    if (p && !(R.a && R.dests[0])) map.setView([p.lat, p.lng], Math.max(map.getZoom(), 11));
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
    Object.keys(pins).forEach(function (k) { if (k !== 'a') { if (pins[k]) map.removeLayer(pins[k]); delete pins[k]; } });
    R.dests.forEach(function (p, i) { pin(i, p); });
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
  ['kwh', 'use', 'dc', 'margin'].forEach(function (id) { $(id).addEventListener('change', function () { readTune(); }); });

  $('soc').addEventListener('input', syncRange);
  $('soc-range').addEventListener('input', function () { $('soc').value = this.value; syncRange(); });
  $('soc-range').addEventListener('change', function () { if (R.result) replan(); });
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
    el.addEventListener('change', function () { if (R.result) replan(); });
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
  map.on('click', function (e) {
    if (A.open) { setAddPoint({ lat: e.latlng.lat, lng: e.latlng.lng }); return; }
    if (R.result) return; // with a plan on screen, taps open station popups instead
    var p = { lat: e.latlng.lat, lng: e.latlng.lng, label: 'จุดที่เลือก (' + e.latlng.lat.toFixed(4) + ', ' + e.latlng.lng.toFixed(4) + ')' };
    var free = R.dests.indexOf(null);
    if (R.a && free < 0) return;
    setPoint(!R.a ? 'a' : free, p);
    newTrip();
    if (R.a && R.dests.indexOf(null) < 0 && !R.busy) plan();
  });

  // "แวะชาร์จที่นี่" in a station popup on the map.
  map.getContainer().addEventListener('click', function (e) {
    var b = e.target.closest('[data-add]');
    if (!b) return;
    var id = b.dataset.add;
    delete R.excluded[id];
    if (R.pinned.indexOf(id) < 0) R.pinned.push(id);
    map.closePopup();
    replan();
  });

  document.querySelectorAll('[data-chart]').forEach(function (b) {
    b.addEventListener('click', function () { R.chart = b.dataset.chart; chart(); });
  });

  function onResultClick(e) {
    var t;
    if ((t = e.target.closest('[data-swap]'))) {
      var old = R.result.stops[+t.dataset.swap].st.id;
      R.pinned = R.pinned.filter(function (id) { return id !== old; });
      R.pinned.push(t.dataset.id);
      replan();
      return;
    }
    if ((t = e.target.closest('[data-skip]'))) {
      R.excluded[t.dataset.skip] = true;
      R.pinned = R.pinned.filter(function (id) { return id !== t.dataset.skip; });
      replan();
      return;
    }
    if (e.target.closest('#reset')) { newTrip(); replan(); return; }
    if (e.target.closest('[data-addopen]')) { openAdd(true); return; }
    if ((t = e.target.closest('#share'))) {
      shareURL();
      var done = function () { t.textContent = 'คัดลอกแล้ว ✓'; setTimeout(function () { t.textContent = 'คัดลอกลิงก์แผนนี้'; }, 2000); };
      if (navigator.share && /android|iphone|ipad/i.test(navigator.userAgent)) navigator.share({ title: document.title, url: location.href }).catch(function () {});
      else if (navigator.clipboard) navigator.clipboard.writeText(location.href).then(done, function () {});
      return;
    }
    if (e.target.closest('a, button, summary, details')) return;
    var li = e.target.closest('.row[data-lat]');
    if (li) map.setView([+li.dataset.lat, +li.dataset.lng], 15);
  }
  $('result').addEventListener('click', onResultClick);
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
  var A = { open: false, point: null, marker: null, layer: L.layerGroup() };

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
    if (A.marker) { map.removeLayer(A.marker); A.marker = null; }
    var w = $('add-where');
    if (!p) {
      w.textContent = 'แตะบนแผนที่เพื่อปักหมุด (ลากหมุดเพื่อขยับได้)';
      w.classList.remove('is-set');
      return;
    }
    A.marker = L.marker([p.lat, p.lng], {
      draggable: true, zIndexOffset: 1100,
      icon: L.divIcon({ className: '', html: '<span class="pin pin--new">+</span>', iconSize: [30, 30], iconAnchor: [15, 15] })
    }).addTo(map);
    A.marker.on('dragend', function () { var ll = A.marker.getLatLng(); setAddPoint({ lat: ll.lat, lng: ll.lng }); });
    w.textContent = '📍 ' + p.lat.toFixed(5) + ', ' + p.lng.toFixed(5) + nearText(p);
    w.classList.add('is-set');
    if (center) map.setView([p.lat, p.lng], Math.max(map.getZoom(), 15));
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
    A.layer.clearLayers();
    R.stations.forEach(function (st) {
      L.circleMarker([st.lat, st.lng], { radius: 4, color: '#fff', weight: 1.5, fillColor: st.guess ? css('unk') : css('accent'), fillOpacity: 0.9 })
        .bindTooltip(esc(st.name) + (st.src === 'user' ? ' (ผู้ใช้เพิ่ม)' : ''), { direction: 'top' }).addTo(A.layer);
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
      A.layer.addTo(map);
      $('add-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      setAddPoint(null);
      map.removeLayer(A.layer);
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

  R.ready = loadStations();
  fromURL();
})();
