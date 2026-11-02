#!/usr/bin/env python3
"""
Bygger data/bolag/<ISIN>.json för de amerikanska aktier som svenska fonder äger ("Lär känna bolaget" på aktiesidan),
i samma format som scripts/build-companies.py gör för de svenska bolagen.

Bara bolagens egna rapporter till den amerikanska finansinspektionen SEC (EDGAR), utan nycklar:
  - https://www.sec.gov/files/company_tickers.json kopplar bolaget till dess nummer hos SEC (CIK) via namnet.
    Aktieslag i samma bolag (Alphabet A och C) har samma sex första tecken i CUSIP (tecken 3–8 i ISIN) och får samma CIK.
  - https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json: siffrorna ur kvartalsrapporterna (10-Q) och
    årsrapporterna (10-K). Det fjärde kvartalet har ingen egen rapport utan räknas fram som helåret minus årets tre
    första kvartal. Kassaflödet redovisas från årets början, så kvartalen räknas fram på samma sätt.
  - https://data.sec.gov/submissions/CIK##########.json: huvudkontor, börs, kortnamn, rapporterna och bolagets
    resultatbesked (8-K med punkt 2.02). De ger dagen då kvartalet offentliggjordes och en uppskattning av nästa.

SEC kräver en User-Agent med kontaktadress och tillåter högst 10 anrop per sekund. Här görs högst två per sekund.
De största innehaven hämtas först, och bara --max-fetch bolag per körning. Ett bolag hämtas om när en ny rapport
väntas (från det beräknade datumet tills den kommit), annars en gång i månaden. Läget sparas i data/sec-state.json.
Hellre ingen uppgift än en felaktig: bolag som inte lämnar 10-Q (till exempel ADR:er) hoppas över.

  python3 scripts/build-us-companies.py
  py scripts/build-us-companies.py --raw-cache .cache/sec --only US5949181045,US0378331005    (lokalt, sparar svaren)
"""
import argparse
import datetime as dt
import gzip
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

# Höjs när tolkningen ändras, så att alla bolag läses om (gradvis, --max-fetch per körning)
PARSER_VERSION = 1
UA = "Fondinsyn axelsfondfloden@gmail.com"
TODAY = dt.date.today()
PAUSE = 0.5  # sekunder mellan anropen till SEC
FORMS = {"10-Q", "10-K", "10-Q/A", "10-K/A", "10-KT"}
EDGAR = "https://www.sec.gov"

# ---------- Hämtning ----------

_last_call = [0.0]
RAW_CACHE = None
REUSE_CACHE = False


def fetch(url, tries=3, timeout=90):
    for i in range(tries):
        wait = PAUSE - (time.time() - _last_call[0])
        if wait > 0:
            time.sleep(wait)
        _last_call[0] = time.time()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json", "Accept-Encoding": "gzip"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                return body
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if i == tries - 1:
                raise
            # 403 och 429 betyder att SEC vill att vi saktar ner
            time.sleep(5 * (i + 1) * (4 if e.code in (403, 429) else 1))
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(3 * (i + 1))


def get_json(url, cache_name):
    """Hämtar JSON från SEC. Med --raw-cache sparas svaret, och med --reparse läses det därifrån i stället."""
    path = os.path.join(RAW_CACHE, cache_name) if RAW_CACHE else None
    if path and REUSE_CACHE and os.path.exists(path):
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return json.load(f)
    body = fetch(url)
    if body is None:
        return None
    data = json.loads(body)
    if path:
        os.makedirs(RAW_CACHE, exist_ok=True)
        with gzip.open(path, "wt", encoding="utf-8") as f:
            json.dump(data, f)
    return data


def days_since(date_text):
    try:
        return (TODAY - dt.date.fromisoformat(date_text)).days
    except (TypeError, ValueError):
        return 10 ** 6


def d(s):
    return dt.date.fromisoformat(s)


# ---------- Bolagets CIK ----------

TRAILING = {"INC", "INCORPORATED", "CORP", "CORPORATION", "CO", "COMPANY", "COMPANIES", "LTD", "LIMITED", "PLC", "LLC", "LP", "NV", "SA", "AG",
            "CLASS", "CL", "SER", "SERIES", "COM", "COMMON", "STOCK", "SHS", "SHARES", "REG", "NEW", "DEL", "ORD", "A", "B", "C", "THE"}
LOOSE = {"GROUP", "HOLDING", "HOLDINGS", "INTERNATIONAL", "INTL", "TECHNOLOGIES", "TECHNOLOGY", "SYSTEMS"}


def words(name, loose=False):
    n = str(name or "").upper()
    n = re.sub(r"\s*[/\\]\s*[A-Z]{2,4}\s*[/\\]?\s*$", "", n)  # "BANK OF AMERICA CORP /DE/", "VERTEX PHARMACEUTICALS INC / MA"
    n = re.sub(r"\([^)]*\)", " ", n).replace("'", "")       # "UDR Inc (REIT)", "LOWE'S"
    n = re.sub(r"[^A-Z0-9]+", " ", n.replace("&", " ")).split()
    n = [{"COS": "COMPANIES", "INTL": "INTERNATIONAL"}.get(w, w) for w in n if w != "AND"]
    # "HORTON D R" blir "HORTON DR", som "DR HORTON"
    merged = []
    for w in n:
        if len(w) == 1 and merged and len(merged[-1]) < 3 and merged[-1].isalpha() and merged[-1] not in TRAILING and len(merged) > 1:
            merged[-1] += w
        else:
            merged.append(w)
    n = merged
    while n and n[0] == "THE":
        n.pop(0)
    while len(n) > 1 and (n[-1] in TRAILING or (loose and n[-1] in LOOSE)):
        n.pop()
    return n


