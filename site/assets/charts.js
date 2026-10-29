// Fondinsyn – små SVG-diagram utan beroenden.
// Färger kommer från CSS-klasser (c-pos, c-neg, c-line …) så att diagrammen följer ljust/mörkt tema.
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
    var lo = Math.floor(min / step) * step;
    var hi = Math.ceil(max / step) * step;
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

  function setup(container, height) {
    // Första gången diagrammet ritas animeras det fram, inte när det ritas om efter att fönstret ändrat storlek
    var fresh = !container.hasAttribute("data-drawn");
    container.setAttribute("data-drawn", "");
    container.innerHTML = "";
    container.style.position = "relative";
    var w = Math.max(240, container.clientWidth);
    var svg = el("svg", { width: w, height: height, viewBox: "0 0 " + w + " " + height, role: "img" }, null);
    container.appendChild(svg);
    var tip = document.createElement("div");
    tip.className = "chart-tip";
    container.appendChild(tip);
    return { svg: svg, w: w, h: height, tip: tip, fresh: fresh };
  }

  function showTip(ctx, html, x, y) {
    var tip = ctx.tip, wasOn = tip.classList.contains("on");
    // Första gången hoppar rutan direkt till sin plats, sedan glider den mellan punkterna
    if (!wasOn) tip.classList.add("jump");
    tip.innerHTML = html;
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    var left = x + 12;
    if (left + tw > ctx.w) left = x - tw - 12;
    if (left < 0) left = 0;
    var top = Math.max(0, Math.min(y - th / 2, ctx.h - th));
    tip.style.transform = "translate(" + Math.round(left) + "px," + Math.round(top) + "px)";
    tip.classList.add("on");
    if (!wasOn) { void tip.offsetWidth; tip.classList.remove("jump"); }
  }

  function hideTip(ctx) { ctx.tip.classList.remove("on"); }

  // Bredd för y-axelns etiketter, efter den längsta
  function axisWidth(scale, unit) {
    var n = 0;
    scale.ticks.forEach(function (t) { n = Math.max(n, (fmtTick(t) + (unit || "")).length); });
    return Math.max(30, 12 + n * 6.6);
  }

  // Tonad yta under en linje: en gradient per diagram
  var gradN = 0;
  function areaGradient(svg) {
    var id = "ffg" + (++gradN);
    var defs = el("defs", {}, svg);
    var lg = el("linearGradient", { id: id, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    el("stop", { offset: "0%", "class": "c-grad-top" }, lg);
    el("stop", { offset: "100%", "class": "c-grad-bottom" }, lg);
    return "url(#" + id + ")";
  }

  // Stapel med 4px rundad ände bort från nollinjen, rak vid nollinjen
  function barPath(x, y0, y1, w) {
    var h = Math.abs(y1 - y0);
    var r = Math.min(4, h / 2, w / 2);
    if (h < 0.5) return "";
    if (y1 < y0) {
      return "M" + x + "," + y0 + "V" + (y1 + r) + "Q" + x + "," + y1 + " " + (x + r) + "," + y1 +
        "H" + (x + w - r) + "Q" + (x + w) + "," + y1 + " " + (x + w) + "," + (y1 + r) + "V" + y0 + "Z";
    }
    return "M" + x + "," + y0 + "V" + (y1 - r) + "Q" + x + "," + y1 + " " + (x + r) + "," + y1 +
      "H" + (x + w - r) + "Q" + (x + w) + "," + y1 + " " + (x + w) + "," + (y1 - r) + "V" + y0 + "Z";
  }

  // x-etiketter: årtal vid första kvartalet (p.q = "2026Q1") eller första månaden (p.m = "2026-01") varje år
  function yearLabels(g, points, xAt, y, w) {
    var every = w < 420 ? 2 : 1, n = 0;
    points.forEach(function (p, i) {
      var first = p.q ? p.q.slice(5) === "1" : p.m ? p.m.slice(5) === "01" : false;
      if (first) {
        if (n++ % every === 0) text(g, xAt(i), y, (p.q || p.m).slice(0, 4), "c-axis", "middle");
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

  function grid(ctx, m, scale, y) {
    var g = el("g", {}, ctx.svg);
    scale.ticks.forEach(function (t) {
      var yy = Math.round(y(t)) + 0.5;
      el("line", { x1: m.l, x2: ctx.w - m.r, y1: yy, y2: yy, "class": t === 0 ? "c-zero" : "c-grid" }, g);
      text(g, m.l - 8, yy + 4, fmtTick(t), "c-axis", "end");
    });
    return g;
  }

  // Kolumner som kan vara positiva eller negativa (nettoköp per kvartal).
  // Med p.neg ritas dessutom en stapel nedåt i samma kolumn (t.ex. köp uppåt och sälj nedåt samma vecka).
  function columns(container, points, opts) {
    opts = opts || {};
    var ctx = setup(container, opts.height || 220);
    var vals = points.map(function (p) { return p.value || 0; }).concat(points.map(function (p) { return p.neg || 0; }));
    var scale = niceTicks(Math.min(0, Math.min.apply(null, vals)), Math.max(0, Math.max.apply(null, vals)), opts.ticks || 4);
    var m = { t: opts.label ? 24 : 10, r: 8, b: 26, l: axisWidth(scale) };
    var ih = ctx.h - m.t - m.b, iw = ctx.w - m.l - m.r;
    var y = function (v) { return m.t + (scale.max - v) / (scale.max - scale.min) * ih; };
    var band = iw / points.length;
    var bw = Math.max(2, Math.min(opts.barMax || 22, band * 0.62));
    var xAt = function (i) { return m.l + band * i + band / 2; };

    grid(ctx, m, scale, y);
    // Staplarna växer fram en i taget från nollinjen. Med opts.focus tonas alla utom den markerade ner.
    var g = el("g", { "class": "c-bars" + (ctx.fresh ? " grow" : "") + (opts.focus ? " focus" : "") }, ctx.svg);
    var bars = points.map(function (p, i) {
      if (p.value == null) return null;
      var d = barPath(xAt(i) - bw / 2, y(0), y(p.value), bw);
      if (!d) return null;
      var a = { d: d, "class": "c-bar " + (p.value >= 0 ? "c-pos" : "c-neg") + (p.highlight ? " c-strong" : "") };
      if (ctx.fresh) a.style = "animation-delay:" + Math.round(i * Math.min(40, 600 / points.length)) + "ms";
      return el("path", a, g);
    });
    var negBars = points.map(function (p, i) {
      if (!p.neg) return null;
      var d = barPath(xAt(i) - bw / 2, y(0), y(p.neg), bw);
      if (!d) return null;
      var a = { d: d, "class": "c-bar c-neg" };
      if (ctx.fresh) a.style = "animation-delay:" + Math.round(i * Math.min(40, 600 / points.length)) + "ms";
      return el("path", a, g);
    });
    // Värdet ovanför den markerade stapeln
    if (opts.label) {
      points.forEach(function (p, i) {
        if (!p.highlight || p.value == null) return;
        var ly = p.value >= 0 ? y(p.value) - 7 : y(p.value) + 15;
        var lx = Math.max(m.l + 16, Math.min(ctx.w - m.r - 16, xAt(i)));
        text(ctx.svg, lx, Math.max(12, ly), opts.label(p), "c-label c-label-hl", "middle");
      });
    }
    // nollinjen ovanpå staplarna
    var z = Math.round(y(0)) + 0.5;
    el("line", { x1: m.l, x2: ctx.w - m.r, y1: z, y2: z, "class": "c-zero" }, ctx.svg);
    if (opts.xLabel) xLabels(el("g", {}, ctx.svg), points, xAt, ctx.h - 6, band, opts.xLabel);
    else yearLabels(el("g", {}, ctx.svg), points, xAt, ctx.h - 6, ctx.w);

    var hit = el("rect", { x: m.l, y: 0, width: iw, height: ctx.h, fill: "transparent" }, ctx.svg);
    var on = -1;
    var mark = function (i, add) {
      [bars[i], negBars[i]].forEach(function (b) { if (b) b.classList[add ? "add" : "remove"]("on"); });
    };
    hit.addEventListener("pointermove", function (e) {
      var r = ctx.svg.getBoundingClientRect();
      var i = Math.max(0, Math.min(points.length - 1, Math.floor((e.clientX - r.left - m.l) / band)));
      if (i !== on) {
        if (on >= 0) mark(on, false);
        mark(i, true);
        on = i;
      }
      g.classList.add("hovering");
      showTip(ctx, opts.tip(points[i]), xAt(i), y(points[i].value || 0));
    });
    hit.addEventListener("pointerleave", function () {
      g.classList.remove("hovering");
      if (on >= 0) mark(on, false);
      on = -1;
      hideTip(ctx);
    });
  }

  // Linje med tunn yta under (antal fonder som äger)
  function line(container, points, opts) {
    opts = opts || {};
    var ctx = setup(container, opts.height || 220);
    var vals = points.map(function (p) { return p.value; }).filter(function (v) { return v != null; });
    var scale = niceTicks(0, Math.max.apply(null, vals.concat([1])), 4);
    var m = { t: 14, r: 40, b: 26, l: axisWidth(scale) };
    var ih = ctx.h - m.t - m.b, iw = ctx.w - m.l - m.r;
    var y = function (v) { return m.t + (scale.max - v) / (scale.max - scale.min) * ih; };
    var step = points.length > 1 ? iw / (points.length - 1) : 0;
    var xAt = function (i) { return m.l + step * i; };

    grid(ctx, m, scale, y);
    var d = "", a = "", started = false, last = -1;
    points.forEach(function (p, i) {
      if (p.value == null) { started = false; return; }
      d += (started ? "L" : "M") + xAt(i).toFixed(1) + "," + y(p.value).toFixed(1);
      started = true; last = i;
    });
    var first = -1;
    points.forEach(function (p, i) { if (first < 0 && p.value != null) first = i; });
    if (first >= 0) {
      a = d + "L" + xAt(last).toFixed(1) + "," + y(0) + "L" + xAt(first).toFixed(1) + "," + y(0) + "Z";
      el("path", { d: a, "class": "c-area", fill: areaGradient(ctx.svg) }, ctx.svg);
      el("path", ctx.fresh ? { d: d, "class": "c-line draw", pathLength: 1 } : { d: d, "class": "c-line" }, ctx.svg);
      var lp = points[last];
      el("circle", { cx: xAt(last), cy: y(lp.value), r: 4.5, "class": "c-dot" }, ctx.svg);
      text(ctx.svg, xAt(last) + 8, y(lp.value) + 4, opts.format ? opts.format(lp.value) : fmtTick(lp.value), "c-label");
    }
    yearLabels(el("g", {}, ctx.svg), points, xAt, ctx.h - 6, ctx.w);

    var cross = el("line", { y1: m.t, y2: ctx.h - m.b, "class": "c-cross", visibility: "hidden" }, ctx.svg);
    var dot = el("circle", { r: 4.5, "class": "c-dot", visibility: "hidden" }, ctx.svg);
    var hit = el("rect", { x: m.l - step / 2, y: 0, width: iw + step, height: ctx.h, fill: "transparent" }, ctx.svg);
    hit.addEventListener("pointermove", function (e) {
      var r = ctx.svg.getBoundingClientRect();
      var i = Math.max(0, Math.min(points.length - 1, Math.round((e.clientX - r.left - m.l) / (step || 1))));
      var p = points[i];
      cross.setAttribute("x1", xAt(i)); cross.setAttribute("x2", xAt(i)); cross.setAttribute("visibility", "visible");
      if (p.value != null) { dot.setAttribute("cx", xAt(i)); dot.setAttribute("cy", y(p.value)); dot.setAttribute("visibility", "visible"); }
      else dot.setAttribute("visibility", "hidden");
      showTip(ctx, opts.tip(p), xAt(i), y(p.value || 0));
    });
    hit.addEventListener("pointerleave", function () {
      cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); hideTip(ctx);
    });
  }

  // Punktdiagram: aktiv risk (x) mot avgift (y), med markerad zon
  function scatter(container, points, opts) {
    var ctx = setup(container, opts.height || 380);
    var m = { t: 28, r: 16, b: 42, l: 48 };
    var xs = niceTicks(0, opts.xMax, 5), ys = niceTicks(0, opts.yMax, 4);
    var ih = ctx.h - m.t - m.b, iw = ctx.w - m.l - m.r;
    var x = function (v) { return m.l + Math.min(v, xs.max) / xs.max * iw; };
    var y = function (v) { return m.t + (ys.max - Math.min(v, ys.max)) / ys.max * ih; };

    // Zonen "låg aktiv risk men hög avgift"
    el("rect", { x: m.l, y: m.t, width: x(opts.zone.x) - m.l, height: y(opts.zone.y) - m.t, "class": "c-zone" }, ctx.svg);
    text(ctx.svg, m.l + 8, m.t + 16, opts.zone.label, "c-zone-label");

    var g = el("g", {}, ctx.svg);
    ys.ticks.forEach(function (t) {
      var yy = Math.round(y(t)) + 0.5;
      el("line", { x1: m.l, x2: ctx.w - m.r, y1: yy, y2: yy, "class": t === 0 ? "c-zero" : "c-grid" }, g);
      text(g, m.l - 8, yy + 4, fmtTick(t) + " %", "c-axis", "end");
    });
    xs.ticks.forEach(function (t) {
      var xx = Math.round(x(t)) + 0.5;
      if (t > 0) el("line", { x1: xx, x2: xx, y1: m.t, y2: ctx.h - m.b, "class": "c-grid" }, g);
      text(g, xx, ctx.h - m.b + 16, fmtTick(t), "c-axis", "middle");
    });
    text(ctx.svg, m.l + iw / 2, ctx.h - 6, opts.xLabel, "c-axis-title", "middle");
    text(ctx.svg, m.l - 40, 14, opts.yLabel, "c-axis-title");

    // Rita markerade punkter sist så att de hamnar överst
    var order = points.slice().sort(function (a, b) { return (a.cat === opts.top) - (b.cat === opts.top); });
    var dots = el("g", {}, ctx.svg);
    order.forEach(function (p) {
      p._x = x(p.x); p._y = y(p.y);
      el("circle", { cx: p._x.toFixed(1), cy: p._y.toFixed(1), r: p.cat === opts.top ? 5.5 : 4.5, "class": "c-pt c-" + p.cat }, dots);
    });
    var ring = el("circle", { r: 9, "class": "c-ring", visibility: "hidden" }, ctx.svg);

    var current = null;
    var hit = el("rect", { x: 0, y: 0, width: ctx.w, height: ctx.h, fill: "transparent", style: "cursor:default" }, ctx.svg);
    hit.addEventListener("pointermove", function (e) {
      var r = ctx.svg.getBoundingClientRect();
      var px = e.clientX - r.left, py = e.clientY - r.top, best = null, bd = 18 * 18;
      points.forEach(function (p) {
        var dd = (p._x - px) * (p._x - px) + (p._y - py) * (p._y - py);
        if (dd < bd) { bd = dd; best = p; }
      });
      current = best;
      hit.style.cursor = best ? "pointer" : "default";
      if (!best) { ring.setAttribute("visibility", "hidden"); hideTip(ctx); return; }
      ring.setAttribute("cx", best._x); ring.setAttribute("cy", best._y); ring.setAttribute("visibility", "visible");
      showTip(ctx, opts.tip(best), best._x, best._y);
    });
    hit.addEventListener("pointerleave", function () { current = null; ring.setAttribute("visibility", "hidden"); hideTip(ctx); });
    hit.addEventListener("click", function () { if (current && opts.onClick) opts.onClick(current); });
  }

  // Flera tidsserier på en gemensam datumaxel (marknadsräntor). series: [{ label, cls, points: [{ d: "YYYY-MM-DD", v }] }]
  // Varje linje får en etikett vid sista punkten, och ett hårkors visar alla serier för samma datum.
  function lines(container, series, opts) {
    opts = opts || {};
    var ctx = setup(container, opts.height || 280);
    var narrow = ctx.w < 520;
    var m = { t: 16, r: narrow ? 12 : 64, b: 26, l: 44 };
    var all = [];
    series.forEach(function (s) { s.points.forEach(function (p) { all.push(p.v); }); });
    if (!all.length) return;
    var scale = niceTicks(Math.min(0, Math.min.apply(null, all)), Math.max.apply(null, all), 4);
    var ih = ctx.h - m.t - m.b, iw = ctx.w - m.l - m.r;
    var t0 = Infinity, t1 = -Infinity;
    series.forEach(function (s) { s.points.forEach(function (p) { p.t = Date.parse(p.d); if (p.t < t0) t0 = p.t; if (p.t > t1) t1 = p.t; }); });
    var x = function (t) { return m.l + (t - t0) / Math.max(1, t1 - t0) * iw; };
    var y = function (v) { return m.t + (scale.max - v) / (scale.max - scale.min) * ih; };

    var g = el("g", {}, ctx.svg);
    scale.ticks.forEach(function (t) {
      var yy = Math.round(y(t)) + 0.5;
      el("line", { x1: m.l, x2: ctx.w - m.r, y1: yy, y2: yy, "class": t === 0 ? "c-zero" : "c-grid" }, g);
      text(g, m.l - 8, yy + 4, fmtTick(t) + (opts.unit || ""), "c-axis", "end");
    });
    // Årtal vid varje årsskifte (vartannat år om axeln är trång)
    var y0 = new Date(t0).getUTCFullYear(), y1 = new Date(t1).getUTCFullYear();
    var years = []; for (var yr = y0 + 1; yr <= y1; yr++) years.push(yr);
    var every = Math.max(1, Math.ceil(years.length * 48 / iw));
    years.forEach(function (yr, i) {
      if (i % every) return;
      var xx = x(Date.UTC(yr, 0, 1));
      el("line", { x1: xx, x2: xx, y1: ctx.h - m.b, y2: ctx.h - m.b + 4, "class": "c-zero" }, g);
      text(g, xx, ctx.h - 6, String(yr), "c-axis", "middle");
    });

    // Linjerna, med en 2px ring av bakgrundsfärg runt slutpunkten
    var ends = [];
    series.forEach(function (s) {
      var d = "";
      s.points.forEach(function (p, i) { d += (i ? "L" : "M") + x(p.t).toFixed(1) + "," + y(p.v).toFixed(1); });
      el("path", ctx.fresh ? { d: d, "class": "c-series draw " + s.cls, pathLength: 1 } : { d: d, "class": "c-series " + s.cls }, ctx.svg);
      var lp = s.points[s.points.length - 1];
      if (lp) { el("circle", { cx: x(lp.t), cy: y(lp.v), r: 4, "class": "c-end " + s.cls }, ctx.svg); ends.push({ s: s, p: lp, y: y(lp.v) }); }
    });
    // Värdet vid linjens slut, utan att etiketterna krockar
    if (!narrow) {
      ends.sort(function (a, b) { return a.y - b.y; });
      for (var k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 14) ends[k].y = ends[k - 1].y + 14;
      ends.forEach(function (e) { text(ctx.svg, ctx.w - m.r + 8, e.y + 4, (opts.format ? opts.format(e.p.v) : fmtTick(e.p.v)) + (opts.unit || ""), "c-label"); });
    }

    var cross = el("line", { y1: m.t, y2: ctx.h - m.b, "class": "c-cross", visibility: "hidden" }, ctx.svg);
    var dots = series.map(function (s) { return el("circle", { r: 4, "class": "c-end " + s.cls, visibility: "hidden" }, ctx.svg); });
    var hit = el("rect", { x: m.l, y: 0, width: iw, height: ctx.h, fill: "transparent" }, ctx.svg);
    function nearest(s, t) {
      var lo = 0, hi = s.points.length - 1;
      while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (s.points[mid].t < t) lo = mid; else hi = mid; }
      return Math.abs(s.points[lo].t - t) <= Math.abs(s.points[hi].t - t) ? s.points[lo] : s.points[hi];
    }
    hit.addEventListener("pointermove", function (e) {
      var r = ctx.svg.getBoundingClientRect();
      var t = t0 + (e.clientX - r.left - m.l) / iw * (t1 - t0);
      var rows = [], cx = null;
      series.forEach(function (s, i) {
        var p = nearest(s, t);
        if (cx == null) cx = x(p.t);
        dots[i].setAttribute("cx", x(p.t)); dots[i].setAttribute("cy", y(p.v)); dots[i].setAttribute("visibility", "visible");
        rows.push({ s: s, p: p });
      });
      cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible");
      showTip(ctx, opts.tip(rows), cx, m.t + 30);
    });
    hit.addEventListener("pointerleave", function () {
      cross.setAttribute("visibility", "hidden"); dots.forEach(function (d) { d.setAttribute("visibility", "hidden"); }); hideTip(ctx);
    });
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

  // Punktdiagram med valfri storlek per punkt, trendlinje och etiketter i kvadranterna. Namnen står inte i diagrammet
  // utan visas när man pekar på en punkt (på mobilen: första trycket visar, andra öppnar).
  // points: [{ x, y, size, cls }]. opts: xFmt, yFmt (axeltext), xLabel, yLabel, trend, quad { tl, tr, bl, br },
  // bands { above, below } (tonad bakgrund över och under noll med text), xHint [vänster, höger] (riktningen i klartext),
  // tip(p), onClick(p)
  function xy(container, points, opts) {
    opts = opts || {};
    var ctx = setup(container, opts.height || 380);
    if (!points.length) return;
    var xFmt = opts.xFmt || fmtTick, yFmt = opts.yFmt || fmtTick;
    var ext = function (key, pad) {
      var vals = points.map(function (p) { return p[key]; });
      var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), d = (hi - lo) * pad || 1;
      return [lo - d, hi + d];
    };
    var dx = opts.xDomain || ext("x", 0.04), dy = opts.yDomain || ext("y", 0.06);
    var xs = niceTicks(dx[0], dx[1], ctx.w < 520 ? 4 : 6), ys = niceTicks(dy[0], dy[1], 5);
    var yw = 0; ys.ticks.forEach(function (t) { yw = Math.max(yw, yFmt(t).length); });
    var m = { t: 26, r: 16, b: 44, l: Math.max(34, 14 + yw * 6.6) };
    var ih = ctx.h - m.t - m.b, iw = ctx.w - m.l - m.r;
    var x = function (v) { return m.l + (Math.max(xs.min, Math.min(xs.max, v)) - xs.min) / (xs.max - xs.min) * iw; };
    var y = function (v) { return m.t + (ys.max - Math.max(ys.min, Math.min(ys.max, v))) / (ys.max - ys.min) * ih; };

    var g = el("g", {}, ctx.svg);
    ys.ticks.forEach(function (t) {
      var yy = Math.round(y(t)) + 0.5;
      el("line", { x1: m.l, x2: ctx.w - m.r, y1: yy, y2: yy, "class": t === 0 ? "c-zero" : "c-grid" }, g);
      text(g, m.l - 8, yy + 4, yFmt(t), "c-axis", "end");
    });
    xs.ticks.forEach(function (t) {
      var xx = Math.round(x(t)) + 0.5;
      el("line", { x1: xx, x2: xx, y1: m.t, y2: ctx.h - m.b, "class": t === 0 ? "c-zero" : "c-grid" }, g);
      text(g, xx, ctx.h - m.b + 16, xFmt(t), "c-axis", "middle");
    });
    // Axlarnas namn, och vad riktningarna betyder i klartext ("← Kursen föll", "Kursen steg →")
    if (opts.xHint) {
      text(ctx.svg, m.l, ctx.h - 6, opts.xHint[0], "c-hint");
      text(ctx.svg, ctx.w - m.r, ctx.h - 6, opts.xHint[1], "c-hint", "end");
    }
    if (opts.xLabel && !(opts.xHint && iw < 520)) text(ctx.svg, m.l + iw / 2, ctx.h - 6, opts.xLabel, "c-axis-title", "middle");
    if (opts.yLabel) text(ctx.svg, 4, 14, opts.yLabel, "c-axis-title");

    // Tonad bakgrund över och under nollan, med vad den betyder ("Fonderna köpte"), under rutnätet
    if (opts.bands && ys.min < 0 && ys.max > 0) {
      var y0 = y(0);
      g.insertBefore(el("rect", { x: m.l, y: y0, width: iw, height: ctx.h - m.b - y0, "class": "c-band-neg" }, null), g.firstChild);
      g.insertBefore(el("rect", { x: m.l, y: m.t, width: iw, height: y0 - m.t, "class": "c-band-pos" }, null), g.firstChild);
      if (opts.bands.above) text(ctx.svg, m.l + 10, m.t + 18, opts.bands.above, "c-band-label pos");
      if (opts.bands.below) text(ctx.svg, m.l + 10, ctx.h - m.b - 10, opts.bands.below, "c-band-label neg");
    }

    // Kvadranternas namn i hörnen
    if (opts.quad) {
      var q = opts.quad;
      if (q.tl) text(ctx.svg, m.l + 8, m.t + 14, q.tl, "c-quad");
      if (q.tr) text(ctx.svg, ctx.w - m.r - 8, m.t + 14, q.tr, "c-quad", "end");
      if (q.bl) text(ctx.svg, m.l + 8, ctx.h - m.b - 8, q.bl, "c-quad");
      if (q.br) text(ctx.svg, ctx.w - m.r - 8, ctx.h - m.b - 8, q.br, "c-quad", "end");
    }

    // Trendlinjen ritas bara inom diagrammet
    var reg = opts.trend ? regression(points) : null;
    if (reg) {
      var x0 = xs.min, x1 = xs.max, ya = reg.a + reg.b * x0, yb = reg.a + reg.b * x1;
      el("line", { x1: x(x0), y1: y(ya), x2: x(x1), y2: y(yb), "class": "c-trend" }, ctx.svg);
    }

    // Stora punkter först så att små hamnar ovanpå. Punkterna tonas in från vänster till höger.
    // Storleken räknas mot den 95:e percentilen, så att en jätte (AP7) inte gör alla andra till prickar
    var sizes = points.map(function (p) { return p.size || 0; }).sort(function (a, b) { return a - b; });
    var maxS = Math.max(1e-9, sizes[Math.floor(0.95 * (sizes.length - 1))]);
    points.forEach(function (p) { p._r = p.size != null ? 2.5 + 9 * Math.sqrt(Math.min(1, p.size / maxS)) : 4.5; p._x = x(p.x); p._y = y(p.y); });
    var order = points.slice().sort(function (a, b) { return b._r - a._r; });
    var dots = el("g", { "class": "c-pts" + (ctx.fresh ? " pop" : "") }, ctx.svg);
    order.forEach(function (p) {
      var a = { cx: p._x.toFixed(1), cy: p._y.toFixed(1), r: p._r.toFixed(1), "class": "c-pt " + (p.cls || "c-brand") };
      if (ctx.fresh) a.style = "animation-delay:" + Math.round((p._x - m.l) / iw * 500) + "ms";
      p._el = el("circle", a, dots);
    });
    var ring = el("circle", { r: 9, "class": "c-ring", visibility: "hidden" }, ctx.svg);

    var current = null, tapped = null, lastType = "mouse";
    var hit = el("rect", { x: 0, y: 0, width: ctx.w, height: ctx.h, fill: "transparent" }, ctx.svg);
    function pick(e) {
      var r = ctx.svg.getBoundingClientRect();
      var px = e.clientX - r.left, py = e.clientY - r.top, best = null, bd = 22 * 22;
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
      ring.setAttribute("cx", best._x); ring.setAttribute("cy", best._y); ring.setAttribute("r", best._r + 4); ring.setAttribute("visibility", "visible");
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
    return reg;
  }

  // Fördelning: histogram och normalfördelningskurvor med samma medelvärde och standardavvikelse som datan.
  // series: [{ values, cls, label, hist, curve, dash }]. Med opts.share visas andel i procent i stället för antal,
  // så att serier av olika storlek kan jämföras. opts: bins, xFmt, xLabel, yLabel, domain, tip(bin, rows)
  function stats(values) {
    var n = values.length, mean = values.reduce(function (a, b) { return a + b; }, 0) / n;
    var sd = Math.sqrt(values.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / Math.max(1, n - 1));
    return { n: n, mean: mean, sd: sd };
  }
  function dist(container, series, opts) {
    opts = opts || {};
    var ctx = setup(container, opts.height || 300);
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
    var ys = niceTicks(0, top * 1.08, 4);
    var m = { t: 26, r: 16, b: 44, l: axisWidth(ys, opts.share ? " %" : "") };
    var ih = ctx.h - m.t - m.b, iw = ctx.w - m.l - m.r;
    var x = function (v) { return m.l + (v - xs.min) / (xs.max - xs.min) * iw; };
    var y = function (v) { return m.t + (ys.max - v) / (ys.max - ys.min) * ih; };

    var g = el("g", {}, ctx.svg);
    ys.ticks.forEach(function (t) {
      var yy = Math.round(y(t)) + 0.5;
      el("line", { x1: m.l, x2: ctx.w - m.r, y1: yy, y2: yy, "class": t === 0 ? "c-zero" : "c-grid" }, g);
      text(g, m.l - 8, yy + 4, fmtTick(t) + (opts.share ? " %" : ""), "c-axis", "end");
    });
    xs.ticks.forEach(function (t) { text(g, x(t), ctx.h - m.b + 16, xFmt(t), "c-axis", "middle"); });
    if (opts.xLabel) text(ctx.svg, m.l + iw / 2, ctx.h - 6, opts.xLabel, "c-axis-title", "middle");
    if (opts.yLabel) text(ctx.svg, 4, 14, opts.yLabel, "c-axis-title");

    // Staplarna, med 2px mellanrum
    var bars = el("g", { "class": "c-bars" + (ctx.fresh ? " grow" : "") }, ctx.svg), barEls = [];
    series.forEach(function (s) {
      if (!s.hist) return;
      s.counts.forEach(function (c, i) {
        var x0 = x(xs.min + i * bw) + 1, w = Math.max(1, x(xs.min + (i + 1) * bw) - x(xs.min + i * bw) - 2);
        var d = barPath(x0, y(0), y(c * s.k), w);
        var a = { d: d || "M0,0", "class": "c-bar c-hist" };
        if (ctx.fresh) a.style = "animation-delay:" + Math.round(i * 400 / nb) + "ms";
        barEls[i] = el("path", a, bars);
      });
    });
    // Nollan
    if (xs.min < 0 && xs.max > 0) el("line", { x1: x(0), x2: x(0), y1: m.t, y2: ctx.h - m.b, "class": "c-zero" }, ctx.svg);

    // Kurvorna, med tonad yta under, och en linje vid medelvärdet
    series.forEach(function (s) {
      if (!s.curve || !(s.st.sd > 0)) return;
      var d = "", steps = 160;
      for (var i = 0; i <= steps; i++) { var v = xs.min + (xs.max - xs.min) * i / steps; d += (i ? "L" : "M") + x(v).toFixed(1) + "," + y(curveAt(s, v)).toFixed(1); }
      el("path", { d: d + "L" + x(xs.max) + "," + y(0) + "L" + x(xs.min) + "," + y(0) + "Z", "class": "c-curve-fill " + (s.cls || "c-brand") }, ctx.svg);
      var ca = { d: d, "class": "c-curve " + (s.cls || "c-brand") + (s.dash ? " dash" : "") };
      if (ctx.fresh && !s.dash) { ca["class"] += " draw"; ca.pathLength = 1; }
      el("path", ca, ctx.svg);
      var mx = x(s.st.mean);
      el("line", { x1: mx, x2: mx, y1: y(0), y2: y(curveAt(s, s.st.mean)), "class": "c-mean " + (s.cls || "c-brand") }, ctx.svg);
    });
    // Medelvärdenas etiketter, utan att de krockar
    var labels = series.filter(function (s) { return s.curve && s.label; }).map(function (s) {
      return { s: s, x: x(s.st.mean), y: y(curveAt(s, s.st.mean)) - 8 };
    }).sort(function (a, b) { return a.y - b.y; });
    for (var k = 1; k < labels.length; k++) if (Math.abs(labels[k].x - labels[k - 1].x) < 120 && labels[k].y - labels[k - 1].y < 15) labels[k].y = labels[k - 1].y - 15;
    labels.forEach(function (l) {
      var anchor = l.x > ctx.w - m.r - 80 ? "end" : l.x < m.l + 80 ? "start" : "middle";
      text(ctx.svg, l.x, Math.max(12, l.y), l.s.label, "c-ptlabel", anchor);
    });

    // Hårkors per intervall med andelarna för alla serier
    var band = el("rect", { y: m.t, height: ih, "class": "c-hover", visibility: "hidden" }, ctx.svg);
    ctx.svg.insertBefore(band, bars);
    var hit = el("rect", { x: m.l, y: 0, width: iw, height: ctx.h, fill: "transparent" }, ctx.svg);
    hit.addEventListener("pointermove", function (e) {
      var r = ctx.svg.getBoundingClientRect();
      var i = Math.max(0, Math.min(nb - 1, Math.floor((e.clientX - r.left - m.l) / iw * nb)));
      var a = xs.min + i * bw, b = a + bw;
      band.setAttribute("x", x(a)); band.setAttribute("width", Math.max(1, x(b) - x(a))); band.setAttribute("visibility", "visible");
      var rows = series.map(function (s) { return { s: s, count: s.counts[i], share: s.counts[i] / s.st.n * 100 }; });
      showTip(ctx, opts.tip ? opts.tip({ from: a, to: b }, rows) : xFmt(a) + " till " + xFmt(b), x(a + bw / 2), m.t + 40);
    });
    hit.addEventListener("pointerleave", function () { band.setAttribute("visibility", "hidden"); hideTip(ctx); });
    return series.map(function (s) { return s.st; });
  }

  window.FFCharts = { columns: columns, line: line, scatter: scatter, lines: lines, xy: xy, dist: dist, regression: regression, stats: stats };
})();
