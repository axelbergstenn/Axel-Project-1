// Fondinsyn – klientlogik.
// Data byggs av scripts/build-data.ps1:
//   data/index.json            kvartal som finns
//   data/<kvartal>.json        svenska aktier + nyckeltal för alla fonder
//   data/<kvartal>-world.json  utländska aktier
//   data/history-se.json       ägande och nettoköp per svensk aktie sedan 2018
//   data/history-world.json    samma för utländska aktier
(function () {
  "use strict";

  var INDEX_RE = /index|indx|\bomx|passiv|tracker|\betf\b|\bzero\b|\baccess\b/i;

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

  function getJSON(url) {
    return fetch(url, { cache: "no-cache" }).then(function (r) {
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

  function marketWord() { return state.market === "se" ? "svenska" : "utländska"; }

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
  function reportCard(ds, cont, buys, sells) {
    var m = quarterData().meta, t = ds.totals, net = t.buy + t.sell;
    var pq = repPick.q || state.q, pm = repPick.market || state.market;
    var opts = state.index.quarters.map(function (x) {
      return '<option value="' + x.id + '"' + (x.id === pq ? " selected" : "") + ">" + quarterLabel(x.id) + "</option>";
    }).join("");
    var pick = function (v, label) { return '<button type="button" class="seg-btn" data-rep-pick="' + v + '" aria-pressed="' + (pm === v) + '">' + label + "</button>"; };
    return '<section class="rep-card"><div class="rc-main">' +
      '<p class="kicker">Kvartalsrapport ' + quarterLabel(m.id) + "</p>" +
      '<a class="rc-title" href="#/rapport">' + esc(quarterHeadline(cont, buys, sells)) + "</a>" +
      '<p class="rc-meta">Nettoköp ' + marketWord() + ' aktier <b class="' + cls(net) + '">' + bigSek(net, true) + "</b> · " + int(t.funds) + " fonder" +
      (state.excludeIndex ? " utan indexfonder" : "") + " · innehaven den " + dateText(m.curr) + "</p></div>" +
      '<div class="rc-controls" role="group" aria-label="Välj kvartalsrapport">' +
      '<select class="select-sm" id="repQ" aria-label="Kvartal">' + opts + "</select>" +
      '<div class="seg" role="group" aria-label="Marknad i rapporten">' + pick("se", "Sverige") + pick("world", "Utland") + "</div>" +
      repGoLinks(pq, pm) + "</div></section>";
  }
  function reportHref(q) { return q === state.q ? "#/rapport" : "#/rapport/" + q; }

  // ---------- Kvartalsrapporten som PDF ----------
  // PDF-filerna skapas av scripts/build-pdf.sh när sajten publiceras (Chrome skriver ut rapportsidan med ?pdf).
  // data/reports-pdf.json listar vilka som finns, t.ex. ["2026-q2", "2026-q2-utland"].
  function reportSlug(q) { return q.slice(0, 4) + "-q" + q.slice(5); }
  function pdfName(q, world) { return reportSlug(q) + (world ? "-utland" : ""); }
  function pdfHref(q, world) { return "/rapport/" + reportSlug(q) + "/fondinsyn-" + pdfName(q, world) + ".pdf"; }
  function hasPdf(q, world) {
    if (!need("pdfs", function () { return getJSON("data/reports-pdf.json").then(function (d) { state.pdfs = d; }, function () { state.pdfs = []; }); })) return false;
    return (state.pdfs || []).indexOf(pdfName(q, world)) >= 0;
  }
  // "Läs rapporten" öppnar PDF:en i en ny flik när den finns, annars webbversionen
  function repGoLinks(q, market) {
    var pdf = hasPdf(q, market === "world");
    return '<span class="rc-go"><a class="btn btn-primary" id="repGo" href="' + (pdf ? pdfHref(q, market === "world") : reportHref(q)) + '"' +
      (pdf ? ' target="_blank" rel="noopener" data-pdf="1"' : "") + ">Läs rapporten" + (pdf ? ' <span class="btn-tag">PDF</span>' : "") + "</a>" +
      (pdf ? '<a class="rc-web" id="repWeb" href="' + reportHref(q) + '">Webbversion</a>' : "") + "</span>";
  }
  function updateRepGo() {
    var box = document.querySelector(".rc-go");
    if (box) box.outerHTML = repGoLinks(repPick.q || state.q, repPick.market || state.market);
  }

  // Kvartalets nettoköp som en stor siffra, en mening som sätter den i perspektiv och staplar för tre år
  function heroFigure(net) {
    var head = '<div class="hero-figure"><div class="hf-label">Fondernas nettoköp <span>' + marketWord() + " aktier, " + quarterLabel(state.q) +
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
          return "<b>" + quarterLabel(p.q) + "</b><br>" + (p.value == null ? "Ingen data" : bigSek(p.value * 1e9, true));
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
    if (!ds) return failed("world-" + state.q) ? errorBlock() : loadingBlock("Laddar utländska aktier…");
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

    var top = buys[0], bottom = sells[0], longest = buyStreaks && buyStreaks[0];
    var highlights = '<div class="highlights">' +
      highlight("Mest köpt", top && top.name, top && stockHref(top), top ? '<span class="pos">' + bigSek(top.flow, true) + "</span>" : "", top ? int(top.nNew) + " nya fonder" : "") +
      highlight("Mest sålt", bottom && bottom.name, bottom && stockHref(bottom), bottom ? '<span class="neg">' + bigSek(bottom.flow, true) + "</span>" : "", bottom ? nFunds(bottom.nExit) + " sålde allt" : "") +
      (hasHist ? highlight("Längsta köpsvit", longest && longest.s.name, longest && stockHref(longest.s), longest ? longest.n + " kvartal i rad" : "Ingen", longest ? msek(longest.sum, true) + " mkr under perioden" : "")
        : highlight("Längsta köpsvit", null, null, '<span class="muted">Laddar…</span>', "")) +
      "</div>";

    return reportCard(ds, cont, buys, sells) + watchBlock() + signalModules() + '<div class="section-gap">' + highlights + "</div>" +
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

  // ---------- Marknadsremsan och startsidans signaler (data/front.json) ----------

  var RATE_SHORT = { SECBREPOEFF: "Styrränta", SEGVB10YC: "Statsobl. 10 år", SEMB5YCACOMB: "Bostadsobl. 5 år", SEGVB2YC: "Statsobl. 2 år" };
  // Bolagsnamn utan "AB" och "(publ)" i korta listor
  function shortCo(n) { return prettyName(n).replace(/\s*\(publ\)\s*$/i, "").replace(/\s+AB$/, ""); }
  function ratePp(v) { return v == null ? "" : Math.abs(v) < 0.005 ? "oförändrad" : signed(nf2.format(v), v) + " p.e."; }

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
      parts.push(item("#/rantor", RATE_SHORT[r[0]] || esc(r[1]), ratePct(r[2]), r[4] != null ? [ratePp(r[4]) + " på 1 år", ""] : null, r[1] + ", " + dateText(r[3])));
    });
    parts.push('<span class="tk-sep" aria-hidden="true"></span>');
    parts.push(item("#/rapport", "Fonderna " + esc(f.ql), bigSek(f.net, true), null, "Svenska fonders nettoköp av svenska aktier"));
    if (f.insider) parts.push(item("#/insyn", "Insiderköp 30 d", bigSek(f.insider.buy30), null, "Insiders köp de senaste 30 dagarna"));
    if (f.double) parts.push(item("#/dubbelsignal", "Dubbelsignal", int(f.double.buy) + " aktier", null, "Både fonder och insiders köper"));
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
      '<defs><linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" class="c-grad-top"/><stop offset="100%" class="c-grad-bottom"/></linearGradient></defs>' +
      '<path class="spark-area" d="' + line + "L" + W + " " + H + "L0 " + H + 'Z"/>' +
      '<path class="draw" pathLength="1" vector-effect="non-scaling-stroke" d="' + line + '"/></svg>';
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
        "Insiders köpte för <b>" + bigSek(ins.buy30) + "</b> och sålde för " + bigSek(ins.sell30) + " de senaste 30 dagarna.",
        insTop.length ? '<ul class="mod-list">' + insTop.slice(0, 4).map(function (r) {
          return "<li>" + name(r[0], r[1], esc(personName(r[2])) + (r[3] ? " · " + esc(r[3]) : "")) + '<span class="mod-v pos">' + bigSek(r[4]) + "</span></li>";
        }).join("") + "</ul>" : '<p class="desc">Inga större köp de senaste två veckorna.</p>'));
    }
    if (f.double) {
      out.push(mod("Dubbelsignal", "#/dubbelsignal", "Se listan",
        "<b>" + int(f.double.buy) + " aktier</b> köps av både fonder och bolagens egna insiders.",
        '<ul class="mod-list">' + f.double.top.slice(0, 4).map(function (r) {
          return "<li>" + name(r[0], r[1], "Fonder " + bigSek(r[2], true) + " · insiders " + bigSek(r[3], true)) + "</li>";
        }).join("") + "</ul>"));
    }
    if (f.shorts && f.shorts.length) {
      out.push(mod("Mest blankade", "#/blankning", "Blankning",
        "Andel av aktierna som lånats ut och sålts, enligt Finansinspektionen.",
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
          (policy[4] != null ? ", " + ratePp(policy[4]) + " på ett år" : "") + "</p>" : "") +
        (ten ? '<p class="desc">Statsobligation 10 år, senaste året</p>' + sparkline(ten[5]) : "") +
        '<div class="mod-rates">' + f.rates.filter(function (r) { return r !== policy; }).map(function (r) {
          return "<span>" + (RATE_SHORT[r[0]] || esc(r[1])) + "</span><b>" + ratePct(r[2]) + "</b>";
        }).join("") + "</div>"));
    }
    return out.length ? '<div class="modules section-gap">' + out.join("") + "</div>" : "";
  }

  function highlight(label, name, href, value, note) {
    return '<div class="hl"><div class="hl-label">' + label + "</div>" +
      (!name ? '<div class="hl-name muted">–</div>' : href ? '<a class="hl-name" href="' + href + '">' + esc(name) + "</a>" : '<div class="hl-name">' + esc(name) + "</div>") +
      '<div class="hl-value">' + value + "</div>" + (note ? '<div class="hl-note">' + note + "</div>" : "") + "</div>";
  }

  // ---------- Aktier ----------

  var stockFilter = { q: "", sector: "", min: "100" };

  function viewStocks() {
    document.title = (state.market === "world" ? "Utländska aktier" : "Svenska aktier") + " som fonderna äger – Fondinsyn";
    var ds = marketDs();
    if (!ds) return failed("world-" + state.q) ? errorBlock() : loadingBlock("Laddar utländska aktier…");
    var sectors = {};
    ds.stocks.forEach(function (s) { if (s.f2 || s.f1b) sectors[s.sector] = 1; });
    var sectorOpts = Object.keys(sectors).sort(function (a, b) { return a.localeCompare(b, "sv"); }).map(function (x) {
      return '<option value="' + esc(x) + '"' + (stockFilter.sector === x ? " selected" : "") + ">" + esc(x) + "</option>";
    }).join("");
    var minOpts = [["0", "Alla storlekar"], ["10", "Över 10 mkr"], ["100", "Över 100 mkr"], ["1000", "Över 1 000 mkr"]].map(function (o) {
      return '<option value="' + o[0] + '"' + (stockFilter.min === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
    }).join("");
    return '<div class="page-head"><h1>' + (state.market === "se" ? "Svenska aktier" : "Utländska aktier") + '</h1><p class="meta">Aktier som ägs av svenska fonder, ' +
      quarterLabel(state.q) + " jämfört med " + quarterLabel(quarterData().meta.prevId) + ".</p></div>" +
      '<div class="toolbar">' +
      '<input class="input" type="search" id="stockSearch" placeholder="Sök aktie eller ISIN" value="' + esc(stockFilter.q) + '" autocomplete="off">' +
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
    var cols = [nameWithSub].concat(world ? [col.country] : [], [col.sector, col.funds, col.dFunds, col.value, col.flow, col.chg]);
    $("stockTable").innerHTML = table("stocks-" + state.market, cols, rows, { csv: true, sort: { col: "flow", dir: -1 }, empty: "Inga aktier matchar filtret." });
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
    var crumbs = '<div class="crumbs"><a href="#/aktier" data-market="' + (world ? "world" : "se") + '">' + (world ? "Utländska aktier" : "Aktier") + "</a> / " + esc(name) + "</div>";
    var metaParts = [];
    if (s ? s.sector : hs.sector) metaParts.push(esc(s ? s.sector : hs.sector));
    if (world) metaParts.push(esc(countryName(s ? s.country : hs.country)));
    metaParts.push(esc(isin));
    if (s && s.price) metaParts.push("Kurs " + nf1.format(s.price) + " kr (" + esc(d.meta.curr) + ")");
    if (s && s.split) metaParts.push("Splitjusterad ×" + nf1.format(s.split));

    var html = '<div class="page-head">' + crumbs + '<div class="title-row"><div class="title-main">' + avatar(name) + '<h1>' + esc(name) + '</h1></div><div class="actions">' + starBtn("stocks", isin) + shareBtn("aktie", isin) + '</div></div><p class="meta">' + metaParts.join(" · ") + "</p></div>";
    html += alertForm(isin, name);

    if (s) {
      html += '<dl class="figures">' +
        fig("Fonder som äger", int(s.f2)) + fig("Fondernas innehav", s.price ? bigSek(s.val2) : "–", s.price ? "" : "kurs saknas") +
        fig("Nettoköp " + quarterLabel(state.q), s.netFlow == null || !s.price ? "–" : '<span class="' + cls(s.flow) + '">' + bigSek(s.flow, true) + "</span>") +
        fig("Δ antal aktier", '<span class="' + cls(s.chg) + '">' + pct(s.chg, true) + "</span>") +
        fig("Nya fonder", int(s.nNew)) + fig("Avvecklat", int(s.nExit)) + "</dl>";
      if (s.isNew) html += '<p class="notice">Ingen fond ägde aktien förra kvartalet. Det beror oftast på en notering, avknoppning eller ett nytt aktieslag, så innehaven räknas inte som köp i översikten.</p>';
      if (s.isGone) html += '<p class="notice">Ingen fond äger aktien längre. Det beror oftast på uppköp, avnotering eller byte av aktieslag.</p>';
      html += stockSignalPanel(s);
    }

    // Uppköpserbjudanden på bolaget
    if (needOffers()) {
      offersFor(isin).forEach(function (o) {
        html += '<div class="notice offer-notice"><b>Uppköpserbjudande ' + o.date + "</b> från " + esc(o.bidder) +
          (o.price != null ? ", " + offerPriceText(o) + " per aktie" : "") + (o.premium != null ? " (premie " + nf1.format(o.premium) + " %)" : "") +
          '. <a href="#/uppkop/' + encodeURIComponent(o.id) + '">Se vilka fonder som ägde bolaget</a></div>';
      });
    }

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
            return "<b>" + quarterLabel(p.q) + "</b><br>" + (p.value == null ? "Ingen data" : '<span class="' + cls(p.value) + '">' + msek(p.value, true) + " mkr</span>");
          } });
        }) + "</div>" +
        '<div class="chart-card"><div class="chart-title">Antal fonder som äger</div>' +
        chart(function (node) {
          FFCharts.line(node, pts.map(function (p) { return { q: p.q, value: p.funds, val: p.val }; }), {
            format: function (v) { return int(v); },
            tip: function (p) { return "<b>" + quarterLabel(p.q) + "</b><br>" + (p.value == null ? "Inga fonder" : int(p.value) + " fonder<br>Innehav " + msek(p.val) + " mkr"); }
          });
        }) + "</div></div>";
      html += "</section>";
    }

    html += stockShortSection(isin);
    html += stockInsiderSection(isin);

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

  // ---------- Fonder ----------

  var fundFilter = { q: "", co: "", type: "" };

  function fundList() {
    var d = quarterData();
    return Object.keys(d.fi).map(function (id) { return d.fi[id]; });
  }

  function viewFunds() {
    document.title = "Fonder – innehav, avgifter och affärer – Fondinsyn";
    var ds = marketDs();
    if (!ds) return failed("world-" + state.q) ? errorBlock() : loadingBlock("Laddar utländska aktier…");
    var cos = {};
    fundList().forEach(function (f) { cos[f.co] = 1; });
    var coOpts = Object.keys(cos).sort(function (a, b) { return a.localeCompare(b, "sv"); }).map(function (x) {
      return '<option value="' + esc(x) + '"' + (fundFilter.co === x ? " selected" : "") + ">" + esc(x) + "</option>";
    }).join("");
    var opt = function (o) { return '<option value="' + o[0] + '"' + (fundFilter.type === o[0] ? " selected" : "") + ">" + o[1] + "</option>"; };
    var typeOpts = opt(["", "Alla fonder"]) +
      '<optgroup label="Aktiefonder">' + [["equity", "Alla aktiefonder"], ["active", "Aktiva aktiefonder"], ["index", "Indexfonder"], ["closet", "Indexnära med hög avgift"]].map(opt).join("") + "</optgroup>" +
      '<optgroup label="Andra fonder">' + [["rante", "Räntefonder"], ["bland", "Blandfonder"], ["fof", "Fondandelsfonder"]].map(opt).join("") + "</optgroup>";
    return '<div class="page-head"><div class="title-row"><h1>Fonder</h1><a class="btn" href="#/fondbolag">Alla fondbolag</a></div><p class="meta">Alla svenska värdepappersfonder, ' + quarterLabel(state.q) + ". Köp och sälj avser " + marketWord() + " aktier.</p></div>" +
      '<div class="toolbar">' +
      '<input class="input" type="search" id="fundSearch" placeholder="Sök fond eller fondbolag" value="' + esc(fundFilter.q) + '" autocomplete="off">' +
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
    $("fundTable").innerHTML = table("funds-" + state.market, cols, rows, { csv: true, sort: { col: "mv", dir: -1 }, empty: "Inga fonder matchar filtret." });
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
      { label: "Utländska aktier", v: wF ? wF.val || 0 : 0, ready: hasWorld },
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
    if (!hasWorld) parts.push({ v: -1, html: '<section class="block section-gap"><div class="block-head"><h2>Utländska aktier</h2></div>' + (failed("world-" + state.q) ? errorBlock() : loadingBlock()) + "</section>" });
    else if (wF && wF.h.length) parts.push({ v: wF.val || 0, html: fundHoldings(f, wF, "Utländska aktier", wds, d.meta) });
    if (hasBonds) parts.push({ v: rx.bond, html: fundBondSection(f, rx, rrows) });
    if (hasUnits) parts.push({ v: rx.unit, html: fundUnitSection(f, rx, rrows) });
    parts.sort(function (a, b) { return b.v - a.v; });
    return html + parts.map(function (p) { return p.html; }).join("");
  }

  // Alla köp och sälj en fond gjort under kvartalet: aktier, räntepapper och fondandelar
  var fundTradeFilter = "all";
  function fundTradesView(info, seF, wF, wds, hasWorld, meta, rx, rrows) {
    var rows = [];
    [[seF, quarterData().se, "Svenska aktier"], [wF, wds, "Utländska aktier"]].forEach(function (x) {
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
    var cols = [
      { key: "name", label: "Innehav", align: "l", cls: "name", cell: function (r) {
        return nameOf(r) + (r.sub ? '<span class="sub">' + esc(r.sub) + "</span>" : "") + '<span class="sub show-sm">' + changeLabel(r.s1, r.s2) + " " + esc(r.m) + "</span>";
      }, value: function (r) { return r.name; } },
      { key: "chg", label: "Ändring", align: "l", hideSm: true, cell: function (r) { return changeLabel(r.s1, r.s2); } },
      { key: "n", label: "Antal före och efter", hideSm: true, cell: function (r) { return r.n ? int(r.s1) + " → " + int(r.s2) : "–"; } },
      { key: "d", label: "Förändring (mkr)", cell: function (r) { return '<span class="' + cls(r.d) + '">' + mkr(r.d, true) + "</span>"; }, value: function (r) { return r.d; } },
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
    document.title = "Avgifter – Fondinsyn";
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
    var points = funds.map(function (f) { return { x: f.ar, y: f.feeMax, cat: f.cat, f: f }; });

    var listRows = feeFilter.list === "closet" ? closet : funds;
    var cols = [
      { key: "name", label: "Fond", align: "l", cls: "name", value: function (f) { return f.name; }, cell: function (f) {
        return nameCell(fundHref(f), f.name, esc(f.co) + " · aktiv risk " + pctPlain(f.ar)) + (feeFilter.list !== "closet" ? " " + catLabel(f.cat, true) : "");
      } },
      { key: "co", label: "Fondbolag", align: "l", cls: "muted", hideSm: true, cell: function (f) { return esc(f.co); }, value: function (f) { return f.co; } },
      { key: "fee", label: "Avgift", cell: function (f) { return nf2.format(f.feeMax) + " %"; }, value: function (f) { return f.feeMax; } },
      { key: "ar", label: "Aktiv risk", hideSm: true, cell: function (f) { return pctPlain(f.ar); }, value: function (f) { return f.ar; } },
      { key: "r5", label: "Per år, 5 år", hideSm: true, cell: function (f) { var p = hasPerf && perfOf(f.id); return p ? retText(p[3]) : "–"; },
        value: function (f) { var p = hasPerf && perfOf(f.id); return p ? p[3] : null; } },
      { key: "t5", label: "Totalt, 5 år", hideSm: true, cell: function (f) { var p = hasPerf && perfOf(f.id); return p ? retApprox(total5(p)) : "–"; },
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
      '<div class="legend">' + catLabel("closet") + catLabel("active") + catLabel("index") + "</div>" +
      '<div class="chart-card">' + chart(function (node) {
        FFCharts.scatter(node, points, {
          height: node.clientWidth < 500 ? 320 : 400,
          xMax: maxAr, yMax: maxFee, top: "closet",
          zone: { x: CLOSET_AR, y: CLOSET_FEE, label: "Indexnära men dyr" },
          xLabel: "Aktiv risk, % (avvikelse mot jämförelseindex)", yLabel: "Avgift, %",
          tip: function (p) {
            return "<b>" + esc(p.f.name) + "</b><br>" + esc(p.f.co) + "<br>Avgift " + feeText(p.f) + " · Aktiv risk " + pctPlain(p.f.ar) + "<br>" + bigSek(p.f.aum);
          },
          onClick: function (p) { location.hash = fundHref(p.f); }
        });
      }) + "</div></section>" +
      '<section class="block section-gap"><div class="block-head"><h2>' + (feeFilter.list === "closet" ? "Indexnära fonder med hög avgift" : "Alla aktiefonder") + "</h2>" +
      '<div class="seg" role="group" aria-label="Lista">' + seg("list", "closet", "Indexnära", feeFilter.list) + seg("list", "all", "Alla", feeFilter.list) + "</div></div>" +
      table("fees-" + feeFilter.list, cols, listRows, { csv: true, sort: { col: "cost", dir: -1 }, empty: "Inga fonder i urvalet." }) + "</section>" +
      '<section class="block section-gap prose"><h2>Så ska du läsa det</h2>' +
      "<p><b>Aktiv risk</b> (tracking error) mäter hur mycket fondens avkastning har avvikit från jämförelseindex de senaste 24 månaderna. En indexfond ligger nära 0 %. En vanlig tumregel är att en fond under 3 % i praktiken följer index ganska nära.</p>" +
      "<p><b>Avgift</b> är den högsta fasta förvaltningsavgiften bland fondens andelsklasser, vilket oftast är den som privatpersoner betalar. Prestationsbaserade avgifter ingår inte.</p>" +
      "<p>Låg aktiv risk är inte fel i sig, men då bör avgiften vara låg. Siffrorna rapporteras av fondbolagen till Finansinspektionen. Endast aktiefonder (minst 80 % aktier, inga bland- eller generationsfonder) med över 100 mkr i förmögenhet visas.</p></section>";
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
  function shareBtn(kind, key) {
    if (!pageMap) { pageMap = {}; getJSON("data/pages.json").then(function (p) { pageMap = p; }, function () {}); }
    return '<button type="button" class="btn" data-share="' + kind + "|" + esc(key) + '">Dela</button>';
  }
  function shareUrl(kind, key) {
    var slug = pageMap && pageMap[kind] && pageMap[kind][key];
    return slug ? location.origin + "/" + kind + "/" + slug + "/" : location.href;
  }
  function share(btn) {
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
    return '<div class="watch ' + (parts.length > 1 ? "grid-2" : "") + '">' + parts.join("") + "</div>";
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
      "vad du betalar i avgifter och om dina fonder äger samma saker. Portföljen sparas bara i din webbläsare.</p></div>";
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
      row(termLink("avkastning", "Avkastning per år, 5 år"), function (f) { var p = needPerf() && perfOf(f.id); return p ? retText(p[3]) : "–"; }) +
      row("Total avkastning, 5 år", function (f) { var p = needPerf() && perfOf(f.id); return p ? retApprox(total5(p)) : "–"; }) +
      row("Jämförelseindex", function (f) { return esc(f.bench || "–"); }) +
      "</tbody></table></div>" +
      '<section class="block section-gap"><div class="block-head"><h2>Gemensamma innehav</h2><span class="note">Andel av fondernas aktieinnehav</span></div>' +
      table("cmp-common", [
        { key: "name", label: "Aktie", align: "l", cls: "name", cell: function (c) { return nameCell(stockHref(c.s), c.s.name, ""); } },
        { key: "a", label: esc(shortName(A.name)), cell: function (c) { return pw(c.wa); } },
        { key: "b", label: esc(shortName(B.name)), cell: function (c) { return pw(c.wb); } }
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

  function shortName(n) { return n.length > 22 ? n.slice(0, 20) + "…" : n; }

  // ---------- Sök ----------

  var search = { open: false, sel: 0, items: [] };

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
    return -1;
  }

  function runSearch() {
    var q = $("searchInput").value.trim().toLowerCase();
    var d = quarterData(), items = [];
    if (!q) {
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
      var pages = [["Räntor", "#/rantor"], ["Dubbelsignal", "#/dubbelsignal"], ["Räntefonder", "#/fonder/rantefonder"], ["Fondbolag", "#/fondbolag"],["Ordlista och vanliga frågor", "#/ordlista"], ["Blankning", "#/blankning"], ["Blankare", "#/blankare"], ["Kvartalsrapport", "#/rapport"], ["Uppköp", "#/uppkop"], ["Avgiftskollen", "#/avgifter"], ["Kända förvaltare", "#/forvaltare"], ["Min fondportfölj", "#/portfolj"], ["Jämför fonder", "#/jamfor"], ["Om datan", "#/om"], ["Kontakt", "#/kontakt"]];
      pages.forEach(function (pg) { if (scoreMatch(pg[0], q) >= 0) items.push({ kind: "Sidor", label: pg[0], sub: "", href: pg[1] }); });
    }
    search.items = items;
    search.sel = 0;
    var html = "", last = "";
    items.forEach(function (it, i) {
      if (it.kind !== last) { html += '<li class="sr-group" role="presentation">' + it.kind + "</li>"; last = it.kind; }
      html += '<li role="option" id="sr-' + i + '" class="sr-item" data-sr="' + i + '"' + (i === 0 ? ' aria-selected="true"' : "") + '>' + (/^(Aktier|Fonder|Fondbolag|Bevakade)$/.test(it.kind) ? avatar(it.label, true) : "") + '<span class="sr-label">' + esc(it.label) + "</span>" +
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
    closeSearch();
    location.hash = it.href;
  }

  // ---------- Uppköp ----------

  // ---------- Avkastning (Pensionsmyndigheten) ----------

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
  function cleanTarget(t) { return t ? prettyName(String(t).replace(/\s*\(publ\)\s*/ig, " ").replace(/\s+/g, " ").trim()) : null; }
  function offerUrl(o) { return "https://www.fi.se/sv/vara-register/prospektregistret/details?id=" + encodeURIComponent(o.id); }
  function offersFor(isin) {
    return state.offers ? state.offers.offers.filter(function (o) { return o.isins && o.isins.indexOf(isin) >= 0; }) : [];
  }

  // Status utifrån historiken: finns aktien kvar i fonderna eller försvann den efter budet?
  function offerStatus(o) {
    var h = state.history;
    if (!h || !o.isins || !o.isins.length) return null;
    var last = -1;
    o.isins.forEach(function (isin) {
      var e = h.stocks[isin];
      if (e) e[3].forEach(function (r) { if (r[1] > 0 && r[0] > last) last = r[0]; });
    });
    if (last < 0) return null;
    var latest = h.quarters.length - 1, offerQ = h.qIndex[o.quarter];
    if (last >= latest) return { gone: false, label: "Ägs fortfarande av fonder" };
    if (offerQ != null && last < offerQ) return null;
    return { gone: true, label: "Borta ur fonderna efter " + quarterLabel(h.quarters[last]) };
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
      { key: "status", label: "Status", align: "l", hideSm: true, cell: function (o) { var s = offerStatus(o); return s ? '<span class="label' + (s.gone ? " out" : "") + '">' + s.label + "</span>" : "–"; } },
      { key: "more", label: "", cell: function (o) { return '<a href="#/uppkop/' + encodeURIComponent(o.id) + '">Detaljer</a>'; } }
    ];
    var winCols = [
      { key: "name", label: "Fond", align: "l", cls: "name", cell: function (f) { return nameCell(fundHref(f), f.name, f.targets.slice(0, 4).join(", ")); } },
      { key: "n", label: "Uppköpta innehav", cell: function (f) { return '<span class="streak pos">' + f.n + "</span>"; } },
      { key: "v", label: "Värde vid budet", cell: function (f) { return bigSek(f.v); } },
      { key: "t", label: "Bolag", align: "l", cls: "muted", hideSm: true, cell: function (f) { return esc(f.targets.slice(0, 4).join(", ") + (f.targets.length > 4 ? " …" : "")); } }
    ];

    return head +
      '<div class="highlights">' +
      highlight("Uppköpserbjudanden", int(offers.length) + " bud", null, years.length ? "sedan " + years[0] : "", "Godkända erbjudandehandlingar hos FI") +
      highlight("Mittenvärde för budpremien", medPrem != null ? nf1.format(medPrem) + " %" : "–", null, "", "Mot stängningskursen dagen före budet, " + prem.length + " bud") +
      highlight("Flest uppköpta innehav", top ? top.name : null, top ? fundHref(top) : null, top ? top.n + " bolag som fått bud" : "", top ? "ägda kvartalet före budet" : "") +
      "</div>" +
      '<section class="block section-gap"><div class="block-head"><h2>Alla bud</h2><span class="note">' + int(withTarget.length) + " av " + int(offers.length) + " med identifierat målbolag</span></div>" +
      table("offers", cols, offers, { csv: true, sort: { col: "date", dir: -1 } }) + "</section>" +
      '<section class="block section-gap"><div class="block-head"><h2>Fonderna som oftast ägt uppköpta bolag</h2></div>' +
      '<p class="desc">Antal bolag som fonden ägde vid kvartalsslutet före budet. Indexfonder, blandfonder och fonder med aktiv risk under 1,5 % är borträknade.</p>' +
      table("offer-winners", winCols, winners, { static: true, empty: "Inga fonder." }) + "</section>" +
      '<p class="desc section-gap">Källa: Finansinspektionens prospektregister. Målbolag, pris och premie läses automatiskt ur erbjudandehandlingarna och kan i enstaka fall bli fel. ' +
      "Bud på First North och andra marknader utan krav på godkänd erbjudandehandling saknas.</p>";
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
      '<dl class="figures">' + fig("Pris per aktie", offerPriceText(o)) + fig("Premie", o.premium != null ? nf1.format(o.premium) + " %" : "–", "mot stängningskursen före budet") +
      fig("Fonder som ägde", int(o.holders.length), quarterLabel(o.quarter)) + fig("Fondernas innehav", bigSek(o.held)) +
      fig("Status", st ? st.label : "–") + "</dl>" +
      '<p class="actions-row">' + (o.isins && o.isins.length ? '<a class="btn" href="#/aktie/' + o.isins[0] + '">Aktiens sida och historik</a> ' : "") +
      '<a class="btn" href="' + offerUrl(o) + '" target="_blank" rel="noopener">Erbjudandehandlingen hos FI ↗</a></p>' +
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
  var insiderFilter = { kind: "buy", min: 100000, period: "90" };
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
  function personText(r) { return esc(personName(r.person)) + (r.close ? " (närstående)" : ""); }

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
            tip: function (p) { return "<b>" + monthLabel(p.m, true) + "</b><br>" + (p.value == null ? "Ingen data" : '<span class="' + cls(p.value) + '">' + bigSek(p.value * 1e9, true) + "</span>"); } });
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

  // ---------- Samlad signal ----------
  // Väger ihop tre saker som redan finns på sajten: fondernas köp och sälj under kvartalet (40 %), insidernas köp minus
  // sälj de senaste 90 dagarna (40 %) och hur blankningen ändrats de senaste 30 dagarna (20 %). Varje del blir ett tal
  // mellan −1 och 1, och summan skalas till −100 … +100. Det är ett sätt att se var flera signaler pekar åt samma håll,
  // inte en rekommendation.

  var SIGNAL_MIN_VALUE = 50e6; // aktier där fonderna äger minst 50 mkr
  function clamp1(v) { return Math.max(-1, Math.min(1, v)); }

  function signalFor(s, insBy) {
    var fb = 0, fs = 0;
    s.trades.forEach(function (t) { if (t.d > 0) fb++; else if (t.d < 0) fs++; });
    var breadth = fb + fs ? (fb - fs) / (fb + fs) : 0;
    var mag = s.chg == null ? 0 : clamp1(s.chg / 0.1);
    var F = (breadth + mag) / 2;
    if (fb + fs < 3) F *= 0.5;
    var e = insBy[s.isin], inet = e ? e.buy - e.sell : 0;
    var I = Math.abs(inet) < 2e5 ? 0 : clamp1(inet / 5e6);
    var a = state.shorts && state.shorts.byIsin[s.isin];
    var S = a && a.ch30 != null ? clamp1(-a.ch30 / 1) : 0;
    return { s: s, score: Math.round(100 * (0.4 * F + 0.4 * I + 0.2 * S)), F: F, I: I, S: S, fb: fb, fs: fs, inet: e ? inet : null, nIns: e ? e.n : 0, short: a || null };
  }
  function insiderTotals() {
    var by = {};
    state.insider.rows.forEach(function (r) {
      if (r.sek == null || r.kind === "other") return;
      var e = by[r.isin] = by[r.isin] || { buy: 0, sell: 0, n: 0 };
      if (r.kind === "buy") e.buy += r.sek; else e.sell += r.sek;
      e.n++;
    });
    return by;
  }
  function allSignals() {
    var insBy = insiderTotals();
    return quarterData().se.stocks.filter(function (s) { return s.netFlow != null && s.price && Math.max(s.val1, s.val2) >= SIGNAL_MIN_VALUE; })
      .map(function (s) { return signalFor(s, insBy); });
  }
  function signalWord(v) { return v >= 40 ? "Starkt positiv" : v >= 15 ? "Positiv" : v > -15 ? "Neutral" : v > -40 ? "Negativ" : "Starkt negativ"; }
  function signalBadge(v) {
    var c = v >= 40 ? "sp2" : v >= 15 ? "sp1" : v > -15 ? "s0" : v > -40 ? "sn1" : "sn2";
    return '<span class="sig ' + c + '" title="' + signalWord(v) + '"><b>' + (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v) + "</b></span>";
  }
  function signalMeter(v) {
    var w = Math.abs(v) / 2;
    return '<span class="sig-meter" aria-hidden="true"><i class="' + (v >= 0 ? "pos" : "neg") + '" style="width:' + w + "%;" + (v >= 0 ? "left:50%" : "right:50%") + '"></i></span>';
  }
  function partText(g, which) {
    if (which === "F") return (g.fb || g.fs ? g.fb + " köpte, " + g.fs + " sålde" : "Inga affärer") + (g.s.chg != null ? " · aktier " + pct(g.s.chg) : "");
    if (which === "I") return g.inet == null ? "Ingen handel" : (g.inet >= 0 ? "Köp minus sälj " : "Sälj minus köp ") + bigSek(Math.abs(g.inet));
    return g.short ? nf2.format(g.short.pct) + " % blankat" + (g.short.ch30 == null ? "" : Math.abs(g.short.ch30) < 0.005 ? ", oförändrat på 30 dagar" : ", " + signed(nf2.format(g.short.ch30), g.short.ch30) + " p.e. på 30 dagar") : "Ingen större blankning";
  }
  // En liten färgad punkt per del: grön (positiv), röd (negativ) eller grå (neutral)
  function partArrow(v) { return '<span class="part ' + (v > 0.05 ? "pos" : v < -0.05 ? "neg" : "") + '" aria-hidden="true"></span>'; }

  function viewSignals() {
    document.title = "Samlad signal – fonder, insiders och blankning ihop – Fondinsyn";
    var head = '<div class="page-head"><h1>Samlad signal</h1><p class="meta lead">Fondernas köp och sälj, insidernas affärer och blankningen vägda ihop till ett tal per aktie, ' +
      "från −100 till +100. Ett sätt att se var flera signaler pekar åt samma håll. Det är inte en rekommendation att köpa eller sälja.</p></div>";
    var okI = needInsider(), okS = needShorts();
    if (!okI || !okS) return head + (failed("insider") || failed("shorts") ? errorBlock() : loadingBlock("Laddar insynshandel och blankning…"));
    var all = allSignals();
    var pos = all.filter(function (g) { return g.score > 0; }).sort(function (a, b) { return b.score - a.score; });
    var neg = all.filter(function (g) { return g.score < 0; }).sort(function (a, b) { return a.score - b.score; });
    var cols = [
      { key: "name", label: "Aktie", align: "l", cls: "name", cell: function (g) {
        return nameCell(stockHref(g.s), g.s.name, partArrow(g.F) + " Fonder " + partArrow(g.I) + " Insiders " + partArrow(g.S) + " Blankning");
      }, value: function (g) { return g.s.name; }, csv: function (g) { return g.s.name; } },
      { key: "score", label: "Signal", cell: function (g) { return '<span class="sig-cell">' + signalMeter(g.score) + signalBadge(g.score) + "</span>"; }, value: function (g) { return g.score; }, csv: function (g) { return g.score; } },
      { key: "F", label: "Fonderna " + quarterLabel(state.q), align: "l", hideSm: true, cell: function (g) { return partArrow(g.F) + " " + partText(g, "F"); }, value: function (g) { return g.F; } },
      { key: "I", label: "Insiders 90 dagar", align: "l", hideSm: true, cell: function (g) { return partArrow(g.I) + " " + partText(g, "I"); }, value: function (g) { return g.I; } },
      { key: "S", label: "Blankning", align: "l", hideSm: true, cell: function (g) { return partArrow(g.S) + " " + partText(g, "S"); }, value: function (g) { return g.S; } }
    ];
    var strong = function (list, lim) { return list.filter(function (g) { return Math.abs(g.score) >= lim; }).length; };
    return head +
      '<dl class="figures">' + fig("Aktier med signal", int(all.length), "fonderna äger minst 50 mkr") +
      fig("Starkt positiva", '<span class="pos">' + int(strong(pos, 40)) + "</span>", "+40 eller mer") +
      fig("Starkt negativa", '<span class="neg">' + int(strong(neg, 40)) + "</span>", "−40 eller lägre") + "</dl>" +
      '<div class="stack">' +
      block("Starkast positiva", "Aktier där fonderna köper, insiders köper och blankningen minskar.", table("sig-pos", cols, pos.slice(0, 25), { csv: true, sort: { col: "score", dir: -1 } })) +
      block("Starkast negativa", "Aktier där fonderna säljer, insiders säljer och blankningen ökar.", table("sig-neg", cols, neg.slice(0, 25), { csv: true, sort: { col: "score", dir: 1 } })) +
      "</div>" +
      '<section class="block section-gap text-page"><div class="block-head"><h2>Så räknas signalen</h2></div>' +
      "<p><b>Fonderna (40 %).</b> Hälften är hur många fonder som ökade jämfört med hur många som minskade i aktien under " + quarterLabel(state.q) +
      ", hälften hur mycket fondernas antal aktier ändrades (±10 % ger fullt utslag). Färre än tre fonder som handlat ger halv vikt.</p>" +
      "<p><b>Insiders (40 %).</b> Köp minus sälj i bolaget de senaste 90 dagarna enligt Finansinspektionens insynsregister. Under 200 000 kr räknas som brus, 5 mkr ger fullt utslag.</p>" +
      "<p><b>Blankning (20 %).</b> Hur den blankade andelen ändrats de senaste 30 dagarna. En procentenhet mindre blankning ger fullt positivt utslag, en mer fullt negativt.</p>" +
      "<p>Delarna blir tal mellan −1 och 1 och vägs ihop till en signal mellan −100 och +100. Bara svenska aktier där fonderna äger minst 50 mkr är med.</p></section>";
  }

  // Panelen på aktiesidan
  function stockSignalPanel(s) {
    if (!s || s.netFlow == null || !s.price || s.isin.slice(0, 2) !== "SE") return "";
    if (!needInsider() || !needShorts()) return "";
    var g = signalFor(s, insiderTotals());
    var row = function (label, v, which) { return '<li><span class="sp-l">' + partArrow(v) + " " + label + '</span><span class="sp-t">' + partText(g, which) + "</span></li>"; };
    return '<section class="signal-panel"><div class="sp-head"><div><p class="kicker">Samlad signal</p><p class="sp-word">' + signalWord(g.score) + "</p></div>" +
      '<div class="sp-score">' + signalBadge(g.score) + signalMeter(g.score) + "</div></div>" +
      '<ul class="sp-parts">' + row("Fonderna", g.F, "F") + row("Insiders", g.I, "I") + row("Blankning", g.S, "S") + "</ul>" +
      '<a class="more" href="#/signaler">Så räknas signalen</a></section>';
  }

  // ---------- Dubbelsignal ----------
  // Aktier där både fonderna (kvartalets nettoköp) och bolagets egna insiders (köp minus sälj) går åt samma håll.
  var doubleFilter = { period: "90" };
  var DOUBLE_MIN_FUND = 1e6, DOUBLE_MIN_INSIDER = 5e5; // under 1 mkr respektive 500 000 kr räknas som brus

  function doubleSignals() {
    var I = state.insider, ds = quarterData().se, by = {};
    var yearMode = doubleFilter.period === "365" && state.insiderYear;
    if (yearMode) {
      state.insiderYear.rows.forEach(function (y) { by[y[0]] = { buy: y[2], sell: y[3], nBuyers: y[4], last: null }; });
    } else {
      I.rows.forEach(function (r) {
        if (r.sek == null || r.kind === "other") return;
        var e = by[r.isin] = by[r.isin] || { buy: 0, sell: 0, buyers: {}, last: null };
        if (r.kind === "buy") { e.buy += r.sek; e.buyers[r.person] = 1; if (!e.last || r.tx > e.last) e.last = r.tx; } else e.sell += r.sek;
      });
      Object.keys(by).forEach(function (k) { by[k].nBuyers = Object.keys(by[k].buyers).length; });
    }
    var rows = [];
    ds.stocks.forEach(function (s) {
      var e = by[s.isin];
      if (!e || s.netFlow == null) return;
      var net = e.buy - e.sell;
      if (Math.abs(s.flow) < DOUBLE_MIN_FUND || Math.abs(net) < DOUBLE_MIN_INSIDER || (s.flow > 0) !== (net > 0)) return;
      var nb = 0, nsell = 0;
      s.trades.forEach(function (t) { if (t.d > 0) nb++; else if (t.d < 0) nsell++; });
      rows.push({ s: s, flow: s.flow, net: net, buy: e.buy, sell: e.sell, nBuyers: e.nBuyers, last: e.last, fb: nb, fs: nsell });
    });
    return { buy: rows.filter(function (x) { return x.flow > 0; }), sell: rows.filter(function (x) { return x.flow < 0; }) };
  }

  function viewDouble() {
    document.title = "Dubbelsignal – när både fonder och insiders köper – Fondinsyn";
    var head = '<div class="page-head"><h1>Dubbelsignal</h1><p class="meta lead">Aktier där både fonderna och bolagets egna insiders har köpt, eller där båda har sålt. ' +
      "Fondernas affärer gäller " + quarterLabel(state.q) + ", insidernas köp och sälj kommer från Finansinspektionens insynsregister.</p></div>";
    if (!needInsider()) return head + (failed("insider") ? errorBlock() : loadingBlock("Laddar insynshandel…"));
    var yearMode = doubleFilter.period === "365";
    if (yearMode && !need("insider-year", function () { return getJSON("data/insider-year.json").then(function (x) { state.insiderYear = x; }); })) {
      return head + (failed("insider-year") ? errorBlock() : loadingBlock());
    }
    var sig = doubleSignals();
    var period = yearMode ? "12 månader" : state.insider.days + " dagar";
    var cols = function (sell) {
      return [
        { key: "n", label: "Aktie", align: "l", cls: "name", value: function (x) { return x.s.name; }, cell: function (x) {
          return nameCell(stockHref(x.s), x.s.name, (sell ? int(x.fs) + " fonder sålde" : int(x.fb) + " fonder köpte") + " · insiders " + bigSek(x.net, true));
        } },
        { key: "f", label: "Fonderna " + quarterLabel(state.q), cell: function (x) { return '<span class="' + cls(x.flow) + '">' + bigSek(x.flow, true) + "</span>"; }, value: function (x) { return x.flow; } },
        { key: "fn", label: sell ? "Fonder som sålt" : "Fonder som köpt", hideSm: true, cell: function (x) { return int(sell ? x.fs : x.fb) + '<span class="vote-other"> / ' + int(sell ? x.fb : x.fs) + "</span>"; }, value: function (x) { return sell ? x.fs : x.fb; } },
        { key: "i", label: "Insiders " + period, cell: function (x) { return '<span class="' + cls(x.net) + '">' + bigSek(x.net, true) + "</span>"; }, value: function (x) { return x.net; } },
        { key: "ib", label: "Insiderköpare", hideSm: true, cell: function (x) { return int(x.nBuyers); }, value: function (x) { return x.nBuyers; } },
        { key: "d", label: "Senaste köp", hideSm: true, cls: "muted", cell: function (x) { return x.last ? esc(x.last) : "–"; }, value: function (x) { return x.last; } }
      ];
    };
    var pseg = function (v, label) { return '<button type="button" class="seg-btn" data-double-period="' + v + '" aria-pressed="' + (doubleFilter.period === v) + '">' + label + "</button>"; };
    var top = sig.buy.slice().sort(function (a, b) { return b.net - a.net; })[0];
    var html = head + '<div class="highlights">' +
      highlight("Dubbel köpsignal", int(sig.buy.length) + " aktier", null, "fonder och insiders köper", "") +
      highlight("Dubbel säljsignal", int(sig.sell.length) + " aktier", null, "fonder och insiders säljer", "") +
      highlight("Mest köpt av insiders", top && top.s.name, top ? stockHref(top.s) : null, top ? '<span class="pos">' + bigSek(top.net, true) + "</span>" : "", top ? "insiders, och fonderna " + bigSek(top.flow, true) : "") +
      "</div>" +
      '<div class="toolbar section-gap"><div class="seg" role="group" aria-label="Period för insidernas affärer">' + pseg("90", "Insiders 90 dagar") + pseg("365", "Insiders 12 månader") + "</div></div>" +
      block("Både fonder och insiders köper", "Fonderna nettoköpte för minst 1 mkr under " + quarterLabel(state.q) + " och insiders köpte för minst 500 000 kr mer än de sålde de senaste " + (yearMode ? "12 månaderna" : state.insider.days + " dagarna") + ".",
        table("double-buy", cols(false), sig.buy, { sort: { col: "i", dir: -1 }, limit: 25, expand: true, csv: true, empty: "Inga aktier med dubbel köpsignal just nu." })) +
      block("Både fonder och insiders säljer", "Fonderna nettosålde och insiders sålde mer än de köpte under samma period.",
        table("double-sell", cols(true), sig.sell, { sort: { col: "i", dir: 1 }, limit: 25, expand: true, csv: true, empty: "Inga aktier med dubbel säljsignal just nu." }), "section-gap") +
      '<p class="desc section-gap">Så räknas det: fondernas nettoköp är förändringen i antal aktier gånger kursen vid kvartalets slut, bara för fonder som rapporterat båda kvartalen. ' +
      "Insidernas netto är köp minus sälj i kronor enligt insynsregistret. Insiders kan sälja av skäl som skatt, lån eller optionsprogram, och fondernas affärer kan spegla in- och utflöden. " +
      "En dubbelsignal är alltså en intressant observation, inte en köp- eller säljrekommendation.</p>";
    return html;
  }

  function viewInsider() {
    document.title = "Insynshandel – Fondinsyn";
    var head = '<div class="page-head"><h1>Insynshandel</h1><p class="meta lead">Köp och sälj som vd:ar, styrelseledamöter och andra i ledande ställning har gjort i sina egna bolag. ' +
      "Från Finansinspektionens insynsregister, uppdateras varje morgon. " + termLink("insynshandel", "Vad är insynshandel?") + "</p></div>";
    if (!needInsider()) return head + (failed("insider") ? errorBlock() : loadingBlock("Laddar insynshandel…"));
    var I = state.insider, ds = quarterData().se, since30 = daysAgo(30);
    var sum = function (list) { return list.reduce(function (a, r) { return a + (r.sek || 0); }, 0); };
    var buys30 = I.rows.filter(function (r) { return r.kind === "buy" && r.tx >= since30; });
    var sells30 = I.rows.filter(function (r) { return r.kind === "sell" && r.tx >= since30; });

    // Per bolag under hela perioden: köpt, sålt och hur många olika personer som köpt
    var by = {};
    I.rows.forEach(function (r) {
      if (r.sek == null || r.kind === "other") return;
      var e = by[r.isin] = by[r.isin] || { r: r, buy: 0, sell: 0, buyers: {} };
      if (r.kind === "buy") { e.buy += r.sek; e.buyers[r.person] = 1; } else e.sell += r.sek;
    });
    var comp = Object.keys(by).map(function (k) { var e = by[k]; e.net = e.buy - e.sell; e.nBuyers = Object.keys(e.buyers).length; return e; });
    // Tolv månader: sammanställningen ur arkivet (data/insider-year.json, byggs av scripts/build-pages.ps1)
    var yearMode = insiderFilter.period === "365" && need("insider-year", function () { return getJSON("data/insider-year.json").then(function (x) { state.insiderYear = x; }); });
    if (yearMode) comp = state.insiderYear.rows.map(function (y) { return { r: { issuer: y[1], isin: y[0] }, buy: y[2], sell: y[3], net: y[2] - y[3], nBuyers: y[4] }; });
    var periodText = yearMode ? "12 månaderna" : I.days + " dagarna";
    var top = comp.filter(function (e) { return e.net > 0; }).sort(function (a, b) { return b.net - a.net; });
    var topSold = comp.filter(function (e) { return e.net < 0; }).sort(function (a, b) { return a.net - b.net; });

    var html = head + '<div class="highlights">' +
      highlight("Insiderköp, 30 dagar", bigSek(sum(buys30)), null, '<span class="pos">' + int(buys30.length) + " affärer</span>", "") +
      highlight("Insidersälj, 30 dagar", bigSek(sum(sells30)), null, '<span class="neg">' + int(sells30.length) + " affärer</span>", "") +
      highlight("Mest köpt av insiders", top[0] && top[0].r.issuer, top[0] && ds.byIsin[top[0].r.isin] ? stockHref(ds.byIsin[top[0].r.isin]) : null,
        top[0] ? '<span class="pos">' + bigSek(top[0].net, true) + "</span>" : "", top[0] ? int(top[0].nBuyers) + (top[0].nBuyers === 1 ? " person" : " personer") + ", " + (yearMode ? "12 månader" : I.days + " dagar") : "") +
      "</div>";

    var fundFlow = function (e) { var s = ds.byIsin[e.r.isin]; return s && s.netFlow != null ? s.flow : null; };
    var compCols = function (sold) {
      return [
        { key: "b", label: "Bolag", align: "l", cls: "name", cell: function (e) { return issuerCell(e.r, sold ? "Sålt " + bigSek(e.sell) : "Köpt " + bigSek(e.buy) + " · " + int(e.nBuyers) + " köpare"); } },
        { key: "net", label: "Netto insiders", cell: function (e) { return '<span class="' + cls(e.net) + '">' + bigSek(e.net, true) + "</span>"; }, value: function (e) { return e.net; } },
        { key: "n", label: "Köpare", hideSm: true, cell: function (e) { return int(e.nBuyers); }, value: function (e) { return e.nBuyers; } },
        { key: "f", label: "Fondernas nettoköp " + quarterLabel(state.q), cell: function (e) { var v = fundFlow(e); return v == null ? "–" : '<span class="' + cls(v) + '">' + bigSek(v, true) + "</span>"; },
          value: function (e) { return fundFlow(e); } }
      ];
    };
    var pseg = function (v, label) { return '<button type="button" class="seg-btn" data-ins-period="' + v + '" aria-pressed="' + (insiderFilter.period === v) + '">' + label + "</button>"; };
    html += '<div class="toolbar section-gap"><div class="seg" role="group" aria-label="Period">' + pseg("90", "90 dagar") + pseg("365", "12 månader") + "</div>" +
      '<a class="note" href="#/dubbelsignal">Dubbelsignal: när både fonder och insiders köper</a></div>';
    html += '<div class="grid-2">' +
      block("Mest köpt av insiders", "Köp minus sälj de senaste " + periodText + ", i kronor.", table("ins-top", compCols(false), top, { sort: { col: "net", dir: -1 }, limit: 15 })) +
      block("Mest sålt av insiders", "Samma period. Försäljningar kan bero på skatt, lån eller optionsprogram.", table("ins-sold", compCols(true), topSold, { sort: { col: "net", dir: 1 }, limit: 15 })) +
      "</div>";

    // Senaste affärerna med filter
    var f = insiderFilter;
    var list = I.rows.filter(function (r) {
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
      table("ins-latest", cols, list, { sort: { col: "d", dir: -1 }, limit: 150, csv: true }) + "</section>";
    html += '<p class="desc section-gap">Källa: Finansinspektionens insynsregister, publiceringar sedan ' + esc(I.from) + ". Bara affärer i aktier visas. " +
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
    if (!failed(key)) {
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
    var since = daysAgo(365), b = 0, s = 0;
    rows.forEach(function (r) { if (r.tx < since) return; if (r.kind === "buy") b += r.sek || 0; else s += r.sek || 0; });
    var cols = [
      { key: "p", label: "Person", align: "l", cls: "name", cell: function (r) { return '<span class="nm-plain">' + personText(r) + '</span><span class="sub">' + esc(r.role) + '<span class="show-sm-i"> · ' + esc(r.tx) + "</span></span>"; } },
      { key: "k", label: "Typ", align: "l", cell: insiderKind },
      { key: "v", label: "Värde", cell: insiderValue },
      { key: "d", label: "Datum", cls: "muted", hideSm: true, cell: function (r) { return esc(r.tx); } }
    ];
    var first = rows[rows.length - 1].tx.slice(0, 4);
    return '<section class="block section-gap"><div class="block-head"><h2>Insynshandel</h2><span class="note">' + (b || s ? "Senaste 12 månaderna: köpt " + bigSek(b) + " · sålt " + bigSek(s) : "Inga köp eller sälj de senaste 12 månaderna") + "</span></div>" +
      '<p class="desc">' + int(rows.length) + (rows.length === 1 ? " köp eller sälj" : " köp och sälj") + " anmälda " + (res.all ? "sedan " + first : "de senaste 90 dagarna") + ".</p>" +
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
          tip: function (p) { return "<b>" + p.date + "</b><br>" + nf2.format(p.value) + " % blankat"; } });
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

  function repSection(n, title, desc, inner) {
    return '<section class="rep-section section-gap"><div class="rep-head"><span class="rep-num">' + (n < 10 ? "0" : "") + n + "</span><div><h2>" + title + "</h2>" +
      (desc ? '<p class="desc">' + desc + "</p>" : "") + "</div></div>" + inner + "</section>";
  }

  function viewReport(q) {
    // /rapport/2025-q4/ visar det kvartalet utan att ändra vilket kvartal som är valt nästa gång
    if (q && q !== state.q && state.index.quarters.some(function (x) { return x.id === q; })) {
      setTimeout(function () { selectQuarter(q, true); }, 0);
      return loadingBlock();
    }
    // Rapporten följer marknadsvalet (Sverige/Utland), som också kan bytas direkt i rapporten.
    // Blankning, uppköp och köpsviter finns bara för svenska aktier.
    var world = state.market === "world";
    var d = quarterData(), m = d.meta, ds = marketDs();
    if (!ds) return failed("world-" + state.q) ? errorBlock() : loadingBlock("Laddar utländska aktier…");
    var word = marketWord(), Word = world ? "Utländska aktier" : "Svenska aktier";
    var hasHist = needHistory(world ? "world" : "se"), hasOffers = !world && needOffers();
    var cont = ds.stocks.filter(function (s) { return s.price && !s.isNew && !s.isGone; });
    var buys = cont.filter(function (s) { return s.flow > 0; }).sort(function (a, b) { return b.flow - a.flow; });
    var sells = cont.filter(function (s) { return s.flow < 0; }).sort(function (a, b) { return a.flow - b.flow; });
    var news = cont.filter(function (s) { return s.nNew > 0; }).sort(function (a, b) { return b.nNew - a.nNew; });
    var t = ds.totals, net = t.buy + t.sell;
    document.title = "Fondinsyn " + quarterLabel(state.q) + " · " + Word.toLowerCase() + " – kvartalsrapport";

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
      '<div class="rep-tools"><div class="seg rep-market" role="group" aria-label="Rapport för">' + mbtn("se", "Svenska aktier") + mbtn("world", "Utländska aktier") + "</div>" +
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
    if (hasOffers) {
      var bids = state.offers.offers.filter(function (o) { return o.date > m.prev && o.date <= m.curr; });
      if (bids.length) note("Uppköp", bids.length + (bids.length === 1 ? " uppköpserbjudande" : " uppköpserbjudanden") + " godkändes av FI under kvartalet: " +
        sentenceList(bids.slice(0, 4), function (o) { return '<a href="#/uppkop/' + encodeURIComponent(o.id) + '">' + esc(o.name || o.bidder) + "</a>" + (o.premium != null ? " (premie " + nf1.format(o.premium) + " %)" : ""); }) +
        (bids.length > 4 ? " med flera" : "") + ".", "#/uppkop", "Alla uppköp");
    }
    if (!world && needShorts()) {
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
    return '<article class="report">' + printHead + head +
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
    var tradeCols = [
      { key: "s", label: "Aktie", align: "l", cls: "name", cell: function (t) { return nameCell(stockHref(t.s), t.s.name, t.n + (t.n === 1 ? " fond" : " fonder")); } },
      { key: "d", label: "Netto (mkr)", cell: function (t) { return '<span class="' + cls(t.d) + '">' + mkr(t.d, true) + "</span>"; } },
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
      "<li>Vid aktiesplit justeras förra kvartalets antal när de flesta fonder visar samma förändringskvot.</li>" +
      "<li>Indexfonder identifieras på namnet. Deras affärer speglar oftast in- och utflöden i fonden snarare än aktiva beslut.</li>" +
      "<li><b>Köpsviter</b> räknas på historiken sedan 2018. Kvartal med nettoköp under 0,5 mkr räknas inte.</li>" +
      "<li>Utländska aktier visas om svenska fonder sammanlagt äger minst 20 mkr.</li>" +
      '<li><b>Räntepapper</b> (obligationer och certifikat) och <b>fondandelar</b> visas på fondsidan och under <a href="#/rantor">Räntor</a>. Emittenten läses ur värdepapperets namn, ' +
      "och papper som förfallit räknas inte som sålda. Marknadsräntorna kommer från Riksbanken.</li></ul>" +
      '<p class="desc">Fondinsyn räknar antalet besök med GoatCounter, som inte använder kakor och inte sparar några personuppgifter.</p>' +
      "<h2>Uppdatering</h2><p>Datan hämtas automatiskt från Finansinspektionen varje dag. Blankningen ändras dagligen, fondinnehaven en gång per kvartal. Finansinspektionen publicerar kvartalets innehav ungefär tolv veckor efter kvartalsslut (Q2 2026, som slutade 30 juni, kom 21 september). FI publicerar ibland om äldre kvartal med rättelser, och de hämtas också automatiskt.</p>" +
      (m && m.src ? "<p>Källfiler för " + quarterLabel(state.q) + ": <code>" + esc(m.src[0]) + "</code> och <code>" + esc(m.src[1]) + "</code>.</p>" : "") +
      '<h2>Källa</h2><p><a href="https://www.fi.se/sv/vara-register/fondinnehav-per-kvartal/" target="_blank" rel="noopener">Finansinspektionen – Fondinnehav per kvartal</a></p>' +
      "<p>Informationen på sidan är inte investeringsrådgivning.</p></div>";
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
    ["SECBREPOEFF", "Styrränta", "s1"], ["SEGVB2YC", "Statsobligation 2 år", "s2"],
    ["SEGVB10YC", "Statsobligation 10 år", "s3"], ["SEMB5YCACOMB", "Bostadsobligation 5 år", "s4"]
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
      if (pr) figs.push(fig(termLink("styrranta", "Styrränta"), ratePct(pr.v), "Riksbanken, " + dateText(pr.d)));
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
        '<div class="legend">' + series.map(function (s) { return '<span class="legend-item"><span class="dot ' + s.cls + '"></span>' + esc(s.label) + "</span>"; }).join("") + "</div>" +
        chart(function (node) {
          FFCharts.lines(node, series, { unit: " %", format: function (v) { return nf2.format(v); }, tip: function (rows) {
            return "<b>" + dateText(rows[0].p.d) + "</b>" + rows.map(function (x) {
              return '<div class="tip-row"><span><span class="dot ' + x.s.cls + '"></span>' + esc(x.s.label) + "</span><b>" + nf2.format(x.p.v) + " %</b></div>";
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
      '<div class="toolbar"><input class="input" type="search" id="rateSearch" placeholder="Sök emittent, till exempel Castellum" value="' + esc(rateState.q) + '" autocomplete="off">' +
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

  // Kvartalsrapporten har egna flikar för marknaden
  var MARKET_PAGES = { oversikt: 1, aktier: 1, fonder: 1, fondbolag: 1 };
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
      case "dubbelsignal": html = viewDouble(); break;
      case "sparande": html = viewSavings(); break;
      case "signaler": html = viewSignals(); break;
      case "emittent": html = viewIssuer(r.arg); break;
      default: html = viewOverview();
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
    var navKey = { aktie: "aktier", fond: "fonder", blankare: "blankning", fondbolag: "fonder", emittent: "rantor" }[r.page] || r.page;
    document.querySelectorAll("[data-nav]").forEach(function (a) {
      if (a.getAttribute("data-nav") === navKey) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    // Sidor som bara ligger i menyn markerar menyknappen (på dator om sidan saknas i menyraden, på mobil i flikraden)
    var inMenu = !!document.querySelector('#moreMenu [aria-current="page"]');
    $("moreBtn").classList.toggle("active", inMenu && !document.querySelector('.mainnav [aria-current="page"]'));
    $("moreBtnM").classList.toggle("active", inMenu && !document.querySelector('.tabbar [aria-current="page"]'));
    document.body.setAttribute("data-page", r.page || "oversikt");
    // Sidor utan brödsmulor får menygruppens namn ovanför rubriken (Marknaden, Signaler, Verktyg)
    var ph = app.querySelector(".page-head");
    if (ph && !ph.querySelector(".crumbs, .kicker")) {
      var cur = document.querySelector('#moreMenu a[aria-current="page"]'), grp = cur && cur.closest(".mega-col");
      var gh = grp && grp.querySelector("h2");
      if (gh) ph.insertAdjacentHTML("afterbegin", '<p class="kicker">' + esc(gh.textContent) + "</p>");
    }
    $("marketSwitch").hidden = !MARKET_PAGES[r.page];
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
  function toggleMore(open) {
    var menu = $("moreMenu");
    var sheet = window.matchMedia("(max-width: 760px)").matches;
    if (open == null) open = menu.hidden;
    menu.hidden = !open;
    menu.classList.toggle("sheet", sheet);
    $("moreBackdrop").hidden = !open;
    document.body.classList.toggle("sheet-open", open && sheet);
    $("moreBtn").setAttribute("aria-expanded", String(open));
    $("moreBtnM").setAttribute("aria-expanded", String(open));
    tabIndicator();
    if (!open) return;
    if (sheet) { menu.removeAttribute("style"); $("moreBackdrop").removeAttribute("style"); return; }
    menu.style.top = $("moreBackdrop").style.top = Math.round(document.querySelector(".topbar").getBoundingClientRect().bottom) + "px";
    var first = menu.querySelector(".mega-col a:not(.m-only)");
    if (first && document.activeElement === $("moreBtn")) first.focus({ preventScroll: true });
  }
  var moreWidth = window.innerWidth;
  window.addEventListener("resize", function () { if (window.innerWidth !== moreWidth) { moreWidth = window.innerWidth; toggleMore(false); } });
  // Skugga under sidhuvudet när sidan är skrollad
  window.addEventListener("scroll", function () { document.body.classList.toggle("scrolled", window.scrollY > 4); }, { passive: true });
  window.addEventListener("scroll", function () { if (!$("moreMenu").hidden && !$("moreMenu").classList.contains("sheet")) toggleMore(false); }, { passive: true });

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

  // Ljust eller mörkt läge. Valet sparas i webbläsaren och läses in redan i <head> (index.html),
  // så att sidan inte hinner visas i fel läge.
  function isDark() { return document.documentElement.getAttribute("data-theme") === "dark"; }
  function syncThemeBtn() {
    var dark = isDark();
    $("themeBtn").setAttribute("aria-label", dark ? "Byt till ljust läge" : "Byt till mörkt läge");
    $("themeBtn").title = dark ? "Ljust läge" : "Mörkt läge";
  }
  function setTheme(theme) {
    if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
    try { localStorage.setItem("ff-theme", theme); } catch (e) { /* ingen lagring */ }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#0c0b0a" : "#ffffff");
    syncThemeBtn();
  }
  syncThemeBtn();

  document.addEventListener("click", function (e) {
    if (e.target.closest && e.target.closest("#themeBtn")) { setTheme(isDark() ? "light" : "dark"); return; }
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
    if (shareEl) { share(shareEl); return; }
    if (e.target.id === "copyMail") {
      var btn = e.target;
      var done = function () { btn.textContent = "Kopierad"; setTimeout(function () { btn.textContent = "Kopiera"; }, 2000); };
      if (navigator.clipboard) navigator.clipboard.writeText(CONTACT).then(done, function () { selectText(btn.previousElementSibling); });
      else selectText(btn.previousElementSibling);
      return;
    }
    var csv = e.target.closest("[data-csv]");
    if (csv) { downloadCsv(csv.getAttribute("data-csv")); return; }
    var sv = e.target.closest("[data-sav-type]");
    if (sv) { savingsState.type = sv.getAttribute("data-sav-type"); var sy = window.scrollY; render(); window.scrollTo(0, sy); return; }
    var rp = e.target.closest("[data-rep-pick]");
    if (rp) {
      repPick.market = rp.getAttribute("data-rep-pick");
      rp.parentNode.querySelectorAll("[data-rep-pick]").forEach(function (b) { b.setAttribute("aria-pressed", String(b === rp)); });
      updateRepGo();
      segThumbs();
      return;
    }
    if (e.target.closest("#repGo:not([data-pdf]), #repWeb") && repPick.market && repPick.market !== state.market) setMarket(repPick.market);
    var mk = e.target.closest("[data-market]");
    if (mk) {
      setMarket(mk.getAttribute("data-market"));
      if (mk.closest("#marketSwitch, .rep-market")) { render(); toast(mk.getAttribute("data-market") === "world" ? "Visar utländska aktier" : "Visar svenska aktier"); }
      return; // länkar med data-market (brödsmulor) navigerar som vanligt
    }
    // Sök
    if (e.target.closest("#moreBtn, #moreBtnM")) { toggleMore(); return; }
    if (!$("moreMenu").hidden && !e.target.closest("#moreMenu")) toggleMore(false);
    if (e.target.closest("#searchBtn, #searchBtnT")) { openSearch(); return; }
    if (e.target.closest("[data-search-close]")) { closeSearch(); return; }
    var sr = e.target.closest("[data-sr]");
    if (sr) { pickSel(+sr.getAttribute("data-sr")); return; }

    // Bevakning
    var wt = e.target.closest("[data-watch]");
    if (wt) {
      var key0 = wt.getAttribute("data-watch"), kind = key0.split(":")[0], wid = key0.slice(kind.length + 1);
      watchToggle(kind, wid);
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
    if (e.key === "Escape" && !$("moreMenu").hidden) { toggleMore(false); ($("moreBtnM").offsetParent ? $("moreBtnM") : $("moreBtn")).focus(); return; }
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
      updateRepGo();
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