def norm(name, loose=False):
    """"Amazon.com" och "AMAZON COM INC" blir båda AMAZON, "ALPHABET A" och "Alphabet Inc." blir ALPHABET."""
    return "".join(words(name, loose))


def word_set(name):
    """SEC skriver ibland efternamnet först ("SCHWAB CHARLES CORP", "PRICE T ROWE GROUP INC")."""
    return " ".join(sorted(words(name, True)))


def match_ciks(stocks, tickers, old):
    """ISIN -> CIK. Först exakt på namnet, sedan utan "Group"/"Holdings" och sist på början av namnet, men bara
    när träffen är entydig. Aktieslag i samma bolag (samma CUSIP-början) delar CIK."""
    exact, loose, wset = {}, {}, {}
    for t in tickers.values():
        exact.setdefault(norm(t["title"]), set()).add(t["cik_str"])
        loose.setdefault(norm(t["title"], True), set()).add(t["cik_str"])
        wset.setdefault(word_set(t["title"]), set()).add(t["cik_str"])
    found = {}
    for isin, name in stocks.items():
        if old.get(isin, {}).get("cik"):
            found[isin] = old[isin]["cik"]
            continue
        hit = exact.get(norm(name)) or loose.get(norm(name, True)) or (wset.get(word_set(name)) if len(words(name, True)) >= 2 else None)
        if not hit:
            n = norm(name)
            if len(n) >= 6:
                hit = {c for k, cs in exact.items() if len(k) >= 6 and (k.startswith(n) or n.startswith(k)) for c in cs}
        if hit and len(hit) == 1:
            found[isin] = next(iter(hit))
    by_issuer = {}
    for isin, cik in found.items():
        by_issuer.setdefault(isin[2:8], set()).add(cik)
    for isin in stocks:
        if isin not in found and len(by_issuer.get(isin[2:8], ())) == 1:
            found[isin] = next(iter(by_issuer[isin[2:8]]))
    return found


# ---------- Siffrorna ur 10-Q och 10-K ----------

CONCEPTS = {
    "rev": (["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax",
             "SalesRevenueNet", "SalesRevenueGoodsNet", "SalesRevenueServicesNet", "RevenuesNetOfInterestExpense"], "max"),
    "ebit": (["OperatingIncomeLoss"], "first"),
    "net": (["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"], "first"),
    "eps": (["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted", "EarningsPerShareBasic"], "first"),
    "ocf": (["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"], "first"),
    "capex": (["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets",
               "PaymentsToAcquirePropertyPlantAndEquipmentAndIntangibleAssets"], "first"),
    "buyback": (["PaymentsForRepurchaseOfCommonStock", "PaymentsForRepurchaseOfEquity"], "first"),
    "divPaid": (["PaymentsOfDividendsCommonStock", "PaymentsOfDividends", "PaymentsOfOrdinaryDividends"], "first"),
    "equity": (["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"], "first"),
    "assets": (["Assets"], "first"),
    "cash": (["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"], "first"),
    "dps": (["CommonStockDividendsPerShareDeclared", "CommonStockDividendsPerShareCashPaid"], "first"),
}
PER_SHARE = {"eps", "dps"}


# Balansräkningen för nettoskulden, som för de svenska bolagen: räntebärande skulder (lån och leasingskulder) minus likvida
# medel. Amerikanska bolag har ofta mycket pengar i kortfristiga placeringar (Microsoft, Apple), så de räknas till de
# likvida medlen; annars skulle bolag med nettokassa se skuldsatta ut. Skulderna räknas bara när lånen är märkta.
BALANCE = {
    "debtAll": ["LongTermDebt", "DebtAndCapitalLeaseObligations", "LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities"],
    "debtLong": ["LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations"],
    "debtCur": ["LongTermDebtCurrent", "LongTermDebtAndCapitalLeaseObligationsCurrent"],
    "paper": ["CommercialPaper"],
    "shortDebt": ["ShortTermBorrowings", "OtherShortTermBorrowings"],
    "opLease": ["OperatingLeaseLiability"],
    "opLeaseLong": ["OperatingLeaseLiabilityNoncurrent"],
    "opLeaseCur": ["OperatingLeaseLiabilityCurrent"],
    "finLease": ["FinanceLeaseLiability"],
    "finLeaseLong": ["FinanceLeaseLiabilityNoncurrent"],
    "finLeaseCur": ["FinanceLeaseLiabilityCurrent"],
    "liquid": ["CashCashEquivalentsAndShortTermInvestments"],
    "invest": ["MarketableSecuritiesCurrent", "ShortTermInvestments", "AvailableForSaleSecuritiesDebtSecuritiesCurrent"],
    # sista utvägen (Nvidia): räntepapper som förfaller inom ett år, ett försiktigt mått
    "investYear": ["AvailableForSaleSecuritiesDebtMaturitiesWithinOneYearFairValue"],
}


def values(facts, key):
    return values_for(facts, *CONCEPTS[key], unit="USD/shares" if key in PER_SHARE else "USD")


