#!/usr/bin/env python3
"""
Nyheter från bolagen, återköp av egna aktier och nyemissioner, ur bolagens egna pressmeddelanden på MFN.

MFN:s nyhetsflöde för Norden (svenska pressmeddelanden) läses sida för sida tills det möter det som redan är sparat.
Pressmeddelanden från bolag vars aktier finns på sajten sparas med en etikett efter rubriken (rapport, ledning,
förvärv, order, återköp, emission, bud, stämma). Ur två sorters meddelanden läses också siffror:
  - Återköp: bolagens veckorapporter har en tabell med datum, antal aktier, snittpris och belopp per dag. En rad
    sparas bara om antal × snittpris stämmer med beloppet, så att inga felaktiga tal kommer med.
  - Nyemissioner: beslut om riktad emission eller företrädesemission, med belopp och teckningskurs när de står
    tydligt i rubriken eller texten.
MFN:s robots.txt förbjuder *.json, så bara HTML-sidorna används. Högst två anrop i sekunden.

Läget sparas i data/news-state.json (i repot, de senaste 120 dagarna). Till sajten skrivs (gitignorerat):
  site/data/news/<ISIN>.json   ett bolags pressmeddelanden, återköp och emissioner (aktiesidan)
  site/data/news-latest.json   de senaste pressmeddelandena från de bolag fonderna äger mest av (startsidan)
  site/data/buybacks.json      återköp per bolag (sidan Återköp)
  site/data/issues.json        nyemissioner (sidan Emissioner)

  py scripts/build-news.py             vanlig körning (läser tills det möter sparade meddelanden, högst 6 sidor)
  py scripts/build-news.py --pages 30  första körningen: läs bakåt 120 dagar
"""
import argparse
import datetime as dt
import html
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

MFN = "https://mfn.se"
UA = "Fondinsyn/1.0 (https://www.fondinsyn.se)"
TODAY = dt.date.today()
KEEP_DAYS = 120
STATE = os.path.join("data", "news-state.json")
OUT = os.path.join("site", "data")
MONTHS = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "maj": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "okt": 10, "nov": 11, "dec": 12}

# Etikett efter rubriken. Ordningen spelar roll: den första som passar gäller.
TAGS = [
    ("bud", r"offentlig[ta]? (?:uppköps|kontant|aktie)?erbjudande|uppköpserbjudande|budpliktsbud|budkommitt|erbjudandet till aktieägarna"),
    ("aterkop", r"återköp|förvärv av egna aktier|egna aktier"),
    ("emission", r"nyemission|företrädesemission|riktad emission|riktade emissioner|emission av (?:nya )?aktier|emissionen|teckningsperiod|teckningstid"),
    ("rapport", r"delårsrapport|kvartalsrapport|bokslutskommunik|halvårsrapport|årsredovisning|års- och hållbarhetsredovisning|delårsredogörelse|"
                r"interim report|year-end report|preliminär[a-z]* (?:resultat|siffror|försäljning)|vinstvarning|resultatvarning|"
                r"\b(?:första|andra|tredje|fjärde) kvartalet \d{4}|\bQ[1-4] 20\d\d\b|januari\s*[–-]\s*(?:mars|juni|september|december) 20\d\d"),
    ("ledning", r"\b(?:ny|nya|utser|utnämner|rekryterar|tillträder|lämnar|avgår|avgående|tillförordnad|t\.f\.)\b.{0,40}\b(?:vd|verkställande direktör|"
                r"cfo|finanschef|ekonomichef|ordförande|koncernchef)\b|förändring(?:ar)? i (?:koncern)?ledningen|ny (?:koncern)?ledning|\b(?:vd|cfo|finanschef|koncernchef)\b.{0,30}\b(?:lämnar|avgår|utses|utnämns|byts)"),
    ("forvarv", r"förvärvar|förvärv av|förvärvet av|avyttrar|avyttring|säljer (?:sin|sitt|sina|verksamhet|dotterbolag|affärsområde)|går samman|fusion"),
    ("order", r"\border\b|ordern|beställning|tecknar (?:avtal|kontrakt|ramavtal)|tilldelas|vinner (?:upphandling|kontrakt)|ramavtal|kontrakt (?:med|värt|om)"),
    ("stamma", r"kallelse|årsstämma|bolagsstämma|kommuniké från|valberedning"),
]
TAGS = [(k, re.compile(rx, re.I)) for k, rx in TAGS]
# Rutinmeddelanden som inte säger något nytt får ingen etikett
NOISE = re.compile(r"inbjudan|invitation|ändrat datum|nytt datum|datum för|webbsändning|webcast|telefonkonferens|presentation av|presenterar på|"
                   r"nytt antal|antal aktier och röster|kommer att publicera|publiceras den", re.I)

