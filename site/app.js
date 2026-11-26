/* Market hub front end. Reads data/news.json (written by fetcher/fetch.py) and renders the feed. */
(function () {
  'use strict';

  var DATA_URL = 'data/news.json';
  var PAGE = 60;
  var POLL_MS = 5 * 60 * 1000;

  var CATS = [
    { id: 'all', label: 'All' },
    { id: 'filings', label: 'Filings' },
    { id: 'regulators', label: 'RBI / SEBI' },
    { id: 'markets', label: 'Markets' },
    { id: 'global', label: 'Global' },
    { id: 'video', label: 'Video' }
  ];
  var VIEWS = [
    { id: 'all', label: 'Everything' },
    { id: 'important', label: 'Important' },
    { id: 'watchlist', label: 'Watchlist' },
    { id: 'saved', label: 'Saved' }
  ];

  // ---------- small storage wrapper (private mode can throw)
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('mh.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('mh.' + k, JSON.stringify(v)); } catch (e) {} }
  };

  var state = {
    data: null,
    view: 'all',
    cat: 'all',
    q: '',
    routine: store.get('routine', false),
    shown: PAGE,
    saved: store.get('saved', {}),           // id -> item copy, so saved stories outlive the 7-day window
    read: new Set(store.get('read', [])),
    prevVisit: store.get('lastVisit', null), // ISO time of the previous visit
    focus: -1,
    list: [],
    wl: store.get('watchlist', []),         // [{symbol, name, terms}] kept on this device
    companies: null                          // NSE company list for search, loaded on demand
  };

  var $ = function (s) { return document.querySelector(s); };
  var feedEl = $('#feed');

  // ---------- helpers
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function safeUrl(u) { return /^https?:\/\//i.test(u || '') ? u : '#'; }

  var istTime = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
  var istDay = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
  var istKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' });

  function ago(iso) {
    if (!iso) return '';
    var d = new Date(iso), s = (Date.now() - d) / 1000;
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 6 * 3600) return Math.floor(s / 3600) + 'h';
    var today = istKey.format(new Date()), day = istKey.format(d);
    if (day === today) return istTime.format(d);
    var y = new Date(Date.now() - 864e5);
    if (day === istKey.format(y)) return 'Yesterday ' + istTime.format(d);
    return istDay.format(d) + ', ' + istTime.format(d);
  }
  function fmtNum(n) {
    if (n == null) return '–';
    return n >= 1000 ? n.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }

  // ---------- watchlist matching (done here, so the list stays private to this device)
  function reEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  var wlMatchers = [];
  function compileWatchlist() {
    wlMatchers = state.wl.map(function (s) {
      var terms = (s.terms || []).filter(Boolean).map(reEsc);
      return {
        name: s.name,
        terms: terms.length ? new RegExp('(?<![\\w&])(' + terms.join('|') + ')(?![\\w&])', 'i') : null,
        // Symbols match only in capitals, so "SAIL" doesn't match "sail".
        symbol: s.symbol && s.symbol.length >= 3 ? new RegExp('(?<![\\w&])' + reEsc(s.symbol) + '(?![\\w&])') : null
      };
    });
  }
  function applyWatchlist(items) {
    (items || []).forEach(function (it) {
      var text = it.title + ' ' + (it.summary || '');
      it.wl = wlMatchers.filter(function (m) { return (m.terms && m.terms.test(text)) || (m.symbol && m.symbol.test(text)); })
        .map(function (m) { return m.name; });
    });
  }
  function stocksOf(it) {
    var out = (it.stocks || []).slice();
    (it.wl || []).forEach(function (n) { if (out.indexOf(n) === -1) out.push(n); });
    return out;
  }
  function prio(it) {
    var p = it.priority || 0;
    if (it.routine || !(it.wl && it.wl.length)) return p;
    return (it.category === 'filings' || (it.tags || []).length) ? 2 : Math.max(p, 1);
  }
  function refreshWatchlist() {
    compileWatchlist();
    if (state.data) applyWatchlist(state.data.items);
    applyWatchlist(Object.keys(state.saved).map(function (k) { return state.saved[k]; }));
  }

  // ---------- filtering
  function matches(it, q) {
    if (!q) return true;
    var hay = (it.title + ' ' + (it.summary || '') + ' ' + it.source + ' ' + (it.tags || []).join(' ') + ' ' + stocksOf(it).join(' ')).toLowerCase();
    return q.split(/\s+/).every(function (w) { return hay.indexOf(w) !== -1; });
  }

  function baseList() {
    if (state.view === 'saved') {
      return Object.keys(state.saved).map(function (k) { return state.saved[k]; })
        .sort(function (a, b) { return a.time < b.time ? 1 : -1; });
    }
    return state.data ? state.data.items : [];
  }

  function viewFilter(it) {
    if (state.view === 'important') return prio(it) >= 1;
    if (state.view === 'watchlist') return stocksOf(it).length > 0;
    return true;
  }

  function compute() {
    var q = state.q.trim().toLowerCase();
    var showRoutine = state.routine || state.view === 'saved';
    state.list = baseList().filter(function (it) {
      return (showRoutine || !it.routine) && viewFilter(it) &&
        (state.cat === 'all' || it.category === state.cat) && matches(it, q);
    });
  }

  function counts() {
    var c = {}, src = baseList(), showRoutine = state.routine || state.view === 'saved';
    src.forEach(function (it) {
      if ((!showRoutine && it.routine) || !viewFilter(it)) return;
      c[it.category] = (c[it.category] || 0) + 1;
      c.all = (c.all || 0) + 1;
    });
    return c;
  }

  // ---------- rendering
  function itemHtml(it, i) {
    var saved = !!state.saved[it.id];
    var tags = stocksOf(it).map(function (s) { return '<span class="tag watch">' + esc(s) + '</span>'; })
      .concat((it.tags || []).map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }));
    if (it.routine) tags.push('<span class="tag">Routine</span>');
    if (it.also && it.also.length) tags.push('<button type="button" class="tag also" data-also="' + i + '">+' + it.also.length + ' more source' + (it.also.length > 1 ? 's' : '') + '</button>');
    return '<article class="item' + (state.read.has(it.id) ? ' read' : '') + '" data-p="' + prio(it) + '" data-i="' + i + '" tabindex="-1">' +
      '<div class="meta"><span class="src">' + esc(it.source) + '</span><span aria-hidden="true">·</span>' +
      '<time datetime="' + esc(it.time) + '" title="' + esc(it.time ? new Date(it.time).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST' : '') + '">' + esc(ago(it.time)) + '</time></div>' +
      '<a class="title" href="' + esc(safeUrl(it.link)) + '" target="_blank" rel="noopener noreferrer" data-open="' + i + '">' + esc(it.title) + '</a>' +
      (it.summary ? '<p class="sum">' + esc(it.summary) + '</p>' : '') +
      '<div class="tags">' + tags.join('') + '</div>' +
      '<button type="button" class="icon-btn save" data-save="' + i + '" aria-pressed="' + saved + '" aria-label="' + (saved ? 'Remove from saved' : 'Save story') + '">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg></button>' +
      '</article>';
  }

  function emptyHtml() {
    if (!state.data) return '<div class="empty"><strong>No news yet</strong>The first update hasn\'t run. Check back in a few minutes.</div>';
    if (state.view === 'saved') return '<div class="empty"><strong>Save stories to read later</strong>Tap the bookmark on any story and it stays here, even after it leaves the feed.</div>';
    if (state.view === 'watchlist' && !state.wl.length && !(state.data.watchlist || []).length) return '<div class="empty"><strong>Add your stocks</strong>Search for a company above. Stories and filings that mention it collect here.</div>';
    if (state.view === 'watchlist' && !state.q) return '<div class="empty"><strong>No news on your stocks yet</strong>Stories show up here as soon as a source mentions one of them. To catch more, tap a stock to add other names it goes by.</div>';
    if (state.q) return '<div class="empty"><strong>Nothing matches "' + esc(state.q) + '"</strong>Try fewer words, or switch to All.</div>';
    return '<div class="empty"><strong>Nothing here right now</strong>Try another category or turn on routine filings.</div>';
  }

  function renderFeed() {
    compute();
    var list = state.list, n = Math.min(state.shown, list.length), out = [], dividerDone = false;
    var markDivider = state.prevVisit && state.view !== 'saved' && !state.q;
    for (var i = 0; i < n; i++) {
      var it = list[i];
      if (markDivider && !dividerDone && i > 0 && (it.first_seen || it.time) <= state.prevVisit) {
        out.push('<div class="divider">Seen before this</div>');
        dividerDone = true;
      }
      if (markDivider && i === 0 && (it.first_seen || it.time) <= state.prevVisit) dividerDone = true;
      out.push(itemHtml(it, i));
    }
    feedEl.innerHTML = n ? out.join('') : emptyHtml();
    updateUnread();
    $('#more').hidden = list.length <= n;
    $('#more').textContent = 'Show more (' + (list.length - n) + ' left)';
    state.focus = -1;
  }

  function renderNav() {
    var c = counts();
    $('#views').innerHTML = VIEWS.map(function (v) {
      var n = v.id === 'saved' ? Object.keys(state.saved).length : v.id === 'watchlist' ? state.wl.length : '';
      return '<li><a href="#" data-view="' + v.id + '"' + (state.view === v.id ? ' aria-current="page"' : '') + '>' + esc(v.label) + '<span class="count">' + n + '</span></a></li>';
    }).join('');
    $('#cats').innerHTML = CATS.map(function (k) {
      return '<li><a href="#" data-cat="' + k.id + '"' + (state.cat === k.id ? ' aria-current="page"' : '') + '>' + esc(k.label) + '<span class="count">' + (c[k.id] || 0) + '</span></a></li>';
    }).join('');
    $('#chips').innerHTML = CATS.map(function (k) {
      return '<button type="button" class="chip" role="tab" data-cat="' + k.id + '" aria-selected="' + (state.cat === k.id) + '">' + esc(k.label) + (c[k.id] ? ' ' + c[k.id] : '') + '</button>';
    }).join('');
    document.querySelectorAll('.bottomnav [data-view]').forEach(function (b) {
      if (b.dataset.view === state.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }

  function renderSide() {
    var d = state.data;
    if (!d) return;
    var snap = d.snapshot || [];
    function chg(s) { return s.change_pct == null ? '' : '<span class="' + (s.change_pct >= 0 ? 'up' : 'down') + '">' + (s.change_pct >= 0 ? '+' : '') + s.change_pct.toFixed(2) + '%</span>'; }
    var fii = (d.fii_dii || [])[0];
    var fiiChip = fii ? '<button type="button" class="fii-chip" data-fii-open title="FII / DII history">FII <b>' + crore(fii.fii && fii.fii.net) + '</b> · DII <b>' + crore(fii.dii && fii.dii.net) + '</b> <span class="muted">(' + esc(shortDate(fii.date)) + ')</span></button>' : '';
    $('#snapshot').innerHTML = fiiChip + snap.map(function (s) { return '<span>' + esc(s.label) + ' <b>' + fmtNum(s.price) + '</b> ' + chg(s) + '</span>'; }).join('');
    renderFii();
    $('#snapshot-rail').innerHTML = snap.map(function (s) {
      return '<div class="snap-row"><span class="lbl">' + esc(s.label) + '</span><span>' + fmtNum(s.price) + ' ' + chg(s) + '</span></div>';
    }).join('') || '<p class="muted tiny">Not available right now.</p>';
    var links = (d.links || []).map(function (l) { return '<a href="' + esc(safeUrl(l.url)) + '" target="_blank" rel="noopener noreferrer">' + esc(l.label) + '</a>'; }).join('');
    document.querySelectorAll('[data-links]').forEach(function (el) { el.innerHTML = links; });
    updatedLabel();
  }

  // ---------- FII / DII
  function crore(n) {
    if (n == null) return '–';
    var cls = n >= 0 ? 'up' : 'down';
    return '<span class="' + cls + '">' + (n >= 0 ? '+' : '−') + Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 }) + '</span>';
  }
  function shortDate(iso) {
    var p = (iso || '').split('-');
    return p.length === 3 ? istDay.format(new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 6))) : iso;
  }
  function sum(rows, key) {
    return rows.reduce(function (a, r) { return a + ((r[key] && r[key].net) || 0); }, 0);
  }

  function renderFii() {
    var rows = (state.data && state.data.fii_dii) || [];
    var rail = $('#fii-rail');
    if (!rows.length) {
      rail.innerHTML = '<p class="muted tiny">Not available yet.</p>';
      return;
    }
    var last = rows[0], five = rows.slice(0, 5), month = rows.filter(function (r) { return r.date.slice(0, 7) === last.date.slice(0, 7); });
    rail.innerHTML =
      '<div class="snap-row"><span class="lbl">' + esc(shortDate(last.date)) + ', ₹ cr</span><span></span></div>' +
      '<div class="snap-row"><span class="lbl">FII / FPI</span><span>' + crore(last.fii && last.fii.net) + '</span></div>' +
      '<div class="snap-row"><span class="lbl">DII</span><span>' + crore(last.dii && last.dii.net) + '</span></div>' +
      (rows.length > 1 ? '<div class="snap-row"><span class="lbl">FII, last ' + five.length + ' days</span><span>' + crore(sum(five, 'fii')) + '</span></div>' : '');

    $('#fii-totals').innerHTML =
      '<div>FII, last ' + five.length + ' day' + (five.length > 1 ? 's' : '') + '<b>' + crore(sum(five, 'fii')) + '</b></div>' +
      '<div>DII, last ' + five.length + ' day' + (five.length > 1 ? 's' : '') + '<b>' + crore(sum(five, 'dii')) + '</b></div>' +
      '<div>FII, ' + esc(shortDate(last.date).replace(/^\d+\s*/, '')) + ' so far<b>' + crore(sum(month, 'fii')) + '</b></div>' +
      '<div>DII, ' + esc(shortDate(last.date).replace(/^\d+\s*/, '')) + ' so far<b>' + crore(sum(month, 'dii')) + '</b></div>';
    $('#fii-body').innerHTML = rows.map(function (r) {
      return '<tr><td>' + esc(shortDate(r.date)) + '</td><td class="num">' + crore(r.fii && r.fii.net) + '</td><td class="num">' + crore(r.dii && r.dii.net) + '</td></tr>';
    }).join('');
    var first = rows[rows.length - 1].date;
    $('#fii-note').textContent = 'History starts ' + shortDate(first) + ', when the hub began recording it. NSE only publishes the latest day, so earlier days aren\'t available here. Month totals cover recorded days only.';
  }

  function updatedLabel() {
    if (!state.data) return;
    var t = state.data.generated_at, mins = (Date.now() - new Date(t)) / 60000;
    var el = $('#updated');
    el.textContent = 'Updated ' + (mins < 1 ? 'just now' : ago(t) + (mins < 360 ? ' ago' : ''));
    el.title = new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST';
  }

  function renderSources() {
    var d = state.data;
    if (!d) return;
    $('#sources-when').textContent = 'Checked ' + ago(d.generated_at) + '. Sources marked "may fail" often block automated readers.';
    $('#sources-body').innerHTML = (d.sources || []).map(function (s) {
      var status = s.ok ? '<span class="badge" data-variant="success">OK</span>' :
        (s.optional ? '<span class="badge outline">May fail: ' + esc(s.error || '') + '</span>' : '<span class="badge" data-variant="danger">' + esc(s.error || 'Failed') + '</span>');
      return '<tr><td>' + esc(s.name) + '</td><td>' + (s.count || 0) + '</td><td>' + status + '</td></tr>';
    }).join('');
  }

  // ---------- watchlist manager (Watchlist view)
  function shortName(name) {
    var n = name.replace(/\s+(limited|ltd\.?)$/i, '').replace(/^the\s+/i, '').trim();
    // NSE writes some names in capitals; show them in normal case.
    if (n === n.toUpperCase() && /[A-Z]{4,}/.test(n)) {
      n = n.toLowerCase().replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
    }
    return n;
  }

  function saveWatchlist() {
    store.set('watchlist', state.wl);
    refreshWatchlist();
    render();
  }

  function addStock(entry) {
    var exists = state.wl.some(function (s) { return (entry.symbol && s.symbol === entry.symbol) || s.name.toLowerCase() === entry.name.toLowerCase(); });
    if (exists) { if (window.ot) ot.toast(entry.name + ' is already on your watchlist.', '', { placement: 'bottom-center', duration: 2500 }); return; }
    state.wl.push(entry);
    saveWatchlist();
    var n = state.data ? state.data.items.filter(function (it) { return (it.wl || []).indexOf(entry.name) !== -1; }).length : 0;
    if (window.ot) ot.toast(n ? n + ' recent ' + (n === 1 ? 'story mentions' : 'stories mention') + ' it.' : 'No recent stories yet. New ones will show here.', entry.name + ' added', { placement: 'bottom-center', duration: 3000 });
  }

  function renderWatchPanel() {
    var panel = $('#wl-panel');
    panel.hidden = state.view !== 'watchlist';
    if (panel.hidden) return;
    var counts = {};
    if (state.data) state.data.items.forEach(function (it) { (it.wl || []).forEach(function (n) { counts[n] = (counts[n] || 0) + 1; }); });
    $('#wl-chips').innerHTML = state.wl.map(function (s, i) {
      return '<button type="button" class="wl-chip" data-wl-edit="' + i + '" title="Edit or remove">' + esc(s.name) +
        (s.symbol ? ' <span class="muted">' + esc(s.symbol) + '</span>' : '') +
        ' <span class="wl-count">' + (counts[s.name] || 0) + '</span></button>';
    }).join('');
    $('#wl-foot').hidden = !state.wl.length;
  }

  function loadCompanies() {
    if (state.companies) return Promise.resolve(state.companies);
    return fetch('data/stocks.json').then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; })
      .then(function (rows) { state.companies = rows; return rows; });
  }

  var sugg = [], suggIdx = 0;
  function suggest(q) {
    var box = $('#wl-suggest');
    q = q.trim();
    if (!q) { box.hidden = true; sugg = []; return; }
    var qu = q.toUpperCase(), ql = q.toLowerCase();
    var have = {};
    state.wl.forEach(function (s) { if (s.symbol) have[s.symbol] = 1; });
    var scored = [];
    (state.companies || []).forEach(function (c) {
      if (have[c[0]]) return;
      var nl = c[1].toLowerCase(), score = -1;
      if (c[0] === qu) score = 0;
      else if (c[0].indexOf(qu) === 0) score = 1;
      else if (nl.indexOf(ql) === 0) score = 2;
      else if (nl.indexOf(' ' + ql) !== -1) score = 3;
      else if (nl.indexOf(ql) !== -1) score = 4;
      if (score >= 0) scored.push([score, c]);
    });
    scored.sort(function (a, b) { return a[0] - b[0] || a[1][0].length - b[1][0].length; });
    sugg = scored.slice(0, 8).map(function (x) { return { symbol: x[1][0], name: shortName(x[1][1]), full: x[1][1] }; });
    if (q.length >= 2) sugg.push({ keyword: q });
    suggIdx = 0;
    box.innerHTML = sugg.map(function (s, i) {
      var label = s.keyword ? 'Follow the word "<b>' + esc(s.keyword) + '</b>"' : '<b>' + esc(s.name) + '</b> <span class="muted">' + esc(s.symbol) + '</span>';
      return '<li role="option" data-sugg="' + i + '"' + (i === 0 ? ' aria-selected="true"' : '') + '>' + label + '</li>';
    }).join('');
    box.hidden = !sugg.length;
  }

  function pickSuggestion(i) {
    var s = sugg[i];
    if (!s) return;
    if (s.keyword) addStock({ symbol: '', name: s.keyword, terms: [s.keyword] });
    else addStock({ symbol: s.symbol, name: s.name, terms: [s.name] });
    var input = $('#wl-input');
    input.value = '';
    suggest('');
  }

  var editing = -1;
  function openEdit(i) {
    var s = state.wl[i];
    if (!s) return;
    editing = i;
    $('#wl-dlg-title').textContent = s.name;
    $('#wl-terms').value = (s.terms || []).join(', ');
    $('#wl-dlg-symbol').textContent = s.symbol ? 'The NSE symbol ' + s.symbol + ' is also matched when written in capitals.' : '';
    $('#wl-dlg').showModal();
  }

  // Watchlist sharing: the list travels in the link itself (#wl=...), nothing is uploaded.
  function shareLink() {
    var data = state.wl.map(function (s) { return [s.symbol || '', s.name, s.terms || []]; });
    var code = btoa(unescape(encodeURIComponent(JSON.stringify(data))));
    return location.origin + location.pathname + '#wl=' + encodeURIComponent(code);
  }
  function importFromHash() {
    var m = location.hash.match(/^#wl=(.+)$/);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    var rows;
    try { rows = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(m[1]))))); } catch (e) { return; }
    if (!Array.isArray(rows) || !rows.length) return;
    var added = 0;
    rows.forEach(function (r) {
      if (!Array.isArray(r) || typeof r[1] !== 'string') return;
      var entry = { symbol: String(r[0] || '').slice(0, 20), name: r[1].slice(0, 80), terms: (Array.isArray(r[2]) ? r[2] : []).map(String).slice(0, 10) };
      var dup = state.wl.some(function (s) { return (entry.symbol && s.symbol === entry.symbol) || s.name.toLowerCase() === entry.name.toLowerCase(); });
      if (!dup) { state.wl.push(entry); added++; }
    });
    store.set('watchlist', state.wl);
    refreshWatchlist();
    state.view = 'watchlist';
    setTimeout(function () {
      if (window.ot) ot.toast(added ? added + ' stock' + (added === 1 ? '' : 's') + ' added from the link.' : 'Everything in that link is already on this device.', 'Watchlist', { placement: 'bottom-center' });
    }, 600);
  }

  function render() { renderNav(); renderWatchPanel(); renderFeed(); }

  // ---------- data
  var loading = false;
  function load(userAsked) {
    if (loading) return;
    loading = true;
    $('#refresh').classList.add('spin');
    var prevGen = state.data && state.data.generated_at;
    var prevIds = state.data ? new Set(state.data.items.map(function (i) { return i.id; })) : null;
    fetch(DATA_URL + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        state.data = d;
        applyWatchlist(d.items);
        renderSide();
        renderSources();
        if (prevIds && d.generated_at !== prevGen) {
          var fresh = d.items.filter(function (i) { return !prevIds.has(i.id) && !i.routine; }).length;
          if (fresh && window.ot) ot.toast(fresh + ' new ' + (fresh === 1 ? 'story' : 'stories') + ' added to the top.', 'Feed updated', { placement: 'bottom-center' });
          else if (userAsked && window.ot) ot.toast('No new stories since the last update.', '', { placement: 'bottom-center' });
        } else if (userAsked && window.ot) {
          ot.toast('Already up to date. The hub refreshes every 15 min in market hours.', '', { placement: 'bottom-center' });
        }
        render();
      })
      .catch(function () {
        if (!state.data) feedEl.innerHTML = '<div class="empty"><strong>Couldn\'t load the news</strong>You might be offline. Pull down or press refresh to try again.</div>';
        else if (window.ot) ot.toast('Couldn\'t reach the server. Showing the last loaded news.', '', { variant: 'warning', placement: 'bottom-center' });
      })
      .then(function () { loading = false; $('#refresh').classList.remove('spin'); });
  }

  // ---------- actions
  function setView(v) { state.view = v; state.cat = 'all'; state.shown = PAGE; render(); scrollTop(); closeSidebar(); }
  function setCat(c) { state.cat = c; state.shown = PAGE; render(); scrollTop(); closeSidebar(); }
  function scrollTop() { var m = document.querySelector('main'); if (m) m.scrollTop = 0; }
  function closeSidebar() { document.body.removeAttribute('data-sidebar-open'); }

  function toggleSave(i) {
    var it = state.list[i];
    if (!it) return;
    if (state.saved[it.id]) delete state.saved[it.id];
    else state.saved[it.id] = it;
    store.set('saved', state.saved);
    if (state.view === 'saved') render();
    else {
      var btn = feedEl.querySelector('[data-save="' + i + '"]');
      var on = !!state.saved[it.id];
      btn.setAttribute('aria-pressed', on);
      btn.setAttribute('aria-label', on ? 'Remove from saved' : 'Save story');
      renderNav();
    }
  }

  function saveRead() { store.set('read', Array.from(state.read).slice(-3000)); }

  function markRead(i) {
    var it = state.list[i];
    if (!it) return;
    state.read.add(it.id);
    saveRead();
    var el = feedEl.querySelector('[data-i="' + i + '"]');
    if (el) el.classList.add('read');
    updateUnread();
  }

  function updateUnread() {
    var n = state.list.filter(function (it) { return !state.read.has(it.id); }).length;
    var btn = $('#readall');
    $('#unread').innerHTML = !state.list.length ? '' : n ? '<b>' + n.toLocaleString('en-IN') + '</b> unread' : 'All caught up';
    btn.hidden = n === 0 || state.view === 'saved';
  }

  // Marks everything in the current view (category, search and filters applied) as read.
  function markAllRead() {
    var n = 0;
    state.list.forEach(function (it) { if (!state.read.has(it.id)) { state.read.add(it.id); n++; } });
    saveRead();
    if (state.data && state.view === 'all' && state.cat === 'all' && !state.q) {
      state.prevVisit = state.data.generated_at;   // the "Seen before this" line moves to the top
      store.set('lastVisit', state.prevVisit);
    }
    renderFeed();
    if (n && window.ot) ot.toast('Marked ' + n.toLocaleString('en-IN') + ' ' + (n === 1 ? 'story' : 'stories') + ' as read.', '', { placement: 'bottom-center', duration: 2500 });
  }

  function showAlso(i, btn) {
    var it = state.list[i];
    if (!it || !it.also) return;
    var box = document.createElement('div');
    box.className = 'also-list';
    box.innerHTML = it.also.map(function (a) { return '<a href="' + esc(safeUrl(a.link)) + '" target="_blank" rel="noopener noreferrer">' + esc(a.source) + '</a>'; }).join('');
    btn.closest('.item').appendChild(box);
    btn.remove();
  }

  function moveFocus(d) {
    var items = feedEl.querySelectorAll('.item');
    if (!items.length) return;
    var cur = feedEl.querySelector('.item.focus');
    var idx = cur ? Array.prototype.indexOf.call(items, cur) : -1;
    idx = Math.max(0, Math.min(items.length - 1, idx + d));
    if (cur) cur.classList.remove('focus');
    items[idx].classList.add('focus');
    items[idx].scrollIntoView({ block: 'nearest' });
    state.focus = +items[idx].dataset.i;
  }

  // ---------- events
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-fii-open]')) { e.preventDefault(); renderFii(); $('#fii-dlg').showModal(); return; }
    var t = e.target.closest('[data-view],[data-cat],[data-save],[data-open],[data-also]');
    if (!t) return;
    if (t.dataset.view) { e.preventDefault(); setView(t.dataset.view); }
    else if (t.dataset.cat) { e.preventDefault(); setCat(t.dataset.cat); }
    else if (t.dataset.save) toggleSave(+t.dataset.save);
    else if (t.dataset.also) showAlso(+t.dataset.also, t);
    else if (t.dataset.open) markRead(+t.dataset.open);
  });

  $('#more').addEventListener('click', function () { state.shown += PAGE; renderFeed(); });
  $('#readall').addEventListener('click', markAllRead);

  // watchlist events
  var wlInput = $('#wl-input');
  wlInput.addEventListener('focus', function () { loadCompanies().then(function () { suggest(wlInput.value); }); });
  wlInput.addEventListener('input', function () { loadCompanies().then(function () { suggest(wlInput.value); }); });
  wlInput.addEventListener('keydown', function (e) {
    var items = $('#wl-suggest').querySelectorAll('li');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      suggIdx = (suggIdx + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      items.forEach(function (li, i) { li.setAttribute('aria-selected', i === suggIdx); });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pickSuggestion(suggIdx);
    } else if (e.key === 'Escape') {
      wlInput.value = ''; suggest('');
    }
  });
  wlInput.addEventListener('blur', function () { setTimeout(function () { $('#wl-suggest').hidden = true; }, 200); });
  $('#wl-suggest').addEventListener('mousedown', function (e) {
    var li = e.target.closest('[data-sugg]');
    if (li) { e.preventDefault(); pickSuggestion(+li.dataset.sugg); }
  });
  $('#wl-chips').addEventListener('click', function (e) {
    var b = e.target.closest('[data-wl-edit]');
    if (b) openEdit(+b.dataset.wlEdit);
  });
  $('#wl-save').addEventListener('click', function () {
    var s = state.wl[editing];
    if (!s) return;
    var terms = $('#wl-terms').value.split(',').map(function (t) { return t.trim(); }).filter(Boolean);
    s.terms = terms.length ? terms : [s.name];
    saveWatchlist();
  });
  // Enter in the words box means Save (the form's first button is Remove).
  $('#wl-terms').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); $('#wl-save').click(); }
  });
  $('#wl-remove').addEventListener('click', function () {
    var s = state.wl[editing];
    if (!s) return;
    state.wl.splice(editing, 1);
    saveWatchlist();
    if (window.ot) ot.toast(s.name + ' removed from your watchlist.', '', { placement: 'bottom-center', duration: 2500 });
  });
  $('#wl-share').addEventListener('click', function (e) {
    e.preventDefault();
    var link = shareLink();
    var done = function () { if (window.ot) ot.toast('Open it on your other device to add these stocks there.', 'Link copied', { placement: 'bottom-center' }); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, function () { window.prompt('Copy this link:', link); });
    else window.prompt('Copy this link:', link);
  });

  var qTimer;
  $('#q').addEventListener('input', function (e) {
    clearTimeout(qTimer);
    qTimer = setTimeout(function () { state.q = e.target.value; state.shown = PAGE; render(); }, 150);
  });
  $('#q').addEventListener('focus', function () { document.body.classList.add('search-open'); });
  $('#q').addEventListener('blur', function () { document.body.classList.remove('search-open'); });

  var routineEl = $('#routine');
  routineEl.checked = state.routine;
  routineEl.addEventListener('change', function () { state.routine = routineEl.checked; store.set('routine', state.routine); state.shown = PAGE; render(); });

  $('#refresh').addEventListener('click', function () { load(true); });

  $('#theme').addEventListener('click', function () {
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    document.documentElement.style.colorScheme = next;
    try { localStorage.setItem('mh.theme', next); } catch (e) {}
  });

  $('#sources-open').addEventListener('click', function (e) { e.preventDefault(); renderSources(); $('#sources-dlg').showModal(); });

  document.addEventListener('keydown', function (e) {
    if (e.target.matches('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) {
      if (e.key === 'Escape' && e.target.id === 'q') { e.target.value = ''; state.q = ''; e.target.blur(); render(); }
      return;
    }
    if (e.key === 'j') moveFocus(1);
    else if (e.key === 'k') moveFocus(-1);
    else if ((e.key === 'o' || e.key === 'Enter') && state.focus >= 0) {
      var a = feedEl.querySelector('[data-open="' + state.focus + '"]');
      if (a) { markRead(state.focus); window.open(a.href, '_blank', 'noopener'); }
    } else if (e.key === 's' && state.focus >= 0) toggleSave(state.focus);
    else if (e.key === '/') { e.preventDefault(); $('#q').focus(); }
    else return;
  });

  // Remember this visit for the "Seen before this" divider (saved when leaving the page).
  function saveVisit() { if (state.data) store.set('lastVisit', state.data.generated_at); }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') saveVisit();
    else { state.prevVisit = store.get('lastVisit', state.prevVisit); load(false); }
  });
  window.addEventListener('pagehide', saveVisit);

  setInterval(function () { if (document.visibilityState === 'visible') load(false); }, POLL_MS);
  setInterval(function () { updatedLabel(); }, 60000);

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    // When an updated service worker takes over, reload once so the new version shows.
    var hadController = !!navigator.serviceWorker.controller, reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(function () {});
  }

  compileWatchlist();
  importFromHash();
  window.addEventListener('hashchange', function () {
    if (/^#wl=/.test(location.hash)) { importFromHash(); state.cat = 'all'; render(); }
  });
  renderNav();
  renderWatchPanel();
  load(false);
})();
