(function () {
  'use strict';

  var P = window.EVPlan, CARS = window.EVCars;

  // server.mjs proxies both; the public services also send CORS headers, so direct calls are the fallback.
  var ROUTE_URLS = ['/api/route', 'https://valhalla1.openstreetmap.de/route'];
  var GEO_URLS = ['/api/geocode?q=', 'https://photon.komoot.io/api/?limit=5&bbox=97.3,5.6,105.7,20.5&q='];
  var MAX_GMAPS_WAYPOINTS = 9;  // Google Maps URL limit (mobile apps may honour only 3)
  var MOBILE_WAYPOINTS = 3;

  var R = {
    stations: [], operators: {}, ready: null,
    a: null, b: null, car: null, busy: false,
    pinned: [], excluded: {}, result: null,
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

  // ---------- map ----------
  var map = L.map('map', { zoomControl: true }).setView([13.4, 101.0], 6);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
  var routeLayer = L.layerGroup().addTo(map);
  var candLayer = L.layerGroup().addTo(map);
  var stopLayer = L.layerGroup().addTo(map);
  var pins = { a: null, b: null };

  function pin(which, p) {
    if (pins[which]) map.removeLayer(pins[which]);
    pins[which] = p ? L.marker([p.lat, p.lng], {
      icon: L.divIcon({ className: '', html: '<span class="rt-pin rt-pin--' + which + '">' + which.toUpperCase() + '</span>', iconSize: [28, 28], iconAnchor: [14, 14] }),
      zIndexOffset: 1000, keyboard: false
    }).bindTooltip(esc(p.label)).addTo(map) : null;
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
    if (c.id === 'custom' && !c.plugs.length) c.plugs = ['CCS2'];
    store('car', { id: c.id, kwh: c.kwh, use: c.use, dc: c.dc, margin: c.margin });
    showSpec();
  }

  function rangeKm(soc) {
    return soc / 100 * R.car.kwh / (R.car.use / 100 * (1 + R.car.margin / 100));
  }

  function showSpec() {
    var c = R.car;
    var plugs = c.plugs.length ? c.plugs.join(', ') : 'ไม่รองรับชาร์จเร็ว DC';
    $('spec').innerHTML = 'แบต <b>' + c.kwh + ' kWh</b> · กินไฟ ~' + c.use + ' kWh/100 กม. · DC สูงสุด ' + (c.dc ? c.dc + ' kW' : '–') +
      ' · หัว ' + esc(plugs) + '<br><span class="muted">วิ่งได้ราว ' + Math.round(rangeKm(100)) + ' กม. ต่อแบตเต็ม (ขับทั่วไป รวมที่เผื่อไว้ ' + c.margin + '%)</span>';
  }

  function startSoc() {
    var v = parseFloat($('soc').value);
    if (!isFinite(v) || v <= 0) return null;
    return unit() === 'km' ? P.kmToSoc(v, R.car) : Math.min(100, v);
  }
  function unit() { return document.querySelector('input[name="unit"]:checked').value; }

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
      var s = d.sources || {};
      $('updated').textContent = 'สถานีชาร์จ ' + R.stations.length.toLocaleString('th-TH') + ' แห่ง';
      $('live').className = 'live is-fresh';
      $('sources').dataset.counts = JSON.stringify(s);
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
  function plan() {
    if (!R.a || !R.b) { say('เลือกต้นทางและปลายทางก่อน'); return; }
    if (P.km(R.a, R.b) < 1) { say('ต้นทางกับปลายทางใกล้กันเกินไป'); return; }
    readTune();
    var soc = startSoc();
    if (soc == null) { say('ใส่แบตที่เหลือตอนออกเดินทาง'); return; }
    var minSoc = +$('min').value, target = +$('target').value;
    if (target - minSoc < 20) { say('"ชาร์จถึง" ควรมากกว่า "แวะชาร์จเมื่อเหลือ" อย่างน้อย 20%'); return; }
    if (soc <= minSoc) { say('แบตตอนออกเดินทาง (' + Math.round(soc) + '%) ต่ำกว่าหรือเท่ากับระดับที่ตั้งให้แวะชาร์จ (' + minSoc + '%) ควรชาร์จก่อนออกเดินทาง'); return; }

    R.busy = true;
    var go = $('go');
    go.disabled = true;
    go.textContent = 'กำลังวางแผน…';
    $('result').innerHTML = '<div class="panel rt-wait"><span class="sk sk--row"></span><span class="sk sk--row"></span><span class="sk sk--row"></span></div>';
    shareURL();
    var opts = { startSoc: soc, minSoc: minSoc, targetSoc: target, pinned: R.pinned.slice() };

    R.ready.then(function () { return route([R.a, R.b]); }).then(function (d) {
      var prof = P.profile(d.trip.legs);
      var cands = P.candidates(prof, R.stations, R.car, { exclude: R.excluded });
      var res = P.plan(prof, cands, R.car, opts);
      res.prof = prof;
      res.cands = cands;
      res.opts = opts;
      if (!res.stops.length) return res;
      // Route again through the chosen stations for real distances, times and battery levels.
      var pts = [R.a].concat(res.stops.map(function (s) { return s.st; }), [R.b]);
      return route(pts).then(function (d2) {
        var prof2 = P.profile(d2.trip.legs);
        var legs = P.replay(prof2, R.car, soc, res.stops.map(function (s) { return s.depart; }));
        res.final = prof2;
        res.legs = legs;
        res.stops.forEach(function (s, i) { s.arriveReal = legs[i].arrive; s.kmReal = legs[i].km; });
        res.arriveReal = legs[legs.length - 1].arrive;
        return res;
      }, function (err) {
        console.warn('route via stops failed', err);
        return res;
      });
    }).then(function (res) {
      R.result = res;
      render();
    }).catch(function (err) {
      console.error(err);
      $('result').innerHTML = '<div class="rt-verdict rt-verdict--crit"><b>วางแผนไม่สำเร็จ</b><span>' +
        (/no path|no suitable/i.test(err.message) ? 'ไม่พบเส้นทางรถยนต์ระหว่าง 2 จุดนี้' : 'บริการหาเส้นทางหรือข้อมูลสถานีไม่ตอบ ลองใหม่อีกครั้ง') + '</span></div>';
    }).then(function () {
      R.busy = false;
      go.disabled = false;
      go.textContent = 'วางแผนการเดินทาง';
    });
  }

  function replan() { if (R.a && R.b && !R.busy) plan(); }

  // ---------- render ----------
  function dur(min) {
    var m = Math.round(min);
    return m < 60 ? m + ' นาที' : Math.floor(m / 60) + ' ชม.' + (m % 60 ? ' ' + (m % 60) + ' นาที' : '');
  }
  function pct(v) { return Math.round(v) + '%'; }
  function km1(v) { return v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString('th-TH'); }

  function opInfo(op) { return R.operators[op] || null; }

  function appLink(op) {
    var o = opInfo(op);
    if (!o) return '';
    var ua = navigator.userAgent, url = o.web;
    if (/android/i.test(ua) && o.android) url = 'https://play.google.com/store/apps/details?id=' + encodeURIComponent(o.android);
    else if (/iphone|ipad|ipod/i.test(ua) && o.ios) url = o.ios;
    return '<a class="btn ev-app" href="' + esc(url) + '" target="_blank" rel="noopener">' +
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

  function verdict(res) {
    var c = R.car, o = res.opts;
    if (!res.ok) {
      var f = res.fail;
      var where = f.at ? 'หลัง <b>' + esc(f.at.name) + '</b> (กม. ' + km1(f.along) + ')' : 'จากต้นทาง';
      return '<div class="rt-verdict rt-verdict--crit"><b>⛔ ไปไม่ถึงด้วยสถานีชาร์จที่มีข้อมูล</b>' +
        '<span>' + where + ' วิ่งได้ถึงราว กม. ' + km1(f.reach) + ' แต่ไม่มีสถานีชาร์จ DC ที่ใช้กับ ' + esc(c.plugs.join('/') || 'รถคันนี้') + ' ในระยะที่ไปถึง (เส้นทางยาว ' + km1(res.km) + ' กม.)</span>' +
        '<span class="small">ลองชาร์จให้เต็มกว่านี้ ตั้ง "ชาร์จถึง" สูงขึ้น ลด "แวะชาร์จเมื่อเหลือ" หรือหาสถานีในแอปผู้ให้บริการ (ข้อมูลสถานีของเรายังไม่ครบทุกเครือข่าย)</span></div>';
    }
    var total = (res.final ? res.final.min : res.driveMin) + res.chargeMin;
    var distance = res.final ? res.final.km : res.km;
    var arrive = res.arriveReal != null ? res.arriveReal : res.arrive;
    var low = res.legs && res.legs.some(function (l) { return l.arrive < o.minSoc - 3; });
    var head = !res.stops.length
      ? '<b>✅ ไม่ต้องแวะชาร์จ</b><span>ถึงปลายทางเหลือแบตราว <b>' + pct(arrive) + '</b></span>'
      : '<b>⚡ แวะชาร์จ ' + res.stops.length + ' จุด</b><span>ชาร์จรวม ~' + dur(res.chargeMin) + ' · ถึงปลายทางเหลือแบตราว <b>' + pct(arrive) + '</b></span>';
    return '<div class="rt-verdict ' + (low ? 'rt-verdict--warn' : 'rt-verdict--ok') + '">' + head +
      '<div class="ev-nums"><span><b>' + km1(distance) + '</b> กม.</span><span><b>' + dur(total) + '</b> รวมเวลา</span><span>ขับ ' + dur(res.final ? res.final.min : res.driveMin) + '</span></div>' +
      (low ? '<span>⚠️ บางช่วงแบตอาจต่ำกว่า ' + o.minSoc + '% เพราะต้องอ้อมเข้าสถานี เผื่อเวลาชาร์จเพิ่มเล็กน้อย</span>' : '') +
      '</div>';
  }

  function stopCard(s, i, res) {
    var st = s.st, arrive = s.arriveReal != null ? s.arriveReal : s.arrive;
    var off = s.c.off < 0.15 ? 'ติดเส้นทาง' : 'ห่างเส้นทาง ' + km1(s.c.off) + ' กม.';
    var alts = s.alts.length ? '<details class="ev-alts"><summary>เปลี่ยนสถานี (' + s.alts.length + ')</summary><ul>' +
      s.alts.map(function (a) {
        return '<li><button type="button" class="ev-alt" data-swap="' + i + '" data-id="' + esc(a.c.st.id) + '">' +
          '<b>' + esc(a.c.st.name) + '</b><span>' + esc(a.c.st.op || '') + ' · ' + a.c.kw + ' kW · กม. ' + km1(a.c.along) + ' · ถึงแล้วเหลือ ~' + pct(a.arrive) + (a.c.st.guess ? ' · ยังไม่ยืนยันหัวชาร์จ' : '') + '</span></button></li>';
      }).join('') + '</ul></details>' : '';
    return '<li class="ev-stop" data-lat="' + st.lat + '" data-lng="' + st.lng + '">' +
      '<span class="ev-stop__n">' + (i + 1) + '</span>' +
      '<div class="ev-stop__body">' +
        '<div class="ev-stop__km">กม. ' + km1(s.kmReal != null ? s.kmReal : s.along) + ' · ' + off + (s.pinned ? ' · <span class="ev-tag">เลือกเอง</span>' : '') + '</div>' +
        '<div class="ev-stop__name">' + esc(st.name) + '</div>' +
        '<div class="ev-stop__op">' + esc(st.op || 'ไม่ทราบผู้ให้บริการ') + ' · ' + esc(plugText(st)) + '</div>' +
        (st.guess ? '<div class="ev-stop__warn">ข้อมูลหัวชาร์จ/กำลังไฟยังไม่ยืนยัน ตรวจในแอปก่อน</div>' : '') +
        (st.addr ? '<div class="ev-stop__addr">' + esc(st.addr) + '</div>' : '') +
        (st.hours ? '<div class="ev-stop__addr">เวลาเปิด: ' + esc(st.hours) + '</div>' : '') +
        '<div class="ev-bar" aria-label="แบตถึง ' + pct(arrive) + ' ชาร์จถึง ' + pct(s.depart) + '">' +
          '<span class="ev-bar__a" style="width:' + Math.max(0, Math.min(100, arrive)) + '%"></span>' +
          '<span class="ev-bar__c" style="left:' + Math.max(0, Math.min(100, arrive)) + '%;width:' + Math.max(0, s.depart - Math.max(0, arrive)) + '%"></span>' +
        '</div>' +
        '<div class="ev-stop__soc">ถึง <b>' + pct(arrive) + '</b> → ชาร์จถึง <b>' + pct(s.depart) + '</b> · ~' + dur(s.chargeMin + P.PLUG_MIN) + ' · +' + s.kwhAdded.toFixed(1) + ' kWh (' + Math.round(s.c.kw) + ' kW)</div>' +
        '<div class="ev-stop__acts">' +
          '<a class="btn" href="' + gmapsDir(i ? res.stops[i - 1].st : R.a, st) + '" target="_blank" rel="noopener">นำทางมาที่นี่</a>' +
          appLink(st.op) +
          '<button type="button" class="btn ev-skip" data-skip="' + esc(st.id) + '">ไม่แวะที่นี่</button>' +
        '</div>' + alts +
      '</div></li>';
  }

  function navBlock(res) {
    var via = res.stops.map(function (s) { return s.st; });
    var html = '<div class="panel ev-nav">';
    if (via.length <= MAX_GMAPS_WAYPOINTS) {
      html += '<a class="btn btn--primary rt-go" href="' + gmapsDir(R.a, R.b, via) + '" target="_blank" rel="noopener">เปิดเส้นทางทั้งหมดใน Google Maps</a>';
    }
    if (via.length > MOBILE_WAYPOINTS || via.length > MAX_GMAPS_WAYPOINTS) {
      html += '<p class="muted small">แอป Google Maps บนมือถือบางเครื่องรับจุดแวะได้ไม่เกิน ' + MOBILE_WAYPOINTS + ' จุด ถ้าจุดแวะหายไป ให้นำทางทีละช่วง:</p><ol class="ev-legs">';
      var pts = [R.a].concat(via, [R.b]);
      for (var i = 0; i + 1 < pts.length; i++) {
        html += '<li><a href="' + gmapsDir(pts[i], pts[i + 1]) + '" target="_blank" rel="noopener">ช่วง ' + (i + 1) + ': ' +
          esc(i ? via[i - 1].name : R.a.label) + ' → ' + esc(i < via.length ? via[i].name : R.b.label) + '</a></li>';
      }
      html += '</ol>';
    }
    html += '<button type="button" class="btn ev-share" id="share">คัดลอกลิงก์แผนนี้</button></div>';
    return html;
  }

  function render() {
    var res = R.result;
    var html = verdict(res);
    if (res.ok || res.stops.length) {
      var arrive = res.arriveReal != null ? res.arriveReal : res.arrive;
      html += '<ol class="ev-timeline">' +
        '<li class="ev-end"><span class="rt-pin rt-pin--a">A</span><div><b>' + esc(R.a.label) + '</b><span class="muted small">ออกเดินทาง แบต ' + pct(res.opts.startSoc) + '</span></div></li>' +
        res.stops.map(function (s, i) { return stopCard(s, i, res); }).join('') +
        (res.ok ? '<li class="ev-end"><span class="rt-pin rt-pin--b">B</span><div><b>' + esc(R.b.label) + '</b><span class="muted small">ถึงปลายทาง แบตเหลือราว ' + pct(arrive) + '</span></div></li>' : '') +
        '</ol>';
      if (res.ok) html += navBlock(res);
    }
    if (R.pinned.length || Object.keys(R.excluded).length) {
      html += '<button type="button" class="link-btn ev-reset" id="reset">ล้างการเลือกสถานีเอง แล้วให้ระบบเลือกใหม่</button>';
    }
    $('result').innerHTML = html;
    draw();
  }

  function draw() {
    var res = R.result;
    routeLayer.clearLayers();
    candLayer.clearLayers();
    stopLayer.clearLayers();
    if (!res) return;
    var pts = (res.final || res.prof).pts;
    L.polyline(pts, { color: '#fff', weight: 9, opacity: 0.9, interactive: false }).addTo(routeLayer);
    L.polyline(pts, { color: css('accent'), weight: 5, opacity: 1, interactive: false }).addTo(routeLayer);

    var chosen = {};
    res.stops.forEach(function (s) { chosen[s.st.id] = true; });
    res.cands.forEach(function (c) {
      if (chosen[c.st.id]) return;
      L.circleMarker([c.st.lat, c.st.lng], {
        radius: 6, color: '#fff', weight: 2, fillColor: c.st.guess ? css('unk') : css('down'), fillOpacity: 0.95
      }).bindPopup(stationPopup(c), { maxWidth: 280 }).addTo(candLayer);
    });
    res.stops.forEach(function (s, i) {
      L.marker([s.st.lat, s.st.lng], {
        icon: L.divIcon({ className: '', html: '<span class="ev-pin">' + (i + 1) + '</span>', iconSize: [30, 30], iconAnchor: [15, 15] }),
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

  function stationPopup(c) {
    var st = c.st;
    return '<b>' + esc(st.name) + '</b><br>' + esc(st.op || 'ไม่ทราบผู้ให้บริการ') + '<br>' + esc(plugText(st)) +
      '<br><span class="muted small">กม. ' + km1(c.along) + ' · ' + (c.off < 0.15 ? 'ติดเส้นทาง' : 'ห่างเส้นทาง ' + km1(c.off) + ' กม.') + '</span>' +
      (st.guess ? '<br><span class="small">ข้อมูลหัวชาร์จยังไม่ยืนยัน</span>' : '') +
      '<br><button type="button" class="btn ev-add" data-add="' + esc(st.id) + '">แวะชาร์จที่นี่</button>';
  }

  function say(msg) {
    $('result').innerHTML = '<div class="rt-verdict rt-verdict--info"><span>' + esc(msg) + '</span></div>';
  }

  // ---------- inputs ----------
  function setPoint(which, p) {
    R[which] = p;
    $(which === 'a' ? 'from' : 'to').value = p ? p.label : '';
    pin(which, p);
    if (p && !(R.a && R.b)) map.setView([p.lat, p.lng], Math.max(map.getZoom(), 11));
  }

  function newTrip() { R.pinned = []; R.excluded = {}; }

  function suggest(input, list, which) {
    var timer, last = '';
    input.addEventListener('input', function () {
      R[which] = null;
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
          }).join('') : '<li class="rt-sug__none">ไม่พบสถานที่ ลองพิมพ์ชื่ออำเภอหรือจังหวัด หรือแตะบนแผนที่</li>';
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
      if (which === 'a') $('to').focus();
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !list.hidden && list._res && list._res.length) {
        e.preventDefault();
        setPoint(which, list._res[0]);
        newTrip();
        list.hidden = true;
        if (which === 'a') $('to').focus(); else if (R.a) plan();
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
      var q = new URLSearchParams({
        from: R.a.lat.toFixed(5) + ',' + R.a.lng.toFixed(5), fn: R.a.label,
        to: R.b.lat.toFixed(5) + ',' + R.b.lng.toFixed(5), tn: R.b.label,
        car: c.id, soc: $('soc').value, u: unit(), min: $('min').value, tgt: $('target').value,
      });
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
    setCar(carId, tune);
    if (q.get('soc')) $('soc').value = q.get('soc');
    if (q.get('u') === 'km') document.querySelector('input[name="unit"][value="km"]').checked = true;
    if (q.get('min')) $('min').value = q.get('min');
    if (q.get('tgt')) $('target').value = q.get('tgt');
    if (q.get('pin')) R.pinned = q.get('pin').split(',').filter(Boolean);
    if (q.get('ex')) q.get('ex').split(',').forEach(function (id) { if (id) R.excluded[id] = true; });
    var a = parse(q.get('from'), q.get('fn')), b = parse(q.get('to'), q.get('tn'));
    if (a) setPoint('a', a);
    if (b) setPoint('b', b);
    if (a && b) plan();
  }

  // ---------- events ----------
  $('brand').innerHTML = brands().map(function (b) { return '<option>' + esc(b) + '</option>'; }).join('');
  $('brand').addEventListener('change', function () {
    fillModels($('brand').value);
    setCar($('model').value);
    readTune();
    if (R.result) replan();
  });
  $('model').addEventListener('change', function () { setCar($('model').value); readTune(); if (R.result) replan(); });
  ['kwh', 'use', 'dc', 'margin'].forEach(function (id) { $(id).addEventListener('change', function () { readTune(); }); });
  document.querySelectorAll('input[name="unit"]').forEach(function (el) {
    el.addEventListener('change', function () {
      // Convert the number in the box so it keeps meaning the same charge.
      var v = parseFloat($('soc').value);
      if (!isFinite(v)) return;
      $('soc').value = el.value === 'km' ? Math.round(rangeKm(v)) : Math.round(P.kmToSoc(v, R.car));
      $('soc').max = el.value === 'km' ? 1000 : 100;
    });
  });

  suggest($('from'), $('from-sug'), 'a');
  suggest($('to'), $('to-sug'), 'b');
  $('from-gps').addEventListener('click', gps);
  $('swap').addEventListener('click', function () {
    var a = R.a, b = R.b;
    setPoint('a', b);
    setPoint('b', a);
    newTrip();
    if (R.a && R.b && R.result) plan();
  });
  $('form').addEventListener('submit', function (e) { e.preventDefault(); if (!R.busy) plan(); });
  map.on('click', function (e) {
    var p = { lat: e.latlng.lat, lng: e.latlng.lng, label: 'จุดที่เลือก (' + e.latlng.lat.toFixed(4) + ', ' + e.latlng.lng.toFixed(4) + ')' };
    if (R.result) return; // with a plan on screen, taps open station popups instead
    setPoint(!R.a ? 'a' : 'b', p);
    newTrip();
    if (R.a && R.b && !R.busy) plan();
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

  $('result').addEventListener('click', function (e) {
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
    if ((t = e.target.closest('#share'))) {
      shareURL();
      var done = function () { t.textContent = 'คัดลอกแล้ว ✓'; setTimeout(function () { t.textContent = 'คัดลอกลิงก์แผนนี้'; }, 2000); };
      if (navigator.share && /android|iphone|ipad/i.test(navigator.userAgent)) navigator.share({ title: document.title, url: location.href }).catch(function () {});
      else if (navigator.clipboard) navigator.clipboard.writeText(location.href).then(done, function () {});
      return;
    }
    if (e.target.closest('a, button, summary, details')) return;
    var li = e.target.closest('.ev-stop');
    if (li) map.setView([+li.dataset.lat, +li.dataset.lng], 15);
  });

  $('theme').addEventListener('click', function () {
    var t = document.documentElement.dataset.theme;
    var dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('theme', dark ? 'light' : 'dark'); } catch (e) {}
    if (R.result) draw();
  });

  R.ready = loadStations();
  fromURL();
})();