ISSUE_NEW = re.compile(r"(?:beslutar|beslutat|genomför|genomfört|offentliggör|föreslår|avser|tillförs|säkerställer|kapitalanskaffning)[^.]{0,80}?"
                       r"(?:riktad[e]? (?:ny)?emission(?:er)?|företrädesemission|nyemission)|"
                       r"(?:riktad[e]? (?:ny)?emission(?:er)?|företrädesemission|nyemission)[^.]{0,30}?(?:om|på|uppgående till) (?:ca\.? |cirka |totalt |omkring |ungefär )*\d", re.I)
ISSUE_SKIP = re.compile(r"portföljbolag|innehavet|intressebolag|utreder|undersöker|nuvärde|värdering|utfall|registrer|teckningsperiod|teckningstid|inleds|memorandum|informationsdokument|prospekt|villkor och anvisningar|"
                        r"obligation|teckningsoption|stödjer|garant|övertilldelning|kompensationsemission|slutlig|sista dag|handel med|"
                        r"bta|uta|delregistr|påminnelse|tilldelning", re.I)
BUYBACK_START = re.compile(r"(?:beslutar|beslutat|inleder|initierar|påbörjar|startar|offentliggör|lanserar)[^.]{0,60}?(?:återköp|återköpsprogram)", re.I)


def fetch(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8", "replace")
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(5 * (i + 1))


def plain(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or "")).replace("­", "")).strip()


def norm(name):
    n = re.sub(r"\(publ\)|\b(ab|asa|oyj|abp|plc|a/s|as|ltd|inc|ser\.?\s*[a-d]|[a-d]-?aktie\w*|aktiebolag|holding|group)\b", " ", (name or "").lower())
    return re.sub(r"[^a-z0-9åäöéü]+", " ", n).strip()


def tag_of(title):
    if NOISE.search(title):
        return ""
    for k, rx in TAGS:
        if rx.search(title):
            return k
    return ""


def num(s):
    s = re.sub(r"[\s  ]", "", s).replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


CACHE = os.path.join(".cache", "mfn")


def body_of(path):
    """Pressmeddelandets text. Sparas i .cache/mfn så att en omläsning (--reparse) inte hämtar allt igen."""
    key = os.path.join(CACHE, re.sub(r"[^a-zA-Z0-9-]+", "_", path)[-180:] + ".txt")
    if os.path.exists(key):
        return open(key, encoding="utf-8").read()
    page = fetch(MFN + path)
    m = re.search(r'<div class="content s-[a-z]+">(.*?)</article>', page, re.S)
    text = plain(m.group(1) if m else "")
    os.makedirs(CACHE, exist_ok=True)
    open(key, "w", encoding="utf-8").write(text)
    return text


# ---------- Återköp: tabellen med datum, antal aktier, snittpris och belopp per dag ----------

DATE_RX = re.compile(r"(?<![\d-])(?:(\d{4})-(\d{2})-(\d{2})|(\d{1,2})-(\d{1,2})-(\d{2})(?!\d)|(\d{1,2})\s+(jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec)[a-zé]*\.?\s+(\d{4}))", re.I)
TOKEN_RX = re.compile(r"\d{1,3}(?:[   ]\d{3})*(?:,\d+)?|\d+(?:,\d+)?")


def row_date(m, year_hint):
    try:
        if m.group(1):
            return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        if m.group(4):
            # "09-11-26": dag-månad-år
            return dt.date(2000 + int(m.group(6)), int(m.group(5)), int(m.group(4)))
        return dt.date(int(m.group(9)), MONTHS[m.group(8).lower()[:3]], int(m.group(7)))
    except (ValueError, KeyError):
        return None


