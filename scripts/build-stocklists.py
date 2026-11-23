#!/usr/bin/env python3
"""Samlar bolagens senaste kvartalsrapport, nästa rapportdatum och börslista till site/data/stocklist.json.

Underlag för sidorna Bolagens rapporter (#/bolagsrapporter) och börslistorna (#/lista/<lista>). Allt kommer ur
site/data/bolag/<ISIN>.json, som scripts/build-companies.py bygger ur bolagens egna rapporter och MFN.
Bara svenska bolag (inte filerna ur SEC). Körs efter build-companies.py; behöver bara standardbiblioteket.

Format:
  lists:   {ISIN: "large" | "mid" | "small" | "fn"}
  reports: [[ISIN:er, datum, period, månader, valuta, omsättning, rörelseresultat, resultat, utan siffror, kursreaktion]]
           (talen som [i år, året innan]; ett bolag med flera aktieslag står en gång)
  next:    [[ISIN:er, datum, rapport]]  (kommande rapporter, högst 60 dagar fram)
  rx:      [[ISIN:er, [[datum, procent], ...]]]  aktiens rörelse på rapportdagarna, nyast först (bara rapporter
           som kom före börsöppning; se price_reaction i build-companies.py)
"""
import datetime as dt
import json
import os
import sys

LISTS = {
    "Large Cap Stockholm": "large",
    "Mid Cap Stockholm": "mid",
    "Small Cap Stockholm": "small",
    "First North Stockholm": "fn",
}


def main():
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
    src = os.path.join(root, "site", "data", "bolag")
    out = os.path.join(root, "site", "data", "stocklist.json")
    today = dt.date.today()
    lists, by_co = {}, {}
    for name in sorted(os.listdir(src)):
        if not name.endswith(".json") or name.startswith("_"):
            continue
        isin = name[:-5]
        try:
            d = json.load(open(os.path.join(src, name), encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if d.get("src") == "sec":
            continue
        lst = LISTS.get((d.get("facts") or {}).get("list") or "")
        if lst:
            lists[isin] = lst
        # samma bolag med flera aktieslag: en rad per bolag
        key = d.get("mfn") or d.get("parent") or isin
        co = by_co.setdefault(key, {"isins": [], "q": None, "next": None, "rx": None})
        co["isins"].append(isin)
        q = d.get("q")
        if q and q.get("date") and q.get("p") and not co["q"]:
            co["q"] = [q["date"], q["p"], q.get("m") or 3, q.get("cur")] + [q.get(k) for k in ("rev", "ebit", "net")] + \
                      [1 if q.get("noNumbers") else 0, q.get("react")]
        if d.get("reacts") and not co["rx"]:
            co["rx"] = d["reacts"]
        nxt = (d.get("cal") or {}).get("next")
        if nxt and not co["next"]:
            try:
                days = (dt.date.fromisoformat(nxt[0]) - today).days
            except ValueError:
                days = -1
            if 0 <= days <= 60:
                co["next"] = nxt[:2]
    reports = sorted(([sorted(c["isins"])] + c["q"] for c in by_co.values() if c["q"]), key=lambda r: r[1], reverse=True)
    upcoming = sorted(([sorted(c["isins"])] + c["next"] for c in by_co.values() if c["next"]), key=lambda r: r[1])
    rx = [[sorted(c["isins"]), c["rx"]] for c in by_co.values() if c["rx"]]
    doc = {"built": today.isoformat(), "lists": lists, "reports": reports, "next": upcoming, "rx": rx}
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    counts = {}
    for v in lists.values():
        counts[v] = counts.get(v, 0) + 1
    print("  stocklist.json: %d rapporter, %d kommande, listor %s" % (len(reports), len(upcoming), counts))
    if not reports:
        print("Inga rapporter hittades", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
