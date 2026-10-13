// One small map interface over Leaflet (OpenStreetMap tiles, the free default) and the Google Maps
// JavaScript API (used when Google Places data is on, since Google requires its data to be shown
// on a Google map). The page only talks to this interface.
//
// view.setView(lat, lng, zoom) · view.getZoom() · view.fit([[lat, lng], ...], padPx)
// view.onClick(fn(lat, lng)) · view.closePopup() · view.container
// view.layer(visible) -> { clear(), show(bool) }
// view.pin(lat, lng, { html, z, tooltip, popup, draggable, onDragEnd(lat, lng), layer }) -> { remove() }
// view.dot(lat, lng, { radius, fill, popup, tooltip, layer }) -> { remove() }
// view.line([[lat, lng], ...], { color, weight, opacity, layer })
(function (root) {
  'use strict';

  function escText(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------- Leaflet ----------
  function leaflet(id) {
    var map = L.map(id, { zoomControl: false }).setView([13.4, 101.0], 6);
    L.control.zoom({ position: 'topright' }).addTo(map);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    var base = L.layerGroup().addTo(map);

    function place(obj, o) {
      if (o.popup) obj.bindPopup(o.popup, { maxWidth: 290 });
      if (o.tooltip) obj.bindTooltip(escText(o.tooltip), { direction: 'top' });
      obj.addTo((o.layer && o.layer._group) || base);
      return { remove: function () { obj.remove(); } };
    }

    return {
      kind: 'leaflet',
      container: map.getContainer(),
      setView: function (lat, lng, zoom) { map.setView([lat, lng], zoom); },
      getZoom: function () { return map.getZoom(); },
      fit: function (pts, pad) { if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [pad, pad] }); },
      onClick: function (fn) { map.on('click', function (e) { fn(e.latlng.lat, e.latlng.lng); }); },
      closePopup: function () { map.closePopup(); },
      layer: function (visible) {
        var g = L.layerGroup();
        if (visible !== false) g.addTo(map);
        return { _group: g, clear: function () { g.clearLayers(); }, show: function (on) { if (on) g.addTo(map); else map.removeLayer(g); } };
      },
      pin: function (lat, lng, o) {
        var m = L.marker([lat, lng], {
          icon: L.divIcon({ className: '', html: o.html, iconSize: [30, 30], iconAnchor: [15, 15] }),
          zIndexOffset: o.z || 0, draggable: !!o.draggable, keyboard: false,
        });
        if (o.onDragEnd) m.on('dragend', function () { var p = m.getLatLng(); o.onDragEnd(p.lat, p.lng); });
        return place(m, o);
      },
      dot: function (lat, lng, o) {
        return place(L.circleMarker([lat, lng], { radius: o.radius || 6, color: '#fff', weight: o.radius > 5 ? 2 : 1.5, fillColor: o.fill, fillOpacity: 0.95 }), o);
      },
      line: function (pts, o) {
        return place(L.polyline(pts, { color: o.color, weight: o.weight, opacity: o.opacity == null ? 1 : o.opacity, interactive: false, lineCap: 'round' }), o);
      },
    };
  }

  // ---------- Google Maps ----------
  function loadGoogle(key) {
    return new Promise(function (ok, fail) {
      if (root.google && root.google.maps && root.google.maps.marker) { ok(); return; }
      var cb = '__evrouteMapsReady';
      root[cb] = function () { ok(); };
      root.gm_authFailure = function () { fail(new Error('google maps auth failed')); };
      var s = document.createElement('script');
      s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) + '&v=weekly&loading=async&libraries=marker&language=th&region=TH&callback=' + cb;
      s.async = true;
      s.onerror = function () { fail(new Error('google maps failed to load')); };
      document.head.appendChild(s);
      setTimeout(function () { fail(new Error('google maps timeout')); }, 15000);
    });
  }

  function google(id, cfg, dark) {
    return loadGoogle(cfg.key).then(function () {
      var g = root.google.maps;
      var el = document.getElementById(id);
      var map = new g.Map(el, {
        center: { lat: 13.4, lng: 101.0 }, zoom: 6, mapId: cfg.mapId,
        disableDefaultUI: true, zoomControl: true, clickableIcons: false, gestureHandling: 'greedy',
        colorScheme: dark ? 'DARK' : 'LIGHT',
      });
      var info = new g.InfoWindow({ maxWidth: 300 });
      var base = { items: [], visible: true };

      function track(item, o) {
        var layer = o.layer || base;
        layer.items.push(item);
        item.attach(layer.visible ? map : null);
        return { remove: function () { item.attach(null); var i = layer.items.indexOf(item); if (i >= 0) layer.items.splice(i, 1); } };
      }

      // HTML content centred on the point (Advanced Markers anchor at the bottom centre).
      function marker(lat, lng, html, o) {
        var box = document.createElement('div');
        box.style.transform = 'translateY(50%)';
        box.innerHTML = html;
        if (o.tooltip) box.title = o.tooltip;
        var m = new g.marker.AdvancedMarkerElement({ position: { lat: lat, lng: lng }, content: box, zIndex: o.z || 0, gmpDraggable: !!o.draggable });
        if (o.popup) {
          box.style.cursor = 'pointer';
          m.addListener('click', function () { info.setContent(o.popup); info.open({ anchor: m, map: map }); });
        }
        if (o.onDragEnd) {
          m.addListener('dragend', function () {
            var p = m.position, la = typeof p.lat === 'function' ? p.lat() : p.lat, ln = typeof p.lng === 'function' ? p.lng() : p.lng;
            o.onDragEnd(la, ln);
          });
        }
        return track({ attach: function (mp) { m.map = mp; } }, o);
      }

      return {
        kind: 'google',
        container: el,
        setView: function (lat, lng, zoom) { map.setCenter({ lat: lat, lng: lng }); map.setZoom(zoom); },
        getZoom: function () { return map.getZoom() || 6; },
        fit: function (pts, pad) {
          if (!pts.length) return;
          var b = new g.LatLngBounds();
          pts.forEach(function (p) { b.extend({ lat: p[0], lng: p[1] }); });
          map.fitBounds(b, pad);
        },
        onClick: function (fn) { map.addListener('click', function (e) { fn(e.latLng.lat(), e.latLng.lng()); }); },
        closePopup: function () { info.close(); },
        layer: function (visible) {
          var layer = { items: [], visible: visible !== false };
          layer.clear = function () { layer.items.forEach(function (it) { it.attach(null); }); layer.items = []; };
          layer.show = function (on) { layer.visible = on; layer.items.forEach(function (it) { it.attach(on ? map : null); }); };
          return layer;
        },
        pin: function (lat, lng, o) { return marker(lat, lng, o.html, o); },
        dot: function (lat, lng, o) {
          var r = o.radius || 6;
          return marker(lat, lng, '<span style="display:block;width:' + 2 * r + 'px;height:' + 2 * r + 'px;border-radius:50%;background:' + o.fill +
            ';border:' + (r > 5 ? 2 : 1.5) + 'px solid #fff;box-shadow:0 1px 3px rgb(0 0 0 / 30%)"></span>', o);
        },
        line: function (pts, o) {
          var pl = new g.Polyline({ path: pts.map(function (p) { return { lat: p[0], lng: p[1] }; }), strokeColor: o.color, strokeWeight: o.weight, strokeOpacity: o.opacity == null ? 1 : o.opacity, clickable: false });
          return track({ attach: function (mp) { pl.setMap(mp); } }, o);
        },
      };
    });
  }

  root.MapView = { leaflet: function (id) { return Promise.resolve(leaflet(id)); }, google: google };
})(window);