def values_for(facts, concepts, how="first", unit="USD"):
    """Värdet per period (start, slut) ur 10-Q och 10-K. Varje period kan finnas i flera rapporter (som jämförelsetal);
    den senast inlämnade gäller, eftersom den har med eventuella omräkningar."""
    g = facts.get("facts", {}).get("us-gaap", {})
    per_concept = []
    for c in concepts:
        best = {}
        for x in g.get(c, {}).get("units", {}).get(unit, []):
            if x.get("form") not in FORMS or x.get("val") is None:
                continue
            # rullande tolv månader i en kvartalsrapport (Amazon redovisar kassaflödet så) är inget räkenskapsår
            if x["form"].startswith("10-Q") and x.get("start") and length(x["start"], x["end"]) > 290:
                continue
            k = (x.get("start"), x["end"])
            if k not in best or x["filed"] > best[k][1]:
                best[k] = (x["val"], x["filed"])
        per_concept.append({k: v[0] for k, v in best.items()})
    out = {}
    for vals in per_concept:
        for k, v in vals.items():
            if k not in out:
                out[k] = v
            elif how == "max" and v > out[k]:
                out[k] = v
    return out


def length(start, end):
    return (d(end) - d(start)).days + 1


def quarters(vals, derive=True):
    """Kvartal per slutdatum: (start, värde). Rapporterade direkt, eller skillnaden mellan två perioder från årets början
    (halvår minus första kvartalet, nio månader minus halvår, helår minus nio månader)."""
    q = {}
    for (s, e), v in vals.items():
        if s and 80 <= length(s, e) <= 105:
            q[e] = (s, v, False)
    if derive:
        by_start = {}
        for (s, e), v in vals.items():
            if s and length(s, e) <= 380:
                by_start.setdefault(s, []).append((e, v))
        for s, lst in by_start.items():
            lst.sort()
            for (e1, v1), (e2, v2) in zip(lst, lst[1:]):
                if 80 <= (d(e2) - d(e1)).days <= 105 and e2 not in q:
                    q[e2] = ((d(e1) + dt.timedelta(days=1)).isoformat(), v2 - v1, True)
    return q


def annuals(vals):
    return {e: v for (s, e), v in vals.items() if s and 350 <= length(s, e) <= 380}


def instants(vals):
    return {e: v for (s, e), v in vals.items() if not s}


def pkey(end):
    """Kvartalet som slutar 2026-09-27 är "2026-09". Slutar det de första dagarna i en månad räknas föregående månad."""
    e = d(end)
    if e.day <= 7:
        e = e.replace(day=1) - dt.timedelta(days=1)
    return "%04d-%02d" % (e.year, e.month)


def near(target, dates, slack=12):
    """Datumet i dates som ligger närmast target (högst slack dagar ifrån)."""
    best = None
    for x in dates:
        diff = abs((d(x) - target).days)
        if diff <= slack and (best is None or diff < best[0]):
            best = (diff, x)
    return best[1] if best else None


def year_ago(end, dates):
    return near(d(end) - dt.timedelta(days=364), dates)


def fy_label(end):
    """Räkenskapsåret som slutar i december 2025 är "2025", det som slutar i juni 2026 är "2025/26"."""
    p = pkey(end)
    y, m = int(p[:4]), int(p[5:])
    return str(y) if m == 12 else "%d/%02d" % (y - 1, y % 100)


def clean(v):
    if v is None:
        return None
    return round(v, 4) if isinstance(v, float) and abs(v) < 1000 else (int(round(v)) if abs(v) >= 1000 else v)


# ---------- Bolagets fakta ----------

STATES = {"AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "Kalifornien", "CO": "Colorado", "CT": "Connecticut",
          "DE": "Delaware", "DC": "Washington D.C.", "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois",
          "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
          "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri", "MT": "Montana",
          "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
          "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania",
          "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah",
          "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
          "PR": "Puerto Rico"}
MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"]
EXCHANGES = {"Nasdaq": "Nasdaq i New York", "NYSE": "New Yorkbörsen (NYSE)", "CBOE": "Cboe", "NYSE American": "NYSE American"}
# Namn som inte går att skriva rätt automatiskt ur versaler
NAMES = {"JPMORGANCHASE": "JPMorgan Chase", "ABBVIE": "AbbVie", "MCKESSON": "McKesson", "SERVICENOW": "ServiceNow", "PAYPAL": "PayPal",
         "NVIDIA": "Nvidia", "AMD": "AMD", "ADVANCEDMICRODEVICES": "AMD", "KLA": "KLA", "IBM": "IBM", "INTERNATIONALBUSINESSMACHINES": "IBM",
         "UNITEDHEALTHGROUP": "UnitedHealth", "MCDONALDS": "McDonald's", "BLACKROCK": "BlackRock", "FEDEX": "FedEx", "DOORDASH": "DoorDash",
         "MERCADOLIBRE": "MercadoLibre", "CROWDSTRIKE": "CrowdStrike", "HUBSPOT": "HubSpot", "MONGODB": "MongoDB", "GODADDY": "GoDaddy",
         "EBAY": "eBay", "ATT": "AT&T", "CVSHEALTH": "CVS Health", "PROLOGIS": "Prologis", "ELILILLY": "Eli Lilly", "AMAZON": "Amazon",
         "COSTCOWHOLESALE": "Costco", "UBER": "Uber", "HCAHEALTHCARE": "HCA Healthcare", "SP": "S&P Global", "SPGLOBAL": "S&P Global"}


