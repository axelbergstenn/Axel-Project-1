// Fondinsyn – klientlogik.
// Data byggs av scripts/build-data.ps1:
//   data/index.json            kvartal som finns
//   data/<kvartal>.json        svenska aktier + nyckeltal för alla fonder
//   data/<kvartal>-world.json  utländska aktier
//   data/history-se.json       ägande och nettoköp per svensk aktie sedan 2018
//   data/history-world.json    samma för utländska aktier
(function () {
  "use strict";

  var INDEX_RE = /index|indx|\bomx|passiv|tracker|\betf\b|\bzero\b|\baccess\b|aktiespararna topp/i;

  // Gränser för "indexnära men dyr": aktiv risk under 3 % och avgift på minst 0,7 %
  var CLOSET_AR = 3;
  var CLOSET_FEE = 0.7;

  // Kända aktiva fonder (FI:s institutnummer) som visas under Förvaltare
  var FEATURED = ["51313", "60319", "51272", "51718", "60730", "51545", "51670", "60908", "51540", "51791", "51381",
    "60503", "60012", "60214", "51760", "51669", "60194", "51318", "51544"];

  var CONTACT = ["axelsfondfloden", "gmail.com"].join("@");

  // Versionen sätts vid publicering. Om webbläsaren har en äldre sparad kopia av sajten
  // laddas sidan om en gång med den nya versionen i adressen, så att allt hämtas på nytt.
  var APP_VERSION = "__VERSION__";
  (function checkVersion() {
    if (APP_VERSION.indexOf("__") === 0) return; // lokal utveckling
    fetch("version.txt?t=" + Date.now(), { cache: "no-store" }).then(function (r) { return r.ok ? r.text() : ""; }).then(function (v) {
      v = (v || "").trim();
      if (!v || v === APP_VERSION) return;
      var key = "ff-reloaded-" + v;
      try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, "1"); } catch (e) { /* ingen lagring */ }
      location.replace(location.pathname + "?v=" + encodeURIComponent(v) + location.hash);
    }).catch(function () {});
  })();

  // Användarnamn hos Buttondown för nyhetsbrevet. Tomt = prenumerationsformuläret visas inte.
  var NEWSLETTER = "";

  var nf0 = new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 0 });
  var nf1 = new Intl.NumberFormat("sv-SE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var nf2 = new Intl.NumberFormat("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var regionNames = null;
  try { regionNames = new Intl.DisplayNames(["sv"], { type: "region" }); } catch (e) { /* äldre webbläsare */ }

  var app = document.getElementById("app");
  var state = {
    index: null,
    q: null,
    market: "se",           // "se" eller "world"
    excludeIndex: false,
    data: {},               // kvartal -> { se, world, fi }
    history: null,
    loading: {},
    sorts: {},
    showAll: {},
    tables: {},
    charts: []
  };

  // ---------- Formatering ----------

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  // Bricka med initialer i en färg som räknas fram ur namnet, så att samma bolag alltid får samma färg
  var AVATAR_SKIP = /^(ab|publ|ser|series|class|inc|ltd|plc|corp|co|the|sa|asa|oyj|nv|sdb|[a-d])$/i;
  function avatar(name, small) {
    name = String(name || "");
    var words = name.replace(/[()&,.\-]/g, " ").split(/\s+/).filter(function (w) { return w && !AVATAR_SKIP.test(w); });
    var ini = words.length > 1 ? words[0].charAt(0) + words[1].charAt(0) : (words[0] || name || "?").slice(0, 2);
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return '<span class="avatar' + (small ? " avatar-sm" : "") + '" style="--h:' + h + '" aria-hidden="true">' + esc(ini.toUpperCase()) + "</span>";
  }
  function fixMinus(s) { return s.replace(/^-/, "−"); }
  function signed(s, v) { return v > 0 ? "+" + s : fixMinus(s); }
  function mkr(v, withSign) {
    if (v == null || !isFinite(v)) return "–";
    var m = v / 1e6;
    if (Math.abs(m) < 0.05) return nf1.format(0); // "0,0" i stället för "+0,0" eller "−0,0"
    var s = Math.abs(m) >= 100 ? nf0.format(m) : nf1.format(m);
    return withSign ? signed(s, m) : fixMinus(s);
  }
  function bigSek(v, withSign) {
    if (v == null || !isFinite(v)) return "–";
    if (v === 0) return "0 kr";
    var a = Math.abs(v);
    // Små belopp med en decimal, och under 0,05 mkr som "under 0,1 mkr" i stället för "0 mkr"
    if (a > 0 && a < 5e4) return "<" + nf1.format(0.1) + " mkr";
    var s = a >= 1e9 ? nf1.format(v / 1e9) + " mdkr" : (a >= 1e8 ? nf0 : nf1).format(v / 1e6) + " mkr";
    return withSign ? signed(s, v) : fixMinus(s);
  }
  function msek(m, withSign) { return m == null ? "–" : mkr(m * 1e6, withSign); }
  function pct(v, decimals) {
    if (v == null || !isFinite(v)) return "–";
    // Andelar som avrundas till noll visas utan tecken ("0 %" i stället för "+0 %")
    if (Math.abs(v * 100) < (decimals ? 0.05 : 0.5)) return (decimals ? nf1 : nf0).format(0) + " %";
    var s = (decimals ? nf1 : nf0).format(v * 100) + " %";
    return signed(s, v);
  }
  function pctPlain(v, digits) { return v == null ? "–" : (digits === 2 ? nf2 : nf1).format(v) + " %"; }
  function int(v) { return nf0.format(v || 0); }
  function nFunds(n) { return int(n) + (n === 1 ? " fond" : " fonder"); }
  function cls(v) { return v > 0 ? "pos" : v < 0 ? "neg" : ""; }
  function quarterLabel(id) { return id ? "Q" + id.slice(5) + " " + id.slice(0, 4) : ""; }
  var MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
  function dateText(iso) {
    var p = String(iso || "").split("-");
    return p.length === 3 ? parseInt(p[2], 10) + " " + MONTHS[parseInt(p[1], 10) - 1] + " " + p[0] : String(iso || "");
  }
  function countryName(code) {
    if (!code) return "";
    try { return regionNames ? regionNames.of(code) : code; } catch (e) { return code; }
  }
  // "VOLVO AB SER. B" blir "Volvo AB SER. B" och "ACRINOVA AB-B" blir "Acrinova AB-B". Korta ord (AB, ASA, SDB) behålls.
  function prettyName(name) {
    if (!name) return "";
    if (name === name.toUpperCase()) {
      name = name.split(/(\s+|-)/).map(function (w) {
        return w.length > 3 && /^[A-ZÅÄÖÉÜ]/.test(w) ? w.charAt(0) + w.slice(1).toLowerCase() : w;
      }).join("");
    }
    // Tekniska tillägg från depåsystemen ("Ord Shs", "/new") tas bort
    name = name.replace(/\s*\/(new|the)\s*$/i, "").replace(/\s+(ord(inary)?\.?\s+sh(ar)?e?s?|ord\.?|reg(istered)?\.?\s+shs?)\s*$/i, "");
    return name.replace(/\b(INC|LTD|CORP)\b/g, function (w) { return w.charAt(0) + w.slice(1).toLowerCase(); });
  }
  function store(key, value) {
    try {
      if (value === undefined) return JSON.parse(localStorage.getItem(key));
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { return null; }
  }
  function stockHref(s) { return "#/aktie/" + s.isin; }
  function fundHref(f) { return "#/fond/" + encodeURIComponent(f.id); }
  function feeText(f) {
    if (f.feeMax == null) return "–";
    return f.feeMin != null && f.feeMin < f.feeMax ? nf2.format(f.feeMin) + "–" + nf2.format(f.feeMax) + " %" : nf2.format(f.feeMax) + " %";
  }

  // ---------- Data ----------

  // Filer som sidhuvudet redan har börjat hämta (window.__pre, se index.html) används en gång
  function getJSON(url) {
    var pre = window.__pre && window.__pre[url];
    if (pre) delete window.__pre[url];
    return (pre || fetch(url, { cache: "no-cache" })).then(function (r) {
      if (!r.ok) throw new Error(url + ": " + r.status);
      return r.json();
    });
  }

  // Laddar något en gång och ritar om sidan när det är klart
  function need(key, loader) {
    if (state.loading[key] === "done") return true;
    if (!state.loading[key]) {
      state.loading[key] = "pending";
      loader().then(function () { state.loading[key] = "done"; render(); }, function (err) {
        console.error(err);
        state.loading[key] = "error";
        render();
      });
    }
    return false;
  }
  function failed(key) { return state.loading[key] === "error"; }

  function quarterData() { return state.data[state.q]; }

  function loadSe(q) {
    return getJSON("data/" + q + ".json").then(function (raw) {
      var d = state.data[q] = state.data[q] || {};
      d.fi = {};
      (raw.fundInfo || []).forEach(function (x) {
        d.fi[x[0]] = { id: x[0], name: x[1], co: x[2], bench: x[3], aum: x[4], feeMin: x[5], feeMax: x[6], perf: !!x[7],
          ar: x[8], sd: x[9], eq: x[10], nStocks: x[11], isIndex: INDEX_RE.test(x[1]) };
      });
      d.meta = raw.meta;
      d.se = prepare(raw);
    });
  }
  function needWorld() {
    var q = state.q;
    return need("world-" + q, function () {
      return getJSON("data/" + q + "-world.json").then(function (raw) { state.data[q].world = prepare(raw); });
    });
  }
  // Historiken ligger i två filer (svenska och utländska aktier). Den del som behövs laddas
  // och slås ihop med det som redan finns i state.history.
  function histPart(isin) { return isin && isin.slice(0, 2) !== "SE" ? "world" : "se"; }
  function needHistory(part) {
    part = part || (state.market === "world" ? "world" : "se");
    return need("history-" + part, function () {
      return getJSON("data/history-" + part + ".json").then(function (h) {
        if (!state.history) {
          h.qIndex = {};
          h.quarters.forEach(function (q, i) { h.qIndex[q] = i; });
          state.history = h;
        } else {
          Object.keys(h.stocks).forEach(function (k) { state.history.stocks[k] = h.stocks[k]; });
        }
      });
    });
  }

  // ---------- Små filer för senaste kvartalet ----------
  // scripts/build-pages.ps1 delar upp de stora filerna så att en aktie- eller fondsida bara hämtar det den
  // behöver. Saknas en fil (till exempel lokalt, eller för äldre kvartal) används de stora filerna som förut.

  function latestQ() { return state.index && state.index.quarters[0].id; }

  // Historik för en svensk aktie (data/hist/<isin>.json) i stället för hela history-se.json
  function needStockHistory(isin) {
    var part = histPart(isin);
    if (part !== "se" || state.loading["history-se"] === "done" || failed("h-" + isin)) return needHistory(part);
    return need("h-" + isin, function () {
      return getJSON("data/hist/" + isin + ".json").then(function (x) {
        if (!state.history) {
          var h = { quarters: x.quarters, stocks: {}, qIndex: {} };
          x.quarters.forEach(function (q, i) { h.qIndex[q] = i; });
          state.history = h;
        }
        state.history.stocks[isin] = x.s;
      });
    });
  }

  // En fonds utländska innehav (data/fund/<id>.json) i stället för hela <kvartal>-world.json.
  // Returnerar ett dataset med fonden, eller null medan det laddas.
  function fundWorld(id) {
    var d = quarterData(), q = state.q, key = "fw-" + id;
    if (d.world) return d.world;
    if (q !== latestQ() || failed(key)) return needWorld() ? d.world : null;
    if (!need(key, function () {
      return getJSON("data/fund/" + encodeURIComponent(id) + ".json").then(function (raw) {
        if (raw.q !== q) throw new Error("data/fund/" + id + ".json gäller " + raw.q);
        d.fundWorld = d.fundWorld || {};
        d.fundWorld[id] = prepare(raw);
      });
    })) return null;
    return d.fundWorld[id];
  }

  // Aktiv andel, koncentration och antal aktier per fond, uträknade i bygget (data/profiles.json)
  function needProfiles() {
    var d = quarterData(), q = state.q;
    if (q !== latestQ() || failed("profiles")) return needWorld();
    return need("profiles", function () {
      return getJSON("data/profiles.json").then(function (p) {
        if (p.q !== q) throw new Error("data/profiles.json gäller " + p.q);
        d.profileData = p.p;
      });
    });
  }

  // Namn på utländska aktier för sökningen (data/search.json) i stället för hela utlandsfilen
  function needSearchNames() {
    var d = quarterData(), q = state.q;
    if (d.world || q !== latestQ() || failed("search-names")) return needWorld();
    return need("search-names", function () {
      return getJSON("data/search.json").then(function (x) {
        if (x.q !== q) throw new Error("data/search.json gäller " + x.q);
        d.searchNames = x.stocks.map(function (s) {
          return { isin: s[0], name: prettyName(s[1]), sector: s[2] || "Övrigt", country: s[3] || "", f2: s[4], val2: s[5] };
        });
      });
    });
  }

  function prepare(raw) {
    var ds = { raw: raw };
    ds.funds = raw.funds.map(function (x) {
      return { id: x[0], name: x[1], co: x[2], bench: x[3], aum1: x[4], aum2: x[5], h: x[6], isIndex: INDEX_RE.test(x[1]) };
    });
    ds.fundById = {};
    ds.funds.forEach(function (f) { ds.fundById[f.id] = f; });
    compute(ds);
    return ds;
  }

  // Räknar fram per aktie och per fond. Förändringar räknas bara för fonder som rapporterat båda kvartalen.
  function compute(ds) {
    var stocks = ds.raw.stocks.map(function (s, i) {
      return {
        i: i, isin: s[0], name: prettyName(s[1]), sector: s[2] || "Övrigt", price: s[3] || 0, split: s[4], country: s[5] || "",
        h2: 0, f2: 0, h1b: 0, h2b: 0, f1b: 0, f2b: 0, flow: 0, nNew: 0, nExit: 0, trades: []
      };
    });
    var t = { funds: 0, buy: 0, sell: 0, value: 0, held: 0 };
    ds.funds.forEach(function (f) {
      var both = f.aum1 != null && f.aum2 != null;
      f.both = both;
      f.val = 0; f.bought = 0; f.sold = 0; f.nHold = 0;
      var excluded = state.excludeIndex && f.isIndex;
      if (both && !excluded) t.funds++;
      f.h.forEach(function (r) {
        var s = stocks[r[0]], s1 = r[1] || 0, s2 = r[2] || 0, d = (s2 - s1) * s.price;
        if (s2 && f.aum2 != null) { f.val += s2 * s.price; f.nHold++; }
        if (both) { if (d > 0) f.bought += d; else f.sold += d; }
        if (excluded) return;
        if (s2 && f.aum2 != null) { s.h2 += s2; s.f2++; }
        if (!both) return;
        if (s1) s.f1b++;
        if (s2) s.f2b++;
        s.h1b += s1; s.h2b += s2; s.flow += d;
        if (!s1 && s2) s.nNew++;
        if (s1 && !s2) s.nExit++;
        if (s1 !== s2) s.trades.push({ f: f, s1: s1, s2: s2, d: d });
      });
    });
    stocks.forEach(function (s) {
      s.val2 = s.h2 * s.price;
      s.val1 = s.h1b * s.price;
      s.chg = s.h1b ? (s.h2b - s.h1b) / s.h1b : null;
      s.dF = s.f2b - s.f1b;
      // Ingen fond ägde aktien förra kvartalet (notering, avknoppning, nytt aktieslag)
      // eller ingen äger den längre (uppköp, avnotering). Räknas inte som köp eller sälj.
      s.isNew = s.h1b === 0 && s.h2b > 0;
      s.isGone = s.h2b === 0 && s.h1b > 0;
      s.netFlow = s.isNew || s.isGone ? null : s.flow;
      if (s.f2) t.held++;
      t.value += s.val2;
      if (s.netFlow > 0) t.buy += s.netFlow; else if (s.netFlow < 0) t.sell += s.netFlow;
    });
    ds.stocks = stocks;
    ds.byIsin = {};
    stocks.forEach(function (s) { ds.byIsin[s.isin] = s; });
    ds.totals = t;
  }

  function recomputeAll() {
    Object.keys(state.data).forEach(function (q) {
      var d = state.data[q];
      if (d.se) compute(d.se);
      if (d.world) compute(d.world);
    });
  }

  // Aktuell marknad: returnerar dataset eller null medan det laddas
  function marketDs() {
    var d = quarterData();
    if (state.market === "se") return d.se;
    return needWorld() ? d.world : null;
  }

  // ---------- Historik ----------

  function histFor(isin) {
    var h = state.history;
    if (!h || !h.stocks[isin]) return null;
    var e = h.stocks[isin];
    var byQ = {};
    e[3].forEach(function (r) { byQ[r[0]] = r; });
    return { name: prettyName(e[0]), sector: e[1], country: e[2], byQ: byQ };
  }

  function flowOf(r) { return r ? (state.excludeIndex ? r[4] : r[3]) : null; }

  // Antal kvartal i rad (bakåt från valt kvartal) med nettoköp eller nettosälj
  function streak(hs, qi) {
    var first = flowOf(hs.byQ[qi]);
    if (first == null || Math.abs(first) < 0.5) return { n: 0, sign: 0, sum: 0 };
    var sign = first > 0 ? 1 : -1, n = 0, sum = 0;
    for (var k = qi; k >= 0; k--) {
      var v = flowOf(hs.byQ[k]);
      if (v == null || Math.abs(v) < 0.5 || (v > 0 ? 1 : -1) !== sign) break;
      n++; sum += v;
    }
    return { n: n, sign: sign, sum: sum };
  }

  function streakList(ds, sign) {
    var h = state.history, qi = h.qIndex[state.q];
    if (qi == null) return [];
    var out = [];
    ds.stocks.forEach(function (s) {
      if (s.val2 < 100e6 || s.isNew || s.isGone) return;
      var hs = histFor(s.isin);
      if (!hs) return;
      var st = streak(hs, qi);
      if (st.sign === sign && st.n >= 2) out.push({ s: s, n: st.n, sum: st.sum });
    });
    return out.sort(function (a, b) { return b.n - a.n || Math.abs(b.sum) - Math.abs(a.sum); });
  }

  // ---------- Tabeller ----------

  // cols: { key, label, align, cls, hideSm, cell(row, n), value(row) }
  function table(key, cols, rows, opts) {
    opts = opts || {};
    var sort = state.sorts[key] || opts.sort;
    if (sort && !opts.static) {
      var col = cols.filter(function (c) { return c.key === sort.col; })[0];
      if (col && col.value) {
        rows = rows.slice().sort(function (a, b) {
          var x = col.value(a), y = col.value(b);
          if (x == null && y == null) return 0;
          if (x == null) return 1;
          if (y == null) return -1;
          if (typeof x === "string") return sort.dir * x.localeCompare(y, "sv");
          return sort.dir * (x - y);
        });
      }
    }
    if (opts.csv) state.tables[key] = { cols: cols, rows: rows };
    // opts.expand: knapp som visar alla rader i stället för de första opts.limit
    var total = rows.length, showAll = opts.expand && state.showAll[key];
    if (opts.limit && !showAll) rows = rows.slice(0, opts.limit);
    var moreBtn = opts.expand && opts.limit && total > opts.limit
      ? '<button type="button" class="more-rows" data-show-all="' + esc(key) + '">' + (showAll ? "Visa färre" : "Visa alla " + int(total)) + "</button>" : "";
    var head = cols.map(function (c) {
      var thCls = [c.align === "l" ? "l" : "", c.hideSm ? "hide-sm" : ""].join(" ").trim();
      var al = thCls ? ' class="' + thCls + '"' : "";
      if (!c.value || opts.static) return "<th" + al + ' scope="col">' + c.label + "</th>";
      var active = sort && sort.col === c.key;
      var aria = active ? ' aria-sort="' + (sort.dir > 0 ? "ascending" : "descending") + '"' : "";
      var arrow = active ? (sort.dir > 0 ? " ▲" : " ▼") : "";
      return "<th" + al + aria + ' scope="col"><button type="button" data-sort="' + key + ":" + c.key + '">' + c.label + arrow + "</button></th>";
    }).join("");
    var body = rows.map(function (r, n) {
      // Rader vars namn är en länk får klassen rl (hela raden går att klicka på)
      var link = false;
      var tds = cols.map(function (c) {
        var classes = [c.align === "l" ? "l" : "", c.cls || "", c.hideSm ? "hide-sm" : ""].join(" ").trim();
        var html = c.cell(r, n);
        if (c.cls === "name" && String(html).indexOf("<a ") === 0) link = true;
        return "<td" + (classes ? ' class="' + classes + '"' : "") + ">" + html + "</td>";
      }).join("");
      return (link ? '<tr class="rl">' : "<tr>") + tds + "</tr>";
    }).join("");
    if (!rows.length) body = '<tr><td class="empty" colspan="' + cols.length + '">' + (opts.empty || "Inga rader.") + "</td></tr>";
    return '<div class="table-wrap"><table><thead><tr>' + head + "</tr></thead><tbody>" + body + "</tbody></table></div>" +
      moreBtn +
      (opts.csv && rows.length ? '<button type="button" class="csv-btn" data-csv="' + esc(key) + '">Ladda ner som CSV (Excel)</button>' : "");
  }

  // Exporterar en tabell som CSV med semikolon och decimalkomma, så att den öppnas rätt i svenska Excel
  function cellText(html) {
    var div = document.createElement("div");
    div.innerHTML = html;
    div.querySelectorAll(".sub, .show-sm").forEach(function (n) { n.remove(); });
    var t = div.textContent.replace(/\s+/g, " ").trim().replace(/−/g, "-");
    // "+5 893" och "1 234,5 %" blir tal som Excel känner igen
    if (/^[+\-]?[\d\s  ]+(,\d+)?(\s?%)?$/.test(t)) t = t.replace(/[\s  %]/g, "").replace(/^\+/, "");
    return t;
  }
  function downloadCsv(key) {
    var t = state.tables[key];
    if (!t) return;
    var q = function (s) { return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var lines = [t.cols.map(function (c) { return q(cellText(c.label)); }).join(";")];
    // En kolumn kan ange ett exakt värde för filen (csv), annars används texten i cellen
    t.rows.forEach(function (r, n) { lines.push(t.cols.map(function (c) { var v = c.csv ? c.csv(r) : null; return q(v != null ? String(v) : cellText(c.cell(r, n))); }).join(";")); });
    var blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "fondinsyn-" + key.replace(/[^a-z0-9-]+/gi, "-") + "-" + state.q + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function bar(value, max, kind) {
    var w = max ? Math.max(1, Math.min(100, Math.abs(value) / max * 100)) : 0;
    return '<span class="bar ' + kind + '"><i style="width:' + w.toFixed(1) + '%"></i></span>';
  }

  function changeLabel(s1, s2) {
    if (!s1 && s2) return '<span class="label new">Ny</span>';
    if (s1 && !s2) return '<span class="label out">Avvecklad</span>';
    if (s2 > s1) return '<span class="label up">Ökad</span>';
    if (s2 < s1) return '<span class="label down">Minskad</span>';
    return '<span class="label">Oförändrad</span>';
  }

  // Namncell med en extra rad som bara visas på mobil, där kolumnerna den ersätter är dolda.
  function nameCell(href, name, sub) {
    return '<a href="' + href + '">' + esc(name) + "</a>" + (sub ? '<span class="sub show-sm">' + sub + "</span>" : "");
  }

  function stockCol(subFn) {
    return { key: "name", label: "Aktie", align: "l", cls: "name", value: function (s) { return s.name; },
      cell: function (s) { return nameCell(stockHref(s), s.name, subFn && subFn(s)); } };
  }

  var col = {
    rank: { key: "rank", label: "#", cls: "rank", hideSm: true, cell: function (r, n) { return n + 1; } },
    stock: stockCol(),
    sector: { key: "sector", label: "Sektor", align: "l", cls: "muted", hideSm: true, cell: function (s) { return esc(s.sector); }, value: function (s) { return s.sector; } },
    country: { key: "country", label: "Land", align: "l", cls: "muted", hideSm: true, cell: function (s) { return esc(countryName(s.country)); }, value: function (s) { return countryName(s.country); } },
    funds: { key: "f2", label: "Fonder", hideSm: true, cell: function (s) { return int(s.f2); }, value: function (s) { return s.f2; } },
    dFunds: { key: "dF", label: "Δ fonder", hideSm: true, cell: function (s) { return '<span class="' + cls(s.dF) + '">' + (s.dF ? signed(String(s.dF), s.dF) : "0") + "</span>"; }, value: function (s) { return s.dF; } },
    value: { key: "val2", label: "Innehav (mkr)", hideSm: true, cell: function (s) { return mkr(s.val2); }, value: function (s) { return s.val2; } },
    flow: { key: "flow", label: "Nettoköp (mkr)", cell: function (s) {
      if (s.isNew) return '<span class="label new">Ny</span>';
      if (s.isGone) return '<span class="label out">Borta</span>';
      return '<span class="' + cls(s.flow) + '">' + mkr(s.flow, true) + "</span>";
    }, value: function (s) { return s.netFlow; } },
    chg: { key: "chg", label: "Δ antal aktier", cell: function (s) { return '<span class="' + cls(s.chg) + '">' + pct(s.chg) + "</span>"; }, value: function (s) { return s.isNew || s.isGone ? null : s.chg; } }
  };

  function flowCol(max) {
    return { key: "flow", label: "Nettoköp (mkr)", cell: function (s) {
      return '<span class="barcell"><span class="' + cls(s.flow) + '">' + mkr(s.flow, true) + "</span>" + bar(s.flow, max, s.flow >= 0 ? "pos" : "neg") + "</span>";
    } };
  }

  // ---------- Byggstenar ----------

  function block(title, desc, inner, extraCls) {
    return '<section class="block' + (extraCls ? " " + extraCls : "") + '"><div class="block-head"><h2>' + title + "</h2></div>" +
      (desc ? '<p class="desc">' + desc + "</p>" : "") + inner + "</section>";
  }
  function fig(label, value, note) {
    return "<div><dt>" + label + "</dt><dd>" + value + "</dd>" + (note ? '<span class="fig-note">' + note + "</span>" : "") + "</div>";
  }
  // Platshållare som skimrar medan datan laddas (texten läses upp av skärmläsare)
  function loadingBlock(text) {
    return '<div class="loading" role="status"><span class="visually-hidden">' + (text || "Laddar…") + '</span>' +
      '<div class="sk sk-line w40"></div><div class="sk sk-line w90"></div><div class="sk sk-line w70"></div><div class="sk sk-block"></div></div>';
  }
  function errorBlock() { return '<div class="notice">Datan kunde inte laddas. Ladda om sidan för att försöka igen.</div>'; }
  function notFound(msg) { return '<div class="notice">' + esc(msg) + ' <a href="#/">Till översikten</a></div>'; }

  // Diagram ritas efter att sidan satts in, och ritas om när fönstrets bredd ändras
  function chart(draw) {
    var id = "chart-" + state.charts.length;
    state.charts.push({ id: id, draw: draw });
    return '<div class="chart" id="' + id + '"></div>';
  }
  function drawCharts() {
    state.charts.forEach(function (c) {
      var node = $(c.id);
      if (node) c.draw(node);
    });
  }

  function marketWord() { return state.market === "se" ? "svenska" : "globala"; }

  // ---------- Översikt ----------

  // Kvartalets rubrik, samma på startsidan och i kvartalsrapporten: den sektor fonderna köpte mest och den mest köpta aktien
  function quarterHeadline(cont, buys, sells) {
    var by = {};
    cont.forEach(function (s) { if (s.sector && s.sector !== "Övrigt") by[s.sector] = (by[s.sector] || 0) + s.flow; });
    var secs = Object.keys(by).sort(function (a, b) { return by[b] - by[a]; });
    if (!secs.length) return "Fondernas affärer";
    if (by[secs[0]] > 0) return "Fonderna köpte " + lcWord(secs[0]) + (buys[0] ? " och mest av allt " + buys[0].name : "");
    var worst = secs[secs.length - 1];
    return "Fonderna sålde " + lcWord(worst) + (sells[0] ? " och mest av allt " + sells[0].name : "");
  }

  // Överst på startsidan: kvartalsrapporten i liten form, med val av kvartal och marknad
  var repPick = { q: null, market: null };
  // Vad Fondinsyn är och hur ofta datan uppdateras. Kan döljas, men bara under besöket (sessionStorage):
  // den som kommer tillbaka senare, till exempel från en sökning, ser den igen.
  function aboutHidden(hide) {
    try {
      if (hide) sessionStorage.setItem("ff-hide-about", "1");
      return sessionStorage.getItem("ff-hide-about") === "1";
    } catch (e) { return false; }
  }
  function aboutCard() {
    if (aboutHidden()) return "";
    var built = state.front && state.front.built ? shortStamp(state.front.built) : null;
    var item = function (what, when, src) { return "<div><dt>" + what + "</dt><dd>" + when + "</dd><span>" + src + "</span></div>"; };
    return '<section class="about-card" aria-label="Om Fondinsyn">' +
      '<button type="button" class="ac-close" data-hide-about aria-label="Dölj rutan" title="Dölj">×</button>' +
      '<div class="ac-text"><h2>Vad är Fondinsyn?</h2>' +
      "<p>Fondinsyn visar vad svenska fonder köper och säljer. Varje kvartal rapporterar fondbolagen alla sina innehav till Finansinspektionen, " +
      "och vi jämför kvartalen per aktie, fond och fondbolag. Till det kommer insynshandel, blankning, uppköp, fondsparande, räntor och bolagens egna kvartalsrapporter. " +
      'All data kommer från officiella källor. Gratis och oberoende. <a href="#/om">Så fungerar det</a></p></div>' +
      '<dl class="ac-freq">' +
      item("Fondernas innehav", "Varje kvartal", "Finansinspektionen") +
      item("Insynshandel och blankning", "Varje dag", "Finansinspektionen") +
      item("Fondsparandet", "Varje månad", "Fondbolagens förening") +
      item("Räntor och avkastning", "Dag och vecka", "Riksbanken, Pensionsmyndigheten") +
      "</dl>" + (built ? '<p class="ac-stamp">Senast uppdaterad ' + esc(built) + "</p>" : "") + "</section>";
  }

  // Data för kortet: valt kvartal och vald marknad. Andra kvartal och utländska aktier laddas när de väljs.
  function cardData(q, world) {
    var d = state.data[q];
    if (!d || !d.se) { need("se-" + q, function () { return loadSe(q); }); return null; }
    if (!world) return { meta: d.meta, ds: d.se };
    if (!d.world) {
      need("world-" + q, function () { return getJSON("data/" + q + "-world.json").then(function (raw) { state.data[q].world = prepare(raw); }); });
      return null;
    }
    return { meta: d.meta, ds: d.world };
  }

  function reportCard() {
    var pq = repPick.q || state.q, pm = repPick.market || state.market, world = pm === "world";
    var opts = state.index.quarters.map(function (x) {
      return '<option value="' + x.id + '"' + (x.id === pq ? " selected" : "") + ">" + quarterLabel(x.id) + "</option>";
    }).join("");
    var pick = function (v, label) { return '<button type="button" class="seg-btn" data-rep-pick="' + v + '" aria-pressed="' + (pm === v) + '">' + label + "</button>"; };
    var cd = cardData(pq, world), body, movers = "";
    if (cd) {
      var cont = cd.ds.stocks.filter(function (s) { return s.price && !s.isNew && !s.isGone; });
      var buys = cont.filter(function (s) { return s.flow > 0; }).sort(function (a, b) { return b.flow - a.flow; });
      var sells = cont.filter(function (s) { return s.flow < 0; }).sort(function (a, b) { return a.flow - b.flow; });
      var t = cd.ds.totals, net = t.buy + t.sell;
      body = '<a class="rc-title rc-web-link" href="' + reportHref(pq) + '">' + esc(quarterHeadline(cont, buys, sells)) + "</a>" +
        '<p class="rc-meta">Fonderna ' + (net < 0 ? "nettosålde " : "nettoköpte ") + (world ? "globala" : "svenska") + " aktier för <b>" + bigSek(Math.abs(net)) + "</b>. " + int(t.funds) + " fonder" + (state.excludeIndex ? " utan indexfonder" : "") + ", innehaven den " + dateText(cd.meta.curr) + ".</p>";
      movers = topMovers(buys.slice(0, 5), sells.slice(0, 5));
    } else {
      body = (failed("se-" + pq) || failed("world-" + pq)) ? '<p class="rc-meta">Rapporten kunde inte laddas. Ladda om sidan för att försöka igen.</p>' :
        '<div class="sk sk-line w70" style="height:30px;margin:4px 0 10px"></div><div class="sk sk-line w40"></div>';
      movers = '<div class="rc-movers" aria-hidden="true"><div class="sk sk-block"></div></div>';
    }
    return '<section class="rep-card" aria-label="Kvartalsrapporten">' +
      '<div class="rc-top"><p class="kicker">Kvartalsrapporten för ' + quarterLabel(pq) + ", " + (world ? "globala aktier" : "svenska aktier") + "</p>" +
      '<div class="rc-controls" role="group" aria-label="Välj kvartal och marknad">' +
      '<select class="select-sm" id="repQ" aria-label="Kvartal">' + opts + "</select>" +
      '<div class="seg" role="group" aria-label="Marknad i rapporten">' + pick("se", "Sverige") + pick("world", "Globalt") + "</div></div></div>" +
      '<div class="rc-body"><div class="rc-main">' + body + repGoLinks(pq, pm) +
      (pq === state.index.quarters[0].id ? '<p class="rc-next">Fonderna rapporterar sina innehav en gång per kvartal, och Finansinspektionen publicerar dem en tid efter kvartalets slut. ' +
        quarterLabel(nextQuarter(pq)) + " läggs in samma morgon som det publiceras.</p>" : "") +
      "</div>" + movers + "</div></section>";
  }
  // Kvartalets fem största köp och sälj som staplar i samma skala, så att storlekarna går att jämföra
  function topMovers(buys, sells) {
    var max = Math.max(buys.length ? buys[0].flow : 0, sells.length ? -sells[0].flow : 0) || 1;
    var list = function (title, rows, kind) {
      return '<div class="mv-col"><h2 class="mv-h">' + title + '</h2><ol class="mv-list">' + rows.map(function (s) {
        var w = Math.max(2, Math.abs(s.flow) / max * 100);
        return '<li><a href="' + stockHref(s) + '">' + esc(s.name) + '</a><span class="mv-bar ' + kind + '"><i style="width:' + w.toFixed(1) + '%"></i></span>' +
          '<span class="mv-v">' + bigSek(s.flow, true) + "</span></li>";
      }).join("") + "</ol></div>";
    };
    return '<div class="rc-movers">' + list("Mest köpta", buys, "pos") + list("Mest sålda", sells, "neg") + "</div>";
  }
  // Ritar om bara kortet när kvartal eller marknad väljs (resten av startsidan står kvar)
  function refreshReportCard() {
    var card = document.querySelector(".rep-card");
    if (!card) return;
    card.outerHTML = reportCard();
    segThumbs();
  }
  function reportHref(q) { return q === state.q ? "#/rapport" : "#/rapport/" + q; }
  function nextQuarter(q) { var y = +q.slice(0, 4), n = +q.slice(5); return n === 4 ? (y + 1) + "Q1" : y + "Q" + (n + 1); }

  // Genvägar till sajtens avdelningar, var och en med en aktuell siffra
  function quickLinks(ds, rail) {
    var f = state.front || {}, t = ds.totals, net = t.buy + t.sell;
    var policy = (f.rates || []).filter(function (r) { return r[0] === "SECBREPOEFF"; })[0];
    var sav = f.savings;
    var tile = function (href, title, value, desc) {
      return '<a class="ql" href="' + href + '"><span class="ql-t">' + title + '</span><span class="ql-v">' + value + '</span><span class="ql-d">' + desc + "</span></a>";
    };
    return '<nav class="quick' + (rail ? " rail" : " section-gap") + '" aria-label="Genvägar">' +
      tile("#/aktier", "Aktier", '<span class="' + cls(net) + '">' + bigSek(net, true) + "</span>", "fondernas nettoköp i " + int(t.held) + " " + marketWord() + " aktier") +
      tile("#/fonder", "Fonder", int(Object.keys(quarterData().fi).length), "fonder med innehav, avgifter och avkastning") +
      tile("#/insyn", "Insynshandel", f.insider ? bigSek(f.insider.buy30) : "Insyn", f.insider ? "insiders köp de senaste 30 dagarna" : "insiders köp och sälj i sina egna bolag") +
      tile("#/sparande", "Sparande", sav ? '<span class="' + cls(sav[1]) + '">' + bigSek(sav[1] * 1e6, true) + "</span>" : "Fondsparandet",
        sav ? "spararnas nettosparande i " + monthLabel(sav[0], true) : "vart spararnas pengar går") +
      tile("#/rantor", "Räntor", policy ? nf2.format(policy[2]) + " %" : "Räntor", "Riksbankens styrränta, obligationer och räntefonder") +
      tile("#/rapport", "Kvartalsrapporter", quarterLabel(state.index.quarters[0].id), "alla kvartal, som webbsida och PDF") +
      "</nav>";
  }

  // ---------- Kvartalsrapporten som PDF ----------
  // PDF-filerna skapas av scripts/build-pdf.sh när sajten publiceras (Chrome skriver ut rapportsidan med ?pdf).
  // data/reports-pdf.json listar vilka som finns, t.ex. ["2026-q2", "2026-q2-utland"].
  function reportSlug(q) { return q.slice(0, 4) + "-q" + q.slice(5); }
  function pdfName(q, world) { return reportSlug(q) + (world ? "-utland" : ""); }
  function pdfHref(q, world) { return "/rapport/" + reportSlug(q) + "/fondinsyn-" + pdfName(q, world) + ".pdf"; }
  function hasPdf(q, world) { return hasPdfName(pdfName(q, world)); }
  function hasPdfName(name) {
    if (!need("pdfs", function () { return getJSON("data/reports-pdf.json").then(function (d) { state.pdfs = d; }, function () { state.pdfs = []; }); })) return false;
    return (state.pdfs || []).indexOf(name) >= 0;
  }
  // "Läs rapporten" öppnar PDF:en i en ny flik när den finns, annars webbversionen
  function repGoLinks(q, market) {
    var pdf = hasPdf(q, market === "world");
    return '<span class="rc-go"><a class="btn btn-primary" id="repGo" href="' + (pdf ? pdfHref(q, market === "world") : reportHref(q)) + '"' +
      (pdf ? ' target="_blank" rel="noopener" data-pdf="1"' : "") + ">Läs rapporten" + (pdf ? ' <span class="btn-tag">PDF</span>' : "") + "</a>" +
      (pdf ? '<a class="rc-web" id="repWeb" href="' + reportHref(q) + '">Webbversion</a>' : "") + "</span>";
  }

  // Kvartalets nettoköp som en stor siffra, en mening som sätter den i perspektiv och staplar för tre år
  function heroFigure(net) {
    var head = '<div class="hero-figure"><div class="hf-label">Fondernas nettoköp <span>' + (state.market === "world" ? "globala" : "svenska") + " aktier, " + quarterLabel(state.q) +
      (state.excludeIndex ? " · utan indexfonder" : "") + "</span></div>" +
      '<div class="hf-value count ' + cls(net) + '">' + bigSek(net, true) + "</div>";
    var part = state.market === "world" ? "world" : "se";
    if (state.loading["history-" + part] !== "done") return head + '<div class="sk sk-line w70 hf-sk"></div><div class="sk sk-chart"></div></div>';
    var h = state.history, qi = h.qIndex[state.q];
    if (qi == null) return head + "</div>";
    var flows = sectorFlows(state.market), tot = {};
    Object.keys(flows).forEach(function (sec) { Object.keys(flows[sec]).forEach(function (k) { tot[k] = (tot[k] || 0) + flows[sec][k]; }); });
    var pts = [];
    // Det valda kvartalet visar samma siffra som rubriken (den följer valet att utesluta indexfonder)
    tot[qi] = net / 1e6;
    for (var k = Math.max(1, qi - 11); k <= qi; k++) pts.push({ q: h.quarters[k], value: tot[k] == null ? null : tot[k] / 1000, highlight: k === qi });
    return head + '<p class="hf-note">' + flowContext(tot, h.quarters, qi) + "</p>" + chart(function (node) {
      FFCharts.columns(node, pts, { height: 148, ticks: 3, focus: true, barMax: 18,
        label: function (p) { return signed(nf1.format(p.value), p.value); },
        tip: function (p) {
          return "<b>" + quarterLabel(p.q) + "</b>" + (p.value == null ? '<div class="muted">Ingen data</div>' : tipRow(p.value >= 0 ? "c-pos" : "c-neg", p.value >= 0 ? "Köpt netto" : "Sålt netto", bigSek(p.value * 1e9, true), true));
        } });
    }) + "</div>";
  }

  // "Det största nettoköpet sedan Q4 2023. Förra kvartalet −15,6 mdkr." Värdena i tot är mkr per kvartalsindex.
  function flowContext(tot, quarters, qi) {
    var cur = tot[qi];
    if (cur == null) return "";
    var parts = [], pos = cur >= 0;
    var since = null;
    for (var k = qi - 1; k >= 1; k--) {
      if (tot[k] == null) continue;
      if (pos ? tot[k] >= cur : tot[k] <= cur) { since = k; break; }
    }
    var what = pos ? "nettoköpet" : "nettosäljet";
    if (since == null && qi > 8) parts.push("Det största " + what + " sedan mätningarna började " + quarters[1].slice(0, 4) + ".");
    else if (since != null && qi - since >= 4) parts.push("Det största " + what + " sedan " + quarterLabel(quarters[since]) + ".");
    if (tot[qi - 1] != null) parts.push("Förra kvartalet " + bigSek(tot[qi - 1] * 1e6, true) + ".");
    return parts.join(" ");
  }

  function viewOverview() {
    var ds = marketDs();
    if (!ds) return failed("world-" + state.q) ? errorBlock() : loadingBlock("Laddar globala aktier…");
    var S = ds.stocks;
    var cont = S.filter(function (s) { return s.price && !s.isNew && !s.isGone; });
    var buys = cont.filter(function (s) { return s.flow > 0; }).sort(function (a, b) { return b.flow - a.flow; }).slice(0, 15);
    var sells = cont.filter(function (s) { return s.flow < 0; }).sort(function (a, b) { return a.flow - b.flow; }).slice(0, 15);
    var news = cont.filter(function (s) { return s.nNew > 0; }).sort(function (a, b) { return b.nNew - a.nNew || b.flow - a.flow; }).slice(0, 10);
    var exits = cont.filter(function (s) { return s.nExit > 0; }).sort(function (a, b) { return b.nExit - a.nExit || a.flow - b.flow; }).slice(0, 10);
    var arrived = S.filter(function (s) { return s.isNew; }).sort(function (a, b) { return b.val2 - a.val2; }).slice(0, 10);
    var gone = S.filter(function (s) { return s.isGone; }).sort(function (a, b) { return b.val1 - a.val1; }).slice(0, 10);
    var maxFlow = Math.max(buys.length ? buys[0].flow : 0, sells.length ? -sells[0].flow : 0);

    var fundsWide = { key: "f2", label: "Fonder", hideSm: true, cell: col.funds.cell };
    var flowCols = [col.rank, col.stock, flowCol(maxFlow), col.chg, fundsWide];
    var plainFlow = { key: "flow", label: "Nettoköp (mkr)", cell: function (s) { return '<span class="' + cls(s.flow) + '">' + mkr(s.flow, true) + "</span>"; } };
    var newCols = [col.rank, col.stock, { key: "n", label: "Nya fonder", cell: function (s) { return '<span class="pos">+' + s.nNew + "</span>"; } }, plainFlow, fundsWide];
    var exitCols = [col.rank, col.stock, { key: "n", label: "Avvecklat", cell: function (s) { return '<span class="neg">−' + s.nExit + "</span>"; } }, plainFlow, fundsWide];
    var arrivedCols = [col.rank, col.stock, { key: "v", label: "Innehav (mkr)", cell: function (s) { return mkr(s.val2); } }, { key: "f", label: "Fonder", cell: function (s) { return int(s.f2); } }];
    var goneCols = [col.rank, col.stock, { key: "v", label: "Förra kv. (mkr)", cell: function (s) { return mkr(s.val1); } }, { key: "f", label: "Fonder", cell: function (s) { return int(s.f1b); } }];
    var st = { static: true };

    // Köpsviter kräver historiken
    var hasHist = needHistory();
    var buyStreaks = hasHist ? streakList(ds, 1) : null;
    var sellStreaks = hasHist ? streakList(ds, -1) : null;
    var streakCols = function (sign) {
      return [col.rank, col.stock,
        { key: "n", label: "Kvartal i rad", cell: function (r) { return '<span class="streak ' + (sign > 0 ? "pos" : "neg") + '">' + r.n + "</span>"; } },
        { key: "sum", label: "Summa (mkr)", cell: function (r) { return '<span class="' + cls(r.sum) + '">' + msek(r.sum, true) + "</span>"; } }];
    };
    var streakRows = function (list) { return list.map(function (r) { r.name = r.s.name; r.isin = r.s.isin; return r; }); };


    return '<h1 class="visually-hidden">Fondinsyn: vad svenska fonder köper och säljer</h1>' + reportCard() + quickLinks(ds, true) + aboutCard() + watchBlock() + signalModules() + reportWeek() +
      '<div class="grid-2 section-gap">' +
      block("Störst nettoköp", "Förändring i antal aktier × kurs vid kvartalsslut. " + termLink("nettokop", "Hur räknas det?"), table("ov-buy", flowCols, buys, st) + '<a class="more" href="#/aktier">Alla aktier</a>') +
      block("Störst nettosälj", "&nbsp;", table("ov-sell", flowCols, sells, st)) +
      "</div>" +
      sectorBlock(hasHist) +
      '<div class="grid-2 section-gap">' +
      block("Längsta köpsviter", "Aktier som fonderna nettoköpt flest kvartal i rad", buyStreaks ? table("ov-bs", streakCols(1), streakRows(buyStreaks.slice(0, 10)), st) : loadingBlock("Laddar historik…")) +
      block("Längsta säljsviter", "Aktier som fonderna nettosålt flest kvartal i rad", sellStreaks ? table("ov-ss", streakCols(-1), streakRows(sellStreaks.slice(0, 10)), st) : loadingBlock("Laddar historik…")) +
      "</div>" +
      '<div class="grid-2 section-gap">' +
      block("Flest nya fondägare", "Fonder som inte ägde aktien förra kvartalet", table("ov-new", newCols, news, st)) +
      block("Flest avvecklade innehav", "Fonder som sålt hela sitt innehav", table("ov-exit", exitCols, exits, st)) +
      "</div>" +
      '<div class="grid-2 section-gap">' +
      block("Nya i fonderna", "Ägdes inte av någon fond förra kvartalet: noteringar, avknoppningar, nya aktieslag. Räknas inte som köp.", table("ov-arr", arrivedCols, arrived, st)) +
      block("Borta ur fonderna", "Ägs inte längre av någon fond: uppköp, avnoteringar, byte av aktieslag. Räknas inte som sälj.", table("ov-gone", goneCols, gone, st)) +
      "</div>";
  }

  // ---------- Marknadsremsan och startsidans moduler (data/front.json) ----------

  var RATE_SHORT = { SECBREPOEFF: "Styrränta", SEGVB10YC: "Statsobl. 10 år", SEMB5YCACOMB: "Bostadsobl. 5 år", SEGVB2YC: "Statsobl. 2 år" };
  // Bolagsnamn utan "AB" och "(publ)" i korta listor
  function shortCo(n) { return prettyName(n).replace(/\s*\(publ\)\s*$/i, "").replace(/\s+AB$/, ""); }
  function ratePp(v) { return v == null ? "" : Math.abs(v) < 0.005 ? "oförändrad" : signed(nf2.format(v), v) + " p.e."; }
  // Riksbankens beslut som inte börjat gälla än ({rate, from, date, url}), annars null
  function policyNext(n, now) {
    return n && n.from > new Date().toISOString().slice(0, 10) && (now == null || Math.abs(n.rate - now) >= 0.005) ? n : null;
  }
  // "höjs till 2,00 % den 11 november"
  function policyNextText(n, now, short) {
    var d = dateText(n.from).replace(/ \d{4}$/, "");
    return (now == null ? "blir " : n.rate > now ? "höjs till " : "sänks till ") + ratePct(n.rate) + " den " + (short ? d.replace(/(\d+ \w{3})\w*/, "$1") : d);
  }

  function loadFront() {
    getJSON("data/front.json").then(function (f) { state.front = f; }, function () { state.front = false; }).then(function () {
      renderTicker();
      if (document.body.getAttribute("data-page") === "oversikt" && quarterData() && quarterData().se) render();
    });
  }

  function renderTicker() {
    var f = state.front, el = $("ticker");
    if (!el) return;
    if (!f) { el.parentNode.hidden = true; return; }
    var item = function (href, label, value, chg, title) {
      return '<a class="tk" href="' + href + '"' + (title ? ' title="' + esc(title) + '"' : "") + '><span class="tk-l">' + label + '</span><span class="tk-v">' + value + "</span>" +
        (chg ? '<span class="tk-c ' + chg[1] + '">' + chg[0] + "</span>" : "") + "</a>";
    };
    var parts = ['<span class="tk-live">Uppdaterad ' + esc(shortStamp(f.built)) + "</span>"];
    (f.rates || []).forEach(function (r) {
      if (r[0] === "SEGVB2YC") return;
      var nx = r[0] === "SECBREPOEFF" ? policyNext(f.next, r[2]) : null;
      parts.push(item("#/rantor", RATE_SHORT[r[0]] || esc(r[1]), ratePct(r[2]), nx ? [policyNextText(nx, r[2], true), nx.rate > r[2] ? "pos" : "neg"] : r[4] != null ? [ratePp(r[4]) + " på 1 år", ""] : null,
        r[1] + ", " + dateText(r[3]) + (nx ? ". Riksbanken beslutade den " + dateText(nx.date) + " att räntan " + policyNextText(nx, r[2]) : "")));
    });
    parts.push('<span class="tk-sep" aria-hidden="true"></span>');
    parts.push(item("#/rapport", "Fonderna " + esc(f.ql), bigSek(f.net, true), null, "Svenska fonders nettoköp av svenska aktier"));
    if (f.insider) parts.push(item("#/insyn", "Insiderköp 30 d", bigSek(f.insider.buy30), null, "Insiders köp de senaste 30 dagarna"));
    if (f.shorts && f.shorts[0]) parts.push(item("#/blankning", "Mest blankad", esc(shortCo(f.shorts[0][0])) + " " + nf1.format(f.shorts[0][2]) + " %"));
    el.innerHTML = parts.join("");
  }
  // "2026-10-15 06:12" blir "15 okt 06:12"
  function shortStamp(s) {
    var m = /^(\d{4})-(\d\d)-(\d\d)(?: (\d\d:\d\d))?/.exec(s || "");
    return m ? parseInt(m[3], 10) + " " + MONTHS[parseInt(m[2], 10) - 1].slice(0, 3) + (m[4] ? " " + m[4] : "") : String(s || "");
  }

  function sparkline(pts) {
    var v = pts.filter(function (x) { return x != null; });
    if (v.length < 2) return "";
    var min = Math.min.apply(null, v), max = Math.max.apply(null, v), span = max - min || 1;
    var W = 200, H = 44, step = W / (pts.length - 1);
    var xy = pts.map(function (p, i) { return [i * step, H - 3 - (p - min) / span * (H - 6)]; });
    var line = xy.map(function (p, i) { return (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1); }).join("");
    return '<svg class="spark" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<path class="spark-area" d="' + line + "L" + W + " " + H + "L0 " + H + 'Z"/>' +
      '<path vector-effect="non-scaling-stroke" d="' + line + '"/></svg>';
  }

  function signalModules() {
    var f = state.front;
    if (f === false) return "";
    var mod = function (title, href, linkText, desc, inner) {
      return '<section class="module"><div class="module-head"><h2>' + title + '</h2><a href="' + href + '">' + linkText + "</a></div>" +
        (desc ? '<p class="desc">' + desc + "</p>" : "") + inner + "</section>";
    };
    if (!f) {
      var sk = '<section class="module"><div class="sk sk-line w40"></div><div class="sk sk-line w90" style="margin-top:12px"></div><div class="sk sk-line w70" style="margin-top:10px"></div><div class="sk sk-line w90" style="margin-top:10px"></div></section>';
      return '<div class="modules section-gap" aria-busy="true">' + sk + sk + sk + sk + "</div>";
    }
    var se = quarterData().se;
    var href = function (isin) { return se && se.byIsin[isin] ? "#/aktie/" + isin : null; };
    var name = function (n, isin, sub) {
      var h = href(isin);
      return '<span class="mod-n">' + (h ? '<a href="' + h + '">' + esc(shortCo(n)) + "</a>" : esc(shortCo(n))) + (sub ? '<span class="mod-s">' + sub + "</span>" : "") + "</span>";
    };
    var out = [];
    if (f.insider) {
      var ins = f.insider, seen = {};
      // Ett bolag en gång, med sitt största köp
      var insTop = ins.top.filter(function (r) { var k = r[1] || r[0]; if (seen[k]) return false; seen[k] = 1; return true; });
      out.push(mod("Insynshandel", "#/insyn", "Alla affärer",
        "Insiders köpte för <b>" + bigSek(ins.buy30) + "</b>" + (ins.close30 ? closeNote(ins.buy30, ins.close30[0]) : "") + " och sålde för " + bigSek(ins.sell30) +
          (ins.close30 ? closeNote(ins.sell30, ins.close30[1]) : "") + " de senaste 30 dagarna.",
        insTop.length ? '<ul class="mod-list">' + insTop.slice(0, 4).map(function (r) {
          return "<li>" + name(r[0], r[1], (r[6] ? "Närstående till " : "") + esc(personName(r[2])) + (r[3] ? " · " + esc(r[3]) : "")) + '<span class="mod-v pos">' + bigSek(r[4]) + "</span></li>";
        }).join("") + "</ul>" : '<p class="desc">Inga större köp de senaste två veckorna.</p>'));
    }
    if (f.shorts && f.shorts.length) {
      out.push(mod("Mest blankade", "#/blankning", "All blankning",
        "Andel av aktierna som är lånade och sålda (blankade), enligt Finansinspektionen.",
        '<ul class="mod-list">' + f.shorts.slice(0, 5).map(function (r) {
          return "<li>" + name(r[0], r[1]) + '<span class="mod-v short-pct">' + nf1.format(r[2]) + " %</span></li>";
        }).join("") + "</ul>"));
    }
    if (f.rates && f.rates.length) {
      var byId = {};
      f.rates.forEach(function (r) { byId[r[0]] = r; });
      var policy = byId.SECBREPOEFF, ten = byId.SEGVB10YC;
      out.push(mod("Räntor", "#/rantor", "Räntor och obligationer", "",
        (policy ? '<div class="mod-big"><b>' + ratePct(policy[2]) + '</b></div><p class="desc">Riksbankens styrränta' +
          (policy[4] != null ? ", " + ratePp(policy[4]) + " på ett år" : "") + "." +
          (policyNext(f.next, policy[2]) ? " <b>Den " + policyNextText(f.next, policy[2]) + ".</b>" : "") + "</p>" : "") +
        (ten ? '<p class="desc">Statsobligation 10 år, senaste året</p>' + sparkline(ten[5]) : "") +
        '<div class="mod-rates">' + f.rates.filter(function (r) { return r !== policy; }).map(function (r) {
          return "<span>" + (RATE_SHORT[r[0]] || esc(r[1])) + "</span><b>" + ratePct(r[2]) + "</b>";
        }).join("") + "</div>"));
    }
    return out.length ? '<div class="modules section-gap">' + out.join("") + "</div>" : "";
  }

  // ---------- Rapportveckan på startsidan (data/bolag/_week.json, scripts/build-companies.py) ----------

  function needWeek() {
    return need("week", function () {
      return getJSON("data/bolag/_week.json").then(function (d) { state.week = d; }, function () { state.week = false; });
    });
  }
  function reportWeek() {
    if (!needWeek() || !state.week) return "";
    var se = quarterData().se;
    if (!se) return "";
    // det aktieslag som fonderna äger mest av, och bolagets värde i fonderna (för urvalet)
    var pick = function (isins) {
      var best = null;
      isins.forEach(function (i) { var s = se.byIsin[i]; if (s && (!best || (s.val2 || 0) > (best.val2 || 0))) best = s; });
      return best;
    };
    var top = function (rows, n) {
      return rows.map(function (r) { return { r: r, s: pick(r[0]) }; }).filter(function (x) { return x.s; })
        .sort(function (a, b) { return (b.s.val2 || 0) - (a.s.val2 || 0); }).slice(0, n);
    };
    var today = new Date().toISOString().slice(0, 10);
    var recent = top(state.week.recent || [], 8).sort(function (a, b) { return a.r[1] < b.r[1] ? 1 : a.r[1] > b.r[1] ? -1 : 0; });
    var done = {};
    recent.forEach(function (x) { done[x.s.isin] = x.r[1]; });
    var next = top((state.week.next || []).filter(function (r) { return r[1] >= today; }), 8)
      .filter(function (x) { return !(done[x.s.isin] && done[x.s.isin] >= x.r[1]); })
      .sort(function (a, b) { return a.r[1] < b.r[1] ? -1 : a.r[1] > b.r[1] ? 1 : 0; });
    if (!recent.length && !next.length) return "";
    var day = function (d) { return d === today ? "i dag" : shortStamp(d); };
    var nameCell = function (s, sub) {
      return '<span class="mod-n"><a href="#/aktie/' + s.isin + '">' + esc(shortCo(s.name)) + '</a><span class="mod-s">' + sub + "</span></span>";
    };
    var recentHtml = recent.map(function (x) {
      var r = x.r, rev = r[4], ebit = r[5], v = "", what = "";
      if (!r[7] && rev && rev[0] > 0 && rev[1] > 0) {
        var g = rev[0] / rev[1] - 1;
        v = '<span class="mod-v ' + cls(g) + '">' + pct(g) + "</span>";
        what = "försäljningen";
      } else if (!r[7] && ebit && ebit[0] != null && ebit[1] != null) {
        v = '<span class="mod-v ' + cls(ebit[0] - ebit[1]) + '">' + (ebit[0] >= ebit[1] ? "Bättre" : "Sämre") + "</span>";
        what = "rörelseresultatet";
      } else if (r[8] != null) {
        v = '<span class="mod-v ' + cls(r[8]) + '">' + pct(r[8] / 100, 1) + "</span>";
        what = "aktien på rapportdagen";
      }
      var per = r[2] ? periodText(r[2], 3) : "";
      return "<li>" + nameCell(x.s, day(r[1]) + (per ? " · " + per : "") + (what ? " · " + what : "")) + (v || '<span class="mod-v muted">–</span>') + "</li>";
    }).join("");
    var nextHtml = next.map(function (x) {
      var r = x.r;
      return "<li>" + nameCell(x.s, esc(String(r[2]).replace(/\s+\d{4}(-Q\d)?$/, "").toLowerCase())) + '<span class="mod-v rw-date">' + day(r[1]) + "</span></li>";
    }).join("");
    return '<section class="block section-gap rw"><div class="block-head"><h2>Rapporter</h2></div>' +
      '<p class="desc">Kvartalsrapporter från de bolag som fonderna äger mest av, med siffrorna ur bolagens egna rapporter. Förändringen jämförs med samma kvartal året innan.</p>' +
      '<div class="rw-grid">' +
      '<div><h3 class="rw-h">Senaste tio dagarna</h3>' + (recentHtml ? '<ul class="mod-list">' + recentHtml + "</ul>" : '<p class="desc">Inga rapporter de senaste tio dagarna.</p>') + "</div>" +
      '<div><h3 class="rw-h">Kommande två veckor</h3>' + (nextHtml ? '<ul class="mod-list">' + nextHtml + "</ul>" : '<p class="desc">Inga rapporter de kommande två veckorna.</p>') + "</div>" +
      "</div></section>";
  }

  function highlight(label, name, href, value, note) {
    return '<div class="hl"><div class="hl-label">' + label + "</div>" +
      (!name ? '<div class="hl-name muted">–</div>' : href ? '<a class="hl-name" href="' + href + '">' + esc(name) + "</a>" : '<div class="hl-name">' + esc(name) + "</div>") +
      '<div class="hl-value">' + value + "</div>" + (note ? '<div class="hl-note">' + note + "</div>" : "") + "</div>";
  }

  // ---------- Aktier ----------

  var stockFilter = { q: "", sector: "", min: "100" };

  function viewStocks() {
    document.title = (state.market === "world" ? "Globala aktier" : "Svenska aktier") + " som fonderna äger – Fondinsyn";
    var ds = marketDs();
    if (!ds) return failed("world-" + state.q) ? errorBlock() : loadingBlock("Laddar globala aktier…");
    var sectors = {};
    ds.stocks.forEach(function (s) { if (s.f2 || s.f1b) sectors[s.sector] = 1; });
    var sectorOpts = Object.keys(sectors).sort(function (a, b) { return a.localeCompare(b, "sv"); }).map(function (x) {
      return '<option value="' + esc(x) + '"' + (stockFilter.sector === x ? " selected" : "") + ">" + esc(x) + "</option>";
    }).join("");
    var minOpts = [["0", "Alla storlekar"], ["10", "Över 10 mkr"], ["100", "Över 100 mkr"], ["1000", "Över 1 000 mkr"]].map(function (o) {
      return '<option value="' + o[0] + '"' + (stockFilter.min === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
    }).join("");
    return '<div class="page-head"><h1>' + (state.market === "se" ? "Svenska aktier" : "Globala aktier") + '</h1><p class="meta">Aktier som ägs av svenska fonder, ' +
      quarterLabel(state.q) + " jämfört med " + quarterLabel(quarterData().meta.prevId) + ".</p></div>" +
      '<div class="toolbar">' +
      '<input class="input" type="search" id="stockSearch" aria-label="Filtrera aktierna" placeholder="Sök aktie eller ISIN" value="' + esc(stockFilter.q) + '" autocomplete="off">' +
      '<select class="select-sm" id="stockSector" aria-label="Sektor"><option value="">Alla sektorer</option>' + sectorOpts + "</select>" +
      '<select class="select-sm" id="stockMin" aria-label="Minsta fondinnehav" title="Fondernas sammanlagda innehav i aktien">' + minOpts + "</select>" +
      '<span class="count" id="stockCount"></span></div>' +
      '<div id="stockTable"></div>';
  }

  function renderStockTable() {
    var ds = marketDs();
    if (!ds || !$("stockTable")) return;
    var q = stockFilter.q.trim().toLowerCase(), min = +stockFilter.min * 1e6;
    var rows = ds.stocks.filter(function (s) {
      if (!s.f2 && !s.f1b) return false;
      if (Math.max(s.val2, s.val1) < min) return false;
      if (stockFilter.sector && s.sector !== stockFilter.sector) return false;
      return !q || s.name.toLowerCase().indexOf(q) >= 0 || s.isin.toLowerCase().indexOf(q) >= 0;
    });
    var world = state.market === "world";
    var nameWithSub = stockCol(function (s) { return (world && s.country ? esc(countryName(s.country)) + " · " : "") + esc(s.sector) + " · " + int(s.f2) + " fonder · " + mkr(s.val2) + " mkr"; });
    // Fondernas ägarandel finns för svenska bolag på Nasdaq Stockholm och First North
    var ownCol = !world && needShares() ? [{ key: "own", label: "Ägarandel", hideSm: true, cell: function (s) { return ownText(ownShare(s)); }, value: function (s) { return ownShare(s); } }] : [];
    var cols = [nameWithSub].concat(world ? [col.country] : [], [col.sector, col.funds, col.dFunds, col.value], ownCol, [col.flow, col.chg]);
    $("stockTable").innerHTML = table("stocks-" + state.market, cols, rows, { csv: true, sort: { col: "flow", dir: -1 }, limit: 50, expand: true, empty: "Inga aktier matchar filtret." });
    $("stockCount").textContent = int(rows.length) + " aktier";
  }

  // ---------- Aktie ----------

  function viewStock(isin) {
    var d = quarterData();
    var s = d.se.byIsin[isin];
    if (!s) {
      if (!needWorld()) return failed("world-" + state.q) ? errorBlock() : loadingBlock();
      s = d.world.byIsin[isin];
    }
    var hasHist = needStockHistory(isin);
    var hs = hasHist ? histFor(isin) : null;
    if (!s && !hs) return notFound("Aktien finns inte i " + quarterLabel(state.q) + ".");
    var name = s ? s.name : hs.name;
    document.title = name + " – Fondinsyn";
    var world = isin.slice(0, 2) !== "SE";
    var crumbs = '<div class="crumbs"><a href="#/aktier" data-market="' + (world ? "world" : "se") + '">' + (world ? "Globala aktier" : "Aktier") + "</a> / " + esc(name) + "</div>";
    var metaParts = [];
    if (s ? s.sector : hs.sector) metaParts.push(esc(s ? s.sector : hs.sector));
    if (world) metaParts.push(esc(countryName(s ? s.country : hs.country)));
    metaParts.push(esc(isin));
    // Kursen kommer ur fondernas kvartalsrapporter och gäller kvartalsslutet, inte i dag. Dagens kurs finns hos Nasdaq.
    if (s && s.price) metaParts.push("Kurs vid kvartalsslutet " + dateText(d.meta.curr) + ": " + nf1.format(s.price) + " kr");
    var nq = needShares() && nasdaqUrl(isin);
    if (nq) metaParts.push('<a href="' + nq + '" target="_blank" rel="noopener">Dagens kurs hos Nasdaq ↗</a>');
    if (s && s.split) metaParts.push("Splitjusterad ×" + nf1.format(s.split));

    var html = '<div class="page-head">' + crumbs + '<div class="title-row"><div class="title-main">' + avatar(name) + '<h1>' + esc(name) + '</h1></div><div class="actions">' + starBtn("stocks", isin) + shareBtn("aktie", isin) + '</div></div><p class="meta">' + metaParts.join(" · ") + "</p></div>";
    html += alertForm(isin, name);

    if (s) {
      html += '<dl class="figures">' +
        fig("Fonder som äger", int(s.f2)) + fig("Fondernas innehav", s.price ? bigSek(s.val2) : "–", s.price ? "" : "kurs saknas") +
        fig("Nettoköp " + quarterLabel(state.q), s.netFlow == null || !s.price ? "–" : '<span class="' + cls(s.flow) + '">' + bigSek(s.flow, true) + "</span>") +
        fig("Δ antal aktier", '<span class="' + cls(s.chg) + '">' + pct(s.chg, true) + "</span>") +
        fig("Nya fonder", int(s.nNew)) + fig("Avvecklat", int(s.nExit)) +
        (!world && needShares() && ownShare(s) != null ? fig('<a href="#/agarandel">Fondernas ägarandel</a>', ownText(ownShare(s)),
          s.isNew ? "" : (function (d) { return (d >= 0 ? "+" : "−") + nf1.format(Math.abs(d) * 100) + " p.e. sedan " + quarterLabel(quarterData().meta.prevId); })(ownShare(s) - ownShare(s, true))) : "") + "</dl>";
      if (s.isNew) html += '<p class="notice">Ingen fond ägde aktien förra kvartalet. Det beror oftast på en notering, avknoppning eller ett nytt aktieslag, så innehaven räknas inte som köp i översikten.</p>';
      if (s.isGone) html += '<p class="notice">Ingen fond äger aktien längre. Det beror oftast på uppköp, avnotering eller byte av aktieslag.</p>';
    }

    // Uppköpserbjudanden på bolaget
    if (needOffers()) {
      offersFor(isin).forEach(function (o) {
        html += '<div class="notice offer-notice"><b>Uppköpserbjudande ' + o.date + "</b> från " + esc(o.bidder) +
          (o.price != null ? ", " + offerPriceText(o) + " per aktie" : "") + (o.premium != null ? " (premie " + nf1.format(o.premium) + " %)" : "") +
          '. <a href="#/uppkop/' + encodeURIComponent(o.id) + '">Se vilka fonder som ägde bolaget</a></div>';
      });
      if (needBids()) newBids(isin).forEach(function (b) {
        html += '<div class="notice offer-notice"><b>Nytt uppköpserbjudande ' + b.date + "</b>" + (b.bidder ? " från " + esc(b.bidder) : "") +
          (b.price != null ? ", " + bidPriceText(b) + " per aktie" : "") + (b.premium != null ? " (premie " + nf1.format(b.premium) + " %)" : "") +
          (b.rec === "ja" ? ". Styrelsen rekommenderar budet" : b.rec === "nej" ? ". Styrelsen avråder från budet" : "") +
          '. <a href="' + esc(b.url) + '" target="_blank" rel="noopener">Pressmeddelandet ↗</a></div>';
      });
    }

    html += companySection(isin, name, s ? s.sector : hs.sector);

    html += '<section class="block section-gap"><div class="block-head"><h2>Historik</h2>';
    if (!hasHist) {
      html += "</div>" + (failed("history-" + histPart(isin)) ? errorBlock() : loadingBlock("Laddar historik…")) + "</section>";
    } else if (!hs) {
      html += '</div><p class="desc">Det finns ingen historik för den här aktien. Små innehav tas inte med.</p></section>';
    } else {
      var h = state.history, qi = h.qIndex[state.q];
      var st = qi != null ? streak(hs, qi) : { n: 0 };
      if (st.n >= 2) html += '<span class="pill ' + (st.sign > 0 ? "pos" : "neg") + '">' + (st.sign > 0 ? "Nettoköpt " : "Nettosålt ") + st.n + " kvartal i rad</span>";
      html += "</div>";
      var pts = h.quarters.map(function (q, i) {
        var r = hs.byQ[i];
        return { q: q, value: r ? flowOf(r) : null, funds: r ? r[1] : null, val: r ? r[2] : null, highlight: q === state.q };
      });
      var flowPts = pts.slice(1);
      html += '<div class="grid-2 charts">' +
        '<div class="chart-card"><div class="chart-title">Nettoköp per kvartal <span>mkr' + (state.excludeIndex ? ", utan indexfonder" : "") + "</span></div>" +
        chart(function (node) {
          FFCharts.columns(node, flowPts, { tip: function (p) {
            return "<b>" + quarterLabel(p.q) + "</b>" + (p.value == null ? '<div class="muted">Ingen data</div>' : tipRow(p.value >= 0 ? "c-pos" : "c-neg", p.value >= 0 ? "Köpt netto" : "Sålt netto", msek(p.value, true) + " mkr", true));
          } });
        }) + "</div>" +
        '<div class="chart-card"><div class="chart-title">Antal fonder som äger</div>' +
        chart(function (node) {
          FFCharts.line(node, pts.map(function (p) { return { q: p.q, value: p.funds, val: p.val }; }), {
            format: function (v) { return int(v); },
            tip: function (p) { return "<b>" + quarterLabel(p.q) + "</b>" + (p.value == null ? '<div class="muted">Inga fonder</div>' : tipRow("s1", "Fonder som äger", int(p.value)) + tipRow("", "Innehav", msek(p.val) + " mkr")); }
          });
        }) + "</div></div>";
      html += "</section>";
    }

    html += stockShortSection(isin);
    html += stockInsiderSection(isin);
    if (!world) html += embedBox(isin, name);

    if (s) {
      var trades = s.trades;
      var unchanged = s.f2b - trades.filter(function (t) { return t.s2; }).length;
      var cols = [
        { key: "fund", label: "Fond", align: "l", cls: "name", cell: function (t) { return nameCell(fundHref(t.f), t.f.name, changeLabel(t.s1, t.s2) + " " + esc(t.f.co)); }, value: function (t) { return t.f.name; } },
        { key: "co", label: "Fondbolag", align: "l", cls: "muted", hideSm: true, cell: function (t) { return esc(t.f.co); }, value: function (t) { return t.f.co; } },
        { key: "chg", label: "Ändring", align: "l", hideSm: true, cell: function (t) { return changeLabel(t.s1, t.s2); } },
        { key: "s1", label: "Antal " + quarterLabel(d.meta.prevId), hideSm: true, cell: function (t) { return int(t.s1); }, value: function (t) { return t.s1; } },
        { key: "s2", label: "Antal " + quarterLabel(state.q), hideSm: true, cell: function (t) { return int(t.s2); }, value: function (t) { return t.s2; } },
        { key: "d", label: "Förändring (mkr)", cell: function (t) { return '<span class="' + cls(t.d) + '">' + mkr(t.d, true) + "</span>"; }, value: function (t) { return t.d; } },
        { key: "w", label: "Andel av fond", cell: function (t) { return t.f.aum2 ? nf1.format(t.s2 * s.price / t.f.aum2 * 100) + " %" : "–"; }, value: function (t) { return t.f.aum2 ? t.s2 * s.price / t.f.aum2 : null; } }
      ];
      html += '<section class="block section-gap"><div class="block-head"><h2>Fondernas affärer ' + quarterLabel(state.q) + '</h2><span class="note">' + trades.length + " fonder har ändrat innehavet" +
        (unchanged > 0 ? ", " + unchanged + " oförändrade" : "") + "</span></div>" +
        table("stock-trades", cols, trades, { sort: { col: "d", dir: -1 }, empty: "Ingen fond ändrade sitt innehav." }) + "</section>";
    }
    return html;
  }

  // ---------- Lär känna bolaget ----------
  // Bara bolagets egna rapporter: senaste kvartalsrapporten (via MFN), årsredovisningen (ESEF) med affärsområden och
  // marknader, bolagets egen beskrivning och MFN:s kalender. Byggs av scripts/build-companies.py till data/bolag/<ISIN>.json.

  function needCompanyIndex() {
    return need("bolag-index", function () {
      return getJSON("data/bolag/_index.json").then(function (d) {
        state.companyIndex = {};
        (d.isins || []).forEach(function (i) { state.companyIndex[i] = true; });
      });
    });
  }
  function needCompany(isin) {
    return need("bolag-" + isin, function () {
      return getJSON("data/bolag/" + isin + ".json").then(function (d) { (state.companies = state.companies || {})[isin] = d; });
    });
  }
  // "Volvo AB SER. B" blir "Volvo", "Acrinova AB-B" blir "Acrinova"
  function companyShort(name) {
    return String(name || "").replace(/\s*\(publ\)/i, "").replace(/[\s-]+(ser\.?|series|class)?\s*[A-D]$/i, "")
      .replace(/\s+(AB|ASA|Oyj|AS|plc|SDB)$/i, "").replace(/^AB\s+/i, "").trim();
  }
  // Belopp i bolagets valuta (de flesta redovisar i kronor)
  function money(v, cur) {
    if (!cur || cur === "SEK") return bigSek(v);
    if (v == null || !isFinite(v)) return "–";
    var a = Math.abs(v), unit = { EUR: "euro", USD: "dollar", NOK: "norska kronor", DKK: "danska kronor" }[cur] || cur;
    return fixMinus(a >= 1e9 ? nf1.format(v / 1e9) + " md " : a >= 1e6 ? nf0.format(v / 1e6) + " mn " : nf0.format(v) + " ") + unit;
  }
  function smallMoney(v, cur) {
    var unit = !cur || cur === "SEK" ? "kr" : ({ EUR: "euro", USD: "dollar" }[cur] || cur);
    return fixMinus(nf0.format(v)) + " " + unit;
  }
  function perShare(v, cur) {
    var unit = !cur || cur === "SEK" ? "kr" : ({ EUR: "euro", USD: "dollar" }[cur] || cur);
    return fixMinus(nf2.format(v)) + " " + unit;
  }
  // Valutan i löptext: "av varje 100 kronor" eller "av varje 100 dollar"
  function curWord(cur) { return ({ USD: "dollar", EUR: "euro" })[cur] || "kronor"; }
  // Räkenskapsåret: "2025", eller "2025/26" för amerikanska bolag vars år inte följer kalenderåret (Microsoft, Apple, Nvidia)
  function fyName(r, back) {
    var y = r.fy - (back || 0);
    return r.fyl && r.fyl.indexOf("/") > 0 ? (y - 1) + "/" + String(y).slice(2) : String(y);
  }
  function fyText(r, back) { return (r.fyl && r.fyl.indexOf("/") > 0 ? "räkenskapsåret " : "helåret ") + fyName(r, back); }
  // Andelar som en nybörjare säger dem: "ungefär hälften", "en fjärdedel"
  function shareWords(v) {
    var words = [[0.25, "en fjärdedel"], [1 / 3, "en tredjedel"], [0.5, "hälften"], [2 / 3, "två tredjedelar"], [0.75, "tre fjärdedelar"]];
    for (var i = 0; i < words.length; i++) {
      if (Math.abs(v - words[i][0]) < 0.02) return "ungefär " + words[i][1];
    }
    return nf0.format(v * 100) + " %";
  }
  var MON = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
  // Perioden som slutar "2026-09" och är 3 månader lång: "jul–sep 2026"
  function periodText(p, months) {
    var y = +p.slice(0, 4), m = +p.slice(5, 7), start = ((m - (months || 3)) % 12 + 12) % 12;
    return MON[start] + "–" + MON[m - 1] + " " + y;
  }
  // Kort etikett under en stapel: "Q3" för vanliga kvartal, annars slutmånaden ("aug" för H&M)
  function periodShort(p) {
    var m = +p.slice(5, 7);
    return (m % 3 === 0 ? "Q" + m / 3 : MON[m - 1]) + "<br>" + p.slice(0, 4);
  }
  function capFirst(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); }
  function change(now, before) {
    return now != null && before != null && before > 0 ? now / before - 1 : null;
  }

  // Staplar per kvartal (försäljning eller resultat). Förluster går under nollinjen.
  function quarterBars(series, idx, title, cur) {
    var pts = series.filter(function (x) { return x[idx] != null; });
    if (pts.length < 4) return "";
    var max = Math.max.apply(null, pts.map(function (x) { return Math.max(0, x[idx]); }));
    var min = Math.min.apply(null, pts.map(function (x) { return Math.min(0, x[idx]); }));
    var span = max - min || 1, zero = max / span * 100;
    var last = pts[pts.length - 1];
    return '<div class="qb-chart"><div class="qb-title">' + title + '<span class="qb-now">' + periodText(last[0], 3).replace(/ \d{4}$/, "") + ": <b>" + money(last[idx], cur) + "</b></span></div>" +
      '<div class="qb-plot" role="img" aria-label="' + esc(title + " per kvartal") + '">' + pts.map(function (x) {
        var v = x[idx], h = Math.abs(v) / span * 100, label = periodText(x[0], 3) + ": " + money(v, cur);
        return '<div class="qb-col" title="' + esc(label) + '"><div class="qb-area"><span class="qb-bar' + (v < 0 ? " neg" : "") + (x === last ? " now" : "") +
          '" style="height:' + Math.max(h, 0.8).toFixed(1) + "%;" + (v < 0 ? "top:" + zero.toFixed(1) + "%" : "bottom:" + (100 - zero).toFixed(1) + "%") + '"></span></div>' +
          '<div class="qb-lbl">' + periodShort(x[0]) + "</div></div>";
      }).join("") + "</div></div>";
  }

  // Bolagets rubrik på rapporten, men inte nyckeltalsrader ("Orderingång 36 948 Mkr (30 769)"), bolagsnamn eller "Sammanfattning"
  function headlineText(h) {
    if (!h || (h.match(/\d+/g) || []).length >= 2 || /\b(AB|ASA|Oyj|plc|publ|Group|Holding)\b|^sammanfattning/i.test(h)) return null;
    return h === h.toUpperCase() ? h.charAt(0) + h.slice(1).toLowerCase() : h;
  }

  // Rapporten på 30 sekunder: det bästa, det sämsta och något att hålla koll på, räknat ur rapportens siffror
  function quickTake(c, q, finance, short) {
    var good = [], bad = [], cur = q.cur;
    var add = function (list, w, text) { list.push({ w: w, t: text }); };
    var rev = !finance && q.rev ? q.rev : null;
    var g = rev ? change(rev[0], rev[1]) : null;
    if (g != null && g >= 0.03) add(good, g, "Försäljningen växte med " + nf0.format(g * 100) + " % jämfört med samma period i fjol" + (q.organic != null && q.organic > 0 ? ", varav " + nf0.format(q.organic) + " % utan förvärv och valuta." : "."));
    if (g != null && g <= -0.03) add(bad, -g, "Försäljningen minskade med " + nf0.format(-g * 100) + " % jämfört med samma period i fjol.");
    if (rev && rev[0] > 0 && rev[1] > 0 && q.ebit && q.ebit[0] != null && q.ebit[1] != null) {
      var m0 = q.ebit[0] / rev[0], m1 = q.ebit[1] / rev[1], md = m0 - m1;
      var cw = curWord(cur);
      if (md >= 0.01) add(good, md * 4, "Lönsamheten blev bättre: av varje 100 " + cw + " blev " + nf0.format(m0 * 100) + " " + cw + " rörelsevinst, mot " + nf0.format(Math.max(0, m1) * 100) + " ett år tidigare.");
      if (md <= -0.01) add(bad, -md * 4, "Lönsamheten blev sämre: av varje 100 " + cw + " blev " + nf0.format(Math.max(0, m0) * 100) + " " + cw + " rörelsevinst, mot " + nf0.format(m1 * 100) + " ett år tidigare.");
      if (q.ebit[0] < 0) add(bad, 1, "Verksamheten gick med förlust: rörelseresultatet blev " + money(q.ebit[0], cur) + ".");
    }
    var res = q.ebit && q.ebit[0] != null && q.ebit[1] > 0 ? q.ebit : q.net && q.net[0] != null && q.net[1] > 0 ? q.net : null;
    if (res) {
      var rg = res[0] / res[1] - 1, what = res === q.ebit ? "Rörelseresultatet" : "Vinsten";
      if (rg >= 0.1) add(good, Math.min(rg, 2) * 0.8, what + " ökade med " + nf0.format(rg * 100) + " % till " + money(res[0], cur) + ".");
      if (rg <= -0.1) add(bad, Math.min(-rg, 2) * 0.8, what + " minskade med " + nf0.format(-rg * 100) + " % till " + money(res[0], cur) + ".");
    }
    var ord = q.orders && q.orders["in"];
    if (ord && rev && rev[0] > 0) {
      var bb = ord[0] / rev[0], og = ord[1] ? ord[0] / ord[1] - 1 : null;
      if (bb >= 1.05 || (og != null && og >= 0.1)) add(good, Math.max(bb - 1, og || 0) + 0.05, "Nya order för " + money(ord[0], cur) + (og != null ? " (" + pct(og) + ")" : "") + (bb >= 1.05 ? ", mer än bolaget levererade. Det talar för fortsatt växande försäljning." : "."));
      if (bb <= 0.95 || (og != null && og <= -0.1)) add(bad, Math.max(1 - bb, -(og || 0)) + 0.05, "Färre nya order: " + money(ord[0], cur) + (og != null ? " (" + pct(og) + ")" : "") + (bb <= 0.95 ? ", mindre än bolaget levererade." : "."));
    }
    if (q.cash && q.cash[0] != null) {
      if (q.cash[0] < 0) add(bad, 0.3, "Verksamheten drog inte in pengar i kvartalet: kassaflödet var " + money(q.cash[0], cur) + ".");
      else if (q.cash[1] != null && q.cash[0] > q.cash[1] * 1.2 && q.cash[1] > 0) add(good, 0.25, "Starkt kassaflöde: verksamheten drog in " + money(q.cash[0], cur) + ", mer än ett år tidigare.");
    }
    if (q.react != null && Math.abs(q.react) >= 2) {
      if (q.react > 0) add(good, q.react / 25, "Börsen gillade rapporten: aktien steg " + nf1.format(q.react) + " % samma dag.");
      else add(bad, -q.react / 25, "Börsen var besviken: aktien föll " + nf1.format(-q.react) + " % samma dag.");
    }
    // Det senaste året (fyra kvartal) mot året innan, om åtta kvartal i följd finns
    var qs = c.qs || [];
    if (rev && qs.length >= 8) {
      var mi = function (p) { return +p.slice(0, 4) * 12 + +p.slice(5, 7); }, last8 = qs.slice(-8), ok = true;
      for (var i = 1; i < 8; i++) if (mi(last8[i][0]) - mi(last8[i - 1][0]) !== 3 || last8[i][1] == null) ok = false;
      if (ok && last8[0][1] != null) {
        var s1 = 0, s0 = 0;
        for (i = 0; i < 4; i++) { s0 += last8[i][1]; s1 += last8[i + 4][1]; }
        var yg = s1 / s0 - 1;
        if (yg >= 0.05) add(good, yg * 0.6, "Det senaste året sålde " + esc(short) + " för " + money(s1, cur) + ", " + nf0.format(yg * 100) + " % mer än året innan.");
        if (yg <= -0.02) add(bad, -yg * 0.6 + 0.02, "Det senaste året sålde " + esc(short) + " för " + money(s1, cur) + ", " + nf0.format(-yg * 100) + " % mindre än året innan.");
      }
    }
    var bk = q.bank || {};
    if (bk.roe != null && bk.roe >= 12) add(good, 0.2, "Hög avkastning på eget kapital: " + nf1.format(bk.roe) + " % per år.");
    if (bk.ci != null && bk.ci >= 0.6) add(bad, 0.2, "Höga kostnader: banken har " + nf0.format(bk.ci * 100) + " öre i kostnader per intjänad krona.");
    // Något att hålla koll på: bolagets egen syn framåt, det rapporten pratar mest om, eller nästa rapport
    var watch = null;
    if (q.outlook) watch = "Bolaget om framtiden: " + ((q.outlook.match(/^[\s\S]*?[.!?](?=\s|$)/) || [q.outlook])[0]);
    else if (q.events && q.events.length) watch = "Viktigt i kvartalet: " + q.events[0] + ".";
    else if (q.themes && q.themes.length && q.themes[0][1] >= 8) {
      var tn = q.themes[0][0], tl = /^(AI|USA|Kina)$/.test(tn) ? tn : tn.toLowerCase();
      watch = "Rapporten tar ofta upp " + tl + " (" + q.themes[0][1] + " gånger), värt att följa.";
    }
    if (c.cal && c.cal.next) watch = (watch ? watch + " " : "") + (c.cal.est ? "Nästa rapport väntas omkring " : "Nästa rapport kommer ") + dateText(c.cal.next[0]) + ".";
    var best = good.sort(function (a, b) { return b.w - a.w; })[0], worst = bad.sort(function (a, b) { return b.w - a.w; })[0];
    if (!best && !worst) return "";
    var card = function (cls, icon, title, text) {
      return '<div class="qt ' + cls + '"><div class="qt-head"><span class="qt-ic" aria-hidden="true">' + icon + "</span>" + title + '</div><p>' + text + "</p></div>";
    };
    return '<div class="qt-wrap"><h4 class="kq-sub qt-title">Rapporten på 30 sekunder</h4><div class="qt-grid">' +
      card("pos", "+", "Det bästa", best ? best.t : "Inget som stack ut positivt i siffrorna.") +
      card("neg", "−", "Det sämsta", worst ? worst.t : "Inget tydligt negativt i siffrorna.") +
      (watch ? card("watch", "→", "Håll koll på", esc(watch)) : "") + "</div></div>";
  }

  // Snabbkoll: ja/nej-frågor om rapporten med bock eller kryss
  function scoreCard(items) {
    if (items.length < 2) return "";
    return '<div class="kq-score">' + items.map(function (it) {
      var icon = it.tone === "pos" ? "✓" : it.tone === "neg" ? "✕" : "–";
      return '<div class="ks ' + it.tone + '"><span class="ks-ic" aria-hidden="true">' + icon + '</span><div class="ks-t"><div class="ks-q">' + it.q + '</div><div class="ks-a">' + it.a + "</div></div></div>";
    }).join("") + "</div>";
  }

  // Rörelsemarginalen kvartal för kvartal som en linje
  function marginLine(qs) {
    var pts = qs.filter(function (x) { return x[1] > 0 && x[2] != null && Math.abs(x[2]) <= x[1]; }).map(function (x) { return [x[0], x[2] / x[1]]; });
    if (pts.length < 4) return "";
    var vals = pts.map(function (p) { return p[1]; });
    var lo = Math.min(0, Math.min.apply(null, vals)), hi = Math.max.apply(null, vals);
    var pad = (hi - lo) * 0.15 || 0.02; lo = lo < 0 ? lo - pad : Math.max(0, lo - pad); hi += pad;
    var W = 300, H = 84, x = function (i) { return 8 + i * (W - 16) / (pts.length - 1); }, y = function (v) { return 6 + (hi - v) / (hi - lo) * (H - 12); };
    var path = pts.map(function (p, i) { return (i ? "L" : "M") + x(i).toFixed(1) + " " + y(p[1]).toFixed(1); }).join(" ");
    var last = pts[pts.length - 1];
    return '<div class="qb-chart"><div class="qb-title">Rörelsemarginal<span class="qb-now">' + periodText(last[0], 3).replace(/ \d{4}$/, "") + ": <b>" + nf0.format(last[1] * 100) + " %</b></span></div>" +
      '<div class="ml-wrap"><svg class="ml-svg" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img" aria-label="Rörelsemarginal per kvartal">' +
      (lo < 0 ? '<line class="ml-zero" x1="0" x2="' + W + '" y1="' + y(0).toFixed(1) + '" y2="' + y(0).toFixed(1) + '"></line>' : "") +
      '<path class="ml-area" d="' + path + " L" + x(pts.length - 1).toFixed(1) + " " + H + " L" + x(0).toFixed(1) + " " + H + ' Z"></path>' +
      '<path class="ml-line" d="' + path + '" vector-effect="non-scaling-stroke"></path></svg>' +
      '<div class="ml-dots">' + pts.map(function (p, i) {
        return '<span class="ml-dot' + (i === pts.length - 1 ? " now" : "") + '" style="left:' + (x(i) / W * 100).toFixed(2) + "%;top:" + (y(p[1]) / H * 100).toFixed(2) + '%" title="' + esc(periodText(p[0], 3) + ": " + nf1.format(p[1] * 100) + " %") + '"></span>';
      }).join("") + "</div></div>" +
      '<div class="ml-axis"><span>' + periodShort(pts[0][0]).replace("<br>", " ") + "</span><span>" + periodShort(last[0]).replace("<br>", " ") + "</span></div></div>";
  }

  // Börsens reaktion på rapportdagen, de senaste rapporterna
  function reactCard(reacts, short) {
    var list = reacts.slice().reverse();
    var max = Math.max.apply(null, list.map(function (r) { return Math.abs(r[1]); })) || 1;
    var up = list.filter(function (r) { return r[1] > 0; }).length;
    var lead = "Börsen tog emot " + up + " av de senaste " + list.length + " rapporterna positivt.";
    return '<div class="know-card"><h3>Så tog börsen emot rapporterna</h3><p class="know-lead">' + lead + ' <span class="muted">Hur ' + esc(short) + "-aktien rörde sig den dag rapporten kom.</span></p>" +
      '<div class="rx-plot" role="img" aria-label="Aktiens rörelse på rapportdagarna">' + list.map(function (r) {
        var h = Math.max(3, Math.abs(r[1]) / max * 100), d = r[0].split("-");
        return '<div class="rx-col" title="' + esc(dateText(r[0]) + ": " + (r[1] > 0 ? "+" : "") + nf1.format(r[1]) + " %") + '">' +
          '<div class="rx-up">' + (r[1] > 0 ? '<span class="rx-val pos">+' + nf1.format(r[1]) + '</span><span class="rx-bar pos" style="height:' + h.toFixed(0) + '%"></span>' : "") + "</div>" +
          '<div class="rx-down">' + (r[1] <= 0 ? '<span class="rx-bar neg" style="height:' + h.toFixed(0) + '%"></span><span class="rx-val neg">' + fixMinus(nf1.format(r[1])) + "</span>" : "") + "</div>" +
          '<div class="qb-lbl">' + MON[+d[1] - 1] + "<br>" + d[0] + "</div></div>";
      }).join("") + "</div></div>";
  }

  // Utdelningen år för år (de senaste åtta åren) och hur länge bolaget har delat ut
  function dividendCard(hist, cur, short, fiscal) {
    var thisYear = new Date().getFullYear();
    var rows = hist.filter(function (h) { return h[0] <= thisYear; });
    var last8 = rows.slice(-8);
    if (last8.length < 3) return "";
    var max = Math.max.apply(null, last8.map(function (h) { return h[1] + h[2]; })) || 1;
    var span = rows[rows.length - 1][0] - rows[0][0] + 1, paid = rows.filter(function (h) { return h[1] + h[2] > 0; }).length;
    var streak = 0;
    for (var i = rows.length - 1; i > 0 && rows[i][1] > 0 && rows[i][1] >= rows[i - 1][1] && rows[i][0] - rows[i - 1][0] === 1; i--) streak++;
    var lead = esc(short) + " har delat ut pengar till ägarna " + (paid === span ? "varje år de senaste " + span + " åren" : paid + " av de senaste " + span + " åren") + ".";
    if (streak >= 2) lead += " Den ordinarie utdelningen har höjts eller legat kvar " + streak + " år i rad.";
    return '<div class="know-card"><h3>Utdelningen år för år</h3><p class="know-lead">' + lead + "</p>" +
      '<div class="dv-plot" role="img" aria-label="Utdelning per aktie och år">' + last8.map(function (h) {
        var tot = h[1] + h[2];
        return '<div class="dv-col" title="' + esc(h[0] + ": " + perShare(tot, cur) + (h[2] ? " (varav " + perShare(h[2], cur) + " extra)" : "")) + '">' +
          '<div class="dv-val">' + (tot ? nf2.format(tot).replace(/,00$/, "") : "0") + '</div><div class="dv-area">' +
          (h[2] ? '<span class="dv-bar extra" style="height:' + (h[2] / max * 100).toFixed(1) + '%"></span>' : "") +
          '<span class="dv-bar" style="height:' + (h[1] / max * 100).toFixed(1) + '%"></span></div><div class="qb-lbl">' + h[0] + "</div></div>";
      }).join("") + "</div>" +
      '<div class="fin-legend"><span><i class="fin-eq"></i>Ordinarie</span>' + (last8.some(function (h) { return h[2]; }) ? '<span><i class="dv-extra-i"></i>Extra</span>' : "") +
      '<span class="muted">' + (cur === "SEK" || !cur ? "Kronor" : cur === "USD" ? "Dollar" : cur) + " per aktie" +
      (fiscal ? " och räkenskapsår, beslutad utdelning" : ", inte justerat för eventuella aktiesplittar") + "</span></div></div>";
  }

  // Vad rapporten handlar om, och hur positivt den är skriven
  function themesHtml(themes, tone) {
    var out = "";
    if (themes && themes.length) {
      var max = themes[0][1];
      out += '<div><h4 class="kq-sub">Det här pratar rapporten om</h4><div class="th-chips">' + themes.map(function (t) {
        var w = t[1] / max;
        return '<span class="th-chip' + (w > 0.66 ? " big" : w > 0.33 ? " mid" : "") + '">' + esc(t[0]) + '<b>' + t[1] + "</b></span>";
      }).join("") + '</div><p class="th-note">Siffran är hur många gånger ämnet nämns i rapporten.</p></div>';
    }
    if (tone && tone[0] + tone[1] > 0) {
      var s = tone[0] / (tone[0] + tone[1]);
      var word = s >= 0.75 ? "Mycket positiv" : s >= 0.6 ? "Mest positiv" : s >= 0.45 ? "Blandad" : s >= 0.3 ? "Mest negativ" : "Mycket negativ";
      out += '<div><h4 class="kq-sub">Rapportens ton: ' + word + '</h4><div class="tone-bar" role="img" aria-label="' + nf0.format(s * 100) + ' % positiva ord">' +
        '<span class="tone-pos" style="width:' + (s * 100).toFixed(1) + '%"></span><span class="tone-neg" style="width:' + ((1 - s) * 100).toFixed(1) + '%"></span></div>' +
        '<div class="fin-legend"><span><i class="tone-pos"></i>' + tone[0] + " positiva ord (stark, ökade, rekord …)</span><span><i class=\"tone-neg\"></i>" + tone[1] + " negativa ord (svag, minskade, osäker …)</span></div></div>";
    }
    return out;
  }

  // Insikter ur kvartalen: det senaste året mot året innan, hur ofta bolaget växer, lönsamhet, rekord och säsong
  function quarterInsights(qs, cur, short, finance) {
    var idx = function (p) { return +p.slice(0, 4) * 12 + +p.slice(5, 7); };
    // bara en obruten följd av kvartal, räknat bakifrån
    var run = [qs[qs.length - 1]];
    for (var i = qs.length - 2; i >= 0 && idx(run[0][0]) - idx(qs[i][0]) === 3; i--) run.unshift(qs[i]);
    var out = [];
    var sum = function (list, k) { var s = 0; for (var j = 0; j < list.length; j++) { if (list[j][k] == null) return null; s += list[j][k]; } return s; };
    var last4 = run.slice(-4), prev4 = run.length >= 8 ? run.slice(-8, -4) : null;
    if (!finance && last4.length === 4) {
      var r4 = sum(last4, 1), r4p = prev4 ? sum(prev4, 1) : null, g = change(r4, r4p);
      if (r4 > 0) out.push({ tone: g == null ? "" : cls(g), text: "Det senaste året (fyra kvartal) sålde " + esc(short) + " för " + money(r4, cur) +
        (g != null ? ", " + nf0.format(Math.abs(g) * 100) + " % " + (g >= 0 ? "mer" : "mindre") + " än året innan." : ".") });
      var e4 = sum(last4, 2), e4p = prev4 ? sum(prev4, 2) : null;
      if (r4 > 0 && e4 != null && r4p > 0 && e4p != null && Math.abs(e4) <= r4) {
        var m4 = e4 / r4, m4p = e4p / r4p, d = m4 - m4p;
        if (Math.abs(d) >= 0.01) out.push({ tone: d > 0 ? "pos" : "neg", text: "Lönsamheten har " + (d > 0 ? "blivit bättre" : "blivit sämre") + ": rörelsemarginalen är " +
          nf0.format(m4 * 100) + " % det senaste året mot " + nf0.format(m4p * 100) + " % året innan." });
        else out.push({ tone: "", text: "Lönsamheten är ungefär densamma som året innan: rörelsemarginalen är " + nf0.format(m4 * 100) + " %." });
      }
    }
    if (!finance && run.length >= 8) {
      var up = 0;
      for (var k = run.length - 4; k < run.length; k++) if (run[k][1] != null && run[k - 4][1] != null && run[k][1] > run[k - 4][1]) up++;
      out.push({ tone: up >= 3 ? "pos" : up <= 1 ? "neg" : "", text: "Försäljningen ökade jämfört med samma kvartal året innan i " + ["inget", "ett", "två", "tre", "alla fyra"][up] + " av de senaste fyra kvartalen." });
    }
    var vals = run.map(function (x) { return x[1]; }).filter(function (v) { return v != null; });
    if (!finance && vals.length >= 6 && run[run.length - 1][1] === Math.max.apply(null, vals)) {
      out.push({ tone: "pos", text: "Kvartalet var det största i försäljning på " + (vals.length >= 8 ? "två år" : vals.length + " kvartal") + "." });
    }
    var res = run.map(function (x) { return finance ? x[3] : x[2]; }).filter(function (v) { return v != null; });
    if (res.length >= 6) {
      var plus = res.filter(function (v) { return v > 0; }).length, what = finance ? "vinst" : "rörelsevinst";
      if (plus === res.length) out.push({ tone: "pos", text: "Bolaget har gått med " + what + " i alla " + res.length + " kvartal." });
      else if (plus === 0) out.push({ tone: "neg", text: "Bolaget har gått med förlust i alla " + res.length + " kvartal." });
      else out.push({ tone: "", text: "Bolaget har gått med " + what + " i " + plus + " av de senaste " + res.length + " kvartalen." });
    }
    // Säsong: ett kvartal som år efter år säljer klart mer än de andra. Inte när bolaget växer snabbt (över 25 % på ett år),
    // för då är det senaste kvartalet störst på grund av tillväxten (Nvidia), inte säsongen.
    var yr8 = run.length >= 8 ? change(sum(run.slice(-4), 1), sum(run.slice(-8, -4), 1)) : null;
    if (!finance && run.length >= 8 && !(yr8 > 0.25)) {
      var byQ = {}, n = {};
      run.slice(-8).forEach(function (x) { var m = x[0].slice(5, 7); if (x[1] != null) { byQ[m] = (byQ[m] || 0) + x[1]; n[m] = (n[m] || 0) + 1; } });
      var ms = Object.keys(byQ).filter(function (m) { return n[m] === 2; });
      if (ms.length === 4) {
        var avg = ms.reduce(function (a, m) { return a + byQ[m]; }, 0) / 4;
        var top = ms.sort(function (a, b) { return byQ[b] - byQ[a]; })[0];
        // Med bara två år sägs det bara om samma kvartal var störst båda åren, och utan att påstå att det alltid är så
        var bestOf = function (h) { var b = null; h.forEach(function (x) { if (x[1] != null && (!b || x[1] > b[1])) b = x; }); return b && b[0].slice(5, 7); };
        if (byQ[top] > avg * 1.15 && bestOf(run.slice(-8, -4)) === top && bestOf(run.slice(-4)) === top) out.push({ tone: "",
          text: periodText("2000-" + top, 3).replace(" 2000", "").replace(/^./, function (c) { return c.toUpperCase(); }) + " var bolagets största kvartal båda de senaste två åren, med ungefär " +
          nf0.format((byQ[top] / avg - 1) * 100) + " % mer försäljning än ett genomsnittligt kvartal. Två år räcker inte för att säga att mönstret alltid håller." });
      }
    }
    return out;
  }

  // ---------- Årsredovisningarna år för år: lönsamhet, kassaflöde, utdelning och skulder ----------
  // h = report.hist, kolumner med äldsta året först: { fy: [2021, …], rev: […], ocf: […], capex: […], … }
  function hv(h, k, i) { return h[k] && h[k][i] != null ? h[k][i] : null; }
  function histFcf(h, i) { var o = hv(h, "ocf", i), c = hv(h, "capex", i); return o != null && c != null ? o - c : null; }
  // Avkastning på eget kapital: årets resultat (ägarnas del) i procent av det genomsnittliga egna kapitalet under året
  function histRoe(h, i) {
    if (i < 1) return null;
    var own = hv(h, "netOwn", i) != null && hv(h, "eqOwn", i) != null && hv(h, "eqOwn", i - 1) != null;
    var res = own ? hv(h, "netOwn", i) : hv(h, "net", i);
    var e0 = own ? hv(h, "eqOwn", i - 1) : hv(h, "equity", i - 1), e1 = own ? hv(h, "eqOwn", i) : hv(h, "equity", i);
    return res != null && e0 > 0 && e1 > 0 ? res / ((e0 + e1) / 2) : null;
  }
  function histMargin(h, i) {
    var r = hv(h, "rev", i), e = hv(h, "ebit", i);
    return r > 0 && e != null && Math.abs(e) <= r ? e / r : null;
  }
  function pc(v) { return fixMinus(nf0.format(v * 100)) + " %"; }
  function yearSpan(a, b) { return a === b ? String(a) : a + "–" + b; }
  // Staplar per år, som kvartalsstaplarna. Förluster går under nollinjen.
  function yearBars(years, vals, title, fmt) {
    var pts = years.map(function (y, i) { return [y, vals[i]]; }).filter(function (x) { return x[1] != null; });
    if (pts.length < 2) return "";
    var max = Math.max.apply(null, pts.map(function (x) { return Math.max(0, x[1]); }));
    var min = Math.min.apply(null, pts.map(function (x) { return Math.min(0, x[1]); }));
    var span = max - min || 1, zero = max / span * 100, last = pts[pts.length - 1];
    return '<div class="qb-chart"><div class="qb-title">' + title + '<span class="qb-now">' + last[0] + ": <b>" + fmt(last[1]) + "</b></span></div>" +
      '<div class="qb-plot" role="img" aria-label="' + esc(title + " per år") + '">' + pts.map(function (x) {
        var v = x[1], h = Math.abs(v) / span * 100;
        return '<div class="qb-col" title="' + esc(x[0] + ": " + fmt(v)) + '"><div class="qb-area"><span class="qb-bar' + (v < 0 ? " neg" : "") + (x === last ? " now" : "") +
          '" style="height:' + Math.max(h, 0.8).toFixed(1) + "%;" + (v < 0 ? "top:" + zero.toFixed(1) + "%" : "bottom:" + (100 - zero).toFixed(1) + "%") + '"></span></div>' +
          '<div class="qb-lbl">' + x[0] + "</div></div>";
      }).join("") + "</div></div>";
  }
  // Två staplar per år: fritt kassaflöde och utbetald utdelning
  function pairBars(years, a, b, label, cur) {
    var idx = years.map(function (y, i) { return i; }).filter(function (i) { return a[i] != null && b[i] != null; });
    if (!idx.length) return "";
    var all = [];
    idx.forEach(function (i) { all.push(a[i], b[i]); });
    var max = Math.max(0, Math.max.apply(null, all)), min = Math.min(0, Math.min.apply(null, all));
    var span = max - min || 1, zero = max / span * 100;
    var bar = function (v, k) {
      var h = Math.max(Math.abs(v) / span * 100, 0.8);
      return '<span class="pb-bar ' + k + (v < 0 ? " neg" : "") + '" style="height:' + h.toFixed(1) + "%;" + (v < 0 ? "top:" + zero.toFixed(1) + "%" : "bottom:" + (100 - zero).toFixed(1) + "%") + '"></span>';
    };
    return '<div class="qb-plot pb-plot" role="img" aria-label="' + esc(label) + '">' + idx.map(function (i) {
      return '<div class="qb-col" title="' + esc(years[i] + ": fritt kassaflöde " + money(a[i], cur) + ", utdelning " + money(b[i], cur)) + '"><div class="qb-area">' +
        bar(a[i], "a") + bar(b[i], "b") + '</div><div class="qb-lbl">' + years[i] + "</div></div>";
    }).join("") + "</div>" +
      '<div class="fin-legend"><span><i class="pb-a-i"></i>Fritt kassaflöde</span><span><i class="pb-b-i"></i>Utbetald utdelning</span></div>';
  }

  // Lönsamhet år för år: rörelsemarginal och avkastning på eget kapital
  function profitCard(h, short, finance, cur) {
    var n = h.fy.length, years = h.fy;
    var margins = finance ? [] : years.map(function (y, i) { return histMargin(h, i); });
    var roes = years.map(function (y, i) { return histRoe(h, i); });
    var mPts = margins.filter(function (v) { return v != null; }), rPts = roes.filter(function (v) { return v != null; });
    if (mPts.length < 2 && rPts.length < 2) return "";
    var lead = [];
    if (mPts.length >= 2) {
      var lo = Math.min.apply(null, mPts), hi = Math.max.apply(null, mPts), lastM = margins[n - 1];
      var mYears = years.filter(function (y, i) { return margins[i] != null; });
      lead.push(Math.round(hi * 100) === Math.round(lo * 100) ? "Rörelsemarginalen har legat på " + pc(hi) + " varje år " + yearSpan(mYears[0], mYears[mYears.length - 1]) + "."
        : "Rörelsemarginalen har legat mellan " + fixMinus(nf0.format(lo * 100)) + " och " + pc(hi) + " " + yearSpan(mYears[0], mYears[mYears.length - 1]) +
          (lastM != null ? ", senast " + pc(lastM) + " " + years[n - 1] + (lastM >= hi - 0.0001 ? ", den högsta på perioden" : lastM <= lo + 0.0001 ? ", den lägsta på perioden" : "") : "") + ".");
    }
    if (rPts.length >= 1) {
      var lastR = roes[n - 1], avgR = rPts.reduce(function (a, v) { return a + v; }, 0) / rPts.length;
      if (lastR != null) lead.push("Avkastningen på eget kapital var " + pc(lastR) + " " + years[n - 1] + (rPts.length >= 3 ? " och i snitt " + pc(avgR) + " per år." : "."));
    }
    var charts = (mPts.length >= 2 ? yearBars(years, margins, "Rörelsemarginal", pc) : "") + (rPts.length >= 2 ? yearBars(years, roes, "Avkastning på eget kapital", pc) : "");
    return '<div class="know-card know-fin"><h3>Lönsamheten år för år</h3><p class="know-lead">' + lead.join(" ") + "</p>" +
      (charts ? '<div class="qb-charts">' + charts + "</div>" : "") +
      '<p class="know-explain">' + (finance ? "" : "<b>Rörelsemarginal</b>: hur många " + curWord(cur) + " av varje 100 i försäljning som blir rörelseresultat, alltså vinst före räntor och skatt. ") +
      "<b>Avkastning på eget kapital</b>: årets resultat i procent av ägarnas pengar i bolaget (det egna kapitalet i genomsnitt under året). Visar hur bra bolaget förräntar ägarnas pengar." +
      (finance ? " Kassaflöden visas inte för banker, försäkrings- och investmentbolag: deras kassaflöden består mest av in- och utlåning eller köp och försäljning av värdepapper och går inte att jämföra med andra bolags." : "") +
      "</p></div>";
  }

  // Kassaflödet: kassaflöde från den löpande verksamheten, investeringar (capex), fritt kassaflöde och kassakonvertering
  function cashCard(h, short, cur, custFin) {
    var n = h.fy.length, i = n - 1, fy = h.fy[i];
    var ocf = hv(h, "ocf", i), capex = hv(h, "capex", i), fcf = histFcf(h, i), net = hv(h, "net", i);
    if (fcf == null) return "";
    var lead = "Under " + fy + " drog den löpande verksamheten in " + money(ocf, cur) + " (kassaflöde från den löpande verksamheten). " +
      money(capex, cur) + " gick till investeringar i maskiner, fastigheter, it och utveckling (capex). " +
      (fcf >= 0 ? "Kvar blev " + money(fcf, cur) + " i fritt kassaflöde: pengar som kan gå till utdelning, förvärv eller att betala av lån."
        : "Investeringarna var större än det verksamheten drog in, så det fria kassaflödet blev negativt: " + money(fcf, cur) + ".");
    // Kassakonvertering: hur stor del av årets resultat som blev fritt kassaflöde, helst räknat över alla år
    var sf = 0, sn = 0, yrs = [];
    for (var k = 0; k < n; k++) {
      var f = histFcf(h, k), r = hv(h, "net", k);
      if (f != null && r != null) { sf += f; sn += r; yrs.push(h.fy[k]); }
    }
    var conv = net > 0 ? fcf / net : null, convAll = yrs.length >= 3 && sn > 0 ? sf / sn : null, judge = convAll != null ? convAll : conv;
    var convText = "";
    if (conv != null || convAll != null) {
      convText = (conv != null ? " Det fria kassaflödet motsvarade " + pc(conv) + " av årets resultat (" + money(net, cur) + ")" : " Sammanlagt") +
        (convAll != null ? (conv != null ? ", och " : " ") + pc(convAll) + " sammanlagt " + yearSpan(yrs[0], yrs[yrs.length - 1]) : "") + ". Det kallas kassakonvertering. " +
        (judge >= 0.9 ? "Vinsten blir till riktiga pengar." : judge >= 0.6 ? "En stor del av vinsten blir pengar, resten binds i investeringar, lager och kundfordringar."
          : "Mycket av vinsten binds i investeringar, lager och kundfordringar och blir inte pengar i kassan direkt.");
    } else if (net != null && net <= 0) {
      convText = " Bolaget gick med förlust, så kassakonverteringen går inte att räkna ut.";
    }
    var tiles = '<div class="know-tiles in-card cash-tiles">' +
      '<div class="know-tile"><div class="kt-big' + (ocf < 0 ? " neg" : "") + '">' + money(ocf, cur) + '</div><div class="kt-label">kassaflöde från den löpande verksamheten</div></div>' +
      '<div class="know-tile"><div class="kt-big">' + money(capex, cur) + '</div><div class="kt-label">investeringar (capex)</div></div>' +
      '<div class="know-tile"><div class="kt-big' + (fcf < 0 ? " neg" : "") + '">' + money(fcf, cur) + '</div><div class="kt-label">fritt kassaflöde</div></div>' +
      (judge != null ? '<div class="know-tile"><div class="kt-big">' + pc(judge) + '</div><div class="kt-label">kassakonvertering</div><div class="kt-sub">' + (convAll != null ? "Sammanlagt " + yearSpan(yrs[0], yrs[yrs.length - 1]) : fy) + "</div></div>" : "") +
      "</div>";
    return '<div class="know-card"><h3>Kassaflödet: blir vinsten pengar?</h3><p class="know-lead">' + lead + convText + "</p>" + tiles +
      '<div class="qb-charts">' + yearBars(h.fy, h.fy.map(function (y, j) { return histFcf(h, j); }), "Fritt kassaflöde", function (v) { return money(v, cur); }) + "</div>" +
      '<p class="know-explain"><b>Fritt kassaflöde</b> = kassaflödet från den löpande verksamheten minus investeringar i anläggningar. Köp av andra bolag räknas inte in. ' +
      "<b>Kassakonvertering</b> = fritt kassaflöde i procent av årets resultat." +
      (custFin ? " Koncernens kassaflöde räknar med finansieringsverksamheten, alltså lån och leasing till kunder (" + nf0.format(custFin * 100) +
        " % av tillgångarna). Den binder pengar när utlåningen växer, så bolagets egna mått för industriverksamheten kan se bättre ut." : "") + "</p></div>";
  }

  // Täcks utdelningen av det fria kassaflödet? Utbetald utdelning enligt kassaflödesanalysen, samma år.
  function coverCard(h, short, cur) {
    var n = h.fy.length, years = h.fy;
    var fcfs = years.map(function (y, i) { return histFcf(h, i); }), divs = years.map(function (y, i) { return hv(h, "div", i); });
    var both = years.map(function (y, i) { return i; }).filter(function (i) { return fcfs[i] != null && divs[i] != null; });
    if (!both.length) return "";
    var i = both[both.length - 1], fcf = fcfs[i], div = divs[i];
    var sf = 0, sd = 0;
    both.forEach(function (j) { sf += fcfs[j]; sd += divs[j]; });
    var times = function (f, d) { return nf1.format(f / d).replace(/,0$/, "") + " gånger"; };
    var lead, sc = [];
    if (sd <= 0) {
      lead = esc(short) + " har inte betalat ut någon utdelning " + yearSpan(years[both[0]], years[i]) + ". Det fria kassaflödet stannar i bolaget, till exempel för investeringar, förvärv eller att betala av lån.";
    } else {
      lead = years[i] + " betalade " + esc(short) + " ut " + money(div, cur) + " i utdelning, och det fria kassaflödet var " + money(fcf, cur) + ". " +
        (div <= 0 ? "Ingen utdelning betalades ut det året."
          : fcf >= div * 1.2 ? "Utdelningen täcktes " + times(fcf, div) + " om av det fria kassaflödet, alltså med god marginal."
          : fcf >= div ? "Utdelningen täcktes, men med liten marginal (" + times(fcf, div) + ")."
          : "Utdelningen var större än det fria kassaflödet. Mellanskillnaden kom från kassan, från lån eller från sålda tillgångar.");
      if (both.length >= 2) {
        lead += " Sammanlagt " + yearSpan(years[both[0]], years[i]) + " var det fria kassaflödet " + money(sf, cur) + " och utdelningarna " + money(sd, cur) +
          (sf >= sd ? ", så utdelningen har betalats med pengar som verksamheten tjänat in." : ", så bolaget har delat ut mer än verksamheten dragit in.");
      }
      var tone = function (f, d) { return f >= d ? "pos" : "neg"; };
      if (div > 0) sc.push({ q: "Täcktes utdelningen " + years[i] + "?", a: fcf >= div ? "Ja, " + times(fcf, div) + " om" : "Nej, " + nf0.format(Math.max(0, fcf) / div * 100) + " % täcktes", tone: tone(fcf, div) });
      if (both.length >= 2) sc.push({ q: "Täcktes den " + yearSpan(years[both[0]], years[i]) + "?", a: sf >= sd ? "Ja, " + times(sf, sd) + " om" : "Nej, " + nf0.format(Math.max(0, sf) / sd * 100) + " % täcktes", tone: tone(sf, sd) });
    }
    return '<div class="know-card"><h3>Räcker pengarna till utdelningen?</h3>' + scoreCard(sc) + '<p class="know-lead">' + lead + "</p>" +
      (sd > 0 ? pairBars(years, fcfs, divs, "Fritt kassaflöde och utbetald utdelning per år", cur) : "") +
      '<p class="know-explain">En utdelning som täcks av det fria kassaflödet betalas med pengar som verksamheten tjänar in. Täcks den inte år efter år måste bolaget ta av kassan eller låna, och då kan utdelningen bli svår att behålla.</p></div>';
  }

  // Substansvärdet: investmentbolagens substansvärde per aktie, fastighetsbolagens EPRA NRV och belåningsgrad, och om
  // aktien kostar mindre (substansrabatt) eller mer (premie) än så. Vi har bara kursen vid kvartalsslut, så rabatten
  // räknas för den rapport som gäller samma dag, eller tas ur rapporten när bolaget själv anger den.
  function navCard(n, short, industry) {
    if (!n || (n.v == null && n.ltv == null)) return "";
    var prop = n.k === "nrv" || n.ltv != null || industry === "Förvaltning";
    var kr = function (v) { return (v === Math.round(v) ? nf0 : nf2).format(v) + " kr"; };
    var size = function (d) { return (Math.abs(d) < 10 ? nf1 : nf0).format(Math.abs(d)) + " %"; };
    var word = function (d) { return d < 0 ? "rabatt" : "premie"; };
    var VIA = { pm: "Står i både rapporten och pressmeddelandet.", text: "Står i rapportens nyckeltal och i rapportens text.",
      tabeller: "Samma värde i flera tabeller i rapporten.", calc: "Rapportens substansvärde, aktiekurs och rabatt går ihop." };
    var lbl = n.lbl || "Substansvärde", lblLow = lbl === "EPRA NRV" ? lbl : lbl.toLowerCase();
    // bestämd form: "det justerade substansvärdet", "EPRA NRV"
    var the = { "Substansvärde": "substansvärdet", "Justerat substansvärde": "det justerade substansvärdet", "Rapporterat substansvärde": "det rapporterade substansvärdet",
      "Långsiktigt substansvärde": "det långsiktiga substansvärdet" }[lbl] || lblLow;
    var tiles = [], tile = function (big, label, sub) {
      tiles.push('<div class="know-tile"><div class="kt-big">' + big + '</div><div class="kt-label">' + label + '</div><div class="kt-sub">' + sub + "</div></div>");
    };
    if (n.v != null) tile(kr(n.v), lblLow + " per aktie", "Den " + dateText(n.end) + ". " + VIA[n.via]);
    if (n.disc != null && n.v != null) tile(size(n.disc), "substans" + word(n.disc) + " enligt rapporten", Math.abs(n.disc) < 0.5 ? "Aktien kostade ungefär substansvärdet den " + dateText(n.end) + "." :
      "Den " + dateText(n.end) + ". Bolaget räknar själv mot aktiekursen den dagen.");
    var c = n.calc;
    if (c) tile(size(c.disc), Math.abs(c.disc) < 0.5 ? "ingen rabatt per kvartalsslut" : word(c.disc) + " per kvartalsslut", "Kursen " + kr(c.px) + " den " + dateText(c.end) + " mot " + lblLow + " " + kr(c.v) + " samma dag.");
    if (n.ltv != null) tile(nf1.format(n.ltv).replace(/,0$/, "") + " %", "belåningsgrad", "Så stor del av fastigheternas värde som är lånat, den " + dateText(n.end) + ".");
    // Kurs mot substansvärde samma dag, som två staplar, och vad det betyder i kronor
    var lead = [], bars = "";
    if (n.v != null) {
      var h0 = n.hist && n.hist.length >= 2 ? n.hist[n.hist.length - 2] : null, g = h0 ? n.v / h0[1] - 1 : null;
      lead.push("Den " + dateText(n.end) + " var " + the + " " + kr(n.v) + " per aktie" + (g == null ? "." : Math.abs(g) < 0.005 ? ", lika mycket som den " + dateText(h0[0]) + "." :
        ", " + nf0.format(Math.max(1, Math.abs(g) * 100)) + " % " + (g > 0 ? "mer" : "mindre") + " än den " + dateText(h0[0]) + "."));
    }
    // Kurs mot substansvärde samma dag, som två staplar, och vad det betyder i kronor
    if (c) {
      var max = Math.max(c.px, c.v), d = c.disc / 100;
      lead.push("Vid kvartalsslutet den " + dateText(c.end) + " kostade aktien " + kr(c.px) + " mot " + kr(c.v) + " i " + (lbl === "EPRA NRV" ? "EPRA NRV" : "substansvärde") +
        (Math.abs(c.disc) < 0.5 ? ", alltså ungefär vad tillgångarna var värda." : ", alltså en " + word(c.disc) + " på " + size(c.disc) + ": för 100 kronor fick man tillgångar värda ungefär " + nf0.format(100 / (1 + d)) + " kronor."));
      bars = '<ul class="know-rows nav-bars">' + [["Aktiekursen", c.px, true], [capFirst(lblLow), c.v, false]].map(function (x) {
        return '<li class="kr-row' + (x[2] ? " other" : "") + '"><div class="kr-top"><span class="kr-name">' + x[0] + '</span><span class="kr-val">' + kr(x[1]) + "</span></div>" +
          '<div class="kr-bar"><span style="width:' + (x[1] / max * 100).toFixed(1) + '%"></span></div></li>';
      }).join("") + "</ul>";
    }
    if (n.disc != null && n.v != null && (!c || c.end !== n.end)) {
      lead.push("Enligt rapporten var " + (Math.abs(n.disc) < 0.5 ? "kursen nära substansvärdet" : n.disc < 0 ? "substansrabatten " + size(n.disc) : "premien " + size(n.disc)) + " den " + dateText(n.end) + ".");
    }
    lead = lead.join(" ");
    var explain = prop ?
      "<p><b>" + (n.k === "nrv" ? "EPRA NRV (långsiktigt substansvärde)" : "Substansvärdet") + "</b> är vad fastigheterna och bolagets andra tillgångar är värda minus skulderna, räknat per aktie" +
        (n.k === "nrv" ? ", utan avdrag för den skatt som skulle betalas om fastigheterna såldes. Det är fastighetsbranschens vanliga mått." : ".") +
        " Kostar aktien mindre än så handlas den med " + termLink("substansrabatt", "substansrabatt") + ".</p>" +
        (n.ltv != null ? "<p><b>Belåningsgraden</b> är hur stor del av fastigheternas värde som är lånade pengar. Ju högre den är, desto mer känsligt är bolaget för högre räntor och fallande fastighetspriser. " +
          termLink("belaningsgrad", "Mer om belåningsgrad") + "</p>" : "")
      : "<p><b>Substansvärdet</b> är vad allt investmentbolaget äger (aktier i andra bolag, onoterade innehav och kassa) är värt minus skulderna, räknat per aktie. " +
        "Kostar aktien mindre än substansvärdet handlas den med <b>substansrabatt</b>: man köper tillgångarna billigare än de är värda. Kostar den mer är det en <b>premie</b>.</p>" +
        "<p>Rabatt är vanligt för investmentbolag, bland annat för att bolaget har förvaltningskostnader och för att ägarna inte själva väljer innehaven. " + termLink("substansrabatt", "Mer om substansrabatt") + "</p>";
    return '<div class="know-card nav-card"><h3>' + (prop ? "Substansvärde och belåning" : "Substansvärde och rabatt") + "</h3>" +
      (lead ? '<p class="know-lead">' + lead + "</p>" : "") +
      bars + '<div class="know-tiles in-card">' + tiles.join("") + "</div>" +
      '<div class="nav-explain">' + explain + "<p>Fondinsyn har bara aktiekursen vid kvartalsslut (ur fondernas rapporter till Finansinspektionen), inte dagens kurs. " +
        "Rabatten gäller därför den dag som står, och kan vara en annan i dag.</p></div>" +
      '<p class="kq-link"><a href="' + esc(n.url) + '" target="_blank" rel="noopener">Källa: ' + esc(n.title) + " (" + dateText(n.date) + ") ↗</a>" +
        (c && c.url !== n.url ? ' · <a href="' + esc(c.url) + '" target="_blank" rel="noopener">Rapporten för ' + dateText(c.end) + " ↗</a>" : "") + "</p></div>";
  }

  // ---------- Vad räknar börsen med? Värdering ur det fria kassaflödet ----------
  // Dagens börsvärde (Nasdaqs senaste kurs × antalet aktier i alla aktieslag) mot bolagets fria kassaflöde ur
  // årsredovisningarna (kassaflödet från den löpande verksamheten minus investeringar, snittet av de tre senaste åren).
  // Omvänd DCF: vilken årlig tillväxt i kassaflödet de närmaste tio åren gör att nuvärdet blir lika stort som
  // börsvärdet? Efter tio år antas 2 % per år för alltid. Läsaren kan själv ändra avkastningskravet och tillväxten.
  var DCF_YEARS = 10, DCF_TERMINAL = 0.02;
  function dcfValue(fcf, g, r) {
    var v = 0, f = fcf;
    for (var t = 1; t <= DCF_YEARS; t++) { f *= 1 + g; v += f / Math.pow(1 + r, t); }
    return v + f * (1 + DCF_TERMINAL) / (r - DCF_TERMINAL) / Math.pow(1 + r, DCF_YEARS);
  }
  // tillväxten som ger nuvärdet target (halvering mellan −30 % och +60 % per år)
  function dcfImplied(fcf, target, r) {
    var lo = -0.3, hi = 0.6;
    if (dcfValue(fcf, lo, r) > target || dcfValue(fcf, hi, r) < target) return null;
    for (var i = 0; i < 60; i++) { var mid = (lo + hi) / 2; if (dcfValue(fcf, mid, r) < target) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  }
  function cagr(a, b, years) { return a > 0 && b > 0 && years > 0 ? Math.pow(b / a, 1 / years) - 1 : null; }
  function valuationCard(c, isin, h, short, cur) {
    if (!h || !needShares() || !state.prices) return "";
    var isins = c.classes && c.classes.indexOf(isin) >= 0 ? c.classes : [isin];
    var mcap = 0, shares = 0, px = state.prices[isin];
    for (var i = 0; i < isins.length; i++) {
      var n = state.shares[isins[i]], p = state.prices[isins[i]];
      if (!n || !p || p[2] !== cur) return "";  // kurs i en annan valuta än rapporten: räknas inte
      mcap += n[0] * p[0]; shares += n[0];
    }
    if (!px || !(mcap > 0)) return "";
    var n = h.fy.length, fcfs = [];
    for (var k = Math.max(0, n - 3); k < n; k++) { var f = histFcf(h, k); if (f != null) fcfs.push(f); }
    if (fcfs.length < 2) return "";
    var fcf0 = fcfs.reduce(function (a, b) { return a + b; }, 0) / fcfs.length, net = hv(h, "netOwn", n - 1) != null ? hv(h, "netOwn", n - 1) : hv(h, "net", n - 1);
    var yieldF = fcf0 / mcap, pe = net > 0 ? mcap / net : null;
    // historisk tillväxt: det fria kassaflödet (snitt av två år i början och slutet, för att jämna ut) och försäljningen
    var first = [histFcf(h, 0), histFcf(h, 1)].filter(function (x) { return x != null; }), last2 = [histFcf(h, n - 2), histFcf(h, n - 1)].filter(function (x) { return x != null; });
    var avg = function (l) { return l.reduce(function (a, b) { return a + b; }, 0) / l.length; };
    var gF = n >= 4 && first.length === 2 && last2.length === 2 ? cagr(avg(first), avg(last2), n - 2) : null;
    // Kassaflödet hoppar mycket hos cykliska och investeringstunga bolag (SSAB, Boliden). Då jämförs i stället med
    // försäljningen, som säger mer om hur bolaget har vuxit.
    var allPos = h.fy.every(function (y, j) { var x = histFcf(h, j); return x == null || x > 0; });
    if (gF != null && (!allPos || Math.abs(gF) > 0.3)) gF = null;
    var gR = n >= 3 ? cagr(hv(h, "rev", 0), hv(h, "rev", n - 1), n - 1) : null;
    if (gR != null && Math.abs(gR) > 0.5) gR = null;
    var years = h.fy[0] + "–" + h.fy[n - 1];
    var pctTxt = function (v) { return fixMinus(nf1.format(v * 100).replace(/,0$/, "")) + " %"; };
    var tiles = '<div class="know-tiles in-card">' +
      '<div class="know-tile"><div class="kt-big">' + money(mcap, cur) + '</div><div class="kt-label">börsvärde</div><div class="kt-sub">Kursen ' + perShare(px[0], cur) + " den " + dateText(px[1]) + (isins.length > 1 ? ", alla aktieslag" : "") + "</div></div>" +
      (pe ? '<div class="know-tile"><div class="kt-big">' + nf1.format(pe) + '</div><div class="kt-label">P/E-tal</div><div class="kt-sub">Börsvärdet delat med vinsten ' + h.fy[n - 1] + ": så många års vinst kostar bolaget</div></div>" : "") +
      '<div class="know-tile"><div class="kt-big' + (fcf0 < 0 ? " neg" : "") + '">' + pctTxt(yieldF) + '</div><div class="kt-label">kassaflödesavkastning</div><div class="kt-sub">Fritt kassaflöde (snitt ' + fcfs.length + " år, " + money(fcf0, cur) + ") i procent av börsvärdet</div></div></div>";
    if (fcf0 <= 0) {
      return '<div class="know-card dcf-card"><h3>Vad räknar börsen med?</h3><p class="know-lead">Det fria kassaflödet har varit negativt de senaste åren, så börsvärdet går inte att räkna om till en förväntad tillväxt. ' +
        "Ägarna betalar för något som ska ge pengar längre fram.</p>" + tiles + "</div>";
    }
    var r0 = 0.08, implied = dcfImplied(fcf0, mcap, r0);
    // jämförelsen: kassaflödets tillväxt om den är stabil, annars försäljningens
    var hist = gF != null ? [gF, "det fria kassaflödet"] : gR != null ? [gR, "försäljningen"] : null, verdict = "";
    if (implied != null && hist) {
      var was = hist[1] + " har vuxit " + years + " (" + pctTxt(hist[0]) + " per år)";
      verdict = Math.abs(implied - hist[0]) <= 0.02 ? " Det är ungefär lika mycket som " + was + "."
        : implied > hist[0] ? " Det är mer än " + was + ": börsen tror att det blir bättre framöver."
        : " Det är mindre än " + was + ": börsen tror att tillväxten mattas av, eller räknar med en högre risk.";
    }
    var lead = implied == null ? "Börsvärdet är så " + (dcfValue(fcf0, -0.3, r0) > mcap ? "lågt" : "högt") + " jämfört med kassaflödet att det inte går att räkna ut en rimlig förväntad tillväxt."
      : implied >= 0 ? "För att dagens börsvärde ska vara rimligt behöver det fria kassaflödet växa med <b>" + pctTxt(implied) + " per år</b> de kommande tio åren, med ett avkastningskrav på 8 %." + verdict
      : "Dagens börsvärde är rimligt även om det fria kassaflödet <b>minskar med " + pctTxt(-implied) + " per år</b> de kommande tio åren, med ett avkastningskrav på 8 %. Börsen räknar alltså med sämre tider, eller med en högre risk." +
        (hist ? " " + capFirst(hist[1]) + " har vuxit " + pctTxt(hist[0]) + " per år " + years + "." : "");
    // Stora investeringar (Boliden) gör det fria kassaflödet litet just nu: säg det, annars ser förväntningen orimlig ut
    var oc = 0, cx = 0;
    for (k = Math.max(0, n - 3); k < n; k++) { oc += hv(h, "ocf", k) || 0; cx += hv(h, "capex", k) || 0; }
    if (implied != null && implied > 0.12 && oc > 0 && cx / oc > 0.6) {
      lead += " Men " + nf0.format(cx / oc * 100) + " % av det verksamheten drog in har gått till investeringar de senaste åren. Minskar de växer det fria kassaflödet utan att försäljningen behöver göra det.";
    }
    // reglaget börjar på bolagets historiska tillväxt, annars på det börsen räknar med
    var start = hist ? hist[0] : implied != null ? implied : 0.03;
    var g0 = Math.max(-0.05, Math.min(0.2, Math.round(start * 100) / 100));
    var data = ' data-fcf="' + fcf0 + '" data-mcap="' + mcap + '" data-shares="' + shares + '" data-px="' + px[0] + '" data-cur="' + esc(cur) + '"';
    return '<div class="know-card dcf-card"' + data + '><h3>Vad räknar börsen med?</h3><p class="know-lead">' + lead + "</p>" + tiles +
      '<h4 class="kq-sub">Värdera själv</h4>' +
      '<div class="dcf-controls">' +
      '<label class="dcf-ctl"><span>Avkastningskrav <b class="dcf-r-out">8 %</b></span><input type="range" class="dcf-r" data-dcf min="6" max="12" step="0.5" value="8" aria-label="Avkastningskrav i procent"></label>' +
      '<label class="dcf-ctl"><span>Tillväxt i kassaflödet per år <b class="dcf-g-out">' + pctTxt(g0) + '</b></span><input type="range" class="dcf-g" data-dcf min="-5" max="20" step="1" value="' + Math.round(g0 * 100) + '" aria-label="Tillväxt per år i procent"></label>' +
      "</div>" + '<div class="dcf-result" aria-live="polite">' + dcfResultHtml(fcf0, mcap, shares, px[0], cur, g0, r0) + "</div>" +
      '<p class="know-explain"><b>Så räknas det.</b> Det fria kassaflödet (' + money(fcf0, cur) + " per år i snitt) antas växa med din tillväxt i tio år och därefter med 2 % per år. " +
      "Varje års kassaflöde räknas om till dagens värde med avkastningskravet, alltså den avkastning man vill ha för att äga aktien. Summan delas med antalet aktier. " +
      (gR != null ? "Försäljningen har vuxit " + pctTxt(gR) + " per år " + yearSpan(h.fy[0], h.fy[n - 1]) + ". " : "") +
      "Kassaflödet tas ur årsredovisningarna, kursen från Nasdaq. Det är ett räkneexempel med förenklade antaganden, inte ett råd att köpa eller sälja.</p></div>";
  }
  function dcfResultHtml(fcf, mcap, shares, px, cur, g, r) {
    var value = dcfValue(fcf, g, r) / shares, diff = value / px - 1, max = Math.max(value, px);
    var implied = dcfImplied(fcf, mcap, r);
    return '<ul class="know-rows nav-bars">' + [["Aktiekursen i dag", px, true], ["Värde med dina antaganden", value, false]].map(function (x) {
      return '<li class="kr-row' + (x[2] ? " other" : "") + '"><div class="kr-top"><span class="kr-name">' + x[0] + '</span><span class="kr-val">' + perShare(x[1], cur) + "</span></div>" +
        '<div class="kr-bar"><span style="width:' + (Math.max(0, x[1]) / max * 100).toFixed(1) + '%"></span></div></li>';
    }).join("") + "</ul>" +
      '<p class="dcf-say">' + (Math.abs(diff) < 0.05 ? "Med dina antaganden är aktien värd ungefär vad den kostar."
        : "Med dina antaganden är aktien värd <b class=\"" + cls(diff) + "\">" + nf0.format(Math.abs(diff) * 100) + " % " + (diff > 0 ? "mer" : "mindre") + "</b> än kursen.") +
      (implied != null ? " Med avkastningskravet " + nf1.format(r * 100).replace(/,0$/, "") + " % räknar börsen med " + fixMinus(nf1.format(implied * 100).replace(/,0$/, "")) + " % tillväxt per år." : "") + "</p>";
  }
  document.addEventListener("input", function (e) {
    var t = e.target;
    if (!t.hasAttribute || !t.hasAttribute("data-dcf")) return;
    var card = t.closest(".dcf-card");
    if (!card) return;
    var r = +card.querySelector(".dcf-r").value / 100, g = +card.querySelector(".dcf-g").value / 100;
    card.querySelector(".dcf-r-out").textContent = nf1.format(r * 100).replace(/,0$/, "") + " %";
    card.querySelector(".dcf-g-out").textContent = fixMinus(nf0.format(g * 100)) + " %";
    card.querySelector(".dcf-result").innerHTML = dcfResultHtml(+card.dataset.fcf, +card.dataset.mcap, +card.dataset.shares, +card.dataset.px, card.dataset.cur, g, r);
  });

  // ---------- Branschens nyckeltal ur bolagets rapporter (kpi i data/bolag/<ISIN>.json) ----------
  // Det som betyder mest i just den branschen: räntenetto och kreditförluster för banker, uthyrningsgrad och snittränta
  // för fastighetsbolag, produktion och metallpriser för gruvbolag, kassan för läkemedelsbolag och så vidare.
  // [rubrik, slag, förklaring]. Slag: pct (procent), x (gånger), yr (år), amt (belopp), n (antal).
  var KPI_META = {
    nii: ["Räntenetto", "amt", "Ränteintäkterna från utlåningen minus räntekostnaderna för inlåning och upplåning. Den största intäkten för de flesta banker."],
    fee: ["Provisionsnetto", "amt", "Avgifter för fonder, kort, betalningar och rådgivning, minus bankens egna avgifter."],
    kf: ["Kreditförluster", "amt", "Lån som banken räknar med att inte få tillbaka. Ett negativt tal betyder att tidigare reserveringar har återförts."],
    kfn: ["Kreditförlustnivå", "pct", "Kreditförlusterna i procent av utlåningen, räknat per år. Under 0,1 % är lågt."],
    lend: ["Utlåning till allmänheten", "amt", "Lån till hushåll och företag vid kvartalets slut."],
    dep: ["Inlåning från allmänheten", "amt", "Pengar som hushåll och företag har på konton i banken."],
    lcr: ["Likviditetstäckningsgrad", "pct", "Hur väl bankens likvida tillgångar räcker för 30 dagars stress. Kravet är minst 100 %."],
    aum: ["Sparkapital", "amt", "Kundernas sammanlagda sparande hos bolaget i aktier, fonder och på konton."],
    cust: ["Antal kunder", "n", "Kunder vid kvartalets slut."],
    inflow: ["Nettoinflöde", "amt", "Pengar som kunderna satte in minus det de tog ut under kvartalet."],
    tkp: ["Totalkostnadsprocent", "pct", "Skadeersättningar och kostnader i procent av premieintäkterna. Under 100 % betyder att försäkringsrörelsen går med vinst."],
    skp: ["Skadeprocent", "pct", "Ersättningarna för skador i procent av premieintäkterna."],
    prem: ["Premieintäkter", "amt", "Det kunderna betalade för sina försäkringar under kvartalet, efter återförsäkring."],
    occ: ["Uthyrningsgrad", "pct", "Hyran bolaget får in i procent av vad det skulle få om allt var uthyrt."],
    surplus: ["Överskottsgrad", "pct", "Hur stor del av hyrorna som blir kvar efter drift, underhåll och fastighetsskatt."],
    icr: ["Räntetäckningsgrad", "x", "Hur många gånger resultatet före räntor räcker till räntekostnaderna. Långivare brukar vilja se minst 1,5–2 gånger."],
    rate: ["Genomsnittlig ränta", "pct", "Snitträntan på bolagets lån."],
    fixyr: ["Räntebindning", "yr", "Hur länge räntorna på lånen är bundna i genomsnitt. Längre bindning skyddar mot högre räntor."],
    capyr: ["Kapitalbindning", "yr", "Hur länge det i genomsnitt är kvar tills lånen ska betalas tillbaka eller förnyas."],
    pv: ["Fastigheternas värde", "amt", "Vad fastigheterna är värda enligt bolagets värdering vid kvartalets slut."],
    mgmt: ["Förvaltningsresultat", "amt", "Resultatet av uthyrningen efter räntor, men före värdeförändringar och skatt. Fastighetsbolagens viktigaste resultatmått."],
    noi: ["Driftnetto", "amt", "Hyresintäkterna minus kostnaderna för drift, underhåll och fastighetsskatt."],
    rent: ["Hyresintäkter", "amt", "Hyrorna under kvartalet."],
    netlet: ["Nettouthyrning", "amt", "Årshyran i nya hyresavtal minus årshyran i avtal som sagts upp. Positivt betyder att uthyrningen växer."],
    stores: ["Antal butiker", "n", "Butiker vid kvartalets slut."],
    lfl: ["Jämförbara butiker", "pct", "Förändringen av försäljningen i butiker som funnits i minst ett år, så att nyöppnade butiker inte räknas in."],
    active: ["Aktiva kunder", "n", "Kunder som spelade under kvartalet."],
    deposits: ["Kundinsättningar", "amt", "Pengar som spelarna satte in på sina spelkonton under kvartalet."],
    svc: ["Tjänsteintäkter", "amt", "Intäkterna från abonnemang och tjänster, utan försäljning av telefoner och annan utrustning. Operatörens viktigaste mått på om affären växer."],
    fcf: ["Fritt kassaflöde", "amt", "Pengar som blev kvar efter investeringar i näten, räntor och skatt. Det är de pengarna som kan gå till utdelning och till att betala av lån."],
    arr: ["Årligt återkommande intäkter", "amt", "Vad de löpande abonnemangen är värda på ett år (ARR). Visar hur stor den återkommande affären är."],
    cash: ["Likvida medel", "amt", "Pengar på bank och liknande vid kvartalets slut."],
    ocf: ["Kassaflöde från verksamheten", "amt", "Pengar som verksamheten drog in, eller förbrukade, under kvartalet."],
    gm: ["Bruttomarginal", "pct", "Hur mycket av varje 100 kronor i försäljning som blir kvar efter kostnaden för det som såldes."],
    ebitdam: ["EBITDA-marginal", "pct", "Resultatet före räntor, skatt och avskrivningar i procent av försäljningen."],
    ndebitda: ["Nettoskuld/EBITDA", "x", "Hur många års resultat före avskrivningar (EBITDA) det skulle ta att betala nettoskulden. Negativt betyder mer pengar i kassan än lån."],
    roce: ["Avkastning på sysselsatt kapital", "pct", "Rörelseresultatet i procent av kapitalet i verksamheten (eget kapital och lån). Visar hur bra bolaget förräntar pengarna i verksamheten."]
  };
  var KPI_TITLE = {
    bank: "Bankens nyckeltal", ins: "Försäkringsrörelsen", prop: "Fastigheterna och lånen", mine: "Produktion och leveranser",
    forest: "Produktion och leveranser", retail: "Butikerna och marginalerna", tele: "Tjänsteintäkter och kassaflöde",
    pharma: "Kassan: hur länge räcker pengarna?", games: "Spelarna och marginalerna", tech: "Den återkommande affären", ind: "Lönsamhet och skulder"
  };
  function kpiFmt(v, kind, cur) {
    // små procenttal med två decimaler: kreditförlustnivån 0,04 %, inte 0 %
    if (kind === "pct") return fixMinus(Math.abs(v) < 1 && v !== 0 ? nf2.format(v) : nf1.format(v).replace(/,0$/, "")) + " %";
    if (kind === "x") return fixMinus(nf1.format(v)) + " gånger";
    if (kind === "yr") return nf1.format(v).replace(/,0$/, "") + " år";
    if (kind === "n") return int(v);
    return money(v, cur);
  }
  // Förändringen mot samma kvartal året innan, annars mot kvartalet innan: [text, tecken]
  function kpiChange(s, kind, cur) {
    if (!s || s.length < 2) return null;
    var mi = function (p) { return +p.slice(0, 4) * 12 + +p.slice(5, 7); }, last = s[s.length - 1];
    var yearAgo = s.filter(function (x) { return mi(last[0]) - mi(x[0]) === 12; })[0];
    var prevQ = s.filter(function (x) { return mi(last[0]) - mi(x[0]) === 3; })[0];
    var base = yearAgo || prevQ;
    if (!base) return null;
    var when = yearAgo ? "mot samma kvartal i fjol" : "mot kvartalet innan", d = last[1] - base[1], txt;
    var sign = function (s) { return (d > 0 ? "+" : "−") + s; };
    var small = Math.abs(base[1]) < 1 && Math.abs(last[1]) < 1;  // kreditförlustnivån: hundradelar
    if (kind === "pct") txt = Math.abs(d) < (small ? 0.005 : 0.05) ? "Oförändrat" : sign((small ? nf2.format(Math.abs(d)) : nf1.format(Math.abs(d)).replace(/,0$/, ""))) +
      (Math.abs(Math.abs(d) - 1) < 0.05 ? " procentenhet" : " procentenheter");
    else if (kind === "x" || kind === "yr") txt = Math.abs(d) < 0.05 ? "Oförändrat" : sign(nf1.format(Math.abs(d))) + (kind === "x" ? " gånger" : " år");
    else if (base[1] > 0 && last[1] >= 0) { var g = last[1] / base[1] - 1; txt = Math.abs(g) < 0.005 ? "Oförändrat" : pct(g); d = g; }
    else txt = sign(kpiFmt(Math.abs(d), kind, cur));
    return [txt + " " + when, Math.abs(d) < 1e-9 || /^Oförändrat/.test(txt) ? 0 : d];
  }
  // Liten tidsserie i ett nyckeltal: staplar för belopp och antal, en linje för procent, gånger och år
  function kpiSpark(s, kind, cur) {
    if (!s || s.length < 3) return "";
    var label = function (x) { return periodText(x[0], 3) + ": " + kpiFmt(x[1], kind, cur); };
    var last = s[s.length - 1];
    // Tiden i kvartal från det första värdet, så att ett kvartal som saknas blir en lucka
    var mi = function (p) { return +p.slice(0, 4) * 12 + +p.slice(5, 7); }, t0 = mi(s[0][0]), steps = Math.max(1, (mi(last[0]) - t0) / 3);
    if (kind === "amt" || kind === "n") {
      var max = Math.max(0, Math.max.apply(null, s.map(function (x) { return x[1]; }))), min = Math.min(0, Math.min.apply(null, s.map(function (x) { return x[1]; })));
      var span = max - min || 1, zero = max / span * 100, slots = [];
      for (var q = 0; q <= steps; q++) slots.push(s.filter(function (x) { return mi(x[0]) - t0 === q * 3; })[0] || null);
      return '<div class="kp-bars" role="img" aria-label="' + esc(s.map(label).join(", ")) + '">' + slots.map(function (x) {
        if (!x) return '<div class="kp-col"></div>';
        var h = Math.max(Math.abs(x[1]) / span * 100, 1.5);
        return '<div class="kp-col" title="' + esc(label(x)) + '"><span class="kp-bar' + (x[1] < 0 ? " neg" : "") + (x === last ? " now" : "") + '" style="height:' + h.toFixed(1) + "%;" +
          (x[1] < 0 ? "top:" + zero.toFixed(1) + "%" : "bottom:" + (100 - zero).toFixed(1) + "%") + '"></span></div>';
      }).join("") + '</div><div class="kp-axis"><span>' + periodShort(s[0][0]).replace("<br>", " ") + "</span><span>" + periodShort(last[0]).replace("<br>", " ") + "</span></div>";
    }
    var vals = s.map(function (x) { return x[1]; }), lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var pad = (hi - lo) * 0.2 || Math.abs(hi) * 0.05 || 1; lo -= pad; hi += pad;
    var W = 200, H = 44, yp = function (v) { return 4 + (hi - v) / (hi - lo) * (H - 8); };
    var xp = function (i) { return 5 + (mi(s[i][0]) - t0) / 3 / steps * (W - 10); };
    // ett kvartal som saknas bryter linjen
    var path = s.map(function (x, i) { return (i && mi(x[0]) - mi(s[i - 1][0]) === 3 ? "L" : "M") + xp(i).toFixed(1) + " " + yp(x[1]).toFixed(1); }).join(" ");
    return '<div class="kp-line"><svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img" aria-label="' + esc(s.map(label).join(", ")) + '">' +
      '<path class="ml-line" d="' + path + '" vector-effect="non-scaling-stroke"></path></svg>' +
      '<div class="ml-dots">' + s.map(function (x, i) {
        return '<span class="ml-dot' + (x === last ? " now" : "") + '" style="left:' + (xp(i) / W * 100).toFixed(2) + "%;top:" + (yp(x[1]) / H * 100).toFixed(2) + '%" title="' + esc(label(x)) + '"></span>';
      }).join("") + '</div></div><div class="kp-axis"><span>' + periodShort(s[0][0]).replace("<br>", " ") + "</span><span>" + periodShort(last[0]).replace("<br>", " ") + "</span></div>";
  }
  // Ett par meningar om det viktigaste, med bolagets egna siffror
  function kpiLead(k, by, short, cur) {
    var v = function (key) { return by[key] ? by[key].v : null; }, out = [];
    var f = function (key) { return kpiFmt(by[key].v, KPI_META[key][1], cur); };
    if (k.g === "bank") {
      if (v("nii") != null) out.push("Räntenettot, det banken tjänar på skillnaden mellan in- och utlåningsräntor, var " + f("nii") + " under kvartalet.");
      if (v("kfn") != null) out.push(v("kfn") < 0 ? "Kreditförlusterna var negativa (kreditförlustnivå " + f("kfn") + "): banken kunde återföra pengar som den tidigare reserverat för befarade förluster."
        : v("kfn") === 0 ? "Kreditförlusterna var i stort sett noll."
        : "Kreditförlustnivån var " + f("kfn") + (v("kfn") < 0.1 ? ", vilket är lågt." : v("kfn") < 0.3 ? ", vilket är normalt för en bank." : ", vilket är högt."));
      if (v("cust") != null) out.push(esc(short) + " hade " + f("cust") + " kunder vid kvartalets slut.");
    } else if (k.g === "ins") {
      if (v("tkp") != null) out.push("Totalkostnadsprocenten var " + f("tkp") + (v("tkp") < 100 ? ": av varje 100 kronor kunderna betalade gick " + nf0.format(v("tkp")) + " till skador och kostnader, och resten blev vinst." : ": skador och kostnader var större än premierna."));
    } else if (k.g === "prop") {
      if (v("occ") != null) out.push("Uthyrningsgraden var " + f("occ") + ", alltså stod ungefär " + nf0.format(100 - v("occ")) + " % av hyresvärdet tomt.");
      if (v("rate") != null) out.push("Lånen hade en snittränta på " + f("rate") + (v("fixyr") != null ? " och räntorna var bundna i " + f("fixyr") + " i genomsnitt." : "."));
      if (v("icr") != null) out.push("Resultatet före räntor räckte " + f("icr").replace(" gånger", "") + " gånger till räntekostnaderna" + (v("icr") >= 2 ? ", en trygg marginal." : v("icr") >= 1.5 ? ", en godkänd marginal." : ", en tunn marginal."));
    } else if (k.g === "pharma") {
      var cash = v("cash"), ocf = by.ocf ? by.ocf.s.slice(-4).map(function (x) { return x[1]; }) : [];
      var burn = ocf.length >= 2 ? ocf.reduce(function (a, b) { return a + b; }, 0) / ocf.length : null;
      if (cash != null && burn != null && burn < 0) {
        var qn = cash / -burn;
        out.push("Kassan var " + f("cash") + ". Verksamheten förbrukade i snitt " + money(-burn, cur) + " per kvartal de senaste " + ocf.length + " kvartalen. " +
          (qn >= 12 ? "I den takten räcker pengarna i mer än tre år." : "I den takten räcker pengarna i ungefär " + (qn >= 4 ? nf1.format(qn / 4).replace(/,0$/, "") + " år" : nf0.format(Math.max(1, qn)) + " kvartal") + ".") +
          " Det är ett räkneexempel: bolaget kan få in nya pengar, till exempel genom en nyemission eller ett licensavtal, eller ändra sina planer.");
      } else if (cash != null && burn != null) {
        out.push("Kassan var " + f("cash") + ", och verksamheten drog in pengar de senaste " + ocf.length + " kvartalen.");
      } else if (cash != null) out.push("Kassan var " + f("cash") + " vid kvartalets slut.");
    } else if (k.g === "retail") {
      if (v("gm") != null) out.push("Av varje 100 kronor i försäljning blev " + nf0.format(v("gm")) + " kronor kvar efter kostnaden för varorna (bruttomarginal " + f("gm") + ").");
      if (v("stores") != null) out.push(esc(short) + " hade " + f("stores") + " butiker vid kvartalets slut.");
    }
    if (k.g === "tele") {
      var sch = by.svc ? kpiChange(by.svc.s, "amt", cur) : null;
      if (v("svc") != null) out.push("Tjänsteintäkterna, det kunderna betalar för abonnemang och tjänster, var " + f("svc") + " under kvartalet" + (sch && sch[1] ? " (" + sch[0] + ")" : "") + ".");
      if (v("fcf") != null) out.push(v("fcf") >= 0 ? "Efter investeringar i näten blev " + f("fcf") + " kvar i fritt kassaflöde." : "Det fria kassaflödet var negativt: " + f("fcf") + ".");
    }
    // Spel, mjukvara och telekom: marginalen och hur den har ändrats
    var mg = !out.length && (by.ebitdam || by.gm);
    if (mg) {
      var mk = by.ebitdam ? "ebitdam" : "gm", ch = kpiChange(mg.s, "pct", cur);
      // "−8,7 procentenheter mot samma kvartal i fjol" blir "8,7 procentenheter lägre än samma kvartal i fjol"
      var cm = ch && ch[1] ? ch[0].match(/^[+−](.*) mot (.*)$/) : null;
      out.push((mk === "gm" ? "Bruttomarginalen" : "EBITDA-marginalen") + " var " + f(mk) + (cm ? ", " + cm[1] + (ch[1] > 0 ? " högre än " : " lägre än ") + cm[2] : "") + ".");
    }
    if (!out.length && v("roce") != null) out.push("Avkastningen på sysselsatt kapital var " + f("roce") + ": för varje 100 kronor i verksamheten blev det " + nf0.format(Math.max(0, v("roce"))) + " kronor i rörelseresultat per år.");
    if (v("ndebitda") != null && k.g !== "pharma") out.push(v("ndebitda") < 0 ? "Bolaget har mer pengar i kassan än lån (nettoskuld/EBITDA " + f("ndebitda") + ")."
      : "Nettoskulden motsvarar " + f("ndebitda").replace(" gånger", "") + " års EBITDA" + (v("ndebitda") <= 2 ? ", en måttlig skuldsättning." : v("ndebitda") <= 3.5 ? ", en ganska hög skuldsättning." : ", en hög skuldsättning."));
    return out.join(" ");
  }
  // Enheten som i rapporten, men enhetligt skriven: "Kton" blir "kton", "1 000 m3" blir "tusen m³"
  function kpiUnit(u) {
    return String(u || "").replace(/^1 ?000 /, "tusen ").replace(/m3/g, "m³").replace(/^Kton$/, "kton").replace(/^KT$|^kt$/i, "kton");
  }
  // Produktion, leveranser, metallpriser och halter ur gruv- och skogsbolagens tabeller
  function kpiVolRows(list, kindWanted) {
    var rows = list.filter(function (x) { return x.kind === kindWanted; });
    if (!rows.length) return "";
    var mi = function (p) { return +p.slice(0, 4) * 12 + +p.slice(5, 7); };
    return '<ul class="kp-vol">' + rows.map(function (x) {
      var last = x.s[x.s.length - 1], prev = x.s.filter(function (y) { return mi(last[0]) - mi(y[0]) === 12; })[0] || x.s.filter(function (y) { return mi(last[0]) - mi(y[0]) === 3; })[0];
      var g = prev && prev[1] > 0 ? last[1] / prev[1] - 1 : null, when = prev && mi(last[0]) - mi(prev[0]) === 12 ? "mot samma kvartal i fjol" : "mot kvartalet innan";
      var fmt = function (v) { return (Math.abs(v) >= 100 || v === Math.round(v) ? nf0 : nf1).format(v) + " " + esc(kpiUnit(x.unit)); };
      var max = Math.max.apply(null, x.s.map(function (y) { return y[1]; })) || 1;
      return '<li><div class="kpv-top"><span class="kpv-name">' + esc(x.lbl) + '</span><span class="kpv-val">' + fmt(last[1]) + "</span></div>" +
        '<div class="kpv-bars" role="img" aria-label="' + esc(x.s.map(function (y) { return periodText(y[0], 3) + ": " + fmt(y[1]); }).join(", ")) + '">' + x.s.map(function (y) {
          return '<span class="kpv-bar' + (y === last ? " now" : "") + '" title="' + esc(periodText(y[0], 3) + ": " + fmt(y[1])) + '"><i style="height:' + Math.max(4, y[1] / max * 100).toFixed(1) + '%"></i></span>';
        }).join("") + "</div>" +
        (g != null ? '<div class="kpv-sub"><span class="' + cls(g) + '">' + pct(g) + "</span> " + when + "</div>" : "") + "</li>";
    }).join("") + "</ul>";
  }
  function kpiCard(k, short, cur) {
    if (!k || (!k.items && !k.vol)) return "";
    var by = {};
    // kassaflödet ensamt säger lite: det visas bara tillsammans med kassan (hur länge pengarna räcker)
    var items = (k.items || []).filter(function (it) { return KPI_META[it.k] && !(it.k === "ocf" && !(k.items || []).some(function (x) { return x.k === "cash"; })); });
    if (!items.length && !k.vol) return "";
    items.forEach(function (it) { by[it.k] = it; });
    var tiles = items.map(function (it) {
      var m = KPI_META[it.k], ch = kpiChange(it.s, m[1], cur);
      return '<div class="know-tile kp-tile"><div class="kp-name">' + m[0] + '</div><div class="kt-big' + (it.v < 0 && m[1] === "amt" ? " neg" : "") + '">' + kpiFmt(it.v, m[1], cur) + "</div>" +
        (ch ? '<div class="kp-change"><span class="' + cls(ch[1]) + '">' + ch[0].replace(/ (mot .*)$/, "</span> $1") + "</div>" : "") +
        kpiSpark(it.s, m[1], cur) + '<div class="kt-sub">' + m[2] + "</div></div>";
    });
    var vol = k.vol || [], lead = kpiLead(k, by, short, cur);
    if (vol.length) {
      // "Under jul–sep 2026 var zink i koncentrat 84 744 ton (−22 % mot samma kvartal i fjol) och …"
      var mi = function (p) { return +p.slice(0, 4) * 12 + +p.slice(5, 7); };
      var said = function (x, i) {
        var last = x.s[x.s.length - 1], ago = x.s.filter(function (y) { return mi(last[0]) - mi(y[0]) === 12; })[0];
        var g = ago && ago[1] > 0 ? last[1] / ago[1] - 1 : null;
        return esc(x.lbl.charAt(0).toLowerCase() + x.lbl.slice(1)) + " " + (Math.abs(last[1]) >= 100 ? nf0 : nf1).format(last[1]) + " " + esc(kpiUnit(x.unit)) +
          (g != null ? " (" + pct(g) + (i ? ")" : " mot samma kvartal i fjol)") : "");
      };
      var vs = vol.filter(function (x) { return x.kind === "vol"; }).slice(0, 2), ps = vol.filter(function (x) { return x.kind === "pris"; });
      if (vs.length) lead = (lead ? lead + " " : "") + "Under " + periodText(k.p, 3) + ": " + vs.map(said).join(" och ") + ".";
      var big = ps.map(function (x) {
        var last = x.s[x.s.length - 1], ago = x.s.filter(function (y) { return mi(last[0]) - mi(y[0]) === 12; })[0];
        return ago && ago[1] > 0 ? { x: x, g: last[1] / ago[1] - 1 } : null;
      }).filter(Boolean).sort(function (a, b) { return Math.abs(b.g) - Math.abs(a.g); })[0];
      if (big && Math.abs(big.g) >= 0.1) lead += " Största prisrörelsen: " + esc(big.x.lbl.toLowerCase()) + " kostade " + nf0.format(Math.abs(big.g) * 100) + " % " + (big.g > 0 ? "mer" : "mindre") + " än för ett år sedan.";
    }
    var volHtml = "";
    if (vol.length) {
      var parts = [["vol", "Produktion och leveranser"], ["halt", "Halter i malmen"], ["pris", "Priser"]].map(function (p) {
        var rows = kpiVolRows(vol, p[0]);
        return rows ? [p[1], rows] : null;
      }).filter(Boolean);
      // en enda lista behöver ingen egen rubrik (kortets rubrik säger redan "Produktion och leveranser")
      volHtml = '<div class="kp-vol-grid' + (parts.length === 1 ? " one" : "") + '">' + parts.map(function (p) {
        return "<div>" + (parts.length > 1 || items.length ? '<h4 class="kq-sub">' + p[0] + "</h4>" : "") + p[1] + "</div>";
      }).join("") + "</div>";
    }
    var title = KPI_TITLE[k.g] || "Branschens nyckeltal";
    if (k.g === "mine" && vol.some(function (x) { return x.kind === "pris"; })) title = "Produktion och metallpriser";
    // "hur länge räcker pengarna?" bara när verksamheten förbrukar pengar
    if (k.g === "pharma" && !/räcker pengarna i/.test(lead)) title = "Kassan och kassaflödet";
    return '<div class="know-card kp-card"><h3>' + title + ' <span class="kq-per">' + periodText(k.p, 3) + "</span></h3>" +
      (lead ? '<p class="know-lead">' + lead + "</p>" : "") +
      (tiles.length ? '<div class="know-tiles in-card kp-tiles">' + tiles.join("") + "</div>" : "") + volHtml +
      '<p class="know-explain">Måtten väljs efter vad som betyder mest i branschen och kommer ur bolagets egen kvartalsrapport. Ett värde visas bara när samma tal står både i rapportens nyckeltalstabell och i texten' +
      (vol.length ? ", eller, för produktion och priser, när nästa rapport visar samma tal som jämförelse" : "") + ". Staplar och linjer visar de senaste kvartalen." +
      (vol.some(function (x) { return x.kind === "pris"; }) ? " Priserna är de metallpriser som bolaget själv redovisar i rapporten." : "") + "</p>" +
      '<p class="kq-link"><a href="' + esc(k.url) + '" target="_blank" rel="noopener">Källa: ' + esc(k.title) + " (" + dateText(k.date) + ") ↗</a></p></div>";
  }

  function companySection(isin, name, sector) {
    // Svenska bolag (scripts/build-companies.py) och amerikanska (scripts/build-us-companies.py, ur SEC)
    if (!needCompanyIndex() || !state.companyIndex[isin]) return "";
    if (!needCompany(isin)) return failed("bolag-" + isin) ? "" : '<section class="block section-gap">' + loadingBlock("Laddar fakta om bolaget…") + "</section>";
    var c = state.companies[isin], r = c.report || null, f = c.facts || {}, q = c.q || null;
    var us = c.src === "sec";
    var cur = r ? r.cur : us ? "USD" : "SEK", fin = r ? r.fin || {} : {};
    var now = function (k) { return fin[k] ? fin[k][0] : null; };
    var before = function (k) { return fin[k] ? fin[k][1] : null; };
    var short = c.short || companyShort(name);
    // Banker och investmentbolag har inte "försäljning" i vanlig mening, så de siffrorna visas inte för dem.
    // De amerikanska bankerna och försäkringsbolagen känns igen på SEC:s branschkod (inte Visa och Mastercard).
    var finance = us ? !!c.bank : sector === "Finans";
    var rev = finance ? null : now("rev"), ebit = now("ebit"), net = now("net");
    var yearNow = new Date().getFullYear();

    var html = '<section class="block section-gap know"><div class="block-head"><h2>Lär känna ' + esc(short) + '</h2><span class="note">Bolaget på en minut</span></div>';

    // Om bolaget: bolagets egen beskrivning och fakta
    var about = c.about;
    var facts = [];
    if (f.founded) facts.push(["Grundat", f.founded + ' <span class="muted">(' + (yearNow - f.founded) + " år sedan)</span>"]);
    if (f.hq) facts.push(["Huvudkontor", esc(f.hq)]);
    if (f.employees) facts.push(["Anställda", "ca " + int(f.employees[0]) + (f.employees[1] && +f.employees[1] < yearNow - 1 ? ' <span class="muted">(' + f.employees[1] + ")</span>" : "")]);
    if (f.ceo) facts.push(["Vd", esc(f.ceo)]);
    if (f.industry) facts.push(["Bransch", esc(f.industry)]);
    if (f.list) facts.push(["Handlas på", esc(f.list)]);
    if (f.ticker && f.ticker.length) facts.push([f.ticker.length > 1 ? "Kortnamn" : "Kortnamn på börsen", esc(f.ticker.join(" och "))]);
    if (f.inc) facts.push(["Registrerat i", "delstaten " + esc(f.inc)]);
    if (f.fye) facts.push(["Räkenskapsåret slutar", "i " + esc(f.fye)]);
    if (f.web) facts.push(["Webbplats", '<a href="' + esc(f.web) + '" target="_blank" rel="noopener">' + esc(f.web.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")) + "</a>"]);
    if (about || facts.length) {
      html += '<div class="know-card">' +
        (about ? '<p class="know-about">' + esc(about.text) + (about.url ? ' <a class="src" href="' + esc(about.url) + '" target="_blank" rel="noopener">' +
          (about.src === "pm" ? "Bolagets egen beskrivning" : about.src === "sec" ? "Bolagets rapporter hos SEC" : "Ur årsredovisningen") + " ↗</a>" : "") + "</p>" : "") +
        (facts.length ? '<dl class="know-facts">' + facts.map(function (x) { return "<div><dt>" + x[0] + "</dt><dd>" + x[1] + "</dd></div>"; }).join("") + "</dl>" : "") +
        "</div>";
    }

    // Investment- och fastighetsbolag: substansvärde, rabatt och belåningsgrad
    html += navCard(c.nav, short, f.industry);

    // Senaste kvartalsrapporten
    if (q) {
      var qcur = q.cur, per = q.p ? periodText(q.p, q.m) : "", qrev = finance || !q.rev ? null : q.rev;
      var g = qrev ? change(qrev[0], qrev[1]) : null;
      var lead = [];
      if (qrev && qrev[0] > 0) {
        lead.push("Under " + per + " sålde " + esc(short) + " för " + money(qrev[0], qcur) +
          (g != null ? ", " + (Math.abs(g) < 0.005 ? "lika mycket som" : nf0.format(Math.abs(g) * 100) + " % " + (g > 0 ? "mer än" : "mindre än")) + " samma period året innan." : "."));
      }
      if (qrev && qrev[0] > 0 && q.ebit && q.ebit[0] != null && Math.abs(q.ebit[0]) <= qrev[0]) {
        var m0 = q.ebit[0] / qrev[0], m1 = q.ebit[1] != null && qrev[1] > 0 ? q.ebit[1] / qrev[1] : null;
        var cw = curWord(qcur);
        lead.push(m0 >= 0 ? "Av varje 100 " + cw + " blev " + nf0.format(m0 * 100) + " " + cw + " rörelsevinst" + (m1 != null ? " (" + nf0.format(Math.max(0, m1) * 100) + " " + cw + " ett år tidigare)." : ".")
          : "Rörelseresultatet var negativt: verksamheten gick med förlust.");
      } else if (q.net && q.net[0] != null) {
        lead.push(q.net[0] >= 0 ? "Bolaget gick med vinst." : "Bolaget gick med förlust.");
      }
      var qt = [];
      var qtile = function (big, label, sub, klass) {
        qt.push('<div class="know-tile"><div class="kt-big' + (klass ? " " + klass : "") + '">' + big + '</div><div class="kt-label">' + label + "</div>" + (sub ? '<div class="kt-sub">' + sub + "</div>" : "") + "</div>");
      };
      var was = function (pair, fmt) { return pair[1] != null ? "Ett år tidigare " + fmt(pair[1], qcur) : ""; };
      if (qrev && qrev[0] != null) qtile(money(qrev[0], qcur), "försäljning", g != null ? '<span class="' + cls(g) + '">' + pct(g) + "</span> mot samma period i fjol" : was(qrev, money));
      if (q.ebit && q.ebit[0] != null) qtile(money(q.ebit[0], qcur), "rörelseresultat", was(q.ebit, money), q.ebit[0] < 0 ? "neg" : "");
      if (q.net && q.net[0] != null) qtile(money(q.net[0], qcur), q.net[0] >= 0 ? "vinst efter skatt" : "förlust efter skatt", was(q.net, money), q.net[0] < 0 ? "neg" : "");
      if (q.eps && q.eps[0] != null) qtile(perShare(q.eps[0], qcur), "resultat per aktie", was(q.eps, perShare), q.eps[0] < 0 ? "neg" : "");
      // Orderingång: nya beställningar under kvartalet, orderstock: beställt men inte levererat än
      var ord = q.orders || {};
      if (ord["in"]) {
        var og = change(ord["in"][0], ord["in"][1]);
        qtile(money(ord["in"][0], qcur), "nya order (orderingång)", og != null ? '<span class="' + cls(og) + '">' + pct(og) + "</span> mot samma period i fjol" : "");
        if (qrev && qrev[0] > 0) {
          var bb = ord["in"][0] / qrev[0];
          lead.push(bb >= 1.05 ? "Bolaget fick in fler nya beställningar än det levererade, vilket brukar betyda att försäljningen kan fortsätta växa."
            : bb <= 0.95 ? "Bolaget fick in färre nya beställningar än det levererade, så orderböckerna krymper något." : "Nya beställningar och leveranser var ungefär lika stora.");
        }
      }
      if (ord.book) {
        var months = qrev && qrev[0] > 0 ? ord.book[0] / qrev[0] * (q.m || 3) : null;
        qtile(money(ord.book[0], qcur), "i orderstock", months != null && months >= 1 ? "Beställt men inte levererat, motsvarar ungefär " + nf0.format(months) + " månaders försäljning" : "Beställt men inte levererat än");
      }
      if (q.organic != null && qrev) lead.splice(1, 0, "Räknat utan förvärv och valutaeffekter (organiskt) " + (q.organic >= 0 ? "växte försäljningen med " : "minskade försäljningen med ") + nf0.format(Math.abs(q.organic)) + " %.");
      if (q.cash && q.cash[0] != null) qtile(money(q.cash[0], qcur), "kassaflöde från verksamheten", "Pengar som den vanliga verksamheten drog in" + (q.cash[1] != null ? ". Ett år tidigare " + money(q.cash[1], qcur) : ""), q.cash[0] < 0 ? "neg" : "");
      // Bankernas egna mått, förklarade
      var bk = q.bank || {};
      if (bk.roe != null) qtile(nf1.format(bk.roe) + " %", "avkastning på eget kapital", "Årets vinst i procent av eget kapital", bk.roe < 0 ? "neg" : "");
      if (bk.ci != null) qtile(nf2.format(bk.ci), "kostnad per intjänad krona", "Banken har " + nf0.format(bk.ci * 100) + " öre i kostnader för varje krona den tjänar in. Lägre är bättre.");
      if (bk.cet1 != null) qtile(nf1.format(bk.cet1) + " %", "kapitalbuffert (kärnprimärkapital)", "Bankens buffert mot förluster i förhållande till utlåningens risk. Högre är tryggare.");
      var charts = "", insights = [];
      if (c.qs) {
        charts = (finance ? "" : quarterBars(c.qs, 1, "Försäljning", qcur)) + quarterBars(c.qs, finance ? 3 : 2, finance ? "Resultat" : "Rörelseresultat", qcur);
        insights = quarterInsights(c.qs, qcur, short, finance);
      }
      var insHtml = insights.length ? '<div><h4 class="kq-sub">Det här visar kvartalen</h4><ul class="know-ins">' + insights.map(function (x) {
        return '<li class="' + x.tone + '"><span class="ki-dot" aria-hidden="true"></span>' + x.text + "</li>";
      }).join("") + "</ul></div>" : "";
      var evHtml = q.events && q.events.length ? '<div><h4 class="kq-sub">Viktigt som hänt</h4><ul class="know-ins events">' + q.events.map(function (x) {
        return '<li><span class="ki-dot" aria-hidden="true"></span>' + esc(x.replace(/^[·•●–-]\s*/, "")) + "</li>";
      }).join("") + "</ul></div>" : "";
      var voice = (q.quote && f.ceo ? '<blockquote class="know-quote"><p>”' + esc(q.quote) + '”</p><footer>' + esc(f.ceo) + ", vd</footer></blockquote>" : "") +
        (q.outlook ? '<h4 class="kq-sub">Bolaget om framtiden</h4><p class="know-outlook">' + esc(q.outlook) + "</p>" : "");
      var pair = function (a, b) { return a && b ? '<div class="kq-split">' + a + "<div>" + b + "</div></div>" : a || b; };
      // Snabbkoll
      var sc = [], yes = function (v, txt) { return v > 0 ? "Ja, " + txt : v < 0 ? "Nej, " + txt : "Oförändrat"; };
      if (g != null) sc.push({ q: "Växte försäljningen?", a: yes(g, pct(g)), tone: cls(g) });
      var eg = q.ebit && q.ebit[1] != null && q.ebit[0] != null ? q.ebit[0] - q.ebit[1] : null;
      if (eg != null && !finance) sc.push({ q: "Ökade rörelseresultatet?", a: q.ebit[1] > 0 ? yes(eg, pct(q.ebit[0] / q.ebit[1] - 1)) : (eg > 0 ? "Ja, förbättrades" : "Nej, försämrades"), tone: cls(eg) });
      var ng = q.net && q.net[1] != null && q.net[0] != null ? q.net[0] - q.net[1] : null;
      if (ng != null && (finance || eg == null)) sc.push({ q: "Ökade vinsten?", a: q.net[1] > 0 ? yes(ng, pct(q.net[0] / q.net[1] - 1)) : (ng > 0 ? "Ja, förbättrades" : "Nej, försämrades"), tone: cls(ng) });
      if (qrev && qrev[0] > 0 && qrev[1] > 0 && q.ebit && q.ebit[0] != null && q.ebit[1] != null) {
        var md = q.ebit[0] / qrev[0] - q.ebit[1] / qrev[1];
        sc.push({ q: "Blev lönsamheten bättre?", a: Math.abs(md) < 0.005 ? "Ungefär samma" : (md > 0 ? "Ja, " : "Nej, ") + nf0.format(q.ebit[0] / qrev[0] * 100) + " % marginal (" + nf0.format(q.ebit[1] / qrev[1] * 100) + " %)", tone: Math.abs(md) < 0.005 ? "" : cls(md) });
      }
      if (ord["in"] && ord["in"][1]) { var oc = ord["in"][0] / ord["in"][1] - 1; sc.push({ q: "Fler nya order?", a: yes(oc, pct(oc)), tone: cls(oc) }); }
      if (q.cash && q.cash[0] != null) sc.push({ q: "Drog verksamheten in pengar?", a: q.cash[0] > 0 ? "Ja, " + money(q.cash[0], qcur) : "Nej, " + money(q.cash[0], qcur), tone: q.cash[0] > 0 ? "pos" : "neg" });
      if (q.react != null) sc.push({ q: "Gillade börsen rapporten?", a: (q.react > 0 ? "Ja, aktien steg " : q.react < 0 ? "Nej, aktien föll " : "Aktien stod still ") + fixMinus(nf1.format(Math.abs(q.react))) + " %", tone: cls(q.react) });
      var thHtml = themesHtml(q.themes, q.tone);
      html += '<div class="know-card know-q"><div class="kq-head"><h3>Senaste rapporten' + (per ? ' <span class="kq-per">' + per + "</span>" : "") + '</h3><span class="kq-date">Publicerad ' + dateText(q.date) +
        // när bolagets sida på MFN senast lästes: en nyare rapport hade synts här
        (c.checked && c.checked >= q.date ? '<span class="kq-checked" title="Fondinsyn läser bolagens pressmeddelanden på MFN flera gånger i veckan och samma dag som kalendern säger att en rapport kommer"> · senast kontrollerad ' + shortStamp(c.checked) + "</span>" : "") +
        "</span></div>" +
        (headlineText(q.headline) ? '<p class="kq-headline">”' + esc(headlineText(q.headline)) + "”</p>" : "") +
        // rapporten kom, men dess siffror gick inte att läsa ut på ett säkert sätt: hellre inga siffror än fel siffror
        (q.noNumbers ? '<p class="know-lead muted">Siffrorna i den här rapporten gick inte att läsa ut automatiskt på ett säkert sätt, så de visas inte här. De står i rapporten, som det finns en länk till nedan.</p>' : "") +
        quickTake(c, q, finance, short) +
        scoreCard(sc) +
        (lead.length ? '<p class="know-lead">' + lead.join(" ") + "</p>" : "") +
        (qt.length ? '<div class="know-tiles in-card">' + qt.join("") + "</div>" : "") +
        pair(charts ? '<div class="qb-charts">' + charts + "</div>" : "", (c.qs && !finance && marginLine(c.qs) ? '<div class="qb-charts">' + marginLine(c.qs) + "</div>" : "") + insHtml) +
        pair(evHtml, voice) +
        (thHtml ? '<div class="kq-split th-split">' + thHtml + "</div>" : "") +
        '<p class="kq-link"><a href="' + esc(q.url) + '" target="_blank" rel="noopener">Läs hela rapporten: ' + esc(q.title) + " ↗</a></p></div>";
    }

    // Branschens nyckeltal ur rapporten
    html += kpiCard(c.kpi, short, q ? q.cur : cur);

    // Kalendern: nästa rapport, årsstämman och utdelningen
    var cal = c.cal || {}, calItems = [];
    // Amerikanska bolag: beräknat utifrån när bolaget rapporterade samma kvartal förra året (est)
    if (cal.next) calItems.push([cal.est ? "Nästa rapport väntas" : "Nästa rapport", (cal.est ? "omkring " : "") + dateText(cal.next[0]) + ' <span class="muted">(' +
      esc(cal.next[1].replace(/\s+\d{4}(-Q\d)?$/, "").toLowerCase()) + (cal.est ? ", beräknat utifrån förra året" : "") + ")</span>"]);
    if (cal.agm) calItems.push(["Årsstämma", dateText(cal.agm)]);
    if (cal.div && cal.div.length) {
      // Allt som betalats ut (eller ska betalas ut) det senaste året, även när utdelningen delas upp på flera tillfällen
      var lastDate = cal.div[cal.div.length - 1][0], dcur = cal.div[0][2];
      var cutoff = new Date(new Date(lastDate).getTime() - 330 * 864e5).toISOString().slice(0, 10);
      var divs = cal.div.filter(function (d) { return d[0] > cutoff; });
      var sumOf = function (list) { return list.reduce(function (a, d) { return a + d[1]; }, 0); };
      var all = sumOf(divs), extra = sumOf(divs.filter(function (d) { return d[3] !== "ord"; }));
      var times = divs.map(function (d) { return d[0]; }).filter(function (d, i, a) { return a.indexOf(d) === i; }).length;
      calItems.push(["Utdelning per aktie, senaste året", perShare(all, dcur) + ' <span class="muted">(' + (extra > 0 ? "varav " + perShare(extra, dcur) + " extra, " : "") +
        (times > 1 ? "i " + times + " omgångar, " : "") + (lastDate >= new Date().toISOString().slice(0, 10) ? "nästa x-dag " : "senast x-dag ") + dateText(lastDate) + ")</span>"]);
    }
    if (calItems.length) {
      html += '<dl class="know-cal">' + calItems.map(function (x) { return "<div><dt>" + x[0] + "</dt><dd>" + x[1] + "</dd></div>"; }).join("") + "</dl>";
    }
    // Börsens reaktion på rapporterna och utdelningen genom åren, sida vid sida
    var duo = [];
    if (c.reacts && c.reacts.length >= 2) duo.push(reactCard(c.reacts, short));
    if (cal.divHist) { var dc = dividendCard(cal.divHist, cal.divHist.length && cal.div && cal.div[0] ? cal.div[0][2] : us ? "USD" : "SEK", short, us); if (dc) duo.push(dc); }
    if (duo.length) html += '<div class="know-grid' + (duo.length === 1 ? " one" : "") + '">' + duo.join("") + "</div>";

    // Affärsområden (senaste kvartalet om rapporten har dem, annars helåret ur årsredovisningen) och marknader
    var cards = [];
    var qseg = !finance && c.qseg && q ? c.qseg : null;
    var seg = qseg || (!finance && r && r.seg);
    var segCur = qseg ? q.cur : cur, segWhen = qseg ? capFirst(periodText(qseg.p, qseg.m)) : "Helåret " + (r ? r.fy : "");
    if (seg) {
      var items = seg.items.map(function (x) { return { name: x[0], rev: x[1], profit: x[2], share: x[3], margin: x[4], other: !!x[5] }; })
        .sort(function (a, b) { return (a.other - b.other) || (b.share - a.share); });
      var main = items.filter(function (x) { return !x.other; });
      var biggest = main[0];
      var withMargin = main.filter(function (x) { return x.margin != null; });
      var best = withMargin.length >= 2 ? withMargin.slice().sort(function (a, b) { return b.margin - a.margin; })[0] : null;
      var hundred = function (x) { return nf0.format(Math.max(0, x.margin) * 100) + " kronor"; };
      var segLead = esc(biggest.name) + " är störst och står för " + shareWords(biggest.share) + " av försäljningen.";
      if (best && best.margin > 0) {
        segLead += best === biggest ? " Det är också det mest lönsamma affärsområdet: av varje 100 kronor det säljer för blir " + hundred(best) + " vinst."
          : " Mest lönsamt är " + esc(best.name) + ": av varje 100 kronor det säljer för blir " + hundred(best) + " vinst.";
      }
      var metricNote = seg.metric && !/^rörelseresultat$/i.test(seg.metric) ? " Vinsten är bolagets mått " + esc(seg.metric.toLowerCase()) + "." : "";
      cards.push('<div class="know-card"><h3>Så tjänar ' + esc(short) + " pengar</h3>" +
        '<p class="know-lead">' + segLead + metricNote + ' <span class="muted">' + segWhen + ".</span></p>" +
        '<ul class="know-rows">' + items.map(function (x) {
          var badges = (x === biggest ? '<span class="kr-badge big">Störst</span>' : "") + (x === best && best.margin > 0 ? '<span class="kr-badge best">Mest lönsamt</span>' : "");
          var sub = [];
          if (x.rev != null) sub.push((qseg ? "Sålde för " : "Säljer för ") + money(x.rev, segCur));
          if (x.margin != null) sub.push(x.margin < 0 ? '<span class="neg">Går med förlust</span>' : "Vinstmarginal " + nf0.format(x.margin * 100) + " %");
          return '<li class="kr-row' + (x.other ? " other" : "") + '"><div class="kr-top"><span class="kr-name">' + esc(x.name) + badges + '</span><span class="kr-val">' + nf0.format(x.share * 100) + " %</span></div>" +
            '<div class="kr-bar"><span style="width:' + Math.max(1, x.share * 100).toFixed(1) + '%"></span></div>' +
            (sub.length ? '<div class="kr-sub">' + sub.join(" · ") + "</div>" : "") + "</li>";
        }).join("") + "</ul></div>");
    }
    if (r && r.geo && r.geo.length && !finance) {
      var total = r.geo.reduce(function (a, g) { return a + g[1]; }, 0);
      var places = r.geo.filter(function (g) { return !/^Övriga länder$/.test(g[0]); });
      var top = places.slice(0, 7), rest = total - top.reduce(function (a, g) { return a + g[1]; }, 0);
      var rows = top.map(function (g) { return { name: g[0], share: g[1] / total }; });
      if (rest / total >= 0.005) rows.push({ name: places.length > 7 ? "Övriga länder" : "Övrigt", share: rest / total, other: true });
      var first = rows[0];
      var se = places.filter(function (g) { return g[0] === "Sverige"; })[0];
      var geoLead = "Största marknaden är " + esc(first.name) + " med " + shareWords(first.share) + " av försäljningen.";
      if (se && se[1] / total < 0.15 && first.name !== "Sverige") geoLead += " Bara " + nf0.format(Math.max(1, se[1] / total * 100)) + " % säljs i Sverige.";
      cards.push('<div class="know-card"><h3>Här säljer ' + esc(short) + "</h3>" +
        '<p class="know-lead">' + geoLead + ' <span class="muted">Helåret ' + r.fy + ".</span></p>" +
        '<ul class="know-rows">' + rows.map(function (x) {
          return '<li class="kr-row' + (x.other ? " other" : "") + '"><div class="kr-top"><span class="kr-name">' + esc(x.name) + '</span><span class="kr-val">' + nf0.format(x.share * 100) + " %</span></div>" +
            '<div class="kr-bar"><span style="width:' + Math.max(1, x.share * 100).toFixed(1) + '%"></span></div></li>';
        }).join("") + "</ul></div>");
    }
    if (cards.length) html += '<div class="know-grid' + (cards.length === 1 ? " one" : "") + '">' + cards.join("") + "</div>";

    // Helåret i siffror som går att förstå utan att kunna läsa en årsredovisning
    var tiles = [];
    var tile = function (big, label, sub, klass) {
      tiles.push('<div class="know-tile"><div class="kt-big' + (klass ? " " + klass : "") + '">' + big + '</div><div class="kt-label">' + label + "</div>" + (sub ? '<div class="kt-sub">' + sub + "</div>" : "") + "</div>");
    };
    if (rev > 0) {
      var perSec = rev / (365 * 24 * 3600);
      tile(perSec >= 10 ? smallMoney(perSec, cur) : money(rev / 365, cur), perSec >= 10 ? "säljer de för varje sekund" : "säljer de för varje dag",
        money(rev, cur) + " under " + fyName(r));
    }
    if (net != null && (rev || finance)) {
      tile(money(Math.abs(net) / 365, cur), net >= 0 ? "i vinst varje dag" : "i förlust varje dag", "Årets resultat " + money(net, cur), net < 0 ? "neg" : "");
    }
    var growth = rev > 0 && before("rev") > 0 ? rev / before("rev") - 1 : null;
    if (growth != null) tile(pct(growth), "försäljningen jämfört med " + fyName(r, 1), growth >= 0 ? "Bolaget växte" : "Försäljningen minskade", cls(growth));
    var dps = now("dps");
    if (dps > 0) tile(perShare(dps, cur).replace(/,00 /, " "), "i utdelning per aktie", "Äger du 100 aktier får du " + smallMoney(dps * 100, cur));
    if (rev > 0 && f.employees && f.employees[0] > 0 && (!f.employees[1] || +f.employees[1] >= r.fy - 2)) {
      tile(money(rev / f.employees[0], cur), "i försäljning per anställd", "Med ca " + int(f.employees[0]) + " anställda");
    }
    if (tiles.length) html += '<h3 class="know-h">' + capFirst(fyText(r)) + " i vardagliga mått</h3>" + '<div class="know-tiles">' + tiles.slice(0, 5).join("") + "</div>";

    // Årsredovisningarna år för år: lönsamhet för alla, kassaflöde och utdelning inte för banker och försäkringsbolag
    var h = r && r.hist && r.hist.fy && r.hist.fy.length && r.hist.fy[r.hist.fy.length - 1] === (r.fyl || r.fy) ? r.hist : null, hl = h ? h.fy.length - 1 : -1;
    if (h) {
      html += profitCard(h, short, finance, cur);
      var cc = finance ? [] : [cashCard(h, short, cur, r.custFin), coverCard(h, short, cur)].filter(Boolean);
      if (cc.length) html += '<div class="know-grid' + (cc.length === 1 ? " one" : "") + '">' + cc.join("") + "</div>";
      // Värderingen: inte för banker, försäkrings-, investment- och fastighetsbolag (deras kassaflöden säger lite om värdet),
      // inte för bolag med finansieringsverksamhet (Volvo) och bara för svenska aktier (kursen från Nasdaq Stockholm)
      if (!finance && !us && !c.nav && !r.custFin && f.industry !== "Förvaltning" && f.industry !== "Investeringar") html += valuationCard(c, isin, h, short, cur);
    }

    // Hur bolaget är finansierat: eget kapital mot lån och andra skulder (banker har alltid lite eget kapital, så inte för dem)
    var eq = now("equity"), assets = now("assets");
    if (!finance && eq != null && assets > 0 && eq <= assets) {
      // Nettoskuld: räntebärande skulder (lån och leasingskulder) minus likvida medel
      var debtNow = h ? hv(h, "debt", hl) : null, cashNow = h ? hv(h, "cash", hl) : null;
      var nd = debtNow != null && cashNow != null ? debtNow - cashNow : null, gear = nd != null && eq > 0 ? nd / eq : null;
      var fcfNow = h ? histFcf(h, hl) : null;
      var debtText = nd == null ? "" : " Räntebärande skulder (lån och leasingskulder) är " + money(debtNow, cur) + " och likvida medel " + money(cashNow, cur) + ". " +
        (nd > 0 ? "Nettoskulden är alltså " + money(nd, cur) + (fcfNow > 0 ? ", vilket motsvarar ungefär " + nf1.format(nd / fcfNow).replace(/,0$/, "") + " års fritt kassaflöde." : ".")
          : "Bolaget har alltså mer pengar i kassan än lån, en nettokassa på " + money(-nd, cur) + ".");
      var debtTiles = nd == null ? "" : '<div class="know-tiles in-card fin-tiles">' +
        '<div class="know-tile"><div class="kt-big">' + money(Math.abs(nd), cur) + '</div><div class="kt-label">' + (nd > 0 ? "nettoskuld" : "nettokassa") + '</div><div class="kt-sub">' +
          (nd > 0 ? "Lån och leasingskulder minus likvida medel" : "Mer likvida medel än lån och leasingskulder") + "</div></div>" +
        (gear != null ? '<div class="know-tile"><div class="kt-big">' + fixMinus(nf2.format(gear)) + '</div><div class="kt-label">skuldsättningsgrad (netto)</div><div class="kt-sub">Nettoskulden delad med eget kapital. ' +
          (gear < 0 ? "Under noll: nettokassa." : gear < 0.5 ? "Under 0,5 räknas oftast som låg." : gear < 1 ? "Mellan 0,5 och 1 räknas oftast som måttlig." : "Över 1: lånen är större än ägarnas pengar i bolaget.") + "</div></div>" : "") +
        '<div class="know-tile"><div class="kt-big">' + nf0.format(Math.max(0, eq / assets) * 100) + ' %</div><div class="kt-label">soliditet</div><div class="kt-sub">Eget kapital i procent av tillgångarna</div></div>' +
        "</div>";
      var share = eq / assets, debt = 1 - Math.max(0, share);
      var eqBefore = before("equity") != null && before("assets") > 0 ? before("equity") / before("assets") : null;
      var verdict = share < 0 ? "Bolaget har mer skulder än tillgångar (negativt eget kapital), vilket är en varningssignal."
        : share >= 0.5 ? "Soliditeten är hög: bolaget har marginal om det blir sämre tider."
        : share >= 0.3 ? "Det är en vanlig soliditet för ett börsbolag."
        : "Soliditeten är låg: bolaget är beroende av lånefinansiering och känsligare om det blir sämre tider.";
      html += '<div class="know-card know-fin"><h3>Hur finansierar ' + esc(short) + " sina tillgångar?</h3>" +
        '<p class="know-lead">Bolagets tillgångar uppgår till ' + money(assets, cur) + " (anläggningar, varulager, kundfordringar, likvida medel med mera). " +
        (share >= 0 ? nf0.format(share * 100) + " % är finansierat med eget kapital, alltså ägarnas pengar i bolaget, och " + nf0.format(debt * 100) + " % med skulder. Andelen eget kapital kallas soliditet. " : "") +
        verdict + (eqBefore != null && Math.abs(share - eqBefore) >= 0.03 ? " Ett år tidigare var soliditeten " + nf0.format(eqBefore * 100) + " %." : "") + debtText +
        ' <span class="muted">' + capFirst(fyText(r)) + ".</span></p>" +
        (share >= 0 ? '<div class="fin-bar" role="img" aria-label="' + nf0.format(share * 100) + ' % eget kapital, ' + nf0.format(debt * 100) + ' % skulder">' +
          '<span class="fin-eq" style="width:' + (share * 100).toFixed(1) + '%"></span><span class="fin-debt" style="width:' + (debt * 100).toFixed(1) + '%"></span></div>' +
          '<div class="fin-legend"><span><i class="fin-eq"></i>Eget kapital ' + money(eq, cur) + '</span><span><i class="fin-debt"></i>Skulder ' + money(assets - eq, cur) + "</span></div>" : "") + debtTiles +
        "</div>";
    }

    // Placering bland alla bolag på sajten
    var rk = c.rank || {}, ranks = [];
    var place = function (x, what) { return x && x[0] <= Math.max(25, x[1] * 0.1) ? "nr " + x[0] + " " + what : null; };
    [place(!finance && rk.rev, "i försäljning"), place(rk.emp, "i antal anställda"), place(rk.age, "bland de äldsta")].forEach(function (x) { if (x) ranks.push(x); });
    if (ranks.length) html += '<p class="know-rank">Bland de ' + (us ? "amerikanska" : "svenska") + " bolagen på Fondinsyn: " + ranks.join(", ") + ".</p>";

    if (us) {
      var usSrc = [];
      if (q && q.url) usSrc.push('<a href="' + esc(q.url) + '" target="_blank" rel="noopener">' + (/10-K/.test(q.title) ? "årsrapporten (10-K)" : "kvartalsrapporten (10-Q)") + "</a>");
      if (r && r.url && (!q || r.url !== q.url)) usSrc.push('<a href="' + esc(r.url) + '" target="_blank" rel="noopener">årsrapporten (10-K) för ' + fyText(r) + "</a>");
      if (c.about && c.about.url) usSrc.push('<a href="' + esc(c.about.url) + '" target="_blank" rel="noopener">alla bolagets rapporter hos SEC</a>');
      html += '<p class="know-src">Källor: ' + usSrc.join(", ") + ". Allt kommer från bolagets egna rapporter till SEC och läses automatiskt ur deras maskinläsbara siffror (XBRL)." +
        " Bolagen lämnar ingen egen rapport för det fjärde kvartalet, så det räknas fram som helåret minus årets tre första kvartal, och kvartalens kassaflöde på samma sätt." +
        (cal.est ? " Nästa rapportdag är beräknad utifrån när bolaget rapporterade samma kvartal förra året." : "") + "</p>";
      return html + "</section>";
    }
    var src = [];
    if (q) src.push('<a href="' + esc(q.url) + '" target="_blank" rel="noopener">kvartalsrapporten</a>');
    if (r) src.push((r.url ? '<a href="' + esc(r.url) + '" target="_blank" rel="noopener">årsredovisningen ' + r.fy + "</a>" : "årsredovisningen " + r.fy));
    if (c.mfn) src.push('<a href="https://mfn.se/all/a/' + encodeURIComponent(c.mfn) + '" target="_blank" rel="noopener">bolagets pressmeddelanden och kalender på MFN</a>');
    html += '<p class="know-src">Källor: ' + src.join(", ") + ". Allt kommer från bolagets egna rapporter och pressmeddelanden. Siffrorna läses automatiskt och visas bara när de" +
      " stämmer med pressmeddelandet eller med bolagets totala omsättning.</p>";
    return html + "</section>";
  }

  // ---------- Fonder ----------

  var fundFilter = { q: "", co: "", type: "" };

  function fundList() {
    var d = quarterData();
    return Object.keys(d.fi).map(function (id) { return d.fi[id]; });
  }

  function viewFunds() {
    document.title = "Fonder – innehav, avgifter och affärer – Fondinsyn";
    var ds = marketDs();
    if (!ds) return failed("world-" + state.q) ? errorBlock() : loadingBlock("Laddar globala aktier…");
    var cos = {};
    fundList().forEach(function (f) { cos[f.co] = 1; });
    var coOpts = Object.keys(cos).sort(function (a, b) { return a.localeCompare(b, "sv"); }).map(function (x) {
      return '<option value="' + esc(x) + '"' + (fundFilter.co === x ? " selected" : "") + ">" + esc(x) + "</option>";
    }).join("");
    var opt = function (o) { return '<option value="' + o[0] + '"' + (fundFilter.type === o[0] ? " selected" : "") + ">" + o[1] + "</option>"; };
    var typeOpts = opt(["", "Alla fonder"]) +
      '<optgroup label="Aktiefonder">' + [["equity", "Alla aktiefonder"], ["active", "Aktiva aktiefonder"], ["index", "Indexfonder"], ["closet", "Indexnära med hög avgift"]].map(opt).join("") + "</optgroup>" +
      '<optgroup label="Andra fonder">' + [["rante", "Räntefonder"], ["bland", "Blandfonder"], ["fof", "Fondandelsfonder"]].map(opt).join("") + "</optgroup>";
    return '<div class="page-head"><div class="title-row"><h1>Fonder</h1><a class="btn hide-sm" href="#/fondbolag">Alla fondbolag</a></div><p class="meta">Alla svenska värdepappersfonder, ' + quarterLabel(state.q) + ". Köp och sälj avser " + marketWord() + " aktier.</p></div>" +
      '<div class="toolbar">' +
      '<input class="input" type="search" id="fundSearch" aria-label="Filtrera fonderna" placeholder="Sök fond eller fondbolag" value="' + esc(fundFilter.q) + '" autocomplete="off">' +
      '<select class="select-sm" id="fundType" aria-label="Typ av fond">' + typeOpts + "</select>" +
      '<select class="select-sm" id="fundCo" aria-label="Fondbolag"><option value="">Alla fondbolag</option>' + coOpts + "</select>" +
      '<span class="count" id="fundCount"></span></div><div id="fundTable"></div>';
  }

  // Blandfonder mäts mot blandade index och hör inte hemma i jämförelsen av aktiefonder
  var MIXED_RE = /balanser|generation|stratega|\bmix|fokus \d|pension|flex|ränt|obligation|allokering|försiktig|offensiv \d/i;

  function fundCategory(f) {
    if (f.isIndex) return "index";
    if (f.eq == null || f.eq < 0.8 || MIXED_RE.test(f.name)) return "other";
    if (f.ar === 0) return "other"; // 0,0 betyder i praktiken att uppgiften saknas
    if (f.ar != null && f.ar < CLOSET_AR && f.feeMax != null && f.feeMax >= CLOSET_FEE) return "closet";
    return "active";
  }

  function renderFundTable() {
    var ds = marketDs();
    if (!ds || !$("fundTable")) return;
    var q = fundFilter.q.trim().toLowerCase();
    // Fondtyp (ränte-, bland- och fondandelsfonder) bygger på räntedatan, som laddas vid behov
    var KINDS = { equity: 1, rante: 1, bland: 1, fof: 1 }, kind = KINDS[fundFilter.type] ? fundFilter.type : "";
    if (kind && !needRates()) {
      $("fundTable").innerHTML = failed("rates-" + state.q) ? '<p class="notice">Fondtyperna kunde inte laddas för ' + quarterLabel(state.q) + ".</p>" : loadingBlock();
      $("fundCount").textContent = "";
      return;
    }
    if (kind === "rante" || kind === "fof") { renderKindTable(kind, q); return; }
    var rows = fundList().filter(function (f) {
      if (state.excludeIndex && f.isIndex) return false;
      if (fundFilter.co && f.co !== fundFilter.co) return false;
      if (kind) { if (fundKind(f) !== kind) return false; }
      else if (fundFilter.type && fundCategory(f) !== fundFilter.type) return false;
      return !q || f.name.toLowerCase().indexOf(q) >= 0 || f.co.toLowerCase().indexOf(q) >= 0;
    }).map(function (f) { return { f: f, m: ds.fundById[f.id] }; });
    var mv = function (r) { return r.m ? r.m.val : 0; };
    var net = function (r) { return r.m && r.m.both ? r.m.bought + r.m.sold : null; };
    var cols = [
      { key: "name", label: "Fond", align: "l", cls: "name", value: function (r) { return r.f.name; }, cell: function (r) {
        var c = fundCategory(r.f);
        return nameCell(fundHref(r.f), r.f.name, esc(r.f.co) + " · " + feeText(r.f)) +
          (c === "index" && !/index/i.test(r.f.name) ? ' <span class="label hide-sm">Index</span>' : "") +
          (c === "closet" ? ' <span class="label warn hide-sm" title="Låg aktiv risk men hög avgift">Indexnära</span>' : "");
      } },
      { key: "co", label: "Fondbolag", align: "l", cls: "muted", hideSm: true, cell: function (r) { return companyLink(r.f.co); }, value: function (r) { return r.f.co; } },
      { key: "aum", label: "Förmögenhet (mkr)", hideSm: true, cell: function (r) { return mkr(r.f.aum); }, value: function (r) { return r.f.aum; } },
      { key: "fee", label: "Avgift", hideSm: true, cell: function (r) { return r.f.feeMax == null ? "–" : nf2.format(r.f.feeMax) + " %"; }, value: function (r) { return r.f.feeMax; } },
      { key: "ar", label: "Aktiv risk", hideSm: true, cell: function (r) { return pctPlain(r.f.ar); }, value: function (r) { return r.f.ar; } },
      { key: "mv", label: (state.market === "se" ? "Sv." : "Utl.") + " aktier (mkr)", cell: function (r) { return mv(r) ? mkr(mv(r)) : "–"; }, value: mv },
      { key: "net", label: "Netto (mkr)", cell: function (r) { var v = net(r); return v == null ? "–" : '<span class="' + cls(v) + '">' + mkr(v, true) + "</span>"; }, value: net }
    ];
    $("fundTable").innerHTML = table("funds-" + state.market, cols, rows, { csv: true, sort: { col: "mv", dir: -1 }, limit: 50, expand: true, empty: "Inga fonder matchar filtret." });
    $("fundCount").textContent = int(rows.length) + " fonder";
  }
  // Räntefonder och fondandelsfonder får egna kolumner
  function renderKindTable(kind, q) {
    var r = ratesData();
    var rows = fundList().filter(function (f) {
      if (fundKind(f) !== kind) return false;
      if (fundFilter.co && f.co !== fundFilter.co) return false;
      return !q || f.name.toLowerCase().indexOf(q) >= 0 || f.co.toLowerCase().indexOf(q) >= 0;
    });
    var cols = kind === "rante" ? rateFundCols() : [
      { key: "name", label: "Fond", align: "l", cls: "name", cell: function (f) { return nameCell(fundHref(f), f.name, esc(f.co) + " · " + feeText(f)); }, value: function (f) { return f.name; } },
      { key: "co", label: "Fondbolag", align: "l", cls: "muted", hideSm: true, cell: function (f) { return companyLink(f.co); }, value: function (f) { return f.co; } },
      { key: "aum", label: "Förmögenhet (mkr)", cell: function (f) { return mkr(f.aum); }, value: function (f) { return f.aum; } },
      { key: "fee", label: "Avgift", hideSm: true, cell: function (f) { return f.feeMax == null ? "–" : nf2.format(f.feeMax) + " %"; }, value: function (f) { return f.feeMax; } },
      { key: "u", label: "I andra fonder", hideSm: true, cell: function (f) { var x = r.funds[f.id]; return x && f.aum ? pctShare(x.unit / f.aum) : "–"; }, value: function (f) { var x = r.funds[f.id]; return x && f.aum ? x.unit / f.aum : null; } },
      { key: "flow", label: "Netto (mkr)", cell: function (f) { var x = r.funds[f.id]; return !x || x.unitFlow == null ? "–" : '<span class="' + cls(x.unitFlow) + '">' + mkr(x.unitFlow, true) + "</span>"; }, value: function (f) { var x = r.funds[f.id]; return x ? x.unitFlow : null; } }
    ];
    $("fundTable").innerHTML = table("funds-" + kind, cols, rows, { csv: true, sort: { col: "aum", dir: -1 }, empty: "Inga fonder matchar filtret." }) +
      '<p class="desc section-gap-sm">' + (kind === "rante" ? "Räntefonder har minst hälften av förmögenheten i obligationer och certifikat enligt rapporten till Finansinspektionen. Netto är köp minus sälj av räntepapper under kvartalet." :
        "Fondandelsfonder har minst hälften av förmögenheten i andra fonder. Netto är köp minus sälj av fondandelar under kvartalet.") + "</p>";
    $("fundCount").textContent = int(rows.length) + " fonder";
  }
  // De två största tillgångsslagen i fonden (aktier, räntepapper eller fondandelar) som nyckeltal
  function assetFigs(id, seF, wF, hasWorld) {
    var r = ratesData(), x = r && r.funds[id];
    var items = [
      { label: "Svenska aktier", v: seF ? seF.val || 0 : 0, ready: true },
      { label: "Globala aktier", v: wF ? wF.val || 0 : 0, ready: hasWorld },
      { label: "Räntepapper", v: x ? x.bond : 0, ready: !!r },
      { label: "Fondandelar", v: x ? x.unit : 0, ready: !!r }
    ];
    var show = items.filter(function (i) { return i.v > 0; }).sort(function (a, b) { return b.v - a.v; }).slice(0, 2);
    items.slice(0, 2).forEach(function (i) { if (show.length < 2 && show.indexOf(i) < 0) show.push(i); });
    return show.map(function (i) { return fig(i.label, !i.ready ? "…" : i.v ? bigSek(i.v) : "–"); }).join("");
  }
  // ---------- Fond ----------

  function viewFund(id, sub) {
    var d = quarterData();
    var f = d.fi[id] || d.se.fundById[id];
    if (!f) return notFound("Fonden finns inte i " + quarterLabel(state.q) + ".");
    document.title = f.name + " – Fondinsyn";
    var wds = fundWorld(id), hasWorld = !!wds;
    var seF = d.se.fundById[id];
    var wF = hasWorld ? wds.fundById[id] : null;
    var cat = d.fi[id] ? fundCategory(d.fi[id]) : "other";

    var html = '<div class="page-head"><div class="crumbs"><a href="#/fonder">Fonder</a> / ' + esc(f.name) + '</div><div class="title-row"><div class="title-main">' + avatar(f.name) + '<h1>' + esc(f.name) +
      (cat === "index" && !/index/i.test(f.name) ? ' <span class="label">Index</span>' : "") +
      (cat === "closet" ? ' <span class="label warn">Indexnära</span>' : "") +
      '</h1></div><div class="actions">' + starBtn("funds", id) +
      '<a class="btn" href="#/jamfor/' + encodeURIComponent(id) + '">Jämför</a>' + shareBtn("fond", id) +
      (d.fi[id] ? '<button type="button" class="btn" data-pf-add="' + esc(id) + '">' + (inPortfolio(id) ? "I din portfölj ✓" : "+ Min portfölj") + "</button>" : "") +
      '</div></div><p class="meta">' + (d.fi[id] && ratesData() ? esc(KIND_LABEL[fundKind(d.fi[id])]) + " · " : "") + companyLink(f.co) + (f.bench ? " · Jämförelseindex: " + esc(f.bench) : "") + "</p></div>";

    if (d.fi[id]) {
      var fi = d.fi[id];
      var ff = needFlows() ? fundFlowFor(id) : null;
      html += '<dl class="figures">' + fig("Fondförmögenhet", bigSek(fi.aum),
        ff ? 'Nettoflöde ' + quarterLabel(state.q) + ' <span class="' + cls(ff[4]) + '">' + bigSek(ff[4], true) + "</span> (uppskattat, " + '<a href="#/sparande">om siffran</a>)' : "") +
        fig(termLink("avgift", "Förvaltningsavgift"), feeText(fi), fi.perf ? "+ prestationsbaserad avgift" : "") +
        fig(termLink("aktiv-risk", "Aktiv risk"), pctPlain(fi.ar), "Avvikelse mot index, 24 mån") +
        fig(termLink("standardavvikelse", "Standardavvikelse"), pctPlain(fi.sd), "24 månader") +
        assetFigs(id, seF, wF, hasWorld) + "</dl>";
      var perfHtml = perfBlock(id);
      var prof = needProfiles() ? fundProfile(id) : null;
      if (prof) {
        html += '<dl class="figures">' +
          fig(termLink("aktiv-andel", "Aktiv andel"), prof.active == null ? "–" : pctShare(prof.active),
            prof.active == null ? (fi.isIndex ? "indexfond" : "kan inte mätas") : "jämfört med " + (prof.region === "se" ? "svenska" : "globala") + " indexfonder") +
          fig(termLink("koncentration", "Tio största innehaven"), pctShare(prof.top10), "av fondens aktier") +
          fig("Antal aktier", int(prof.n)) + "</dl>";
      }
      if (cat === "closet") {
        html += '<p class="notice warn-notice">Fonden har en aktiv risk på ' + pctPlain(fi.ar) + " men tar ut upp till " + nf2.format(fi.feeMax) +
          ' % i avgift. Den följer alltså sitt jämförelseindex ganska nära, men kostar som en aktiv fond. <a href="#/avgifter">Läs mer om avgifter</a></p>';
      }
      html += perfHtml;
    }

    // Räntepapper och fondandelar (data/<kvartal>-rates.json och data/rf/<id>.json)
    var hasRates = needRates();
    var rx = hasRates && ratesData() ? ratesData().funds[id] : null;
    var hasBonds = !!(rx && rx.bond > 0), hasUnits = !!(rx && rx.unit > 0);
    var rrows = (hasBonds || hasUnits || (rx && rx.n)) && needFundRates(id) ? fundBondRows(id) : null;
    var hasStocks = !!((seF && seF.h.length) || (wF && wF.h.length));
    if (hasWorld && (hasRates || failed("rates-" + state.q)) && !hasStocks && !hasBonds && !hasUnits) {
      return html + '<p class="notice section-gap">Fonden ägde inga aktier, räntepapper eller fondandelar enligt rapporten för ' + quarterLabel(state.q) +
        ". Den består troligen av likvida medel och derivat.</p>";
    }

    // Flikar: alla innehav, eller bara kvartalets affärer (köp och sälj)
    if (state.fundTabFor !== id) { state.fundTabFor = id; state.fundTab = sub === "affarer" ? "trades" : "holdings"; }
    var tabBtn = function (v, label) { return '<button type="button" class="tab" role="tab" data-fund-tab="' + v + '" aria-selected="' + (state.fundTab === v) + '">' + label + "</button>"; };
    html += '<div class="tabs section-gap" role="tablist">' + tabBtn("holdings", "Innehav") + tabBtn("trades", "Alla affärer " + quarterLabel(state.q)) + "</div>";
    if (state.fundTab === "trades") return html + fundTradesView(f, seF, hasWorld ? wF : null, wds, hasWorld, d.meta, rx, rrows);
    // Delarna i storleksordning: en räntefond visar räntepappren först, en aktiefond aktierna
    var parts = [];
    if (seF && seF.h.length) parts.push({ v: seF.val || 0, html: fundHoldings(f, seF, "Svenska aktier", d.se, d.meta) });
    if (!hasWorld) parts.push({ v: -1, html: '<section class="block section-gap"><div class="block-head"><h2>Globala aktier</h2></div>' + (failed("world-" + state.q) ? errorBlock() : loadingBlock()) + "</section>" });
    else if (wF && wF.h.length) parts.push({ v: wF.val || 0, html: fundHoldings(f, wF, "Globala aktier", wds, d.meta) });
    if (hasBonds) parts.push({ v: rx.bond, html: fundBondSection(f, rx, rrows) });
    if (hasUnits) parts.push({ v: rx.unit, html: fundUnitSection(f, rx, rrows) });
    parts.sort(function (a, b) { return b.v - a.v; });
    return html + parts.map(function (p) { return p.html; }).join("");
  }

  // Alla köp och sälj en fond gjort under kvartalet: aktier, räntepapper och fondandelar
  var fundTradeFilter = "all";
  function fundTradesView(info, seF, wF, wds, hasWorld, meta, rx, rrows) {
    var rows = [];
    [[seF, quarterData().se, "Svenska aktier"], [wF, wds, "Globala aktier"]].forEach(function (x) {
      var f = x[0], ds = x[1];
      if (!f || !f.both || !ds) return;
      f.h.forEach(function (r) {
        var s = ds.stocks[r[0]], s1 = r[1] || 0, s2 = r[2] || 0;
        if (s1 !== s2) rows.push({ name: s.name, href: stockHref(s), s1: s1, s2: s2, d: (s2 - s1) * s.price, m: x[2], n: true });
      });
    });
    if (rrows) {
      rrows.b.forEach(function (b) {
        if (b.matured || b.flow == null || !Math.round(b.flow / 1e3) || b.n1 === b.n2) return;
        rows.push({ name: b.issuer, href: b.key ? issuerHref(b.key) : null, sub: b.raw, s1: b.n1, s2: b.n2, d: b.flow, m: "Räntepapper", n: true });
      });
      rrows.u.forEach(function (u) {
        if (u.flow == null || !Math.round(u.flow / 1e3)) return;
        var t = u.target && quarterData().fi[u.target];
        rows.push({ name: u.name, href: t ? fundHref(t) : null, s1: u.v1, s2: u.v2, d: u.flow, m: "Fondandelar", n: false });
      });
    }
    var missing = seF && !seF.both;
    var waiting = (rx && (rx.bond > 0 || rx.unit > 0) && !rrows) || !hasWorld;
    if (!rows.length) {
      if (waiting) return loadingBlock();
      return '<p class="notice">' + (missing ? "Fonden saknas i rapporten för " + quarterLabel(meta.prevId) + ", så affärerna kan inte räknas ut." : "Inga affärer under kvartalet.") + "</p>";
    }
    var buys = rows.filter(function (r) { return r.d > 0; }), sells = rows.filter(function (r) { return r.d < 0; });
    var sum = function (l) { return l.reduce(function (a, r) { return a + r.d; }, 0); };
    var ft = fundTradeFilter;
    var list = ft === "buy" ? buys : ft === "sell" ? sells : rows;
    var seg = function (v, label) { return '<button type="button" class="seg-btn" data-fund-trades="' + v + '" aria-pressed="' + (ft === v) + '">' + label + "</button>"; };
    var nameOf = function (r) { return r.href ? '<a href="' + r.href + '">' + esc(r.name) + "</a>" : '<span class="nm-plain">' + esc(r.name) + "</span>"; };
    var maxD = rows.reduce(function (a, r) { return Math.max(a, Math.abs(r.d)); }, 0);
    var cols = [
      { key: "name", label: "Innehav", align: "l", cls: "name", cell: function (r) {
        return nameOf(r) + (r.sub ? '<span class="sub">' + esc(r.sub) + "</span>" : "") + '<span class="sub show-sm">' + changeLabel(r.s1, r.s2) + " " + esc(r.m) + "</span>";
      }, value: function (r) { return r.name; } },
      { key: "chg", label: "Ändring", align: "l", hideSm: true, cell: function (r) { return changeLabel(r.s1, r.s2); } },
      { key: "n", label: "Antal före och efter", hideSm: true, cell: function (r) { return r.n ? int(r.s1) + " → " + int(r.s2) : "–"; } },
      { key: "d", label: "Förändring (mkr)", cell: function (r) {
        return '<span class="barcell"><span class="' + cls(r.d) + '">' + mkr(r.d, true) + "</span>" + bar(r.d, maxD, r.d >= 0 ? "pos" : "neg") + "</span>";
      }, value: function (r) { return r.d; } },
      { key: "m", label: "Typ", align: "l", hideSm: true, cls: "muted", cell: function (r) { return esc(r.m); }, value: function (r) { return r.m; } }
    ];
    return '<section class="block"><div class="block-head"><h2>Köp och sälj ' + quarterLabel(state.q) + '</h2><div class="seg" role="group" aria-label="Typ av affär">' +
      seg("all", "Alla") + seg("buy", "Köp") + seg("sell", "Sälj") + "</div></div>" +
      '<p class="desc">' + int(buys.length) + " köp för " + mkr(sum(buys)) + " mkr och " + int(sells.length) + " sälj för " + mkr(-sum(sells)) + " mkr, jämfört med " + quarterLabel(meta.prevId) + "." +
      (rrows && rrows.b.some(function (b) { return b.matured; }) ? " Räntepapper som förfallit räknas inte som sålda." : "") +
      (waiting ? " Fler innehav laddas…" : "") + "</p>" +
      table("fund-trades-" + info.id + "-" + ft, cols, list, { sort: { col: "d", dir: ft === "sell" ? 1 : -1 }, csv: true }) + "</section>";
  }
  function fundHoldings(info, f, title, ds, meta) {
    if (!f) return "";
    var rows = f.h.map(function (r) {
      var s = ds.stocks[r[0]], s1 = r[1] || 0, s2 = r[2] || 0;
      return { s: s, s1: s1, s2: s2, d: (s2 - s1) * s.price, v: s2 * s.price };
    }).filter(function (r) { return f.both ? (r.s1 || r.s2) : r.s2; });
    var aum = f.aum2;
    var cols = [
      { key: "name", label: "Aktie", align: "l", cls: "name", cell: function (r) { return nameCell(stockHref(r.s), r.s.name, (f.both ? changeLabel(r.s1, r.s2) + " " : "") + mkr(r.v) + " mkr"); }, value: function (r) { return r.s.name; } },
      { key: "chg", label: "Ändring", align: "l", hideSm: true, cell: function (r) { return f.both ? changeLabel(r.s1, r.s2) : "–"; } },
      { key: "s2", label: "Antal", hideSm: true, cell: function (r) { return int(r.s2); }, value: function (r) { return r.s2; } },
      { key: "d", label: "Förändring (mkr)", cell: function (r) { return f.both ? '<span class="' + cls(r.d) + '">' + mkr(r.d, true) + "</span>" : "–"; }, value: function (r) { return f.both ? r.d : null; } },
      { key: "v", label: "Värde (mkr)", hideSm: true, cell: function (r) { return mkr(r.v); }, value: function (r) { return r.v; } },
      { key: "w", label: "Andel av fond", cell: function (r) { return aum ? nf1.format(r.v / aum * 100) + " %" : "–"; }, value: function (r) { return r.v; } }
    ];
    var note = f.both ? (rows.length + " innehav · köpt " + mkr(f.bought, true) + " mkr · sålt " + mkr(f.sold, true) + " mkr")
      : "Fonden saknas i rapporten för " + quarterLabel(meta.prevId) + ", så förändringar kan inte beräknas.";
    return '<section class="block section-gap"><div class="block-head"><h2>' + title + '</h2><span class="note">' + note + "</span></div>" +
      table("fund-" + title + "-" + info.id, cols, rows, { sort: f.both ? { col: "d", dir: -1 } : { col: "v", dir: -1 } }) + "</section>";
  }

  // ---------- Förvaltare ----------

  function viewManagers() {
    document.title = "Kända förvaltare – Fondinsyn";
    var d = quarterData(), ds = d.se;
    var funds = FEATURED.map(function (id) { return { info: d.fi[id], m: ds.fundById[id] }; })
      .filter(function (x) { return x.info && x.m; })
      .sort(function (a, b) { return b.info.aum - a.info.aum; });

    // Konsensus: hur många av de kända fonderna som köpt respektive sålt varje aktie
    var tally = {};
    funds.forEach(function (x) {
      if (!x.m.both) return;
      x.m.h.forEach(function (r) {
        var s = ds.stocks[r[0]], s1 = r[1] || 0, s2 = r[2] || 0;
        if (s1 === s2 || s.isNew || s.isGone) return;
        var t = tally[s.isin] = tally[s.isin] || { s: s, buyers: [], sellers: [], sum: 0 };
        var dd = (s2 - s1) * s.price;
        t.sum += dd;
        (s2 > s1 ? t.buyers : t.sellers).push(x.info.name);
      });
    });
    var all = Object.keys(tally).map(function (k) { return tally[k]; });
    var bought = all.filter(function (t) { return t.buyers.length >= 2 && t.buyers.length > t.sellers.length; })
      .sort(function (a, b) { return (b.buyers.length - b.sellers.length) - (a.buyers.length - a.sellers.length) || b.sum - a.sum; }).slice(0, 10);
    var sold = all.filter(function (t) { return t.sellers.length >= 2 && t.sellers.length > t.buyers.length; })
      .sort(function (a, b) { return (b.sellers.length - b.buyers.length) - (a.sellers.length - a.buyers.length) || a.sum - b.sum; }).slice(0, 10);
    var consCols = function (buy) {
      return [
        { key: "name", label: "Aktie", align: "l", cls: "name", cell: function (t) { return nameCell(stockHref(t.s), t.s.name, (buy ? t.buyers : t.sellers).join(", ")); } },
        { key: "n", label: buy ? "Köpte" : "Sålde", cell: function (t) {
          return '<span class="vote ' + (buy ? "pos" : "neg") + '" title="' + esc((buy ? t.buyers : t.sellers).join(", ")) + '">' + (buy ? t.buyers.length : t.sellers.length) + "</span>" +
            '<span class="vote-other"> / ' + (buy ? t.sellers.length : t.buyers.length) + "</span>";
        } },
        { key: "sum", label: "Netto (mkr)", cell: function (t) { return '<span class="' + cls(t.sum) + '">' + mkr(t.sum, true) + "</span>"; } }
      ];
    };

    var cards = funds.map(function (x) {
      var f = x.m, info = x.info;
      var trades = f.h.map(function (r) {
        var s = ds.stocks[r[0]], s1 = r[1] || 0, s2 = r[2] || 0;
        return { s: s, s1: s1, s2: s2, d: (s2 - s1) * s.price };
      }).filter(function (t) { return t.s1 !== t.s2; });
      var buys = trades.filter(function (t) { return t.d > 0; }).sort(function (a, b) { return b.d - a.d; }).slice(0, 3);
      var sells = trades.filter(function (t) { return t.d < 0; }).sort(function (a, b) { return a.d - b.d; }).slice(0, 3);
      var list = function (items, empty) {
        if (!f.both) return '<li class="muted">Ingen jämförelse</li>';
        return items.map(function (t) {
          return '<li><a href="' + stockHref(t.s) + '">' + esc(t.s.name) + "</a>" + (!t.s1 ? ' <span class="label new">Ny</span>' : !t.s2 ? ' <span class="label out">Ut</span>' : "") +
            '<span class="' + cls(t.d) + '">' + mkr(t.d, true) + "</span></li>";
        }).join("") || '<li class="muted">' + empty + "</li>";
      };
      return '<article class="mgr">' +
        '<header><a class="mgr-name" href="' + fundHref(info) + '">' + esc(info.name) + '</a><div class="mgr-co">' + esc(info.co) + "</div></header>" +
        '<div class="mgr-stats"><span><b>' + bigSek(info.aum) + "</b> förmögenhet</span><span><b>" + feeText(info) + "</b> avgift</span><span><b>" + pctPlain(info.ar) + "</b> aktiv risk</span></div>" +
        '<div class="mgr-cols"><div><h3>Köpte mest</h3><ul>' + list(buys, "Inga köp") + "</ul></div>" +
        "<div><h3>Sålde mest</h3><ul>" + list(sells, "Inga sälj") + "</ul></div></div>" +
        '<a class="more" href="#/fond/' + encodeURIComponent(info.id) + '/affarer">Alla affärer</a>' +
        "</article>";
    }).join("");

    return '<div class="page-head"><h1>Kända förvaltare</h1><p class="meta lead">Vad gör Sveriges mest kända aktiva aktiefonder? ' + funds.length + " fonder, " +
      quarterLabel(state.q) + " jämfört med " + quarterLabel(d.meta.prevId) + ". Endast svenska aktier.</p></div>" +
      '<div class="grid-2">' +
      block("Köpt av flera", "Aktier där fler av fonderna köpt än sålt", table("mgr-buy", consCols(true), bought, { static: true, empty: "Inga gemensamma köp." })) +
      block("Sålt av flera", "Aktier där fler av fonderna sålt än köpt", table("mgr-sell", consCols(false), sold, { static: true, empty: "Inga gemensamma sälj." })) +
      "</div>" +
      '<h2 class="section-title">Fonderna</h2><div class="mgr-grid">' + cards + "</div>";
  }

  // ---------- Avgifter ----------

  var feeFilter = { scope: "all", list: "closet" };

  function viewFees() {
    document.title = "Avgiftskollen – Fondinsyn";
    var d = quarterData(), ds = d.se;
    var hasWorld = needProfiles(), hasPerf = needPerf();
    var funds = fundList().filter(function (f) { return f.ar != null && f.feeMax != null && f.aum >= 100e6 && fundCategory(f) !== "other"; });
    if (feeFilter.scope === "se") {
      funds = funds.filter(function (f) { var m = ds.fundById[f.id]; return m && m.val / f.aum >= 0.6; });
    }
    funds.forEach(function (f) { f.cat = fundCategory(f); });
    var closet = funds.filter(function (f) { return f.cat === "closet"; });
    var closetAum = closet.reduce(function (a, f) { return a + f.aum; }, 0);
    var closetCost = closet.reduce(function (a, f) { return a + f.aum * f.feeMax / 100; }, 0);
    var indexFee = funds.filter(function (f) { return f.cat === "index"; }).map(function (f) { return f.feeMax; }).sort(function (a, b) { return a - b; });
    var medianIndexFee = indexFee.length ? indexFee[Math.floor(indexFee.length / 2)] : 0.2;
    var overpay = closet.reduce(function (a, f) { return a + f.aum * Math.max(0, f.feeMax - medianIndexFee) / 100; }, 0);

    var maxAr = Math.min(14, Math.max.apply(null, funds.map(function (f) { return f.ar; }).concat([6])));
    var maxFee = Math.min(2.5, Math.max.apply(null, funds.map(function (f) { return f.feeMax; }).concat([1.5])));
    // Indexnära fonder med hög avgift ritas sist så att de hamnar överst
    var points = funds.map(function (f) { return { x: f.ar, y: f.feeMax, cls: "c-" + f.cat, f: f }; })
      .sort(function (a, b) { return (a.cls === "c-closet") - (b.cls === "c-closet"); });

    var listRows = feeFilter.list === "closet" ? closet : funds;
    var cols = [
      { key: "name", label: "Fond", align: "l", cls: "name", value: function (f) { return f.name; }, cell: function (f) {
        return nameCell(fundHref(f), f.name, esc(f.co) + " · aktiv risk " + pctPlain(f.ar)) + (feeFilter.list !== "closet" ? " " + catLabel(f.cat, true) : "");
      } },
      { key: "co", label: "Fondbolag", align: "l", cls: "muted", hideSm: true, cell: function (f) { return esc(f.co); }, value: function (f) { return f.co; } },
      { key: "fee", label: "Avgift", cell: function (f) { return nf2.format(f.feeMax) + " %"; }, value: function (f) { return f.feeMax; } },
      { key: "ar", label: "Aktiv risk", hideSm: true, cell: function (f) { return pctPlain(f.ar); }, value: function (f) { return f.ar; } },
      { key: "r5", label: "Per år, 5 år", hideSm: true, cell: function (f) { var p = hasPerf && perfOf(f.id); return p && p[3] != null ? retText(p[3]) : PERF_MISSING; },
        value: function (f) { var p = hasPerf && perfOf(f.id); return p ? p[3] : null; } },
      { key: "t5", label: "Totalt, 5 år", hideSm: true, cell: function (f) { var p = hasPerf && perfOf(f.id); return p && p[3] != null ? retApprox(total5(p)) : PERF_MISSING; },
        value: function (f) { var p = hasPerf && perfOf(f.id); return p ? total5(p) : null; } },
      { key: "as", label: "Aktiv andel", hideSm: true, cell: function (f) { var p = hasWorld && fundProfile(f.id); return p ? pctShare(p.active) : "…"; },
        value: function (f) { var p = hasWorld && fundProfile(f.id); return p ? p.active : null; } },
      { key: "aum", label: "Förmögenhet (mkr)", hideSm: true, cell: function (f) { return mkr(f.aum); }, value: function (f) { return f.aum; } },
      { key: "cost", label: "Avgifter per år (mkr)", cell: function (f) { return mkr(f.aum * f.feeMax / 100); }, value: function (f) { return f.aum * f.feeMax / 100; } }
    ];

    var seg = function (name, value, label, current) {
      return '<button type="button" class="seg-btn" data-fee-' + name + '="' + value + '" aria-pressed="' + (current === value) + '">' + label + "</button>";
    };

    return '<div class="page-head"><h1>Avgiftskollen</h1><p class="meta lead">Betalar du för aktiv förvaltning som du inte får? Varje punkt är en aktiefond. ' +
      "Ju längre till vänster, desto mer liknar fonden sitt jämförelseindex. Ju högre upp, desto dyrare. " + termLink("aktiv-risk", "Vad är aktiv risk?") + "</p></div>" +
      '<div class="highlights">' +
      highlight("Indexnära med hög avgift", int(closet.length) + " fonder", null, "av " + int(funds.length) + " aktiefonder", "Aktiv risk under " + CLOSET_AR + " % och avgift från " + nf1.format(CLOSET_FEE) + " %") +
      highlight("Sparat kapital i dem", bigSek(closetAum), null, "", "Fondförmögenhet " + quarterLabel(state.q)) +
      highlight("Avgifter per år", bigSek(closetCost), null, '<span class="neg">~' + bigSek(overpay) + " mer</span>", "än med en indexfond (median " + nf2.format(medianIndexFee) + " %)") +
      "</div>" +
      '<section class="block section-gap"><div class="block-head"><h2>Avgift mot aktiv risk</h2>' +
      '<div class="seg" role="group" aria-label="Urval">' + seg("scope", "all", "Alla aktiefonder", feeFilter.scope) + seg("scope", "se", "Sverigefonder", feeFilter.scope) + "</div></div>" +
      '<div class="chart-card">' + chart(function (node) {
        FFCharts.xy(node, points, {
          height: node.clientWidth < 500 ? 340 : 420,
          xDomain: [0, maxAr], yDomain: [0, maxFee], xTicks: 7, yTicks: 5,
          xFmt: function (v) { return fixMinus(nf0.format(v)) + " %"; }, yFmt: function (v) { return nf1.format(v) + " %"; },
          legend: catLegend(["closet", "active", "index"], points),
          zone: { x: CLOSET_AR, y: CLOSET_FEE, label: "Indexnära men dyr" },
          xLabel: "Aktiv risk: avvikelse mot jämförelseindex", yLabel: "Avgift per år", xHint: ["← Följer index", "Avviker mer →"],
          tip: function (p) {
            return "<b>" + esc(p.f.name) + "</b>" + '<div class="muted">' + esc(p.f.co) + "</div>" +
              tipRow("", "Avgift", feeText(p.f)) + tipRow("", "Aktiv risk", pctPlain(p.f.ar)) + tipRow("", "Förmögenhet", bigSek(p.f.aum)) +
              tipRow(p.cls, CAT_NAMES[p.cls.slice(2)], "");
          },
          onClick: function (p) { location.hash = fundHref(p.f); }
        });
      }) + "</div></section>" +
      feeReturnBlock(funds, hasPerf) +
      '<section class="block section-gap"><div class="block-head"><h2>' + (feeFilter.list === "closet" ? "Indexnära fonder med hög avgift" : "Alla aktiefonder") + "</h2>" +
      '<div class="seg" role="group" aria-label="Lista">' + seg("list", "closet", "Indexnära", feeFilter.list) + seg("list", "all", "Alla", feeFilter.list) + "</div></div>" +
      table("fees-" + feeFilter.list, cols, listRows, { csv: true, sort: { col: "cost", dir: -1 }, empty: "Inga fonder i urvalet." }) + "</section>" +
      '<section class="block section-gap prose"><h2>Så ska du läsa det</h2>' +
      "<p><b>Aktiv risk</b> (tracking error) mäter hur mycket fondens avkastning har avvikit från jämförelseindex de senaste 24 månaderna. En indexfond ligger nära 0 %. En vanlig tumregel är att en fond under 3 % i praktiken följer index ganska nära.</p>" +
      "<p><b>Avgift</b> är den högsta fasta förvaltningsavgiften bland fondens andelsklasser, vilket oftast är den som privatpersoner betalar. Prestationsbaserade avgifter ingår inte.</p>" +
      "<p>Låg aktiv risk är inte fel i sig, men då bör avgiften vara låg. Siffrorna rapporteras av fondbolagen till Finansinspektionen. Endast aktiefonder (minst 80 % aktier, inga bland- eller generationsfonder) med över 100 mkr i förmögenhet visas.</p></section>";
  }

  // Avgift mot avkastning: ger en dyrare fond bättre avkastning? Trendlinjen är en vanlig regression över fonderna.
  function feeReturnBlock(funds, hasPerf) {
    if (!hasPerf) return "";
    var pts = funds.map(function (f) { var p = perfOf(f.id); return p && p[3] != null ? { x: f.feeMax, y: p[3], size: f.aum, cls: "c-" + f.cat, f: f } : null; }).filter(Boolean);
    if (pts.length < 20) return "";
    var ct = corrTest(pts.map(function (p) { return p.x; }), pts.map(function (p) { return p.y; }));
    var pp = function (v) { return (v > 0 ? "+" : "") + fixMinus(nf1.format(v)); };
    var feeText1 = ct.level === "none" ?
      "Bland de här fonderna finns inget statistiskt säkerställt samband mellan avgift och avkastning: lutningen kan lika gärna vara slump. " :
      "Dyrare fonder har i snitt gått " + (ct.b < 0 ? "sämre" : "bättre") + ". Varje procentenhet högre avgift har gått ihop med ungefär " + nf1.format(Math.abs(ct.b)) +
        " procentenheter " + (ct.b < 0 ? "lägre" : "högre") + " avkastning per år. Sambandet är " + (ct.level === "strong" ? "starkt" : "svagt") + ". ";
    var feeBox = corrBox({ t: ct, unit: "fonder", unitNote: "med fem års historik",
      text: feeText1 + "Avgiften dras alltid från avkastningen, så två i övrigt likadana fonder skiljer sig med just avgiften. Frågan här är om dyrare fonder i snitt har tjänat in sin avgift.",
      extra: [["Lutning", pp(ct.b) + " p.e.", "per procentenhet avgift, 95 %: " + ciText(ct.ciB, pp)]],
      caveats: [
        "<b>Olika marknader.</b> Dyra fonder placerar ofta i småbolag, tillväxtmarknader eller teman, medan billiga indexfonder ofta är globala. Skillnaden kan bero på marknaden, inte på avgiften. Välj Sverigefonder ovan för att jämföra fonder på samma marknad.",
        "<b>Överlevnadsbias.</b> Fonder som lagts ner eller slagits ihop saknas, och det är oftare fonder som gått dåligt.",
        "<b>Rabatterad avgift.</b> Avkastningen från Pensionsmyndigheten är räknad efter premiepensionens rabatt, så utanför premiepensionen drar den ordinarie avgiften ännu mer.",
        "<b>Inte oberoende.</b> Många fonder äger samma aktier, så p-värdet är snarare för lågt än för högt.",
        "<b>Avgiften</b> är den högsta fasta avgiften bland fondens andelsklasser. Prestationsbaserade avgifter ingår inte."
      ] });
    return '<section class="block section-gap"><div class="block-head"><h2>Avgift mot avkastning</h2><span class="note">' + int(pts.length) + " fonder med femårshistorik</span></div>" +
      '<div class="chart-card"><p class="chart-howto">Varje prick är en fond. <b>Till höger</b> är avgiften högre, <b>högre upp</b> har fonden gått bättre. ' +
      "Den streckade linjen visar hur det ser ut i genomsnitt. Peka på en prick för att se vilken fond det är.</p>" + chart(function (node) {
        FFCharts.xy(node, pts, {
          height: node.clientWidth < 500 ? 340 : 420, trend: true, xHint: ["← Billigare", "Dyrare →"], yTicks: 8,
          legend: catLegend(["closet", "active", "index"], pts).concat([{ label: "Trend", cls: "s-ink", kind: "dash" }]),
          sizeKey: { values: [1e9, 25e9], fmt: function (v) { return nf0.format(v / 1e9) + " mdkr"; } },
          xDomain: [0, Math.max.apply(null, pts.map(function (p) { return p.x; })) * 1.04],
          xFmt: function (v) { return nf1.format(v) + " %"; }, yFmt: function (v) { return fixMinus(nf0.format(v)) + " %"; },
          xLabel: "Avgift per år", yLabel: "Avkastning per år, 5 år",
          tip: function (p) {
            return "<b>" + esc(p.f.name) + "</b>" + '<div class="muted">' + esc(p.f.co) + "</div>" +
              tipRow("", "Avkastning per år", (p.y > 0 ? "+" : "") + fixMinus(nf0.format(p.y)) + " %") + tipRow("", "Avgift", feeText(p.f)) +
              tipRow("", "Förmögenhet", bigSek(p.f.aum)) + tipRow(p.cls, CAT_NAMES[p.cls.slice(2)], "");
          },
          onClick: function (p) { location.hash = fundHref(p.f); }
        });
      }) + '<p class="chart-note">Punkternas storlek är fondförmögenheten. Den streckade linjen är en vanlig regression över fonderna.</p></div>' + feeBox + "</section>";
  }

  // En rad i ett diagrams tooltip: serien som en kort linje (bar: en ruta) i seriens färg, namnet svagt och värdet starkt.
  // Texten står alltid i textfärg, aldrig i seriens färg.
  function tipRow(key, label, value, bar) {
    return '<div class="tip-row"><span>' + (key ? '<i class="tip-key ' + (bar ? "bar " : "") + key + '"></i>' : "") + label + "</span><b>" + value + "</b></div>";
  }
  var CAT_NAMES = { closet: "Indexnära med hög avgift", active: "Aktiv fond", index: "Indexfond" };
  // Teckenförklaring för fondkategorierna i punktdiagrammen, med antal fonder per kategori
  function catLegend(cats, pts) {
    return cats.map(function (c) {
      var n = pts.filter(function (p) { return p.cls === "c-" + c; }).length;
      return { label: CAT_NAMES[c] + " (" + int(n) + ")", cls: "c-" + c, kind: "dot", key: "c-" + c };
    });
  }

  function catLabel(cat, small) {
    var t = { closet: "Indexnära med hög avgift", active: "Aktiv fond", index: "Indexfond", other: "Övrig" }[cat];
    if (small) return cat === "closet" ? '<span class="label warn hide-sm">Indexnära</span>' : cat === "index" ? '<span class="label hide-sm">Index</span>' : "";
    return '<span class="legend-item"><i class="dot c-' + cat + '"></i>' + t + "</span>";
  }

  // ---------- Bevakningslista ----------

  function watchGet() {
    var w = store("ff-watch");
    return w && Array.isArray(w.stocks) && Array.isArray(w.funds) ? w : { stocks: [], funds: [] };
  }
  function watching(kind, id) { return watchGet()[kind].indexOf(id) >= 0; }
  function watchToggle(kind, id) {
    var w = watchGet(), i = w[kind].indexOf(id);
    if (i >= 0) w[kind].splice(i, 1); else w[kind].push(id);
    store("ff-watch", w);
  }
  function starBtn(kind, id) {
    var on = watching(kind, id);
    return '<button type="button" class="star' + (on ? " on" : "") + '" data-watch="' + kind + ":" + esc(id) + '" aria-pressed="' + on + '">' +
      '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l1.9 4 4.4.5-3.3 3 .9 4.3L8 11.1l-3.9 2.2.9-4.3-3.3-3 4.4-.5z"/></svg>' +
      (on ? "Bevakas" : "Bevaka") + "</button>";
  }

  // Dela-knappen ger den fasta adressen (fondinsyn.se/aktie/volvo-b/) som har egen titel och delningsbild.
  // data/pages.json kopplar ISIN, fond-id och fondbolag till adresserna och byggs av scripts/build-pages.ps1.
  var pageMap = null;
  function needPages() {
    return need("pages", function () { return getJSON("data/pages.json").then(function (p) { pageMap = p; }); });
  }
  function shareBtn(kind, key) {
    needPages();
    return '<button type="button" class="btn" data-share="' + kind + "|" + esc(key) + '">Dela</button>';
  }
  function shareUrl(kind, key) {
    var slug = pageMap && pageMap[kind] && pageMap[kind][key];
    return slug ? location.origin + "/" + kind + "/" + slug + "/" : location.href;
  }
  function shareLink(btn) {
    var parts = btn.getAttribute("data-share").split("|");
    var url = shareUrl(parts[0], parts.slice(1).join("|"));
    var title = document.querySelector("#app h1");
    if (navigator.share && window.matchMedia("(pointer: coarse)").matches) {
      navigator.share({ title: (title ? title.textContent + " – " : "") + "Fondinsyn", url: url }).catch(function () {});
      return;
    }
    var done = function () { btn.textContent = "Länk kopierad"; setTimeout(function () { btn.textContent = "Dela"; }, 2000); };
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, function () { window.prompt("Kopiera länken", url); });
    else window.prompt("Kopiera länken", url);
  }

  // Bädda in rutan för aktien på en annan sajt, eller prenumerera på aktiens insynshandel via RSS
  function embedBox(isin, name) {
    var slug = pageMap && pageMap.aktie && pageMap.aktie[isin];
    var code = '<iframe src="https://www.fondinsyn.se/embed.html?aktie=' + (slug || isin) + '" width="100%" height="260" style="border:0" loading="lazy" title="Fondinsyn: ' + name + '"></iframe>';
    var rss = slug && state.insider && state.insider.byIsin[isin] ? "/rss/insyn/" + slug + ".xml" : null;
    return '<details class="embed-box section-gap"><summary>Bädda in eller prenumerera</summary>' +
      '<p class="desc">Visa fondernas köp och sälj, ägarandel, insynshandel och blankning för ' + esc(name) + " på din blogg, sajt eller i ett forum. Rutan uppdateras automatiskt.</p>" +
      '<div class="embed-preview" data-src="/embed.html?aktie=' + encodeURIComponent(slug || isin) + '"></div>' +
      '<div class="embed-code"><code id="embedCode">' + esc(code) + '</code><button type="button" class="btn" data-copy-embed>Kopiera koden</button></div>' +
      '<p class="desc">' + (rss ? '<a href="' + rss + '">RSS för insynshandel i ' + esc(name) + "</a> · " : "") + '<a href="/oppen-data/">Fler flöden, topplistor och öppen data</a></p></details>';
  }

  function watchBlock() {
    var w = watchGet();
    if (!w.stocks.length && !w.funds.length) return "";
    var d = quarterData();
    var needsWorld = w.stocks.some(function (i) { return i.slice(0, 2) !== "SE"; });
    var hasWorld = !needsWorld || needWorld();
    var hasHist = state.loading["history-se"] === "done";
    var qi = hasHist ? state.history.qIndex[state.q] : null;
    var stocks = w.stocks.map(function (isin) { return d.se.byIsin[isin] || (hasWorld && d.world ? d.world.byIsin[isin] : null); }).filter(Boolean);
    var funds = w.funds.map(function (id) { return d.fi[id] || d.se.fundById[id]; }).filter(Boolean);
    var stockCols = [stockCol(function (s) { return int(s.f2) + " fonder"; }), col.flow, col.chg,
      { key: "f2", label: "Fonder", hideSm: true, cell: function (s) { return int(s.f2) + (s.dF ? ' <span class="' + cls(s.dF) + '">(' + signed(String(s.dF), s.dF) + ")</span>" : ""); } }];
    if (hasHist) stockCols.push({ key: "streak", label: "Svit", hideSm: true, cell: function (s) {
      var hs = histFor(s.isin), st = hs && qi != null ? streak(hs, qi) : null;
      return st && st.n >= 2 ? '<span class="streak ' + (st.sign > 0 ? "pos" : "neg") + '">' + st.n + "</span>" : "–";
    } });
    var fundNet = function (f) {
      var a = d.se.fundById[f.id], b = d.world && d.world.fundById[f.id], v = 0, any = false;
      [a, b].forEach(function (m) { if (m && m.both) { v += m.bought + m.sold; any = true; } });
      return any ? v : null;
    };
    var fundCols = [
      { key: "name", label: "Fond", align: "l", cls: "name", cell: function (f) { return nameCell(fundHref(f), f.name, esc(f.co)); } },
      { key: "net", label: "Nettoköp (mkr)", cell: function (f) { var v = fundNet(f); return v == null ? "–" : '<span class="' + cls(v) + '">' + mkr(v, true) + "</span>"; } },
      { key: "fee", label: "Avgift", cell: function (f) { return f.feeMax == null ? "–" : nf2.format(f.feeMax) + " %"; } }
    ];
    var parts = [];
    if (stocks.length) parts.push(block("Dina bevakade aktier", "", table("watch-s", stockCols, stocks, { static: true })));
    if (funds.length) parts.push(block("Dina bevakade fonder", "", table("watch-f", fundCols, funds, { static: true })));
    return '<div class="watch section-gap ' + (parts.length > 1 ? "grid-2" : "") + '">' + parts.join("") + '</div><a class="more" href="#/bevakning">Hela din bevakning</a>';
  }

  // Min bevakning: allt man bevakar på en sida, med det senaste från fonderna, insiders och blankarna.
  // Listan finns bara i webbläsaren (ff-watch).
  function viewWatch() {
    document.title = "Min bevakning – Fondinsyn";
    var w = watchGet();
    var head = '<div class="page-head"><h1>Min bevakning</h1><p class="meta lead">Aktierna och fonderna du följer, med det senaste från fonderna, insiders och blankarna. ' +
      "Listan sparas bara i din webbläsare.</p></div>";
    if (!w.stocks.length && !w.funds.length) {
      var d0 = quarterData().se, ideas = d0.stocks.filter(function (s) { return s.price && !s.isNew && !s.isGone && s.flow > 0; })
        .sort(function (a, b) { return b.flow - a.flow; }).slice(0, 5);
      return head + '<div class="empty-state"><h2>Du bevakar inget än</h2><p>Tryck på <b>Bevaka</b> på en aktie- eller fondsida, så hamnar den här. ' +
        "Kvartalets mest köpta aktier att börja med:</p><p class=\"watch-ideas\">" + ideas.map(function (s) { return starBtn("stocks", s.isin).replace("Bevaka<", esc(s.name) + "<"); }).join("") + "</p></div>";
    }
    var d = quarterData();
    var needsWorld = w.stocks.some(function (i) { return i.slice(0, 2) !== "SE"; });
    var hasWorld = !needsWorld || needWorld(), hasIns = needInsider(), hasShorts = needShorts(), hasPerf = needPerf();
    var stocks = w.stocks.map(function (isin) { return d.se.byIsin[isin] || (hasWorld && d.world ? d.world.byIsin[isin] : null); }).filter(Boolean);
    var funds = w.funds.map(function (id) { return d.fi[id]; }).filter(Boolean);
    // Insiders nettoköp de senaste 90 dagarna (köp minus sälj, kronor)
    var insNet = function (isin, closeOnly) {
      var rows = hasIns && state.insider.byIsin[isin];
      if (!rows || !rows.length) return null;
      return rows.reduce(function (a, r) { return a + (closeOnly && !r.close ? 0 : r.kind === "buy" ? r.sek || 0 : r.kind === "sell" ? -(r.sek || 0) : 0); }, 0);
    };
    var stockCols = [
      stockCol(function (s) { return esc(s.sector) + " · " + int(s.f2) + " fonder"; }), col.flow,
      { key: "chg", label: "Δ antal aktier", hideSm: true, cell: col.chg.cell, value: col.chg.value },
      { key: "ins", label: "Insiders 90 d", cell: function (s) {
        var v = insNet(s.isin), note = v == null ? "" : closeNote(v, insNet(s.isin, true));
        return v == null ? '<span class="muted">–</span>' : '<span class="' + cls(v) + '">' + bigSek(v, true) + "</span>" + (note ? '<span class="sub">' + note.slice(2) + "</span>" : "");
      },
        value: function (s) { return insNet(s.isin); } },
      { key: "sh", label: "Blankning", hideSm: true, cell: function (s) { var a = hasShorts && state.shorts.byIsin[s.isin]; return a ? nf2.format(a.pct) + " %" : '<span class="muted">–</span>'; },
        value: function (s) { var a = hasShorts && state.shorts.byIsin[s.isin]; return a ? a.pct : null; } },
      { key: "rm", label: "", cell: function (s) { return starBtn("stocks", s.isin); } }
    ];
    var fundNet = function (f) {
      var v = 0, any = false;
      [d.se.fundById[f.id], d.world && d.world.fundById[f.id]].forEach(function (m) { if (m && m.both) { v += m.bought + m.sold; any = true; } });
      return any ? v : null;
    };
    var fundCols = [
      { key: "name", label: "Fond", align: "l", cls: "name", value: function (f) { return f.name; }, cell: function (f) { return nameCell(fundHref(f), f.name, esc(f.co)); } },
      { key: "net", label: "Fondens nettoköp (mkr)", cell: function (f) { var v = fundNet(f); return v == null ? "–" : '<span class="' + cls(v) + '">' + mkr(v, true) + "</span>"; }, value: fundNet },
      { key: "r5", label: "Avkastning per år, 5 år", hideSm: true, cell: function (f) { var p = hasPerf && perfOf(f.id); return p && p[3] != null ? retText(p[3]) : PERF_MISSING; },
        value: function (f) { var p = hasPerf && perfOf(f.id); return p ? p[3] : null; } },
      { key: "fee", label: "Avgift", hideSm: true, cell: function (f) { return feeText(f); }, value: function (f) { return f.feeMax; } },
      { key: "rm", label: "", cell: function (f) { return starBtn("funds", f.id); } }
    ];
    // Avkastningen finns bara för fonderna på premiepensionens fondtorg. Har ingen av fonderna någon, visas inte kolumnen.
    var withPerf = funds.filter(function (f) { var p = hasPerf && perfOf(f.id); return p && p[3] != null; }).length;
    if (hasPerf && !withPerf) fundCols = fundCols.filter(function (c) { return c.key !== "r5"; });
    var perfNote = hasPerf && withPerf < funds.length ? " Avkastningen kommer från Pensionsmyndigheten och finns bara för fonder på premiepensionens fondtorg." : "";
    return head +
      (stocks.length ? block("Aktier", int(stocks.length) + (stocks.length === 1 ? " aktie" : " aktier") + ". Fondernas köp och sälj gäller " + quarterLabel(state.q) + ".",
        table("watch-stocks", stockCols, stocks, { sort: { col: "flow", dir: -1 } })) : "") +
      (funds.length ? block("Fonder", int(funds.length) + (funds.length === 1 ? " fond" : " fonder") + ". Nettoköp är fondens egna affärer i aktier under " + quarterLabel(state.q) + "." + perfNote,
        table("watch-funds", fundCols, funds, { sort: { col: "net", dir: -1 } }), "section-gap") : "") +
      '<p class="desc section-gap">Tryck på stjärnan för att sluta bevaka. Listan finns bara på den här enheten och i den här webbläsaren.</p>';
  }

  // Stjärnan i sidhuvudet visar hur många aktier och fonder man bevakar
  function syncWatchCount(pulse) {
    var w = watchGet(), n = w.stocks.length + w.funds.length, el = $("watchCount"), btn = $("watchBtn");
    if (!el || !btn) return;
    el.hidden = !n;
    el.textContent = n > 99 ? "99+" : String(n);
    btn.classList.toggle("has", n > 0);
    btn.setAttribute("aria-label", n ? "Min bevakning, " + n + " bevakade" : "Min bevakning");
    if (pulse) { btn.classList.remove("pulse"); void btn.offsetWidth; btn.classList.add("pulse"); }
  }

  // ---------- Sektorrotation ----------

  function sectorFlows(market) {
    var h = state.history, out = {};
    Object.keys(h.stocks).forEach(function (isin) {
      if ((isin.slice(0, 2) === "SE") !== (market === "se")) return;
      var e = h.stocks[isin], sec = e[1] || "Övrigt";
      var row = out[sec] = out[sec] || {};
      var byQ = {};
      e[3].forEach(function (r) { byQ[r[0]] = r; });
      e[3].forEach(function (r) {
        // Aktier som är nya eller borta det kvartalet räknas inte som köp eller sälj, samma regel som i compute()
        var prev = byQ[r[0] - 1];
        if (!prev || !(prev[1] > 0) || !(r[1] > 0)) return;
        var v = flowOf(r);
        if (v != null) row[r[0]] = (row[r[0]] || 0) + v;
      });
    });
    return out;
  }

  function sectorBlock(hasHist) {
    var title = "Sektorrotation";
    if (!hasHist) return '<div class="section-gap">' + block(title, "", loadingBlock("Laddar historik…")) + "</div>";
    var h = state.history, qi = h.qIndex[state.q];
    if (qi == null || qi < 1) return "";
    var flows = sectorFlows(state.market);
    var sectors = Object.keys(flows).filter(function (s) { return s !== "Övrigt"; });
    sectors.sort(function (a, b) { return (flows[b][qi] || 0) - (flows[a][qi] || 0); });
    var maxNow = Math.max.apply(null, sectors.map(function (s) { return Math.abs(flows[s][qi] || 0); }).concat([1]));

    var bars = '<ul class="divbars">' + sectors.map(function (s) {
      var v = flows[s][qi] || 0, w = Math.abs(v) / maxNow * 50;
      return "<li><span class=\"db-label\">" + esc(s) + '</span><span class="db-track"><i class="' + (v >= 0 ? "pos" : "neg") + '" style="width:' + w.toFixed(1) +
        "%;" + (v >= 0 ? "left:50%" : "right:50%") + '"></i></span><span class="db-val ' + cls(v) + '">' + bigSek(v * 1e6, true) + "</span></li>";
    }).join("") + "</ul>";

    var first = Math.max(1, qi - 7), cols = [];
    for (var k = first; k <= qi; k++) cols.push(k);
    var maxAll = 1;
    sectors.forEach(function (s) { cols.forEach(function (k) { maxAll = Math.max(maxAll, Math.abs(flows[s][k] || 0)); }); });
    var heat = '<div class="table-wrap"><table class="heat"><thead><tr><th class="l">Sektor</th>' + cols.map(function (k, n) {
      var q = h.quarters[k];
      return '<th class="' + (n < cols.length - 4 ? "hide-sm" : "") + '">Q' + q.slice(5) + " " + q.slice(2, 4) + "</th>";
    }).join("") + "</tr></thead><tbody>" + sectors.map(function (s) {
      return '<tr><td class="l">' + esc(s) + "</td>" + cols.map(function (k, n) {
        var v = flows[s][k] || 0, a = Math.min(1, Math.abs(v) / maxAll);
        var pctMix = Math.round(8 + a * 62);
        var bg = Math.abs(v) < 1 ? "" : ' style="background:color-mix(in srgb, var(' + (v > 0 ? "--bar-pos" : "--bar-neg") + ") " + pctMix + '%, transparent)"';
        return '<td class="' + (n < cols.length - 4 ? "hide-sm" : "") + '"' + bg + ' title="' + esc(s + ", " + quarterLabel(h.quarters[k]) + ": " + bigSek(v * 1e6, true)) + '">' +
          (Math.abs(v) < 50 ? "0,0" : fixMinus((v > 0 ? "+" : "") + nf1.format(v / 1000))) + "</td>";
      }).join("") + "</tr>";
    }).join("") + "</tbody></table></div>";

    return '<div class="grid-2 section-gap">' +
      block(title, "Fondernas nettoköp per sektor " + quarterLabel(state.q) + (state.excludeIndex ? ", utan indexfonder" : ""), bars) +
      block("Sektorer över tid", "Nettoköp per kvartal, miljarder kronor", heat) + "</div>";
  }

  // ---------- Gemensamt för portfölj och jämförelse ----------

  function fundDatalist() {
    return '<datalist id="fundNames">' + fundList().slice().sort(function (a, b) { return a.name.localeCompare(b.name, "sv"); })
      .map(function (f) { return '<option value="' + esc(f.name) + '"></option>'; }).join("") + "</datalist>";
  }
  function fundByName(name) {
    var n = String(name || "").trim().toLowerCase(), list = fundList();
    for (var i = 0; i < list.length; i++) if (list[i].name.toLowerCase() === n) return list[i];
    return null;
  }

  // Alla aktieinnehav i en fond (svenska och utländska) med värde i kronor
  function fundPositions(id) {
    var d = quarterData(), out = [];
    [d.se, d.world].forEach(function (ds) {
      var f = ds && ds.fundById[id];
      if (!f || f.aum2 == null) return;
      f.h.forEach(function (r) {
        var s = ds.stocks[r[0]], s2 = r[2] || 0;
        if (s2 && s.price) out.push({ s: s, v: s2 * s.price });
      });
    });
    return out;
  }

  // Vikter normerade mot fondens samlade aktieinnehav
  function stockWeights(id) {
    var pos = fundPositions(id), tot = 0, w = {}, s = {};
    pos.forEach(function (o) { tot += o.v; });
    pos.forEach(function (o) { w[o.s.isin] = (w[o.s.isin] || 0) + o.v / (tot || 1); s[o.s.isin] = o.s; });
    return { w: w, s: s, n: pos.length };
  }

  // ---------- Aktiv andel och koncentration ----------
  // Aktiv andel = halva summan av skillnaden i vikt mot ett index, 0 % = som index, 100 % = inget gemensamt.
  // Som index används indexfondernas sammanlagda innehav (viktat efter storlek), separat för
  // Sverigefonder och globala fonder.

  function regionOf(id) {
    var d = quarterData(), se = 0, all = 0;
    fundPositions(id).forEach(function (o) { all += o.v; if (o.s.isin.slice(0, 2) === "SE") se += o.v; });
    if (!all) return null;
    if (se / all >= 0.8) return "se";
    if (se / all <= 0.2) return "world";
    return null;
  }

  function indexProxy(region) {
    var d = quarterData();
    d.proxy = d.proxy || {};
    if (d.proxy[region]) return d.proxy[region];
    var sum = {}, tot = 0;
    fundList().forEach(function (f) {
      if (!f.isIndex || !f.aum || regionOf(f.id) !== region) return;
      var w = stockWeights(f.id).w;
      Object.keys(w).forEach(function (k) { sum[k] = (sum[k] || 0) + w[k] * f.aum; });
      tot += f.aum;
    });
    Object.keys(sum).forEach(function (k) { sum[k] /= tot || 1; });
    return (d.proxy[region] = tot ? sum : null);
  }

  // Returnerar { active, top10, n, region } eller null om fonden inte går att mäta
  function fundProfile(id) {
    var d = quarterData();
    if (d.profileData) {
      var pd = d.profileData[id];
      return pd ? { active: pd[0], top10: pd[1], n: pd[2], region: pd[3] } : null;
    }
    if (!d.world) return null; // kräver alla innehav
    d.profiles = d.profiles || {};
    if (id in d.profiles) return d.profiles[id];
    var sw = stockWeights(id), ws = Object.keys(sw.w).map(function (k) { return sw.w[k]; }).sort(function (a, b) { return b - a; });
    if (!ws.length) return (d.profiles[id] = null);
    var top10 = ws.slice(0, 10).reduce(function (a, b) { return a + b; }, 0);
    var region = regionOf(id), active = null, fi = d.fi[id];
    var proxy = region ? indexProxy(region) : null;
    if (proxy && !(fi && fi.isIndex)) {
      var keys = {}, diff = 0;
      Object.keys(sw.w).forEach(function (k) { keys[k] = 1; });
      Object.keys(proxy).forEach(function (k) { keys[k] = 1; });
      Object.keys(keys).forEach(function (k) { diff += Math.abs((sw.w[k] || 0) - (proxy[k] || 0)); });
      active = diff / 2;
    }
    return (d.profiles[id] = { active: active, top10: top10, n: sw.n, region: region });
  }

  function pctShare(v) { return v == null ? "–" : nf0.format(v * 100) + " %"; }

  function overlap(idA, idB) {
    var a = stockWeights(idA), b = stockWeights(idB), sum = 0, common = [];
    Object.keys(a.w).forEach(function (k) {
      if (!b.w[k]) return;
      sum += Math.min(a.w[k], b.w[k]);
      common.push({ s: a.s[k], wa: a.w[k], wb: b.w[k] });
    });
    return { value: sum, common: common, a: a, b: b };
  }

  function shareBars(items, total, limit) {
    return '<ul class="sharebars">' + items.slice(0, limit || 10).map(function (it) {
      var p = total ? it.v / total : 0;
      return '<li><span class="sb-label">' + esc(it.label) + '</span><span class="sb-track"><i style="width:' + (p * 100).toFixed(1) + '%"></i></span><span class="sb-val">' + nf1.format(p * 100) + " %</span></li>";
    }).join("") + "</ul>";
  }

  function kr(v) { return nf0.format(Math.round(v || 0)) + " kr"; }

  // ---------- Min fondportfölj ----------

  function loadPortfolio() {
    var p = store("ff-portfolio");
    return Array.isArray(p) ? p.filter(function (x) { return x && x.id && x.amount > 0; }) : [];
  }
  function savePortfolio(p) { store("ff-portfolio", p); }
  function inPortfolio(id) { return loadPortfolio().some(function (x) { return x.id === id; }); }
  function encodePortfolio(p) { return p.map(function (x) { return x.id + "-" + Math.round(x.amount); }).join("."); }
  function decodePortfolio(s) {
    return String(s || "").split(".").map(function (t) { var a = t.split("-"); return { id: a[0], amount: +a[1] || 0 }; })
      .filter(function (x) { return x.id && x.amount > 0; });
  }
  function addToPortfolio(id, amount) {
    var p = loadPortfolio(), ex = p.filter(function (x) { return x.id === id; })[0];
    if (ex) ex.amount += amount; else p.push({ id: id, amount: amount });
    savePortfolio(p);
  }

  function viewPortfolio(arg) {
    document.title = "Min fondportfölj – Fondinsyn";
    var head = '<div class="page-head"><h1>Min fondportfölj</h1><p class="meta lead">Fyll i dina fonder och hur mycket du har i varje. Då ser du vilka aktier du faktiskt äger, ' +
      "vad du betalar i avgifter och om dina fonder har samma innehav. Portföljen sparas bara i din webbläsare.</p></div>";
    if (!needWorld()) return head + (failed("world-" + state.q) ? errorBlock() : loadingBlock("Laddar fondernas innehav…"));
    var d = quarterData();
    var shared = !!arg;
    var p = (shared ? decodePortfolio(arg) : loadPortfolio()).filter(function (x) { return d.fi[x.id]; });

    var form = shared
      ? '<div class="notice pf-shared">Du tittar på en delad portfölj. <button type="button" class="btn btn-primary" data-pf-adopt="' + esc(arg) + '">Spara som min portfölj</button></div>'
      : '<form class="pf-form" id="pfForm" autocomplete="off">' + fundDatalist() +
        '<input class="input" id="pfFund" list="fundNames" placeholder="Sök och välj fond" aria-label="Fond">' +
        '<input class="input pf-amount" id="pfAmount" type="number" min="1" step="any" inputmode="numeric" placeholder="Belopp i kr" aria-label="Belopp i kronor">' +
        '<button class="btn btn-primary" type="submit">Lägg till</button><span class="form-msg" id="pfMsg" role="status"></span></form>';

    if (!p.length) {
      return head + form + '<div class="empty-state"><h2>Lägg till din första fond</h2><p>Skriv namnet på en fond du äger, till exempel <i>Swedbank Robur Ny Teknik</i>, ' +
        "och hur många kronor du har i den. Du kan också trycka på <b>+ Min portfölj</b> på en fonds sida.</p></div>";
    }

    var total = 0, feeKr = 0, other = 0, byIsin = {};
    var rows = p.map(function (x) {
      var fi = d.fi[x.id], sumW = 0;
      fundPositions(x.id).forEach(function (o) {
        var w = o.v / fi.aum;
        sumW += w;
        var e = byIsin[o.s.isin] = byIsin[o.s.isin] || { s: o.s, kr: 0, via: [] };
        e.kr += x.amount * w;
        if (e.via.indexOf(fi.name) < 0) e.via.push(fi.name);
      });
      sumW = Math.min(1, sumW);
      other += x.amount * (1 - sumW);
      total += x.amount;
      var fee = fi.feeMax != null ? x.amount * fi.feeMax / 100 : 0;
      feeKr += fee;
      return { x: x, fi: fi, fee: fee, eq: sumW };
    });
    var holdings = Object.keys(byIsin).map(function (k) { return byIsin[k]; }).sort(function (a, b) { return b.kr - a.kr; });
    var inStocks = total - other;
    var top10 = holdings.slice(0, 10).reduce(function (a, e) { return a + e.kr; }, 0);

    var group = function (keyFn) {
      var m = {};
      holdings.forEach(function (e) { var k = keyFn(e.s); m[k] = (m[k] || 0) + e.kr; });
      return Object.keys(m).map(function (k) { return { label: k, v: m[k] }; }).sort(function (a, b) { return b.v - a.v; });
    };
    var sectors = group(function (s) { return s.sector || "Övrigt"; });
    var countries = group(function (s) { return countryName(s.country) || "Okänt"; });

    // Fonder som äger samma aktier
    var pairs = [];
    for (var i = 0; i < p.length; i++) for (var j = i + 1; j < p.length; j++) {
      var ov = overlap(p[i].id, p[j].id).value;
      if (ov >= 0.4) pairs.push({ a: d.fi[p[i].id], b: d.fi[p[j].id], v: ov });
    }
    pairs.sort(function (a, b) { return b.v - a.v; });

    var fundCols = [
      { key: "name", label: "Fond", align: "l", cls: "name", cell: function (r) { return nameCell(fundHref(r.fi), r.fi.name, esc(r.fi.co) + " · " + feeText(r.fi)); } },
      { key: "amount", label: "Belopp (kr)", cell: function (r) {
        return shared ? nf0.format(r.x.amount) : '<input class="input pf-edit" type="number" min="0" step="any" inputmode="numeric" value="' + Math.round(r.x.amount) + '" data-pf-id="' + esc(r.x.id) + '" aria-label="Belopp i ' + esc(r.fi.name) + '">';
      } },
      { key: "share", label: "Andel", hideSm: true, cell: function (r) { return nf1.format(r.x.amount / total * 100) + " %"; } },
      { key: "fee", label: "Avgift per år", cell: function (r) { return r.fi.feeMax == null ? "–" : kr(r.fee); } },
      { key: "eq", label: "Aktier", hideSm: true, cell: function (r) { return nf0.format(r.eq * 100) + " %"; } }
    ];
    if (!shared) fundCols.push({ key: "rm", label: "", cell: function (r) { return '<button type="button" class="icon-btn" data-pf-remove="' + esc(r.x.id) + '" aria-label="Ta bort ' + esc(r.fi.name) + '">✕</button>'; } });

    var holdCols = [
      { key: "name", label: "Aktie", align: "l", cls: "name", cell: function (e) { return nameCell(stockHref(e.s), e.s.name, kr(e.kr) + " · via " + esc(e.via.join(", "))); } },
      { key: "kr", label: "Belopp", cell: function (e) { return kr(e.kr); } },
      { key: "p", label: "Andel", cell: function (e) { return nf1.format(e.kr / total * 100) + " %"; } },
      { key: "via", label: "Via", align: "l", cls: "muted", hideSm: true, cell: function (e) { return esc(e.via.join(", ")); } }
    ];

    var weightedFee = total ? feeKr / total * 100 : 0;
    var shareUrl = location.href.split("#")[0] + "#/portfolj/" + encodePortfolio(p);

    return head + form +
      '<div class="highlights section-gap">' +
      highlight("Portföljens värde", kr(total), null, "", p.length + (p.length === 1 ? " fond" : " fonder") + " · " + nf0.format(inStocks / total * 100) + " % i aktier") +
      highlight("Avgifter per år", kr(feeKr), null, nf2.format(weightedFee) + " % i snitt", "Högsta avgiftsklassen i varje fond") +
      highlight("Du äger", int(holdings.length) + " aktier", null, "", "De tio största är " + nf0.format(top10 / total * 100) + " % av portföljen") +
      "</div>" +
      (pairs.length ? '<div class="notice overlap-notice section-gap"><b>Dina fonder äger delvis samma aktier.</b><ul>' + pairs.slice(0, 4).map(function (x) {
        return '<li><a href="#/jamfor/' + encodeURIComponent(x.a.id) + "/" + encodeURIComponent(x.b.id) + '">' + esc(x.a.name) + " och " + esc(x.b.name) + "</a> överlappar till " + nf0.format(x.v * 100) + " %.</li>";
      }).join("") + "</ul></div>" : "") +
      '<section class="block section-gap"><div class="block-head"><h2>Dina fonder</h2>' +
      (shared ? "" : '<button type="button" class="btn" id="pfShare" data-url="' + esc(shareUrl) + '">Kopiera delningslänk</button>') + "</div>" +
      table("pf-funds", fundCols, rows, { static: true }) + "</section>" +
      '<div class="grid-2 section-gap pf-grid">' +
      block("Dina största innehav", "Det du äger genom dina fonder, enligt fondernas senaste rapport " + quarterLabel(state.q), table("pf-hold", holdCols, holdings.slice(0, 25), { static: true }) +
        (holdings.length > 25 ? '<p class="desc more-note">… och ' + int(holdings.length - 25) + " aktier till.</p>" : "")) +
      '<div class="stack">' + block("Sektorer", "", shareBars(sectors, total, 11)) +
      block("Länder", "", shareBars(countries, total, 8)) +
      (other > total * 0.02 ? '<p class="desc">' + nf0.format(other / total * 100) + " % av portföljen ligger i räntor, kassa, fondandelar eller mindre innehav som inte syns här.</p>" : "") +
      "</div></div>";
  }

  // ---------- Jämför fonder ----------

  function viewCompare(idA, idB) {
    document.title = "Jämför fonder – Fondinsyn";
    var head = '<div class="page-head"><h1>Jämför fonder</h1><p class="meta lead">Hur lika är två fonder egentligen? Överlappet visar hur stor del av innehaven som är gemensam.</p></div>';
    if (!needWorld()) return head + (failed("world-" + state.q) ? errorBlock() : loadingBlock("Laddar fondernas innehav…"));
    var d = quarterData(), A = d.fi[idA], B = d.fi[idB];
    var form = '<form class="cmp-form" id="cmpForm" autocomplete="off">' + fundDatalist() +
      '<input class="input" id="cmpA" list="fundNames" placeholder="Första fonden" aria-label="Första fonden" value="' + esc(A ? A.name : "") + '">' +
      '<button type="button" class="icon-btn" id="cmpSwap" aria-label="Byt plats" title="Byt plats">⇄</button>' +
      '<input class="input" id="cmpB" list="fundNames" placeholder="Andra fonden" aria-label="Andra fonden" value="' + esc(B ? B.name : "") + '">' +
      '<button class="btn btn-primary" type="submit">Jämför</button><span class="form-msg" id="cmpMsg" role="status"></span></form>';
    if (!A || !B) {
      return head + form + '<div class="empty-state"><h2>Välj två fonder</h2><p>Till exempel <a href="#/jamfor/51718/60730">SEB Sverigefond och Handelsbanken Sverige Selektiv</a>, ' +
        'eller <a href="#/jamfor/51545/51670">Swedbank Robur Småbolagsfond Sverige och Lannebo Småbolag</a>.</p></div>';
    }
    document.title = fundShort(A.name) + " och " + fundShort(B.name) + " – Jämför fonder – Fondinsyn";
    var ov = overlap(idA, idB);
    var v = ov.value;
    var verdict = v >= 0.6 ? "Fonderna är mycket lika. Att äga båda ger liten extra spridning."
      : v >= 0.3 ? "Fonderna är ganska lika men har en del egna innehav."
      : "Fonderna är olika. De kompletterar varandra.";
    var common = ov.common.sort(function (a, b) { return Math.min(b.wa, b.wb) - Math.min(a.wa, a.wb); });
    var only = function (x, y) {
      return Object.keys(x.w).filter(function (k) { return !y.w[k]; }).map(function (k) { return { s: x.s[k], w: x.w[k] }; })
        .sort(function (a, b) { return b.w - a.w; }).slice(0, 10);
    };
    var onlyA = only(ov.a, ov.b), onlyB = only(ov.b, ov.a);
    var pw = function (w) { return nf1.format(w * 100) + " %"; };
    var row = function (label, fn) { return "<tr><th class=\"l\" scope=\"row\">" + label + "</th><td>" + fn(A) + "</td><td>" + fn(B) + "</td></tr>"; };

    return head + form +
      '<div class="cmp-hero section-gap"><div class="cmp-score"><div class="cmp-num">' + nf0.format(v * 100) + ' %</div><div class="cmp-cap">överlapp</div></div>' +
      '<div class="cmp-text"><p><b>' + esc(verdict) + "</b></p><p class=\"desc\">" + int(common.length) + " gemensamma aktier av " + int(ov.a.n) + " respektive " + int(ov.b.n) +
      ". Överlappet är summan av den lägsta vikten för varje gemensam aktie.</p>" +
      '<div class="cmp-bar" aria-hidden="true"><i style="width:' + (v * 100).toFixed(1) + '%"></i></div></div></div>' +
      '<div class="table-wrap section-gap"><table class="cmp-table"><thead><tr><th class="l"></th><th><a href="' + fundHref(A) + '">' + esc(A.name) + '</a></th><th><a href="' + fundHref(B) + '">' + esc(B.name) + "</a></th></tr></thead><tbody>" +
      row("Fondbolag", function (f) { return esc(f.co); }) +
      row("Förmögenhet", function (f) { return bigSek(f.aum); }) +
      row("Avgift", function (f) { return feeText(f); }) +
      row("Aktiv risk", function (f) { return pctPlain(f.ar); }) +
      row("Standardavvikelse", function (f) { return pctPlain(f.sd); }) +
      row("Antal aktier", function (f) { return int(f.id === idA ? ov.a.n : ov.b.n); }) +
      row(termLink("aktiv-andel", "Aktiv andel"), function (f) { var p = fundProfile(f.id); return p ? pctShare(p.active) : "–"; }) +
      row(termLink("koncentration", "Tio största"), function (f) { var p = fundProfile(f.id); return p ? pctShare(p.top10) : "–"; }) +
      row(termLink("avkastning", "Avkastning per år, 5 år"), function (f) { var p = needPerf() && perfOf(f.id); return p && p[3] != null ? retText(p[3]) : PERF_MISSING; }) +
      row("Total avkastning, 5 år", function (f) { var p = needPerf() && perfOf(f.id); return p && p[3] != null ? retApprox(total5(p)) : PERF_MISSING; }) +
      row("Jämförelseindex", function (f) { return esc(f.bench || "–"); }) +
      "</tbody></table></div>" +
      '<section class="block section-gap"><div class="block-head"><h2>Gemensamma innehav</h2><span class="note">Andel av fondernas aktieinnehav</span></div>' +
      table("cmp-common", [
        { key: "name", label: "Aktie", align: "l", cls: "name", cell: function (c) { return nameCell(stockHref(c.s), c.s.name, ""); } },
        { key: "a", label: esc(fundShort(A.name)), cell: function (c) { return pw(c.wa); } },
        { key: "b", label: esc(fundShort(B.name)), cell: function (c) { return pw(c.wb); } }
      ], common.slice(0, 25), { static: true, empty: "Fonderna har inga gemensamma aktier." }) + "</section>" +
      '<div class="grid-2 section-gap">' +
      block("Bara i " + esc(A.name), "", table("cmp-a", [
        { key: "name", label: "Aktie", align: "l", cls: "name", cell: function (c) { return nameCell(stockHref(c.s), c.s.name, ""); } },
        { key: "w", label: "Vikt", cell: function (c) { return pw(c.w); } }], onlyA, { static: true, empty: "Inga egna innehav." })) +
      block("Bara i " + esc(B.name), "", table("cmp-b", [
        { key: "name", label: "Aktie", align: "l", cls: "name", cell: function (c) { return nameCell(stockHref(c.s), c.s.name, ""); } },
        { key: "w", label: "Vikt", cell: function (c) { return pw(c.w); } }], onlyB, { static: true, empty: "Inga egna innehav." })) +
      "</div>";
  }

  function fundShort(n) { return n.length > 22 ? n.slice(0, 20) + "…" : n; }

  // ---------- Sök ----------

  var search = { open: false, sel: 0, items: [], fuzzy: false };

  function openSearch() {
    if (!state.q || !quarterData() || !quarterData().se) return;
    search.open = true;
    $("searchModal").hidden = false;
    document.body.classList.add("modal-open");
    var input = $("searchInput");
    input.value = "";
    runSearch();
    input.focus();
    needSearchNames();
    needGlossary();
    needRates();
  }
  function closeSearch() {
    search.open = false;
    $("searchModal").hidden = true;
    document.body.classList.remove("modal-open");
    $("searchBtn").focus();
  }

  // Utländska aktier att söka bland: hela datasetet om det redan är laddat, annars namnlistan
  function worldNames() { var d = quarterData(); return d.world ? d.world.stocks : (d.searchNames || []); }

  function scoreMatch(name, q) {
    var n = name.toLowerCase();
    if (n.indexOf(q) === 0) return 0;
    if (n.indexOf(" " + q) >= 0) return 1;
    if (n.indexOf(q) >= 0) return 2;
    return search.fuzzy && fuzzyMatch(n, q) ? 3 : -1;
  }

  // Används bara när inget matchar exakt. Tål ett stavfel (två i längre ord): "ericson" hittar Ericsson och "hexgon" Hexagon.
  // Varje sökord ska likna ett ord i namnet, helt eller början av det.
  function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var prev = [], cur, i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      var rowMin = i;
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }
  function fuzzyMatch(n, q) {
    if (q.length < 4) return false;
    var words = n.split(/[\s\-&.,()]+/);
    return q.split(/\s+/).every(function (qw) {
      if (qw.length < 3) return n.indexOf(qw) >= 0;
      var max = qw.length >= 7 ? 2 : 1;
      return words.some(function (w) {
        return w.indexOf(qw) === 0 || editDistance(qw, w, max) <= max || (w.length > qw.length && editDistance(qw, w.slice(0, qw.length), max) <= max);
      });
    });
  }

  function runSearch() {
    var q = $("searchInput").value.trim().toLowerCase();
    var d = quarterData(), items = [];
    if (!q) {
      recentSearches().forEach(function (r) { items.push({ kind: "Senaste", was: r.was, label: r.label, sub: r.sub, href: r.href }); });
      var w = watchGet();
      w.stocks.forEach(function (isin) {
        var s = d.se.byIsin[isin] || (d.world && d.world.byIsin[isin]) || worldNames().filter(function (x) { return x.isin === isin; })[0];
        if (s) items.push({ kind: "Bevakade", label: s.name, sub: s.sector, href: stockHref(s) });
      });
      w.funds.forEach(function (id) { var f = d.fi[id]; if (f) items.push({ kind: "Bevakade", label: f.name, sub: f.co, href: fundHref(f) }); });
    } else {
      var stocks = [];
      [d.se.stocks, worldNames()].forEach(function (list) {
        list.forEach(function (s) {
          if (!s.f2 && !s.f1b) return;
          var sc = s.isin.toLowerCase() === q ? 0 : scoreMatch(s.name, q);
          if (sc >= 0) stocks.push({ s: s, sc: sc });
        });
      });
      stocks.sort(function (a, b) { return a.sc - b.sc || b.s.val2 - a.s.val2; });
      stocks.slice(0, 8).forEach(function (x) {
        items.push({ kind: "Aktier", label: x.s.name, sub: (x.s.isin.slice(0, 2) === "SE" ? "" : countryName(x.s.country) + " · ") + x.s.sector + " · " + int(x.s.f2) + " fonder", href: stockHref(x.s) });
      });
      var funds = fundList().map(function (f) { return { f: f, sc: Math.min(scoreMatch(f.name, q), 99) }; }).filter(function (x) { return x.sc >= 0; });
      funds.sort(function (a, b) { return a.sc - b.sc || b.f.aum - a.f.aum; });
      funds.slice(0, 6).forEach(function (x) { items.push({ kind: "Fonder", label: x.f.name, sub: x.f.co + " · " + bigSek(x.f.aum), href: fundHref(x.f) }); });
      var cos = {};
      fundList().forEach(function (f) { if (scoreMatch(f.co, q) >= 0) cos[f.co] = (cos[f.co] || 0) + 1; });
      Object.keys(cos).slice(0, 4).forEach(function (co) { items.push({ kind: "Fondbolag", label: co, sub: cos[co] + " fonder", href: companyHref(co) }); });
      GLOSSARY.filter(function (t) { return scoreMatch(t[1], q) >= 0; }).slice(0, 3).forEach(function (t) {
        items.push({ kind: "Ordlista", label: t[1], sub: t[2].slice(0, 70) + "…", href: "#/ordlista/" + t[0] });
      });
      // Emittenter av obligationer (laddas när sökrutan öppnas, se openSearch)
      var rd = ratesData();
      if (rd) {
        rd.issuers.filter(function (i) { return i.v2 > 0 && scoreMatch(i.name, q) >= 0; }).sort(function (a, b) { return scoreMatch(a.name, q) - scoreMatch(b.name, q) || b.v2 - a.v2; })
          .slice(0, 4).forEach(function (i) { items.push({ kind: "Obligationer", label: i.name, sub: CAT_LABEL[i.cat] + " · " + bigSek(i.v2) + " hos fonderna", href: issuerHref(i.key) }); });
      }
      if (state.shorts) {
        holdersNow().filter(function (h) { return scoreMatch(h.name, q) >= 0; }).slice(0, 4).forEach(function (h) {
          items.push({ kind: "Blankare", label: h.name, sub: h.positions.length + " aktier blankade", href: holderHref(h.name) });
        });
      }
      var pages = [["Räntor", "#/rantor"], ["Räntefonder", "#/fonder/rantefonder"], ["Fondbolag", "#/fondbolag"],["Ordlista och vanliga frågor", "#/ordlista"], ["Blankning", "#/blankning"], ["Blankare", "#/blankare"], ["Kvartalsrapport", "#/rapport"], ["Uppköp", "#/uppkop"], ["Avgiftskollen", "#/avgifter"], ["Risk och avkastning", "#/risk"], ["Kända förvaltare", "#/forvaltare"], ["Min fondportfölj", "#/portfolj"], ["Jämför fonder", "#/jamfor"], ["Om datan", "#/om"], ["Kontakt", "#/kontakt"]];
      pages.forEach(function (pg) { if (scoreMatch(pg[0], q) >= 0) items.push({ kind: "Sidor", label: pg[0], sub: "", href: pg[1] }); });
      // Inga exakta träffar: sök igen med stavfel tillåtna
      if (!items.length && !search.fuzzy) { search.fuzzy = true; try { runSearch(); } finally { search.fuzzy = false; } return; }
    }
    search.items = items;
    search.sel = 0;
    var html = "", last = "";
    items.forEach(function (it, i) {
      if (it.kind !== last) {
        html += it.kind === "Senaste" ? '<li class="sr-group" role="presentation">Senaste sökningar<button type="button" class="sr-clear" data-clear-recent>Rensa</button></li>'
          : '<li class="sr-group" role="presentation">' + it.kind + "</li>";
        last = it.kind;
      }
      html += '<li role="option" id="sr-' + i + '" class="sr-item" data-sr="' + i + '"' + (i === 0 ? ' aria-selected="true"' : "") + '>' + (/^(Aktier|Fonder|Fondbolag|Bevakade)$/.test(it.was || it.kind) ? avatar(it.label, true) : "") + '<span class="sr-label">' + esc(it.label) + "</span>" +
        (it.sub ? '<span class="sr-sub">' + esc(it.sub) + "</span>" : "") + "</li>";
    });
    if (!items.length) {
      html = '<li class="sr-empty">' + (q ? "Inga träffar på \"" + esc(q) + "\".<br><small>Fondinsyn visar de " + int(fundList().length) + " värdepappersfonder som rapporterar sina innehav till Finansinspektionen. " +
        "Specialfonder och hedgefonder, till exempel Alcur Grow, rapporterar inte sina innehav öppet och finns därför inte med.</small>" : "Sök bland " + int(d.se.stocks.length + worldNames().length) + " aktier och " + int(fundList().length) + " fonder.") + "</li>";
    }
    $("searchResults").innerHTML = html;
  }

  function moveSel(delta) {
    if (!search.items.length) return;
    search.sel = (search.sel + delta + search.items.length) % search.items.length;
    document.querySelectorAll(".sr-item").forEach(function (li) { li.removeAttribute("aria-selected"); });
    var cur = $("sr-" + search.sel);
    if (cur) { cur.setAttribute("aria-selected", "true"); cur.scrollIntoView({ block: "nearest" }); }
  }
  function pickSel(i) {
    var it = search.items[i == null ? search.sel : i];
    if (!it) return;
    rememberSearch(it);
    closeSearch();
    location.hash = it.href;
  }

  // Senaste sökningar: de sex senast valda träffarna sparas i webbläsaren och visas när sökrutan öppnas
  function recentSearches() { var r = store("ff-recent"); return Array.isArray(r) ? r : []; }
  function rememberSearch(it) {
    if (it.kind === "Senaste") it = { kind: it.was, label: it.label, sub: it.sub, href: it.href };
    var list = recentSearches().filter(function (x) { return x.href !== it.href; });
    list.unshift({ was: it.kind, label: it.label, sub: it.sub || "", href: it.href });
    store("ff-recent", list.slice(0, 6));
  }

  // ---------- Uppköp ----------

  // ---------- Avkastning (Pensionsmyndigheten) ----------

  var PERF_MISSING = '<span class="muted" title="Pensionsmyndigheten har bara avkastning för fonder på premiepensionens fondtorg">Saknas</span>';
  function needPerf() {
    return need("perf", function () {
      return getJSON("data/perf.json").then(function (d) { state.perf = d; });
    });
  }
  // [i år, förra året, året före, snitt 5 år, avgift i premiepensionen, risk, namn, kategori]
  function perfOf(id) { return state.perf && state.perf.funds[id] ? state.perf.funds[id] : null; }
  function retText(v) { return v == null ? "–" : '<span class="' + cls(v) + '">' + (v > 0 ? "+" : "") + fixMinus(nf0.format(v)) + " %</span>"; }
  // Total avkastning över fem år ur den genomsnittliga årliga (CAGR): (1 + r)^5 − 1. Pensionsmyndigheten avrundar
  // snittet till hela procent, så totalen är ungefärlig.
  function total5(p) { return p && p[3] != null ? (Math.pow(1 + p[3] / 100, 5) - 1) * 100 : null; }
  function retApprox(v) { return v == null ? "–" : '<span class="' + cls(v) + '">ca ' + (v > 0 ? "+" : "") + fixMinus(nf0.format(v)) + " %</span>"; }

  function perfBlock(id) {
    if (!needPerf()) return "";
    var p = perfOf(id), y = state.perf.years;
    if (!p) return "";
    return '<section class="block section-gap"><div class="block-head"><h2>' + termLink("avkastning", "Avkastning") + "</h2>" +
      '<span class="note">Pensionsmyndigheten, beräknad ' + esc(state.perf.calculated) + "</span></div>" +
      '<dl class="figures">' + fig(esc(y[0]) + " hittills", retText(p[0])) + fig(esc(y[1]), retText(p[1])) + fig(esc(y[2]), retText(p[2])) +
      fig("Per år, 5 år", retText(p[3]), "genomsnitt (CAGR)") + fig("Totalt, 5 år", retApprox(total5(p)), "uträknat ur snittet") + fig("Risk", p[5] == null ? "–" : nf0.format(p[5]) + " %", "standardavvikelse, 36 mån") + "</dl>" +
      '<p class="desc">Avkastning efter fondens avgifter enligt premiepensionens fondtorg (' + esc(p[6]) + "). I premiepensionen är avgiften rabatterad till " +
      (p[4] == null ? "–" : nf2.format(p[4]) + " %") + ", utanför gäller fondens ordinarie avgift.</p></section>";
  }

  function needOffers() {
    return need("offers", function () {
      return getJSON("data/offers.json").then(function (d) {
        d.offers.forEach(function (o) {
          o.name = cleanTarget(o.target);
          // "Ambea AB ( publ )" blir "Ambea AB (publ)"
          o.bidder = String(o.bidder || "").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").replace(/\s+/g, " ").trim();
          o.holders = (o.holders || []).map(function (h) { return { id: h[0], name: h[1], v: h[2], w: h[3] }; });
          o.held = o.holders.reduce(function (a, h) { return a + h.v; }, 0);
        });
        state.offers = d;
      });
    });
  }
  // Nya bud ur pressmeddelandena på MFN (scripts/build-bids.py), samma dag som de lämnas. Ett bud visas tills
  // Finansinspektionens erbjudandehandling för samma bolag finns i offers.json.
  function needBids() {
    return need("bids", function () {
      return getJSON("data/bids.json").then(function (d) { state.bids = d.bids || []; state.bidEvents = d.events || []; }, function () { state.bids = []; state.bidEvents = []; });
    });
  }
  function newBids(isin) {
    if (!state.bids || !state.offers) return [];
    return state.bids.filter(function (b) {
      if (isin && b.isins.indexOf(isin) < 0) return false;
      var from = new Date(Date.parse(b.date) - 14 * 864e5).toISOString().slice(0, 10);
      return !state.offers.offers.some(function (o) { return o.date >= from && (o.isins || []).some(function (i) { return b.isins.indexOf(i) >= 0; }); });
    });
  }
  function bidPriceText(b) { return b.price == null ? "–" : nf2.format(b.price).replace(/,00$/, "") + " " + (b.cur === "SEK" || !b.cur ? "kr" : b.cur); }
  function cleanTarget(t) { return t ? prettyName(String(t).replace(/\s*\(publ\)\s*/ig, " ").replace(/\s+/g, " ").trim()) : null; }
  function offerUrl(o) { return "https://www.fi.se/sv/vara-register/fis-marknadsregister/prospekt/register/details?id=" + encodeURIComponent(o.id); }
  function offersFor(isin) {
    return state.offers ? state.offers.offers.filter(function (o) { return o.isins && o.isins.indexOf(isin) >= 0; }) : [];
  }

  // Status utifrån historiken: finns aktien kvar i fonderna eller försvann den efter budet?
  // Budets utfall, härlett ur fondernas innehav:
  //   done     aktien försvann ur alla fonder efter budet: bolaget köptes ut och avnoterades
  //   failed   fonderna äger aktien flera kvartal efter budet: bolaget är kvar på börsen
  //   pending  budet kom under eller efter senaste kvartalsrapporten: utfallet syns i nästa rapport
  // Senaste händelsen i ett bud ur pressmeddelandena (scripts/build-bids.py): fullföljt, tillbakadraget, utfall
  // eller förlängd acceptfrist, för något av bolagets aktieslag och tidigast samma dag som budet
  function bidEvent(isins, since) {
    return (state.bidEvents || []).filter(function (e) {
      return e.date >= since && e.isins.some(function (i) { return isins.indexOf(i) >= 0; });
    })[0] || null;
  }
  function eventStatus(e) {
    // andelen som i pressmeddelandet, med upp till två decimaler ("97,99 %")
    var pct = e.pct != null ? e.pct.toLocaleString("sv-SE", { maximumFractionDigits: 2 }) + " % av aktierna" : "";
    if (e.kind === "done") return { key: "done", label: "Genomfört", note: "fullföljs" + (pct ? ", " + pct : "") + ", " + dateText(e.date), url: e.url, ev: e };
    if (e.kind === "withdrawn") return { key: "failed", label: "Inte genomfört", note: "budet drogs tillbaka " + dateText(e.date), url: e.url, ev: e };
    if (e.kind === "result") return { key: "pending", label: "Pågår", note: (pct ? "accepterat av " + pct : "utfall offentliggjort") + ", " + dateText(e.date), url: e.url, ev: e };
    return { key: "pending", label: "Pågår", note: "acceptfristen förlängd " + dateText(e.date), url: e.url, ev: e };
  }

  function offerStatus(o) {
    // Pressmeddelandena går före: de visar utfallet samma dag, fondernas innehav först nästa kvartal
    var ev = o.isins && o.isins.length ? bidEvent(o.isins, o.date) : null;
    if (ev) return eventStatus(ev);
    var h = state.history;
    if (!h || !o.isins || !o.isins.length) return null;
    var last = -1;
    o.isins.forEach(function (isin) {
      var e = h.stocks[isin];
      if (e) e[3].forEach(function (r) { if (r[1] > 0 && r[0] > last) last = r[0]; });
    });
    if (last < 0) return null;
    var latest = h.quarters.length - 1, offerQ = h.qIndex[o.quarter];
    // Fonderna ägde aktien i den senaste kvartalsrapporten. Kom budet under eller efter det kvartalet kan bolaget
    // ha köpts ut senare; det syns först i nästa rapport. Är budet äldre finns bolaget kvar på börsen.
    if (last >= latest) {
      if (offerQ == null || offerQ >= latest - 1) return { key: "pending", label: "Pågår eller oklart", note: "fonder ägde aktien " + dateText(quarterEnd(h.quarters[latest])) };
      return { key: "failed", label: "Inte genomfört", note: "bolaget är kvar på börsen" };
    }
    if (offerQ != null && last < offerQ) return null;
    return { key: "done", label: "Genomfört", note: "borta ur fonderna efter " + quarterLabel(h.quarters[last]) };
  }

  function outcomeText(s) {
    if (s.url) {
      var link = ' <a href="' + esc(s.url) + '" target="_blank" rel="noopener">Läs pressmeddelandet ↗</a>';
      var e = s.ev;
      return (s.key === "done" ? "Enligt pressmeddelandet den " + dateText(e.date) + " fullföljs budet" + (e.pct != null ? ": budgivaren har fått " + e.pct.toLocaleString("sv-SE", { maximumFractionDigits: 2 }) + " % av aktierna" : "") +
          ". Budgivaren tar alltså över bolaget, som sedan brukar lämna börsen."
        : s.key === "failed" ? "Enligt pressmeddelandet den " + dateText(e.date) + " drogs budet tillbaka. Bolaget är kvar på börsen."
        : "Budet pågår: " + s.note + ".") + link;
    }
    return s.key === "done" ? "Aktien försvann ur alla svenska fonder efter budet, vilket betyder att bolaget köptes ut och lämnade börsen. Anslutningsgraden och datum för avnoteringen står i pressmeddelandena."
      : s.key === "failed" ? "Fonderna äger fortfarande aktien flera kvartal efter budet. Budet ledde alltså inte till att bolaget lämnade börsen: det kan ha dragits tillbaka, fått för få ja eller bara gett budgivaren en del av aktierna."
      : "Budet kom under eller efter fondernas senaste kvartalsrapport. Utfallet syns här när nästa rapport kommer, och står redan nu i pressmeddelandena.";
  }
  function outcomeLabel(s) { return '<span class="label ' + { done: "up", failed: "", pending: "warn" }[s.key] + '">' + s.label + "</span>"; }
  // Sökning bland pressmeddelanden hos MFN, där budgivare och bolag publicerar utfallet och avnoteringen
  function offerNewsUrl(o) {
    var name = String(o.name || o.target || "").replace(/\s*\(publ\)\s*/i, " ").replace(/\s+(AB|Aktiebolag)\s*$/i, "").trim();
    return "https://mfn.se/all/s/nordic?query=" + encodeURIComponent(name);
  }

  function offerPriceText(o) {
    if (o.price == null) return o.type === "Aktiebud" ? "Aktier" : "–";
    return nf2.format(o.price).replace(/,00$/, "") + " " + (o.currency === "SEK" ? "kr" : o.currency);
  }

  function viewOffers(id) {
    document.title = "Uppköp – Fondinsyn";
    var head = '<div class="page-head"><h1>Uppköp</h1><p class="meta lead">Offentliga uppköpserbjudanden på Stockholmsbörsen som godkänts av Finansinspektionen, ' +
      "och vilka fonder som ägde bolagen när budet kom. " + termLink("budpremie", "Vad är budpremie?") + "</p></div>";
    if (!needOffers()) return head + (failed("offers") ? errorBlock() : loadingBlock("Laddar uppköp…"));
    needHistory("se");
    if (id) return viewOffer(id);
    var offers = state.offers.offers;
    var withTarget = offers.filter(function (o) { return o.name; });
    var prem = offers.map(function (o) { return o.premium; }).filter(function (p) { return p != null; }).sort(function (a, b) { return a - b; });
    var medPrem = prem.length ? prem[Math.floor(prem.length / 2)] : null;
    var years = offers.map(function (o) { return o.date.slice(0, 4); }).sort();

    // Fonder som oftast ägt bolag som fått bud
    var byFund = {};
    offers.forEach(function (o) {
      o.holders.forEach(function (h) {
        var f = byFund[h.id] = byFund[h.id] || { id: h.id, name: h.name, n: 0, v: 0, targets: [] };
        f.n++; f.v += h.v; f.targets.push(o.name);
      });
    });
    var fiNow = quarterData().fi;
    var winners = Object.keys(byFund).map(function (k) { return byFund[k]; }).filter(function (f) {
      var fi = fiNow[f.id];
      // indexnära fonder och blandfonder räknas bort
      return !INDEX_RE.test(f.name) && !MIXED_RE.test(f.name) && !(fi && fi.ar != null && fi.ar < 1.5);
    })
      .sort(function (a, b) { return b.n - a.n || b.v - a.v; }).slice(0, 12);
    var top = winners[0];

    var targetCell = function (o) {
      var nm = o.name || "Okänt bolag";
      var href = o.isins && o.isins.length ? "#/aktie/" + o.isins[0] : null;
      var sub = o.date + " · " + esc(o.bidder) + (o.premium != null ? " · premie " + nf1.format(o.premium) + " %" : "");
      return (href ? nameCell(href, nm, sub) : '<span class="nm-plain">' + esc(nm) + '</span><span class="sub show-sm">' + sub + "</span>");
    };
    var cols = [
      { key: "date", label: "Datum", align: "l", cls: "muted", hideSm: true, cell: function (o) { return o.date; }, value: function (o) { return o.date; } },
      { key: "name", label: "Bolag", align: "l", cls: "name", cell: targetCell, value: function (o) { return o.name || ""; } },
      { key: "bidder", label: "Budgivare", align: "l", cls: "muted", hideSm: true, cell: function (o) { return esc(o.bidder); }, value: function (o) { return o.bidder; } },
      { key: "price", label: "Pris", hideSm: true, cell: offerPriceText, value: function (o) { return o.price; } },
      { key: "premium", label: "Premie", cell: function (o) { return o.premium == null ? "–" : '<span class="pos">' + nf1.format(o.premium) + " %</span>"; }, value: function (o) { return o.premium; } },
      { key: "held", label: "Fonder ägde", hideSm: true, cell: function (o) { return o.holders.length ? int(o.holders.length) + " · " + bigSek(o.held) : "–"; }, value: function (o) { return o.held; } },
      { key: "status", label: "Utfall", align: "l", hideSm: true, cell: function (o) { var s = offerStatus(o); return s ? outcomeLabel(s) + '<span class="sub">' + s.note + "</span>" : "–"; },
        value: function (o) { var s = offerStatus(o); return s ? s.label : ""; } },
      { key: "more", label: "", cell: function (o) { return '<a href="#/uppkop/' + encodeURIComponent(o.id) + '">Detaljer</a>'; } }
    ];
    var winCols = [
      { key: "name", label: "Fond", align: "l", cls: "name", cell: function (f) { return nameCell(fundHref(f), f.name, f.targets.slice(0, 4).join(", ")); } },
      { key: "n", label: "Uppköpta innehav", cell: function (f) { return '<span class="streak pos">' + f.n + "</span>"; } },
      { key: "v", label: "Värde vid budet", cell: function (f) { return bigSek(f.v); } },
      { key: "t", label: "Bolag", align: "l", cls: "muted", hideSm: true, cell: function (f) { return esc(f.targets.slice(0, 4).join(", ") + (f.targets.length > 4 ? " …" : "")); } }
    ];

    // Nya bud som ännu inte har någon erbjudandehandling hos FI
    var fresh = needBids() ? newBids() : [];
    var freshCols = [
      { key: "date", label: "Datum", align: "l", cls: "muted", hideSm: true, cell: function (b) { return b.date; } },
      { key: "name", label: "Bolag", align: "l", cls: "name", cell: function (b) {
        return nameCell("#/aktie/" + b.isins[0], cleanTarget(b.name) || "Okänt bolag", b.date + (b.bidder ? " · " + esc(b.bidder) : ""));
      } },
      { key: "bidder", label: "Budgivare", align: "l", cls: "muted", hideSm: true, cell: function (b) { return b.bidder ? esc(b.bidder) : "–"; } },
      { key: "price", label: "Pris per aktie", cell: bidPriceText },
      { key: "premium", label: "Premie", cell: function (b) { return b.premium == null ? "–" : '<span class="pos">' + nf1.format(b.premium) + " %</span>"; } },
      { key: "rec", label: "Styrelsen", align: "l", hideSm: true, cell: function (b) {
        var ev = bidEvent(b.isins, b.date), s = ev ? eventStatus(ev) : null;
        return (b.rec === "ja" ? "Rekommenderar budet" : b.rec === "nej" ? '<span class="neg">Avråder</span>' : "–") +
          (s ? '<span class="sub">' + outcomeLabel(s) + " " + s.note + "</span>" : "");
      } },
      { key: "src", label: "", cell: function (b) { return '<a href="' + esc(b.url) + '" target="_blank" rel="noopener">Pressmeddelande ↗</a>'; } }
    ];
    var freshHtml = fresh.length ? '<section class="block section-gap"><div class="block-head"><h2>Nya bud</h2><span class="note">' +
      (fresh.length === 1 ? "1 bud" : int(fresh.length) + " bud") + " utan erbjudandehandling än</span></div>" +
      '<p class="desc">Bud som har lämnats men där Finansinspektionen ännu inte har godkänt erbjudandehandlingen, vilket brukar ta två till fyra veckor. ' +
      "Uppgifterna kommer ur pressmeddelandena på MFN. Premien är mot stängningskursen dagen före budet.</p>" +
      table("bids-new", freshCols, fresh, { static: true }) + "</section>" : "";

    return head +
      '<div class="highlights">' +
      highlight("Uppköpserbjudanden", int(offers.length) + " bud", null, years.length ? "sedan " + years[0] : "", "Godkända erbjudandehandlingar hos FI") +
      highlight("Mittenvärde för budpremien", medPrem != null ? nf1.format(medPrem) + " %" : "–", null, "", "Mot stängningskursen dagen före budet, " + prem.length + " bud") +
      highlight("Flest uppköpta innehav", top ? top.name : null, top ? fundHref(top) : null, top ? top.n + " bolag som fått bud" : "", top ? "ägda kvartalet före budet" : "") +
      "</div>" +
      freshHtml +
      '<section class="block section-gap"><div class="block-head"><h2>Alla bud</h2><span class="note">' + int(withTarget.length) + " av " + int(offers.length) + " med identifierat målbolag</span></div>" +
      table("offers", cols, offers, { csv: true, sort: { col: "date", dir: -1 } }) + "</section>" +
      '<section class="block section-gap"><div class="block-head"><h2>Fonderna som oftast ägt uppköpta bolag</h2></div>' +
      '<p class="desc">Antal bolag som fonden ägde vid kvartalsslutet före budet. Indexfonder, blandfonder och fonder med aktiv risk under 1,5 % är borträknade.</p>' +
      table("offer-winners", winCols, winners, { static: true, empty: "Inga fonder." }) + "</section>" +
      '<p class="desc section-gap">Källa: Finansinspektionens prospektregister. Målbolag, pris och premie läses automatiskt ur erbjudandehandlingarna och kan i enstaka fall bli fel. ' +
      "Bud på First North och andra marknader utan krav på godkänd erbjudandehandling saknas.</p>" +
      '<p class="desc"><b>Utfallet</b> läses ur fondernas kvartalsrapporter till Finansinspektionen, senast' + (state.history ? " " + dateText(quarterEnd(state.history.quarters[state.history.quarters.length - 1])) : "") + ". " +
      "<b>Genomfört</b>: aktien försvann ur alla fonder efter budet, bolaget köptes ut. <b>Inte genomfört</b>: fonderna äger aktien flera kvartal senare, bolaget är kvar på börsen. " +
      "<b>Pågår eller oklart</b>: budet kom under eller efter senaste rapporten. I sällsynta fall kan ett litet bolag försvinna ur fonderna utan att ha köpts ut. " +
      "Exakt anslutningsgrad står i pressmeddelandena, som det finns en länk till på varje bud.</p>";
  }

  function viewOffer(id) {
    var o = state.offers.offers.filter(function (x) { return x.id === id; })[0];
    if (!o) return notFound("Budet finns inte.");
    document.title = (o.name || "Uppköp") + " – Fondinsyn";
    var st = offerStatus(o);
    var cols = [
      { key: "name", label: "Fond", align: "l", cls: "name", cell: function (h) { return nameCell(fundHref(h), h.name, bigSek(h.v) + (h.w != null ? " · " + nf1.format(h.w * 100) + " % av fonden" : "")); } },
      { key: "v", label: "Innehav", cell: function (h) { return bigSek(h.v); }, value: function (h) { return h.v; } },
      { key: "w", label: "Andel av fonden", cell: function (h) { return h.w != null ? nf2.format(h.w * 100) + " %" : "–"; }, value: function (h) { return h.w; } }
    ];
    return '<div class="page-head"><div class="crumbs"><a href="#/uppkop">Uppköp</a> / ' + esc(o.name || o.bidder) + "</div>" +
      "<h1>" + esc(o.name || "Okänt målbolag") + '</h1><p class="meta">Bud från ' + esc(o.bidder) + " · " + esc(o.type) + " · " + o.date + "</p></div>" +
      // Uppgifter som inte gick att läsa ur erbjudandehandlingen visas inte
      '<dl class="figures">' + (o.price != null || o.type === "Aktiebud" ? fig("Pris per aktie", offerPriceText(o)) : "") +
      (o.premium != null ? fig("Premie", nf1.format(o.premium) + " %", "mot stängningskursen före budet") : "") +
      fig("Fonder som ägde", int(o.holders.length), quarterLabel(o.quarter)) + (o.holders.length ? fig("Fondernas innehav", bigSek(o.held)) : "") +
      (st ? fig("Utfall", outcomeLabel(st), st.note) : "") + "</dl>" +
      '<p class="actions-row">' + (o.isins && o.isins.length ? '<a class="btn" href="#/aktie/' + o.isins[0] + '">Aktiens sida och historik</a> ' : "") +
      '<a class="btn" href="' + offerUrl(o) + '" target="_blank" rel="noopener">Erbjudandehandlingen hos FI ↗</a> ' +
      '<a class="btn" href="' + offerNewsUrl(o) + '" target="_blank" rel="noopener">Pressmeddelanden om budet ↗</a></p>' +
      (st ? '<p class="desc">' + outcomeText(st) + "</p>" : "") +
      '<section class="block section-gap"><div class="block-head"><h2>Fonder som ägde bolaget</h2><span class="note">Vid kvartalsslutet före budet, ' + quarterLabel(o.quarter) + "</span></div>" +
      table("offer-holders-" + o.id, cols, o.holders, { sort: { col: "v", dir: -1 }, empty: "Inga svenska fonder ägde bolaget." }) + "</section>";
  }

  // ---------- Blankning ----------

  function needShorts() {
    return need("shorts", function () {
      return getJSON("data/shorts.json").then(function (d) {
        d.agg = d.aggregate.map(function (r) { return { name: r[0].trim(), isin: r[1], pct: r[2], date: r[3], ch30: r[4] }; });
        d.byIsin = {};
        d.agg.forEach(function (a) { if (a.isin) d.byIsin[a.isin] = a; });
        d.cur = d.current.map(function (r) { return { holder: r[0], isin: r[1], pct: r[2], date: r[3] }; });
        d.holdersOf = {};
        d.cur.forEach(function (c) { (d.holdersOf[c.isin] = d.holdersOf[c.isin] || []).push(c); });
        state.shorts = d;
      });
    });
  }

  function shortStock(isin) {
    var d = quarterData();
    return isin ? (d.se.byIsin[isin] || (d.world && d.world.byIsin[isin]) || null) : null;
  }
  function shortName(a) { var s = shortStock(a.isin); return s ? s.name : prettyName(a.name); }
  function shortCell(a, sub) {
    var s = shortStock(a.isin);
    return s ? nameCell(stockHref(s), s.name, sub) : '<span class="nm-plain">' + esc(prettyName(a.name)) + "</span>" + (sub ? '<span class="sub show-sm">' + sub + "</span>" : "");
  }
  function pctCell(v, signed2) {
    if (v == null) return "–";
    return signed2 ? '<span class="' + (v > 0 ? "neg" : v < 0 ? "pos" : "") + '">' + (v > 0 ? "+" : "") + fixMinus(nf2.format(v)) + "</span>" : nf2.format(v) + " %";
  }

  var shortFilter = { min: 0.5 };

  function viewShorts() {
    document.title = "Blankning – Fondinsyn";
    var head = '<div class="page-head"><h1>Blankning</h1><p class="meta lead">Vilka aktier hedgefonder och andra fondförvaltare satsar på ska sjunka. ' +
      "Från Finansinspektionens blankningsregister, uppdateras varje dag. " + termLink("blankning", "Vad är blankning?") + "</p></div>";
    if (!needShorts()) return head + (failed("shorts") ? errorBlock() : loadingBlock("Laddar blankning…"));
    var d = state.shorts;
    var agg = d.agg.slice().sort(function (a, b) { return b.pct - a.pct; });
    var top = agg[0];
    var rising = d.agg.filter(function (a) { return a.ch30 != null && a.ch30 > 0; }).sort(function (a, b) { return b.ch30 - a.ch30; }).slice(0, 10);
    var falling = d.agg.filter(function (a) { return a.ch30 != null && a.ch30 < 0; }).sort(function (a, b) { return a.ch30 - b.ch30; }).slice(0, 10);
    // Konflikt: svenska fonder köpte senaste kvartalet men aktien är kraftigt blankad
    var conflict = agg.filter(function (a) { var s = shortStock(a.isin); return a.pct >= 2 && s && s.netFlow > 0; }).slice(0, 10);

    // Blankarna: aktuella positioner per innehavare
    var holders = {};
    d.cur.forEach(function (c) {
      var h = holders[c.holder] = holders[c.holder] || { name: c.holder, n: 0, sum: 0, top: [] };
      h.n++; h.sum += c.pct; h.top.push(c);
    });
    var holderList = Object.keys(holders).map(function (k) { return holders[k]; }).sort(function (a, b) { return b.n - a.n || b.sum - a.sum; });
    var bigHolder = holderList[0];

    var mostCols = [
      { key: "name", label: "Aktie", align: "l", cls: "name", value: function (a) { return shortName(a); }, cell: function (a) {
        var hs = d.holdersOf[a.isin] || [];
        return shortCell(a, hs.length + " blankare" + (a.ch30 ? " · 30 dagar: " + (a.ch30 > 0 ? "+" : "") + fixMinus(nf2.format(a.ch30)) : ""));
      } },
      { key: "pct", label: "Blankat", cell: function (a) { return '<span class="short-pct">' + nf2.format(a.pct) + " %</span>"; }, value: function (a) { return a.pct; } },
      { key: "ch30", label: "Δ 30 dagar", hideSm: true, cell: function (a) { return pctCell(a.ch30, true); }, value: function (a) { return a.ch30; } },
      { key: "n", label: "Blankare ≥0,5 %", hideSm: true, cell: function (a) { return int((d.holdersOf[a.isin] || []).length); }, value: function (a) { return (d.holdersOf[a.isin] || []).length; } },
      { key: "funds", label: "Fonder äger", hideSm: true, cell: function (a) { var s = shortStock(a.isin); return s ? int(s.f2) : "–"; }, value: function (a) { var s = shortStock(a.isin); return s ? s.f2 : null; } },
      { key: "flow", label: "Fondernas nettoköp " + quarterLabel(state.q), hideSm: true, cell: function (a) { var s = shortStock(a.isin); return s && s.netFlow != null ? '<span class="' + cls(s.flow) + '">' + mkr(s.flow, true) + " mkr</span>" : "–"; },
        value: function (a) { var s = shortStock(a.isin); return s ? s.netFlow : null; } }
    ];
    var chCols = [
      { key: "name", label: "Aktie", align: "l", cls: "name", cell: function (a) { return shortCell(a, nf2.format(a.pct) + " % blankat"); } },
      { key: "ch", label: "Δ 30 dagar", cell: function (a) { return pctCell(a.ch30, true) + " %-enh."; } },
      { key: "pct", label: "Blankat nu", cell: function (a) { return nf2.format(a.pct) + " %"; } }
    ];
    var holderCols = [
      { key: "name", label: "Blankare", align: "l", cls: "name", cell: function (h) {
        var tops = h.top.sort(function (a, b) { return b.pct - a.pct; }).slice(0, 3).map(function (c) { return (d.names[c.isin] ? prettyName(d.names[c.isin]) : c.isin) + " " + nf2.format(c.pct) + " %"; }).join(", ");
        return holderLink(h.name) + '<span class="sub">' + esc(tops) + "</span>";
      } },
      { key: "n", label: "Positioner", cell: function (h) { return int(h.n); } },
      { key: "sum", label: "Summa", hideSm: true, cell: function (h) { return nf2.format(h.sum) + " %"; } }
    ];
    var recentCols = [
      { key: "date", label: "Datum", align: "l", cls: "muted", cell: function (r) { return r[0]; } },
      { key: "name", label: "Aktie", align: "l", cls: "name", cell: function (r) {
        var s = shortStock(r[2]), nm = s ? s.name : prettyName(d.names[r[2]] || r[2]);
        return (s ? '<a href="' + stockHref(s) + '">' + esc(nm) + "</a>" : '<span class="nm-plain">' + esc(nm) + "</span>") + '<span class="sub">' + holderLink(r[1]) + "</span>";
      } },
      { key: "p", label: "Ny position", cell: function (r) { return r[3] > 0 ? nf2.format(r[3]) + " %" : '<span class="muted" title="Positionen är under 0,5 % och redovisas inte längre med namn">&lt; 0,5 %</span>'; } }
    ];
    var listed = agg.filter(function (a) { return a.pct >= shortFilter.min; });
    var seg = function (v, label) { return '<button type="button" class="seg-btn" data-short-min="' + v + '" aria-pressed="' + (shortFilter.min === v) + '">' + label + "</button>"; };

    return head +
      '<div class="highlights">' +
      highlight("Mest blankad", top ? shortName(top) : null, top && shortStock(top.isin) ? stockHref(shortStock(top.isin)) : null, top ? '<span class="neg">' + nf2.format(top.pct) + " % av aktierna</span>" : "", top ? (d.holdersOf[top.isin] || []).length + " blankare med minst 0,5 %" : "") +
      highlight("Blankade bolag", int(d.agg.length) + " bolag", null, "", "Med sammanlagd blankning över 0,1 %") +
      highlight("Flest positioner", bigHolder ? bigHolder.name : null, null, bigHolder ? bigHolder.n + " aktier blankade" : "", "Positioner på minst 0,5 %") +
      "</div>" +
      '<section class="block section-gap"><div class="block-head"><h2>Mest blankade aktier</h2>' +
      '<div class="seg" role="group" aria-label="Urval">' + seg(0.5, "Över 0,5 %") + seg(2, "Över 2 %") + seg(0, "Alla") + "</div></div>" +
      '<p class="desc">Andel av bolagets aktier som är blankade, summan av alla rapporterade positioner över 0,1 %. Kolumnerna till höger visar vad svenska fonder gjorde senaste kvartalet.</p>' +
      table("shorts-most", mostCols, listed, { csv: true, sort: { col: "pct", dir: -1 }, limit: 60, empty: "Inga bolag i urvalet." }) + "</section>" +
      '<div class="grid-2 section-gap">' +
      block("Fonder köper, blankare satsar mot", "Minst 2 % blankat, men svenska fonder nettoköpte aktien senaste kvartalet.", table("shorts-conflict", [
        { key: "name", label: "Aktie", align: "l", cls: "name", cell: function (a) { return shortCell(a, ""); } },
        { key: "pct", label: "Blankat", cell: function (a) { return nf2.format(a.pct) + " %"; } },
        { key: "flow", label: "Fonderna köpte", cell: function (a) { var s = shortStock(a.isin); return '<span class="pos">' + mkr(s.flow, true) + " mkr</span>"; } }
      ], conflict, { static: true, empty: "Inga sådana aktier just nu." })) +
      block("Största blankarna", "Fonder och förvaltare med flest offentliga positioner just nu.", table("shorts-holders", holderCols, holderList.slice(0, 12), { static: true }) + '<a class="more" href="#/blankare">Alla blankare</a>') +
      "</div>" +
      '<div class="grid-2 section-gap">' +
      block("Ökad blankning", "Störst ökning av offentliga positioner senaste 30 dagarna", table("shorts-up", chCols, rising, { static: true, empty: "Ingen ökning." })) +
      block("Minskad blankning", "Blankarna har täckt", table("shorts-down", chCols, falling, { static: true, empty: "Ingen minskning." })) +
      "</div>" +
      '<section class="block section-gap"><div class="block-head"><h2>Senaste ändringarna</h2><span class="note">Senaste 30 dagarna</span></div>' +
      table("shorts-recent", recentCols, d.recent.slice(0, 60), { static: true, empty: "Inga ändringar." }) + "</section>" +
      '<p class="desc section-gap">FI publicerar namn bara för positioner på minst 0,5 % av aktierna. Den sammanlagda blankningen inkluderar även mindre positioner från 0,1 %. ' +
      "Förändringen över 30 dagar bygger på de offentliga positionerna. Källa: Finansinspektionens blankningsregister, uppdaterad " + esc(d.built) + ".</p>";
  }

  // Blankning på aktiesidan
  // ---------- Insynshandel ----------
  // data/insider.json byggs av scripts/build-insider.ps1 ur FI:s insynsregister (senaste 90 dagarna, bara aktier)

  function needInsider() {
    return need("insider", function () {
      return getJSON("data/insider.json").then(function (x) {
        var rows = x.rows.map(insiderRow);
        var byIsin = {};
        rows.forEach(function (r) { (byIsin[r.isin] = byIsin[r.isin] || []).push(r); });
        state.insider = { built: x.built, from: x.from, days: x.days, rows: rows, byIsin: byIsin };
      });
    });
  }
  var insiderFilter = { kind: "buy", min: 100000, period: "90", own: false };
  function daysAgo(n) { return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10); }
  function insiderKind(r) {
    return r.kind === "buy" ? '<span class="label up">Köp</span>' : r.kind === "sell" ? '<span class="label down">Sälj</span>' : '<span class="label">' + esc(r.nature) + "</span>";
  }
  function insiderValue(r) {
    // Stora belopp i mkr ("234,6 mkr") så att kolumnen går att läsa av, exakt belopp när man håller muspekaren över
    if (r.sek != null) return '<span class="' + (r.kind === "sell" ? "neg" : r.kind === "buy" ? "pos" : "") + '" title="' + esc(kr(r.sek)) + '">' + (Math.abs(r.sek) >= 1e6 ? bigSek(r.sek) : kr(r.sek)) + "</span>";
    return r.vol != null && r.price != null ? nf0.format(r.vol * r.price) + " " + esc(r.cur) : "–";
  }
  function issuerCell(r, sub) {
    var s = quarterData().se.byIsin[r.isin];
    return s ? nameCell(stockHref(s), r.issuer, sub) : '<span class="nm-plain">' + esc(r.issuer) + "</span>" + (sub ? '<span class="sub show-sm">' + sub + "</span>" : "");
  }
  // En del anmälningar har namnet i bara gemener ("björn krasse"): ge dem stor bokstav
  function personName(p) {
    p = String(p || "");
    // Namn skrivna med bara gemener eller bara versaler får stor bokstav i början av varje namn
    if (p === p.toUpperCase() && /[A-ZÅÄÖ]{2}/.test(p)) p = p.toLowerCase();
    return p === p.toLowerCase() ? p.replace(/(^|[\s-])(\S)/g, function (m, a, c) { return a + c.toUpperCase(); }) : p;
  }
  // Närstående är familjemedlemmar eller bolag som personen kontrollerar eller företräder (till exempel ett
  // investmentbolag där personen är vd). Registret säger inte vem, bara att det inte var personen själv.
  var CLOSE_INFO = "Närstående är familjemedlemmar eller bolag som personen kontrollerar eller företräder, till exempel ett investmentbolag där personen är vd. Sådana affärer kan vara mycket större än personens egna.";
  function personText(r) {
    var n = esc(personName(r.person));
    return r.close ? '<span class="close-of" title="' + esc(CLOSE_INFO) + '">Närstående till</span> ' + n : n;
  }
  // ", varav 468 mkr via närstående" när mer än hälften av nettot kommer från närstående
  function closeNote(total, part) {
    if (!part || !total || Math.abs(part) < 0.5 * Math.abs(total)) return "";
    return Math.abs(part) >= 0.95 * Math.abs(total) ? ", nästan allt via närstående" : ", varav " + bigSek(Math.abs(part)) + " via närstående";
  }

  // ---------- Fondernas ägarandel ----------
  // data/shares.json (scripts/build-shares.ps1): antal aktier per aktieslag för bolag på Nasdaq Stockholm och First North.
  // Ägarandelen är fondernas antal aktier delat med antalet aktier i aktieslaget, samma antal aktier för båda kvartalen.

  function needShares() {
    return need("shares", function () { return getJSON("data/shares.json").then(function (d) { state.shares = d.shares || {}; state.sharesBuilt = d.built; state.nasdaqIds = d.book || {}; state.prices = d.px || {}; }); });
  }
  // Länk till aktiens sida hos Nasdaq, där dagens kurs finns (vi visar själva bara kursen vid kvartalsslutet)
  function nasdaqUrl(isin) {
    var b = state.nasdaqIds && state.nasdaqIds[isin];
    if (!b || !b[0] || !b[1]) return null;
    return "https://www.nasdaq.com/european-market-activity/shares/" + encodeURIComponent(b[1].toLowerCase().replace(/\s+/g, "-")) + "?id=" + encodeURIComponent(b[0]);
  }
  function ownShare(s, prev) {
    var n = state.shares && state.shares[s.isin];
    if (!n || !n[0]) return null;
    var h = prev ? s.h1b : s.h2;
    return h ? Math.min(1, h / n[0]) : 0;
  }
  function ownText(v) { return v == null ? "–" : nf1.format(v * 100) + " %"; }

  function viewOwnership() {
    document.title = "Fondernas ägarandel – Fondinsyn";
    var head = '<div class="page-head"><h1>Fondernas ägarandel</h1><p class="meta lead">Hur stor del av bolagen som svenska fonder äger tillsammans, ' +
      "och var de ökade och minskade sin andel under " + quarterLabel(state.q) + ". En hög andel betyder att många fonder redan äger aktien: " +
      "de kan bära kursen, men säljer de samtidigt blir det trångt i dörren.</p></div>";
    if (!needShares()) return head + (failed("shares") ? errorBlock() : loadingBlock());
    var rows = quarterData().se.stocks.filter(function (s) { return s.price && s.h2 && ownShare(s) != null; }).map(function (s) {
      // Nynoterade bolag (ingen fond ägde dem förra kvartalet) har ingen jämförelse
      var a = ownShare(s), b = s.isNew ? null : ownShare(s, true);
      return { s: s, name: s.name, isin: s.isin, own: a, prev: b, d: b == null ? null : a - b };
    });
    var top = rows.slice().sort(function (a, b) { return b.own - a.own; });
    var up = rows.filter(function (r) { return r.d > 0; }).sort(function (a, b) { return b.d - a.d; });
    var down = rows.filter(function (r) { return r.d < 0; }).sort(function (a, b) { return a.d - b.d; });
    var colName = { key: "name", label: "Aktie", align: "l", cls: "name", cell: function (r) { return nameCell(stockHref(r.s), r.s.name, int(r.s.f2) + " fonder äger " + ownText(r.own)); }, value: function (r) { return r.name; } };
    var colOwn = { key: "own", label: "Ägarandel", cell: function (r) { return '<span class="own-cell"><span class="own-bar"><i style="width:' + Math.min(100, r.own / 0.4 * 100).toFixed(1) + '%"></i></span>' + ownText(r.own) + "</span>"; }, value: function (r) { return r.own; } };
    var colD = { key: "d", label: "Förändring", cell: function (r) { return r.d == null ? "–" : '<span class="' + cls(r.d) + '">' + signed(nf1.format(r.d * 100), r.d) + " p.e.</span>"; }, value: function (r) { return r.d; } };
    var colF = { key: "f", label: "Fonder", hideSm: true, cell: function (r) { return int(r.s.f2); }, value: function (r) { return r.s.f2; } };
    var colV = { key: "v", label: "Innehav (mkr)", hideSm: true, cell: function (r) { return mkr(r.s.val2); }, value: function (r) { return r.s.val2; } };
    var avg = rows.length ? rows.reduce(function (a, r) { return a + r.own; }, 0) / rows.length : 0;
    var over20 = rows.filter(function (r) { return r.own >= 0.2; }).length;
    return head +
      '<dl class="figures">' + fig("Aktier med uppgift", int(rows.length), "Nasdaq Stockholm och First North") +
      fig("Fonderna äger minst 20 %", int(over20) + " bolag") + fig("Genomsnittlig ägarandel", ownText(avg)) +
      fig("Högst ägarandel", top[0] ? esc(top[0].s.name) : "–", top[0] ? ownText(top[0].own) : "") + "</dl>" +
      block("Där fonderna äger mest", "Andel av aktierna i aktieslaget som ägs av svenska fonder i slutet av " + quarterLabel(state.q) + ".",
        table("own-top", [colName, colOwn, colD, colF, colV], top, { csv: true, sort: { col: "own", dir: -1 }, limit: 30, expand: true })) +
      '<div class="grid-2 section-gap">' +
      block("Fonderna ökade sin andel mest", "Förändring i procentenheter jämfört med " + quarterLabel(quarterData().meta.prevId) + ".", table("own-up", [colName, colD, colOwn], up.slice(0, 15), { static: true })) +
      block("Fonderna minskade sin andel mest", "&nbsp;", table("own-down", [colName, colD, colOwn], down.slice(0, 15), { static: true })) + "</div>" +
      '<p class="desc section-gap">Antalet aktier per aktieslag kommer från Nasdaq (uppdaterat ' + esc(state.sharesBuilt || "") + "). För bolag med flera aktieslag (A och B) gäller andelen det aktieslag som står i listan. " +
      "Fonder som inte rapporterar till Finansinspektionen, till exempel utländska fonder, räknas inte med.</p>";
  }

  // Risk och avkastning: alla aktiefonder med femårshistorik hos Pensionsmyndigheten på en karta, och i en tabell
  function viewRisk() {
    document.title = "Risk och avkastning – Fondinsyn";
    var head = '<div class="page-head"><h1>Risk och avkastning</h1><p class="meta lead">Alla aktiefonder med fem års historik på en karta: hur mycket fondens värde svänger, ' +
      "och vad den har gett per år. Bäst är mycket avkastning med låg risk, uppe till vänster.</p></div>";
    if (!needPerf()) return head + (failed("perf") ? errorBlock() : loadingBlock());
    var pts = fundList().map(function (fi) {
      var p = perfOf(fi.id), cat = fundCategory(fi);
      if (!p || fi.sd == null || p[3] == null || (cat !== "index" && cat !== "active" && cat !== "closet")) return null;
      return { x: fi.sd, y: p[3], size: fi.aum, cls: "c-" + cat, fi: fi, p: p };
    }).filter(Boolean);
    if (pts.length < 15) return head + '<div class="notice">Det finns för få fonder med avkastning just nu.</div>';
    var ct = corrTest(pts.map(function (p) { return p.x; }), pts.map(function (p) { return p.y; }));
    var riskText = ct.level === "none" ?
      "Fonder med högre risk har inte gett säkert högre eller lägre avkastning de här fem åren: korrelationen är " + rText(ct.r) + " och kan vara slump. " :
      "Fonder med högre risk har i snitt gett " + (ct.r > 0 ? "högre" : "lägre") + " avkastning de här fem åren. Sambandet är " + (ct.level === "strong" ? "starkt" : "svagt") +
        ": risken samvarierar med ungefär " + nf0.format(ct.r2 * 100) + " % av skillnaderna i avkastning. ";
    var riskBox = corrBox({ t: ct, unit: "fonder", unitNote: "aktiefonder med fem års historik",
      text: riskText + "Spridningen är stor, och fonder med samma risk skiljer sig ofta flera procentenheter per år.",
      caveats: [
        "<b>Överlevnadsbias.</b> Bara fonder som finns i dag och har fem års historik är med. Fonder som lagts ner eller slagits ihop, ofta efter svag avkastning, saknas.",
        "<b>Olika perioder.</b> Risken gäller de senaste 24 månaderna (Finansinspektionen), avkastningen fem år (Pensionsmyndigheten).",
        "<b>En enda femårsperiod.</b> Resultatet beror mycket på vilka marknader som gick bra just de här åren, inte bara på risken. Det säger lite om nästa fem år.",
        "<b>Inte oberoende.</b> Många fonder äger samma aktier. Det verkliga antalet oberoende observationer är färre än antalet fonder, så p-värdet är snarare för lågt.",
        "<b>Urval.</b> Bara fonder i premiepensionen, och avkastningen är räknad efter premiepensionens rabatterade avgift."
      ] });
    // Avkastning per procentenhet risk: ett enkelt mått på hur mycket fonden gett för svängningarna
    // Medianfonden delar kartan i fyra delar. De tre största fonderna och fonderna med högst och lägst avkastning
    // får namn i diagrammet (på mobilen bara de tre största).
    var medX = FFCharts.median(pts.map(function (p) { return p.x; })), medY = FFCharts.median(pts.map(function (p) { return p.y; }));
    var big = pts.slice().sort(function (a, b) { return (b.fi.aum || 0) - (a.fi.aum || 0); }).slice(0, 3);
    var byY = pts.slice().sort(function (a, b) { return b.y - a.y || (b.fi.aum || 0) - (a.fi.aum || 0); });
    var extremes = [byY[0], byY[byY.length - 1]];
    var shortFund = function (n) { return n.length <= 26 ? n : n.slice(0, 25).replace(/\s+\S*$/, "") + "…"; };
    var cols = [
      { key: "name", label: "Fond", align: "l", cls: "name", value: function (p) { return p.fi.name; }, cell: function (p) { return nameCell(fundHref(p.fi), p.fi.name, esc(p.fi.co) + " · " + esc(p.p[7] || "")); } },
      { key: "y", label: "Per år, 5 år", cell: function (p) { return retText(p.y); }, value: function (p) { return p.y; } },
      { key: "x", label: "Risk", cell: function (p) { return nf1.format(p.x) + " %"; }, value: function (p) { return p.x; } },
      { key: "ratio", label: "Avkastning per risk", hideSm: true, cell: function (p) { return fixMinus(nf2.format(p.y / p.x)); }, value: function (p) { return p.y / p.x; } },
      { key: "fee", label: "Avgift", hideSm: true, cell: function (p) { return feeText(p.fi); }, value: function (p) { return p.fi.feeMax; } }
    ];
    return head + '<section class="block"><div class="block-head"><h2>Fondkartan</h2><span class="note">' + int(pts.length) + " aktiefonder med femårshistorik</span></div>" +
      '<div class="chart-card"><p class="chart-howto">Varje prick är en aktiefond. <b>Till höger</b> svänger fondens värde mer, alltså högre risk. ' +
      "<b>Högre upp</b> har fonden gett bättre avkastning. De streckade linjerna är medianfonden, så uppe till vänster om dem finns fonderna som gett mer avkastning med lägre risk än de flesta. " +
      "Peka på en prick eller en kategori för att se vilka fonder det är.</p>" + chart(function (node) {
        var narrow = node.clientWidth < 520;
        FFCharts.xy(node, pts, {
          height: narrow ? 360 : 460, xHint: ["← Lugnare", "Svänger mer →"], xTicks: 10, yTicks: 8,
          xFmt: function (v) { return nf1.format(v).replace(/,0$/, "") + " %"; }, yFmt: function (v) { return fixMinus(nf0.format(v)) + " %"; },
          xLabel: "Risk: standardavvikelse, 24 månader", yLabel: "Avkastning per år, 5 år",
          aria: "Punktdiagram över " + pts.length + " aktiefonder: risk mot avkastning per år. Alla värden finns i tabellen nedanför.",
          legend: catLegend(["active", "closet", "index"], pts),
          sizeKey: { values: [1e9, 25e9], fmt: function (v) { return nf0.format(v / 1e9) + " mdkr"; } },
          ref: { x: medX, y: medY, xText: "Medianrisk " + nf1.format(medX) + " %", yText: "Medianavkastning " + fixMinus(nf1.format(medY)) + " %" },
          quad: { tl: "Mer avkastning, lägre risk", br: "Mindre avkastning, högre risk" },
          label: function (p) { return big.indexOf(p) >= 0 || (!narrow && extremes.indexOf(p) >= 0) ? shortFund(p.fi.name) : null; },
          tip: function (p) {
            return "<b>" + esc(p.fi.name) + "</b>" + '<div class="muted">' + esc(p.fi.co) + "</div>" +
              tipRow("", "Avkastning per år", (p.y > 0 ? "+" : "") + fixMinus(nf0.format(p.y)) + " %") + tipRow("", "Risk", nf1.format(p.x) + " %") +
              tipRow("", "Avgift", feeText(p.fi)) + tipRow("", "Förmögenhet", bigSek(p.fi.aum)) +
              tipRow(p.cls, CAT_NAMES[p.cls.slice(2)], "");
          },
          onClick: function (p) { location.hash = fundHref(p.fi); }
        });
      }) + '<p class="chart-note">Punktens storlek är fondförmögenheten. Namnen i diagrammet är de tre största fonderna och de med högst och lägst avkastning. ' +
      "Pensionsmyndigheten avrundar avkastningen till hela procent, därför står många fonder på samma höjd. " +
      "Avkastningen kommer från Pensionsmyndigheten, risken från Finansinspektionen. Fonder utanför premiepensionen saknas.</p></div>" + riskBox + "</section>" +
      block("Alla fonder på kartan", "Sorterat på avkastning per risk: avkastningen per år delat med risken. Högre är bättre. Tryck på en rubrik för att sortera om.",
        table("risk-funds", cols, pts, { sort: { col: "ratio", dir: -1 }, limit: 15, expand: true, csv: true }), "section-gap") +
      '<p class="desc section-gap">Historisk avkastning är ingen garanti för framtida avkastning. Risken är standardavvikelsen för fondens avkastning de senaste 24 månaderna.</p>';
  }

  // ---------- Statistik ----------
  // Gemensamma test för analyserna som drar en slutsats: t-test, permutationstest, bootstrap och korrelation med p-värde.
  // Slumpen i permutationstest och bootstrap har ett fast frö, så att siffrorna inte ändras mellan två visningar.

  function lnGamma(x) {
    var c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    var y = x, t = x + 5.5, s = 1.000000000190015;
    t -= (x + 0.5) * Math.log(t);
    for (var j = 0; j < 6; j++) s += c[j] / ++y;
    return -t + Math.log(2.5066282746310005 * s / x);
  }
  // Kedjebråk för den regulariserade ofullständiga betafunktionen (Numerical Recipes)
  function betaCf(a, b, x) {
    var tiny = 1e-30, qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap;
    d = 1 / (Math.abs(d) < tiny ? tiny : d);
    var h = d;
    for (var m = 1; m <= 300; m++) {
      var m2 = 2 * m, aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; d = 1 / (Math.abs(d) < tiny ? tiny : d);
      c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
      h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; d = 1 / (Math.abs(d) < tiny ? tiny : d);
      c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
      var del = d * c; h *= del;
      if (Math.abs(del - 1) < 3e-14) break;
    }
    return h;
  }
  function ibeta(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    var bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? bt * betaCf(a, b, x) / a : 1 - bt * betaCf(b, a, 1 - x) / b;
  }
  // Tvåsidigt p-värde för ett t-värde med df frihetsgrader
  function pFromT(t, df) { return df > 0 && !isNaN(t) ? (isFinite(t) ? Math.min(1, ibeta(df / (df + t * t), df / 2, 0.5)) : 0) : 1; }
  // t-värdet som ger ett 95 % konfidensintervall
  function tCrit(df) {
    var lo = 0, hi = 100;
    for (var i = 0; i < 60; i++) { var mid = (lo + hi) / 2; if (pFromT(mid, df) > 0.05) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  }
  function seeded(seed) {
    return function () {
      seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function avgOf(v) { return v.reduce(function (a, b) { return a + b; }, 0) / v.length; }

  // Bedömningen. Utan p under 0,05 dras ingen slutsats. Med signifikans avgör effektens storlek om sambandet kallas
  // starkt eller svagt: en korrelation på minst 0,5, eller ett snitt minst en halv standardavvikelse från noll.
  function strength(p, size) { return !(p < 0.05) ? "none" : Math.abs(size) >= 0.5 ? "strong" : "weak"; }
  var STRENGTH = { strong: "Starkt samband", weak: "Svagt samband", none: "Inget statistiskt säkerställt samband" };

  // Skiljer sig snittet från noll? Två test: ett t-test och ett permutationstest där varje utfall slumpvis får byta
  // tecken (utan någon effekt är ett utfall lika troligt positivt som negativt). Slutsatsen kräver att båda ger p under
  // 0,05, och p-värdet som visas är det högsta. Är utfallen skeva kommer intervallet från bootstrap, annars från t-testet.
  function testMean(v) {
    var n = v.length, m = avgOf(v), i, r, s;
    var sd = Math.sqrt(v.reduce(function (a, x) { return a + (x - m) * (x - m); }, 0) / Math.max(1, n - 1));
    var se = sd / Math.sqrt(n), t = se ? m / se : 0, pT = n > 1 ? pFromT(t, n - 1) : 1;
    var m3 = v.reduce(function (a, x) { return a + Math.pow(x - m, 3); }, 0) / n, sdN = sd * Math.sqrt((n - 1) / n);
    var skewed = n > 2 && sdN > 0 && Math.abs(m3 / Math.pow(sdN, 3)) > 1;
    var rnd = seeded(20261102), R = 10000, B = 5000, hits = 0, boot = [];
    for (r = 0; r < R; r++) {
      for (s = 0, i = 0; i < n; i++) s += rnd() < 0.5 ? -v[i] : v[i];
      if (Math.abs(s / n) >= Math.abs(m) - 1e-12) hits++;
    }
    for (r = 0; r < B; r++) {
      for (s = 0, i = 0; i < n; i++) s += v[Math.floor(rnd() * n)];
      boot.push(s / n);
    }
    boot.sort(function (a, b) { return a - b; });
    var tc = tCrit(n - 1), pPerm = (hits + 1) / (R + 1), p = Math.max(pT, pPerm);
    return { n: n, mean: m, sd: sd, d: sd ? m / sd : 0, t: t, pT: pT, pPerm: pPerm, p: p, skewed: skewed, level: strength(p, sd ? m / sd : 0),
      ci: skewed ? [boot[Math.floor(0.025 * B)], boot[Math.ceil(0.975 * B) - 1]] : [m - tc * se, m + tc * se] };
  }
  // Teckentest: hur troligt är det att minst k av n utfall hamnar på samma sida om noll av en slump (tvåsidigt)?
  function signTest(k, n) {
    var lo = Math.min(k, n - k), tail = 0;
    for (var j = 0; j <= lo; j++) tail += Math.exp(lnGamma(n + 1) - lnGamma(j + 1) - lnGamma(n - j + 1) - n * Math.LN2);
    return Math.min(1, 2 * tail);
  }
  function ranks(v) {
    var idx = v.map(function (x, i) { return i; }).sort(function (a, b) { return v[a] - v[b]; }), r = [];
    for (var i = 0; i < idx.length;) {
      var j = i; while (j + 1 < idx.length && v[idx[j + 1]] === v[idx[i]]) j++;
      for (var k = i; k <= j; k++) r[idx[k]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  }
  // En korrelation med p-värde (t-fördelning) och 95 % konfidensintervall (Fishers z). Med rank räknas rangkorrelation
  // (Spearman), som inte påverkas av enstaka extremvärden. Lutningen b (för vanlig korrelation) har ett eget intervall.
  function corr1(xs, ys, rank) {
    if (rank) { xs = ranks(xs); ys = ranks(ys); }
    var n = xs.length, mx = avgOf(xs), my = avgOf(ys), sxx = 0, syy = 0, sxy = 0;
    for (var i = 0; i < n; i++) { sxx += (xs[i] - mx) * (xs[i] - mx); syy += (ys[i] - my) * (ys[i] - my); sxy += (xs[i] - mx) * (ys[i] - my); }
    var r = sxx && syy ? Math.max(-0.999999, Math.min(0.999999, sxy / Math.sqrt(sxx * syy))) : 0, df = n - 2;
    var z = 0.5 * Math.log((1 + r) / (1 - r)), sez = Math.sqrt((rank ? 1.06 : 1) / (n - 3));
    var b = sxx ? sxy / sxx : 0, seB = df > 0 && sxx ? Math.sqrt(Math.max(0, syy - b * sxy) / df / sxx) : 0, tc = tCrit(df);
    return { r: r, p: pFromT(r * Math.sqrt(df / (1 - r * r)), df), ci: [Math.tanh(z - 1.96 * sez), Math.tanh(z + 1.96 * sez)], b: b, ciB: [b - tc * seB, b + tc * seB] };
  }
  // Vanlig korrelation och rangkorrelation. Med vanlig korrelation som huvudtest är rangkorrelationen en kontroll mot
  // extremvärden: sambandet räknas som säkerställt bara om båda ger p under 0,05 och pekar åt samma håll. Där utfallen
  // har extremvärden (rankMain) avgör rangkorrelationen ensam, och den vanliga korrelationen visas bara som upplysning.
  function corrTest(xs, ys, rankMain) {
    var pe = corr1(xs, ys, false), sp = corr1(xs, ys, true), main = rankMain ? sp : pe, alt = rankMain ? pe : sp;
    var p = rankMain ? sp.p : pe.r * sp.r > 0 ? Math.max(pe.p, sp.p) : 1;
    return { n: xs.length, r: main.r, ci: main.ci, pMain: main.p, rAlt: alt.r, pAlt: alt.p, p: p, b: pe.b, ciB: pe.ciB, r2: pe.r * pe.r,
      level: strength(p, rankMain ? sp.r : Math.min(Math.abs(pe.r), Math.abs(sp.r))) };
  }

  var nf3 = new Intl.NumberFormat("sv-SE", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  function pText(p) { return p < 0.001 ? "under 0,001" : (p < 0.01 ? nf3 : nf2).format(p); }
  function rText(r) { return (r > 0 ? "+" : "") + fixMinus(nf2.format(r)); }
  // "i ungefär 13 fall av 100": p-värdet i ord
  function pChance(p) { return p < 0.01 ? "i färre än 1 fall av 100" : "i ungefär " + nf0.format(Math.max(1, Math.round(p * 100))) + " fall av 100"; }
  function ciText(ci, f) { return f(ci[0]) + " till " + f(ci[1]); }

  // Förklaringen som står under varje statistikruta
  var STAT_HELP =
    "<p><b>Urval</b> är hur många observationer testet bygger på. Ju färre, desto osäkrare svar.</p>" +
    "<p><b>Korrelation</b> går från −1 till +1. Noll betyder inget samband, +1 att punkterna ligger på en stigande rak linje och −1 på en fallande.</p>" +
    "<p><b>95 % konfidensintervall</b> visar osäkerheten. Det rymmer de värden som stämmer med datan: räknas intervallet på samma sätt i många undersökningar " +
    "fångar det det verkliga värdet i 95 av 100. Ligger noll inne i intervallet kan sambandet lika gärna saknas.</p>" +
    "<p><b>p-värdet</b> är sannolikheten att få ett minst lika tydligt resultat av ren slump, om det i verkligheten inte fanns något samband. " +
    "Under 0,05 (5 av 100) räknas sambandet som statistiskt säkerställt.</p>" +
    "<p><b>Bedömningen.</b> Starkt samband: p under 0,05 och en stor effekt (korrelation minst 0,5, eller ett snitt minst en halv standardavvikelse från noll). " +
    "Svagt samband: p under 0,05 men en mindre effekt. Annars dras ingen slutsats. Snitt prövas med både t-test och permutationstest, och båda måste ge p under 0,05. " +
    "En vanlig korrelation kontrolleras med rangkorrelation, som inte påverkas av enstaka extremvärden. Där extremvärden är vanliga används rangkorrelationen direkt.</p>" +
    "<p><b>Samband är inte orsak.</b> Även ett säkerställt samband visar bara att två saker har hängt ihop, inte att den ena orsakar den andra eller att det fortsätter.</p>";

  // Statistikrutan under varje analys. o: { level, text, figs: [[rubrik, värde, notering]], caveats: [...], method }
  function statBox(o) {
    return '<section class="stat-box sb-' + o.level + '"><div class="sb-head"><h3>Statistisk prövning</h3><span class="sb-verdict">' + STRENGTH[o.level] + "</span></div>" +
      '<p class="sb-text">' + o.text + "</p>" +
      '<dl class="sb-figs">' + o.figs.map(function (f) { return "<div><dt>" + f[0] + "</dt><dd>" + f[1] + "</dd>" + (f[2] ? "<small>" + f[2] + "</small>" : "") + "</div>"; }).join("") + "</dl>" +
      (o.caveats && o.caveats.length ? '<div class="sb-caveats"><h4>Källkritik</h4><ul>' + o.caveats.map(function (c) { return "<li>" + c + "</li>"; }).join("") + "</ul></div>" : "") +
      '<details class="sb-more"><summary>Så ska du läsa siffrorna</summary>' + (o.method ? "<p>" + o.method + "</p>" : "") + STAT_HELP + "</details></section>";
  }
  // Statistikrutan för en korrelation. o: { t (testet), text, unit (vad en observation är), xName, yName, caveats, method, extra }
  function corrBox(o) {
    var t = o.t, rName = o.rank ? "Rangkorrelation" : "Korrelation";
    var figs = [["Urval", int(t.n) + " " + o.unit, o.unitNote || ""], [rName, rText(t.r), t.r2 != null && !o.rank ? "r² = " + nf2.format(t.r2) : ""],
      ["95 % konfidensintervall", ciText(t.ci, rText), ""], ["p-värde", pText(t.p), "under 0,05 krävs för en slutsats"]].concat(o.extra || []);
    var odd = t.p >= 0.05 && (t.ci[0] > 0 || t.ci[1] < 0) ? " Intervallet ligger på ena sidan om noll, men kontrolltestet ger p över 0,05, så resultatet räknas inte som säkerställt." : "";
    return statBox({ level: t.level, text: o.text + odd, figs: figs, caveats: o.caveats,
      method: (o.method ? o.method + " " : "") + "Kontroll: " + (o.rank ? "vanlig korrelation " : "rangkorrelation ") + rText(t.rAlt) + " (p-värde " + pText(t.pAlt) + ")." });
  }

  // ---------- Backtest: lönar det sig att följa fonderna? ----------
  // Bygger på history-se.json: per aktie och kvartal [kvartal, fonder, innehav mkr, nettoköp mkr, nettoköp aktiva fonder mkr,
  // kursförändring sedan förra kvartalet]. Kursförändringen räknas i scripts/build-data.ps1 ur medianen av fondernas
  // rapporterade kurser och är splitjusterad men utan utdelningar.
  //
  // Varje kvartal q delas aktierna in i fem lika stora grupper efter nettoköpet under q i procent av innehavet vid
  // kvartalet innan. Datan antas bli känd senast ett kvartal efter q, så gruppernas avkastning mäts under kvartalet
  // därefter (q + 2). Grupperna har lika vikt per aktie och byts varje kvartal.

  var BT_MIN_VALUE = 100;     // mkr: fonderna ägde minst så här mycket i aktien kvartalet innan
  var BT_GROUPS = 5;
  var BT_LAG = 2;             // signal från kvartal q, känd under q + 1, avkastningen mäts under q + 2
  var BT_CLIP = [-0.9, 3];    // enstaka kvartalsavkastningar utanför detta ses som datafel och kapas
  var btState = { active: false };

  function quarterEnd(q) { return q.slice(0, 4) + ["", "-03-31", "-06-30", "-09-30", "-12-31"][+q.slice(5)]; }

  function computeBacktest(activeOnly) {
    var h = state.history, Q = h.quarters, n = Q.length;
    var stocks = Object.keys(h.stocks).filter(function (k) { return k.slice(0, 2) === "SE"; }).map(function (k) {
      var rows = h.stocks[k][3], by = {};
      rows.forEach(function (r) { by[r[0]] = r; });
      return { isin: k, name: h.stocks[k][0], by: by };
    });
    var periods = [], retsTop = [], retsBottom = [];
    for (var q = 1; q + BT_LAG < n; q++) {
      var t = q + BT_LAG; // avkastningen i rad t gäller kvartalet som slutar i t
      var cand = [];
      stocks.forEach(function (st) {
        var prev = st.by[q - 1], cur = st.by[q], fut = st.by[t];
        if (!prev || !cur || !fut || prev[2] < BT_MIN_VALUE) return;
        var flow = activeOnly ? cur[4] : cur[3];
        var ret = fut[5];
        if (flow == null || ret == null) return;
        cand.push({ st: st, sig: flow / prev[2], ret: Math.max(BT_CLIP[0], Math.min(BT_CLIP[1], ret)) });
      });
      if (cand.length < BT_GROUPS * 8) continue;
      cand.sort(function (a, b) { return a.sig - b.sig; });
      var groups = [];
      for (var g = 0; g < BT_GROUPS; g++) {
        var part = cand.slice(Math.floor(g * cand.length / BT_GROUPS), Math.floor((g + 1) * cand.length / BT_GROUPS));
        groups.push({ ret: part.reduce(function (a, c) { return a + c.ret; }, 0) / part.length, n: part.length,
          top: part.slice().sort(function (a, b) { return b.sig - a.sig; }).slice(0, 5) });
        // Varje akties kvartalsavkastning i ytterkvintilerna, för fördelningsdiagrammet
        if (g === BT_GROUPS - 1) part.forEach(function (c) { retsTop.push(c.ret); });
        if (g === 0) part.forEach(function (c) { retsBottom.push(c.ret); });
      }
      var all = cand.reduce(function (a, c) { return a + c.ret; }, 0) / cand.length;
      // Rangkorrelationen mellan köp och kommande avkastning över alla aktier, inte bara ytterkvintilerna (en kontroll)
      var ic = corr1(cand.map(function (c) { return c.sig; }), cand.map(function (c) { return c.ret; }), true).r;
      periods.push({ signal: Q[q], held: Q[t], groups: groups, all: all, n: cand.length, ic: ic });
    }
    // Sammanfattning. Testen räknas per kvartal: aktierna samma kvartal rör sig ihop med börsen och är inte oberoende.
    var N = periods.length;
    if (!N) return { N: 0 };
    var mean = function (f) { return periods.reduce(function (a, p) { return a + f(p); }, 0) / N; };
    var cagr = function (f) { var v = periods.reduce(function (a, p) { return a * (1 + f(p)); }, 1); return Math.pow(v, 4 / N) - 1; };
    var spread = periods.map(function (p) { return p.groups[BT_GROUPS - 1].ret - p.groups[0].ret; });
    var excess = periods.map(function (p) { return p.groups[BT_GROUPS - 1].ret - p.all; });
    var hits = spread.filter(function (x) { return x > 0; }).length;
    return {
      periods: periods, N: N, spreads: spread, retsTop: retsTop, retsBottom: retsBottom,
      groupMean: periods[0].groups.map(function (_, g) { return mean(function (p) { return p.groups[g].ret; }); }),
      allMean: mean(function (p) { return p.all; }),
      cagrTop: cagr(function (p) { return p.groups[BT_GROUPS - 1].ret; }),
      cagrBottom: cagr(function (p) { return p.groups[0].ret; }),
      cagrAll: cagr(function (p) { return p.all; }),
      test: testMean(spread), testExcess: testMean(excess), testIc: testMean(periods.map(function (p) { return p.ic; })),
      hit: hits / N, pHit: signTest(hits, N),
      avgN: mean(function (p) { return p.n; })
    };
  }

  function pctS(v, d) { return (v > 0 ? "+" : v < 0 ? "−" : "") + (d === 0 ? nf0 : nf1).format(Math.abs(v * 100)) + " %"; }

  // Slutsatsen i ord. Utan statistisk säkerhet sägs bara att datan inte visar något, åt något håll.
  function backtestVerdict(b) {
    var s = b.test;
    var head = "Under " + s.n + " kvartal gick de aktier fonderna köpte mest i snitt " + pctS(Math.abs(s.mean)).replace(/^[+−]/, "") + " " + (s.mean > 0 ? "bättre" : "sämre") +
      " per kvartal än de fonderna sålde mest, räknat kvartalet efter att datan blivit offentlig. ";
    if (s.level === "none") return head + "Skillnaden är inte statistiskt säkerställd (p-värde " + pText(s.p) + "). Den är liten jämfört med hur mycket utfallen svänger " +
      "från kvartal till kvartal och kan mycket väl vara slump. Datan visar alltså varken att det lönar sig att följa fondernas köp eller att det lönar sig att göra tvärtom.";
    return head + "Skillnaden är statistiskt säkerställd (p-värde " + pText(s.p) + ")" + (s.level === "strong" ? " och stor." : ", men liten jämfört med hur mycket utfallen svänger.") +
      " Det är ett historiskt samband, inte ett bevis för att fondernas köp orsakar kursrörelserna eller att mönstret håller framåt.";
  }

  function backtestStatBox(b) {
    var s = b.test, pc = function (v) { return pctS(v); };
    return statBox({
      level: s.level,
      text: "Om det i verkligheten inte fanns någon skillnad mellan grupperna skulle en minst så här stor skillnad uppstå av en slump " + pChance(s.p) + ". " +
        "Den verkliga skillnaden kan rimligen ligga någonstans mellan " + pc(s.ci[0]) + " och " + pc(s.ci[1]) + " per kvartal" +
        (s.ci[0] < 0 && s.ci[1] > 0 ? ", alltså också vara noll." : ".") + (s.level === "none" && s.ci[0] * s.ci[1] > 0 ? " Det försiktigare av de två testen ger ändå p över 0,05, så resultatet räknas inte som säkerställt." : ""),
      figs: [["Urval", s.n + " kvartal", "i snitt " + nf0.format(b.avgN) + " aktier per kvartal"], ["Skillnad per kvartal", pc(s.mean), "mest köpta minus mest sålda"],
        ["95 % konfidensintervall", ciText(s.ci, pc), s.skewed ? "bootstrap" : ""], ["p-värde", pText(s.p), "under 0,05 krävs för en slutsats"]],
      caveats: [
        "<b>Testet räknas per kvartal, inte per aktie.</b> Aktierna samma kvartal rör sig ihop med börsen, så tusentals aktieutfall är inte tusentals oberoende försök. Att räkna dem var för sig skulle ge ett alldeles för lågt p-värde.",
        "<b>Kort period.</b> " + s.n + " kvartal är lite. Ett verkligt men litet samband kan behöva många fler kvartal för att synas, och en enstaka extrem period väger tungt.",
        "<b>Överlevnadsbias.</b> Aktier som försvinner från börsen under mätkvartalet (uppköp, konkurs) saknar kurs och faller bort. Konkurser drar ner och uppköp drar upp, så felet kan gå åt båda hållen.",
        "<b>Ingen framtidsinformation.</b> Signalen används först kvartalet efter att innehaven blivit offentliga, och urvalet bygger på innehaven kvartalet innan.",
        "<b>Flera varianter.</b> Testet kan visas för alla fonder och för bara aktiva fonder. Ju fler varianter som prövas, desto större är risken att någon ser säkerställd ut av en slump.",
        "<b>Utan utdelningar och kostnader.</b> Kurserna är fondernas rapporterade kvartalskurser. Utdelningar, courtage och skatt ingår inte."
      ],
      method: "Skillnaden mellan mest köpta och mest sålda räknas varje kvartal. Snittet prövas med ett t-test (p-värde " + pText(s.pT) + ") och ett permutationstest där " +
        "kvartalens tecken byts slumpvis 10 000 gånger (p-värde " + pText(s.pPerm) + "). Kontroller: mest köpta mot alla aktier " + pc(b.testExcess.mean) + " per kvartal (p-värde " +
        pText(b.testExcess.p) + "), och rangkorrelationen mellan köp och kommande avkastning över alla aktier, i snitt per kvartal " + rText(b.testIc.mean) + " (p-värde " + pText(b.testIc.p) + ")."
    });
  }

  function viewBacktest() {
    document.title = "Lönar det sig att följa fonderna? Backtest – Fondinsyn";
    var head = '<div class="page-head"><h1>Lönar det sig att följa fonderna?</h1><p class="meta lead">Ett test på historisk data: går de svenska aktier som fonderna ' +
      "köper mest bättre än de som de säljer? Sedan 2019, kvartal för kvartal, och bara med information som fanns när den behövdes.</p></div>";
    if (!needHistory("se")) return head + (failed("history-se") ? errorBlock() : loadingBlock("Laddar historik…"));
    var probe = state.history.stocks[Object.keys(state.history.stocks)[0]][3][1];
    if (!probe || probe.length < 6) return head + '<div class="notice">Kurshistoriken byggs om och finns på plats efter nästa uppdatering.</div>';
    var b = computeBacktest(btState.active);
    if (!b.N) return head + '<div class="notice">För lite data för att räkna.</div>';
    var G = BT_GROUPS, first = b.periods[0], last = b.periods[b.N - 1];
    var seg = function (v, label) { return '<button type="button" class="seg-btn" data-bt-active="' + v + '" aria-pressed="' + (btState.active === v) + '">' + label + "</button>"; };

    // Indexserier för diagrammet (start 100)
    var mk = function (f) {
      // Första punkten är slutet av kvartalet före det första mätkvartalet
      var v = 100, pts = [{ d: quarterEnd(prevQuarterId(first.held)), v: 100 }];
      b.periods.forEach(function (p) { v *= 1 + f(p); pts.push({ d: quarterEnd(p.held), v: Math.round(v * 10) / 10 }); });
      return pts;
    };
    var series = [
      { label: "Mest köpta", cls: "sp", points: mk(function (p) { return p.groups[G - 1].ret; }) },
      { label: "Alla aktier", cls: "s0", points: mk(function (p) { return p.all; }) },
      { label: "Mest sålda", cls: "sn", points: mk(function (p) { return p.groups[0].ret; }) }
    ];
    var groupNames = ["Mest sålda", "Sålda", "Mitten", "Köpta", "Mest köpta"];
    var maxAbs = Math.max.apply(null, b.groupMean.map(Math.abs).concat([b.allMean, 0.001]));
    var bars = '<ul class="divbars bt-groups">' + b.groupMean.map(function (v, g) {
      var w = Math.abs(v) / maxAbs * 50;
      return '<li style="--d:' + (g * 40) + 'ms"><span class="db-label">' + (g + 1) + ". " + groupNames[g] + '</span><span class="db-track"><i class="' + (v >= 0 ? "pos" : "neg") +
        '" style="width:' + w.toFixed(1) + "%;" + (v >= 0 ? "left:50%" : "right:50%") + '"></i></span><span class="db-val ' + cls(v) + '">' + pctS(v) + "</span></li>";
    }).join("") + "</ul>";
    var rows = b.periods.slice().reverse();
    var cols = [
      { key: "held", label: "Mätkvartal", align: "l", cls: "name", cell: function (p) { return '<span class="nm-plain">' + quarterLabel(p.held) + '</span><span class="sub">signal från ' + quarterLabel(p.signal) + ", " + p.n + " aktier</span>"; } },
      { key: "top", label: "Mest köpta", cell: function (p) { return '<span class="' + cls(p.groups[G - 1].ret) + '">' + pctS(p.groups[G - 1].ret) + "</span>"; }, csv: function (p) { return p.groups[G - 1].ret.toFixed(4); } },
      { key: "all", label: "Alla", cell: function (p) { return '<span class="' + cls(p.all) + '">' + pctS(p.all) + "</span>"; }, csv: function (p) { return p.all.toFixed(4); } },
      { key: "bot", label: "Mest sålda", cell: function (p) { return '<span class="' + cls(p.groups[0].ret) + '">' + pctS(p.groups[0].ret) + "</span>"; }, csv: function (p) { return p.groups[0].ret.toFixed(4); } },
      { key: "spr", label: "Skillnad", hideSm: true, cell: function (p) { var d = p.groups[G - 1].ret - p.groups[0].ret; return '<span class="' + cls(d) + '">' + pctS(d) + "</span>"; } }
    ];
    var lastTop = last.groups[G - 1].top;
    return head +
      '<div class="bt-tools"><div class="seg" role="group" aria-label="Vilka fonders köp">' + seg(false, "Alla fonder") + seg(true, "Bara aktiva fonder") + "</div>" +
      '<span class="muted">' + (btState.active ? "Indexfondernas köp räknas bort, de följer mest in- och utflöden." : "Alla fonders nettoköp, även indexfondernas.") + "</span></div>" +
      '<section class="bt-answer bt-answer-duel">' +
      '<div class="bt-duel"><div><span>Mest köpta</span><b class="' + cls(b.cagrTop) + '">' + pctS(b.cagrTop) + '</b><small>per år</small></div>' +
      '<div class="bt-vs">mot</div><div><span>Mest sålda</span><b class="' + cls(b.cagrBottom) + '">' + pctS(b.cagrBottom) + "</b><small>per år</small></div></div></section>" +
      backtestStatBox(b) +
      '<dl class="figures section-gap">' +
      fig("Alla aktier, per år", '<span class="' + cls(b.cagrAll) + '">' + pctS(b.cagrAll) + "</span>", "lika vikt, jämförelse") +
      fig("Mest köpta slog mest sålda", nf0.format(b.hit * 100) + " % av kvartalen", "slumpen ger 50 %, p-värde " + pText(b.pHit)) +
      fig("Period", b.N + " kvartal", quarterLabel(first.held) + "–" + quarterLabel(last.held)) + "</dl>" +
      block("Utveckling för 100 kronor", "Grupperna köps i slutet av varje kvartal och byts kvartalet efter. Kursutveckling utan utdelningar, före avgifter och courtage.",
        '<div class="chart-card">' + chart(function (node) {
          FFCharts.lines(node, series, { height: 300, zero: false, ref: { v: 100, label: "Start 100 kr" }, format: function (v) { return nf0.format(v); }, tip: function (rws) {
            return "<b>" + dateText(rws[0].p.d) + "</b>" + rws.map(function (r) { return tipRow(r.s.cls, r.s.label, nf0.format(r.p.v) + " kr"); }).join("");
          } });
        }) + "</div>") +
      '<div class="grid-2 section-gap">' +
      block("Snitt per kvartal och grupp", "Från aktierna fonderna sålde mest (1) till dem de köpte mest (5). Alla aktier: " + pctS(b.allMean) + " per kvartal.", bars) +
      block("Mest köpta i senaste signalen", "Signal från " + quarterLabel(last.signal) + ", mätt " + quarterLabel(last.held) + ".",
        '<ol class="rank-list">' + lastTop.map(function (c, i) {
          var st = quarterData().se.byIsin[c.st.isin];
          return '<li><span class="rk-n">' + (i + 1) + '</span><span class="rk-main">' + (st ? '<a href="' + stockHref(st) + '">' + esc(c.st.name) + "</a>" : '<span class="nm-plain">' + esc(c.st.name) + "</span>") +
            '<span class="rk-sub">nettoköp ' + pctS(c.sig, 0) + " av innehavet</span></span><span></span>" + '<span class="rk-v ' + cls(c.ret) + '">' + pctS(c.ret) + "</span></li>";
        }).join("") + "</ol>") + "</div>" +
      backtestDistributions(b) +
      block("Kvartal för kvartal", "", table("bt-periods", cols, rows, { csv: true, limit: 8, expand: true }), "section-gap") +
      '<section class="block section-gap text-page"><div class="block-head"><h2>Så är testet gjort</h2></div>' +
      "<p><b>Signal.</b> Fondernas nettoköp av aktien under kvartalet, i procent av hur mycket fonderna ägde kvartalet innan. Bara svenska aktier där fonderna ägde minst " + BT_MIN_VALUE + " mkr är med.</p>" +
      "<p><b>Grupper.</b> Varje kvartal delas aktierna in i fem lika stora grupper efter signalen. Varje aktie väger lika mycket i sin grupp.</p>" +
      "<p><b>Ingen framtidsinformation.</b> Fondernas innehav blir offentliga först en tid efter kvartalets slut. Testet räknar därför med att datan är känd ett kvartal senare och mäter avkastningen kvartalet efter det.</p>" +
      "<p><b>Kurser.</b> Kvartalskurserna kommer ur fondernas egna rapporter till Finansinspektionen (medianen av fondernas kurser) och är justerade för splittar. Utdelningar ingår inte, och inte heller avgifter, courtage eller skatt. " +
      "Kvartal där antalet fonder som äger aktien rasar med mer än 70 % räknas inte, eftersom det oftast är ett byte av aktieslag, en avnotering eller en fusion. Enstaka kvartalsavkastningar under −90 % eller över +300 % kapas.</p>" +
      "<p><b>Begränsningar.</b> Aktier som försvinner från börsen under mätkvartalet (uppköp, konkurs) saknar kurs och faller bort. Perioden är kort, sju år, och historisk avkastning säger inget säkert om framtiden. Detta är ett test av en idé, inte en investeringsrekommendation.</p>" +
      '<p><a href="#/metod">Läs hela metodrapporten</a></p></section>';
  }

  // Kvartalets kursutveckling mot fondernas nettoköp per aktie: köpte fonderna aktierna som gått upp (momentum)
  // eller dem som gått ner? Bara aktier där fonderna ägde minst 100 mkr kvartalet innan.
  function chaseData(ds) {
    var qi = state.history.qIndex[state.q];
    if (qi == null || !qi) return null;
    var pts = [];
    ds.stocks.forEach(function (s) {
      var h = histFor(s.isin);
      if (!h) return;
      var cur = h.byQ[qi], prev = h.byQ[qi - 1];
      if (!cur || !prev || prev[2] < 100 || cur[3] == null || cur[5] == null) return;
      // Köpet räknas i antal aktier (nettoköpet i kronor delat med kursuppgången), så att kursen inte påverkar båda axlarna
      pts.push({ x: cur[5] * 100, y: cur[3] / prev[2] / (1 + cur[5]) * 100, size: prev[2], cls: cur[3] >= 0 ? "c-pos" : "c-neg", s: s, flow: cur[3] });
    });
    if (pts.length < 30) return null;
    // Samma mått för alla tidigare kvartal, för att se om mönstret återkommer över tid
    var past = [], hs = Object.keys(state.history.stocks).filter(function (isin) { return (isin.slice(0, 2) === "SE") === (state.market !== "world"); }).map(histFor);
    for (var k = 1; k <= qi; k++) {
      var X = [], Y = [];
      hs.forEach(function (h) {
        var c = h.byQ[k], pr = h.byQ[k - 1];
        if (!c || !pr || pr[2] < 100 || c[3] == null || c[5] == null) return;
        X.push(c[5]); Y.push(c[3] / pr[2] / (1 + c[5]));
      });
      if (X.length >= 30) past.push(corr1(X, Y, true).r);
    }
    var overTime = past.length >= 8 ? testMean(past) : null;
    // Styrkan över tid avgörs av korrelationens storlek, inte av hur jämn den är mellan kvartalen
    if (overTime) overTime.level = strength(overTime.p, overTime.mean);
    // Axlarna går till 2:a och 98:e percentilen, extremvärden ritas vid kanten
    var pctl = function (v, p) { var a = v.slice().sort(function (x, y) { return x - y; }); return a[Math.floor(p * (a.length - 1))]; };
    var xsv = pts.map(function (p) { return p.x; }), ysv = pts.map(function (p) { return p.y; });
    var xd = [Math.min(-5, pctl(xsv, 0.02)), Math.max(5, pctl(xsv, 0.98))], yd = [Math.min(-5, pctl(ysv, 0.02)), Math.max(5, pctl(ysv, 0.98))];
    var ct = corrTest(xsv, ysv, true);
    var winners = pts.filter(function (p) { return p.x > 0; }), losers = pts.filter(function (p) { return p.x <= 0; });
    var share = function (list) { return list.length ? list.filter(function (p) { return p.y > 0; }).length / list.length : 0; };
    var verdict = ct.level === "none" ? "Inte så att det går att säkerställa: mönstret är så svagt att det kan vara slump."
      : (ct.r > 0 ? "Ja, i viss mån. Fonderna köpte oftare aktierna som hade gått upp." : "Snarare tvärtom. Fonderna köpte oftare aktierna som hade gått ner.") +
        " Sambandet är " + (ct.level === "strong" ? "starkt." : "svagt men statistiskt säkerställt.");
    var chaseBox = corrBox({ t: ct, rank: true, unit: "aktier", unitNote: "fonderna ägde minst 100 mkr",
      text: "Om det i verkligheten inte fanns något samband mellan kursrörelse och fondernas köp skulle ett minst så här tydligt mönster uppstå av en slump " + pChance(ct.p) + "." +
        (overTime ? " Över " + overTime.n + " kvartal sedan " + quarterLabel(state.history.quarters[1]) + " var rangkorrelationen i snitt " + rText(overTime.mean) +
          " (95 % konfidensintervall " + ciText(overTime.ci, rText) + ", p-värde " + pText(overTime.p) + "): " + STRENGTH[overTime.level].toLowerCase() + " över tid." : ""),
      caveats: [
        "<b>Vad kom först?</b> Köpen och kursrörelsen gäller samma kvartal. Fonderna kan ha köpt för att kursen steg, men deras köp kan också ha drivit upp kursen. Datan kan inte skilja på det.",
        "<b>Inte oberoende.</b> Aktier i samma bransch rör sig ihop, så p-värdet för ett enskilt kvartal är snarare för lågt. Snittet över många kvartal är säkrare.",
        "<b>Urval.</b> Bara aktier där fonderna ägde minst 100 mkr kvartalet innan. Aktier som avnoterats under kvartalet saknas.",
        "<b>Kurser.</b> Medianen av fondernas rapporterade kurser, utan utdelningar."
      ],
      method: "Köpet räknas som förändringen i fondernas antal aktier, så att kursuppgången inte påverkar båda måtten. Rangkorrelation används eftersom några aktier rör sig extremt mycket." });
    var pct = function (v) { return (v > 0 ? "+" : "") + fixMinus(nf0.format(v)) + " %"; };
    // Några exempel i ord: stora innehav som ligger långt från mitten
    var clip = function (v, d) { return Math.min(Math.abs(v), Math.max(-d[0], d[1])); };
    var standout = function (p) { return Math.sqrt(p.size) * (clip(p.x, xd) / (xd[1] - xd[0]) + clip(p.y, yd) / (yd[1] - yd[0])); };
    // Namn vid de aktier som sticker ut mest (fler i PDF:en, där man inte kan peka på prickarna)
    var named = {};
    pts.slice().sort(function (a, b) { return standout(b) - standout(a); }).slice(0, pdfMode ? 14 : 6).forEach(function (p) { named[p.s.isin] = true; });
    // De fyra hörnen: de största affärerna i varje, så att diagrammet går att läsa utan att peka (och i PDF:en)
    var corner = function (title, test, tone) {
      var list = pts.filter(test).sort(function (a, b) { return Math.abs(b.flow) - Math.abs(a.flow); });
      return '<div class="quad ' + tone + '"><h4>' + title + ' <span class="muted">' + int(list.length) + " aktier</span></h4><ol>" + list.slice(0, 4).map(function (p) {
        return '<li><a href="' + stockHref(p.s) + '">' + esc(shortCo(p.s.name)) + '</a><span class="q-x">kursen ' + pct(p.x) + '</span><span class="q-f ' + cls(p.flow) + '">' +
          bigSek(p.flow * 1e6, true) + "</span></li>";
      }).join("") + "</ol></div>";
    };
    var corners = '<div class="quad-grid">' +
      corner("Köpte, och kursen steg", function (p) { return p.flow > 0 && p.x > 0; }, "q-buy") +
      corner("Köpte, fast kursen föll", function (p) { return p.flow > 0 && p.x <= 0; }, "q-buy") +
      corner("Sålde, fast kursen steg", function (p) { return p.flow < 0 && p.x > 0; }, "q-sell") +
      corner("Sålde, och kursen föll", function (p) { return p.flow < 0 && p.x <= 0; }, "q-sell") + "</div>";
    return {
      text: verdict + " Av aktierna som steg under kvartalet nettoköptes " + nf0.format(share(winners) * 100) + " %, av dem som föll " + nf0.format(share(losers) * 100) +
        " % (rangkorrelation " + rText(ct.r) + ", p-värde " + pText(ct.p) + ").",
      html: '<div class="chart-card"><p class="chart-howto">Varje prick är en aktie. <b>Högt upp</b> köpte fonderna, <b>långt ner</b> sålde de. ' +
        "<b>Till höger</b> steg kursen under kvartalet, <b>till vänster</b> föll den. Stora prickar är aktier som fonderna äger mycket av. " +
        (pdfMode ? "Namnen står vid de aktier som sticker ut mest, och under diagrammet finns de största affärerna i varje hörn.</p>"
          : "Peka på en prick för att se vilken aktie det är.</p>") +
        chart(function (node) {
          FFCharts.xy(node, pts, {
            height: node.clientWidth < 500 ? 340 : 440, xDomain: xd, yDomain: yd,
            legend: [{ label: "Fonderna köpte", cls: "c-pos", kind: "dot", key: "c-pos" }, { label: "Fonderna sålde", cls: "c-neg", kind: "dot", key: "c-neg" }],
            xFmt: function (v) { return pct(v); }, yFmt: function (v) { return pct(v); },
            xLabel: "Kursens förändring under " + quarterLabel(state.q), yLabel: "Köpt eller sålt, i % av fondernas aktier",
            bands: { above: "Fonderna köpte", below: "Fonderna sålde" }, xHint: ["← Kursen föll", "Kursen steg →"],
            tip: function (p) {
              return "<b>" + esc(p.s.name) + "</b>" + tipRow("", "Kursen " + (p.x >= 0 ? "steg" : "föll"), nf0.format(Math.abs(p.x)) + " %") +
                tipRow(p.cls, "Fonderna " + (p.flow >= 0 ? "köpte" : "sålde"), bigSek(Math.abs(p.flow) * 1e6)) + tipRow("", "Av vad de ägde", nf0.format(Math.abs(p.y)) + " %");
            },
            label: function (p) { return named[p.s.isin] ? shortCo(p.s.name) : null; },
            onClick: function (p) { location.hash = stockHref(p.s); }
          });
        }) + '<div class="chart-examples"><h3>De största affärerna i varje hörn</h3>' + corners + "</div>" +
        '<p class="chart-note">Med är aktier där fonderna ägde minst 100 mkr kvartalet innan. Kursen är medianen av fondernas rapporterade kurser, utan utdelningar. Enstaka extremvärden ritas vid kanten.</p></div>' + chaseBox
    };
  }

  // Två fördelningar: skillnaden mellan grupperna kvartal för kvartal, och varje akties kvartalsavkastning i ytterkvintilerna.
  // Kurvorna är normalfördelningar med samma medelvärde och standardavvikelse som utfallen.
  function backtestDistributions(b) {
    var pct = function (v) { return (v > 0 ? "+" : "") + fixMinus(nf1.format(v)) + " %"; };
    var tick = function (v) { return fixMinus(nf0.format(v)) + " %"; };
    var spreads = b.spreads.map(function (v) { return v * 100; });
    var top = b.retsTop.map(function (v) { return v * 100; }), bottom = b.retsBottom.map(function (v) { return v * 100; });
    var sS = FFCharts.stats(spreads), sT = FFCharts.stats(top), sB = FFCharts.stats(bottom);
    var below = spreads.filter(function (v) { return v < 0; }).length;
    var lim = Math.max(10, Math.ceil(Math.max.apply(null, spreads.map(Math.abs)) / 5) * 5);
    return '<div class="grid-2 section-gap">' +
      block("Skillnaden kvartal för kvartal", "Mest köpta minus mest sålda. Staplarna är kvartalen, kurvan en normalfördelning med samma snitt och spridning.",
        '<div class="chart-card">' + chart(function (node) {
          FFCharts.dist(node, [{ values: spreads, hist: true, curve: true, cls: "s-ink", label: "Snitt " + pct(sS.mean) }], {
            height: 280, bins: Math.min(24, Math.round(2 * lim / 2.5)), domain: [-lim, lim], xFmt: tick, yLabel: "Antal kvartal",
            tip: function (bin, rows) { return "<b>" + tick(bin.from) + " till " + tick(bin.to) + "</b>" + tipRow("", "Antal kvartal", rows[0].count); }
          });
        }) + '<p class="chart-note">Snitt <b>' + pct(sS.mean) + "</b> per kvartal, standardavvikelse <b>" + nf1.format(sS.sd) + " %</b>. " +
        below + " av " + sS.n + " kvartal hamnade under noll, alltså gick de mest sålda bättre.</p></div>") +
      block("Spridningen inom grupperna", "Varje akties avkastning kvartalet efter signalen, i de två yttersta grupperna.",
        '<div class="chart-card">' + chart(function (node) {
          FFCharts.dist(node, [
            { values: top, curve: true, cls: "c-pos", label: "Köpta " + pct(sT.mean) },
            { values: bottom, curve: true, dash: true, cls: "c-neg", label: "Sålda " + pct(sB.mean) }
          ], {
            height: 280, bins: 24, domain: [-60, 60], share: true, xFmt: tick, yLabel: "Andel av aktierna",
            legend: [{ label: "Mest köpta", cls: "c-pos", kind: "line" }, { label: "Mest sålda", cls: "c-neg", kind: "dash" }],
            tip: function (bin, rows) {
              return "<b>" + tick(bin.from) + " till " + tick(bin.to) + "</b>" + rows.map(function (r, i) {
                return tipRow(r.s.cls, i ? "Mest sålda" : "Mest köpta", nf1.format(r.share) + " %");
              }).join("");
            }
          });
        }) + '<p class="chart-note">Kurvorna är normalfördelningar med samma snitt och spridning som de ' + int(sT.n + sB.n) + " utfallen. Spridningen inom en grupp (<b>±" +
        nf0.format((sT.sd + sB.sd) / 2) + " %</b> per kvartal) är många gånger större än skillnaden mellan grupperna. Därför är en enskild akties utveckling svår att förutse ur fondernas köp.</p></div>") +
      "</div>";
  }

  // ---------- Metodrapport ----------
  // Beskriver hur datan samlas in och räknas. Siffrorna (antal fonder, kvartal, backtestets resultat) räknas när sidan visas.
  // Skrivs också ut som PDF av scripts/build-pdf.sh (site/metod/fondinsyn-metodrapport.pdf).

  function viewMethod() {
    document.title = "Metodrapport – Fondinsyn";
    var d = quarterData(), m = d.meta, idx = state.index.quarters;
    var hasHist = needHistory("se");
    var probe = hasHist && state.history.stocks[Object.keys(state.history.stocks)[0]][3][1];
    var bt = hasHist && probe && probe.length >= 6 ? computeBacktest(false) : null;
    var btA = bt ? computeBacktest(true) : null;
    var nFunds = Object.keys(d.fi).length;
    var sec = function (n, title, body) { return '<section class="md-sec"><h2><span class="md-n">' + n + "</span>" + title + "</h2>" + body + "</section>"; };
    var pdf = hasPdfName("metodrapport");
    var printHead = '<div class="print-only print-head"><b>Fondinsyn</b><span>Metodrapport</span><span>www.fondinsyn.se</span></div>';
    var btText = bt && bt.N && btA.N ?
      "<p>Resultat " + quarterLabel(bt.periods[0].held) + "–" + quarterLabel(bt.periods[bt.N - 1].held) + " (" + bt.N + " kvartal, i snitt " + nf0.format(bt.avgN) + " aktier per kvartal):</p>" +
      '<table class="md-table"><thead><tr><th class="l">Grupp</th><th>Snitt per kvartal</th><th>Per år</th></tr></thead><tbody>' +
      "<tr><td class=\"l\">Mest köpta (grupp 5)</td><td>" + pctS(bt.groupMean[BT_GROUPS - 1]) + "</td><td>" + pctS(bt.cagrTop) + "</td></tr>" +
      "<tr><td class=\"l\">Alla aktier</td><td>" + pctS(bt.allMean) + "</td><td>" + pctS(bt.cagrAll) + "</td></tr>" +
      "<tr><td class=\"l\">Mest sålda (grupp 1)</td><td>" + pctS(bt.groupMean[0]) + "</td><td>" + pctS(bt.cagrBottom) + "</td></tr></tbody></table>" +
      "<p>" + backtestVerdict(bt) + "</p><p>Bedömning: <b>" + STRENGTH[bt.test.level].toLowerCase() + "</b>. 95 % konfidensintervall " + ciText(bt.test.ci, pctS) + " per kvartal. " +
      "De mest köpta slog de mest sålda " + nf0.format(bt.hit * 100) + " % av kvartalen (slumpen ger 50 %, p-värde " + pText(bt.pHit) + "). " +
      "Med bara de aktivt förvaltade fondernas köp som signal blev skillnaden " + pctS(btA.test.mean) + " per kvartal (95 % konfidensintervall " + ciText(btA.test.ci, pctS) +
      ", p-värde " + pText(btA.test.p) + "): " + STRENGTH[btA.test.level].toLowerCase() + ".</p>" :
      "<p>Resultaten visas när kurshistoriken har laddats.</p>";
    return '<article class="text-page method">' + printHead +
      '<div class="page-head"><h1>Metodrapport</h1><p class="meta lead">Hur Fondinsyn samlar in och räknar sin data: källor, definitioner, uppskattningar och begränsningar. ' +
      "Uppdaterad " + dateText(new Date().toISOString().slice(0, 10)) + ".</p>" +
      (pdf ? '<div class="actions-row"><a class="btn" href="/metod/fondinsyn-metodrapport.pdf" target="_blank" rel="noopener">Ladda ner som PDF</a></div>' : "") + "</div>" +

      sec(1, "Sammanfattning",
        "<p>Fondinsyn visar vad svenska fonder äger, köper och säljer. Grunden är de innehavsrapporter som fondbolagen varje kvartal lämnar till Finansinspektionen (FI). " +
        "Genom att jämföra två kvartal fond för fond räknas nettoköp och nettosälj ut per aktie, fond och fondbolag. Ovanpå det läggs insynshandel, blankning, uppköp, " +
        "räntor, fondsparande och avkastning från andra öppna källor.</p>" +
        "<p>Just nu omfattar datan " + idx.length + " jämförda kvartal i detalj och historik sedan " + (hasHist ? quarterLabel(state.history.quarters[0]) : "2018") + ". Senaste kvartalet, " +
        quarterLabel(m.id) + ", innehåller " + int(nFunds) + " fonder och " + int(d.se.stocks.length) + " svenska aktier. Allt hämtas och räknas automatiskt varje morgon.</p>") +

      sec(2, "Källor",
        '<table class="md-table md-stack"><thead><tr><th class="l">Källa</th><th class="l">Innehåll</th><th class="l">Uppdateras</th></tr></thead><tbody>' +
        [["Finansinspektionen, fondinnehav", "Varje fonds alla innehav, fondförmögenhet, avgifter, aktiv risk", "Kvartalsvis"],
         ["Finansinspektionen, insynsregistret", "Insiders köp och sälj i sina bolag", "Dagligen"],
         ["Finansinspektionen, blankningsregistret", "Korta positioner över 0,5 % och summa per bolag", "Dagligen"],
         ["Finansinspektionen, prospektregistret", "Erbjudandehandlingar vid uppköp", "Dagligen"],
         ["Riksbanken", "Styrränta, stats- och bostadsobligationsräntor", "Dagligen"],
         ["Pensionsmyndigheten", "Avkastning för fonderna på premiepensionens fondtorg", "Veckovis"],
         ["Fondbolagens förening", "Insättningar och uttag per fondtyp och inriktning", "Månadsvis"],
         ["Nasdaq", "Antal aktier per aktieslag (för ägarandel)", "Månadsvis per bolag"]].map(function (r) {
          return '<tr><td class="l">' + r[0] + '</td><td class="l">' + r[1] + '</td><td class="l">' + r[2] + "</td></tr>";
        }).join("") + "</tbody></table>") +

      sec(3, "Från innehavsrapport till aktiedata",
        "<p>FI publicerar en fil per kvartal med en XML-rapport per fond. Som aktier räknas innehav med tillgångsslaget överlåtbart värdepapper, ett ISIN och ett antal. " +
        "Innehav som rapporteras med nominellt belopp, eller vars namn visar att det är en obligation, räknas som räntepapper och hanteras för sig.</p>" +
        "<p><b>Kurs.</b> Kursen för en aktie är medianen av fondernas rapporterade kurser (marknadsvärde delat med antal). Medianen gör att ett felrapporterat innehav hos en enskild fond inte påverkar.</p>" +
        "<p><b>Sektor och land</b> tas från fondernas rapporter (branschkod enligt GICS och emittentens land). Vid olika uppgifter gäller den vanligaste.</p>" +
        "<p><b>Splittar.</b> Vid en split ändras alla fonders antal aktier med samma kvot. Kvoten nytt antal delat med gammalt räknas för varje fond som ägt aktien båda kvartalen. " +
        "Om minst tre fonder, och minst 15 % av dem, har exakt samma kvot långt från 1 tolkas det som en split, och förra kvartalets antal räknas om. " +
        "Har fonderna också handlat samma kvartal används medianen av kvoterna: har de flesta fått ungefär k gånger fler aktier samtidigt som kursen fallit till ungefär 1/k, räknas det som en split med närmaste vanliga kvot.</p>" +
        "<p><b>Byte av aktieslag.</b> Vid en del splittar får aktien ett nytt ISIN. Då ser det gamla aktieslaget ut att säljas och det nya att köpas. Nya aktieslag räknas inte som köp, " +
        "och kvartal där antalet fonder som äger en aktie rasar med mer än 70 % används inte i kursberäkningar.</p>") +

      sec(4, "Nettoköp",
        "<p>Nettoköpet i en aktie är förändringen i antal aktier gånger kursen vid kvartalets slut, summerat över alla fonder som rapporterade både förra och detta kvartal:</p>" +
        '<p class="md-formula">Nettoköp = Σ (antal<sub>nu</sub> − antal<sub>förra</sub> × splitkvot) × kurs<sub>nu</sub></p>' +
        "<p>Fonder som är nya eller har försvunnit (start, nedläggning, fusion) räknas inte, eftersom deras förändring inte är köp eller sälj. " +
        "Aktier som ingen fond ägde förra kvartalet (nynoteringar, avknoppningar) eller som ingen äger längre (uppköp, avnoteringar) räknas inte heller som köp eller sälj.</p>" +
        "<p><b>Indexfonder</b> känns igen på namnet (index, OMX, passiv, tracker, ETF, Zero, Access och liknande). Med valet utan indexfonder räknas deras affärer bort, " +
        "eftersom de mest följer in- och utflöden och inte är egna val.</p>") +

      sec(5, "Fondernas ägarandel",
        "<p>Ägarandelen är fondernas sammanlagda antal aktier delat med antalet aktier i aktieslaget enligt Nasdaq. Den gäller svenska bolag på Nasdaq Stockholm och First North. " +
        "Fonder som inte rapporterar till FI, till exempel utländska fonder, räknas inte med, så den verkliga fondägda andelen är högre.</p>") +

      sec(6, "Fondflöden",
        "<p><b>Per fondtyp</b> används Fondbolagens förenings månadsstatistik över insättningar och uttag direkt.</p>" +
        "<p><b>Per fond</b> finns inga öppna flöden, så de uppskattas ur FI-datan:</p>" +
        '<p class="md-formula">Flöde ≈ förmögenhet<sub>nu</sub> − förmögenhet<sub>förra</sub> − Σ antal<sub>förra</sub> × (kurs<sub>nu</sub> − kurs<sub>förra</sub>)</p>' +
        "<p>Det som blir kvar när kursrörelserna på fondens aktier räknats bort är i huvudsak spararnas insättningar minus uttag. Utdelningar som fonden fått och fusioner med andra fonder " +
        "räknas också dit, så det andra kvartalet, när de flesta bolag delar ut, ser för positivt ut. Som kontroll gav metoden −18 mdkr för aktiefonderna första kvartalet 2026, " +
        "mot −16 mdkr enligt Fondbolagens förening.</p>") +

      sec(7, "Insynshandel",
        "<p><b>Insynshandel</b> är köp och sälj som insiders anmält till FI, med belopp omräknade till kronor. Köp minus sälj summeras per bolag över 90 dagar.</p>") +

      sec(8, "Backtest: lönar det sig att följa fonderna?",
        "<p>Testet undersöker om fondernas köp säger något om aktiernas kommande utveckling. Varje kvartal delas svenska aktier där fonderna ägde minst " + BT_MIN_VALUE +
        " mkr in i fem lika stora grupper efter nettoköpet i procent av innehavet. Eftersom innehaven blir kända först en tid efter kvartalets slut mäts gruppernas kursutveckling " +
        "kvartalet efter det, så att ingen information används innan den fanns. Varje aktie väger lika mycket, utdelningar och kostnader ingår inte, kvartal med byte av aktieslag " +
        "eller avnotering räknas inte och enstaka kvartalsavkastningar under −90 % eller över +300 % kapas.</p>" + btText +
        '<p><a href="#/backtest">Se backtestet med diagram och alla kvartal</a></p>') +

      sec(9, "Statistisk prövning",
        "<p>Varje analys som drar en slutsats om ett samband redovisar urvalets storlek, effektens storlek, ett 95 % konfidensintervall och ett p-värde, och får en av tre bedömningar:</p><ul>" +
        "<li><b>Starkt samband:</b> p-värde under 0,05 och en stor effekt, det vill säga en korrelation på minst 0,5 eller ett snitt minst en halv standardavvikelse från noll.</li>" +
        "<li><b>Svagt samband:</b> p-värde under 0,05 men en mindre effekt.</li>" +
        "<li><b>Inget statistiskt säkerställt samband:</b> p-värde på 0,05 eller mer. Då dras ingen slutsats åt något håll.</li></ul>" +
        "<p><b>Två test.</b> Snitt prövas med t-test och permutationstest (10 000 slumpvisa teckenbyten), och båda måste ge p under 0,05. Det högsta p-värdet visas, " +
        "och är utfallen skeva räknas konfidensintervallet med bootstrap. En vanlig korrelation kontrolleras med rangkorrelation, som inte påverkas av extremvärden. " +
        "Där extremvärden är vanliga, som i aktiers kursrörelser, används rangkorrelationen direkt.</p>" +
        "<p><b>Rätt enhet.</b> Backtestet räknas per kvartal och inte per aktie, eftersom aktier samma kvartal rör sig ihop. Fonder som äger samma aktier är inte heller " +
        "oberoende, så p-värdena för jämförelser mellan fonder är snarare för låga än för höga.</p>" +
        "<p><b>Källkritik.</b> Varje analys listar sina svagheter, till exempel överlevnadsbias, korta perioder och att en tredje faktor kan ligga bakom sambandet. " +
        "Ett säkerställt samband visar bara att två saker har hängt ihop, inte att den ena orsakar den andra.</p>") +

      sec(10, "Begränsningar",
        "<ul><li>Innehaven gäller kvartalets sista dag. Affärer under kvartalet syns bara som nettot mellan två kvartal.</li>" +
        "<li>Bara fonder som rapporterar till Finansinspektionen ingår, inte utländska fonder, pensionsbolag eller andra institutioner.</li>" +
        "<li>Fondbolagen rapporterar själva. Felaktiga uppgifter rättas inte, men medianer och kontroller begränsar effekten.</li>" +
        "<li>Uppskattningarna av fondflöden och ägarandel är just uppskattningar och redovisas som det.</li>" +
        "<li>Inget på Fondinsyn är investeringsrådgivning.</li></ul>") +

      sec(11, "Kvalitet och teknik",
        "<p>Allt hämtas och räknas automatiskt varje morgon. Innan något publiceras kontrolleras datan (antal fonder, aktier och kvartal ska vara rimliga), och stoppas publiceringen om något ser fel ut. " +
        "Sajten är statisk och kräver inget konto. Datan finns att ladda ner som CSV och JSON, se <a href=\"/oppen-data/\">Data och API</a>.</p>") +
      '<div class="print-only print-foot">Fondinsyn (www.fondinsyn.se). Metodrapport skapad ' + dateText(new Date().toISOString().slice(0, 10)) + ". Inte investeringsrådgivning.</div>" +
      "</article>";
  }
  function prevQuarterId(q) { var y = +q.slice(0, 4), n = +q.slice(5); return n === 1 ? (y - 1) + "Q4" : y + "Q" + (n - 1); }

  // ---------- Fondsparandet ----------
  // data/flows.json byggs av scripts/build-flows.ps1: månadsstatistik från Fondbolagens förening (MSEK)
  // och uppskattade nettoflöden per fond och kvartal ur FI:s fondinnehav.

  function needFlows() {
    return need("flows", function () { return getJSON("data/flows.json").then(function (d) { state.flows = d; }); });
  }
  var MONTH_SHORT = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
  function monthLabel(ym, long) {
    var y = ym.slice(0, 4), m = parseInt(ym.slice(5), 10) - 1;
    return (long ? MONTH_NAMES[m] : MONTH_SHORT[m]) + " " + y;
  }
  var MONTH_NAMES = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
  // Uppskattat flöde för en fond det valda kvartalet: [id, namn, bolag, förmögenhet i början, flöde, andel aktier]
  function fundFlowFor(id) {
    var F = state.flows && state.flows.funds && state.flows.funds[state.q];
    if (!F) return null;
    if (!F.byId) { F.byId = {}; F.forEach(function (r) { F.byId[r[0]] = r; }); }
    return F.byId[id] || null;
  }

  var savingsState = { type: "TOTALT" };
  // På mobil står bara början av namnet ("Aktie", "Bland") så att alla fyra får plats
  var SAVINGS_TYPES = [["TOTALT", 'Alla<span class="lg"> fonder</span>'], ["Aktiefonder", 'Aktie<span class="lg">fonder</span>'],
    ["Blandfonder", 'Bland<span class="lg">fonder</span>'], ["Räntefonder", 'Ränte<span class="lg">fonder</span>']];

  function viewSavings() {
    document.title = "Fondsparandet – vart spararnas pengar går – Fondinsyn";
    var head = '<div class="page-head"><h1>Fondsparandet</h1><p class="meta lead">Hur mycket svenskarna sätter in i och tar ut ur fonder varje månad, ' +
      "vilka sorters fonder som får pengarna och vilka enskilda fonder som växer mest. Månadssiffrorna kommer från Fondbolagens förening, " +
      "flödena per fond är uppskattade ur Finansinspektionens fondinnehav.</p></div>";
    if (!needFlows()) return head + (failed("flows") ? errorBlock() : loadingBlock("Laddar fondsparandet…"));
    var D = state.flows, html = head;

    if (D.months && D.types && D.types.TOTALT) {
      var months = D.months, T = D.types;
      // Räntefonder = långa + korta
      var rate = months.map(function (m, i) {
        var a = T["Långa räntefonder"] && T["Långa räntefonder"][i], b = T["Korta räntefonder"] && T["Korta räntefonder"][i];
        return a || b ? [(a ? a[0] : 0) + (b ? b[0] : 0), (a ? a[1] : 0) + (b ? b[1] : 0)] : null;
      });
      var series = function (name) { return name === "Räntefonder" ? rate : (T[name] || D.focus[name] || []); };
      var last = months.length - 1;
      while (last > 0 && !T.TOTALT[last]) last--;
      var lm = months[last], year = lm.slice(0, 4);
      var net = function (name, i) { var v = series(name)[i]; return v ? v[0] : null; };
      var sumNet = function (name, from, to) { var s = 0; for (var i = Math.max(0, from); i <= to; i++) { var v = net(name, i); if (v != null) s += v; } return s; };
      var ytdFrom = months.indexOf(year + "-01");
      var msek = function (v, sign) { return v == null ? "–" : '<span class="' + (sign ? cls(v) : "") + '">' + bigSek(v * 1e6, sign) + "</span>"; };

      html += '<dl class="figures">' +
        fig("Nettosparande " + monthLabel(lm, true), msek(net("TOTALT", last), true), "Hittills i år " + bigSek(sumNet("TOTALT", ytdFrom, last) * 1e6, true)) +
        fig("Aktiefonder", msek(net("Aktiefonder", last), true), "Hittills i år " + bigSek(sumNet("Aktiefonder", ytdFrom, last) * 1e6, true)) +
        fig("Räntefonder", msek(net("Räntefonder", last), true), "Hittills i år " + bigSek(sumNet("Räntefonder", ytdFrom, last) * 1e6, true)) +
        fig("Indexfonder (aktier)", msek(net("varav indexfonder", last), true), "Hittills i år " + bigSek(sumNet("varav indexfonder", ytdFrom, last) * 1e6, true)) +
        fig("Fondförmögenhet", T.TOTALT[last] ? bigSek(T.TOTALT[last][1] * 1e6) : "–", "alla fonder, " + monthLabel(lm)) + "</dl>";

      // Diagram: nettosparande per månad
      var segBtn = function (v, label) { return '<button type="button" class="seg-btn" data-sav-type="' + v + '" aria-pressed="' + (savingsState.type === v) + '">' + label + "</button>"; };
      var pts = [];
      for (var i = Math.max(0, last - 23); i <= last; i++) pts.push({ m: months[i], value: net(savingsState.type, i) == null ? null : net(savingsState.type, i) / 1000, highlight: i === last });
      html += '<section class="block section-gap"><div class="block-head"><h2>Nettosparande per månad</h2>' +
        '<div class="seg" role="group" aria-label="Fondtyp">' + SAVINGS_TYPES.map(function (t) { return segBtn(t[0], t[1]); }).join("") + "</div></div>" +
        '<p class="desc">Insättningar minus uttag, miljarder kronor. Senaste månaden är markerad.</p>' +
        '<div class="chart-card">' + chart(function (node) {
          FFCharts.columns(node, pts, { height: 240, focus: true, label: function (p) { return signed(nf1.format(p.value), p.value); },
            tip: function (p) { return "<b>" + monthLabel(p.m, true) + "</b>" + (p.value == null ? '<div class="muted">Ingen data</div>' : tipRow(p.value >= 0 ? "c-pos" : "c-neg", p.value >= 0 ? "Insättningar netto" : "Uttag netto", bigSek(p.value * 1e9, true), true)); } });
        }) + "</div></section>";

      // Tabell per fondtyp
      var typeNames = ["Aktiefonder", "Blandfonder", "Långa räntefonder", "Korta räntefonder", "Hedgefonder", "Övriga fonder", "TOTALT"].filter(function (n) { return T[n]; });
      var typeRows = typeNames.map(function (n) {
        return { name: n === "TOTALT" ? "Alla fonder" : n, total: n === "TOTALT", m: net(n, last), ytd: sumNet(n, ytdFrom, last), y12: sumNet(n, last - 11, last), aum: T[n][last] ? T[n][last][1] : null };
      });
      var colMsek = function (key, label, hide) { return { key: key, label: label, hideSm: hide, cell: function (r) { return msek(r[key], true); }, value: function (r) { return r[key]; } }; };
      html += '<div class="grid-2 section-gap">' +
        block("Per fondtyp", "Nettosparande " + monthLabel(lm, true) + ", hittills i år och de senaste tolv månaderna.",
          table("sav-types", [
            { key: "name", label: "Fondtyp", align: "l", cls: "name", cell: function (r) { return '<span class="nm-plain">' + esc(r.name) + "</span>"; } },
            colMsek("m", monthLabel(lm)), colMsek("ytd", "I år", true), colMsek("y12", "12 mån"),
            { key: "aum", label: "Förmögenhet", hideSm: true, cell: function (r) { return r.aum == null ? "–" : bigSek(r.aum * 1e6); } }
          ], typeRows, { static: true })) +
        (function () {
          var skip = { "AKTIEFONDER TOTALT": 1, "varav indexfonder": 1, "Ryssland": 1 };
          var items = Object.keys(D.focus).filter(function (n) { return !skip[n]; }).map(function (n) { return { label: n, v: sumNet(n, last - 11, last) }; })
            .sort(function (a, b) { return b.v - a.v; });
          var idx = sumNet("varav indexfonder", last - 11, last), allEq = sumNet("AKTIEFONDER TOTALT", last - 11, last);
          return block("Aktiefonder per inriktning", "Nettosparande de senaste tolv månaderna." +
            (allEq ? " Indexfonderna fick " + bigSek(idx * 1e6, true) + " av aktiefondernas " + bigSek(allEq * 1e6, true) + "." : ""),
            divBars(items));
        })() + "</div>";
    }

    // Uppskattade flöden per fond
    var F = D.funds && D.funds[state.q];
    if (F && F.length) {
      var rows = F.map(function (r) { return { id: r[0], name: r[1], co: r[2], a1: r[3], flow: r[4], p: r[3] ? r[4] / r[3] : null }; });
      var ins = rows.filter(function (r) { return r.flow > 0; }).sort(function (a, b) { return b.flow - a.flow; });
      var outs = rows.filter(function (r) { return r.flow < 0; }).sort(function (a, b) { return a.flow - b.flow; });
      var flowCols = [
        { key: "name", label: "Fond", align: "l", cls: "name", cell: function (r) { return nameCell(fundHref({ id: r.id }), r.name, esc(r.co) + " · " + pct(r.p) + " av förmögenheten"); }, value: function (r) { return r.name; } },
        { key: "co", label: "Fondbolag", align: "l", cls: "muted", hideSm: true, cell: function (r) { return esc(r.co); } },
        { key: "flow", label: "Nettoflöde (mkr)", cell: function (r) { return '<span class="' + cls(r.flow) + '">' + mkr(r.flow, true) + "</span>"; }, value: function (r) { return r.flow; } },
        { key: "p", label: "Andel", hideSm: true, cell: function (r) { return '<span class="' + cls(r.p) + '">' + pct(r.p) + "</span>"; }, value: function (r) { return r.p; } }
      ];
      // Per fondbolag
      var byCo = {};
      rows.forEach(function (r) { var c = byCo[r.co] = byCo[r.co] || { co: r.co, flow: 0, a1: 0, n: 0 }; c.flow += r.flow; c.a1 += r.a1; c.n++; });
      var cos = Object.keys(byCo).map(function (k) { return byCo[k]; }).filter(function (c) { return c.a1 >= 1e9; }).sort(function (a, b) { return b.flow - a.flow; });
      var coCols = [
        { key: "co", label: "Fondbolag", align: "l", cls: "name", cell: function (c) { return nameCell(companyHref(c.co), c.co, int(c.n) + " fonder · " + pct(c.flow / c.a1) + " av förmögenheten"); } },
        { key: "flow", label: "Nettoflöde (mkr)", cell: function (c) { return '<span class="' + cls(c.flow) + '">' + mkr(c.flow, true) + "</span>"; } },
        { key: "p", label: "Andel", hideSm: true, cell: function (c) { return '<span class="' + cls(c.flow) + '">' + pct(c.flow / c.a1) + "</span>"; } }
      ];
      var Q = quarterLabel(state.q);
      html += '<h2 class="section-title">Fonderna som växte och krympte mest ' + Q + "</h2>" +
        '<p class="intro">Uppskattat nettoflöde: hur mycket fondförmögenheten ändrades utöver kursrörelserna på fondens aktier. ' +
        "Det är i huvudsak spararnas insättningar minus uttag, men också fusioner med andra fonder och utdelningar som fonden fått, " +
        "så det andra kvartalet, när de flesta bolag delar ut, ser för positivt ut. Fonder under 100 mkr är inte med.</p>" +
        '<div class="grid-2">' +
        block("Störst inflöde", "", table("flow-in", flowCols, ins.slice(0, 15), { static: true })) +
        block("Störst utflöde", "", table("flow-out", flowCols, outs.slice(0, 15), { static: true })) + "</div>" +
        '<div class="grid-2 section-gap">' +
        block("Fondbolag som fick mest", "Summan för bolagets fonder. Bolag med minst 1 mdkr i fonderna.", table("flow-co-in", coCols, cos.slice(0, 10), { static: true })) +
        block("Fondbolag som tappade mest", "&nbsp;", table("flow-co-out", coCols, cos.slice().reverse().filter(function (c) { return c.flow < 0; }).slice(0, 10), { static: true })) + "</div>";
    } else {
      html += '<div class="notice section-gap">Flöden per fond finns inte för ' + quarterLabel(state.q) + ".</div>";
    }
    html += '<p class="desc section-gap">Källor: <a href="https://www.fondbolagen.se/fakta_index/statistik/" rel="noopener">Fondbolagens förening</a> (månadsstatistik, ' +
      "fonder som marknadsförs av föreningens medlemmar och premiepensionens fonder) och Finansinspektionens fondinnehav. Uppdaterad " + esc(D.built) + ".</p>";
    return html;
  }

  // Insiders köp och sälj per vecka (måndag–söndag): köp som staplar uppåt och sälj nedåt, i miljoner kronor
  function isoWeek(date) {
    var d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    return Math.ceil(((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7);
  }
  function insiderWeeks(rows, days) {
    var monday = function (iso) {
      var d = new Date(iso + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return d;
    };
    // Bara periodens veckor, i följd: affärer som anmälts sent med gamla transaktionsdatum räknas inte, och tomma veckor blir noll
    var weeks = {}, list = [], since = daysAgo(+days || 90);
    for (var d = monday(since), end = new Date(); d <= end; d.setUTCDate(d.getUTCDate() + 7)) {
      var k = d.toISOString().slice(0, 10);
      list.push(weeks[k] = { w: k, buy: 0, sell: 0, nb: 0, ns: 0 });
    }
    rows.forEach(function (r) {
      if (r.sek == null || (r.kind !== "buy" && r.kind !== "sell") || r.tx < since) return;
      var e = weeks[monday(r.tx).toISOString().slice(0, 10)];
      if (!e) return;
      if (r.kind === "buy") { e.buy += r.sek; e.nb++; } else { e.sell += r.sek; e.ns++; }
    });
    if (list.filter(function (e) { return e.nb + e.ns; }).length < 4) return "";
    var pts = list.map(function (e) { return { w: e.w, value: e.buy / 1e6, neg: -e.sell / 1e6, e: e }; });
    var weekNo = function (p) { return isoWeek(new Date(p.w + "T00:00:00Z")); };
    return '<section class="chart-card section-gap"><div class="chart-title">Insiders köp och sälj per vecka <span>mkr, de senaste ' + days + " dagarna</span></div>" +
      chart(function (node) {
        FFCharts.columns(node, pts, { height: 200, ticks: 4, barMax: 20,
          legend: [{ label: "Köp", cls: "c-pos" }, { label: "Sälj", cls: "c-neg" }],
          xLabel: function (p) { return "v. " + weekNo(p); },
          tip: function (p) {
            return "<b>Vecka " + weekNo(p) + "</b>" + tipRow("c-pos", "Köp, " + int(p.e.nb) + " st", bigSek(p.e.buy), true) +
              tipRow("c-neg", "Sälj, " + int(p.e.ns) + " st", bigSek(p.e.sell), true);
          } });
      }) + "</section>";
  }

  function viewInsider() {
    document.title = "Insynshandel – Fondinsyn";
    var head = '<div class="page-head"><h1>Insynshandel</h1><p class="meta lead">Köp och sälj som vd:ar, styrelseledamöter och andra i ledande ställning har gjort i sina egna bolag. ' +
      "Från Finansinspektionens insynsregister, uppdateras varje morgon. " + termLink("insynshandel", "Vad är insynshandel?") + "</p></div>";
    if (!needInsider()) return head + (failed("insider") ? errorBlock() : loadingBlock("Laddar insynshandel…"));
    var I = state.insider, ds = quarterData().se, since30 = daysAgo(30);
    // "Bara egna affärer" räknar bort närståendes affärer (familj och bolag som personen kontrollerar eller företräder)
    var rowsAll = insiderFilter.own ? I.rows.filter(function (r) { return !r.close; }) : I.rows;
    var sum = function (list) { return list.reduce(function (a, r) { return a + (r.sek || 0); }, 0); };
    var closeOf = function (list) { return list.filter(function (r) { return r.close; }); };
    var buys30 = rowsAll.filter(function (r) { return r.kind === "buy" && r.tx >= since30; });
    var sells30 = rowsAll.filter(function (r) { return r.kind === "sell" && r.tx >= since30; });

    // Per bolag under hela perioden: köpt, sålt och hur många olika personer som köpt
    var by = {};
    rowsAll.forEach(function (r) {
      if (r.sek == null || r.kind === "other") return;
      var e = by[r.isin] = by[r.isin] || { r: r, buy: 0, sell: 0, close: 0, buyers: {} };
      if (r.kind === "buy") { e.buy += r.sek; e.buyers[r.person] = 1; } else e.sell += r.sek;
      if (r.close) e.close += r.kind === "buy" ? r.sek : -r.sek;
    });
    var comp = Object.keys(by).map(function (k) { var e = by[k]; e.net = e.buy - e.sell; e.nBuyers = Object.keys(e.buyers).length; return e; });
    // Tolv månader: sammanställningen ur arkivet (data/insider-year.json, byggs av scripts/build-pages.ps1)
    var yearMode = insiderFilter.period === "365" && !insiderFilter.own && need("insider-year", function () { return getJSON("data/insider-year.json").then(function (x) { state.insiderYear = x; }); });
    if (yearMode) comp = state.insiderYear.rows.map(function (y) { return { r: { issuer: y[1], isin: y[0] }, buy: y[2], sell: y[3], net: y[2] - y[3], nBuyers: y[4] }; });
    var periodText = yearMode ? "12 månaderna" : I.days + " dagarna";
    var top = comp.filter(function (e) { return e.net > 0; }).sort(function (a, b) { return b.net - a.net; });
    var topSold = comp.filter(function (e) { return e.net < 0; }).sort(function (a, b) { return a.net - b.net; });

    var html = head + '<div class="highlights">' +
      highlight("Insiderköp, 30 dagar", bigSek(sum(buys30)), null, '<span class="pos">' + int(buys30.length) + " affärer</span>",
        insiderFilter.own ? "bara egna affärer" : closeNote(sum(buys30), sum(closeOf(buys30))).replace(/^, /, "")) +
      highlight("Insidersälj, 30 dagar", bigSek(sum(sells30)), null, '<span class="neg">' + int(sells30.length) + " affärer</span>",
        insiderFilter.own ? "bara egna affärer" : closeNote(sum(sells30), sum(closeOf(sells30))).replace(/^, /, "")) +
      highlight("Mest köpt av insiders", top[0] && top[0].r.issuer, top[0] && ds.byIsin[top[0].r.isin] ? stockHref(ds.byIsin[top[0].r.isin]) : null,
        top[0] ? '<span class="pos">' + bigSek(top[0].net, true) + "</span>" : "", top[0] ? int(top[0].nBuyers) + (top[0].nBuyers === 1 ? " person" : " personer") + ", " + (yearMode ? "12 månader" : I.days + " dagar") + closeNote(top[0].net, top[0].close) : "") +
      "</div>" + insiderWeeks(rowsAll, I.days);

    var fundFlow = function (e) { var s = ds.byIsin[e.r.isin]; return s && s.netFlow != null ? s.flow : null; };
    var compCols = function (sold) {
      return [
        { key: "b", label: "Bolag", align: "l", cls: "name", cell: function (e) { return issuerCell(e.r, (sold ? "Sålt " + bigSek(e.sell) : "Köpt " + bigSek(e.buy) + " · " + int(e.nBuyers) + " köpare") + closeNote(e.net, e.close)); } },
        { key: "net", label: "Netto insiders", cell: function (e) { return '<span class="' + cls(e.net) + '">' + bigSek(e.net, true) + "</span>"; }, value: function (e) { return e.net; } },
        { key: "n", label: "Köpare", hideSm: true, cell: function (e) { return int(e.nBuyers); }, value: function (e) { return e.nBuyers; } },
        { key: "f", label: "Fondernas nettoköp " + quarterLabel(state.q), cell: function (e) { var v = fundFlow(e); return v == null ? "–" : '<span class="' + cls(v) + '">' + bigSek(v, true) + "</span>"; },
          value: function (e) { return fundFlow(e); } }
      ];
    };
    var pseg = function (v, label) { return '<button type="button" class="seg-btn" data-ins-period="' + v + '" aria-pressed="' + (insiderFilter.period === v) + '">' + label + "</button>"; };
    var oseg = function (v, label) { return '<button type="button" class="seg-btn" data-ins-own="' + v + '" aria-pressed="' + (insiderFilter.own === v) + '">' + label + "</button>"; };
    html += '<div class="toolbar section-gap"><div class="seg" role="group" aria-label="Period">' + pseg("90", "90 dagar") + pseg("365", "12 månader") + "</div>" +
      '<div class="seg" role="group" aria-label="Vems affärer">' + oseg(false, "Alla affärer") + oseg(true, "Bara egna") + "</div></div>";
    html += '<div class="grid-2">' +
      block("Mest köpt av insiders", "Köp minus sälj de senaste " + periodText + ", i kronor.", table("ins-top", compCols(false), top, { sort: { col: "net", dir: -1 }, limit: 15 })) +
      block("Mest sålt av insiders", "Samma period. Försäljningar kan bero på skatt, lån eller optionsprogram.", table("ins-sold", compCols(true), topSold, { sort: { col: "net", dir: 1 }, limit: 15 })) +
      "</div>";

    // Senaste affärerna med filter
    var f = insiderFilter;
    var list = rowsAll.filter(function (r) {
      if (f.kind !== "all" && r.kind !== f.kind) return false;
      return !f.min || (r.sek != null && r.sek >= f.min);
    });
    var seg = function (v, label) { return '<button type="button" class="seg-btn" data-ins-kind="' + v + '" aria-pressed="' + (f.kind === v) + '">' + label + "</button>"; };
    var cols = [
      { key: "b", label: "Bolag", align: "l", cls: "name", cell: function (r) { return issuerCell(r, personText(r) + " · " + insiderValue(r)); }, value: function (r) { return r.issuer; }, csv: function (r) { return r.issuer; } },
      { key: "p", label: "Person", align: "l", hideSm: true, cell: function (r) { return personText(r) + '<span class="sub">' + esc(r.role) + "</span>"; }, value: function (r) { return r.person; } },
      { key: "k", label: "Typ", align: "l", cell: function (r) { return insiderKind(r); } },
      { key: "v", label: "Värde", hideSm: true, cell: insiderValue, value: function (r) { return r.sek; }, csv: function (r) { return r.sek == null ? "" : Math.round(r.sek); } },
      { key: "d", label: "Datum", cls: "muted", cell: function (r) { return esc(r.tx); }, value: function (r) { return r.tx; } }
    ];
    html += '<section class="block section-gap"><div class="block-head"><h2>Senaste affärerna</h2><div class="seg" role="group" aria-label="Typ av affär">' +
      seg("buy", "Köp") + seg("sell", "Sälj") + seg("all", "Alla") + "</div></div>" +
      '<div class="toolbar"><label class="visually-hidden" for="insMin">Minsta värde</label><select id="insMin" class="select-sm">' +
      [[0, "Alla belopp"], [100000, "Över 100 000 kr"], [1000000, "Över 1 mkr"]].map(function (o) { return '<option value="' + o[0] + '"' + (f.min === o[0] ? " selected" : "") + ">" + o[1] + "</option>"; }).join("") +
      '</select><span class="count">' + int(list.length) + " affärer</span></div>" +
      table("ins-latest", cols, list, { sort: { col: "d", dir: -1 }, limit: 50, expand: true, csv: true }) + "</section>";
    html += '<p class="desc section-gap"><b>Om närstående:</b> ' + CLOSE_INFO + " Registret säger inte vem den närstående är. Med <b>Bara egna</b> räknas bara personernas egna affärer" +
      (insiderFilter.period === "365" && insiderFilter.own ? " (för de senaste " + I.days + " dagarna, sammanställningen för tolv månader delar inte upp affärerna)" : "") + ".</p>" +
      '<p class="desc">Källa: Finansinspektionens insynsregister, publiceringar sedan ' + esc(I.from) + ". Bara affärer i aktier visas. " +
      "Värdet är antal gånger pris och visas i kronor för affärer i svenska kronor.</p>";
    return html;
  }

  // Insynshandel i en aktie, för aktiesidan
  // Insynshandel i en aktie, för aktiesidan. Hela historiken sedan 2019 ligger i data/insyn/<isin>.json
  // (byggs ur arkivet av scripts/build-pages.ps1). Saknas filen används de senaste 90 dagarna.
  // FI:s befattningar har ofta hårda mellanslag ("Verkställande direktör") som inte kan radbrytas
  function plainSpaces(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
  function insiderRow(r) {
    return { tx: r[0], pub: r[1], issuer: r[2], isin: r[3], person: plainSpaces(r[4]), role: plainSpaces(r[5]), close: !!r[6], nature: r[7],
      vol: r[8], price: r[9], cur: r[10], sek: r[11], kind: r[7] === "Förvärv" ? "buy" : r[7] === "Avyttring" ? "sell" : "other" };
  }
  function stockInsiderRows(isin) {
    state.insiderArchive = state.insiderArchive || {};
    var key = "insyn-" + isin;
    // pages.json listar aktierna som har ett arkiv. Övriga (utländska aktier m.fl.) visar de senaste 90 dagarna.
    if (!needPages() && !failed("pages")) return null;
    var hasArchive = !pageMap || !pageMap.insyn || pageMap.insyn.indexOf(isin) >= 0;
    if (hasArchive && !failed(key)) {
      var ok = need(key, function () {
        return getJSON("data/insyn/" + isin + ".json").then(function (x) { state.insiderArchive[isin] = x.rows.map(insiderRow); });
      });
      if (ok) return { rows: state.insiderArchive[isin], all: true };
      if (state.loading[key] === "pending") return null;
    }
    if (!needInsider()) return null;
    return { rows: state.insider.byIsin[isin] || [], all: false };
  }
  function stockInsiderSection(isin) {
    var res = stockInsiderRows(isin);
    if (!res) return "";
    var rows = res.rows.filter(function (r) { return r.kind !== "other"; });
    if (!rows.length) return "";
    var since = daysAgo(365), b = 0, s = 0, cb = 0, cs = 0;
    rows.forEach(function (r) {
      if (r.tx < since) return;
      if (r.kind === "buy") { b += r.sek || 0; if (r.close) cb += r.sek || 0; } else { s += r.sek || 0; if (r.close) cs += r.sek || 0; }
    });
    var anyClose = rows.some(function (r) { return r.close; });
    var cols = [
      { key: "p", label: "Person", align: "l", cls: "name", cell: function (r) { return '<span class="nm-plain">' + personText(r) + '</span><span class="sub">' + esc(r.role) + '<span class="show-sm-i"> · ' + esc(r.tx) + "</span></span>"; } },
      { key: "k", label: "Typ", align: "l", cell: insiderKind },
      { key: "v", label: "Värde", cell: insiderValue },
      { key: "d", label: "Datum", cls: "muted", hideSm: true, cell: function (r) { return esc(r.tx); } }
    ];
    var first = rows[rows.length - 1].tx.slice(0, 4);
    return '<section class="block section-gap"><div class="block-head"><h2>Insynshandel</h2><span class="note">' + (b || s ? "Senaste 12 månaderna: köpt " + bigSek(b) + (cb >= 0.5 * b && cb > 0 ? " (varav " + bigSek(cb) + " via närstående)" : "") +
        " · sålt " + bigSek(s) + (cs >= 0.5 * s && cs > 0 ? " (varav " + bigSek(cs) + " via närstående)" : "") : "Inga köp eller sälj de senaste 12 månaderna") + "</span></div>" +
      '<p class="desc">' + int(rows.length) + (rows.length === 1 ? " köp eller sälj" : " köp och sälj") + " anmälda " + (res.all ? "sedan " + first : "de senaste 90 dagarna") + "." +
      (anyClose ? " " + CLOSE_INFO : "") + "</p>" +
      table("stock-ins-" + isin, cols, rows, { static: true, limit: 10, expand: true }) +
      '<a class="more" href="#/insyn">All insynshandel</a></section>';
  }

  function stockShortSection(isin) {
    if (!needShorts()) return "";
    var d = state.shorts, a = d.byIsin[isin], hs = d.holdersOf[isin] || [], ser = d.series[isin];
    if (!a && !hs.length && !ser) return "";
    var html = '<section class="block section-gap"><div class="block-head"><h2>Blankning</h2>' +
      (a && a.pct >= 2 ? '<span class="pill neg">' + nf2.format(a.pct) + " % blankat</span>" : "") + "</div>";
    html += '<p class="desc">' + (a ? "Totalt " + nf2.format(a.pct) + " % av aktierna är blankade (" + esc(a.date) + ")" + (a.ch30 != null && a.ch30 !== 0 ? ", " + (a.ch30 > 0 ? "upp " : "ned ") + nf2.format(Math.abs(a.ch30)) + " procentenheter på 30 dagar" : "") + "." : "Ingen blankning över 0,1 % just nu.") + "</p>";
    var parts = [];
    if (ser && ser.length) {
      parts.push('<div class="chart-card"><div class="chart-title">Offentliga blankningspositioner <span>% av aktierna, 2 år</span></div>' + chart(function (node) {
        var pts = [], j = 0, v = 0;
        d.weeks.forEach(function (w, i) {
          while (j < ser.length && ser[j][0] <= i) { v = ser[j][1]; j++; }
          pts.push({ q: w.slice(5, 7) === "01" && +w.slice(8) <= 7 ? w.slice(0, 4) + "Q1" : "", date: w, value: v });
        });
        FFCharts.line(node, pts, { height: 200, format: function (x) { return nf2.format(x) + " %"; },
          tip: function (p) { return "<b>" + dateText(p.date) + "</b>" + tipRow("s1", "Blankat", nf2.format(p.value) + " %"); } });
      }) + "</div>");
    }
    if (hs.length) {
      parts.push(table("stock-shorts-" + isin, [
        { key: "h", label: "Blankare", align: "l", cls: "name", cell: function (c) { return holderLink(c.holder); } },
        { key: "p", label: "Position", cell: function (c) { return nf2.format(c.pct) + " %"; }, value: function (c) { return c.pct; } },
        { key: "d", label: "Sedan", cls: "muted", cell: function (c) { return c.date; } }
      ], hs, { sort: { col: "p", dir: -1 } }));
    }
    return html + (parts.length > 1 ? '<div class="grid-2">' + parts.join("") + "</div>" : parts.join("")) + "</section>";
  }

  // ---------- Blankare ----------

  // Samma blankare har stavats olika genom åren ("MAVERICK CAPITAL, LTD" / "Maverick Capital Ltd")
  function normHolder(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ")
      .replace(/\b(ltd|limited|llc|lp|llp|l p|sa|inc|plc|corp|corporation|ab|as|gmbh|ag|co|the)\b/g, " ").replace(/\s+/g, " ").trim();
  }
  var SWEDISH_HOLDER_RE = /\bAB\b|fonder\b|kapitalförvaltning/i;
  function holderHref(name) { return "#/blankare/" + encodeURIComponent(normHolder(name)); }
  function holderLink(name) {
    return '<a href="' + holderHref(name) + '">' + esc(name) + "</a>" + (SWEDISH_HOLDER_RE.test(name) ? ' <span class="label">Svensk</span>' : "");
  }

  function holdersNow() {
    var d = state.shorts, by = {};
    d.cur.forEach(function (c) {
      var k = normHolder(c.holder);
      var h = by[k] = by[k] || { key: k, name: c.holder, positions: [], sum: 0 };
      h.positions.push(c); h.sum += c.pct;
    });
    return Object.keys(by).map(function (k) { return by[k]; });
  }

  function needShortHistory() {
    return need("shortsHistory", function () {
      return getJSON("data/shorts-history.json").then(function (d) {
        d.rows = d.rows.map(function (r) { return { date: r[0], holder: r[1], key: normHolder(r[1]), isin: r[2], pct: r[3] }; });
        state.shortsHistory = d;
      });
    });
  }

  function shortStockCell(isin) {
    var s = shortStock(isin), nm = s ? s.name : prettyName(state.shorts.names[isin] || isin);
    return s ? '<a href="' + stockHref(s) + '">' + esc(nm) + "</a>" : '<span class="nm-plain">' + esc(nm) + "</span>";
  }

  function viewHolders() {
    document.title = "Blankare – Fondinsyn";
    var head = '<div class="page-head"><div class="crumbs"><a href="#/blankning">Blankning</a> / Blankare</div><h1>Vem blankar?</h1>' +
      '<p class="meta lead">Alla fonder och förvaltare med en offentlig blankningsposition på minst 0,5 % i ett svenskt bolag. De flesta är hedgefonder; vanliga svenska aktiefonder får i regel inte blanka.</p></div>';
    if (!needShorts()) return head + (failed("shorts") ? errorBlock() : loadingBlock("Laddar blankning…"));
    var list = holdersNow();
    var swedish = list.filter(function (h) { return SWEDISH_HOLDER_RE.test(h.name); });
    var cols = [
      { key: "name", label: "Blankare", align: "l", cls: "name", value: function (h) { return h.name; }, cell: function (h) {
        var top = h.positions.slice().sort(function (a, b) { return b.pct - a.pct; }).slice(0, 3).map(function (c) {
          var s = shortStock(c.isin); return (s ? s.name : prettyName(state.shorts.names[c.isin] || c.isin)) + " " + nf2.format(c.pct) + " %";
        }).join(", ");
        return holderLink(h.name) + '<span class="sub">' + esc(top) + "</span>";
      } },
      { key: "n", label: "Aktier", cell: function (h) { return int(h.positions.length); }, value: function (h) { return h.positions.length; } },
      { key: "sum", label: "Summa", hideSm: true, cell: function (h) { return nf2.format(h.sum) + " %"; }, value: function (h) { return h.sum; } },
      { key: "max", label: "Största", hideSm: true, cell: function (h) { return nf2.format(Math.max.apply(null, h.positions.map(function (c) { return c.pct; }))) + " %"; },
        value: function (h) { return Math.max.apply(null, h.positions.map(function (c) { return c.pct; })); } }
    ];
    return head +
      '<div class="highlights">' +
      highlight("Blankare just nu", int(list.length) + " st", null, "", "Med minst en position på 0,5 %") +
      highlight("Positioner", int(state.shorts.cur.length) + " st", null, "", "I " + int(Object.keys(state.shorts.holdersOf).length) + " olika aktier") +
      highlight("Svenska fondbolag", swedish.length ? swedish.map(function (h) { return h.name; }).join(", ") : "Inga", null, "", swedish.length ? swedish.length + " svenska blankare" : "") +
      "</div>" +
      '<section class="block section-gap"><div class="block-head"><h2>Alla blankare</h2></div>' +
      table("holders-all", cols, list, { csv: true, sort: { col: "n", dir: -1 } }) + "</section>";
  }

  function viewHolder(key) {
    if (!needShorts()) return failed("shorts") ? errorBlock() : loadingBlock("Laddar blankning…");
    var d = state.shorts;
    var now = holdersNow().filter(function (h) { return h.key === key; })[0];
    var hasHist = needShortHistory();
    var hist = hasHist ? state.shortsHistory.rows.filter(function (r) { return r.key === key; }) : [];
    var name = now ? now.name : (hist[0] ? hist[0].holder : null);
    if (!name && hasHist) return notFound("Blankaren finns inte i registret det senaste året.");
    if (!name) return loadingBlock("Laddar historik…");
    document.title = name + " – Fondinsyn";
    var positions = now ? now.positions : [];
    // Positioner som stängts det senaste året (finns i historiken men inte bland de aktuella)
    var closed = {};
    hist.forEach(function (r) {
      if (positions.some(function (p) { return p.isin === r.isin; })) return;
      if (!closed[r.isin] || closed[r.isin].date < r.date) closed[r.isin] = r;
    });
    var closedList = Object.keys(closed).map(function (k) { return closed[k]; });

    var html = '<div class="page-head"><div class="crumbs"><a href="#/blankning">Blankning</a> / <a href="#/blankare">Blankare</a> / ' + esc(name) + "</div>" +
      "<h1>" + esc(name) + (SWEDISH_HOLDER_RE.test(name) ? ' <span class="label">Svenskt fondbolag</span>' : "") + "</h1>" +
      '<p class="meta">Offentliga blankningspositioner i svenska bolag enligt Finansinspektionen.</p></div>' +
      '<dl class="figures">' + fig("Aktier blankade nu", int(positions.length)) +
      fig("Summa", nf2.format(positions.reduce(function (s, p) { return s + p.pct; }, 0)) + " %", "av respektive bolags aktier") +
      fig("Ändringar senaste året", hasHist ? int(hist.length) : "…") + fig("Stängda senaste året", hasHist ? int(closedList.length) : "…") + "</dl>";

    html += '<section class="block section-gap"><div class="block-head"><h2>Blankar just nu</h2></div>' +
      table("holder-now-" + key, [
        { key: "s", label: "Aktie", align: "l", cls: "name", cell: function (p) { return shortStockCell(p.isin); } },
        { key: "p", label: "Position", cell: function (p) { return '<span class="short-pct">' + nf2.format(p.pct) + " %</span>"; }, value: function (p) { return p.pct; } },
        { key: "tot", label: "Totalt blankat", hideSm: true, cell: function (p) { var a = d.byIsin[p.isin]; return a ? nf2.format(a.pct) + " %" : "–"; } },
        { key: "f", label: "Fondernas nettoköp " + quarterLabel(state.q), hideSm: true, cell: function (p) { var s = shortStock(p.isin); return s && s.netFlow != null ? '<span class="' + cls(s.flow) + '">' + mkr(s.flow, true) + " mkr</span>" : "–"; } },
        { key: "d", label: "Senast ändrad", cls: "muted", hideSm: true, cell: function (p) { return p.date; }, value: function (p) { return p.date; } }
      ], positions, { sort: { col: "p", dir: -1 }, empty: "Inga positioner på minst 0,5 % just nu." }) + "</section>";

    if (!hasHist) return html + '<section class="block section-gap">' + loadingBlock("Laddar historik…") + "</section>";
    html += '<div class="grid-2 section-gap">' +
      block("Stängda positioner", "Under 0,5 % eller avslutade det senaste året", table("holder-closed-" + key, [
        { key: "s", label: "Aktie", align: "l", cls: "name", cell: function (r) { return shortStockCell(r.isin); } },
        { key: "d", label: "Stängd", cls: "muted", cell: function (r) { return r.date; } }
      ], closedList.sort(function (a, b) { return a.date < b.date ? 1 : -1; }), { static: true, empty: "Inga stängda positioner." })) +
      block("Alla ändringar", "Senaste året", table("holder-hist-" + key, [
        { key: "d", label: "Datum", align: "l", cls: "muted", cell: function (r) { return r.date; } },
        { key: "s", label: "Aktie", align: "l", cls: "name", cell: function (r) { return shortStockCell(r.isin); } },
        { key: "p", label: "Ny position", cell: function (r) { return r.pct > 0 ? nf2.format(r.pct) + " %" : '<span class="muted" title="Positionen är under 0,5 % och redovisas inte längre med namn">&lt; 0,5 %</span>'; } }
      ], hist, { static: true, limit: 100, empty: "Inga ändringar." })) + "</div>";
    return html;
  }

  // ---------- Kvartalsrapport ----------

  function managersConsensus(ds) {
    var d = quarterData(), tally = {};
    FEATURED.forEach(function (id) {
      var f = ds.fundById[id];
      if (!f || !f.both || !d.fi[id]) return;
      f.h.forEach(function (r) {
        var s = ds.stocks[r[0]], s1 = r[1] || 0, s2 = r[2] || 0;
        if (s1 === s2 || s.isNew || s.isGone) return;
        var t = tally[s.isin] = tally[s.isin] || { s: s, buyers: 0, sellers: 0 };
        if (s2 > s1) t.buyers++; else t.sellers++;
      });
    });
    return Object.keys(tally).map(function (k) { return tally[k]; });
  }

  // Gemener i löptext, men behåll förkortningar som IT
  function lcWord(s) { return s === s.toUpperCase() ? s : s.toLowerCase(); }

  function sentenceList(items, fmt) {
    var parts = items.map(fmt);
    if (parts.length <= 1) return parts.join("");
    return parts.slice(0, -1).join(", ") + " och " + parts[parts.length - 1];
  }

  // Liggande staplar kring en mittlinje (sektorer, länder). items: [{ label, v }] med v i mkr.
  function divBars(items) {
    var max = Math.max.apply(null, items.map(function (x) { return Math.abs(x.v); }).concat([1]));
    return '<ul class="divbars">' + items.map(function (x, n) {
      var w = Math.abs(x.v) / max * 50;
      return '<li style="--d:' + (n * 30) + 'ms"><span class="db-label">' + esc(x.label) + '</span><span class="db-track"><i class="' + (x.v >= 0 ? "pos" : "neg") + '" style="width:' + w.toFixed(1) +
        "%;" + (x.v >= 0 ? "left:50%" : "right:50%") + '"></i></span><span class="db-val ' + cls(x.v) + '">' + bigSek(x.v * 1e6, true) + "</span></li>";
    }).join("") + "</ul>";
  }

  // Rangordnad lista med en stapel per rad (kvartalsrapportens köp och sälj)
  function rankList(items, max) {
    return '<ol class="rank-list">' + items.map(function (s, n) {
      var w = max ? Math.max(2, Math.abs(s.flow) / max * 100) : 0;
      return '<li><span class="rk-n">' + (n + 1) + '</span><span class="rk-main"><a href="' + stockHref(s) + '">' + esc(s.name) + '</a><span class="rk-sub">' +
        int(s.f2) + " fonder äger" + (s.chg != null ? " · antalet aktier " + pct(s.chg) : "") + "</span></span>" +
        '<span class="rk-bar ' + cls(s.flow) + '"><i style="width:' + w.toFixed(1) + '%"></i></span><span class="rk-v ' + cls(s.flow) + '">' + bigSek(s.flow, true) + "</span></li>";
    }).join("") + "</ol>";
  }

  // Blankningen ett visst datum ur veckoserierna i data/shorts.json (offentliga positioner, minst 0,5 %)
  function shortAtDate(sh, isin, date) {
    var i = -1;
    for (var k = 0; k < sh.weeks.length && sh.weeks[k] <= date; k++) i = k;
    if (i < 0) return null;
    var v = 0;
    (sh.series[isin] || []).forEach(function (x) { if (x[0] <= i) v = x[1]; });
    return v;
  }
  // Kvartalsrapportens avsnitt om blankning: hur blankningen ändrades mellan kvartalets första och sista dag
  function repShorts(m, buys) {
    var sh = state.shorts;
    if (!sh || !sh.weeks || !sh.series || !sh.weeks.length || sh.weeks[0] > m.prev) return null;
    var rows = Object.keys(sh.series).map(function (isin) {
      var a = shortAtDate(sh, isin, m.prev), b = shortAtDate(sh, isin, m.curr);
      return { isin: isin, name: (sh.names || {})[isin] || isin, a: a, b: b, d: b - a };
    }).filter(function (r) { return r.a != null && r.b != null && (r.a > 0 || r.b > 0); });
    if (rows.length < 5) return null;
    var up = rows.filter(function (r) { return r.d >= 0.1; }).sort(function (x, y) { return y.d - x.d; }).slice(0, 6);
    var down = rows.filter(function (r) { return r.d <= -0.1; }).sort(function (x, y) { return x.d - y.d; }).slice(0, 6);
    var most = rows.slice().sort(function (x, y) { return y.b - x.b; });
    var pp = function (v) { return signed(nf1.format(v), v) + " p.e."; };
    var max = Math.max.apply(null, up.concat(down).map(function (r) { return Math.abs(r.d); }).concat([0.1]));
    var list = function (items) {
      return '<ol class="rank-list">' + items.map(function (r, n) {
        var s = shortStock(r.isin);
        return '<li><span class="rk-n">' + (n + 1) + '</span><span class="rk-main">' + (s ? '<a href="' + stockHref(s) + '">' + esc(s.name) + "</a>" : "<span>" + esc(prettyName(r.name)) + "</span>") +
          '<span class="rk-sub">från ' + nf2.format(r.a) + " % till " + nf2.format(r.b) + " % av aktierna</span></span>" +
          '<span class="rk-bar ' + cls(r.d) + '"><i style="width:' + Math.max(2, Math.abs(r.d) / max * 100).toFixed(1) + '%"></i></span><span class="rk-v ' + cls(r.d) + '">' + pp(r.d) + "</span></li>";
      }).join("") + "</ol>";
    };
    var name = function (r) { var s = shortStock(r.isin); return esc(s ? s.name : prettyName(r.name)); };
    // Fonderna köpte, samtidigt som blankarna satsade mer på att kursen skulle falla
    var byIsin = {};
    rows.forEach(function (r) { byIsin[r.isin] = r; });
    var against = buys.slice(0, 25).filter(function (s) { var r = byIsin[s.isin]; return r && r.d >= 0.3; }).slice(0, 3);
    var text = "Vid kvartalets slut var " + name(most[0]) + " mest blankad, med <b>" + nf2.format(most[0].b) + " %</b> av aktierna" +
      (most[1] ? ", följt av " + name(most[1]) + " (" + nf2.format(most[1].b) + " %)" : "") + "." +
      (against.length ? " Fonderna köpte " + sentenceList(against, function (s) { return esc(s.name) + " (blankningen " + pp(byIsin[s.isin].d) + ")"; }) +
        ", samtidigt som blankarna satsade mer på att kursen skulle falla." : "") +
      " Blankning är lånade aktier som sålts i hopp om att köpa tillbaka dem billigare. Siffrorna är de positioner som måste offentliggöras (minst 0,5 %).";
    return { text: text, html: '<div class="grid-2"><div class="rep-col"><h3>Blankningen ökade mest</h3>' + (up.length ? list(up) : '<p class="desc">Ingen ökade.</p>') + "</div>" +
      '<div class="rep-col"><h3>Blankningen minskade mest</h3>' + (down.length ? list(down) : '<p class="desc">Ingen minskade.</p>') + "</div></div>" };
  }
  // Uppköpen som FI godkände under kvartalet, med premien och hur mycket fonderna ägde i bolagen
  function repOffers(m) {
    var bids = state.offers.offers.filter(function (o) { return o.date > m.prev && o.date <= m.curr; });
    if (!bids.length) return null;
    var owned = function (o) { return o.held || 0; };
    var withPrem = bids.filter(function (o) { return o.premium != null; });
    var avg = withPrem.length ? withPrem.reduce(function (a, o) { return a + o.premium; }, 0) / withPrem.length : null;
    var total = bids.reduce(function (a, o) { return a + owned(o); }, 0);
    var text = "Finansinspektionen godkände " + bids.length + (bids.length === 1 ? " erbjudandehandling" : " erbjudandehandlingar") + " under kvartalet." +
      (avg != null ? " Budpremien var i snitt <b>" + nf0.format(avg) + " %</b> över kursen före budet." : "") +
      (total > 0 ? " Fonderna ägde aktier för sammanlagt " + bigSek(total) + " i bolagen som blev uppköpta." : "");
    var rowsHtml = bids.sort(function (a, b) { return owned(b) - owned(a); }).slice(0, 10).map(function (o) {
      var f = (o.holders || []).length;
      return "<tr><td class=\"l name\"><a href=\"#/uppkop/" + encodeURIComponent(o.id) + "\">" + esc(o.name || o.target) + '</a><span class="sub">' + esc(o.bidder) + "</span></td>" +
        '<td class="num">' + (o.premium != null ? '<span class="pos">+' + nf0.format(o.premium) + " %</span>" : "–") + "</td>" +
        '<td class="num">' + (f ? int(f) : "–") + '</td><td class="num">' + (owned(o) ? bigSek(owned(o)) : "–") + "</td></tr>";
    }).join("");
    return { text: text, html: '<div class="table-wrap rep-table"><table><thead><tr><th class="l">Bolag och budgivare</th><th class="num">Premie</th><th class="num">Fonder</th>' +
      '<th class="num">Fondernas innehav</th></tr></thead><tbody>' + rowsHtml + "</tbody></table></div>" };
  }
  // Fondsparandet under kvartalets tre månader (Fondbolagens förening, data/flows.json)
  function repSavings(m) {
    var D = state.flows;
    if (!D || !D.months || !D.types || !D.types.TOTALT) return null;
    var from = m.prev.slice(0, 7), to = m.curr.slice(0, 7);
    var idx = [];
    D.months.forEach(function (mo, i) { if (mo > from && mo <= to) idx.push(i); });
    if (idx.length !== 3 || idx.some(function (i) { return !D.types.TOTALT[i]; })) return null;
    var sum = function (name) {
      var ser = D.types[name] || (D.focus || {})[name];
      if (!ser) return null;
      return idx.reduce(function (a, i) { return a + (ser[i] ? ser[i][0] : 0); }, 0);
    };
    var types = ["Aktiefonder", "Blandfonder", "Långa räntefonder", "Korta räntefonder", "Företagsobligationsfonder", "Generationsfonder", "Hedgefonder", "Övriga fonder"]
      .map(function (t) { return { label: t, v: sum(t) }; }).filter(function (x) { return x.v != null; }).sort(function (a, b) { return b.v - a.v; });
    var tot = sum("TOTALT"), idxF = sum("varav indexfonder");
    var outT = types.filter(function (x) { return x.v < 0; });
    var text = "Svenskarna satte " + (tot >= 0 ? "in" : "ut") + " netto <b>" + bigSek(Math.abs(tot) * 1e6) + "</b> i fonder under " + monthLabel(D.months[idx[0]]).replace(/ \d{4}$/, "") + "–" +
      monthLabel(D.months[idx[2]]) + "." + (types[0] && types[0].v > 0 ? " Mest pengar gick till " + lcWord(types[0].label) + " (" + bigSek(types[0].v * 1e6, true) + ")" : "") +
      (outT.length ? ", mest togs ut ur " + lcWord(outT[outT.length - 1].label) + " (" + bigSek(outT[outT.length - 1].v * 1e6, true) + ")" : "") + "." +
      (idxF != null ? " Indexfonderna för aktier fick " + bigSek(idxF * 1e6, true) + "." : "") + " Källa: Fondbolagens förening.";
    return { text: text, html: divBars(types) };
  }

  function repSection(n, title, desc, inner) {
    return '<section class="rep-section section-gap"><div class="rep-head"><span class="rep-num">' + (n < 10 ? "0" : "") + n + "</span><div><h2>" + title + "</h2>" +
      (desc ? '<p class="desc">' + desc + "</p>" : "") + "</div></div>" + inner + "</section>";
  }

  function viewReport(q) {
    // /rapport/2025-q4/ visar det kvartalet utan att ändra vilket kvartal som är valt nästa gång
    if (q) q = q.toUpperCase().replace("-", "");
    if (q && q !== state.q && state.index.quarters.some(function (x) { return x.id === q; })) {
      setTimeout(function () { selectQuarter(q, true); }, 0);
      return loadingBlock();
    }
    // Rapporten följer marknadsvalet (Sverige/Globalt), som också kan bytas direkt i rapporten.
    // Blankning, uppköp och köpsviter finns bara för svenska aktier.
    var world = state.market === "world";
    var d = quarterData(), m = d.meta, ds = marketDs();
    if (!ds) return failed("world-" + state.q) ? errorBlock() : loadingBlock("Laddar globala aktier…");
    // Rapporten säger "globala aktier" om de utländska
    var word = world ? "globala" : "svenska", Word = world ? "Globala aktier" : "Svenska aktier";
    var hasHist = needHistory(world ? "world" : "se"), hasOffers = !world && needOffers();
    var cont = ds.stocks.filter(function (s) { return s.price && !s.isNew && !s.isGone; });
    var buys = cont.filter(function (s) { return s.flow > 0; }).sort(function (a, b) { return b.flow - a.flow; });
    var sells = cont.filter(function (s) { return s.flow < 0; }).sort(function (a, b) { return a.flow - b.flow; });
    var news = cont.filter(function (s) { return s.nNew > 0; }).sort(function (a, b) { return b.nNew - a.nNew; });
    var t = ds.totals, net = t.buy + t.sell;
    document.title = "Kvartalsrapport " + quarterLabel(state.q) + ", " + Word.toLowerCase() + " – Fondinsyn";

    // Sektorer (och länder för utländska aktier) summeras ur kvartalets nettoköp
    var sum = function (keyFn) {
      var by = {};
      cont.forEach(function (s) { var k = keyFn(s); if (k) by[k] = (by[k] || 0) + s.flow; });
      return Object.keys(by).map(function (k) { return { s: k, v: by[k] / 1e6 }; }).sort(function (a, b) { return b.v - a.v; });
    };
    var sectors = sum(function (s) { return s.sector !== "Övrigt" ? s.sector : null; });
    var countries = world ? sum(function (s) { return s.country || null; }) : [];
    var headline = quarterHeadline(cont, buys, sells);
    var link = function (s) { return '<a href="' + stockHref(s) + '">' + esc(s.name) + "</a>"; };

    var lead = "Svenska fonder " + (net >= 0 ? "nettoköpte" : "nettosålde") + " " + word + " aktier för <b>" + bigSek(Math.abs(net)) + "</b> under " + quarterLabel(state.q) + "." +
      (buys.length ? " Mest köpte de " + sentenceList(buys.slice(0, 3), link) + "." : "") +
      (sells.length ? " Mest såldes " + sentenceList(sells.slice(0, 3), link) + "." : "");

    var mbtn = function (v, label) { return '<button type="button" class="seg-btn" data-market="' + v + '" aria-pressed="' + (state.market === v) + '">' + label + "</button>"; };
    var stat = function (value, label) { return '<div><dt>' + label + '</dt><dd class="count">' + value + "</dd></div>"; };
    var head = '<header class="hero rep-hero"><div class="hero-text">' +
      '<div class="crumbs"><a href="/rapport/">Kvartalsrapporter</a> / ' + quarterLabel(state.q) + "</div>" +
      '<div class="rep-tools"><div class="seg rep-market" role="group" aria-label="Rapport för">' + mbtn("se", "Svenska aktier") + mbtn("world", "Globala aktier") + "</div>" +
      (hasPdf(state.q, world) ? '<a class="rep-pdf" href="' + pdfHref(state.q, world) + '" target="_blank" rel="noopener">PDF</a>' : "") + "</div>" +
      '<p class="kicker">Kvartalsrapport ' + quarterLabel(state.q) + " · " + Word + "</p>" +
      "<h1>" + esc(headline) + "</h1>" +
      '<p class="intro">' + lead + "</p>" +
      '<p class="hero-sub">Jämförelsen gäller ' + int(t.funds) + " fonder som rapporterade sina innehav till Finansinspektionen både " + quarterLabel(m.prevId) +
      " och " + quarterLabel(state.q) + " (den " + dateText(m.curr) + ")" + (state.excludeIndex ? ", utan indexfonder" : "") + ".</p></div>" +
      '<div class="hero-side">' + heroFigure(net) + '<dl class="hero-stats">' + stat(int(t.funds), "fonder jämförs") + stat(int(t.held), word + " aktier") +
      stat(t.value >= 1e11 ? nf0.format(t.value / 1e9) + " mdkr" : bigSek(t.value), "fondernas innehav") + "</dl></div></header>";

    // I korthet
    var facts = [];
    if (buys[0]) facts.push(highlight("Mest köpt", buys[0].name, stockHref(buys[0]), '<span class="pos">' + bigSek(buys[0].flow, true) + "</span>", int(buys[0].nNew) + " nya fondägare"));
    if (sells[0]) facts.push(highlight("Mest sålt", sells[0].name, stockHref(sells[0]), '<span class="neg">' + bigSek(sells[0].flow, true) + "</span>", nFunds(sells[0].nExit) + " sålde allt"));
    if (sectors[0]) facts.push(highlight("Populäraste sektorn", sectors[0].s, null, '<span class="' + cls(sectors[0].v) + '">' + bigSek(sectors[0].v * 1e6, true) + "</span>",
      sectors.length > 1 ? "Minst populär: " + esc(lcWord(sectors[sectors.length - 1].s)) : ""));
    if (world && countries[0]) facts.push(highlight("Populäraste landet", countryName(countries[0].s), null, '<span class="' + cls(countries[0].v) + '">' + bigSek(countries[0].v * 1e6, true) + "</span>", ""));
    else if (news[0]) facts.push(highlight("Flest nya ägare", news[0].name, stockHref(news[0]), "+" + news[0].nNew + " fonder", "köpte in sig för första gången"));

    var n = 0, out = [];
    var maxFlow = Math.max(buys[0] ? buys[0].flow : 0, sells[0] ? -sells[0].flow : 0);
    out.push(repSection(++n, "Köp och sälj", "Nettoköp per aktie: förändringen i antal aktier gånger kursen vid kvartalets slut. " + termLink("nettokop", "Hur räknas det?"),
      '<div class="grid-2"><div class="rep-col"><h3>Mest köpta</h3>' + rankList(buys.slice(0, 8), maxFlow) + "</div>" +
      '<div class="rep-col"><h3>Mest sålda</h3>' + rankList(sells.slice(0, 8), maxFlow) + "</div></div>" +
      '<a class="more" href="#/aktier">Alla ' + word + " aktier</a>"));

    if (sectors.length) {
      var neg = sectors.filter(function (x) { return x.v < 0; }).sort(function (a, b) { return a.v - b.v; });
      var secText = esc(sectors[0].s) + " drog till sig mest pengar" + (sectors[1] ? ", följt av " + esc(lcWord(sectors[1].s)) : "") + "." +
        (neg.length ? " Mest sålde fonderna " + sentenceList(neg.slice(0, 2), function (x) { return esc(lcWord(x.s)); }) + "." : "");
      out.push(repSection(++n, "Sektorer", secText, divBars(sectors.map(function (x) { return { label: x.s, v: x.v }; }))));
    }
    if (countries.length) {
      var top = countries.slice().sort(function (a, b) { return Math.abs(b.v) - Math.abs(a.v); }).slice(0, 12).sort(function (a, b) { return b.v - a.v; });
      var cPos = countries.filter(function (x) { return x.v > 0; }), cNeg = countries.filter(function (x) { return x.v < 0; }).reverse();
      out.push(repSection(++n, "Länder", (cPos.length ? "Mest pengar gick till aktier från " + sentenceList(cPos.slice(0, 3), function (x) { return esc(countryName(x.s)); }) + "." : "") +
        (cNeg.length ? " Mest sålde fonderna aktier från " + sentenceList(cNeg.slice(0, 2), function (x) { return esc(countryName(x.s)); }) + "." : "") + " De tolv länder där fonderna flyttade mest pengar.",
        divBars(top.map(function (x) { return { label: countryName(x.s), v: x.v }; }))));
    }
    var chase = hasHist ? chaseData(ds) : null;
    if (chase) out.push(repSection(++n, "Köpte fonderna vinnarna?", chase.text, chase.html));
    // Blankningen och uppköpen under kvartalet (bara svenska aktier) och fondsparandet
    var shortSec = !world && needShorts() ? repShorts(m, buys) : null;
    if (shortSec) out.push(repSection(++n, "Blankning", shortSec.text, shortSec.html));
    var offerSec = hasOffers ? repOffers(m) : null;
    if (offerSec) out.push(repSection(++n, "Uppköp", offerSec.text, offerSec.html));
    var saveSec = needFlows() ? repSavings(m) : null;
    if (saveSec) out.push(repSection(++n, "Fondsparandet", saveSec.text, saveSec.html));

    // Kortare noteringar
    var notes = [];
    var note = function (title, text, href, linkText) {
      notes.push('<section class="story"><h3>' + title + "</h3><p>" + text + "</p>" + (href ? '<a class="more" href="' + href + '">' + linkText + "</a>" : "") + "</section>");
    };
    if (hasHist) {
      var bs = streakList(ds, 1), ss = streakList(ds, -1);
      if (bs[0] || ss[0]) note("Trender",
        (bs[0] ? link(bs[0].s) + " har nu nettoköpts <b>" + bs[0].n + " kvartal i rad</b>" + (bs[1] ? ", och " + esc(bs[1].s.name) + " " + bs[1].n + " kvartal i rad" : "") + ". " : "") +
        (ss[0] ? link(ss[0].s) + " har nettosålts " + ss[0].n + " kvartal i rad." : ""), null);
    }
    if (news[0]) note("Nya favoriter", "<b>" + news[0].nNew + " fonder</b> köpte in sig i " + link(news[0]) + " för första gången" +
      (news[1] ? ", och " + news[1].nNew + " i " + esc(news[1].name) : "") + ".", null);
    var cons = managersConsensus(ds).filter(function (c) { return c.buyers > c.sellers; }).sort(function (a, b) { return (b.buyers - b.sellers) - (a.buyers - a.sellers); });
    if (cons[0]) note("Kända förvaltare", "Bland de kända aktiva fonderna var flest överens om att köpa " + link(cons[0].s) +
      " (" + cons[0].buyers + " köpte, " + cons[0].sellers + " sålde).", "#/forvaltare", "Se alla förvaltare");
    if (hasOffers && !offerSec) {
      var bids = state.offers.offers.filter(function (o) { return o.date > m.prev && o.date <= m.curr; });
      if (bids.length) note("Uppköp", bids.length + (bids.length === 1 ? " uppköpserbjudande" : " uppköpserbjudanden") + " godkändes av FI under kvartalet: " +
        sentenceList(bids.slice(0, 4), function (o) { return '<a href="#/uppkop/' + encodeURIComponent(o.id) + '">' + esc(o.name || o.bidder) + "</a>" + (o.premium != null ? " (premie " + nf1.format(o.premium) + " %)" : ""); }) +
        (bids.length > 4 ? " med flera" : "") + ".", "#/uppkop", "Alla uppköp");
    }
    if (!world && !shortSec && needShorts()) {
      var sh = state.shorts.agg.slice().sort(function (a, b) { return b.pct - a.pct; });
      var shortedBuys = buys.slice(0, 15).filter(function (s) { var a = state.shorts.byIsin[s.isin]; return a && a.pct >= 2; });
      if (sh[0]) note("Blankning", "Mest blankad just nu är " + esc(shortName(sh[0])) + " med <b>" + nf2.format(sh[0].pct) + " %</b> av aktierna." +
        (shortedBuys.length ? " Bland kvartalets mest köpta aktier är " + sentenceList(shortedBuys.slice(0, 3), function (s) { return esc(s.name) + " (" + nf2.format(state.shorts.byIsin[s.isin].pct) + " %)"; }) +
          " samtidigt kraftigt blankade." : ""), "#/blankning", "Se all blankning");
    }
    var closet = fundList().filter(function (f) { return f.ar != null && f.feeMax != null && f.aum >= 100e6 && fundCategory(f) === "closet"; });
    if (!world && closet.length) {
      var cost = closet.reduce(function (a, f) { return a + f.aum * f.feeMax / 100; }, 0);
      note("Avgifter", closet.length + " aktiefonder har låg aktiv risk men tar ut minst " + nf1.format(CLOSET_FEE) + " % i avgift, sammanlagt ungefär <b>" + bigSek(cost) + " per år</b>.", "#/avgifter", "Avgiftskollen");
    }
    if (world) note("Bara för svenska aktier", "Köpsviter, blankning, uppköp och avgiftskollen finns i rapporten för svenska aktier.", null);
    if (notes.length) out.push(repSection(++n, "Mer från kvartalet", "", '<div class="story-grid">' + notes.join("") + "</div>"));

    var url = location.href.split("#")[0] + "#/rapport";
    var pdfBtn = hasPdf(state.q, world) ? '<a class="btn" href="' + pdfHref(state.q, world) + '" target="_blank" rel="noopener">Ladda ner som PDF</a>' : "";
    var printHead = '<div class="print-only print-head"><b>Fondinsyn</b><span>Kvartalsrapport ' + quarterLabel(state.q) + " · " + Word + "</span><span>www.fondinsyn.se</span></div>";
    var printFoot = '<div class="print-only print-foot">Källa: fondbolagens innehavsrapporter till Finansinspektionen, sammanställda av Fondinsyn (www.fondinsyn.se) den ' +
      dateText(new Date().toISOString().slice(0, 10)) + ". Nettoköp är förändringen i antal aktier gånger kursen vid kvartalets slut. Inte investeringsrådgivning.</div>";
    // Omslaget i PDF:en: rubriken, de viktigaste siffrorna och vad rapporten innehåller
    var titles = out.map(function (s) { var x = /<h2>(.*?)<\/h2>/.exec(s); return x ? x[1] : null; }).filter(Boolean);
    var pcFig = function (label, value, note) { return "<div><dt>" + label + "</dt><dd>" + value + "</dd>" + (note ? "<span>" + note + "</span>" : "") + "</div>"; };
    var cover = '<section class="print-only print-cover"><div class="pc-top"><span class="pc-brand"><svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true">' +
      '<path class="bm-a" d="M17.5 2.08A14 14 0 0 1 29.92 14.5H17.5Z"/><path d="M29.92 17.5A14 14 0 0 1 17.5 29.92V17.5Z"/><path d="M14.5 29.92A14 14 0 0 1 2.08 17.5H14.5Z"/>' +
      '<path d="M2.08 14.5A14 14 0 0 1 14.5 2.08V14.5Z"/></svg>Fondinsyn</span><span>www.fondinsyn.se</span></div>' +
      '<div class="pc-main"><p class="pc-kicker">Kvartalsrapport ' + quarterLabel(state.q) + " · " + Word + '</p><h1 class="pc-title">' + esc(headline) + "</h1>" +
      '<p class="pc-lead">' + lead + "</p></div>" +
      '<dl class="pc-figs">' + pcFig("Fondernas nettoköp", bigSek(net, true), word + " aktier") + pcFig("Fonder i jämförelsen", int(t.funds), int(t.held) + " " + word + " aktier") +
      (buys[0] ? pcFig("Mest köpt", esc(shortCo(buys[0].name)), bigSek(buys[0].flow, true)) : "") +
      (sells[0] ? pcFig("Mest sålt", esc(shortCo(sells[0].name)), bigSek(sells[0].flow, true)) : "") + "</dl>" +
      '<div class="pc-toc"><h2>I rapporten</h2><ol>' + titles.map(function (x, i) { return "<li><span>" + (i < 9 ? "0" : "") + (i + 1) + "</span>" + x + "</li>"; }).join("") + "</ol></div>" +
      '<p class="pc-foot">Fondernas innehav ' + dateText(m.curr) + " jämfört med " + dateText(m.prev) + ", ur fondbolagens rapporter till Finansinspektionen. Sammanställd av Fondinsyn " +
      dateText(new Date().toISOString().slice(0, 10)) + ". Inte investeringsrådgivning.</p></section>";
    return '<article class="report">' + cover + printHead + head +
      (facts.length ? '<section class="section-gap"><h2 class="visually-hidden">I korthet</h2><div class="highlights hl-' + facts.length + '">' + facts.join("") + "</div></section>" : "") +
      out.join("") +
      '<div class="rep-share section-gap">' + pdfBtn + '<button type="button" class="btn" id="repShare" data-url="' + esc(url) + '">Kopiera länk till rapporten</button></div>' +
      newsletterBox() + printFoot + "</article>";
  }

  // ---------- Nyhetsbrev ----------

  function newsletterBox() {
    if (!NEWSLETTER) return "";
    return '<section class="newsletter section-gap"><div><h2>Få kvartalsrapporten på mejlen</h2><p class="desc">Fyra mejl per år när ny fonddata kommer. Inget annat, och du kan avsluta när du vill.</p></div>' +
      '<form class="nl-form" action="https://buttondown.com/api/emails/embed-subscribe/' + encodeURIComponent(NEWSLETTER) + '" method="post" target="_blank">' +
      '<input class="input" type="email" name="email" required placeholder="din@epost.se" aria-label="E-postadress" autocomplete="email">' +
      '<input type="hidden" name="tag" value="nyhetsbrev"><input type="hidden" name="embed" value="1"><button class="btn btn-primary" type="submit">Prenumerera</button></form></section>';
  }

  // Bevakning via mejl: Buttondown-prenumeration med etiketten a-<ISIN>. scripts/alerts.ps1 skickar mejlen.
  function alertForm(isin, name) {
    if (!NEWSLETTER) return "";
    return '<details class="alert-box"><summary>Få mejl om ' + esc(name) + "</summary>" +
      '<form class="nl-form" action="https://buttondown.com/api/emails/embed-subscribe/' + encodeURIComponent(NEWSLETTER) + '" method="post" target="_blank">' +
      '<input type="hidden" name="tag" value="a-' + esc(isin) + '"><input type="hidden" name="embed" value="1">' +
      '<input class="input" type="email" name="email" required placeholder="din@epost.se" aria-label="E-postadress" autocomplete="email"><button class="btn btn-primary" type="submit">Bevaka</button></form>' +
      '<p class="desc">Du får ett mejl när fonderna har köpt eller sålt aktien ett nytt kvartal, när insiders handlar, när blankningen ändras mycket eller när ett bud kommer. ' +
      "Bekräfta adressen via mejlet du får. Du kan avsluta när du vill.</p></details>";
  }

  // ---------- Fondbolag ----------

  function companyHref(co) { return "#/fondbolag/" + encodeURIComponent(co); }
  function companyLink(co) { return '<a href="' + companyHref(co) + '">' + esc(co) + "</a>"; }

  // Samlar alla fonder per fondbolag med nyckeltal och affärer i den valda marknaden
  function companies(ds) {
    var by = {};
    fundList().forEach(function (f) {
      var c = by[f.co] = by[f.co] || { name: f.co, funds: [], aum: 0, feeAum: 0, feeBase: 0, closet: 0, index: 0, net: 0, hasNet: false };
      c.funds.push(f);
      c.aum += f.aum || 0;
      if (f.feeMax != null && f.aum) { c.feeAum += f.aum * f.feeMax; c.feeBase += f.aum; }
      var cat = fundCategory(f);
      if (cat === "closet") c.closet++;
      if (cat === "index") c.index++;
      var m = ds && ds.fundById[f.id];
      if (m && m.both) { c.net += m.bought + m.sold; c.hasNet = true; }
    });
    return Object.keys(by).map(function (k) { var c = by[k]; c.fee = c.feeBase ? c.feeAum / c.feeBase : null; return c; });
  }

  function viewCompanies() {
    document.title = "Fondbolag – Fondinsyn";
    var ds = marketDs();
    if (!ds) return failed("world-" + state.q) ? errorBlock() : loadingBlock("Laddar…");
    var list = companies(ds);
    var cols = [
      { key: "name", label: "Fondbolag", align: "l", cls: "name", value: function (c) { return c.name; }, cell: function (c) {
        return nameCell(companyHref(c.name), c.name, int(c.funds.length) + " fonder · " + bigSek(c.aum));
      } },
      { key: "n", label: "Fonder", hideSm: true, cell: function (c) { return int(c.funds.length); }, value: function (c) { return c.funds.length; } },
      { key: "aum", label: "Förmögenhet", cell: function (c) { return bigSek(c.aum); }, value: function (c) { return c.aum; } },
      { key: "fee", label: "Snittavgift", hideSm: true, cell: function (c) { return c.fee == null ? "–" : nf2.format(c.fee) + " %"; }, value: function (c) { return c.fee; } },
      { key: "closet", label: "Indexnära", hideSm: true, cell: function (c) { return c.closet ? '<span class="label warn">' + c.closet + "</span>" : "–"; }, value: function (c) { return c.closet; } },
      { key: "net", label: "Nettoköp " + (state.market === "se" ? "sv." : "utl.") + " aktier", cell: function (c) { return c.hasNet ? '<span class="' + cls(c.net) + '">' + bigSek(c.net, true) + "</span>" : "–"; },
        value: function (c) { return c.hasNet ? c.net : null; } }
    ];
    return '<div class="page-head"><div class="crumbs"><a href="#/fonder">Fonder</a> / Fondbolag</div><h1>Fondbolag</h1><p class="meta lead">' +
      int(list.length) + " fondbolag med svenska värdepappersfonder, " + quarterLabel(state.q) + ". " +
      'Snittavgiften är viktad efter fondernas storlek. <a href="#/ordlista/indexnara">Vad betyder indexnära?</a></p></div>' +
      table("companies-" + state.market, cols, list, { csv: true, sort: { col: "aum", dir: -1 } });
  }

  function viewCompany(name) {
    var ds = marketDs();
    if (!ds) return failed("world-" + state.q) ? errorBlock() : loadingBlock("Laddar…");
    var c = companies(ds).filter(function (x) { return x.name === name; })[0];
    if (!c) return notFound("Fondbolaget finns inte i " + quarterLabel(state.q) + ".");
    document.title = c.name + " – Fondinsyn";

    // Bolagets samlade affärer per aktie
    var byStock = {};
    c.funds.forEach(function (f) {
      var m = ds.fundById[f.id];
      if (!m || !m.both) return;
      m.h.forEach(function (r) {
        var s = ds.stocks[r[0]], s1 = r[1] || 0, s2 = r[2] || 0;
        if (s1 === s2 || s.isNew || s.isGone) return;
        var e = byStock[s.isin] = byStock[s.isin] || { s: s, d: 0, n: 0 };
        e.d += (s2 - s1) * s.price; e.n++;
      });
    });
    var trades = Object.keys(byStock).map(function (k) { return byStock[k]; });
    var buys = trades.filter(function (t) { return t.d > 0; }).sort(function (a, b) { return b.d - a.d; });
    var sells = trades.filter(function (t) { return t.d < 0; }).sort(function (a, b) { return a.d - b.d; });
    // Staplarna i köp- och säljtabellen har samma skala, så att storlekarna går att jämföra mellan dem
    var maxTrade = Math.max(buys.length ? buys[0].d : 0, sells.length ? -sells[0].d : 0);
    var tradeCols = [
      { key: "s", label: "Aktie", align: "l", cls: "name", cell: function (t) { return nameCell(stockHref(t.s), t.s.name, t.n + (t.n === 1 ? " fond" : " fonder")); } },
      { key: "d", label: "Netto (mkr)", cell: function (t) {
        return '<span class="barcell"><span class="' + cls(t.d) + '">' + mkr(t.d, true) + "</span>" + bar(t.d, maxTrade, t.d >= 0 ? "pos" : "neg") + "</span>";
      } },
      { key: "n", label: "Fonder", hideSm: true, cell: function (t) { return int(t.n); } }
    ];
    var fundCols = [
      { key: "name", label: "Fond", align: "l", cls: "name", value: function (f) { return f.name; }, cell: function (f) {
        var cat = fundCategory(f);
        return nameCell(fundHref(f), f.name, bigSek(f.aum) + " · " + feeText(f)) +
          (cat === "closet" ? ' <span class="label warn hide-sm">Indexnära</span>' : cat === "index" && !/index/i.test(f.name) ? ' <span class="label hide-sm">Index</span>' : "");
      } },
      { key: "aum", label: "Förmögenhet", hideSm: true, cell: function (f) { return bigSek(f.aum); }, value: function (f) { return f.aum; } },
      { key: "fee", label: "Avgift", hideSm: true, cell: function (f) { return feeText(f); }, value: function (f) { return f.feeMax; } },
      { key: "ar", label: "Aktiv risk", hideSm: true, cell: function (f) { return pctPlain(f.ar); }, value: function (f) { return f.ar; } },
      { key: "net", label: "Netto (mkr)", cell: function (f) { var m = ds.fundById[f.id]; return m && m.both ? '<span class="' + cls(m.bought + m.sold) + '">' + mkr(m.bought + m.sold, true) + "</span>" : "–"; },
        value: function (f) { var m = ds.fundById[f.id]; return m && m.both ? m.bought + m.sold : null; } }
    ];
    // Om fondbolaget också blankar (finns i blankningsregistret)
    var shortNote = "";
    if (state.shorts) {
      var key = normHolder(c.name), h = holdersNow().filter(function (x) { return x.key === key || x.key.indexOf(key) === 0 || key.indexOf(x.key) === 0; })[0];
      if (h) shortNote = '<p class="notice">' + esc(c.name) + " blankar också aktier: " + h.positions.length + ' positioner just nu. <a href="' + holderHref(h.name) + '">Se blankningarna</a></p>';
    } else needShorts();

    return '<div class="page-head"><div class="crumbs"><a href="#/fonder">Fonder</a> / <a href="#/fondbolag">Fondbolag</a> / ' + esc(c.name) + '</div><div class="title-row"><div class="title-main">' + avatar(c.name) + '<h1>' + esc(c.name) + '</h1></div><div class="actions">' + shareBtn("fondbolag", c.name) + "</div></div>" +
      '<p class="meta">' + quarterLabel(state.q) + " jämfört med " + quarterLabel(quarterData().meta.prevId) + ". Affärerna avser " + marketWord() + " aktier.</p></div>" +
      '<dl class="figures">' + fig("Fonder", int(c.funds.length)) + fig("Förvaltat kapital", bigSek(c.aum)) +
      fig("Snittavgift", c.fee == null ? "–" : nf2.format(c.fee) + " %", "viktad efter storlek") +
      fig("Indexnära med hög avgift", int(c.closet)) + fig("Indexfonder", int(c.index)) +
      fig("Nettoköp", c.hasNet ? '<span class="' + cls(c.net) + '">' + bigSek(c.net, true) + "</span>" : "–", marketWord() + " aktier") + "</dl>" + shortNote +
      '<div class="grid-2 section-gap">' +
      block("Köpte mest", "Summerat över bolagets alla fonder", table("co-buy", tradeCols, buys, { static: true, limit: 10, expand: true, empty: "Inga köp." })) +
      block("Sålde mest", "Samma kvartal, alla fonder", table("co-sell", tradeCols, sells, { static: true, limit: 10, expand: true, empty: "Inga sälj." })) + "</div>" +
      '<section class="block section-gap"><div class="block-head"><h2>Bolagets fonder</h2></div>' +
      table("co-funds-" + state.market, fundCols, c.funds, { sort: { col: "aum", dir: -1 } }) + "</section>";
  }

  // ---------- Ordlista och vanliga frågor ----------

  // Ordlistan och vanliga frågor ligger i data/glossary.json, som också bygger sidorna under /ordlista/
  var GLOSSARY = [], FAQ = [];
  function needGlossary() {
    return need("glossary", function () {
      return getJSON("data/glossary.json").then(function (g) { GLOSSARY = g.terms; FAQ = g.faq; });
    });
  }

  function termLink(slug, text) { return '<a class="term" href="#/ordlista/' + slug + '" title="Vad betyder det?">' + text + "</a>"; }

  function viewGlossary(slug) {
    document.title = "Vanliga frågor och ordlista – Fondinsyn";
    if (!needGlossary()) return failed("glossary") ? errorBlock() : loadingBlock();
    var terms = GLOSSARY.slice().sort(function (a, b) { return a[1].localeCompare(b[1], "sv"); });
    var term = terms.filter(function (t) { return t[0] === slug; })[0];
    if (term) document.title = term[1] + " – vad betyder det? – Fondinsyn";
    var html = '<div class="page-head"><h1>Vanliga frågor och ordlista</h1><p class="meta lead">Svar på vanliga frågor och förklaringar av begreppen på Fondinsyn.</p></div>' +
      '<div class="faq">' + FAQ.map(function (q) {
        return "<details><summary>" + esc(q[0]) + "</summary><p>" + esc(q[1]) + "</p></details>";
      }).join("") + "</div>" +
      '<h2 class="section-title">Ordlista</h2>' +
      '<div class="glossary-index">' + terms.map(function (t) { return '<a href="#/ordlista/' + t[0] + '">' + esc(t[1]) + "</a>"; }).join("") + "</div>" +
      '<dl class="glossary">' + terms.map(function (t) {
        return '<div class="g-item' + (t[0] === slug ? " g-active" : "") + '" id="term-' + t[0] + '"><dt>' + esc(t[1]) + "</dt><dd>" + esc(t[2]) + ' <a href="/ordlista/' + t[0] + '/">Exempel ur datan</a></dd></div>';
      }).join("") + "</dl>";
    if (slug) setTimeout(function () { var el = $("term-" + slug); if (el) el.scrollIntoView({ block: "center" }); }, 0);
    return html;
  }

  // ---------- Om och kontakt ----------

  function viewAbout() {
    document.title = "Om datan – Fondinsyn";
    var m = quarterData().meta;
    return '<div class="page-head"><h1>Om datan</h1></div><div class="prose">' +
      "<p>Svenska fondbolag rapporterar varje kvartal sina fonders innehav till Finansinspektionen, som publicerar uppgifterna öppet. Fondinsyn jämför kvartalen och visar vilka aktier fonderna har köpt och sålt.</p>" +
      "<h2>Så räknas det</h2><ul>" +
      "<li><b>Nettoköp</b> är förändringen i antal aktier multiplicerad med kursen vid det senaste kvartalsslutet. Kursrörelser påverkar alltså inte siffran.</li>" +
      "<li>Förändringar räknas bara för fonder som rapporterat <b>båda</b> kvartalen.</li>" +
      "<li>Aktier som ingen fond ägde förra kvartalet, eller som ingen fond äger längre, redovisas separat. Det beror nästan alltid på noteringar, avknoppningar, uppköp eller byte av aktieslag.</li>" +
      "<li>Vid aktiesplit justeras förra kvartalets antal. Splitten känns igen på att fondernas antal aktier ändrats med samma kvot samtidigt som kursen rört sig lika mycket åt andra hållet.</li>" +
      "<li>Indexfonder identifieras på namnet. Deras affärer speglar oftast in- och utflöden i fonden snarare än aktiva beslut.</li>" +
      "<li><b>Köpsviter</b> räknas på historiken sedan 2018. Kvartal med nettoköp under 0,5 mkr räknas inte.</li>" +
      "<li>Globala aktier (aktier noterade utanför Sverige) visas om svenska fonder sammanlagt äger minst 20 mkr.</li>" +
      '<li><b>Räntepapper</b> (obligationer och certifikat) och <b>fondandelar</b> visas på fondsidan och under <a href="#/rantor">Räntor</a>. Emittenten läses ur värdepapperets namn, ' +
      "och papper som förfallit räknas inte som sålda. Marknadsräntorna kommer från Riksbanken.</li></ul>" +
      '<p class="desc">Fondinsyn räknar antalet besök med GoatCounter, som inte använder kakor och inte sparar några personuppgifter.</p>' +
      "<h2>Uppdatering</h2><p>Allt hämtas automatiskt varje morgon. Insynshandel och blankning ändras dagligen, fondsparandet varje månad och fondinnehaven en gång per kvartal. Finansinspektionen publicerar kvartalets innehav ungefär tolv veckor efter kvartalsslut, utan fast datum. FI publicerar ibland om äldre kvartal med rättelser, och de hämtas också automatiskt. Alla detaljer finns i <a href='#/metod'>metodrapporten</a>.</p>" +
      (m && m.src ? "<p>Källfiler för " + quarterLabel(state.q) + ": <code>" + esc(m.src[0]) + "</code> och <code>" + esc(m.src[1]) + "</code>.</p>" : "") +
      '<h2>Källa</h2><p><a href="https://www.fi.se/sv/vara-register/fondinnehav/fondinnehav-per-kvartal/" target="_blank" rel="noopener">Finansinspektionen – Fondinnehav per kvartal</a></p>' +
      "<p>Informationen på sidan är inte investeringsrådgivning.</p></div>";
  }

  // Okända adresser (och 404.html) får en egen sida med vägar vidare i stället för översikten
  function viewNotFound() {
    document.title = "Sidan finns inte – Fondinsyn";
    return '<div class="page-head" data-notfound><h1>Sidan finns inte</h1><p class="meta lead">Adressen kan vara felstavad, eller så har aktien eller fonden bytt namn. ' +
      "Sök efter den i sökrutan överst, eller börja här:</p></div>" + quickLinks(marketDs() || quarterData().se);
  }

  function viewContact() {
    document.title = "Kontakt – Fondinsyn";
    return '<div class="page-head"><h1>Kontakt</h1></div><div class="prose">' +
      "<p>Har du frågor, hittat ett fel i datan eller idéer på vad som borde finnas på sajten? Hör gärna av dig.</p>" +
      '<div class="contact-card"><span class="contact-label">E-post</span>' +
      '<a class="contact-mail" href="mailto:' + CONTACT + '">' + CONTACT + "</a>" +
      '<button type="button" class="btn" id="copyMail">Kopiera</button></div>' +
      '<p class="byline">Fondinsyn är byggd och drivs av <b>Axel Bergsten</b>.</p></div>';
  }

  function selectText(node) {
    var range = document.createRange();
    range.selectNodeContents(node);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ---------- Räntor ----------
  // data/<kvartal>-rates.json (scripts/build-rates.ps1): emittenter, kategorier, löptider och nyckeltal per fond.
  // data/rf/<fond>.json och data/re/<emittent>.json delas upp av scripts/build-pages.ps1.
  // data/rates-market.json: Riksbankens marknadsräntor, uppdateras varje dag.

  // Ordningen i filen (kategorivärden per fond) och ordningen på sajten (största först)
  var BUILD_CATS = ["stat", "kommun", "bostad", "bank", "fastighet", "foretag", "utland"];
  var RATE_CATS = [
    ["bostad", "Bostadsobligationer", "Säkerställda obligationer från bankernas bolåneinstitut, till exempel Stadshypotek och Swedbank Hypotek."],
    ["stat", "Svenska staten", "Statsobligationer och statsskuldväxlar."],
    ["kommun", "Kommuner och regioner", "Kommuninvest, kommuner och regioner, även i Norge och Finland."],
    ["bank", "Banker", "Bankernas vanliga och efterställda obligationer."],
    ["fastighet", "Fastighetsbolag", "Obligationer och certifikat från fastighetsbolag."],
    ["foretag", "Övriga företag", "Industri, energi, konsument och andra bolag."],
    ["utland", "Utländska stater och utvecklingsbanker", "Till exempel Världsbanken, Europeiska investeringsbanken och andra länders stater."]
  ];
  var CAT_LABEL = {};
  RATE_CATS.forEach(function (c) { CAT_LABEL[c[0]] = c[1]; });
  var MAT_LABELS = ["Under 1 år", "1–3 år", "3–5 år", "5–10 år", "Över 10 år", "Okänd"];
  var RATE_SERIES = [
    ["SECBREPOEFF", "Styrränta", "s-ink"], ["SEGVB2YC", "Statsobligation 2 år", "s2"],
    ["SEGVB10YC", "Statsobligation 10 år", "s3"], ["SEMB5YCACOMB", "Bostadsobligation 5 år", "s1"]
  ];
  var rateState = { range: 5, q: "", cat: "" };

  function needRates(q) {
    q = q || state.q;
    return need("rates-" + q, function () {
      return getJSON("data/" + q + "-rates.json").then(function (raw) {
        var r = { meta: raw.meta, maturity: raw.maturity, cats: {}, issuers: [], byKey: {}, funds: {},
          totals: { v1: raw.totals[0], v2: raw.totals[1], flow: raw.totals[2], matured: raw.totals[3] } };
        raw.cats.forEach(function (c) { r.cats[c[0]] = { v1: c[1], v2: c[2], flow: c[3] }; });
        raw.issuers.forEach(function (x) {
          var o = { key: x[0], name: x[1], cat: x[2], sector: x[3], country: x[4], v1: x[5], v2: x[6], flow: x[7], matured: x[8], f1: x[9], f2: x[10], n: x[11] };
          r.issuers.push(o); r.byKey[o.key] = o;
        });
        raw.funds.forEach(function (x) {
          var cats = {};
          BUILD_CATS.forEach(function (c, i) { cats[c] = x[6][i] || 0; });
          r.funds[x[0]] = { id: x[0], bond: x[1], unit: x[2], cash: x[3], float: x[4], years: x[5], cats: cats, n: x[7], flow: x[8], unitFlow: x[9], eq: x[10] };
        });
        // Aktieandelen i kvartalsfilen var tidigare avrundad till 0 eller 1. Räntefilen har den riktiga andelen.
        var fi = state.data[q] && state.data[q].fi;
        if (fi) Object.keys(r.funds).forEach(function (id) { if (fi[id] && r.funds[id].eq != null) fi[id].eq = r.funds[id].eq; });
        (state.data[q] = state.data[q] || {}).rates = r;
      });
    });
  }
  function ratesData() { var d = quarterData(); return d && d.rates; }
  function needMarketRates() {
    return need("rates-market", function () {
      return getJSON("data/rates-market.json").then(function (m) {
        Object.keys(m.series).forEach(function (k) { m.series[k].points = m.series[k].points.map(function (p) { return { d: p[0], v: p[1] }; }); });
        state.market_rates = m;
      });
    });
  }
  // En fonds räntepapper och fondandelar (data/rf/<id>.json), per kvartal
  function needFundRates(id) {
    return need("rf-" + id, function () {
      return getJSON("data/rf/" + encodeURIComponent(id) + ".json").then(function (x) { (state.fundRates = state.fundRates || {})[id] = x; });
    });
  }
  function needIssuer(key) {
    return need("re-" + key, function () {
      return getJSON("data/re/" + encodeURIComponent(key) + ".json").then(function (x) { (state.issuerData = state.issuerData || {})[key] = x; });
    });
  }

  // Aktie-, ränte-, bland- eller fondandelsfond utifrån vad fonden äger enligt FI
  function fundKind(f) {
    var r = ratesData(), x = r && r.funds[f.id], aum = f.aum || 0;
    var eq = f.eq || 0, b = x && aum ? x.bond / aum : 0, u = x && aum ? x.unit / aum : 0;
    if (u >= 0.5) return "fof";
    if (b >= 0.5) return "rante";
    if (eq >= 0.6) return "equity";
    if (eq >= 0.1 && (b >= 0.1 || u >= 0.1) && eq + b + u >= 0.5) return "bland";
    if (eq >= 0.4) return "equity";
    return "other";
  }
  var KIND_LABEL = { equity: "Aktiefond", rante: "Räntefond", bland: "Blandfond", fof: "Fondandelsfond", other: "Övrig fond" };

  function issuerHref(key) { return "#/emittent/" + encodeURIComponent(key); }
  function catName(c) { return '<span class="cat-name"><span class="cat-dot cat-' + c + '" aria-hidden="true"></span>' + esc(CAT_LABEL[c] || c) + "</span>"; }
  function share(v, total) { return total ? nf1.format(v / total * 100) + " %" : "–"; }
  function ratePct(v) { return v == null ? "–" : nf2.format(v) + " %"; }
  function ppChange(v) { return v == null ? "" : signed(nf2.format(v), v) + " procentenheter"; }
  function yearsText(y) { return y == null ? "–" : nf1.format(y) + " år"; }
  function matText(m) { return !m ? "–" : m === "perp" ? "Evig" : m.slice(0, 4) === "20" && m.slice(5) === "12-31" ? m.slice(0, 4) : m; }
  function floatText(f) { return f === 1 ? "Rörlig" : f === 0 ? "Fast" : "–"; }

  // Fördelning som liggande stapel med förklaring (kategori, värde, andel)
  function catBreakdown(vals, total, opts) {
    opts = opts || {};
    var list = RATE_CATS.filter(function (c) { return vals[c[0]] > 0; });
    if (!total || !list.length) return '<p class="desc">Inga räntepapper.</p>';
    return '<div class="seg-stack" role="img" aria-label="Fördelning per emittentkategori">' + list.map(function (c) {
      return '<i class="cat-' + c[0] + '" style="flex:' + (vals[c[0]] / total).toFixed(4) + '" title="' + esc(c[1]) + " " + share(vals[c[0]], total) + '"></i>';
    }).join("") + '</div><ul class="cat-list">' + list.map(function (c) {
      var flow = opts.flows ? opts.flows[c[0]] : null;
      return '<li><span class="cat-dot cat-' + c[0] + '" aria-hidden="true"></span><span class="n">' + esc(c[1]) + '</span><span class="p">' + share(vals[c[0]], total) + "</span>" +
        '<span class="v">' + bigSek(vals[c[0]]) + (flow != null ? ' · <span class="' + cls(flow) + '">' + bigSek(flow, true) + "</span>" : "") + "</span></li>";
    }).join("") + "</ul>";
  }
  function maturityBars(vals) {
    var max = Math.max.apply(null, vals.concat([1])), total = vals.reduce(function (a, b) { return a + b; }, 0);
    return '<div class="mat-bars">' + vals.map(function (v, i) {
      return '<div class="mat-bar' + (i === 5 ? " unknown" : "") + '" title="' + esc(MAT_LABELS[i]) + ": " + bigSek(v) + '"><b>' + share(v, total) + '</b><i style="height:' +
        (v / max * 100).toFixed(1) + '%"></i><span>' + MAT_LABELS[i] + "</span></div>";
    }).join("") + "</div>";
  }

  function viewRates() {
    document.title = "Räntor och räntefonder – Fondinsyn";
    var head = '<div class="page-head"><h1>Räntor</h1><p class="meta lead">Marknadsräntorna från Riksbanken och vad svenska fonder äger för räntepapper: ' +
      "statsobligationer, bostadsobligationer, bankers och företags obligationer. Fondernas innehav kommer från Finansinspektionen varje kvartal.</p></div>";
    var hasMarket = needMarketRates(), hasRates = needRates();
    var html = head;
    // Nyckeltal
    var m = state.market_rates, r = ratesData();
    var last = function (id) { var s = m && m.series[id]; return s ? s.points[s.points.length - 1] : null; };
    var yearAgo = function (id) {
      var s = m && m.series[id]; if (!s) return null;
      var lp = s.points[s.points.length - 1], t = Date.parse(lp.d) - 365 * 864e5, best = null;
      s.points.forEach(function (p) { if (Date.parse(p.d) <= t) best = p; });
      return best ? lp.v - best.v : null;
    };
    var figs = [];
    if (hasMarket && m) {
      var pr = last("SECBREPOEFF"), g10 = last("SEGVB10YC"), mb5 = last("SEMB5YCACOMB");
      var prNext = pr ? policyNext(m.next, pr.v) : null;
      if (pr) figs.push(fig(termLink("styrranta", "Styrränta"), ratePct(pr.v), prNext ? '<a href="' + esc(prNext.url) + '" target="_blank" rel="noopener">' +
        capFirst(policyNextText(prNext, pr.v)) + "</a>, beslutat " + dateText(prNext.date).replace(/ \d{4}$/, "") : "Riksbanken, " + dateText(pr.d)));
      if (g10) figs.push(fig("Statsobligation 10 år", ratePct(g10.v), ppChange(yearAgo("SEGVB10YC")) + " på ett år"));
      if (mb5) figs.push(fig(termLink("bostadsobligation", "Bostadsobligation 5 år"), ratePct(mb5.v), ppChange(yearAgo("SEMB5YCACOMB")) + " på ett år"));
    }
    if (hasRates && r) {
      figs.push(fig("Fondernas räntepapper", bigSek(r.totals.v2), quarterLabel(state.q) + ", " + termLink("kreditflode", "nettoköp") + ' <span class="' + cls(r.totals.flow) + '">' + bigSek(r.totals.flow, true) + "</span>"));
    }
    if (figs.length) html += '<dl class="figures">' + figs.join("") + "</dl>";
    else if (!failed("rates-market") && !failed("rates-" + state.q)) html += loadingBlock("Laddar räntor…");

    // Marknadsräntor
    if (hasMarket && m) {
      var from = new Date(Date.now() - rateState.range * 365.25 * 864e5).toISOString().slice(0, 10);
      var series = RATE_SERIES.filter(function (s) { return m.series[s[0]]; }).map(function (s) {
        return { id: s[0], label: s[1], cls: s[2], points: m.series[s[0]].points.filter(function (p) { return p.d >= from; }) };
      });
      var rangeBtn = function (y, label) { return '<button type="button" class="seg-btn" data-rate-range="' + y + '" aria-pressed="' + (rateState.range === y) + '">' + label + "</button>"; };
      html += '<section class="block section-gap"><div class="block-head"><h2>Marknadsräntor</h2><div class="seg" role="group" aria-label="Period">' +
        rangeBtn(1, "1 år") + rangeBtn(5, "5 år") + rangeBtn(10, "10 år") + rangeBtn(20, "20 år") + '</div></div><div class="chart-card">' +
        chart(function (node) {
          FFCharts.lines(node, series, { unit: " %", format: function (v) { return nf2.format(v); }, tip: function (rows) {
            return "<b>" + dateText(rows[0].p.d) + "</b>" + rows.map(function (x) {
              return tipRow(x.s.cls, esc(x.s.label), nf2.format(x.p.v) + " %");
            }).join("");
          } });
        }) + '<p class="chart-note">Källa: Riksbanken, en notering per vecka. Obligationsräntorna är marknadsräntor för statens och bostadsinstitutens referensobligationer.</p></div></section>';
    } else if (failed("rates-market")) {
      html += '<p class="notice section-gap">Marknadsräntorna kunde inte hämtas från Riksbanken just nu.</p>';
    }

    if (!hasRates) return html + (failed("rates-" + state.q) ? '<p class="notice section-gap">Fondernas räntepapper finns inte för ' + quarterLabel(state.q) + ".</p>" : loadingBlock());
    var Q = quarterLabel(state.q), P = quarterLabel(r.meta.prevId);
    var catVals = {}, catFlows = {};
    Object.keys(r.cats).forEach(function (c) { catVals[c] = r.cats[c].v2; catFlows[c] = r.cats[c].flow; });

    html += '<section class="block section-gap"><div class="block-head"><h2>Vad fonderna äger</h2><span class="note">' + Q + ", med nettoköp sedan " + P + "</span></div>" +
      '<div class="grid-2"><div class="panel"><h3>Per emittent</h3><p class="desc">Andel av fondernas räntepapper.</p>' + catBreakdown(catVals, r.totals.v2, { flows: catFlows }) + "</div>" +
      '<div class="panel"><h3>Tid kvar till förfall</h3><p class="desc">' + termLink("loptid", "Löptid") + " för fondernas räntepapper.</p>" + maturityBars(r.maturity) + "</div></div></section>";

    // Kreditflöden
    var flowCols = function () {
      return [
        { key: "n", label: "Emittent", align: "l", cls: "name", cell: function (i) { return '<a href="' + issuerHref(i.key) + '">' + esc(i.name) + '</a><span class="sub">' + esc(CAT_LABEL[i.cat]) + " · " + int(i.f2) + " fonder</span>"; } },
        { key: "f", label: "Netto (mkr)", cell: function (i) { return '<span class="' + cls(i.flow) + '">' + mkr(i.flow, true) + "</span>"; } },
        { key: "v", label: "Innehav (mkr)", hideSm: true, cell: function (i) { return mkr(i.v2); } }
      ];
    };
    var buys = r.issuers.filter(function (i) { return i.flow > 0; }).sort(function (a, b) { return b.flow - a.flow; });
    var sells = r.issuers.filter(function (i) { return i.flow < 0; }).sort(function (a, b) { return a.flow - b.flow; });
    html += '<div class="grid-2 section-gap">' +
      block("Köpte mest", "Fondernas nettoköp av obligationer per emittent, " + Q + ".", table("rate-buy", flowCols(), buys, { static: true, limit: 10, expand: true, empty: "Inga köp." })) +
      block("Sålde mest", "Papper som förfallit räknas inte som sålda.", table("rate-sell", flowCols(), sells, { static: true, limit: 10, expand: true, empty: "Inga sälj." })) + "</div>";

    // Alla emittenter
    var catOpts = '<option value="">Alla emittenter</option>' + RATE_CATS.map(function (c) { return '<option value="' + c[0] + '"' + (rateState.cat === c[0] ? " selected" : "") + ">" + esc(c[1]) + "</option>"; }).join("");
    html += '<section class="block section-gap"><div class="block-head"><h2>Alla emittenter</h2></div>' +
      '<div class="toolbar"><input class="input" type="search" id="rateSearch" aria-label="Filtrera emittenterna" placeholder="Sök emittent, till exempel Castellum" value="' + esc(rateState.q) + '" autocomplete="off">' +
      '<select class="select-sm" id="rateCat" aria-label="Kategori">' + catOpts + '</select><span class="count" id="rateCount"></span></div><div id="issuerTable"></div></section>';

    // Största räntefonderna
    var d = quarterData();
    var rf = fundList().filter(function (f) { return fundKind(f) === "rante"; }).sort(function (a, b) { return (b.aum || 0) - (a.aum || 0); });
    if (rf.length) {
      html += '<section class="block section-gap"><div class="block-head"><h2>Räntefonder</h2><a class="note" href="#/fonder/rantefonder">Alla ' + int(rf.length) + " räntefonder</a></div>" +
        table("rate-funds", rateFundCols(), rf, { static: true, limit: 10, expand: true }) + "</section>";
    }
    html += '<section class="block section-gap"><div class="block-head"><h2>Så räknas det</h2></div><div class="text-block">' +
      "<p>Fondbolagen rapporterar varje kvartal alla sina innehav till Finansinspektionen, även obligationer och certifikat. Nettoköpet är förändringen i nominellt belopp " +
      "gånger värdet per nominell krona vid kvartalets slut. Papper som förfallit under kvartalet (" + bigSek(r.totals.matured) + " i " + Q + ") räknas inte som sålda.</p>" +
      "<p>Emittenten står inte som ett eget fält hos Finansinspektionen, bara i värdepapperets namn, och fondbolagen skriver samma obligation på olika sätt. " +
      "Fondinsyn grupperar därför obligationerna per ISIN och knyter ihop namnvarianterna. De stora emittenterna blir rätt, men för små bolag kan samma emittent ibland " +
      "synas under två namn. Banker som ger ut både säkerställda och vanliga obligationer visas som en emittent, och varje papper räknas till sin kategori.</p></div></section>";
    return html;
  }
  function rateFundCols() {
    var r = ratesData();
    var x = function (f) { return r.funds[f.id] || {}; };
    var corp = function (f) { var c = x(f).cats || {}; return x(f).bond ? ((c.fastighet || 0) + (c.foretag || 0)) / x(f).bond : null; };
    return [
      { key: "name", label: "Fond", align: "l", cls: "name", cell: function (f) { return nameCell(fundHref(f), f.name, esc(f.co) + " · " + yearsText(x(f).years)); }, value: function (f) { return f.name; } },
      { key: "co", label: "Fondbolag", align: "l", cls: "muted", hideSm: true, cell: function (f) { return companyLink(f.co); }, value: function (f) { return f.co; } },
      { key: "aum", label: "Förmögenhet (mkr)", cell: function (f) { return mkr(f.aum); }, value: function (f) { return f.aum; } },
      { key: "fee", label: "Avgift", hideSm: true, cell: function (f) { return f.feeMax == null ? "–" : nf2.format(f.feeMax) + " %"; }, value: function (f) { return f.feeMax; } },
      { key: "y", label: "Löptid", hideSm: true, cell: function (f) { return yearsText(x(f).years); }, value: function (f) { return x(f).years; } },
      { key: "fl", label: "Rörlig ränta", hideSm: true, cell: function (f) { return x(f).float == null ? "–" : pctShare(x(f).float); }, value: function (f) { return x(f).float; } },
      { key: "c", label: "Företag", hideSm: true, cell: function (f) { return corp(f) == null ? "–" : pctShare(corp(f)); }, value: corp },
      { key: "flow", label: "Netto (mkr)", cell: function (f) { var v = x(f).flow; return v == null ? "–" : '<span class="' + cls(v) + '">' + mkr(v, true) + "</span>"; }, value: function (f) { return x(f).flow; } }
    ];
  }
  function renderIssuerTable() {
    var r = ratesData();
    if (!r || !$("issuerTable")) return;
    var q = rateState.q.trim().toLowerCase();
    var rows = r.issuers.filter(function (i) {
      if (i.v2 <= 0 && i.v1 <= 0) return false;
      if (rateState.cat && i.cat !== rateState.cat) return false;
      return !q || i.name.toLowerCase().indexOf(q) >= 0;
    });
    var cols = [
      { key: "n", label: "Emittent", align: "l", cls: "name", cell: function (i) { return '<a href="' + issuerHref(i.key) + '">' + esc(i.name) + '</a><span class="sub show-sm">' + esc(CAT_LABEL[i.cat]) + " · " + int(i.f2) + " fonder</span>"; }, value: function (i) { return i.name; } },
      { key: "c", label: "Kategori", align: "l", hideSm: true, cell: function (i) { return catName(i.cat); }, value: function (i) { return CAT_LABEL[i.cat]; }, csv: function (i) { return CAT_LABEL[i.cat]; } },
      { key: "v", label: "Innehav (mkr)", cell: function (i) { return mkr(i.v2); }, value: function (i) { return i.v2; } },
      { key: "f", label: "Nettoköp (mkr)", cell: function (i) { return '<span class="' + cls(i.flow) + '">' + mkr(i.flow, true) + "</span>"; }, value: function (i) { return i.flow; } },
      { key: "f2", label: "Fonder", hideSm: true, cell: function (i) { return int(i.f2); }, value: function (i) { return i.f2; } },
      { key: "df", label: "Δ fonder", hideSm: true, cell: function (i) { var dd = i.f2 - i.f1; return '<span class="' + cls(dd) + '">' + (dd ? signed(String(dd), dd) : "0") + "</span>"; }, value: function (i) { return i.f2 - i.f1; } },
      { key: "nb", label: "Papper", hideSm: true, cell: function (i) { return int(i.n); }, value: function (i) { return i.n; } }
    ];
    $("issuerTable").innerHTML = table("issuers", cols, rows, { sort: { col: "v", dir: -1 }, limit: 50, expand: true, csv: true, empty: "Ingen emittent matchar sökningen." });
    $("rateCount").textContent = int(rows.length) + " emittenter";
  }

  // Normaliserat bolagsnamn för att hitta emittentens aktie ("Castellum AB" och "Castellum")
  function bareName(s) {
    return String(s || "").toLowerCase().replace(/\(publ\)|\bpubl\b/g, " ").replace(/\b(ab|aktiebolag|asa|oyj|plc|group|holding|ltd|inc|ser\.?|class|series|sdb|[a-d])\b/g, " ")
      .replace(/[^a-z0-9åäö]+/g, "").trim();
  }
  function issuerStock(name) {
    var key = bareName(name);
    if (key.length < 3) return null;
    var ds = quarterData().se, best = null;
    ds.stocks.forEach(function (s) { if (bareName(s.name) === key && (!best || s.val2 > best.val2)) best = s; });
    return best;
  }

  function viewIssuer(key) {
    var hasRates = needRates();
    if (!hasRates) return failed("rates-" + state.q) ? notFound("Räntedata saknas för " + quarterLabel(state.q) + ".") : loadingBlock();
    var r = ratesData(), i = r.byKey[key];
    if (!i) return notFound("Emittenten finns inte bland fondernas räntepapper " + quarterLabel(state.q) + ".");
    document.title = i.name + " – obligationer som fonderna äger – Fondinsyn";
    var Q = quarterLabel(state.q), P = quarterLabel(r.meta.prevId);
    var metaParts = [CAT_LABEL[i.cat]];
    if (i.sector) metaParts.push(i.sector);
    if (i.country) metaParts.push(countryName(i.country));
    var html = '<div class="page-head"><div class="crumbs"><a href="#/rantor">Räntor</a> / ' + esc(i.name) + '</div><div class="title-row"><div class="title-main">' + avatar(i.name) +
      "<h1>" + esc(i.name) + '</h1></div></div><p class="meta">' + metaParts.map(esc).join(" · ") + "</p></div>";
    html += '<dl class="figures">' + fig("Fondernas innehav", bigSek(i.v2), Q) +
      fig("Nettoköp", '<span class="' + cls(i.flow) + '">' + bigSek(i.flow, true) + "</span>", "sedan " + P) +
      fig("Fonder som äger", int(i.f2), (i.f2 - i.f1 ? signed(String(i.f2 - i.f1), i.f2 - i.f1) + " sedan " + P : "lika många som " + P)) +
      fig("Värdepapper", int(i.n), "som fonderna äger") +
      (i.matured > 0 ? fig("Förföll under kvartalet", bigSek(i.matured), "räknas inte som sålt") : "") + "</dl>";
    var st = issuerStock(i.name);
    if (st) html += '<p class="notice">Fonderna äger också aktier i bolaget: <a href="' + stockHref(st) + '">' + esc(st.name) + "</a> för " + bigSek(st.val2) + ".</p>";

    if (!needIssuer(key)) return html + (failed("re-" + key) ? '<p class="notice section-gap">Detaljerna för emittenten kunde inte laddas.</p>' : loadingBlock());
    var x = (state.issuerData[key] || {})[state.q];
    if (!x) return html + '<p class="notice section-gap">Inga detaljer för ' + Q + ".</p>";
    var d = quarterData();
    var funds = x.f.map(function (f) { return { id: f[0], info: d.fi[f[0]], v1: f[1], v2: f[2], flow: f[3] }; });
    var fundCols = [
      { key: "n", label: "Fond", align: "l", cls: "name", cell: function (f) { return f.info ? nameCell(fundHref(f.info), f.info.name, esc(f.info.co)) : esc(f.id); }, value: function (f) { return f.info ? f.info.name : f.id; } },
      { key: "co", label: "Fondbolag", align: "l", cls: "muted", hideSm: true, cell: function (f) { return f.info ? companyLink(f.info.co) : "–"; } },
      { key: "v", label: "Innehav (mkr)", cell: function (f) { return f.v2 ? mkr(f.v2) : '<span class="label out">Avvecklat</span>'; }, value: function (f) { return f.v2; } },
      { key: "f", label: "Nettoköp (mkr)", cell: function (f) { return f.flow == null ? "–" : '<span class="' + cls(f.flow) + '">' + mkr(f.flow, true) + "</span>"; }, value: function (f) { return f.flow; } },
      { key: "w", label: "Andel av fond", hideSm: true, cell: function (f) { return f.info && f.info.aum && f.v2 ? nf1.format(f.v2 / f.info.aum * 100) + " %" : "–"; }, value: function (f) { return f.info && f.info.aum ? f.v2 / f.info.aum : null; } }
    ];
    var bonds = x.b.map(function (b) { return { isin: b[0], name: b[1], mat: b[2], fl: b[3], v2: b[4], nf: b[5], v1: b[6] }; });
    var bondCols = [
      { key: "n", label: "Värdepapper", align: "l", cls: "name", cell: function (b) { return '<span class="nm-plain">' + esc(b.name) + '</span><span class="sub">' + esc(b.isin.indexOf("X:") === 0 ? "ISIN saknas" : b.isin) + "</span>"; }, value: function (b) { return b.name; } },
      { key: "m", label: "Förfaller", hideSm: true, cell: function (b) { return matText(b.mat); }, value: function (b) { return b.mat || "9999"; } },
      { key: "r", label: "Ränta", hideSm: true, cell: function (b) { return floatText(b.fl); }, value: function (b) { return b.fl; } },
      { key: "v", label: "Fondernas innehav (mkr)", cell: function (b) { return b.v2 ? mkr(b.v2) : '<span class="label out">Borta</span>'; }, value: function (b) { return b.v2; } },
      { key: "nf", label: "Fonder", cell: function (b) { return int(b.nf); }, value: function (b) { return b.nf; } }
    ];
    html += '<div class="grid-2 section-gap">' +
      block("Fonder som äger", "Fondernas innehav och nettoköp av emittentens papper, " + Q + ".", table("iss-funds-" + key, fundCols, funds, { sort: { col: "v", dir: -1 }, limit: 15, expand: true, csv: true })) +
      block("Värdepapper", "Obligationer och certifikat som fonderna äger.", table("iss-bonds-" + key, bondCols, bonds, { sort: { col: "v", dir: -1 }, limit: 15, expand: true, csv: true })) + "</div>";
    return html;
  }

  // Fondsidan: räntepapper och fondandelar
  function fundBondRows(id) {
    var x = state.fundRates && state.fundRates[id] && state.fundRates[id][state.q];
    if (!x) return null;
    var r = ratesData();
    return {
      b: x.b.map(function (b) {
        var iss = b[2] && r ? r.byKey[b[2]] : null;
        return { isin: b[0], raw: b[1], key: b[2], issuer: iss ? iss.name : b[1], cat: b[3], mat: b[4], fl: b[5], n1: b[6], n2: b[7], v1: b[8], v2: b[9], matured: !!b[10], flow: b[11] };
      }),
      u: x.u.map(function (u) { return { isin: u[0], name: prettyName(u[1]), target: u[2], v1: u[3], v2: u[4], flow: u[5] }; })
    };
  }
  function bondFlow(b) { return b.matured ? 0 : b.flow; }

  function fundBondSection(info, rx, rows) {
    var Q = quarterLabel(state.q);
    var aum = info.aum;
    var corp = rx.bond ? ((rx.cats.fastighet || 0) + (rx.cats.foretag || 0)) / rx.bond : null;
    var html = '<section class="block section-gap"><div class="block-head"><h2>Räntepapper</h2><span class="note">' + int(rx.n) + " värdepapper · " + bigSek(rx.bond) +
      (aum ? " · " + share(rx.bond, aum) + " av fonden" : "") + "</span></div>";
    html += '<dl class="figures">' + fig(termLink("loptid", "Genomsnittlig löptid"), yearsText(rx.years), "tid kvar till förfall") +
      fig("Rörlig ränta", rx.float == null ? "–" : pctShare(rx.float), "av räntepappren") +
      fig("Företagsobligationer", corp == null ? "–" : pctShare(corp), "fastighetsbolag och övriga företag") +
      fig("Nettoköp", rx.flow == null ? "–" : '<span class="' + cls(rx.flow) + '">' + bigSek(rx.flow, true) + "</span>", Q) + "</dl>";
    if (!rows) return html + (failed("rf-" + info.id) ? "" : loadingBlock()) + "</section>";
    var mat = [0, 0, 0, 0, 0, 0], qEnd = Date.parse(quarterData().meta.curr);
    rows.b.forEach(function (b) {
      if (!b.v2) return;
      var y = b.mat && b.mat !== "perp" ? (Date.parse(b.mat) - qEnd) / (365.25 * 864e5) : null;
      mat[y == null ? 5 : y < 1 ? 0 : y < 3 ? 1 : y < 5 ? 2 : y < 10 ? 3 : 4] += b.v2;
    });
    html += '<div class="grid-2"><div class="panel"><h3>Per emittent</h3>' + catBreakdown(rx.cats, rx.bond) + '</div><div class="panel"><h3>Tid kvar till förfall</h3>' + maturityBars(mat) + "</div></div>";
    var cols = [
      { key: "n", label: "Emittent", align: "l", cls: "name", cell: function (b) {
        return (b.key ? '<a href="' + issuerHref(b.key) + '">' + esc(b.issuer) + "</a>" : '<span class="nm-plain">' + esc(b.issuer) + "</span>") + '<span class="sub">' + esc(b.raw) + "</span>";
      }, value: function (b) { return b.issuer; } },
      { key: "c", label: "Kategori", align: "l", hideSm: true, cell: function (b) { return catName(b.cat); }, value: function (b) { return CAT_LABEL[b.cat]; }, csv: function (b) { return CAT_LABEL[b.cat]; } },
      { key: "m", label: "Förfaller", hideSm: true, cell: function (b) { return matText(b.mat); }, value: function (b) { return b.mat || "9999"; } },
      { key: "r", label: "Ränta", hideSm: true, cell: function (b) { return floatText(b.fl); }, value: function (b) { return b.fl; } },
      { key: "v", label: "Värde (mkr)", cell: function (b) { return b.v2 ? mkr(b.v2) : '<span class="label out">' + (b.matured ? "Förföll" : "Såld") + "</span>"; }, value: function (b) { return b.v2; } },
      { key: "w", label: "Andel av fond", hideSm: true, cell: function (b) { return aum && b.v2 ? nf1.format(b.v2 / aum * 100) + " %" : "–"; }, value: function (b) { return b.v2; } },
      { key: "d", label: "Förändring (mkr)", hideSm: true, cell: function (b) { var v = bondFlow(b); return b.matured || v == null ? "–" : '<span class="' + cls(v) + '">' + mkr(v, true) + "</span>"; }, value: function (b) { return bondFlow(b); } }
    ];
    return html + '<div class="section-gap-sm">' + table("fund-bonds-" + info.id, cols, rows.b, { sort: { col: "v", dir: -1 }, limit: 15, expand: true, csv: true }) + "</div></section>";
  }
  function fundUnitSection(info, rx, rows) {
    var d = quarterData(), aum = info.aum;
    var html = '<section class="block section-gap"><div class="block-head"><h2>Fondandelar</h2><span class="note">Fonder som fonden äger · ' + bigSek(rx.unit) +
      (aum ? " · " + share(rx.unit, aum) + " av fonden" : "") + "</span></div>";
    if (!rows) return html + (failed("rf-" + info.id) ? "" : loadingBlock()) + "</section>";
    var cols = [
      { key: "n", label: "Fond", align: "l", cls: "name", cell: function (u) {
        var t = u.target && d.fi[u.target];
        return t ? nameCell(fundHref(t), u.name, esc(t.co)) : '<span class="nm-plain">' + esc(u.name) + '</span><span class="sub">' + (u.isin && u.isin.indexOf("X:") ? esc(u.isin) : "") + "</span>";
      }, value: function (u) { return u.name; } },
      { key: "v", label: "Värde (mkr)", cell: function (u) { return u.v2 ? mkr(u.v2) : '<span class="label out">Såld</span>'; }, value: function (u) { return u.v2; } },
      { key: "w", label: "Andel av fond", hideSm: true, cell: function (u) { return aum && u.v2 ? nf1.format(u.v2 / aum * 100) + " %" : "–"; }, value: function (u) { return u.v2; } },
      { key: "d", label: "Förändring (mkr)", cell: function (u) { return u.flow == null ? "–" : '<span class="' + cls(u.flow) + '">' + mkr(u.flow, true) + "</span>"; }, value: function (u) { return u.flow; } }
    ];
    return html + table("fund-units-" + info.id, cols, rows.u, { sort: { col: "v", dir: -1 }, limit: 15, expand: true, csv: true }) + "</section>";
  }

  // ---------- Routing ----------

  // Avdelningarna i menyraden och sidorna i varje avdelning (flikarna överst på sidan)
  var SECTIONS = {
    aktier: { label: "Aktier och marknad", items: [["aktier", "Alla aktier", "#/aktier"], ["blankning", "Blankning", "#/blankning"], ["uppkop", "Uppköp", "#/uppkop"],
      ["insyn", "Insynshandel", "#/insyn"]] },
    fonder: { label: "Fonder", items: [["fonder", "Alla fonder", "#/fonder"], ["fondbolag", "Fondbolag", "#/fondbolag"], ["sparande", "Fondsparandet", "#/sparande"],
      ["agarandel", "Fondernas ägarandel", "#/agarandel"], ["forvaltare", "Kända förvaltare", "#/forvaltare"], ["backtest", "Följ fonderna", "#/backtest"],
      ["avgifter", "Avgiftskollen", "#/avgifter"], ["risk", "Risk och avkastning", "#/risk"], ["jamfor", "Jämför fonder", "#/jamfor"]] },
    om: { label: "Om Fondinsyn", items: [["om", "Om datan", "#/om"], ["metod", "Metodrapport", "#/metod"], ["ordlista", "Ordlista", "#/ordlista"], ["kontakt", "Kontakt", "#/kontakt"]] }
  };
  // Sidor som hör till en avdelning i menyraden (blankning, uppköp och insynshandel under Aktier, ägarandel och sparande under Fonder, emittenterna under Räntor)
  var PAGE_SECTION = { aktie: "aktier", insyn: "aktier", blankning: "aktier", blankare: "aktier", uppkop: "aktier", rantor: "rantor", emittent: "rantor",
    fond: "fonder", fondbolag: "fonder", sparande: "fonder", agarandel: "fonder", forvaltare: "fonder", backtest: "fonder", avgifter: "fonder", risk: "fonder", jamfor: "fonder",
    ordlista: "om", kontakt: "om", metod: "om" };

  // Kvartalsrapporten har egna flikar för marknaden
  var MARKET_PAGES = { oversikt: 1, aktier: 1, fonder: 1, fondbolag: 1 };
  var NO_SUBBAR = { risk: 1, insyn: 1, blankning: 1, blankare: 1, uppkop: 1, sparande: 1, rantor: 1, emittent: 1, backtest: 1, om: 1, metod: 1, ordlista: 1, kontakt: 1, finnsinte: 1, data: 1, integritet: 1 };
  // #/fonder/rantefonder öppnar fondlistan filtrerad på en fondtyp
  var FUND_TYPE_SLUGS = { aktiefonder: "equity", rantefonder: "rante", blandfonder: "bland", fondandelsfonder: "fof", indexfonder: "index" };

  // Sidorna under /aktie/, /fond/ och /fondbolag/ byggs av scripts/build-pages.ps1 och anger sin vy i
  // data-route. En adress med # går alltid före.
  var pageRoute = document.body.getAttribute("data-route") || "";
  var pageTitle = pageRoute ? document.title : "";
  // Sidor med data-keep (ordlistans begrepp, rapportlistan) har eget innehåll som appen inte ritar om
  var pageKeep = document.body.hasAttribute("data-keep");
  var lastRouteKey = "";

  function route() {
    var parts = (location.hash.replace(/^#\/?/, "") || pageRoute).split("/");
    return { page: parts[0] || "oversikt", arg: decodeURIComponent(parts[1] || ""), arg2: decodeURIComponent(parts[2] || "") };
  }

  function render() {
    if (!state.q || !quarterData() || !quarterData().se) return;
    var r = route();
    if (state.restoreQ && r.page !== "rapport") {
      selectQuarter(state.restoreQ, true, true);
      return;
    }
    document.body.setAttribute("data-page", r.page);
    document.title = "Fondinsyn – vad köper och säljer svenska fonder?";
    state.charts = [];
    var html = null;
    if (!(pageKeep && !location.hash)) switch (r.page) {
      case "aktier": html = viewStocks(); break;
      case "aktie": html = viewStock(r.arg); break;
      case "fonder": if (FUND_TYPE_SLUGS[r.arg] && lastRouteKey !== "fonder/" + r.arg + "/") fundFilter.type = FUND_TYPE_SLUGS[r.arg]; html = viewFunds(); break;
      case "fond": html = viewFund(r.arg, r.arg2); break;
      case "forvaltare": html = viewManagers(); break;
      case "avgifter": html = viewFees(); break;
      case "portfolj": html = viewPortfolio(r.arg); break;
      case "jamfor": html = viewCompare(r.arg, r.arg2); break;
      case "uppkop": html = viewOffers(r.arg); break;
      case "rapport": html = viewReport(r.arg); break;
      case "blankning": html = viewShorts(); break;
      case "insyn": html = viewInsider(); break;
      case "blankare": html = r.arg ? viewHolder(r.arg) : viewHolders(); break;
      case "fondbolag": html = r.arg ? viewCompany(r.arg) : viewCompanies(); break;
      case "ordlista": html = viewGlossary(r.arg); break;
      case "om": html = viewAbout(); break;
      case "kontakt": html = viewContact(); break;
      case "rantor": html = viewRates(); break;
      case "dubbelsignal": location.replace("#/insyn"); return;
      case "sparande": html = viewSavings(); break;
      case "agarandel": html = viewOwnership(); break;
      // Toppfonderna finns inte längre; gamla länkar går till risk och avkastning
      case "toppfonder": location.replace("#/risk"); return;
      case "risk": html = viewRisk(); break;
      case "bevakning": html = viewWatch(); break;
      case "backtest": html = viewBacktest(); break;
      case "metod": html = viewMethod(); break;
      case "signaler": location.replace("#/insyn"); return;
      case "emittent": html = viewIssuer(r.arg); break;
      case "oversikt": html = viewOverview(); break;
      default: html = viewNotFound();
    }
    if (html !== null) app.innerHTML = html;
    // Mjuk övergång när man byter sida, men inte när samma sida ritas om efter att mer data laddats
    var routeKey = r.page + "/" + r.arg + "/" + r.arg2;
    if (html !== null && routeKey !== lastRouteKey && lastRouteKey !== "") {
      // Sidans delar glider in i tur och ordning (inte vid första laddningen, då ska innehållet synas direkt)
      Array.prototype.forEach.call(app.children, function (c, i) { c.style.setProperty("--i", Math.min(i, 8)); });
      app.classList.remove("fade-in"); void app.offsetWidth; app.classList.add("fade-in");
    }
    if (routeKey !== lastRouteKey) countVisit();
    lastRouteKey = routeKey;
    // Pilar mellan leden i brödsmulorna
    app.querySelectorAll(".crumbs").forEach(function (c) {
      if (c.innerHTML.indexOf(" / ") >= 0) c.innerHTML = c.innerHTML.split(" / ").join('<span class="crumb-sep" aria-hidden="true"></span>');
    });
    if (pageTitle && !location.hash) document.title = pageTitle;
    if (r.page === "aktier") renderStockTable();
    if (r.page === "fonder") renderFundTable();
    if (r.page === "rantor") renderIssuerTable();
    drawCharts();
    // Sidan markeras i menyn, och dess avdelning i menyraden och flikraden
    var navKey = { aktie: "aktier", fond: "fonder", blankare: "blankning", emittent: "rantor" }[r.page] || r.page;
    var section = PAGE_SECTION[r.page] || navKey;
    document.querySelectorAll("[data-nav]").forEach(function (a) {
      var key = a.getAttribute("data-nav"), top = a.closest(".mainnav, .tabbar");
      if (key === (top ? section : navKey)) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    // Flikar för avdelningen överst på sidan (Fonder: Alla fonder, Risk och avkastning, Fondbolag ...)
    var sec = SECTIONS[section];
    var onList = sec && sec.items.some(function (it) { return it[0] === navKey && r.page === navKey && !r.arg; });
    if (onList && html !== null) {
      // På mobilen blir flikarna en rullgardin, så att de inte tar flera rader
      app.insertAdjacentHTML("afterbegin", '<nav class="subnav" aria-label="' + esc(sec.label) + '">' + sec.items.map(function (it) {
        return '<a href="' + it[2] + '"' + (it[0] === navKey ? ' aria-current="page"' : "") + ">" + it[1] + "</a>";
      }).join("") + "</nav>" +
        '<div class="subnav-pick"><label class="sp-label" for="subnavPick">Välj sida i ' + esc(sec.label) + '</label><select id="subnavPick" class="select-sm">' + sec.items.map(function (it) {
          return '<option value="' + it[2] + '"' + (it[0] === navKey ? " selected" : "") + ">" + it[1] + "</option>";
        }).join("") + "</select></div>");
    }
    // Sidor som bara ligger i menyn markerar menyknappen (på dator om sidan saknas i menyraden, på mobil i flikraden)
    var inMenu = !!document.querySelector('#moreMenu [aria-current="page"]');
    $("moreBtn").classList.toggle("active", inMenu && !document.querySelector('.mainnav [aria-current="page"]'));
    $("moreBtnM").classList.toggle("active", inMenu && !document.querySelector('.tabbar [aria-current="page"]'));
    document.body.setAttribute("data-page", r.page || "oversikt");
    // Sidor utan brödsmulor och utan flikar får menygruppens namn ovanför rubriken
    var ph = app.querySelector(".page-head");
    if (ph && !onList && !ph.querySelector(".crumbs, .kicker")) {
      var cur = document.querySelector('#moreMenu a[aria-current="page"]'), grp = cur && cur.closest(".mega-col");
      var gh = grp && grp.querySelector("h2");
      if (gh) ph.insertAdjacentHTML("afterbegin", '<p class="kicker">' + esc(gh.textContent) + "</p>");
    }
    $("marketSwitch").hidden = !MARKET_PAGES[r.page];
    syncWatchCount();
    if (r.page === "bevakning") $("watchBtn").setAttribute("aria-current", "page"); else $("watchBtn").removeAttribute("aria-current");
    // Raden med kvartalets jämförelse och "Utan indexfonder" gäller fondinnehaven och döljs på sidor utan dem
    document.querySelector(".subbar").style.display = NO_SUBBAR[r.page] || app.querySelector("[data-notfound]") ? "none" : "";
    renderSummary();
    segThumbs();
    tabIndicator();
    navIndicator();
    countUp();
    if (search.open) runSearch();
  }

  // ---------- Rörelse ----------

  // Kort bekräftelse längst ner när ett filter ändras
  var toastTimer = null;
  function toast(msg) {
    var el = $("toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      el.className = "toast";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.remove("on"); void el.offsetWidth; el.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("on"); }, 2600);
  }

  // ?pdf i adressen: sidan skrivs ut som PDF (scripts/build-pdf.sh), då ska allt synas direkt utan animationer
  var pdfMode = /[?&]pdf\b/.test(location.search);
  if (pdfMode) document.documentElement.classList.add("pdf");
  var reduceMotion = pdfMode || (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  // Segmentknapparna får en markering som glider till det valda alternativet. Läget sparas per knapprad,
  // så att markeringen glider även när sidan ritas om och knapparna byts ut.
  var segPos = {};
  function segThumbs() {
    var seen = {};
    document.querySelectorAll(".seg").forEach(function (seg) {
      if (!seg.offsetParent) return;
      var base = seg.id || seg.getAttribute("aria-label") || "seg";
      var key = base + "#" + (seen[base] = (seen[base] || 0) + 1);
      var btn = seg.querySelector('.seg-btn[aria-pressed="true"]');
      var th = seg.querySelector(".seg-thumb");
      if (!btn) { if (th) th.style.opacity = "0"; return; }
      var pos = { x: btn.offsetLeft, w: btn.offsetWidth };
      var place = function (p) { th.style.width = p.w + "px"; th.style.transform = "translateX(" + p.x + "px)"; };
      if (!th) {
        th = document.createElement("span");
        th.className = "seg-thumb";
        th.setAttribute("aria-hidden", "true");
        seg.insertBefore(th, seg.firstChild);
        seg.classList.add("has-thumb");
        var prev = segPos[key];
        if (prev && !reduceMotion && (prev.x !== pos.x || prev.w !== pos.w)) {
          th.style.transition = "none"; place(prev); void th.offsetWidth; th.style.transition = "";
        }
      }
      place(pos);
      th.style.opacity = "";
      segPos[key] = pos;
    });
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { segThumbs(); navIndicator(); });

  // Huvudmenyn: en linje som glider till sidan man är på
  function navIndicator() {
    var nav = document.querySelector(".mainnav"), ind = nav && nav.querySelector(".nav-ind");
    if (!ind || !nav.offsetParent) return;
    var a = nav.querySelector('a[aria-current="page"]');
    // Första gången (och när linjen varit dold) hamnar den direkt på plats utan att glida dit
    var jump = !nav.classList.contains("has-ind");
    nav.classList.toggle("has-ind", !!a);
    if (!a) return;
    var pad = parseFloat(getComputedStyle(a).paddingLeft) || 0;
    if (jump) ind.style.transition = "none";
    ind.style.width = (a.offsetWidth - 2 * pad) + "px";
    ind.style.transform = "translateX(" + (a.offsetLeft + pad) + "px)";
    if (jump) { void ind.offsetWidth; ind.style.transition = ""; }
  }

  // Flikraden på mobil: en markering som glider till den aktiva fliken
  function tabIndicator() {
    var bar = document.querySelector(".tabbar");
    if (!bar) return;
    var items = Array.prototype.filter.call(bar.children, function (c) { return c.matches("a, button"); });
    var idx = -1;
    items.forEach(function (c, i) {
      if (c.getAttribute("aria-current") === "page" || c.getAttribute("aria-expanded") === "true" || c.classList.contains("active")) idx = idx < 0 || c.getAttribute("aria-expanded") === "true" ? i : idx;
    });
    bar.style.setProperty("--ti", Math.max(0, idx));
    bar.classList.toggle("has-ind", idx >= 0);
  }

  // Siffror med klassen count räknas upp första gången de visas
  var counted = {};
  function countUp() {
    if (reduceMotion) return;
    app.querySelectorAll(".count").forEach(function (el, n) {
      var txt = el.textContent, key = lastRouteKey + "|" + n + "|" + txt;
      if (counted[key]) return;
      counted[key] = 1;
      var m = /^([+−-]?)([\d\s  ]+(?:,\d+)?)(.*)$/.exec(txt);
      if (!m) return;
      // mellanslaget före enheten hör till enheten ("726 fonder" blev "350fonder" medan siffran räknades upp)
      var numPart = m[2].replace(/[\s  ]+$/, "");
      m[3] = m[2].slice(numPart.length) + m[3];
      m[2] = numPart;
      var dec = (m[2].split(",")[1] || "").length;
      var target = parseFloat(m[2].replace(/[\s  ]/g, "").replace(",", "."));
      if (!isFinite(target) || target === 0) return;
      var fmt = new Intl.NumberFormat("sv-SE", { minimumFractionDigits: dec, maximumFractionDigits: dec });
      var t0 = null, dur = 650;
      el.style.minWidth = el.offsetWidth + "px";
      var step = function (ts) {
        if (t0 == null) t0 = ts;
        var k = Math.min(1, (ts - t0) / dur), e = 1 - Math.pow(1 - k, 4);
        el.textContent = k < 1 ? m[1] + fmt.format(target * e) + m[3] : txt;
        if (k < 1) requestAnimationFrame(step); else el.style.minWidth = "";
      };
      el.textContent = m[1] + fmt.format(0) + m[3];
      requestAnimationFrame(step);
    });
  }

  // Besöksräknare (GoatCounter, utan kakor och utan personuppgifter). Sajten byter sida utan att ladda om,
  // så varje sidbyte räknas här, med adressen efter # som sökväg (#/aktie/SE0000115446 blir /aktie/SE0000115446).
  // Skriptet laddas asynkront, så den första sidvisningen väntar tills det finns.
  function countVisit(tries) {
    var gc = window.goatcounter;
    if (!gc || !gc.count) {
      if ((tries || 0) < 20) setTimeout(function () { countVisit((tries || 0) + 1); }, 250);
      return;
    }
    var path = location.hash.replace(/^#/, "") || location.pathname;
    try { gc.count({ path: path, title: document.title }); } catch (e) { /* räknaren får aldrig stoppa sajten */ }
  }

  function renderSummary() {
    var d = quarterData(), m = d.meta;
    var ds = state.market === "se" ? d.se : d.world;
    var head = "<b>" + quarterLabel(m.id) + "</b> jämfört med <b>" + quarterLabel(m.prevId) + "</b>";
    if (!ds) { $("summary").innerHTML = head; return; }
    var t = ds.totals;
    $("summary").innerHTML = head + " · <b>" + int(t.funds) + "</b> fonder" + (state.excludeIndex ? ' <span class="filter-on">utan indexfonder</span>' : "") +
      '<span class="hide-sm"> · <b>' + int(t.held) + "</b> " + marketWord() + " aktier</span> · Nettoköp <b class=\"" +
      cls(t.buy + t.sell) + "\">" + bigSek(t.buy + t.sell, true) + "</b>";
    $("updated").textContent = "Uppdaterad " + m.built;
    document.querySelectorAll("[data-market]").forEach(function (b) {
      if (b.closest("#marketSwitch")) b.setAttribute("aria-pressed", String(b.getAttribute("data-market") === state.market));
    });
  }

  function selectQuarter(id, temporary, restoring) {
    // Ett tillfälligt byte (en äldre kvartalsrapport) kommer ihåg vilket kvartal som var valt, så att resten av sajten
    // går tillbaka dit när man lämnar rapporten. Ett vanligt byte glömmer det.
    if (restoring || !temporary) state.restoreQ = null;
    else if (!state.restoreQ && state.q !== id) state.restoreQ = state.q;
    if (!temporary) repPick.q = null;
    state.q = id;
    if (!temporary) store("ff-quarter", id);
    $("quarter").value = id;
    if (state.data[id] && state.data[id].se) { render(); return Promise.resolve(); }
    // Färdigbyggt innehåll (sökmotorsidorna) ligger kvar tills datan har laddats
    if (!app.children.length) app.innerHTML = loadingBlock();
    return loadSe(id).then(render);
  }

  function setMarket(m) {
    if (m !== "se" && m !== "world") return;
    state.market = m;
    store("ff-market", m);
  }

  // ---------- Händelser ----------

  // Menyn: på dator en panel i full bredd direkt under sidhuvudet, på mobil en panel nerifrån ovanför flikraden
  // Öppnas med klassen is-open (övergångarna i style.css) och göms först när stängningen har spelats klart
  var moreTimer = null;
  function moreOpen() { return $("moreMenu").classList.contains("is-open"); }
  function toggleMore(open) {
    var menu = $("moreMenu"), bd = $("moreBackdrop");
    var sheet = window.matchMedia("(max-width: 760px)").matches;
    if (open == null) open = !moreOpen();
    if (open === moreOpen()) return;
    clearTimeout(moreTimer);
    document.body.classList.toggle("sheet-open", open && sheet);
    $("moreBtn").setAttribute("aria-expanded", String(open));
    $("moreBtnM").setAttribute("aria-expanded", String(open));
    tabIndicator();
    if (!open) {
      menu.classList.remove("is-open"); bd.classList.remove("is-open");
      moreTimer = setTimeout(function () { menu.hidden = bd.hidden = true; }, 240);
      return;
    }
    if (menu.hidden) menu.classList.toggle("sheet", sheet);
    menu.hidden = bd.hidden = false;
    if (sheet) { menu.removeAttribute("style"); bd.removeAttribute("style"); }
    else menu.style.top = bd.style.top = Math.round(document.querySelector(".topbar").getBoundingClientRect().bottom) + "px";
    // Läs av layouten så att övergången startar från det stängda läget
    void menu.offsetWidth;
    menu.classList.add("is-open"); bd.classList.add("is-open");
    if (sheet) return;
    var first = menu.querySelector(".mega-col a:not(.m-only)");
    if (first && document.activeElement === $("moreBtn")) first.focus({ preventScroll: true });
  }
  var moreWidth = window.innerWidth;
  window.addEventListener("resize", function () { if (window.innerWidth !== moreWidth) { moreWidth = window.innerWidth; toggleMore(false); } });
  // Skugga under sidhuvudet när sidan är skrollad
  window.addEventListener("scroll", function () { document.body.classList.toggle("scrolled", window.scrollY > 4); }, { passive: true });
  window.addEventListener("scroll", function () { if (moreOpen() && !$("moreMenu").classList.contains("sheet")) toggleMore(false); }, { passive: true });

  // Varje sida minns var man var. Tillbaka och Framåt hamnar på samma ställe, en ny sida börjar högst upp.
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  function saveScroll() { try { history.replaceState({ scroll: window.scrollY }, ""); } catch (e) { /* t.ex. i förhandsvisning */ } }
  var scrollTimer = null;
  window.addEventListener("scroll", function () { clearTimeout(scrollTimer); scrollTimer = setTimeout(saveScroll, 150); }, { passive: true });
  document.addEventListener("click", saveScroll, true);
  window.addEventListener("hashchange", function () {
    toggleMore(false);
    render();
    var st = history.state;
    window.scrollTo(0, st && st.scroll != null ? st.scroll : 0);
  });

  var resizeTimer = null, lastWidth = window.innerWidth;
  window.addEventListener("resize", function () {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { drawCharts(); segThumbs(); navIndicator(); }, 150);
  });

  // Ljust eller mörkt läge. Utan eget val följer sidan systemets inställning. Ett val med knappen sparas i
  // webbläsaren och läses in redan i <head> (index.html), så att sidan inte hinner visas i fel läge.
  function isDark() { return document.documentElement.getAttribute("data-theme") === "dark"; }
  function syncThemeBtn() {
    var dark = isDark();
    $("themeBtn").setAttribute("aria-label", dark ? "Byt till ljust läge" : "Byt till mörkt läge");
    $("themeBtn").title = dark ? "Ljust läge" : "Mörkt läge";
    if ($("themeRowLabel")) $("themeRowLabel").textContent = dark ? "Ljust läge" : "Mörkt läge";
  }
  function setTheme(theme, fromSystem) {
    if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
    if (!fromSystem) { try { localStorage.setItem("ff-theme", theme); } catch (e) { /* ingen lagring */ } }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#131b18" : "#ffffff");
    syncThemeBtn();
  }
  syncThemeBtn();
  // Byter systemet läge (till exempel mörkt på kvällen) följer sidan med, om man inte själv har valt
  if (window.matchMedia && !/[?&]pdf/.test(location.search)) {
    var darkMq = window.matchMedia("(prefers-color-scheme: dark)");
    var onSystemTheme = function (e) {
      var saved = null;
      try { saved = localStorage.getItem("ff-theme"); } catch (err) { /* ingen lagring */ }
      if (!saved) setTheme(e.matches ? "dark" : "light", true);
    };
    if (darkMq.addEventListener) darkMq.addEventListener("change", onSystemTheme); else if (darkMq.addListener) darkMq.addListener(onSystemTheme);
  }

  // Förhandsvisningen av inbäddningsrutan laddas först när rutan fälls ut, i samma läge som sidan
  document.addEventListener("toggle", function (e) {
    var box = e.target;
    if (!box.classList || !box.classList.contains("embed-box") || !box.open) return;
    var pv = box.querySelector(".embed-preview");
    if (!pv || pv.firstChild) return;
    pv.innerHTML = '<iframe src="' + pv.getAttribute("data-src") + "&tema=" + (isDark() ? "morkt" : "ljust") + '" height="260" title="Förhandsvisning av rutan"></iframe>';
  }, true);

  document.addEventListener("click", function (e) {
    if (e.target.closest && e.target.closest("#themeBtn, [data-theme-toggle]")) { setTheme(isDark() ? "light" : "dark"); return; }
    // Hela raden i en tabell går att klicka på och öppnar raden första länk
    var row = e.target.closest && e.target.closest(".table-wrap tbody tr");
    if (row && !e.target.closest("a, button, input, select, label")) {
      var link = row.querySelector("td.name a") || row.querySelector("td a");
      if (link) {
        if (e.ctrlKey || e.metaKey) window.open(link.href, "_blank");
        else link.click();
        return;
      }
    }
    var shareEl = e.target.closest && e.target.closest("[data-share]");
    if (shareEl) { shareLink(shareEl); return; }
    if (e.target.id === "copyMail") {
      var btn = e.target;
      var done = function () { btn.textContent = "Kopierad"; setTimeout(function () { btn.textContent = "Kopiera"; }, 2000); };
      if (navigator.clipboard) navigator.clipboard.writeText(CONTACT).then(done, function () { selectText(btn.previousElementSibling); });
      else selectText(btn.previousElementSibling);
      return;
    }
    var csv = e.target.closest("[data-csv]");
    if (csv) { downloadCsv(csv.getAttribute("data-csv")); return; }
    if (e.target.closest("[data-hide-about]")) {
      aboutHidden(true);
      var ab = document.querySelector(".about-card");
      if (ab) ab.remove();
      return;
    }
    var ce = e.target.closest("[data-copy-embed]");
    if (ce) {
      var code = $("embedCode").textContent;
      var ok = function () { ce.textContent = "Kopierad"; setTimeout(function () { ce.textContent = "Kopiera koden"; }, 2000); };
      if (navigator.clipboard) navigator.clipboard.writeText(code).then(ok, function () { window.prompt("Kopiera koden", code); });
      else window.prompt("Kopiera koden", code);
      return;
    }
    var bt = e.target.closest("[data-bt-active]");
    if (bt) { btState.active = bt.getAttribute("data-bt-active") === "true"; var by = window.scrollY; render(); window.scrollTo(0, by); return; }
    var sv = e.target.closest("[data-sav-type]");
    if (sv) { savingsState.type = sv.getAttribute("data-sav-type"); var sy = window.scrollY; render(); window.scrollTo(0, sy); return; }
    var rp = e.target.closest("[data-rep-pick]");
    if (rp) {
      repPick.market = rp.getAttribute("data-rep-pick");
      refreshReportCard();
      return;
    }
    if (e.target.closest("#repGo:not([data-pdf]), #repWeb, .rc-web-link") && repPick.market && repPick.market !== state.market) setMarket(repPick.market);
    var mk = e.target.closest("[data-market]");
    if (mk) {
      setMarket(mk.getAttribute("data-market"));
      if (mk.closest("#marketSwitch, .rep-market")) { render(); toast(mk.getAttribute("data-market") === "world" ? "Visar globala aktier" : "Visar svenska aktier"); }
      return; // länkar med data-market (brödsmulor) navigerar som vanligt
    }
    // Sök
    if (e.target.closest("#moreBtn, #moreBtnM")) { toggleMore(); return; }
    if (e.target.closest("[data-open-search]")) { toggleMore(false); openSearch(); return; }
    if (moreOpen() && !e.target.closest("#moreMenu")) toggleMore(false);
    if (e.target.closest("#searchBtn, #searchBtnT")) { openSearch(); return; }
    if (e.target.closest("[data-search-close]")) { closeSearch(); return; }
    if (e.target.closest("[data-clear-recent]")) { store("ff-recent", []); runSearch(); $("searchInput").focus(); return; }
    var sr = e.target.closest("[data-sr]");
    if (sr) { pickSel(+sr.getAttribute("data-sr")); return; }

    // Bevakning
    var wt = e.target.closest("[data-watch]");
    if (wt) {
      var key0 = wt.getAttribute("data-watch"), kind = key0.split(":")[0], wid = key0.slice(kind.length + 1);
      watchToggle(kind, wid);
      var added = watching(kind, wid);
      syncWatchCount(added);
      if (added) toast("Sparad i Min bevakning, stjärnan uppe till höger");
      // På bevakningssidan ritas listan om, annars byts bara knappen
      if (route().page === "bevakning") { var sy0 = window.scrollY; render(); window.scrollTo(0, sy0); return; }
      wt.outerHTML = starBtn(kind, wid);
      var again0 = document.querySelector('[data-watch="' + key0 + '"]');
      if (again0) again0.focus();
      return;
    }

    // Portfölj
    var pfAdd = e.target.closest("[data-pf-add]");
    if (pfAdd) {
      var pid = pfAdd.getAttribute("data-pf-add");
      if (!inPortfolio(pid)) addToPortfolio(pid, 10000);
      location.hash = "#/portfolj";
      return;
    }
    var pfRm = e.target.closest("[data-pf-remove]");
    if (pfRm) {
      var rid = pfRm.getAttribute("data-pf-remove");
      savePortfolio(loadPortfolio().filter(function (x) { return x.id !== rid; }));
      render();
      return;
    }
    var adopt = e.target.closest("[data-pf-adopt]");
    if (adopt) {
      savePortfolio(decodePortfolio(adopt.getAttribute("data-pf-adopt")));
      location.hash = "#/portfolj";
      return;
    }
    if (e.target.id === "pfShare") {
      var sb = e.target, url = sb.getAttribute("data-url");
      var ok = function () { sb.textContent = "Länken är kopierad"; setTimeout(function () { sb.textContent = "Kopiera delningslänk"; }, 2500); };
      var fallback = function () { sb.outerHTML = '<input class="input share-url" readonly value="' + esc(url) + '" onfocus="this.select()">'; };
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(ok, fallback); else fallback();
      return;
    }
    if (e.target.closest("#cmpSwap")) {
      var a = $("cmpA"), bb = $("cmpB"), t = a.value;
      a.value = bb.value; bb.value = t;
      return;
    }

    var insPeriod = e.target.closest("[data-ins-period]");
    if (insPeriod) { insiderFilter.period = insPeriod.getAttribute("data-ins-period"); var py = window.scrollY; render(); window.scrollTo(0, py); return; }
    var insOwn = e.target.closest("[data-ins-own]");
    if (insOwn) { insiderFilter.own = insOwn.getAttribute("data-ins-own") === "true"; var oy = window.scrollY; render(); window.scrollTo(0, oy); return; }
    var insKind = e.target.closest("[data-ins-kind]");
    if (insKind) { insiderFilter.kind = insKind.getAttribute("data-ins-kind"); var iy = window.scrollY; render(); window.scrollTo(0, iy); return; }
    var fundTab = e.target.closest("[data-fund-tab]");
    if (fundTab) { state.fundTab = fundTab.getAttribute("data-fund-tab"); var ty = window.scrollY; render(); window.scrollTo(0, ty); return; }
    var dp = e.target.closest("[data-double-period]");
    if (dp) { doubleFilter.period = dp.getAttribute("data-double-period"); var dy = window.scrollY; render(); window.scrollTo(0, dy); return; }
    var rr = e.target.closest("[data-rate-range]");
    if (rr) { rateState.range = +rr.getAttribute("data-rate-range"); var ry2 = window.scrollY; render(); window.scrollTo(0, ry2); return; }
    var fundTr = e.target.closest("[data-fund-trades]");
    if (fundTr) { fundTradeFilter = fundTr.getAttribute("data-fund-trades"); var ry = window.scrollY; render(); window.scrollTo(0, ry); return; }
    var showAllBtn = e.target.closest("[data-show-all]");
    if (showAllBtn) { var sk = showAllBtn.getAttribute("data-show-all"); state.showAll[sk] = !state.showAll[sk]; var sy2 = window.scrollY; render(); window.scrollTo(0, sy2); return; }
    var shMin = e.target.closest("[data-short-min]");
    if (shMin) { shortFilter.min = +shMin.getAttribute("data-short-min"); var sy = window.scrollY; render(); window.scrollTo(0, sy); return; }
    if (e.target.id === "repShare") {
      var rb = e.target, rurl = rb.getAttribute("data-url");
      if (navigator.clipboard) navigator.clipboard.writeText(rurl).then(function () { rb.textContent = "Länken är kopierad"; }, function () {});
      return;
    }

    var fs = e.target.closest("[data-fee-scope],[data-fee-list]");
    if (fs) {
      if (fs.hasAttribute("data-fee-scope")) feeFilter.scope = fs.getAttribute("data-fee-scope");
      else feeFilter.list = fs.getAttribute("data-fee-list");
      render();
      return;
    }
    var b = e.target.closest("[data-sort]");
    if (!b) return;
    var p = b.getAttribute("data-sort").split(":"), key = p[0], c = p[1];
    var cur = state.sorts[key];
    var text = ["name", "sector", "fund", "co", "country"].indexOf(c) >= 0;
    if (!cur) {
      var th = b.closest("th");
      cur = th.hasAttribute("aria-sort") ? { col: c, dir: th.getAttribute("aria-sort") === "ascending" ? 1 : -1 } : null;
    }
    state.sorts[key] = cur && cur.col === c ? { col: c, dir: -cur.dir } : { col: c, dir: text ? 1 : -1 };
    if (key.indexOf("stocks-") === 0) renderStockTable();
    else if (key.indexOf("funds-") === 0) renderFundTable();
    else { var y = window.scrollY; render(); window.scrollTo(0, y); }
    var again = document.querySelector('[data-sort="' + key + ":" + c + '"]');
    if (again) again.focus({ preventScroll: true });
  });

  document.addEventListener("submit", function (e) {
    if (e.target.id === "pfForm") {
      e.preventDefault();
      var f = fundByName($("pfFund").value), amount = parseFloat(String($("pfAmount").value).replace(",", "."));
      if (!f) { $("pfMsg").textContent = "Välj en fond i listan."; $("pfFund").focus(); return; }
      if (!(amount > 0)) { $("pfMsg").textContent = "Fyll i hur många kronor du har i fonden."; $("pfAmount").focus(); return; }
      addToPortfolio(f.id, amount);
      render();
      if ($("pfFund")) $("pfFund").focus();
    }
    if (e.target.id === "cmpForm") {
      e.preventDefault();
      var A = fundByName($("cmpA").value), B = fundByName($("cmpB").value);
      if (!A || !B) { $("cmpMsg").textContent = "Välj två fonder i listan."; return; }
      location.hash = "#/jamfor/" + encodeURIComponent(A.id) + "/" + encodeURIComponent(B.id);
    }
  });

  document.addEventListener("keydown", function (e) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if ((e.key === "k" || e.key === "K") && (e.ctrlKey || e.metaKey)) { e.preventDefault(); search.open ? closeSearch() : openSearch(); return; }
    if (e.key === "/" && !typing && !search.open) { e.preventDefault(); openSearch(); return; }
    if (e.key === "Escape" && moreOpen()) { toggleMore(false); ($("moreBtnM").offsetParent ? $("moreBtnM") : $("moreBtn")).focus(); return; }
    if (!search.open) return;
    if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); moveSel(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveSel(-1); }
    else if (e.key === "Enter" && e.target.id === "searchInput") { e.preventDefault(); pickSel(); }
  });

  document.addEventListener("input", function (e) {
    if (e.target.id === "searchInput") { runSearch(); return; }
    if (e.target.id === "stockSearch") { stockFilter.q = e.target.value; renderStockTable(); }
    if (e.target.id === "fundSearch") { fundFilter.q = e.target.value; renderFundTable(); }
    if (e.target.id === "rateSearch") { rateState.q = e.target.value; renderIssuerTable(); }
  });
  document.addEventListener("change", function (e) {
    var id = e.target.id;
    if (id === "subnavPick") { location.hash = e.target.value; return; }
    if (id === "insMin") { insiderFilter.min = +e.target.value; var my = window.scrollY; render(); window.scrollTo(0, my); return; }
    if (id === "stockSector") { stockFilter.sector = e.target.value; renderStockTable(); }
    if (id === "stockMin") { stockFilter.min = e.target.value; renderStockTable(); }
    if (id === "fundCo") { fundFilter.co = e.target.value; renderFundTable(); }
    if (id === "fundType") { fundFilter.type = e.target.value; renderFundTable(); }
    if (id === "rateCat") { rateState.cat = e.target.value; renderIssuerTable(); }
    if (id === "quarter") selectQuarter(e.target.value);
    if (e.target.hasAttribute && e.target.hasAttribute("data-pf-id")) {
      var pid = e.target.getAttribute("data-pf-id"), val = parseFloat(String(e.target.value).replace(",", "."));
      var p = loadPortfolio();
      p.forEach(function (x) { if (x.id === pid) x.amount = val > 0 ? val : x.amount; });
      savePortfolio(p);
      render();
    }
    if (id === "repQ") {
      repPick.q = e.target.value;
      refreshReportCard();
      var sel = $("repQ"); if (sel) sel.focus();
    }
    if (id === "excludeIndex") {
      state.excludeIndex = e.target.checked;
      store("ff-exclude-index", state.excludeIndex);
      recomputeAll();
      render();
      var nf = quarterData().se ? quarterData().se.totals.funds : 0;
      toast(state.excludeIndex ? "Indexfonderna räknas bort · " + int(nf) + " fonder kvar" : "Alla fonder räknas med · " + int(nf) + " fonder");
    }
  });

  // ---------- Start ----------

  state.excludeIndex = !!store("ff-exclude-index");
  $("excludeIndex").checked = state.excludeIndex;
  setMarket(store("ff-market") || "se");
  // /rapport/2026-q2/utland/ visar rapporten för utländska aktier utan att ändra det sparade valet
  if (/^rapport\/[^\/]+\/utland$/.test(pageRoute)) state.market = "world";

  loadFront();
  getJSON("data/index.json").then(function (idx) {
    state.index = idx;
    var ids = idx.quarters.map(function (q) { return q.id; });
    if (!ids.length) throw new Error("Inga kvartal i index.json");
    var sel = $("quarter");
    sel.innerHTML = idx.quarters.map(function (q) {
      return '<option value="' + q.id + '" title="Jämfört med ' + quarterLabel(q.prevId) + '">' + quarterLabel(q.id) + "</option>";
    }).join("");
    sel.disabled = ids.length < 2;
    var saved = store("ff-quarter");
    var id = ids.indexOf(saved) >= 0 ? saved : ids[0];
    sel.value = id;
    return selectQuarter(id).then(function () {
      var st = history.state;
      if (st && st.scroll) window.scrollTo(0, st.scroll);
    });
  }).catch(function (err) {
    console.error(err);
    $("summary").textContent = "Kunde inte läsa data.";
    app.innerHTML = '<div class="notice">Datan kunde inte laddas. Försök igen om en stund.</div>';
  });
})();
