// Token Radar dashboard. Reads window.RADAR (written beside dashboard/ by
// main.ts) and renders the ranked board, filters, a per-protocol detail
// view, and the model that scored every row. No network: every byte shown
// comes from data.js, and the farm plans below are the board's own steps,
// shown verbatim, never reworded in the page.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('app');
  var state = { q: '', category: 'all', chain: 'all', watchlist: false, tab: 'pre', sort: 'implied', dir: -1, selected: null };
  var MAX_IMPLIED = DATA.rows.reduce(function (m, r) { return Math.max(m, r.implied_value_usd); }, 1);

  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(n) { return 'x' + n.toFixed(2); }
  function catKey(r) { return r.category || 'Uncategorised'; }
  function chainLabel(r) {
    if (!r.chains || r.chains.length === 0) return 'an unnamed chain';
    if (r.chains.length <= 2) return r.chains.join(', ');
    return r.chains.slice(0, 2).join(', ') + ' +' + (r.chains.length - 2) + ' more';
  }

  // The model, recomputed in the page from the snapshot figures: growth,
  // maturity, and chain breadth are derived here from the raw fields, and
  // combined with the row's stated category multiple. The detail view
  // compares this number with the one board.json carries.
  function impliedOf(row, model) {
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, row.change_7d === null ? 0 : row.change_7d));
    var growthMult = 1 + (growth / 100) * model.growth_weight;
    var age = row.age_days === null ? model.unknown_age_days : row.age_days;
    var maturity = model.maturity_floor + (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    var chainMult = 1 + model.chain_step * Math.min(Math.max((row.chains || []).length - 1, 0), model.chain_cap);
    return Math.max(1, Math.round(row.tvl_usd * row.model.category_multiple * growthMult * maturity * chainMult));
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function readHash() {
    var params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    if (params.get('q')) state.q = params.get('q');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('watchlist') === '1') state.watchlist = true;
    if (params.get('tab') === 'live') state.tab = 'live';
    if (params.get('p')) state.selected = params.get('p');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.watchlist) params.set('watchlist', '1');
    if (state.tab === 'live') params.set('tab', 'live');
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.watchlist && !r.on_watchlist) return false;
      if (state.category !== 'all' && catKey(r) !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (state.sort === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (state.sort === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (state.sort === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (state.sort === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (state.sort === 'multiple') { av = a.model.category_multiple; bv = b.model.category_multiple; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' },
        el('span', { class: 'rings', 'aria-hidden': 'true' }),
        el('div', null, el('b', { text: 'Token Radar' }), el('span', { text: 'Pre-token launch radar' }))
      ),
      el('div', { class: 'top-meta' },
        el('span', null, 'Snapshot ', el('b', { text: DATA.as_of })),
        el('span', null, 'Model ', el('b', { text: DATA.model_version })),
        el('span', null, 'Floor ', el('b', { text: fmtUsd(DATA.floor_usd) }))
      )
    );
  }

  function hero() {
    return el('section', { class: 'hero' },
      el('h1', { text: 'Which protocol without a token is worth farming next?' }),
      el('p', null,
        'Every protocol on the watchlist — ', el('b', { text: DATA.watchlist_size + ' with at least ' + fmtUsd(DATA.floor_usd) + ' of TVL and no token on record' }),
        ' — ranked by implied launch value, plus ', el('b', { text: DATA.early_size + ' early finds' }),
        ' below the floor. Implied value is this radar\u2019s model, never a promise, and a protocol here records no token: the record is not proof it has none.'
      )
    );
  }

  function stats() {
    function stat(label, value, note) {
      return el('div', { class: 'stat' }, el('span', { text: label }), el('b', { text: value }), el('small', { text: note }));
    }
    return el('section', { class: 'stats', 'aria-label': 'Board summary' },
      stat('Watchlist covered', DATA.watchlist_size + ' / ' + DATA.watchlist_size, 'every watchlist slug ranked'),
      stat('Board rows', String(DATA.board_size), DATA.early_size + ' early, below the floor'),
      stat('Total implied value', fmtUsd(DATA.total_implied_usd), 'sum of the board\u2019s model'),
      stat('Global multiple', fmtMult(DATA.global_multiple), 'median live mcap / TVL'),
      stat('Live tokens set aside', String(DATA.live_size), 'shown apart, never ranked')
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(catKey))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var catSel = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    catSel.addEventListener('change', function () { state.category = catSel.value; writeHash(); render(); });
    var chainSel = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); })
    );
    chainSel.addEventListener('change', function () { state.chain = chainSel.value; writeHash(); render(); });
    var watchBox = el('input', { type: 'checkbox', id: 'watchlist', checked: state.watchlist ? 'checked' : null });
    watchBox.addEventListener('change', function () { state.watchlist = watchBox.checked; writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre'; writeHash(); render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; writeHash(); render(); } });
    var countText = state.tab === 'pre' ? filteredRows().length + ' of ' + DATA.board_size + ' rows shown' : DATA.live.length + ' live-token protocols';
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), catSel),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSel),
      el('label', { class: 'check', for: 'watchlist' }, watchBox, 'Watchlist only'),
      el('div', { class: 'field' }, el('span', { class: 'muted', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: countText })
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' \u2193' : ' \u2191' }) : null
      )
    );
  }

  function boardTable() {
    var list = sortedRows(filteredRows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or widen the filters to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.watchlist = false; writeHash(); render(); } })
      ));
    }
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num rank', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { text: catKey(r) + ' · ' + chainLabel(r) }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: String((r.chains || []).length) }),
        el('td', { class: 'num', text: fmtMult(r.model.category_multiple) }),
        el('td', { class: 'bar-cell' }, el('div', { class: 'bar-row' },
          el('span', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(2, Math.round((r.implied_value_usd / MAX_IMPLIED) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'badge ' + (r.on_watchlist ? 'watch' : 'early'), text: r.on_watchlist ? 'Watchlist' : 'Early' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel', id: 'board' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { text: 'Pre-token protocols, strongest implied value first. Select a row for its model breakdown and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            el('th', { scope: 'col', text: 'Chains' }),
            sortHeader('multiple', 'Multiple'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Set' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { text: catKey(r) + ' · ' + chainLabel(r) }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: r.mcap_tvl === null ? 'n/a' : fmtMult(r.mcap_tvl) }),
        el('td', null, el('span', { class: 'badge live', text: 'Already trades' }))
      ));
    });
    return el('div', { class: 'panel', id: 'board' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { text: 'Live tokens, by market cap: the market\u2019s own value, not a model. Kept apart from the pre-token ranking; their ratios calibrate it.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Mcap / TVL' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function modelPanel() {
    var m = DATA.model;
    return el('section', { class: 'panel' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { text: 'One function scores every row from the snapshot\u2019s own figures. No protocol name is special-cased, and no row is hand-picked.' }),
      el('div', { class: 'formula', text: 'implied = round( tvl_usd \u00d7 category multiple \u00d7 (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 \u00d7 ' + m.growth_weight + ') \u00d7 (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' \u00d7 ' + m.maturity_range + ') \u00d7 (1 + ' + m.chain_step + ' \u00d7 min(chains \u2212 1, ' + m.chain_cap + ')) )' }),
      el('ul', null,
        el('li', null, el('b', { text: 'Category multiple. ' }), 'Median market-cap-to-TVL of the live-token protocols in the same category, in this snapshot, shrunk toward the global median (' + fmtMult(DATA.global_multiple) + ') when a category has few live examples, clamped to ' + m.multiple_floor + '\u2013' + m.multiple_cap + '.'),
        el('li', null, el('b', { text: 'Growth. ' }), 'Seven-day TVL change, clamped, so a hot week lifts a row without letting one spike set the board.'),
        el('li', null, el('b', { text: 'Maturity. ' }), 'Time since first listing: the longer a protocol has run with no token on record, the closer to full weight, capped at four years. Unknown age uses ' + m.unknown_age_days + ' days.'),
        el('li', null, el('b', { text: 'Breadth. ' }), 'A small lift per extra chain, capped: distribution across chains is worth something, not everything.'),
        el('li', null, el('b', { text: 'Separation. ' }), 'Wrapped, staked, bridged, and exchange products and versioned pools are left out of the ranking, and live tokens are shown apart with market caps.')
      )
    );
  }

  function calibrationPanel() {
    var tbody = el('tbody');
    DATA.calibration.forEach(function (c) {
      tbody.appendChild(el('tr', null,
        el('td', { text: c.category }),
        el('td', { class: 'num', text: String(c.live_count) }),
        el('td', { class: 'num', text: c.median_ratio === null ? 'n/a' : fmtMult(c.median_ratio) }),
        el('td', { class: 'num', text: fmtMult(c.multiple) })
      ));
    });
    return el('section', { class: 'panel' },
      el('h2', { text: 'Calibration: live ratios by category' }),
      el('p', { text: 'Each multiple comes from the live-token protocols in the same snapshot. Small categories borrow strength from the global median.' }),
      el('div', { class: 'cal-wrap' },
        el('table', null,
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Category' }), el('th', { scope: 'col', text: 'Live n' }), el('th', { scope: 'col', text: 'Median ratio' }), el('th', { scope: 'col', text: 'Multiple' }))),
          tbody
        )
      )
    );
  }

  function footer() {
    return el('footer', null,
      el('p', { text: 'Method: the board is computed from one sealed snapshot (' + DATA.source + '). The snapshot carries no ranking, no value, and no farm plan; deriving them is this radar\u2019s work. Figures are the snapshot\u2019s as of ' + DATA.as_of + '.' }),
      el('p', { text: 'Language that matters: every ranked protocol records no token in the snapshot. That is DefiLlama\u2019s record, not proof it has none, and nothing here predicts whether or when a token is issued. Implied value is a model for comparing protocols, not a price, and farming carries smart-contract and market risk: size positions you can afford to lose.' }),
      el('p', { text: 'This page renders fully offline. No request leaves the browser; the data sits beside the page.' })
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function openDetail(slug) {
    var row = null;
    DATA.rows.forEach(function (r) { if (r.slug === slug) row = r; });
    if (!row) return;
    state.selected = slug;
    writeHash();
    var recomputed = impliedOf(row, DATA.model);
    var matches = recomputed === row.implied_value_usd;
    dialog.textContent = '';
    var inner = el('div', { class: 'detail-inner' },
      el('div', { class: 'detail-head' },
        el('div', null,
          el('span', { class: 'kick', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + (row.on_watchlist ? ' · Watchlist' : ' · Early find') }),
          el('h2', { id: 'detail-title', text: row.name }),
          el('p', { text: catKey(row) + ' · ' + ((row.chains || []).join(', ') || 'an unnamed chain') + ' · first listed ' + (row.listed_at || 'unknown') })
        ),
        el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
      ),
      el('section', { class: 'detail-section' },
        el('h3', { text: 'Implied value, broken down' }),
        el('div', { class: 'grid' },
          el('div', null, el('span', { text: 'TVL' }), el('b', { text: fmtUsd(row.tvl_usd) })),
          el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { text: fmtPct(row.change_7d) })),
          el('div', null, el('span', { text: 'Age with no token' }), el('b', { text: fmtAge(row.age_days) })),
          el('div', null, el('span', { text: 'Chains' }), el('b', { text: String((row.chains || []).length) })),
          el('div', null, el('span', { text: 'Category multiple' }), el('b', { text: fmtMult(row.model.category_multiple) })),
          el('div', null, el('span', { text: 'Growth multiplier' }), el('b', { text: String(row.model.growth_multiplier) })),
          el('div', null, el('span', { text: 'Maturity multiplier' }), el('b', { text: String(row.model.maturity_multiplier) })),
          el('div', null, el('span', { text: 'Chain multiplier' }), el('b', { text: String(row.model.chain_multiplier) })),
          el('div', null, el('span', { text: 'Implied value' }), el('b', { text: fmtUsd(row.implied_value_usd) }))
        ),
        el('p', { class: 'check-line' }, 'This page recomputes the row as ', el('b', { text: fmtUsd(recomputed) }), matches ? ', the same number board.json carries.' : ' — it differs from the board, so the data would be stale.')
      ),
      el('section', { class: 'detail-section' },
        el('h3', { text: 'Farm plan' }),
        el('ol', { class: 'steps' }, row.farm_steps.map(function (s) {
          var at = s.indexOf(' Cost: ');
          var action = at >= 0 ? s.slice(0, at) : s;
          var tail = at >= 0 ? s.slice(at + 1) : '';
          return el('li', null, el('b', { text: action }), el('span', { text: tail }));
        }))
      ),
      el('section', { class: 'detail-section' },
        el('p', { class: 'muted', text: 'Records no token in the snapshot (no market cap, no CoinGecko id, no symbol). This is an estimate for comparing protocols, not a prediction that a token issues.' })
      )
    );
    dialog.appendChild(inner);
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(hero());
    shell.appendChild(stats());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre' ? boardTable() : liveTable());
    var duo = el('div', { class: 'duo' });
    duo.appendChild(modelPanel());
    duo.appendChild(calibrationPanel());
    shell.appendChild(duo);
    shell.appendChild(footer());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