def short_name(fi_name, sec_name):
    """Kort namn att skriva i texten: "Apple", "Microsoft", "JPMorgan Chase"."""
    for n in (fi_name, sec_name):
        key = norm(n)
        if key in NAMES:
            return NAMES[key]
    for n in (sec_name, fi_name):
        n = re.sub(r"\s*/[A-Z]{2,4}/?\s*$", "", str(n or "")).strip()
        if n and n != n.upper():
            words = re.sub(r"[,.]", " ", n).split()
            while len(words) > 1 and words[-1].upper() in TRAILING:
                words.pop()
            return " ".join(words)
    words = [w for w in re.sub(r"[,.]", " ", str(fi_name or sec_name)).split()]
    while len(words) > 1 and words[-1].upper() in TRAILING:
        words.pop()
    return " ".join(w if len(w) <= 3 else w.capitalize() for w in words)


def company_facts(sub):
    f = {}
    biz = (sub.get("addresses") or {}).get("business") or {}
    city, st = (biz.get("city") or "").strip(), biz.get("stateOrCountry")
    if city and st in STATES:
        f["hq"] = "%s, %s" % (" ".join(w.capitalize() for w in city.split()), STATES[st])
    exch = [e for e in sub.get("exchanges") or [] if e]
    # preferensaktier ("JPM-PC") räknas inte, men aktieslag ("BRK-B") gör det
    tick = [t for t, e in zip(sub.get("tickers") or [], sub.get("exchanges") or []) if t and e and not re.search(r"-P[A-Z]?$", t)]
    # fler kortnamn bara för andra aktieslag i samma bolag (GOOGL och GOOG, BRK-B och BRK-A), inte för bolagets
    # börshandlade skuldebrev (JPMorgans AMJB)
    tick = tick[:1] + [t for t in tick[1:] if t[:3] == tick[0][:3]]
    if exch:
        f["list"] = EXCHANGES.get(exch[0], exch[0])
    if tick:
        f["ticker"] = tick[:2]
    inc = sub.get("stateOfIncorporation")
    if inc in STATES:
        f["inc"] = STATES[inc]
    fye = sub.get("fiscalYearEnd") or ""
    if re.match(r"^\d{4}$", fye) and 1 <= int(fye[:2]) <= 12:
        # bara månaden: många bolag avslutar året på en viss veckodag ("sista lördagen i september")
        f["fye"] = MONTHS[int(fye[:2]) - 1]
    return f


# ---------- Rapporterna och resultatbeskeden ----------

def filings(sub):
    r = (sub.get("filings") or {}).get("recent") or {}
    keys = ("form", "filingDate", "reportDate", "accessionNumber", "primaryDocument", "items")
    return [dict(zip(keys, row)) for row in zip(*(r.get(k, []) for k in keys))]


def more_filings(sub, cik10):
    """SEC:s lista har de senaste 1 000 dokumenten. Banker lämnar in så många att det bara räcker några månader bakåt,
    så då hämtas nästa sida också: förra årets resultatbesked behövs för att räkna ut när nästa rapport kommer."""
    recent = (sub.get("filings") or {}).get("recent") or {}
    files = (sub.get("filings") or {}).get("files") or []
    dates = recent.get("filingDate") or []
    if not files or not dates or days_since(min(dates)) > 430:
        return
    older = get_json("https://data.sec.gov/submissions/" + files[0]["name"], "sub-%s-1.json.gz" % cik10) or {}
    for k in recent:
        if isinstance(recent[k], list) and isinstance(older.get(k), list):
            recent[k] = recent[k] + older[k]


def doc_url(cik, f):
    return "%s/Archives/edgar/data/%d/%s/%s" % (EDGAR, int(cik), f["accessionNumber"].replace("-", ""), f["primaryDocument"])


def report_for(cik, flist, end, forms):
    """Rapporten (10-Q eller 10-K) för perioden som slutar end: den första som lämnades in."""
    hits = [f for f in flist if f["form"] in forms and f.get("reportDate") == end]
    if not hits:
        return None
    f = min(hits, key=lambda f: f["filingDate"])
    return {"date": f["filingDate"], "url": doc_url(cik, f), "form": f["form"].split("/")[0]}


def release_dates(cik, flist, ends):
    """Dagen då bolaget offentliggjorde perioden: resultatbeskedet (8-K, punkt 2.02). Det senaste före rapporten till SEC,
    eftersom en del bolag också lämnar andra besked med punkt 2.02 (Teslas leveranssiffror i början av kvartalet)."""
    rel = sorted(f["filingDate"] for f in flist if f["form"] == "8-K" and "2.02" in (f.get("items") or ""))
    out = {}
    for e in ends:
        rep = report_for(cik, flist, e, FORMS)
        last = d(rep["date"]) if rep else d(e) + dt.timedelta(days=70)
        hit = [x for x in rel if d(e) < d(x) <= last and (d(x) - d(e)).days <= 70]
        if hit:
            out[e] = hit[-1] if rep else hit[0]
    return out


# ---------- Ett bolag ----------