def parse_rows(body):
    """Dagsrader [datum, antal, pris, belopp] där antal × pris stämmer med beloppet (inom 0,5 %)."""
    rows = {}
    ms = list(DATE_RX.finditer(body))
    for i, m in enumerate(ms):
        d = row_date(m, None)
        if not d:
            continue
        seg = body[m.end(): ms[i + 1].start() if i + 1 < len(ms) else min(len(body), m.end() + 120)][:120]
        # siffrorna direkt efter datumet, fram till första ord
        mm = re.match(r"[\s:]*((?:[\d   ,.]+))", seg)
        if not mm:
            continue
        toks = re.findall(r"\d+(?:,\d+)?", mm.group(1))
        if len(toks) < 3:
            continue
        found = None
        # priset är ett decimaltal; volymen är talgrupperna före (ibland följda av en extra kolumn), beloppet talgrupperna efter
        for pi, pt in enumerate(toks):
            if "," not in pt or pi == 0:
                continue
            price = num(pt)
            if not price or price <= 0:
                continue
            before, after = toks[:pi], toks[pi + 1:]
            for k in range(1, len(before) + 1):
                if any(len(t) != 3 or "," in t for t in before[1:k]) or "," in before[0]:
                    continue
                vol = num("".join(before[:k]))
                # beloppet är alla talgrupper efter priset (fram till nästa ord), så att ett kortare tal inte råkar stämma
                if not after or any(len(t.split(",")[0]) != 3 for t in after[1:]) or any("," in t for t in after[:-1]):
                    continue
                tot = num("".join(after))
                if vol and tot and vol >= 1 and abs(vol * price - tot) <= 0.002 * tot:
                    found = (vol, price, tot)
                if found:
                    break
            if found:
                break
        if found and d <= TODAY and (TODAY - d).days <= 400:
            rows[d.isoformat()] = [d.isoformat(), int(found[0]), round(found[1], 4), round(found[2])]
    return sorted(rows.values())


def buyback_of(body):
    rows = parse_rows(body)
    if not rows:
        return None
    cur = "EUR" if re.search(r"\(EUR\)|\bEUR\b|euro", body) and not re.search(r"\(SEK\)|\bSEK\b|kronor", body) else "SEK"
    isin = re.search(r"ISIN(?:-kod)?:?\s*((?:SE|FI|DK|NO)[0-9A-Z]{10})", body)
    return {"rows": rows, "cur": cur, "isin": isin.group(1) if isin else None}


# ---------- Nyemissioner ----------

AMOUNT_RX = re.compile(r"(?:om|på|uppgående till|tillförs[^.]{0,30}?|totalt|cirka|ca\.?)\s+(?:ca\.?\s+|cirka\s+|totalt\s+|omkring\s+|ungefär\s+|högst\s+)*"
                       r"(\d{1,3}(?:[  ]\d{3})*(?:,\d+)?)\s*(MSEK|miljoner kronor|mkr|Mkr|miljarder kronor|mdkr|MDKR|BSEK|MEUR|miljoner euro)", re.I)
PRICE_RX = re.compile(r"teckningskurs(?:en)?(?: per aktie)?(?: är| uppgår till| om| på| har fastställts till| fastställdes till|:)?\s+(?:\w+\s+){0,2}?(\d{1,5}(?:,\d{1,4})?)\s*(?:kronor|kr|SEK)", re.I)


def amount_of(text):
    m = AMOUNT_RX.search(text)
    if not m:
        return None, None
    v = num(m.group(1))
    u = m.group(2).lower()
    if v is None:
        return None, None
    if u in ("miljarder kronor", "mdkr", "bsek"):
        return v * 1e9, "SEK"
    if u in ("meur", "miljoner euro"):
        return v * 1e6, "EUR"
    return v * 1e6, "SEK"


