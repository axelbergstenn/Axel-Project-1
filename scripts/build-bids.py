#!/usr/bin/env python3
"""
Bygger site/data/bids.json: nya offentliga uppköpserbjudanden samma dag som de lämnas, ur pressmeddelandena på MFN.

Uppköpssidan bygger annars på erbjudandehandlingarna i Finansinspektionens prospektregister (build-data.ps1), som
kommer först när FI har godkänt handlingen, ofta två till fyra veckor efter budet. Här läses MFN:s nyhetsflöde för
Norden (de senaste dagarnas svenska pressmeddelanden, sajten körs tre gånger om dagen) och de rubriker som handlar om
ett nytt offentligt erbjudande. Målbolaget måste vara en aktie som finns på sajten:
  - målbolagets styrelse uttalar sig ("Uttalande från Egetis Therapeutics styrelse med anledning av …"), eller
  - budgivaren lämnar erbjudandet "till aktieägarna i <bolag>".
Pris, premie och styrelsens rekommendation läses ur pressmeddelandet. Bara bolagens egna pressmeddelanden används.
Filen sparas i repot och fylls på körning för körning; bud äldre än ett år tas bort. På sajten visas ett bud här
tills FI:s erbjudandehandling för samma bolag finns.

  py scripts/build-bids.py
"""
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

# Rubriker om ett offentligt erbjudande, men inte om ett gammalt bud (acceptfrist, utfall, erbjudandehandling)
OFFER = re.compile(r"offentlig[ta]? (?:uppköps|kontant|aktie)?erbjudande|uppköpserbjudande|kontanterbjudande|budpliktsbud|"
                   r"(?:lämnar|offentliggör) (?:ett )?(?:rekommenderat )?(?:kontant )?(?:offentligt )?(?:bud|erbjudande) till aktieägarna", re.I)
OLD_NEWS = re.compile(r"erbjudandehandling|tilläggshandling|acceptfrist|acceptperiod|utfall|fullföljer|fullföljs|fullföljande|förvärvat|"
                      r"förvärvar ytterligare|återkall|förläng|tvångsinlösen|avnotering|slutligt|godkänt|godkänner|ökat ägande|"
                      r"accepterats|anslutning|villkor(?:en)? (?:för|i) erbjudandet|uppfyllt|avstår|höjer|höjt|uppdatering|kallelse|stämma", re.I)
TARGET_SAYS = re.compile(r"uttalande från .{0,60}styrelse|styrelsen (?:för .{0,60})?(?:i .{0,60})?(?:rekommenderar|avråder)|"
                         r"oberoende budkommitté|budkommittén", re.I)
TO_HOLDERS = re.compile(r"(?:till|för) (?:aktieägarna|samtliga aktier|aktierna) i (?P<t>[^,:;]+?)(?:\s*\(publ\))?(?:\s+[–-]\s|[,:;]|$)", re.I)


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
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def norm(name):
    """"Egetis Therapeutics AB (publ)" -> "egetis therapeutics", för att jämföra namn."""
    n = re.sub(r"\(publ\)|\b(ab|asa|oyj|abp|plc|a/s|as|ltd|inc|ser\.?\s*[a-d]|[a-d]-?aktie\w*|aktiebolag|holding|group)\b", " ", (name or "").lower())
    return re.sub(r"[^a-z0-9åäöéü]+", " ", n).strip()