def build(cik, facts, sub, fi_name):
    """Dokumentet för bolaget, i samma format som de svenska bolagen (se scripts/build-companies.py)."""
    v = {k: values(facts, k) for k in CONCEPTS}
    # Banker, kreditbolag, mäklare och försäkringsbolag (SIC 6000–6399): "försäljning" och kassaflöde betyder något annat
    # för dem, så de visas inte (som för de svenska bankerna). Visa och Mastercard räknas inte hit.
    bank = str(sub.get("sic") or "").isdigit() and 6000 <= int(sub["sic"]) <= 6399
    if bank:
        for k in ("ocf", "capex"):
            v[k] = {}
    flist = filings(sub)
    q = {k: quarters(v[k], derive=k not in PER_SHARE) for k in ("rev", "ebit", "net", "eps", "ocf")}
    # Försäljningen måste vara positiv; ett negativt framräknat kvartal betyder att perioderna inte går ihop
    q["rev"] = {e: x for e, x in q["rev"].items() if x[1] > 0}
    ann = {k: annuals(v[k]) for k in CONCEPTS if k not in ("equity", "assets", "cash")}
    inst = {k: instants(v[k]) for k in ("equity", "assets", "cash")}
    doc = {"src": "sec", "cik": int(cik)}
    if bank:
        doc["bank"] = 1

    # Kvartalen: försäljning, rörelseresultat och resultat (de åtta senaste)
    ends = sorted(set(q["rev"]) | set(q["net"]))
    pts = {}
    for e in ends:
        pts[pkey(e)] = [clean(q[k].get(e, (None, None))[1]) for k in ("rev", "ebit", "net")]
    series = [[p] + x for p, x in sorted(pts.items())][-8:]
    if len(series) >= 4:
        doc["qs"] = series

    # Senaste kvartalet mot samma kvartal året innan
    if ends:
        e = ends[-1]
        prev = year_ago(e, set(q["rev"]) | set(q["net"]))
        qd = {"cur": "USD", "p": pkey(e), "m": 3, "end": e}
        for k in ("rev", "ebit", "net", "eps"):
            now = q[k].get(e)
            if now:
                qd[k] = [clean(now[1]), clean(q[k][prev][1]) if prev and prev in q[k] else None]
        if q["ocf"].get(e):
            qd["cash"] = [clean(q["ocf"][e][1]), clean(q["ocf"][prev][1]) if prev and prev in q["ocf"] else None]
        rep = report_for(cik, flist, e, {"10-Q", "10-K", "10-KT"})
        rel = release_dates(cik, flist, [e]).get(e)
        if rep:
            yearly = rep["form"] != "10-Q"
            qd["title"] = ("Årsrapporten (10-K)" if yearly else "Kvartalsrapporten (10-Q)") + " till SEC"
            qd["url"] = rep["url"]
            qd["filed"] = rep["date"]
        qd["date"] = min(x for x in (rel, (rep or {}).get("date"), "9999") if x) if rel or rep else None
        if qd.get("date") and days_since(qd["date"]) <= 200 and (qd.get("rev") or qd.get("net")):
            doc["q"] = qd

    # Helåret ur den senaste årsrapporten, och året innan
    fy_ends = sorted(set(ann["rev"]) | set(ann["net"]))
    if fy_ends:
        e = fy_ends[-1]
        prev = year_ago(e, fy_ends)
        fin = {}
        for k in ann:
            now = ann[k].get(e)
            if k == "dps" and now is None:
                # bara kvartalens utdelning: summan av årets fyra kvartal
                qs4 = [x for (s, en), x in v["dps"].items() if s and 80 <= length(s, en) <= 105 and d(e) - dt.timedelta(days=370) < d(en) <= d(e)]
                now = round(sum(qs4), 4) if len(qs4) == 4 else None
            if now is not None:
                fin[k] = [clean(now), clean(ann[k].get(prev)) if prev else None]
        for k in inst:
            pe = prev and near(d(prev), inst[k], 5)
            if inst[k].get(e) is not None:
                fin[k] = [clean(inst[k][e]), clean(inst[k][pe]) if pe else None]
        rep = report_for(cik, flist, e, {"10-K", "10-KT"})
        r = {"fy": int(pkey(e)[:4]), "fyl": fy_label(e), "end": e, "cur": "USD", "fin": fin, "url": rep["url"] if rep else None}
        hist = history(facts, ann, inst, fy_ends, bank)
        if hist:
            r["hist"] = hist
        if days_since(e) <= 550:
            doc["report"] = r
        # Utdelningen per räkenskapsår (de senaste tio). Äldre år kommer ur äldre rapporter och är inte omräknade efter
        # senare aktiesplittar, så historiken slutar där utdelningen per aktie är mer än 2,5 gånger högre än året efter.
        divs = []
        for ye in sorted(ann["dps"], reverse=True)[:10]:
            x = ann["dps"][ye]
            if x is None or x < 0 or (divs and divs[0][1] > 0 and x > divs[0][1] * 2.5):
                break
            divs.insert(0, [int(pkey(ye)[:4]), round(x, 4), 0])
        if len(divs) >= 3:
            doc["cal"] = {"divHist": divs}

    # Nästa rapport: samma dag som motsvarande resultatbesked för ett år sedan, plus 52 veckor
    q_ends = sorted(set(q["rev"]) | set(q["net"]))
    if q_ends:
        last = d(q_ends[-1])
        nxt = last + dt.timedelta(days=91)
        before = near(nxt - dt.timedelta(days=364), q_ends, 15)
        rel = release_dates(cik, flist, [before]).get(before) if before else None
        if rel:
            est = d(rel) + dt.timedelta(days=364)
            doc["_due"] = est.isoformat()
            if est >= TODAY - dt.timedelta(days=3):
                yearly = any(abs((nxt - d(x)).days - 365) <= 15 for x in fy_ends)
                doc.setdefault("cal", {})["next"] = [est.isoformat(), "årsrapport" if yearly else "kvartalsrapport"]
                doc["cal"]["est"] = 1

    f = company_facts(sub)
    emp = None
    for x in (facts.get("facts", {}).get("dei", {}).get("EntityNumberOfEmployees", {}).get("units", {}).get("pure") or []):
        if x.get("form") in FORMS and (emp is None or x["end"] > emp[1]):
            emp = (x["val"], x["end"])
    if emp and emp[0] and days_since(emp[1]) <= 800:
        f["employees"] = [int(emp[0]), int(emp[1][:4])]
    if f:
        doc["facts"] = f
    doc["short"] = short_name(fi_name, sub.get("name") or facts.get("entityName"))
    return doc