EMISSION_WORD = re.compile(r"(?:riktad[e]? (?:ny)?emission(?:er)?|företrädesemission(?:en)?|nyemission(?:en)?|emission(?:en)? av (?:units|aktier|nya aktier|B-aktier))", re.I)


def after_emission(text, span=90):
    """Beloppet som står strax efter ordet emission ("riktad nyemission om cirka 25 MSEK")."""
    for m in EMISSION_WORD.finditer(text):
        a = amount_of(text[m.start(): m.end() + span])
        if a[0] is not None:
            return a
    return None, None


def issue_of(title, body):
    kind = "foretrade" if re.search(r"företrädesemission", title, re.I) else "riktad" if re.search(r"riktad", title, re.I) else "ny"
    amt, cur = after_emission(title)
    if amt is None and re.search(r"tillförs", title, re.I):
        amt, cur = amount_of(title)
    if amt is None:
        # i texten bara i första stycket, där beslutet beskrivs
        amt, cur = after_emission(body[:1200])
    price = PRICE_RX.search(body[:4000])
    return {"kind": kind, "amount": round(amt) if amt else None, "cur": cur, "price": num(price.group(1)) if price else None}


# ---------- Huvudprogrammet ----------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", type=int, default=6, help="högst så många sidor om 500 pressmeddelanden")
    ap.add_argument("--max-bodies", type=int, default=150, help="högst så många pressmeddelanden att läsa i sin helhet")
    ap.add_argument("--reparse", action="store_true", help="läs om återköp och emissioner ur alla sparade pressmeddelanden")
    args = ap.parse_args()

    state = {"items": [], "buybacks": {}, "issues": []}
    if os.path.exists(STATE):
        try:
            state.update(json.load(open(STATE, encoding="utf-8")))
        except ValueError:
            pass
    seen = {it["u"] for it in state["items"]}
    newest = max((it["d"] for it in state["items"]), default="")

    # aktierna på sajten (senaste kvartalet) och MFN-bolagen (ur bolagsfakta)
    index = json.load(open(os.path.join(OUT, "index.json"), encoding="utf-8"))
    q = json.load(open(os.path.join(OUT, index["quarters"][0]["id"] + ".json"), encoding="utf-8"))
    names = {s[0]: s[1] for s in q["stocks"]}
    by_name = {}
    for isin, n in names.items():
        if isin[:2] in ("SE", "FI", "DK", "NO"):
            by_name.setdefault(norm(n), []).append(isin)
    slug_isins = {}
    try:
        bs = json.load(open(os.path.join("data", "bolag-state.json"), encoding="utf-8"))
        for isin, s in bs.get("isin", {}).items():
            if s.get("mfn") and isin in names:
                slug_isins.setdefault(s["mfn"], []).append(isin)
    except (OSError, ValueError):
        pass

    # Nyhetsflödet, nyast först, tills det möter sparade meddelanden eller blir äldre än 120 dagar
    cutoff = (TODAY - dt.timedelta(days=KEEP_DAYS)).isoformat()
    fresh = []
    for page in range(args.pages):
        t = fetch(MFN + "/all/s/nordic?" + urllib.parse.urlencode({"filter": '(and(or(.properties.lang="sv")))', "limit": 500, "offset": page * 500}))
        rows = []
        for blk in re.split(r'<div class="short-item compressible\s*"', t)[1:]:
            d = re.search(r'compressed-date">([^<]+)', blk)
            tm = re.search(r'compressed-time">([^<]+)', blk)
            a = re.search(r'title-link item-link" href="([^"]+)" title="([^"]*)"', blk)
            au = re.search(r'author="([^"]+)"[^>]*>([^<]*)<', blk)
            if d and a:
                rows.append({"d": d.group(1).strip(), "t": (tm.group(1).strip()[:5] if tm else ""), "u": a.group(1), "h": plain(a.group(2)),
                             "slug": au.group(1) if au else "", "author": plain(au.group(2)) if au else ""})
        if not rows:
            break
        new_here = [r for r in rows if r["u"] not in seen]
        fresh += new_here
        print("  MFN sida %d: %d meddelanden %s–%s, %d nya" % (page + 1, len(rows), rows[-1]["d"], rows[0]["d"], len(new_here)))
        if rows[-1]["d"] < cutoff or (newest and rows[-1]["d"] < newest) or len(new_here) < len(rows) * 0.2:
            break
        time.sleep(1)

    if args.reparse:
        # alla sparade meddelanden går igenom tolkningen igen (texterna hämtas ur .cache/mfn när de finns)
        state["buybacks"], state["issues"] = {}, []
        old_items = state["items"]
        state["items"] = []
        seen = set()
        fresh = [{"d": it["d"], "t": it["t"], "u": it["u"], "h": it["h"], "slug": None, "author": None, "isins": it["i"]} for it in old_items] + fresh
        fresh.sort(key=lambda r: (r["d"], r["t"]), reverse=True)

    added, bodies = 0, 0
    for r in reversed(fresh):  # äldst först, så att återköpsraderna läggs i ordning
        if r["d"] < cutoff:
            continue
        if r["u"] in seen:
            continue
        isins = r.get("isins") or slug_isins.get(r["slug"]) or by_name.get(norm(r["author"]))
        if not isins:
            continue
        tag = tag_of(r["h"])
        item = {"d": r["d"], "t": r["t"], "i": isins, "h": r["h"], "u": r["u"], "k": tag}
        # Återköp och emissioner: läs pressmeddelandet
        want_body = (tag == "aterkop" and not BUYBACK_START.search(r["h"]) and not re.search(r"syntetisk|flaggning|slutför|avslut", r["h"], re.I)) or \
                    (tag == "emission" and ISSUE_NEW.search(r["h"]) and not ISSUE_SKIP.search(r["h"]))
        if want_body and bodies < args.max_bodies:
            try:
                body = body_of(r["u"])
                bodies += 1
                time.sleep(0.6)
            except Exception as e:
                print("  %s: gick inte att läsa (%s)" % (r["u"], e))
                body = None
            if body and tag == "aterkop":
                bb = buyback_of(body)
                if bb:
                    isin = bb["isin"] if bb["isin"] in names else isins[0]
                    rec = state["buybacks"].setdefault(isin, {"cur": bb["cur"], "rows": {}})
                    for row in bb["rows"]:
                        rec["rows"][row[0]] = row[1:]
                    rec["cur"] = bb["cur"]
                    item["bb"] = [sum(x[1] for x in bb["rows"]), sum(x[3] for x in bb["rows"])]
            elif body and tag == "emission":
                iss = issue_of(r["h"], body)
                iss.update({"d": r["d"], "i": isins, "h": r["h"], "u": r["u"]})
                state["issues"].append(iss)
        elif tag == "aterkop" and BUYBACK_START.search(r["h"]):
            item["start"] = 1
        state["items"].append(item)
        seen.add(r["u"])
        added += 1

    # Etiketterna sätts om för alla meddelanden, så att ändrade regler gäller även det som redan är sparat
    for it in state["items"]:
        it["k"] = tag_of(it["h"])
    # Rensa: 120 dagar för meddelanden och emissioner, ett år för återköpsrader
    state["items"] = sorted([it for it in state["items"] if it["d"] >= cutoff], key=lambda it: (it["d"], it["t"]), reverse=True)
    # nyast först; samma dag går ett genomfört beslut med teckningskurs före en avsikt
    done_rx = re.compile(r"genomfört|har genomfört|tillförs|beslutat|beslutar|genomför ", re.I)
    issues = sorted({x["u"]: x for x in state["issues"] if x["d"] >= cutoff}.values(),
                    key=lambda x: (x["d"], x.get("price") is not None, bool(done_rx.search(x["h"])), x.get("amount") is not None), reverse=True)
    kept = []
    for x in issues:
        if any(set(x["i"]) & set(k["i"]) and (dt.date.fromisoformat(k["d"]) - dt.date.fromisoformat(x["d"])).days <= 21 for k in kept):
            continue
        kept.append(x)
    state["issues"] = kept
    year = (TODAY - dt.timedelta(days=365)).isoformat()
    for isin in list(state["buybacks"]):
        rows = {d: v for d, v in state["buybacks"][isin]["rows"].items() if d >= year}
        if rows:
            state["buybacks"][isin]["rows"] = rows
        else:
            del state["buybacks"][isin]
    state["built"] = TODAY.isoformat()
    open(STATE, "w", encoding="utf-8", newline="\n").write(json.dumps(state, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
    print("  %d nya pressmeddelanden (%d lästa i sin helhet); sparat %d, %d bolag med återköp, %d emissioner" %
          (added, bodies, len(state["items"]), len(state["buybacks"]), len(state["issues"])))
    write_site(state, names, q)


def write_site(state, names, q):
    # värdet i fonderna per aktie, för urvalet på startsidan
    val = {}
    for s in q["stocks"]:
        val[s[0]] = 0
    os.makedirs(os.path.join(OUT, "news"), exist_ok=True)
    per = {}
    for it in state["items"]:
        row = [it["d"], it["t"], it["h"], it["u"], it["k"]]
        if it.get("bb"):
            row.append(it["bb"])
        for isin in it["i"]:
            per.setdefault(isin, {"items": [], "issues": []})["items"].append(row)
    for x in state["issues"]:
        for isin in x["i"]:
            per.setdefault(isin, {"items": [], "issues": []})["issues"].append([x["d"], x["kind"], x["amount"], x["cur"], x["price"], x["u"]])
    for isin, bb in state["buybacks"].items():
        per.setdefault(isin, {"items": [], "issues": []})["bb"] = [bb["cur"], sorted([[d] + v for d, v in bb["rows"].items()], reverse=True)]
    old = set(os.listdir(os.path.join(OUT, "news")))
    for isin, d in per.items():
        d["items"] = d["items"][:60]
        open(os.path.join(OUT, "news", isin + ".json"), "w", encoding="utf-8", newline="\n").write(json.dumps(d, ensure_ascii=False, separators=(",", ":")))
        old.discard(isin + ".json")
    for f in old:
        os.remove(os.path.join(OUT, "news", f))

    # Startsidan: de senaste tre dagarnas meddelanden, med etikett, från bolag på sajten (appen väljer de största)
    since = (TODAY - dt.timedelta(days=4)).isoformat()
    latest = [[it["d"], it["t"], it["i"], it["h"], it["u"], it["k"]] for it in state["items"] if it["d"] >= since and it["k"]][:300]
    open(os.path.join(OUT, "news-latest.json"), "w", encoding="utf-8", newline="\n").write(
        json.dumps({"built": state["built"], "items": latest}, ensure_ascii=False, separators=(",", ":")))

    # Återköp per bolag: senaste 30 och 90 dagarna, senaste dag, och nya program
    d30 = (TODAY - dt.timedelta(days=30)).isoformat()
    d90 = (TODAY - dt.timedelta(days=90)).isoformat()
    out = []
    for isin, bb in state["buybacks"].items():
        rows = bb["rows"]
        s30 = [v for d, v in rows.items() if d >= d30]
        s90 = [v for d, v in rows.items() if d >= d90]
        if not s90:
            continue
        out.append([isin, names.get(isin, ""), bb["cur"], sum(v[0] for v in s30), sum(v[2] for v in s30), sum(v[0] for v in s90), sum(v[2] for v in s90), max(rows)])
    out.sort(key=lambda r: -r[6])
    starts = [[it["d"], it["i"], it["h"], it["u"]] for it in state["items"] if it.get("start")][:30]
    open(os.path.join(OUT, "buybacks.json"), "w", encoding="utf-8", newline="\n").write(
        json.dumps({"built": state["built"], "rows": out, "starts": starts}, ensure_ascii=False, separators=(",", ":")))
    iss = [[x["d"], x["i"], x["kind"], x["amount"], x["cur"], x["price"], x["h"], x["u"]] for x in state["issues"]]
    open(os.path.join(OUT, "issues.json"), "w", encoding="utf-8", newline="\n").write(
        json.dumps({"built": state["built"], "rows": iss}, ensure_ascii=False, separators=(",", ":")))
    print("  sajten: %d bolag med nyheter, %d med återköp, %d emissioner" % (len(per), len(out), len(iss)))


if __name__ == "__main__":
    sys.exit(main())