def number(s):
    s = s.replace(" ", "").replace(" ", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def read_release(url):
    """Pris per aktie, premien mot senaste stängningskurs, budgivaren och styrelsens rekommendation ur pressmeddelandet."""
    page = fetch(url)
    m = re.search(r'<div class="content s-[a-z]+">(.*?)</article>', page, re.S)
    body = plain(m.group(1) if m else "")[:8000]
    out = {}
    pm = re.search(r"(\d{1,4}(?:[  ]\d{3})*(?:,\d{1,4})?)\s*(kronor|kr|SEK|euro|EUR|norska kronor|NOK|danska kronor|DKK)\s*(?:kontant\s*)?(?:i kontanter\s*)?per (?:aktie|stamaktie|A-aktie|B-aktie)", body)
    if pm:
        out["price"] = number(pm.group(1))
        out["cur"] = {"kronor": "SEK", "kr": "SEK", "euro": "EUR", "norska kronor": "NOK", "danska kronor": "DKK"}.get(pm.group(2), pm.group(2).upper())
    # första premien i texten, som nästan alltid är mot stängningskursen dagen före budet
    pr = re.search(r"premie (?:om|på):? (?:cirka |ungefär |omkring |ca\.? )?(\d{1,3}(?:,\d)?) ?(?:procent|%)", body, re.I)
    if pr:
        out["premium"] = number(pr.group(1))
    if re.search(r"rekommenderar (?:enhälligt )?(?:aktieägarna|bolagets aktieägare|aktieägare)[^.]{0,80}?att inte acceptera|avråder", body, re.I):
        out["rec"] = "nej"
    elif re.search(r"rekommenderar (?:enhälligt )?(?:aktieägarna|bolagets aktieägare|aktieägare)[^.]{0,120}?att acceptera|rekommenderat (?:offentligt |kontant )*(?:uppköps)?erbjudande", body, re.I):
        out["rec"] = "ja"
    return out


def bidder_of(title):
    for rx in (r"med anledning av (?:det )?(?P<b>.+?)(?::s)? (?:kontanta |rekommenderade |offentliga |offentligt |frivilliga )+(?:uppköps|kontant|aktie)?erbjudande",
               r"att (?:inte )?acceptera (?P<b>.+?)(?::s)? (?:kontanta |rekommenderade |offentliga |frivilliga )+(?:uppköps|kontant|aktie)?erbjudande",
               r"^(?P<b>.+?) (?:offentliggör|lämnar) (?:ett )?(?:rekommenderat )?(?:kontant )?(?:offentligt )?(?:uppköps|kontant)?(?:erbjudande|bud)"):
        m = re.search(rx, title, re.I)
        if m:
            b = m.group("b").strip(" ”\"'")
            b = re.sub(r"^(?:[A-ZÅÄÖ][\w&.\- ]{0,40}:\s+)", "", b)  # "Bolaget: Budgivaren …"
            if 2 <= len(b) <= 80:
                return b
    return None


def main():
    out_path = os.path.join("site", "data", "bids.json")
    old = {}
    if os.path.exists(out_path):
        try:
            old = {b["url"]: b for b in json.load(open(out_path, encoding="utf-8")).get("bids", [])}
        except ValueError:
            pass
    # aktierna på sajten: MFN-bolag -> ISIN (ur bolagsfakta) och namn -> ISIN (ur senaste kvartalet)
    index = json.load(open(os.path.join("site", "data", "index.json"), encoding="utf-8"))
    q = json.load(open(os.path.join("site", "data", index["quarters"][0]["id"] + ".json"), encoding="utf-8"))
    names = {s[0]: s[1] for s in q["stocks"]}
    by_name = {}
    for isin, n in names.items():
        if isin[:2] in ("SE", "FI", "DK", "NO"):
            by_name.setdefault(norm(n), isin)
    slug_isin = {}
    try:
        st = json.load(open(os.path.join("data", "bolag-state.json"), encoding="utf-8"))
        for isin, s in st.get("isin", {}).items():
            if s.get("mfn") and isin in names:
                # stamaktien (den som fonderna äger mest av) om bolaget har flera aktieslag
                slug_isin.setdefault(s["mfn"], []).append(isin)
    except (OSError, ValueError):
        pass
    t = fetch(MFN + "/all/s/nordic?" + urllib.parse.urlencode({"filter": '(and(or(.properties.lang="sv")))', "limit": 500}))
    items = []
    for blk in re.split(r'<div class="short-item compressible\s*"', t)[1:]:
        d = re.search(r'compressed-date">([^<]+)', blk)
        a = re.search(r'title-link item-link" href="(/(?:[a-z]+/)?a/([^/"]+)/[^"]*)" title="([^"]*)"', blk)
        if d and a:
            items.append((d.group(1).strip(), MFN + a.group(1), a.group(2), html.unescape(a.group(3))))
    print("  MFN: %d svenska pressmeddelanden %s–%s" % (len(items), items[-1][0] if items else "-", items[0][0] if items else "-"))
    found = 0
    for date, url, slug, title in items:
        if url in old or not OFFER.search(title) or OLD_NEWS.search(title):
            continue
        isins = None
        m = TO_HOLDERS.search(title)
        if m and norm(m.group("t")) in by_name:
            isins = [by_name[norm(m.group("t"))]]
        elif TARGET_SAYS.search(title) and slug in slug_isin:
            isins = slug_isin[slug]
        if not isins:
            continue
        # samma bolag har redan ett bud på senare tid: det här är en uppföljning, inte ett nytt bud
        if any(set(isins) & set(b["isins"]) and abs((dt.date.fromisoformat(b["date"]) - dt.date.fromisoformat(date)).days) <= 120 for b in old.values()):
            continue
        rec = {"date": date, "isins": isins, "name": names.get(isins[0]), "bidder": bidder_of(title), "title": title, "url": url}
        try:
            rec.update(read_release(url))
        except Exception as e:
            print("  %s: pressmeddelandet gick inte att läsa (%s)" % (url, e))
        old[url] = rec
        found += 1
        print("  nytt bud %s: %s från %s, %s %s (premie %s)" % (date, rec["name"], rec.get("bidder"), rec.get("price"), rec.get("cur", ""), rec.get("premium")))
        time.sleep(1)
    since = (TODAY - dt.timedelta(days=365)).isoformat()
    bids = sorted((b for b in old.values() if b["date"] >= since), key=lambda b: b["date"], reverse=True)
    text = json.dumps({"built": TODAY.isoformat(), "bids": bids}, ensure_ascii=False, separators=(",", ":"))
    if found or not os.path.exists(out_path):
        open(out_path, "w", encoding="utf-8", newline="\n").write(text)
    print("  Bud från MFN: %d nya, %d det senaste året" % (found, len(bids)))


if __name__ == "__main__":
    sys.exit(main())