def history(facts, ann, inst, fy_ends, bank):
    """De senaste fem räkenskapsåren som kolumner, i samma format som de svenska bolagen ("hist" i scripts/build-companies.py):
    {"fy": ["2021/22", …], "rev": […], "ebit": […], "net": […], "ocf": […], "capex": […], "div": […], "equity": […], …}."""
    ends = []
    for e in reversed(fy_ends):  # bara en obruten följd av år, räknat bakifrån
        if ends and not 350 <= (d(ends[0]) - d(e)).days <= 380:
            break
        ends.insert(0, e)
        if len(ends) == 5:
            break
    if len(ends) < 2:
        return None
    bal = {k: instants(values_for(facts, c)) for k, c in BALANCE.items()}

    def at(series, e):
        x = near(d(e), series, 5)
        return series[x] if x else None

    def total(e, whole, parts):
        w = at(bal[whole], e)
        if w is not None:
            return w
        vals = [at(bal[p], e) for p in parts]
        return sum(x or 0 for x in vals) if any(x is not None for x in vals) else None

    rows = []
    for e in ends:
        row = {k: ann[k].get(e) for k in ("rev", "ebit", "net", "ocf", "capex")}
        row["div"] = ann["divPaid"].get(e)
        for k in ("equity", "assets"):
            row[k] = at(inst[k], e)
        cash, invest = at(inst["cash"], e), at(bal["invest"], e)
        if invest is None:
            invest = at(bal["investYear"], e)
        row["cash"] = at(bal["liquid"], e) or (cash + (invest or 0) if cash is not None else None)
        loans = total(e, "debtAll", ["debtLong", "debtCur"])
        if loans is not None and not bank:
            row["debt"] = loans + (at(bal["paper"], e) or 0) + (at(bal["shortDebt"], e) or 0) +                 (total(e, "opLease", ["opLeaseLong", "opLeaseCur"]) or 0) + (total(e, "finLease", ["finLeaseLong", "finLeaseCur"]) or 0)
        if bank:
            for k in ("ocf", "capex", "div", "cash"):
                row[k] = None
        # Rimlighet, som för de svenska bolagen
        assets, eq, rev = row.get("assets"), row.get("equity"), row.get("rev")
        if assets and assets > 0:
            if row.get("cash") is not None and not 0 <= row["cash"] <= assets:
                row["cash"] = None
            if row.get("debt") is not None and (row["debt"] < 0 or (eq is not None and row["debt"] > (assets - eq) * 1.01)):
                row["debt"] = None
            if row.get("ocf") is not None and abs(row["ocf"]) > assets:
                row["ocf"] = None
            for k in ("capex", "div"):
                if row.get(k) is not None and row[k] > assets * 0.5:
                    row[k] = None
        if rev and rev > 0 and row.get("capex") is not None and row["capex"] > rev:
            row["capex"] = None
        rows.append(row)
    out = {"fy": [fy_label(e) for e in ends]}
    for k in ("rev", "ebit", "net", "ocf", "capex", "div", "equity", "assets", "debt", "cash"):
        vals = [clean(r.get(k)) for r in rows]
        if any(x is not None for x in vals):
            out[k] = vals
    return out


def about_text(doc):
    """En kort förklaring på svenska av var bolaget finns och var siffrorna kommer ifrån (SEC har ingen
    beskrivning av verksamheten i maskinläsbar form, och bolagens egen text är på engelska)."""
    f, short = doc.get("facts") or {}, doc["short"]
    t = short + " är ett amerikanskt börsbolag"
    if f.get("hq"):
        t += " med huvudkontor i " + f["hq"]
    t += "."
    if f.get("list") and len(f.get("ticker") or []) == 1:
        t += " Aktien handlas på %s under kortnamnet %s." % (f["list"], f["ticker"][0])
    elif f.get("list") and f.get("ticker"):
        t += " Aktierna handlas på %s under kortnamnen %s." % (f["list"], " och ".join(f["ticker"]))
    t += (" Siffrorna nedan kommer från bolagets egna rapporter till SEC, den amerikanska motsvarigheten till Finansinspektionen:"
          " en kvartalsrapport (10-Q) efter årets tre första kvartal och en årsrapport (10-K) för helåret. Beloppen är i amerikanska dollar.")
    return t


