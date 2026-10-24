// Languages. The site is written in Thai; in English or Chinese, Thai text is replaced where it
// appears on the page (static HTML and everything the app renders later), from a dictionary in
// assets/i18n/<lang>.js:
//   phrases: whole texts, with every number written as # (they go back in the same order), and
//            "*" standing for any text, itself translated: "เปิดแอป *" -> "Open * app".
//   runs:    single Thai words or phrases (Thai letters and the spaces between them), used for
//            text with no whole-phrase entry, in place.
// Place and station names have no entry and stay as they are. Loaded in <head>, before the page.
(function () {
  'use strict';
  var LANGS = { th: 'ไทย', en: 'EN', zh: '中文' };
  var LOCALES = { th: 'th-TH', en: 'en-GB', zh: 'zh-CN' };

  function pick() {
    var q = new URLSearchParams(location.search).get('lang');
    if (LANGS[q]) { try { localStorage.setItem('lang', q); } catch (e) {} return q; }
    try { var s = localStorage.getItem('lang'); if (LANGS[s]) return s; } catch (e) {}
    // Thai unless the browser doesn't list Thai at all (a visitor's phone).
    var ls = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'th'];
    if (ls.some(function (l) { return /^th/i.test(l); })) return 'th';
    return /^zh/i.test(ls[0]) ? 'zh' : 'en';
  }

  var lang = pick();
  var I = window.I18N = {
    lang: lang, langs: LANGS, locale: LOCALES[lang],
    t: function (s) { return s; },
    use: function (l) {
      if (!LANGS[l] || l === lang) return;
      try { localStorage.setItem('lang', l); } catch (e) {}
      var u = new URL(location.href);
      u.searchParams.delete('lang');
      location.replace(u.toString());
    },
  };
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
  if (lang === 'th') return;

  var THAI = /[฀-฾เ-๿]/; // without the baht sign
  var RUN = /([฀-฾เ-๿](?:[฀-฾เ-๿ ]*[฀-฾เ-๿])?)(\.)?/g;
  var NUM = /\d+(?:[.,:]\d+)*/g;
  var ABBR = { 'กม': 1, 'ชม': 1, 'น': 1, 'ม': 1, 'ซม': 1 }; // "กม." -> "km", the dot is part of it
  var phrases = {}, runs = {}, patterns = [];

  function phrase(s) {
    var nums = [], key = s.replace(/\s+/g, ' ').replace(NUM, function (n) { nums.push(n); return '#'; });
    var v = phrases[key];
    if (v == null) {
      for (var i = 0; i < patterns.length && v == null; i++) {
        var m = patterns[i][0].exec(key);
        if (m) {
          var parts = m.slice(1).map(function (x) { var p = phrase(x); return p != null ? p : words(x); });
          var k = 0;
          v = patterns[i][1].replace(/\*/g, function () { return parts[k++]; });
        }
      }
    }
    if (v == null) return null;
    var j = 0;
    return v.replace(/#/g, function () { return j < nums.length ? nums[j++] : '#'; });
  }

  function words(s) {
    return s.replace(RUN, function (all, r, dot) {
      var v = runs[r];
      if (v == null && r.indexOf(' ') > 0) v = split(r);
      return v == null ? all : v + (dot && !ABBR[r.split(' ').pop()] ? dot : '');
    }).replace(/ {2,}/g, ' ');
  }

  // Two pieces of text that meet at a space make one run: translate the longest known parts.
  function split(r) {
    var w = r.split(' '), out = [], any = false;
    for (var i = 0; i < w.length;) {
      for (var j = w.length; j > i; j--) {
        var v = runs[w.slice(i, j).join(' ')];
        if (v != null) { out.push(v); any = true; i = j; break; }
      }
      if (j === i) out.push(w[i++]);
    }
    return any ? out.join(' ') : null;
  }

  function tr(s) {
    if (!s || !THAI.test(s)) return s;
    var lead = s.match(/^\s*/)[0], trail = s.match(/\s*$/)[0], core = s.trim();
    var out = phrase(core);
    if (out == null) out = core.split(' · ').map(function (seg) { var p = phrase(seg); return p != null ? p : words(seg); }).join(' · ');
    return lead + out.trim() + trail;
  }

  var ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, NOSCRIPT: 1 };

  function text(node) {
    var v = node.nodeValue;
    if (v && THAI.test(v)) { var n = tr(v); if (n !== v) node.nodeValue = n; }
  }

  function attr(el, name) {
    var v = el.getAttribute(name);
    if (v && THAI.test(v)) { var n = tr(v); if (n !== v) el.setAttribute(name, n); }
  }

  function walk(node) {
    if (node.nodeType === 3) { if (!(node.parentNode && SKIP[node.parentNode.nodeName])) text(node); return; }
    if (node.nodeType !== 1 || node.getAttribute('translate') === 'no') return;
    if (SKIP[node.nodeName] && node.nodeName !== 'TEXTAREA') return;
    for (var i = 0; i < ATTRS.length; i++) if (node.hasAttribute(ATTRS[i])) attr(node, ATTRS[i]);
    if (node.nodeName === 'TEXTAREA') return; // its placeholder, never what the user typed
    for (var c = node.firstChild; c; c = c.nextSibling) walk(c);
  }

  function skipped(node) {
    for (var p = node.parentNode; p && p.nodeType === 1; p = p.parentNode) if (p.getAttribute('translate') === 'no') return true;
    return false;
  }

  // The dictionary file calls this.
  I.load = function (d) {
    phrases = d.phrases || {};
    runs = d.runs || {};
    patterns = Object.keys(phrases).filter(function (k) { return k.indexOf('*') >= 0; }).map(function (k) {
      var re = k.replace(/[.?+^$()[\]{}|\\]/g, '\\$&').replace(/\*/g, '(.+?)');
      return [new RegExp('^' + re + '$'), phrases[k]];
    });
    I.t = tr;
    walk(document.documentElement);
    new MutationObserver(function (list) {
      list.forEach(function (m) {
        if (skipped(m.target)) return;
        if (m.type === 'characterData') text(m.target);
        else if (m.type === 'attributes') attr(m.target, m.attributeName);
        else for (var i = 0; i < m.addedNodes.length; i++) walk(m.addedNodes[i]);
      });
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  };

  // Parser-blocking, so the page never shows in Thai first.
  document.write('<script src="assets/i18n/' + lang + '.js"><\/script>');
})();
