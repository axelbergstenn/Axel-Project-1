// Fondinsyn – små SVG-diagram utan beroenden.
// Samma formspråk i alla diagram: tunna markeringar, 1px stödlinjer, staplar med 4px rundad ände bort från nollinjen,
// text i textfärg (aldrig i seriefärg), teckenförklaring när det finns fler än en serie och en tooltip när man pekar
// eller stegar med piltangenterna. Färgen sätts med en klass per serie (s1, s2, s3, s-ink, c-pos, c-neg, c-active …)
// som ger CSS-variabeln --c, så att diagrammen följer ljust och mörkt läge.
(function () {
  "use strict";

  var SVGNS = "http://www.w3.org/2000/svg";
  var nf0 = new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 0 });
  var nf1 = new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 1 });

  function fmtTick(v) {
    var a = Math.abs(v);
    var s = a >= 10 || v === 0 ? nf0.format(v) : nf1.format(v);
    return s.replace(/^-/, "−");
  }

  // Jämna skalsteg (1, 2, 2,5, 5 × 10^n)
  function niceTicks(min, max, count) {
    if (min === max) { max = min + 1; }
    var span = max - min;
    var raw = span / Math.max(1, count);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var steps = [1, 2, 2.5, 5, 10];
    var step = mag;
    for (var i = 0; i < steps.length; i++) { if (steps[i] * mag >= raw) { step = steps[i] * mag; break; } }
    var lo = Math.floor(min / step + 1e-9) * step;
    var hi = Math.ceil(max / step - 1e-9) * step;
    var ticks = [];
    for (var v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
    return { min: lo, max: hi, ticks: ticks };
  }

  function el(name, attrs, parent) {
    var n = document.createElementNS(SVGNS, name);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function text(parent, x, y, str, cls, anchor) {
    var t = el("text", { x: x, y: y, "class": cls || "c-axis", "text-anchor": anchor || "start" }, parent);
    t.textContent = str;
    return t;
  }

  // Teckenförklaring ovanför diagrammet. items: [{ label, cls, kind: "bar" | "line" | "dash" | "dot", key }].
  // Namnen sätts som text, inte som HTML.
  function legend(container, items) {
    var box = document.createElement("div");
    box.className = "c-legend";
    items.forEach(function (it) {
      var s = document.createElement("span");
      s.className = "c-key";
      if (it.key != null) s.setAttribute("data-key", it.key);
      var i = document.createElement("i");
      i.className = "k-" + (it.kind || "bar") + " " + (it.cls || "");
      s.appendChild(i);
      s.appendChild(document.createTextNode(it.label));
      box.appendChild(s);
    });
    container.appendChild(box);
    return box;
  }

  function setup(container, height, opts) {
    // Första gången diagrammet ritas tonas det in, inte när det ritas om efter att fönstret ändrat storlek
    var fresh = !container.hasAttribute("data-drawn");
    container.setAttribute("data-drawn", "");
    container.innerHTML = "";
    container.style.position = "relative";
    var lg = opts && opts.legend && opts.legend.length ? legend(container, opts.legend) : null;
    var w = Math.max(240, container.clientWidth);
    var svg = el("svg", { width: w, height: height, viewBox: "0 0 " + w + " " + height, "class": "c-svg" + (fresh ? " c-in" : ""), role: "img" }, null);
    if (opts && opts.aria) svg.setAttribute("aria-label", opts.aria);
    container.appendChild(svg);
    var tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.setAttribute("role", "status");
    container.appendChild(tip);
    // Tooltipen placeras i containern, så teckenförklaringens höjd ovanför diagrammet räknas med
    var top = Math.round(svg.getBoundingClientRect().top - container.getBoundingClientRect().top);
    return { svg: svg, w: w, h: height, tip: tip, legend: lg, top: top };
  }

  function showTip(ctx, html, x, y) {
    var tip = ctx.tip, wasOn = tip.classList.contains("on");
    // Första gången hoppar rutan direkt till sin plats, sedan glider den mellan punkterna
    if (!wasOn) tip.classList.add("jump");
    tip.innerHTML = html;
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    var left = x + 14;
    if (left + tw > ctx.w) left = x - tw - 14;
    if (left < 0) left = Math.max(0, Math.min(ctx.w - tw, x - tw / 2));
    var top = ctx.top + Math.max(0, Math.min(y - th / 2, ctx.h - th));
    tip.style.transform = "translate(" + Math.round(left) + "px," + Math.round(top) + "px)";
    tip.classList.add("on");
    if (!wasOn) { void tip.offsetWidth; tip.classList.remove("jump"); }
  }

  function hideTip(ctx) { ctx.tip.classList.remove("on"); }

  // Piltangenterna stegar mellan punkterna med samma tooltip som när man pekar. Enter öppnar (opts.onClick).
  function keys(ctx, n, show, hide, open) {
    var at = -1;
    ctx.svg.setAttribute("tabindex", "0");
    ctx.svg.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { at = -1; hide(); return; }
      if (e.key === "Enter" && at >= 0 && open) { open(at); return; }
      var d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "Home" ? -1e6 : e.key === "End" ? 1e6 : 0;
      if (!d || !n) return;
      e.preventDefault();
      at = Math.max(0, Math.min(n - 1, at < 0 ? (d > 0 ? 0 : n - 1) : at + d));
      show(at);
    });
    ctx.svg.addEventListener("blur", function () { at = -1; hide(); });
  }

  // Bredd för y-axelns etiketter, efter den längsta
  function axisWidth(scale, fmt) {
    var n = 0;
    scale.ticks.forEach(function (t) { n = Math.max(n, fmt(t).length); });
    return Math.max(30, 12 + n * 6.4);
  }

  // Stapel med 4px rundad ände bort från nollinjen, rak vid nollinjen
  function barPath(x, y0, y1, w) {
    var h = Math.abs(y1 - y0);
    var r = Math.min(4, h, w / 2);
    if (h < 0.5) return "";
    var s = y1 < y0 ? 1 : -1;
    return "M" + x + "," + y0 + "V" + (y1 + s * r) + "Q" + x + "," + y1 + " " + (x + r) + "," + y1 +
      "H" + (x + w - r) + "Q" + (x + w) + "," + y1 + " " + (x + w) + "," + (y1 + s * r) + "V" + y0 + "Z";
  }

  // Horisontella stödlinjer med y-axelns tal. Nollan får en starkare linje.
  function grid(ctx, m, scale, y, fmt) {
    var g = el("g", {}, ctx.svg);
    scale.ticks.forEach(function (t) {
      var yy = Math.round(y(t)) + 0.5;
      el("line", { x1: m.l, x2: ctx.w - m.r, y1: yy, y2: yy, "class": t === 0 ? "c-zero" : "c-grid" }, g);
      text(g, m.l - 8, yy + 4, fmt(t), "c-axis", "end");
    });
    return g;
  }

  var MONTHS = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

  // x-etiketter: årtal vid första kvartalet (p.q = "2026Q1") eller första månaden (p.m = "2026-01") varje år.
  // Med få månader visas också april, juli och oktober.
  function yearLabels(g, points, xAt, y, w) {
    var every = w < 420 ? 2 : 1, n = 0;
    var months = points.length <= 30 && points.some(function (p) { return p.m; });
    points.forEach(function (p, i) {
      var key = p.q ? p.q.slice(5) : p.m ? p.m.slice(5) : "";
      if (key === "1" || key === "01") {
        if (n++ % every === 0) text(g, xAt(i), y, (p.q || p.m).slice(0, 4), "c-axis c-axis-year", "middle");
      } else if (months && w >= 420 && (key === "04" || key === "07" || key === "10")) {
        text(g, xAt(i), y, MONTHS[+key - 1], "c-axis", "middle");
      }
    });
  }

  // x-etiketter från opts.xLabel (t.ex. veckonummer), glesare när staplarna står tätt; den sista visas alltid
  function xLabels(g, points, xAt, y, band, fn) {
    var every = Math.max(1, Math.ceil(44 / Math.max(1, band))), last = points.length - 1;
    points.forEach(function (p, i) {
      if ((last - i) % every === 0) text(g, xAt(i), y, fn(p, i), "c-axis", "middle");
    });
  }

  // Kolumner som kan vara positiva eller negativa (nettoköp per kvartal).
  // Med p.neg ritas dessutom en stapel nedåt i samma kolumn (t.ex. köp uppåt och sälj nedåt samma vecka).
  // opts: height, ticks, barMax, focus (tona ner allt utom p.highlight), label(p) (värdet vid den markerade stapeln),
  // xLabel(p), legend, tip(p)
  function columns(container, points, opts) {
    opts = opts || {};
    var ctx = setup(container, opts.height || 220, opts);
    var vals = points.map(function (p) { return p.value || 0; }).concat(points.map(function (p) { return p.neg || 0; }));
    var scale = niceTicks(Math.min(0, Math.min.apply(null, vals)), Math.max(0, Math.max.apply(null, vals)), opts.ticks || 4);
    var m = { t: opts.label ? 24 : 12, r: 8, b: 26, l: axisWidth(scale, fmtTick) };
    var ih = ctx.h - m.t - m.b, iw = ctx.w - m.l - m.r;
    var y = function (v) { return m.t + (scale.max - v) / (scale.max - scale.min) * ih; };
    var band = iw / points.length;
    var bw = Math.max(2, Math.min(opts.barMax || 22, band - 2, band * 0.62));
    var xAt = function (i) { return m.l + band * i + band / 2; };

    grid(ctx, m, scale, y, fmtTick);
    var hover = el("rect", { y: m.t, height: ih, width: band, "class": "c-hover", visibility: "hidden" }, ctx.svg);
    var g = el("g", { "class": "c-bars" + (opts.focus ? " focus" : "") }, ctx.svg);
    var bar = function (v, i, cls) {
      var d = v == null ? "" : barPath(xAt(i) - bw / 2, y(0), y(v), bw);
      return d ? el("path", { d: d, "class": "c-bar " + cls }, g) : null;
    };
    var bars = points.map(function (p, i) { return bar(p.value, i, (p.value >= 0 ? "c-pos" : "c-neg") + (p.highlight ? " c-strong" : "")); });
    var negBars = points.map(function (p, i) { return p.neg ? bar(p.neg, i, "c-neg") : null; });
    // Värdet vid den markerade stapeln
    if (opts.label) {
      points.forEach(function (p, i) {
        if (!p.highlight || p.value == null) return;
        var ly = p.value >= 0 ? y(p.value) - 7 : y(p.value) + 15;
        var lx = Math.max(m.l + 16, Math.min(ctx.w - m.r - 16, xAt(i)));
        text(ctx.svg, lx, Math.max(12, ly), opts.label(p), "c-label", "middle");
      });
    }
    // Nollinjen ovanpå staplarna
    var z = Math.round(y(0)) + 0.5;
    el("line", { x1: m.l, x2: ctx.w - m.r, y1: z, y2: z, "class": "c-zero" }, ctx.svg);
    if (opts.xLabel) xLabels(el("g", {}, ctx.svg), points, xAt, ctx.h - 6, band, opts.xLabel);
    else yearLabels(el("g", {}, ctx.svg), points, xAt, ctx.h - 6, ctx.w);

    var on = -1;
    var show = function (i) {
      if (i !== on) {
        if (on >= 0) [bars[on], negBars[on]].forEach(function (b) { if (b) b.classList.remove("on"); });
        [bars[i], negBars[i]].forEach(function (b) { if (b) b.classList.add("on"); });
        on = i;
      }
      g.classList.add("hovering");
      hover.setAttribute("x", m.l + band * i); hover.setAttribute("visibility", "visible");
      var p = points[i];
      showTip(ctx, opts.tip(p), xAt(i), y(Math.max(0, p.value || 0)));
    };
    var hide = function () {
      g.classList.remove("hovering");
      hover.setAttribute("visibility", "hidden");
      if (on >= 0) [bars[on], negBars[on]].forEach(function (b) { if (b) b.classList.remove("on"); });
      on = -1;
      hideTip(ctx);
    };
    var hit = el("rect", { x: m.l, y: 0, width: iw, height: ctx.h, fill: "transparent" }, ctx.svg);
    hit.addEventListener("pointermove", function (e) {
      var r = ctx.svg.getBoundingClientRect();
      show(Math.max(0, Math.min(points.length - 1, Math.floor((e.clientX - r.left - m.l) / band))));
    });
    hit.addEventListener("pointerleave", hide);
    keys(ctx, points.length, show, hide);
  }

  // En linje med en tunn yta under (antal fonder som äger, blankning över tid). opts: cls (serieklass), format, tip(p)
  function line(container, points, opts) {
    opts = opts || {};
    var ctx = setup(container, opts.height || 220, opts);
    var cls = opts.cls || "s1";
    var vals = points.map(function (p) { return p.value; }).filter(function (v) { return v != null; });
    var scale = niceTicks(0, Math.max.apply(null, vals.concat([1])), 4);
    var m = { t: 14, r: 44, b: 26, l: axisWidth(scale, fmtTick) };
    var ih = ctx.h - m.t - m.b, iw = ctx.w - m.l - m.r;
    var y = function (v) { return m.t + (scale.max - v) / (scale.max - scale.min) * ih; };
    var step = points.length > 1 ? iw / (points.length - 1) : 0;
    var xAt = function (i) { return m.l + step * i; };

    grid(ctx, m, scale, y, fmtTick);
    var d = "", started = false, first = -1, last = -1;
    points.forEach(function (p, i) {
      if (p.value == null) { started = false; return; }
      d += (started ? "L" : "M") + xAt(i).toFixed(1) + "," + y(p.value).toFixed(1);
      started = true; last = i;
      if (first < 0) first = i;
    });
    if (first >= 0) {
      el("path", { d: d + "L" + xAt(last).toFixed(1) + "," + y(0) + "L" + xAt(first).toFixed(1) + "," + y(0) + "Z", "class": "c-area " + cls }, ctx.svg);
      el("path", { d: d, "class": "c-series " + cls }, ctx.svg);
      var lp = points[last];
      el("circle", { cx: xAt(last), cy: y(lp.value), r: 4, "class": "c-end " + cls }, ctx.svg);
      text(ctx.svg, xAt(last) + 9, y(lp.value) + 4, opts.format ? opts.format(lp.value) : fmtTick(lp.value), "c-label");
    }
    el("line", { x1: m.l, x2: ctx.w - m.r, y1: Math.round(y(0)) + 0.5, y2: Math.round(y(0)) + 0.5, "class": "c-zero" }, ctx.svg);
    yearLabels(el("g", {}, ctx.svg), points, xAt, ctx.h - 6, ctx.w);

    var cross = el("line", { y1: m.t, y2: ctx.h - m.b, "class": "c-cross", visibility: "hidden" }, ctx.svg);
    var dot = el("circle", { r: 4, "class": "c-end " + cls, visibility: "hidden" }, ctx.svg);
    var show = function (i) {
      var p = points[i];
      cross.setAttribute("x1", xAt(i)); cross.setAttribute("x2", xAt(i)); cross.setAttribute("visibility", "visible");
      if (p.value != null) { dot.setAttribute("cx", xAt(i)); dot.setAttribute("cy", y(p.value)); dot.setAttribute("visibility", "visible"); }
      else dot.setAttribute("visibility", "hidden");
      showTip(ctx, opts.tip(p), xAt(i), y(p.value || 0));
    };
    var hide = function () { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); hideTip(ctx); };
    var hit = el("rect", { x: m.l - step / 2, y: 0, width: iw + step, height: ctx.h, fill: "transparent" }, ctx.svg);
    hit.addEventListener("pointermove", function (e) {
      var r = ctx.svg.getBoundingClientRect();
      show(Math.max(0, Math.min(points.length - 1, Math.round((e.clientX - r.left - m.l) / (step || 1)))));
    });
    hit.addEventListener("pointerleave", hide);
    keys(ctx, points.length, show, hide);
  }

  // Flera tidsserier på en gemensam datumaxel. series: [{ label, cls, points: [{ d: "YYYY-MM-DD", v }] }].
  // Teckenförklaringen byggs av serierna. Varje linje får sitt värde vid sista punkten (med en tunn ledlinje om
  // etiketterna måste flyttas isär), och ett hårkors visar alla serier för samma datum.
  // opts: height, unit, format, zero (false = axeln behöver inte börja på noll), ref { v, label } (referenslinje), tip(rows)
  function lines(container, series, opts) {
    opts = opts || {};
    if (opts.legend == null && series.length > 1) opts.legend = series.map(function (s) { return { label: s.label, cls: s.cls, kind: "line" }; });
    var ctx = setup(container, opts.height || 280, opts);
    var narrow = ctx.w < 520;
    var unit = opts.unit || "";
    var fmt = function (v) { return fmtTick(v) + unit; };
    var all = [];
    series.forEach(function (s) { s.points.forEach(function (p) { all.push(p.v); }); });
    if (!all.length) return;
    if (opts.ref) all.push(opts.ref.v);
    var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    var scale = opts.zero === false ? niceTicks(lo - (hi - lo) * 0.04, hi + (hi - lo) * 0.04, 4) : niceTicks(Math.min(0, lo), hi, 4);
    var m = { t: 14, r: narrow ? 12 : 64, b: 26, l: axisWidth(scale, fmt) };
    var ih = ctx.h - m.t - m.b, iw = ctx.w - m.l - m.r;
    var t0 = Infinity, t1 = -Infinity;
    series.forEach(function (s) { s.points.forEach(function (p) { p.t = Date.parse(p.d); if (p.t < t0) t0 = p.t; if (p.t > t1) t1 = p.t; }); });
    var x = function (t) { return m.l + (t - t0) / Math.max(1, t1 - t0) * iw; };
    var y = function (v) { return m.t + (scale.max - v) / (scale.max - scale.min) * ih; };

    var g = grid(ctx, m, scale, y, fmt);
    // Årtal vid varje årsskifte (vartannat år om axeln är trång)
    var y0 = new Date(t0).getUTCFullYear(), y1 = new Date(t1).getUTCFullYear();
    var years = []; for (var yr = y0 + 1; yr <= y1; yr++) years.push(yr);
    var every = Math.max(1, Math.ceil(years.length * 48 / iw));
    years.forEach(function (yr, i) {
      if (i % every) return;
      var xx = Math.round(x(Date.UTC(yr, 0, 1))) + 0.5;
      el("line", { x1: xx, x2: xx, y1: ctx.h - m.b, y2: ctx.h - m.b + 4, "class": "c-zero" }, g);
      text(g, xx, ctx.h - 6, String(yr), "c-axis", "middle");
    });
    // Referenslinje, t.ex. startvärdet 100
    if (opts.ref) {
      var ry = Math.round(y(opts.ref.v)) + 0.5;
      el("line", { x1: m.l, x2: ctx.w - m.r, y1: ry, y2: ry, "class": "c-ref" }, ctx.svg);
      if (opts.ref.label) text(ctx.svg, ctx.w - m.r - 6, ry + 15, opts.ref.label, "c-note", "end");
    }

    // Linjerna, med en 2px ring i bakgrundsfärgen runt slutpunkten
    var ends = [];
    series.forEach(function (s) {
      var d = "";
      s.points.forEach(function (p, i) { d += (i ? "L" : "M") + x(p.t).toFixed(1) + "," + y(p.v).toFixed(1); });
      el("path", { d: d, "class": "c-series " + s.cls }, ctx.svg);
      var lp = s.points[s.points.length - 1];
      if (lp) ends.push({ s: s, p: lp, x: x(lp.t), y0: y(lp.v), y: y(lp.v) });
    });
    // Värdet vid linjens slut. Krockar etiketterna flyttas de isär och får en ledlinje till sin linje.
    if (!narrow) {
      ends.sort(function (a, b) { return a.y - b.y; });
      for (var k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 15) ends[k].y = ends[k - 1].y + 15;
      var over = ends.length ? ends[ends.length - 1].y - (ctx.h - m.b) : 0;
      if (over > 0) ends.forEach(function (e) { e.y -= over; });
      ends.forEach(function (e) {
        var lx = ctx.w - m.r + 10;
        if (Math.abs(e.y - e.y0) > 2) el("path", { d: "M" + (e.x + 5) + "," + e.y0 + "L" + (lx - 3) + "," + e.y, "class": "c-leader" }, ctx.svg);
        text(ctx.svg, lx, e.y + 4, (opts.format ? opts.format(e.p.v) : fmtTick(e.p.v)) + unit, "c-label");
      });
    }
    ends.forEach(function (e) { el("circle", { cx: e.x, cy: e.y0, r: 4, "class": "c-end " + e.s.cls }, ctx.svg); });

    var cross = el("line", { y1: m.t, y2: ctx.h - m.b, "class": "c-cross", visibility: "hidden" }, ctx.svg);
    var dots = series.map(function (s) { return el("circle", { r: 4, "class": "c-end " + s.cls, visibility: "hidden" }, ctx.svg); });
    function nearest(s, t) {
      var lo = 0, hi = s.points.length - 1;
      while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (s.points[mid].t < t) lo = mid; else hi = mid; }
      return Math.abs(s.points[lo].t - t) <= Math.abs(s.points[hi].t - t) ? s.points[lo] : s.points[hi];
    }
    var showT = function (t) {
      var rows = [], cx = null, top = ctx.h;
      series.forEach(function (s, i) {
        var p = nearest(s, t);
        if (cx == null) cx = x(p.t);
        top = Math.min(top, y(p.v));
        dots[i].setAttribute("cx", x(p.t)); dots[i].setAttribute("cy", y(p.v)); dots[i].setAttribute("visibility", "visible");
        rows.push({ s: s, p: p });
      });
      cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible");
      showTip(ctx, opts.tip(rows), cx, Math.max(m.t + 40, top));
    };
    var hide = function () {
      cross.setAttribute("visibility", "hidden"); dots.forEach(function (d) { d.setAttribute("visibility", "hidden"); }); hideTip(ctx);
    };
    var hit = el("rect", { x: m.l, y: 0, width: iw, height: ctx.h, fill: "transparent" }, ctx.svg);
    hit.addEventListener("pointermove", function (e) {
      var r = ctx.svg.getBoundingClientRect();
      showT(t0 + (e.clientX - r.left - m.l) / iw * (t1 - t0));
    });
    hit.addEventListener("pointerleave", hide);
    var longest = series.reduce(function (a, s) { return s.points.length > a.points.length ? s : a; }, series[0]);
    keys(ctx, longest.points.length, function (i) { showT(longest.points[i].t); }, hide);
  }

  // Minsta kvadrat-linje och korrelation för punkter { x, y }
  function regression(points) {
    var n = points.length, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    points.forEach(function (p) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; syy += p.y * p.y; });
    var vx = n * sxx - sx * sx, vy = n * syy - sy * sy;
    if (n < 3 || !vx) return null;
    var b = (n * sxy - sx * sy) / vx;
    return { a: (sy - b * sx) / n, b: b, r: vy > 0 ? (n * sxy - sx * sy) / Math.sqrt(vx * vy) : 0, n: n };
  }

  function median(values) {
    var a = values.slice().sort(function (x, y) { return x - y; }), n = a.length;
    return n ? (n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) : 0;
  }

  // Punktdiagram med valfri storlek per punkt. Namnen står inte vid varje punkt utan visas när man pekar
  // (på mobilen: första trycket visar, andra öppnar). Bara några utvalda punkter får en etikett i diagrammet.
  // points: [{ x, y, size, cls }]. opts:
  //   xFmt, yFmt, xLabel, yLabel, xHint [vänster, höger] (riktningen i klartext), xDomain, yDomain
  //   legend [{ label, cls, key }] (pekar man på en post lyfts den kategorins punkter fram)
  //   sizeKey { values, fmt } (exempel på punktstorlekar i teckenförklaringen)
  //   label(p) (namn intill några få punkter), ref { x, y, xText, yText } (referenslinjer, t.ex. medianen),
  //   trend (regressionslinje), xTicks, yTicks (ungefärligt antal skalsteg)
  //   quad { tl, tr, bl, br } (hörnens namn), zone { x, y, label } (markerad yta uppe till vänster),
  //   bands { above, below } (tonad bakgrund över och under noll), tip(p), onClick(p)
  function xy(container, points, opts) {
    opts = opts || {};
    var ctx = setup(container, opts.height || 380, opts);
    if (!points.length) return null;
    var narrow = ctx.w < 520;
    var xFmt = opts.xFmt || fmtTick, yFmt = opts.yFmt || fmtTick;
    var ext = function (key, pad) {
      var vals = points.map(function (p) { return p[key]; });
      var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), d = (hi - lo) * pad || 1;
      return [lo - d, hi + d];
    };
    var dx = opts.xDomain || ext("x", 0.03), dy = opts.yDomain || ext("y", 0.04);
    var xs = niceTicks(dx[0], dx[1], narrow ? 4 : opts.xTicks || 7), ys = niceTicks(dy[0], dy[1], narrow ? 5 : opts.yTicks || 7);
    var m = { t: opts.yLabel ? 30 : 14, r: 14, b: 48, l: axisWidth(ys, yFmt) };
    var ih = ctx.h - m.t - m.b, iw = ctx.w - m.l - m.r;
    var x = function (v) { return m.l + (Math.max(xs.min, Math.min(xs.max, v)) - xs.min) / (xs.max - xs.min) * iw; };
    var y = function (v) { return m.t + (ys.max - Math.max(ys.min, Math.min(ys.max, v))) / (ys.max - ys.min) * ih; };
    var bottom = ctx.h - m.b;

    // Ytor under rutnätet: markerad zon och tonad bakgrund över och under nollan
    if (opts.zone) {
      var zx = x(opts.zone.x), zy = y(opts.zone.y);
      el("rect", { x: m.l, y: m.t, width: zx - m.l, height: zy - m.t, "class": "c-zone" }, ctx.svg);
    }
    if (opts.bands && ys.min < 0 && ys.max > 0) {
      var y0 = y(0);
      el("rect", { x: m.l, y: m.t, width: iw, height: y0 - m.t, "class": "c-band c-pos" }, ctx.svg);
      el("rect", { x: m.l, y: y0, width: iw, height: bottom - y0, "class": "c-band c-neg" }, ctx.svg);
    }

    var g = el("g", {}, ctx.svg);
    ys.ticks.forEach(function (t) {
      var yy = Math.round(y(t)) + 0.5;
      el("line", { x1: m.l, x2: ctx.w - m.r, y1: yy, y2: yy, "class": t === 0 ? "c-zero" : "c-grid" }, g);
      text(g, m.l - 8, yy + 4, yFmt(t), "c-axis", "end");
    });
    xs.ticks.forEach(function (t, i) {
      var xx = Math.round(x(t)) + 0.5;
      el("line", { x1: xx, x2: xx, y1: m.t, y2: bottom, "class": t === 0 ? "c-zero" : "c-grid" }, g);
      el("line", { x1: xx, x2: xx, y1: bottom, y2: bottom + 4, "class": "c-zero" }, g);
      var anchor = i === 0 && xx - m.l < 12 ? "start" : "middle";
      text(g, xx, bottom + 17, xFmt(t), "c-axis", anchor);
    });
    // Axlarnas namn: y-axelns ovanför axeln, x-axelns under talen med riktningen i klartext i ändarna
    if (opts.yLabel) text(ctx.svg, 0, 13, opts.yLabel, "c-axis-title");
    if (opts.xHint) {
      text(ctx.svg, m.l, ctx.h - 6, opts.xHint[0], "c-hint");
      text(ctx.svg, ctx.w - m.r, ctx.h - 6, opts.xHint[1], "c-hint", "end");
    }
    if (opts.xLabel && !(opts.xHint && narrow)) text(ctx.svg, m.l + iw / 2, ctx.h - 6, opts.xLabel, "c-axis-title", "middle");

    // Texter i diagrammet placeras på första lediga plats av några förslag [x, y, ankare], så att de inte krockar
    // med varandra eller hamnar utanför. En text som inte får plats hoppas över, utom när must är satt.
    var placed = [];
    function place(parent, str, cls, spots, must) {
      var t = text(parent, 0, 0, str, cls);
      var tw = t.getComputedTextLength ? t.getComputedTextLength() : str.length * 6.4;
      for (var s = 0; s < spots.length; s++) {
        var sp = spots[s], x0 = sp[2] === "start" ? sp[0] : sp[2] === "end" ? sp[0] - tw : sp[0] - tw / 2;
        var box = { l: x0 - 2, r: x0 + tw + 2, t: sp[1] - 11, b: sp[1] + 3 };
        var inside = box.l >= m.l && box.r <= ctx.w - m.r && box.t >= m.t && box.b <= bottom;
        var free = !placed.some(function (q) { return box.l < q.r && box.r > q.l && box.t < q.b && box.b > q.t; });
        if ((inside && free) || (must && s === spots.length - 1)) {
          t.setAttribute("x", sp[0].toFixed(1)); t.setAttribute("y", sp[1].toFixed(1)); t.setAttribute("text-anchor", sp[2]);
          placed.push(box);
          return t;
        }
      }
      parent.removeChild(t);
      return null;
    }

    // Texter i ytorna och hörnens namn, om de får plats
    var top = m.t + 15, low = bottom - 8;
    if (opts.zone && opts.zone.label) place(ctx.svg, opts.zone.label, "c-note c-note-strong", [[m.l + 8, top, "start"]], true);
    if (opts.bands && ys.min < 0 && ys.max > 0) {
      if (opts.bands.above) place(ctx.svg, opts.bands.above, "c-note c-note-strong", [[m.l + 8, top, "start"]], true);
      if (opts.bands.below) place(ctx.svg, opts.bands.below, "c-note c-note-strong", [[m.l + 8, low, "start"]], true);
    }
    if (opts.quad) {
      var q = opts.quad;
      if (q.tl) place(ctx.svg, q.tl, "c-note", [[m.l + 8, top, "start"]]);
      if (q.tr) place(ctx.svg, q.tr, "c-note", [[ctx.w - m.r - 8, top, "end"]]);
      if (q.bl) place(ctx.svg, q.bl, "c-note", [[m.l + 8, low, "start"]]);
      if (q.br) place(ctx.svg, q.br, "c-note", [[ctx.w - m.r - 8, low, "end"]]);
    }

    // Referenslinjer (t.ex. medianfonden) med en kort etikett vid linjen. Etiketterna flyttas sedan ovanpå punkterna.
    var front = [];
    if (opts.ref) {
      var rf = opts.ref;
      if (rf.x != null) {
        var rx = Math.round(x(rf.x)) + 0.5;
        el("line", { x1: rx, x2: rx, y1: m.t, y2: bottom, "class": "c-ref" }, ctx.svg);
        if (rf.xText) front.push(place(ctx.svg, rf.xText, "c-ref-label", [[rx + 6, top, "start"], [rx + 6, low, "start"], [rx - 6, top, "end"], [rx - 6, low, "end"]], true));
      }
      if (rf.y != null) {
        var ry = Math.round(y(rf.y)) + 0.5;
        el("line", { x1: m.l, x2: ctx.w - m.r, y1: ry, y2: ry, "class": "c-ref" }, ctx.svg);
        if (rf.yText) front.push(place(ctx.svg, rf.yText, "c-ref-label", [[ctx.w - m.r - 4, ry - 6, "end"], [ctx.w - m.r - 4, ry + 15, "end"]], true));
      }
    }

    // Trendlinjen ritas bara inom diagrammet
    var reg = opts.trend ? regression(points) : null;
    if (reg) {
      var x0 = xs.min, x1 = xs.max, ya = reg.a + reg.b * x0, yb = reg.a + reg.b * x1;
      el("line", { x1: x(x0), y1: y(ya), x2: x(x1), y2: y(yb), "class": "c-trend" }, ctx.svg);
    }

    // Storleken räknas mot den 95:e percentilen, så att en jätte (AP7) inte gör alla andra till prickar.
    // Stora punkter ritas först så att små hamnar ovanpå.
    var sizes = points.map(function (p) { return p.size || 0; }).sort(function (a, b) { return a - b; });
    var maxS = Math.max(1e-9, sizes[Math.floor(0.95 * (sizes.length - 1))]);
    var rMax = narrow ? 5 : 6.5;
    var radius = function (s) { return s != null ? 3 + rMax * Math.sqrt(Math.max(0, Math.min(1, s / maxS))) : 4.5; };
    points.forEach(function (p) { p._r = radius(p.size); p._x = x(p.x); p._y = y(p.y); });
    var order = points.slice().sort(function (a, b) { return b._r - a._r; });
    var dots = el("g", { "class": "c-pts" }, ctx.svg);
    order.forEach(function (p) {
      p._el = el("circle", { cx: p._x.toFixed(1), cy: p._y.toFixed(1), r: p._r.toFixed(1), "class": "c-pt " + (p.cls || "s1") }, dots);
    });
    front.forEach(function (t) { if (t) ctx.svg.appendChild(t); });

    // Namn intill några få punkter (opts.label), till höger, vänster, över eller under punkten
    if (opts.label) {
      var lg = el("g", { "class": "c-ptlabels" }, ctx.svg);
      order.slice().reverse().forEach(function (p) {
        var str = opts.label(p);
        if (!str) return;
        var gap = p._r + 5;
        if (place(lg, str, "c-ptlabel", [[p._x + gap, p._y + 4, "start"], [p._x - gap, p._y + 4, "end"], [p._x, p._y - gap - 2, "middle"], [p._x, p._y + gap + 10, "middle"]])) p._el.classList.add("lab");
      });
    }
    var ring = el("circle", { r: 9, "class": "c-ring", visibility: "hidden" }, ctx.svg);

    // Teckenförklaringen: exempel på punktstorlekar, och kategorin lyfts fram när man pekar på dess post
    if (ctx.legend && opts.sizeKey) {
      var sk = document.createElement("span");
      sk.className = "c-key c-sizekey";
      var html = "";
      opts.sizeKey.values.forEach(function (v) {
        var r = radius(v), d = Math.ceil(2 * r + 2);
        html += '<svg width="' + d + '" height="' + d + '" aria-hidden="true"><circle cx="' + d / 2 + '" cy="' + d / 2 + '" r="' + r.toFixed(1) + '"/></svg>' +
          "<span>" + opts.sizeKey.fmt(v) + "</span>";
      });
      sk.innerHTML = html;
      ctx.legend.appendChild(sk);
    }
    if (ctx.legend) {
      Array.prototype.forEach.call(ctx.legend.querySelectorAll(".c-key[data-key]"), function (k) {
        var key = k.getAttribute("data-key");
        k.addEventListener("pointerenter", function () {
          dots.classList.add("pick");
          points.forEach(function (p) { p._el.classList.toggle("m", p.cls === key); });
        });
        k.addEventListener("pointerleave", function () { dots.classList.remove("pick"); });
      });
    }

    var current = null, tapped = null, lastType = "mouse";
    var hit = el("rect", { x: 0, y: 0, width: ctx.w, height: ctx.h, fill: "transparent" }, ctx.svg);
    // Närmaste punkt inom 24px från pekaren räknas, så att små punkter går att träffa
    function pick(e) {
      var r = ctx.svg.getBoundingClientRect();
      var px = e.clientX - r.left, py = e.clientY - r.top, best = null, bd = 24 * 24;
      points.forEach(function (p) {
        var dd = (p._x - px) * (p._x - px) + (p._y - py) * (p._y - py) - p._r * p._r;
        if (dd < bd) { bd = dd; best = p; }
      });
      return best;
    }
    function focusOn(best) {
      if (best !== current) {
        if (current) current._el.classList.remove("on");
        if (best) best._el.classList.add("on");
      }
      current = best;
      dots.classList.toggle("hovering", !!best);
      hit.style.cursor = best && opts.onClick ? "pointer" : "default";
      if (!best) { ring.setAttribute("visibility", "hidden"); hideTip(ctx); return; }
      ring.setAttribute("cx", best._x); ring.setAttribute("cy", best._y); ring.setAttribute("r", best._r + 3.5); ring.setAttribute("visibility", "visible");
      showTip(ctx, opts.tip(best), best._x, best._y);
    }
    // Safari ger inte klicket någon pekartyp, så den sparas när fingret eller musen trycks ner
    hit.addEventListener("pointerdown", function (e) { lastType = e.pointerType || "mouse"; });
    hit.addEventListener("pointermove", function (e) { if (e.pointerType !== "touch") focusOn(pick(e)); });
    hit.addEventListener("pointerleave", function (e) { if (e.pointerType !== "touch") { tapped = null; focusOn(null); } });
    // Med mus öppnar ett klick punkten direkt. Med fingret visar första trycket namnet och andra trycket öppnar.
    hit.addEventListener("click", function (e) {
      var touch = lastType === "touch" || lastType === "pen";
      var p = pick(e);
      if (!touch) { if (p && opts.onClick) opts.onClick(p); return; }
      if (p && p === tapped && opts.onClick) { opts.onClick(p); return; }
      tapped = p;
      focusOn(p);
    });
    // Tangentbordet stegar från vänster till höger
    var byX = points.slice().sort(function (a, b) { return a.x - b.x || b.y - a.y; });
    keys(ctx, byX.length, function (i) { focusOn(byX[i]); }, function () { focusOn(null); },
      opts.onClick ? function (i) { opts.onClick(byX[i]); } : null);
    return reg;
  }

  // Fördelning: histogram och normalfördelningskurvor med samma medelvärde och standardavvikelse som datan.
  // series: [{ values, cls, label, hist, curve, dash }]. Med opts.share visas andel i procent i stället för antal,
  // så att serier av olika storlek kan jämföras. opts: bins, xFmt, xLabel, yLabel, domain, legend, tip(bin, rows)
  function stats(values) {
    var n = values.length, mean = values.reduce(function (a, b) { return a + b; }, 0) / n;
    var sd = Math.sqrt(values.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / Math.max(1, n - 1));
    return { n: n, mean: mean, sd: sd };
  }
  function dist(container, series, opts) {
    opts = opts || {};
    var ctx = setup(container, opts.height || 300, opts);
    var all = [];
    series.forEach(function (s) { s.st = stats(s.values); all = all.concat(s.values); });
    if (!all.length) return;
    var xFmt = opts.xFmt || fmtTick;
    var lo = opts.domain ? opts.domain[0] : Math.min.apply(null, all), hi = opts.domain ? opts.domain[1] : Math.max.apply(null, all);
    var xs = niceTicks(lo, hi, ctx.w < 520 ? 5 : 8);
    var nb = opts.bins || 20, bw = (xs.max - xs.min) / nb;
    // Andel (eller antal) per intervall, värden utanför axeln räknas till ytterintervallen
    series.forEach(function (s) {
      s.counts = []; for (var i = 0; i < nb; i++) s.counts.push(0);
      s.values.forEach(function (v) { var i = Math.floor((v - xs.min) / bw); s.counts[Math.max(0, Math.min(nb - 1, i))]++; });
      s.k = opts.share ? 100 / s.st.n : 1;
    });
    var pdf = function (s, v) { var z = (v - s.st.mean) / s.st.sd; return Math.exp(-0.5 * z * z) / (s.st.sd * Math.sqrt(2 * Math.PI)); };
    var curveAt = function (s, v) { return s.st.sd > 0 ? pdf(s, v) * s.st.n * bw * s.k : 0; };
    var top = 0;
    series.forEach(function (s) {
      if (s.hist) s.counts.forEach(function (c) { top = Math.max(top, c * s.k); });
      if (s.curve && s.st.sd > 0) top = Math.max(top, curveAt(s, s.st.mean));
    });
    var ys = niceTicks(0, top * 1.12, 4);
    var yFmt = function (v) { return fmtTick(v) + (opts.share ? " %" : ""); };
    var m = { t: opts.yLabel ? 30 : 14, r: 14, b: 44, l: axisWidth(ys, yFmt) };
    var ih = ctx.h - m.t - m.b, iw = ctx.w - m.l - m.r;
    var x = function (v) { return m.l + (v - xs.min) / (xs.max - xs.min) * iw; };
    var y = function (v) { return m.t + (ys.max - v) / (ys.max - ys.min) * ih; };

    var g = grid(ctx, m, ys, y, yFmt);
    xs.ticks.forEach(function (t) {
      var xx = Math.round(x(t)) + 0.5;
      el("line", { x1: xx, x2: xx, y1: ctx.h - m.b, y2: ctx.h - m.b + 4, "class": "c-zero" }, g);
      text(g, xx, ctx.h - m.b + 17, xFmt(t), "c-axis", "middle");
    });
    if (opts.xLabel) text(ctx.svg, m.l + iw / 2, ctx.h - 6, opts.xLabel, "c-axis-title", "middle");
    if (opts.yLabel) text(ctx.svg, 0, 13, opts.yLabel, "c-axis-title");

    var band = el("rect", { y: m.t, height: ih, "class": "c-hover", visibility: "hidden" }, ctx.svg);
    // Staplarna, med 2px mellanrum
    var bars = el("g", { "class": "c-bars" }, ctx.svg);
    series.forEach(function (s) {
      if (!s.hist) return;
      s.counts.forEach(function (c, i) {
        var x0 = x(xs.min + i * bw) + 1, w = Math.max(1, x(xs.min + (i + 1) * bw) - x(xs.min + i * bw) - 2);
        var d = barPath(x0, y(0), y(c * s.k), w);
        if (d) el("path", { d: d, "class": "c-bar c-hist" }, bars);
      });
    });
    // Nollan
    if (xs.min < 0 && xs.max > 0) el("line", { x1: Math.round(x(0)) + 0.5, x2: Math.round(x(0)) + 0.5, y1: m.t, y2: ctx.h - m.b, "class": "c-zero" }, ctx.svg);

    // Kurvorna och en linje vid medelvärdet. En ensam kurva utan histogram får en svag yta under; flera kurvor ritas
    // utan yta, eftersom två färgade ytor ovanpå varandra blandas till en tredje färg.
    var curves = series.filter(function (s) { return s.curve && s.st.sd > 0; }).length;
    series.forEach(function (s) {
      if (!s.curve || !(s.st.sd > 0)) return;
      var cls = s.cls || "s1", d = "", steps = 160;
      for (var i = 0; i <= steps; i++) { var v = xs.min + (xs.max - xs.min) * i / steps; d += (i ? "L" : "M") + x(v).toFixed(1) + "," + y(curveAt(s, v)).toFixed(1); }
      if (curves === 1 && !s.hist) el("path", { d: d + "L" + x(xs.max) + "," + y(0) + "L" + x(xs.min) + "," + y(0) + "Z", "class": "c-area " + cls }, ctx.svg);
      el("path", { d: d, "class": "c-series " + cls + (s.dash ? " dash" : "") }, ctx.svg);
      var mx = Math.round(x(s.st.mean)) + 0.5;
      el("line", { x1: mx, x2: mx, y1: y(0), y2: y(curveAt(s, s.st.mean)), "class": "c-mean " + cls }, ctx.svg);
    });
    el("line", { x1: m.l, x2: ctx.w - m.r, y1: Math.round(y(0)) + 0.5, y2: Math.round(y(0)) + 0.5, "class": "c-zero" }, ctx.svg);
    // Medelvärdenas etiketter, utan att de krockar
    var labels = series.filter(function (s) { return s.curve && s.label; }).map(function (s) {
      return { s: s, x: x(s.st.mean), y: y(curveAt(s, s.st.mean)) - 8 };
    }).sort(function (a, b) { return a.y - b.y; });
    for (var k = 1; k < labels.length; k++) if (Math.abs(labels[k].x - labels[k - 1].x) < 120 && labels[k].y - labels[k - 1].y < 15) labels[k].y = labels[k - 1].y - 15;
    labels.forEach(function (l) {
      var anchor = l.x > ctx.w - m.r - 80 ? "end" : l.x < m.l + 80 ? "start" : "middle";
      text(ctx.svg, l.x, Math.max(12, l.y), l.s.label, "c-ptlabel", anchor);
    });

    // Ett intervall i taget, med andelarna för alla serier
    var show = function (i) {
      var a = xs.min + i * bw, b = a + bw;
      band.setAttribute("x", x(a)); band.setAttribute("width", Math.max(1, x(b) - x(a))); band.setAttribute("visibility", "visible");
      var rows = series.map(function (s) { return { s: s, count: s.counts[i], share: s.counts[i] / s.st.n * 100 }; });
      showTip(ctx, opts.tip ? opts.tip({ from: a, to: b }, rows) : xFmt(a) + " till " + xFmt(b), x(a + bw / 2), m.t + 40);
    };
    var hide = function () { band.setAttribute("visibility", "hidden"); hideTip(ctx); };
    var hit = el("rect", { x: m.l, y: 0, width: iw, height: ctx.h, fill: "transparent" }, ctx.svg);
    hit.addEventListener("pointermove", function (e) {
      var r = ctx.svg.getBoundingClientRect();
      show(Math.max(0, Math.min(nb - 1, Math.floor((e.clientX - r.left - m.l) / iw * nb))));
    });
    hit.addEventListener("pointerleave", hide);
    keys(ctx, nb, show, hide);
    return series.map(function (s) { return s.st; });
  }

  window.FFCharts = { columns: columns, line: line, lines: lines, xy: xy, dist: dist, regression: regression, stats: stats, median: median };
})();