# ---------- Körningen ----------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="site/data")
    ap.add_argument("--state", default="data/sec-state.json", help="läget mellan körningarna (sparas i repot, publiceras inte)")
    ap.add_argument("--top", type=int, default=600, help="så många av de största amerikanska innehaven tas med")
    ap.add_argument("--max-fetch", type=int, default=60, help="högst så många bolag hämtas per körning")
    ap.add_argument("--max-minutes", type=float, default=12)
    ap.add_argument("--only", default=None, help="kommaseparerade ISIN")
    ap.add_argument("--raw-cache", default=None, help="mapp där svaren från SEC sparas (lokalt, för felsökning)")
    ap.add_argument("--reparse", action="store_true", help="läs om svaren ur --raw-cache utan att hämta dem igen")
    ap.add_argument("--health", default=None, help="fil där hälsokollen sparas (problem blir ett ärende på GitHub)")
    args = ap.parse_args()
    global RAW_CACHE, REUSE_CACHE
    RAW_CACHE, REUSE_CACHE = args.raw_cache, args.reparse and bool(args.raw_cache)
    started = time.time()
    out_dir = os.path.join(args.out, "bolag")
    os.makedirs(out_dir, exist_ok=True)
    state = {}
    if os.path.exists(args.state):
        try:
            state = json.load(open(args.state, encoding="utf-8"))
        except ValueError:
            print("  Kunde inte läsa %s, börjar om" % args.state)
    st = state.setdefault("isin", {})   # per ISIN: CIK och när kopplingen kontrollerades
    co = state.setdefault("cik", {})    # per CIK: senast hämtat, senaste rapporten och när nästa väntas

    def save_state():
        os.makedirs(os.path.dirname(args.state) or ".", exist_ok=True)
        tmp = args.state + ".tmp"
        json.dump(state, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        os.replace(tmp, args.state)

    def out_of_time():
        return time.time() - started > args.max_minutes * 60

    # De amerikanska aktierna i det senaste kvartalet, störst innehav först
    index = json.load(open(os.path.join(args.out, "index.json"), encoding="utf-8"))
    world = None
    for qq in index["quarters"]:
        p = os.path.join(args.out, qq["id"] + "-world.json")
        if os.path.exists(p):
            world = json.load(open(p, encoding="utf-8"))
            break
    if not world:
        print("  Ingen utlandsdata, inget att göra")
        return 0
    value = {}
    for fund in world["funds"]:
        for h in fund[6]:
            price = world["stocks"][h[0]][3]
            if h[1] and price:
                value[h[0]] = value.get(h[0], 0) + h[1] * price
    us = sorted(((value.get(i, 0), s[0], s[1]) for i, s in enumerate(world["stocks"]) if s[0].startswith("US") and s[5] == "US"), reverse=True)
    universe = {isin: name for _, isin, name in us[:args.top]}
    order = [isin for _, isin, _ in us[:args.top]]
    if args.only:
        wanted = args.only.split(",")
        universe = {i: universe.get(i) or next((n for _, x, n in us if x == i), i) for i in wanted}
        order = wanted
    print("  %d amerikanska aktier (av %d)" % (len(universe), len(us)))

    problems, parse_errors, failures, fetched, ok_fetch = [], [], 0, 0, 0
    # 1. CIK per ISIN, ur SEC:s lista över bolag (hämtas när någon aktie saknar koppling)
    missing = [i for i in universe if not st.get(i, {}).get("cik") and days_since(st.get(i, {}).get("checked")) > 30]
    if missing:
        try:
            tickers = get_json(EDGAR + "/files/company_tickers.json", "company_tickers.json.gz")
            found = match_ciks({i: universe[i] for i in missing}, tickers or {}, st)
            for i in missing:
                st.setdefault(i, {})["checked"] = TODAY.isoformat()
                if found.get(i):
                    st[i]["cik"] = found[i]
            print("  Kopplade %d av %d nya aktier till SEC" % (sum(1 for i in missing if found.get(i)), len(missing)))
        except Exception as e:
            print("  Kunde inte hämta SEC:s bolagslista (%s)" % e)
            problems.append("SEC:s bolagslista (company_tickers.json) gick inte att hämta: %s" % e)

    # 2. Bolagen som ska hämtas: nya först, sedan de som väntar på en rapport, sedan de äldsta. Störst innehav först.
    def priority(cik):
        c = co.get(str(cik), {})
        if not c.get("fetched") or c.get("v") != PARSER_VERSION or args.reparse:
            return 0
        if c.get("fetched") < TODAY.isoformat() and c.get("next") and c["next"] <= TODAY.isoformat() and days_since(c["next"]) <= 45:
            return 1
        if days_since(c.get("fetched")) >= 30:
            return 2
        return None

    ciks, seen = [], set()
    for isin in order:
        cik = st.get(isin, {}).get("cik")
        if cik and cik not in seen and not co.get(str(cik), {}).get("skip"):
            seen.add(cik)
            ciks.append(cik)
    if args.only:
        due = ciks
    else:
        due = [c for _, _, c in sorted((p, n, c) for n, c in enumerate(ciks) for p in [priority(c)] if p is not None)]
    names = {}
    for isin in order:
        cik = st.get(isin, {}).get("cik")
        if cik and cik not in names:
            names[cik] = universe.get(isin)

    docs = {}
    for cik in due:
        if out_of_time() or fetched >= args.max_fetch:
            break
        if failures >= 8:
            print("  SEC svarar inte, resten tas nästa gång")
            break
        c = co.setdefault(str(cik), {})
        cik10 = "%010d" % int(cik)
        try:
            sub = get_json("https://data.sec.gov/submissions/CIK%s.json" % cik10, "sub-%s.json.gz" % cik10)
            fetched += 1
            more_filings(sub or {}, cik10)
            flist = filings(sub or {})
            reports = [f for f in flist if f["form"] in FORMS]
            if not reports:
                # inga 10-Q eller 10-K (utländska bolag lämnar 20-F): inget att visa, kontrolleras igen om ett halvår
                c.update({"fetched": TODAY.isoformat(), "v": PARSER_VERSION, "skip": 1})
                continue
            newest = max(reports, key=lambda f: (f["filingDate"], f["accessionNumber"]))["accessionNumber"]
            # Bara när en ny rapport har kommit hämtas siffrorna (de är flera megabyte)
            if c.get("last") == newest and c.get("v") == PARSER_VERSION and not args.only and not args.reparse:
                c["fetched"] = TODAY.isoformat()
                ok_fetch += 1
                continue
            facts = get_json("https://data.sec.gov/api/xbrl/companyfacts/CIK%s.json" % cik10, "facts-%s.json.gz" % cik10)
        except Exception as e:
            print("  CIK %s: kunde inte hämta från SEC (%s)" % (cik, e))
            failures += 1
            continue
        failures = 0
        ok_fetch += 1
        if not facts or "us-gaap" not in facts.get("facts", {}):
            c.update({"fetched": TODAY.isoformat(), "v": PARSER_VERSION, "skip": 1})
            continue
        try:
            doc = build(cik, facts, sub, names.get(cik))
        except Exception as e:
            print("  CIK %s: fel vid tolkning (%s)" % (cik, e))
            parse_errors.append("CIK %s: %s" % (cik, e))
            continue
        c.update({"fetched": TODAY.isoformat(), "v": PARSER_VERSION, "last": newest, "next": doc.pop("_due", None)})
        c.pop("skip", None)
        docs[cik] = doc
        if fetched % 20 == 0:
            save_state()
    print("  SEC: %d bolag hämtade, %d med nya siffror" % (fetched, len(docs)))
    if len(parse_errors) >= 3:
        problems.append("%d bolag gick inte att tolka (formatet hos SEC kan ha ändrats): %s" % (len(parse_errors), "; ".join(parse_errors[:5])))
    if failures >= 8 or (fetched >= 5 and ok_fetch == 0):
        problems.append("SEC svarade inte: %d anrop i rad misslyckades." % failures)

    # 3. En fil per aktie (alla aktieslag i bolaget får samma), med placering bland de amerikanska bolagen
    written = 0
    for isin in order:
        cik = st.get(isin, {}).get("cik")
        if cik not in docs:
            continue
        doc = dict(docs[cik])
        doc["about"] = {"text": about_text(doc), "src": "sec",
                        "url": EDGAR + "/cgi-bin/browse-edgar?action=getcompany&CIK=%010d&type=10-&dateb=&owner=include&count=40" % int(cik)}
        path = os.path.join(out_dir, isin + ".json")
        old = None
        if os.path.exists(path):
            try:
                old = json.load(open(path, encoding="utf-8"))
                doc["rank"] = old.get("rank")
            except ValueError:
                pass
        if not doc.get("rank"):
            doc.pop("rank", None)
        write_doc(path, doc, old)
        written += 1

    # Placering i försäljning bland alla amerikanska bolag som har en fil (ett bolag räknas en gång)
    us_files = {n[:-5]: os.path.join(out_dir, n) for n in os.listdir(out_dir) if n.startswith("US") and n.endswith(".json")}
    loaded = {}
    for isin, path in us_files.items():
        try:
            loaded[isin] = json.load(open(path, encoding="utf-8"))
        except ValueError:
            continue
    revs = {}
    for isin, doc in loaded.items():
        rev = ((doc.get("report") or {}).get("fin") or {}).get("rev", [None])[0]
        if rev and doc.get("cik"):
            revs[doc["cik"]] = rev
    order_rev = sorted(revs, key=lambda c: -revs[c])
    ranks = {c: [n + 1, len(order_rev)] for n, c in enumerate(order_rev)}
    for isin, doc in loaded.items():
        rk = {"rev": ranks[doc["cik"]]} if doc.get("cik") in ranks else None
        if (doc.get("rank") or None) != rk:
            new = dict(doc)
            if rk:
                new["rank"] = rk
            else:
                new.pop("rank", None)
            write_doc(us_files[isin], new, doc)
    # Aktier som inte längre finns bland innehaven tas bort
    if not args.only:
        keep = {i for _, i, _ in us}
        for isin, path in us_files.items():
            if isin not in keep:
                os.remove(path)
    have = sorted(n[:-5] for n in os.listdir(out_dir) if n.endswith(".json") and not n.startswith("_"))
    json.dump({"built": TODAY.isoformat(), "isins": have}, open(os.path.join(out_dir, "_index.json"), "w", encoding="utf-8"), separators=(",", ":"))
    save_state()
    n_us = sum(1 for i in have if i.startswith("US"))
    print("  Klart: %d filer skrivna, %d amerikanska aktier har bolagsfakta (%.0f s)" % (written, n_us, time.time() - started))
    health = {"date": TODAY.isoformat(), "fetched": fetched, "written": written, "withFacts": n_us, "problems": problems}
    if args.health:
        json.dump(health, open(args.health, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    for p in problems:
        print("  LARM: " + p)
    return 0


def write_doc(path, doc, old):
    """Sparar bara om innehållet ändrats (datumet "built" räknas inte), så att filerna inte ändras i onödan."""
    doc = dict(doc, built=TODAY.isoformat())
    if old:
        o = dict(old, built=doc["built"])
        if json.dumps(o, sort_keys=True) == json.dumps(doc, sort_keys=True):
            return
    open(path, "w", encoding="utf-8").write(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    sys.exit(main())
