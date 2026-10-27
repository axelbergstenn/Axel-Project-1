#!/usr/bin/env python3
"""
Bygger data/bolag/<ISIN>.json: en lättläst bild av varje svenskt bolag som fonderna äger ("Känn bolaget" på aktiesidan).

Tre öppna källor, utan nycklar:
  - Årsredovisningen i ESEF-format (maskinläsbar, obligatorisk för bolag på reglerad marknad), via filings.xbrl.org.
    Därifrån kommer omsättning, resultat, utdelning, affärsområden (segmentsnoten) och försäljning per land.
    ISIN kopplas till bolagets LEI-kod via GLEIF.
  - Wikidata: grundår, grundare, huvudkontor, anställda, vd, kända produkter och varumärken.
  - Svenska Wikipedia: en kort beskrivning av bolaget (CC BY-SA 4.0, med källa och länk på sajten).

Affärsområden och länder läses ur tabeller som ser olika ut hos olika bolag. Varje tabell kontrolleras mot bolagets
totala omsättning: går summan inte ihop (inom 10 %) används den inte. Hellre ingen uppgift än en felaktig.

Allt ändras sällan, så varje del hämtas om med långa mellanrum och bara så mycket som hinns med per körning:
  - LEI-koden en gång (saknas den, en gång i månaden),
  - nya årsredovisningar en gång i veckan per bolag, och bara nya rapporter laddas ner och läses,
  - Wikidata och Wikipedia en gång i månaden.
Läget sparas i data/bolag-state.json i repot (utanför site/, så att det inte publiceras).

  python3 scripts/build-companies.py
  py -I scripts/build-companies.py --raw-cache .cache/esef --only SE0000667891    (lokalt, sparar nedladdade rapporter)
"""
import argparse
import datetime as dt
import gzip
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

# Höjs när tolkningen av rapporterna ändras, så att alla rapporter läses om
PARSER_VERSION = 6
UA = "Fondinsyn/1.0 (https://www.fondinsyn.se)"
TODAY = dt.date.today()


# ---------- Hämtning ----------

def fetch(url, accept="application/json", tries=3, timeout=60):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept, "Accept-Encoding": "gzip"})
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
            time.sleep(3 * (i + 1) * (4 if e.code == 429 else 1))
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(3 * (i + 1))


def fetch_json(url, **kw):
    b = fetch(url, **kw)
    return json.loads(b) if b else None


def days_since(date_text):
    try:
        return (TODAY - dt.date.fromisoformat(date_text)).days
    except (TypeError, ValueError):
        return 10 ** 6


# ---------- Tabeller i rapporternas noter ----------

class TableParser(HTMLParser):
    """Läser alla tabeller i en HTML-bit till listor av rader med celltext. colspan upprepas, så att kolumnerna
    stämmer mellan rubrikrader och siffror."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables, self.stack, self.row, self.cell, self.span = [], [], None, None, 1

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.stack.append([])
        elif tag == "tr" and self.stack:
            self.row = []
        elif tag in ("td", "th") and self.row is not None:
            self.cell = []
            try:
                self.span = max(1, min(20, int(dict(attrs).get("colspan") or 1)))
            except ValueError:
                self.span = 1
        elif tag in ("br", "p", "div") and self.cell is not None:
            self.cell.append(" ")

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.cell is not None and self.row is not None:
            text = re.sub(r"\s+", " ", "".join(self.cell)).strip()
            self.row.append(text)
            self.row.extend([""] * (self.span - 1))
            self.cell = None
        elif tag == "tr" and self.row is not None and self.stack:
            if any(self.row):
                self.stack[-1].append(self.row)
            self.row = None
        elif tag == "table" and self.stack:
            t = self.stack.pop()
            if t:
                self.tables.append(t)

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)


def tables_of(html_text):
    p = TableParser()
    try:
        p.feed(html_text)
    except Exception:
        pass
    return p.tables


NUM_RE = re.compile(r"^\(?([-−–])?\s?(\d{1,3}(?:[   ]\d{3})+|\d+)(?:[,.](\d+))?\)?$")


def num(cell):
    """Tal i en tabellcell: '12 713', '−1 256', '(1 256)', '4,2'. Procent och tomma celler ger None."""
    t = re.sub(r"[  ]", " ", cell or "").strip()
    t = re.sub(r"\s*\d\)$", "", t) if re.search(r"\d\s+\d\)$", t) else t
    if not t or "%" in t:
        return None
    # Tusental med punkt ("206.455", som Volvo skriver) när det inte finns något decimalkomma
    if re.fullmatch(r"\(?[-−–]?\s?\d{1,3}(\.\d{3})+\)?", t):
        t = t.replace(".", " ")
    m = NUM_RE.match(t)
    if not m:
        return None
    v = float(m.group(2).replace(" ", "") + ("." + m.group(3) if m.group(3) else ""))
    if m.group(1) or (t.startswith("(") and t.endswith(")")):
        v = -v
    return v


def is_year(cell):
    return bool(re.fullmatch(r"(19|20)\d\d", (cell or "").strip()))


def clean_label(s):
    s = re.sub(r"\s+", " ", s or "").strip()
    s = re.sub(r"^(RR|BR|KR)\s+", "", s)             # hänvisning till resultat- eller balansräkningen
    # Avstavning från PDF-layouten: "Anläggnings- maskiner" blir "Anläggningsmaskiner", men "Nord- och Sydamerika" behålls
    s = re.sub(r"(\w)- (?!och\b|and\b|eller\b|or\b)([a-zåäö])", r"\1\2", s)
    s = re.sub(r"(\w)- ([A-ZÅÄÖ])", r"\1-\2", s)      # "Ibero- America" blir "Ibero-America"
    s = re.sub(r"[¹²³⁰-₟]", "", s)  # upphöjda fotnotstecken
    s = re.sub(r"(\s*\d?\))+$", "", s)          # fotnoter: "Övrigt2)", "Övrigt 1)", "Övriga )"
    s = re.sub(r"\bverk samhet\b", "verksamhet", s)   # ord som delats av PDF-layouten
    s = re.sub(r"[*]+$", "", s).strip()
    return s.strip(" :")


def split_header(table):
    """Delar en tabell i rubrikrader och datarader. Datan börjar vid första raden med minst två tal som inte är årtal."""
    for i, row in enumerate(table):
        vals = [c for c in row[1:] if num(c) is not None and not is_year(c)]
        if len(vals) >= 2:
            return table[:i], table[i:]
    return table, []


def column_names(header, width):
    """Kolumnnamn ur en eller flera rubrikrader: 'Machining' + 'and Intelligent' + 'Manufacturing'."""
    names, years = [], []
    for col in range(width):
        parts, year = [], None
        for row in header:
            c = row[col].strip() if col < len(row) else ""
            if not c:
                continue
            y = re.search(r"\b(19|20)\d\d\b", c)
            if is_year(c):
                year = int(c)
                continue
            if col == 0 and y:
                year = int(y.group(0))
            parts.append(c)
        name = ""
        for p in parts:
            name = (name[:-1] + p) if name.endswith("-") and p[:1].islower() else (name + " " + p if name else p)
        names.append(clean_label(name))
        years.append(year)
    # Ett namn över två årskolumner ("EMEIA" över 2024 och 2025) gäller båda kolumnerna
    for col in range(2, width):
        if not names[col] and years[col] is not None and names[col - 1] and years[col - 1] is not None and years[col - 1] != years[col]:
            names[col] = names[col - 1]
    return names, years


def row_label(row):
    for i, c in enumerate(row):
        if re.search(r"[A-Za-zÅÄÖåäö]", c):
            return i, clean_label(c)
    return -1, ""


EXCLUDE_COL = re.compile(r"eliminer|^elim\b|koncerngemensam|gruppgemensam|gemensam|corporate|centrala|moderbolag|avstämning|"
                         r"justering|ofördelat|ej fördelat|unallocated|reconcil|^totalt?\b|^total\b|^summa|^koncern|^gruppen|"
                         r"^group\b|övergripande|^msek|^mkr|^tsek|^meur|^sek|^not\b|^belopp|koncernen$|koncernfunktion", re.I)
OTHER_COL = re.compile(r"^(övrig|övriga|övrigt|other|others)\b", re.I)
TOTAL_COL = re.compile(r"^(totalt?|summa|koncernen|gruppen|group|total)\b|koncernen totalt|totalt segment|koncernen$", re.I)
REV_ROW = re.compile(r"^(summa |totala? |total )?(externa? |extern )?(nettoomsättning|intäkter|försäljningsintäkter|"
                     r"rörelsens intäkter|net sales|revenues?|sales|omsättning|hyresintäkter|"
                     r"intäkter från externa kunder|försäljning)\b", re.I)
REV_EXTERNAL = re.compile(r"extern|från externa", re.I)
REV_BAD = re.compile(r"intern|varav|koncerninter|mellan segment|between", re.I)
PROFIT_ROW = re.compile(r"^(justerat |justerad |underliggande |adjusted )?(rörelseresultat|ebita|ebit|operating profit|"
                        r"operating income|operating result|förvaltningsresultat|resultat före finansiella poster)\b", re.I)
# Affärsområdenas försäljning före elimineringar (med försäljning till andra affärsområden)
GROSS_ROW = re.compile(r"^(summa|totalt?|total|försäljningsintäkter|nettoomsättning|intäkter)\b", re.I)


def segment_table(blocks, fy, revenue):
    """Affärsområden ur segmentsnoten: [(namn, intäkter, resultat, övrigt?)] i tabellens enhet, plus resultatmåttets namn
    och skalan till kronor. Godkänns bara om affärsområdenas intäkter summerar till omsättningen (±10 %).
    Står resultatet i en annan tabell än intäkterna (samma affärsområden, samma år) hämtas det därifrån."""
    best = None
    profit_tables = []
    for block in blocks:
        for table in tables_of(block):
            header, data = split_header(table)
            if not header or len(data) < 2:
                continue
            width = max(len(r) for r in table)
            names, years = column_names(header, width)
            cand = segment_rows(data, width, names, years, fy, revenue)
            if cand and (best is None or cand["score"] < best["score"]):
                best = cand
            row_years = {y for y in years if y}
            # Tabeller med flera år i kolumnerna: bara årets kolumner
            per_col_year = len(row_years) > 1 and sum(1 for y in years[1:] if y) >= 2
            if not per_col_year:
                if row_years and fy not in row_years:
                    continue
            cols = []
            for c in range(1, width):
                nm = names[c]
                if not nm or EXCLUDE_COL.search(nm) or not re.search(r"[A-Za-zÅÄÖåäö]", nm):
                    continue
                if per_col_year and years[c] not in (fy, None):
                    continue
                cols.append(c)
            total_cols = [c for c in range(1, width) if names[c] and TOTAL_COL.search(names[c]) and (not per_col_year or years[c] in (fy, None))]
            if len(cols) < 2 or len(cols) > 12:
                continue
            rev_rows, profit_rows = [], []
            for row in data:
                li, label = row_label(row)
                if li < 0:
                    continue
                if REV_ROW.search(label) and not REV_BAD.search(label):
                    rev_rows.append((label, row))
                elif PROFIT_ROW.search(label) and not re.search(r"marginal|%|per aktie", label, re.I):
                    profit_rows.append((label, row))
            if profit_rows:
                profit_tables.append(([names[c] for c in cols], cols, profit_rows, rev_rows))
            tcols = cols
            for label, row in rev_rows:
                # Delsummor ("Industriverksamheten" = kolumnerna närmast före) räknas inte som affärsområden
                raw = [num(row[c]) if c < len(row) else None for c in range(width)]
                sub = set()
                for j in range(2, width):
                    for i in range(1, j - 1):
                        part = [v for v in raw[i:j] if v]
                        if raw[j] and len(part) >= 2 and abs(sum(part) / raw[j] - 1) < 0.005:
                            sub.add(j)
                # Negativa intäkter är elimineringar, hur kolumnen än heter ("Elim.")
                cols = [c for c in tcols if c not in sub and not (raw[c] is not None and raw[c] < 0)]
                vals = [raw[c] for c in cols]
                if sum(1 for v in vals if v and v > 0) < 2:
                    continue
                total = sum(v for v in vals if v)
                tot_cell = None
                for tc in total_cols:
                    if tc < len(row) and num(row[tc]):
                        tot_cell = num(row[tc])
                ref, scale = None, None
                if revenue:
                    for k in (1, 1e3, 1e6, 1e9):
                        if abs(total * k / revenue - 1) <= 0.10:
                            ref, scale = revenue, k
                            break
                elif tot_cell and abs(total / tot_cell - 1) <= 0.10:
                    ref, scale = tot_cell, None
                if ref is None:
                    continue
                prof_label, prof_vals = best_profit(profit_rows, cols)
                score = (abs(total * (scale or 1) / ref - 1) + (0 if REV_EXTERNAL.search(label) else 0.001) - (0.0005 if prof_vals else 0)
                         + place_penalty([names[c] for c in cols]))
                if best is not None and score >= best["score"]:
                    continue
                # Säljer affärsområdena mycket till varandra (som Bolidens gruvor till smältverken) räknas andel och
                # marginal på försäljningen före elimineringar
                for glabel, grow in rev_rows:
                    gv = [num(grow[c]) if c < len(grow) else None for c in cols]
                    if (GROSS_ROW.search(glabel) and not REV_EXTERNAL.search(glabel) and all(g is not None for g in gv)
                            and all(g >= (v or 0) * 0.98 for g, v in zip(gv, vals)) and sum(gv) > total * 1.02):
                        vals = gv
                        break
                items = []
                for i, c in enumerate(cols):
                    if not vals[i]:
                        continue
                    items.append([names[c], vals[i], prof_vals[i] if prof_vals else None, bool(OTHER_COL.search(names[c]))])
                if sum(1 for it in items if not it[3]) < 2:
                    continue
                best = {"score": score, "items": items, "metric": prof_label, "scale": scale, "rowLabel": label}
    if best and not best["metric"]:
        # Resultatet i en annan tabell: samma affärsområden och samma intäkter (så att det är samma år)
        want = {it[0]: it[1] for it in best["items"]}
        for names_, cols, profit_rows, rev_rows in profit_tables:
            if not set(want) <= set(names_):
                continue
            pos = {n: c for n, c in zip(names_, cols)}
            same_year = any(all(num(r[pos[n]] if pos[n] < len(r) else "") == v for n, v in want.items()) for _, r in rev_rows)
            if not same_year:
                continue
            plabel, pv = best_profit(profit_rows, [pos[n] for n in want])
            if pv:
                for it, p in zip(best["items"], pv):
                    it[2] = p
                best["metric"] = plabel
                break
    if best:
        best = tidy_segments(best, fy)
    if best:
        # Ett resultat större än försäljningen är inte en rörelsemarginal att visa (fel rad eller intern försäljning)
        for it in best["items"]:
            if it[2] is not None and abs(it[2]) > it[1]:
                it[2] = None
        m = best["metric"] or ""
        if re.match(r"resultat före finansiella", m, re.I):
            best["metric"] = "Rörelseresultat"
    return best


PERIOD_RE = re.compile(r"\b(jan(uari)?|sept?(ember)?|okt(ober)?|apr(il)?|maj|jul(i)?)\s*[-–—]\s*(dec(ember)?|mar(s)?|apr(il)?|jun(i)?)\b|"
                       r"\bhelår\b|\b(per\s+)?\d{1,2}\s+dec(ember)?\b", re.I)


def tidy_segments(best, fy):
    """Tar bort periodtext ur namnen ("B3 Sweden jan–dec", "Imaging IT Solutions 24/25", "2025 Healthcare Services").
    Står ett annat år kvar, eller ser namnen ut som rubriker eller avstämningsposter, används inte tabellen alls:
    då kan kolumnerna vara blandade mellan åren."""
    fy_tokens = [str(fy), str(fy + 1), "%d/%02d" % (fy, (fy + 1) % 100), "%02d/%02d" % (fy % 100, (fy + 1) % 100)]
    keep = []
    for it in best["items"]:
        n = PERIOD_RE.sub(" ", it[0])
        for t in fy_tokens:
            n = re.sub(r"(?<![\d/])" + re.escape(t) + r"(?![\d/])", " ", n)
        n = re.sub(r"\s+(eller|och|or|and)\s*$|^\s*(eller|och|or|and)\s+", " ", n.strip(" ,;:–-"))
        n = clean_label(re.sub(r"\s+", " ", n))
        if re.search(r"ifrs|omräkning|leasing|justering|avstämning", n, re.I):
            continue  # avstämningsposter mellan affärsområdena och koncernen
        if (not n or re.search(r"\b(19|20)\d\d\b|\b\d\d/\d\d\b|redovisning", n, re.I)
                or re.search(r"\b[A-ZÅÄÖ]{6,}\b", n) or len(n) > 60):
            return None
        keep.append([n] + it[1:])
    if len(set(it[0].lower() for it in keep)) < len(keep) or sum(1 for it in keep if not it[3]) < 2:
        return None
    best["items"] = keep
    return best


def place_penalty(names):
    """Är affärsområdena länder och regioner används de bara om bolaget inte har en tabell med riktiga affärsområden
    (Peab har båda; Telia och Bravida är indelade efter land)."""
    return 0.05 if sum(1 for n in names if place(n)) * 2 >= len(names) else 0


def segment_rows(data, width, names, years, fy, revenue):
    """Affärsområden som rader och nyckeltal som kolumner (som Electrolux: "Nettoomsättning 2025 | 2024 | Rörelseresultat ...")."""
    if not revenue:
        return None
    def find(regex):
        for c in range(1, width):
            if names[c] and regex.search(names[c]) and not REV_BAD.search(names[c]) and years[c] in (fy, None):
                if years[c] == fy or not any(years[1:]):
                    return c
        return None
    rc, pc = find(REV_ROW), find(PROFIT_ROW)
    if rc is None:
        return None
    items = []
    for row in data:
        li, label = row_label(row)
        if li < 0 or li >= rc or re.match(r"^varav\b", label, re.I):
            continue
        if TOTAL_COL.search(label) or EXCLUDE_COL.search(label):
            if items and TOTAL_COL.search(label):
                break
            continue
        v = num(row[rc]) if rc < len(row) else None
        if v is None or v <= 0:
            continue
        p = num(row[pc]) if pc is not None and pc < len(row) else None
        items.append([label, v, p, bool(OTHER_COL.search(label))])
    if sum(1 for it in items if not it[3]) < 2 or len(items) > 12:
        return None
    total = sum(it[1] for it in items)
    for k in (1, 1e3, 1e6, 1e9):
        if abs(total * k / revenue - 1) <= 0.10:
            return {"score": abs(total * k / revenue - 1) + 0.002 + place_penalty([it[0] for it in items]), "items": items, "metric": names[pc] if pc is not None else None,
                    "scale": k, "rowLabel": names[rc]}
    return None


def best_profit(profit_rows, cols):
    """Rörelseresultatet i första hand, justerade mått (EBITA, justerat rörelseresultat) i andra."""
    def prio(x):
        l = x[0].lower()
        return (bool(re.match(r"(justera|underligg|adjusted)", l)), not (l.startswith("rörelseresultat") or l.startswith("resultat före finansiella")),
                "exkl" in l or "före" in l and not l.startswith("resultat före finansiella"))
    for plabel, prow in sorted(profit_rows, key=prio):
        pv = [num(prow[c]) if c < len(prow) else None for c in cols]
        if sum(1 for v in pv if v is not None) >= 2:
            return re.sub(r"\s+(RR|BR)$", "", plabel), pv
    return None, None


# Länder och regioner som kan stå i en tabell över försäljning per marknad, med svenskt namn
PLACES = {}
for sv, *alts in [
    ("Sverige", "sweden"), ("Norge", "norway"), ("Danmark", "denmark"), ("Finland",), ("Island", "iceland"),
    ("Tyskland", "germany"), ("Frankrike", "france"), ("Storbritannien", "uk", "united kingdom", "great britain", "england", "storbritannien och irland"),
    ("Irland", "ireland"), ("Nederländerna", "netherlands", "holland"), ("Belgien", "belgium"), ("Spanien", "spain"),
    ("Italien", "italy"), ("Polen", "poland"), ("Schweiz", "switzerland"), ("Österrike", "austria"), ("Portugal",),
    ("Tjeckien", "czech republic", "czechia"), ("Ryssland", "russia"), ("Turkiet", "turkey", "türkiye"), ("Grekland", "greece"),
    ("Ungern", "hungary"), ("Rumänien", "romania"), ("Baltikum", "baltics", "the baltics"), ("Estland", "estonia"),
    ("Lettland", "latvia"), ("Litauen", "lithuania"), ("Luxemburg", "luxembourg"),
    ("USA", "usa", "us", "united states", "förenta staterna", "united states of america"), ("Kanada", "canada"), ("Mexiko", "mexico"),
    ("Brasilien", "brazil"), ("Chile",), ("Argentina",), ("Peru",), ("Colombia",),
    ("Kina", "china"), ("Japan",), ("Indien", "india"), ("Sydkorea", "south korea", "korea"), ("Australien", "australia"),
    ("Nya Zeeland", "new zealand"), ("Singapore",), ("Hongkong", "hong kong"), ("Taiwan",), ("Indonesien", "indonesia"),
    ("Thailand",), ("Malaysia",), ("Vietnam",), ("Filippinerna", "philippines"), ("Saudiarabien", "saudi arabia"),
    ("Förenade Arabemiraten", "united arab emirates", "uae"), ("Israel",), ("Sydafrika", "south africa"), ("Egypten", "egypt"),
    ("Nigeria",), ("Marocko", "morocco"), ("Curaçao", "curacao"), ("Malta",), ("Cypern", "cyprus"),
    ("Norden", "nordic", "nordics", "nordic countries", "nordiska länder", "nordic region"),
    ("Övriga Norden", "övriga norden", "other nordic", "other nordic countries", "övriga nordiska länder"),
    ("Europa", "europe", "europa exkl. sverige", "europa (exkl. sverige)", "eu", "eu exkl. sverige", "västeuropa",
     "western europe", "emea", "europa, mellanöstern och afrika", "europe, middle east and africa"),
    ("Övriga Europa", "övriga europa", "rest of europe", "other europe", "europa, övrigt", "europa övrigt", "övriga eu",
     "övriga eu-länder", "övriga europeiska länder"),
    ("Östeuropa", "eastern europe", "central- och östeuropa", "central and eastern europe"),
    ("Nordamerika", "north america", "amerika", "americas", "nord- och sydamerika", "the americas"),
    ("Sydamerika", "south america", "latinamerika", "latin america", "syd- och mellanamerika", "central and south america"),
    ("Asien", "asia", "asien och oceanien", "asia pacific", "apac", "asien/stillahavsområdet", "asien och stillahavsområdet",
     "asia and oceania", "asien/oceanien"),
    ("Övriga Asien", "övriga asien", "rest of asia", "other asia"),
    ("Oceanien", "oceania", "australien och nya zeeland", "australia and new zealand"),
    ("Mellanöstern", "middle east", "mellanöstern och afrika", "middle east and africa"), ("Afrika", "africa"),
    ("Övriga länder", "övriga världen", "rest of the world", "rest of world", "övriga länder", "other countries", "övriga marknader",
     "other markets", "resten av världen", "övriga", "övrigt", "other", "andra länder", "världen i övrigt", "others",
     "övriga regioner", "other regions"),
]:
    for a in [sv.lower()] + list(alts):
        PLACES[a] = sv
# Delar av ord som visar att en rad är en region: "Sydostasien, Oceanien och Indien", "Nordostasien"
PLACE_PARTS = re.compile(r"asien|amerika|europa|afrika|norden|oceanien|mellanöstern|asia|america|europe|africa|nordic|oceania|middle east", re.I)


def place(label):
    """Svenskt namn på ett land eller en region, eller None. Regioner med egna namn behåller bolagets namn."""
    k = re.sub(r"\s+", " ", re.sub(r"(\s*\d\)|[*¹²³⁴])+$", "", label or "")).strip().lower().strip(":")
    if k in PLACES:
        return PLACES[k]
    if PLACE_PARTS.search(k) and len(k) <= 48 and not re.search(r"\d|summa|total|varav|intäkt|försälj|tillgång", k):
        return clean_label(label)[:1].upper() + clean_label(label)[1:]
    return None


def geo_table(blocks, fy, revenue, seg_names):
    """Försäljning per land eller region: [(namn, belopp)] i kronor. Godkänns bara om raderna summerar till omsättningen.
    En tabell kan ha flera avsnitt (per affärsområde, per land, per produkt); varje följd av länder prövas för sig, i varje
    kolumn med årets siffror."""
    if not revenue:
        return None
    best = None
    seg_lower = {s.lower() for s in seg_names}
    for block in blocks:
        for table in tables_of(block):
            header, data = split_header(table)
            if len(data) < 3:
                continue
            width = max(len(r) for r in table)
            names, years = column_names(header, width)
            has_years = any(years[1:])
            runs, run, region = [], [], None
            for row in data:
                li, label = row_label(row)
                if li < 0:
                    continue  # delsummor utan rubrik
                # Två nivåer: "Nordamerika | USA", sedan "| Övriga länder"
                second = next((clean_label(c) for c in row[li + 1:li + 2] if re.search(r"[A-Za-zÅÄÖåäö]", c)), None)
                if second and place(label):
                    region, label = label, second
                elif li == 0:
                    region = None
                if re.match(r"^varav\b", label, re.I):
                    continue  # "varav Sverige" ingår redan i regionen ovanför
                if re.match(r"^(summa|totalt?|total|koncernen|nettoomsättning|omsättning|intäkter)\b", label, re.I) or label.lower() in seg_lower:
                    if run:
                        runs.append(run)
                    run = []
                    continue
                pl = place(label)
                if pl == "Övriga länder" and region:
                    pl = "Övriga " + (place(region) or region)
                has_num = any(num(c) is not None for c in row[li + 1:])
                if pl:
                    run.append((pl, row))
                elif run and has_num and len(label) <= 40 and not re.search(
                        r"\d|intäkt|försälj|omsättning|summa|kostnad|resultat|tillgång|derivat|skuld|varav|order|%", label, re.I):
                    # Ett land som inte finns i listan ovan, mitt bland andra länder
                    run.append((label[:1].upper() + label[1:], row))
                else:
                    if run:
                        runs.append(run)
                    run = []
            if run:
                runs.append(run)
            for run in runs:
                for col in range(1, width):
                    if has_years and years[col] != fy:
                        continue
                    rows = [(pl, num(r[col]) if col < len(r) else None) for pl, r in run]
                    rows = [(pl, v) for pl, v in rows if v is not None]
                    places = [r for r in rows if r[0] != "Övriga länder"]
                    if len(places) < 3 or any(v < 0 for _, v in rows):
                        continue
                    total = sum(v for _, v in rows)
                    if total <= 0:
                        continue
                    for k in (1, 1e3, 1e6, 1e9):
                        if abs(total * k / revenue - 1) <= 0.10:
                            merged = {}
                            for name, v in rows:
                                merged[name] = merged.get(name, 0) + v * k
                            score = abs(total * k / revenue - 1) - 0.002 * len(places)
                            if best is None or score < best[0]:
                                best = (score, sorted(merged.items(), key=lambda x: (x[0] == "Övriga länder", -x[1])))
                            break
    return best[1] if best else None


# ---------- Årsredovisningen (xBRL-JSON) ----------

TEXT_CONCEPTS = re.compile(r"(Segment|Geograph|Revenue|DisaggregationOfRevenue|NatureOfEntity|InformationAboutEmployees)", re.I)
NUM_CONCEPTS = {
    "rev": ["ifrs-full:Revenue", "ifrs-full:RevenueFromContractsWithCustomers", "ifrs-full:RevenueAndOperatingIncome"],
    "ebit": ["ifrs-full:ProfitLossFromOperatingActivities"],
    "net": ["ifrs-full:ProfitLoss"],
    "netOwners": ["ifrs-full:ProfitLossAttributableToOwnersOfParent"],
    "ocf": ["ifrs-full:CashFlowsFromUsedInOperatingActivities"],
    "equity": ["ifrs-full:Equity"],
    "assets": ["ifrs-full:Assets"],
    "eps": ["ifrs-full:BasicEarningsPerShare"],
    "dps": ["ifrs-full:DividendsProposedOrDeclaredBeforeFinancialStatementsAuthorisedForIssueButNotRecognisedAsDistributionToOwnersPerShare",
            "ifrs-full:DividendsRecognisedAsDistributionsToOwnersPerShare"],
    "employees": ["ifrs-full:NumberOfEmployees"],
}
CUSTOM_REV = re.compile(r":(NetSales|NetRevenue|Revenues?|Nettoomsattning|TotalRevenue|TotalIncome|Sales)$", re.I)


def slim_report(raw):
    """Det som behövs ur en rapport (ofta 3–10 MB) i en liten fil: textblock och siffror utan dimensioner."""
    facts = raw.get("facts", {})
    texts, nums = {}, []
    for f in facts.values():
        dims = f.get("dimensions", {})
        c = dims.get("concept", "")
        extra = [k for k in dims if k not in ("concept", "entity", "period", "unit", "language")]
        if extra:
            continue
        v = f.get("value")
        if isinstance(v, str) and len(v) > 200 and TEXT_CONCEPTS.search(c):
            texts.setdefault(c, []).append(v)
        elif v is not None and not (isinstance(v, str) and len(v) > 200):
            nums.append([c, dims.get("period", ""), dims.get("unit", ""), v])
    return {"texts": texts, "nums": nums}


def plain(text):
    t = re.sub(r"<[^>]+>", " ", text or "")
    return re.sub(r"\s+", " ", html.unescape(t)).strip()


def swedish(text):
    words = re.findall(r"\b(och|är|av|för|som|med|till|inom|bolaget|koncernen|verksamhet)\b", text.lower())
    return len(words) >= 3


def first_sentences(text, limit=420):
    if len(text) <= limit:
        return text
    cut = text[:limit]
    m = list(re.finditer(r"[.!?](\s|$)", cut))
    if m and m[-1].end() > 120:
        return cut[:m[-1].end()].strip()
    return cut.rsplit(" ", 1)[0].rstrip(",;:") + " …"


def read_report(slim, period_end):
    """Nyckeltal, affärsområden och länder ur en rapport."""
    end = dt.date.fromisoformat(period_end)
    fy = end.year if end.month >= 6 else end.year - 1
    after_end = (end + dt.timedelta(days=1)).isoformat()

    def duration_end(p):
        if "/" not in p:
            return None
        a, b = p.split("/")
        try:
            da, db = dt.date.fromisoformat(a[:10]), dt.date.fromisoformat(b[:10])
        except ValueError:
            return None
        return db.isoformat() if 300 <= (db - da).days <= 380 else None

    prev_end = None
    try:
        prev_end = dt.date(end.year - 1, end.month, min(end.day, 28 if end.month == 2 else end.day)) + dt.timedelta(days=1)
        prev_end = prev_end.isoformat()
    except ValueError:
        pass

    values = {}
    currency = None
    for c, period, unit, v in slim["nums"]:
        try:
            x = float(v)
        except (TypeError, ValueError):
            continue
        key = None
        for k, concepts in NUM_CONCEPTS.items():
            if c in concepts:
                key = (k, concepts.index(c))
        if key is None and CUSTOM_REV.search(c) and not c.startswith("ifrs-full:"):
            key = ("rev", 9)
        if key is None:
            continue
        de = duration_end(period)
        inst = period[:10] if "/" not in period else None
        which = None
        if de == after_end or inst == after_end:
            which = 0
        elif de == prev_end or inst == prev_end:
            which = 1
        if which is None:
            continue
        if key[0] == "rev" and unit.startswith("iso4217:"):
            currency = unit.split(":")[1]
        slot = values.setdefault(key[0], {})
        if (which, key[1]) not in slot:
            slot[(which, key[1])] = x

    def pick(k, which=0):
        slot = values.get(k, {})
        for prio in sorted(p for (w, p) in slot if w == which):
            return slot[(which, prio)]
        return None

    fin = {k: [pick(k, 0), pick(k, 1)] for k in NUM_CONCEPTS}
    if fin["net"][0] is None:
        fin["net"] = fin["netOwners"]
    del fin["netOwners"]
    fin = {k: v for k, v in fin.items() if v[0] is not None or v[1] is not None}
    revenue = fin.get("rev", [None])[0]

    seg_blocks = [v for c, vs in slim["texts"].items() if "Segment" in c for v in vs]
    geo_blocks = [v for c, vs in slim["texts"].items() if re.search(r"Segment|Geograph|Revenue", c) for v in vs]
    seg = segment_table(seg_blocks, fy, revenue)
    if seg and not revenue and seg.get("scale") is None:
        # Ingen märkt omsättning: affärsområdenas andelar går ändå att visa, men inga belopp
        pass
    segments = None
    if seg:
        k = seg["scale"] or 0
        segments = {
            "metric": seg["metric"],
            "items": [[n, round(r * k) if k else None, (round(p * k) if k and p is not None else None), round(r / sum(i[1] for i in seg["items"]), 4),
                       (round(p / r, 4) if p is not None and r else None), 1 if o else 0] for n, r, p, o in seg["items"]],
        }
    geo = geo_table(geo_blocks, fy, revenue, [i[0] for i in seg["items"]] if seg else [])

    about = None
    for v in slim["texts"].get("ifrs-full:DescriptionOfNatureOfEntitysOperationsAndPrincipalActivities", []):
        t = plain(v)
        if 60 <= len(t) and swedish(t):
            about = first_sentences(t, 600)
            break
    return {"fy": fy, "end": period_end, "cur": currency or "SEK", "fin": fin, "seg": segments,
            "geo": [[n, round(v)] for n, v in geo] if geo else None, "about": about}


# ---------- Wikidata och Wikipedia ----------

def wikidata_ids(isins, leis):
    """ISIN eller LEI till Wikidata-id."""
    out = {}
    keys = [("P946", i) for i in isins] + [("P1278", l) for l in leis if l]
    for i in range(0, len(keys), 120):
        part = keys[i:i + 120]
        for prop in ("P946", "P1278"):
            ids = [v for p, v in part if p == prop]
            if not ids:
                continue
            q = 'SELECT ?id ?item WHERE { VALUES ?id { %s } ?item wdt:%s ?id . }' % (" ".join('"%s"' % x for x in ids), prop)
            r = fetch_json("https://query.wikidata.org/sparql?format=json&query=" + urllib.parse.quote(q), accept="application/sparql-results+json")
            for b in (r or {}).get("results", {}).get("bindings", []):
                out.setdefault(b["id"]["value"], b["item"]["value"].rsplit("/", 1)[1])
            time.sleep(1)
    return out


def company_name(name):
    """Bolagsnamnet utan aktieslag och bolagsform: "EPIROC A" blir "EPIROC", "Dustin Group AB" blir "Dustin Group"."""
    n = re.sub(r"\s*\(publ\)", "", name or "", flags=re.I)
    n = re.sub(r"[\s-]+(ser\.?\s*|series\s+|class\s+)?[A-D]\d?(\s+shs)?$", "", n, flags=re.I)
    n = re.sub(r"\s+shs$", "", n, flags=re.I)
    n = re.sub(r"[\s-]+(AB|Aktiebolag|Ab)$", "", n)
    return n.strip()


def norm_name(n):
    n = re.sub(r"\(publ\)|\b(ab|aktiebolag|group|holding|ltd|plc|asa|oyj|inc|the)\b|[^\wåäöéü]+", " ", (n or "").lower())
    return re.sub(r"\s+", " ", n).strip()


def wikidata_by_name(stock_name):
    """Wikidata-id för ett bolag via namnsökning. Bara om namnet (eller ett alternativt namn) stämmer exakt och posten
    ser ut som ett bolag (har huvudkontor, bransch, börs, anställda eller organisationsnummer)."""
    q = company_name(stock_name)
    if len(norm_name(q)) < 3:
        return None
    r = fetch_json("https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=sv&uselang=sv&type=item&limit=7&search="
                   + urllib.parse.quote(q))
    cands = [x["id"] for x in (r or {}).get("search", [])]
    if not cands:
        return None
    ents = wd_entities(cands, props="claims|labels|aliases")
    want = norm_name(q)
    for qid in cands:
        e = ents.get(qid) or {}
        names = set()
        for lang in ("sv", "en"):
            if e.get("labels", {}).get(lang):
                names.add(norm_name(e["labels"][lang]["value"]))
            for a in e.get("aliases", {}).get(lang, []):
                names.add(norm_name(a["value"]))
        if want not in names:
            continue
        claims = e.get("claims", {})
        if any(p in claims for p in ("P414", "P452", "P159", "P1128", "P2139", "P946", "P1278")):
            return qid
    return None


def wd_entities(qids, props="claims|sitelinks|labels"):
    out = {}
    qids = list(dict.fromkeys(qids))
    for i in range(0, len(qids), 50):
        url = ("https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&languages=sv|en&props=%s&ids=%s"
               % (urllib.parse.quote(props), "|".join(qids[i:i + 50])))
        r = fetch_json(url) or {}
        out.update(r.get("entities", {}))
        time.sleep(0.5)
    return out


def claim_values(ent, prop):
    """Värden för en egenskap: föredragna först, utgångna (med sluttid) bort."""
    res = []
    for c in ent.get("claims", {}).get(prop, []):
        if c.get("rank") == "deprecated":
            continue
        q = c.get("qualifiers", {})
        if "P582" in q:  # sluttid: inte längre aktuellt (t.ex. tidigare vd)
            continue
        dv = c.get("mainsnak", {}).get("datavalue", {})
        when = None
        for pt in q.get("P585", []):
            when = pt.get("datavalue", {}).get("value", {}).get("time")
        res.append((c.get("rank") == "preferred", when or "", dv.get("value")))
    res.sort(key=lambda x: (not x[0], ""), reverse=False)
    return res


def label(ent):
    """(namn, språk): svenska i första hand, annars engelska."""
    l = ent.get("labels", {})
    for lang in ("sv", "en"):
        if l.get(lang):
            return (l[lang]["value"], lang)
    return None


def wiki_facts(ent, labels):
    def items(prop, n, sv_only=False):
        vals = []
        for _, _, v in claim_values(ent, prop):
            lab = labels.get(v["id"]) if isinstance(v, dict) and v.get("id") else None
            if not lab or (sv_only and lab[1] != "sv"):
                continue
            if not re.match(r"^Q\d+$", lab[0]) and lab[0] not in vals:
                vals.append(lab[0])
        return vals[:n]

    f = {}
    # Grundår: det tidigaste (Sandvik grundades 1862, aktiebolaget bildades 1897)
    years = []
    for _, _, v in claim_values(ent, "P571"):
        if isinstance(v, dict) and v.get("time"):
            m = re.match(r"\+(\d{4})", v["time"])
            if m:
                years.append(int(m.group(1)))
    if years:
        f["founded"] = min(years)
    emp = [(when, v) for _, when, v in claim_values(ent, "P1128") if isinstance(v, dict) and v.get("amount")]
    if emp:
        when, v = max(emp, key=lambda x: x[0])
        f["employees"] = [int(float(v["amount"])), when[1:5] if when else None]
    for key, prop, n, sv_only in (("founders", "P112", 4, False), ("hq", "P159", 1, False), ("ceo", "P169", 1, False),
                                  ("chair", "P488", 1, False), ("products", "P1056", 8, True), ("brands", "P1716", 8, False),
                                  ("industry", "P452", 3, True), ("owners", "P127", 3, False)):
        v = items(prop, n, sv_only)
        if v:
            f[key] = v if n > 1 else v[0]
    for _, _, v in claim_values(ent, "P856"):
        if isinstance(v, str) and v.startswith("http"):
            f["web"] = v
            break
    sl = ent.get("sitelinks", {}).get("svwiki")
    if sl:
        f["svwiki"] = sl["title"]
    return f


def wiki_summary(title):
    r = fetch_json("https://sv.wikipedia.org/api/rest_v1/page/summary/" + urllib.parse.quote(title.replace(" ", "_")))
    if not r or r.get("type") == "disambiguation":
        return None
    t = (r.get("extract") or "").strip()
    if len(t) < 60:
        return None
    return {"text": first_sentences(t, 520), "url": r.get("content_urls", {}).get("desktop", {}).get("page")}


# ---------- Huvudprogrammet ----------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="site/data")
    ap.add_argument("--max-reports", type=int, default=120, help="högst så många nya rapporter per körning")
    ap.add_argument("--max-checks", type=int, default=150, help="högst så många kontroller av nya rapporter per körning")
    ap.add_argument("--max-minutes", type=float, default=20)
    ap.add_argument("--raw-cache", default=None, help="mapp där nedladdade rapporter sparas (lokalt, för felsökning)")
    ap.add_argument("--only", default=None, help="kommaseparerade ISIN")
    ap.add_argument("--reparse", action="store_true", help="läs om alla rapporter ur --raw-cache")
    ap.add_argument("--state", default="data/bolag-state.json", help="läget mellan körningarna (sparas i repot, publiceras inte)")
    args = ap.parse_args()
    started = time.time()
    out_dir = os.path.join(args.out, "bolag")
    os.makedirs(out_dir, exist_ok=True)
    state_file = args.state
    os.makedirs(os.path.dirname(state_file) or ".", exist_ok=True)
    state = {}
    if os.path.exists(state_file):
        try:
            state = json.load(open(state_file, encoding="utf-8"))
        except ValueError:
            print("  Kunde inte läsa %s, börjar om" % state_file)
    st = state.setdefault("isin", {})
    reports = state.setdefault("reports", {})   # per LEI: senast lästa rapport och resultatet
    wiki = state.setdefault("wiki", {})         # per Wikidata-id: fakta och beskrivning

    def out_of_time():
        return time.time() - started > args.max_minutes * 60

    index = json.load(open(os.path.join(args.out, "index.json"), encoding="utf-8"))
    latest = index["quarters"][0]["id"]
    qd = json.load(open(os.path.join(args.out, latest + ".json"), encoding="utf-8"))
    stocks = {s[0]: s[1] for s in qd["stocks"] if s[0].startswith("SE")}
    if args.only:
        stocks = {i: stocks.get(i, i) for i in args.only.split(",")}
    print("  %d svenska aktier" % len(stocks))

    # 1. LEI-kod per ISIN (GLEIF tar många ISIN i samma anrop)
    need = [i for i in stocks if not st.get(i, {}).get("lei") and days_since(st.get(i, {}).get("leiChecked")) > 30]
    for i in range(0, len(need), 40):
        if out_of_time():
            break
        part = need[i:i + 40]
        r = fetch_json("https://api.gleif.org/api/v1/lei-records?page%5Bsize%5D=100&filter%5Bisin%5D=" + ",".join(part))
        found = {}
        for rec in (r or {}).get("data", []):
            # GLEIF svarar inte vilket ISIN som gav träffen, så det hämtas per post
            found[rec["id"]] = rec
        if len(found) == 1 and len(part) == 1:
            st.setdefault(part[0], {})["lei"] = next(iter(found))
        elif found:
            for isin in part:
                r1 = fetch_json("https://api.gleif.org/api/v1/lei-records?filter%5Bisin%5D=" + isin)
                if r1 and r1.get("data"):
                    st.setdefault(isin, {})["lei"] = r1["data"][0]["id"]
                time.sleep(1.1)
        for isin in part:
            st.setdefault(isin, {})["leiChecked"] = TODAY.isoformat()
        time.sleep(1.1)
    print("  LEI: %d av %d" % (sum(1 for i in stocks if st.get(i, {}).get("lei")), len(stocks)))

    # 2. Senaste årsredovisningen per bolag (LEI)
    leis = sorted({st[i]["lei"] for i in stocks if st.get(i, {}).get("lei")})
    due = sorted((l for l in leis if args.reparse or days_since(reports.get(l, {}).get("checked")) > 7),
                 key=lambda l: (l in reports, reports.get(l, {}).get("checked", "")))
    checks = downloads = 0
    for lei in due:
        if out_of_time() or checks >= args.max_checks or downloads >= args.max_reports:
            break
        rep = reports.setdefault(lei, {})
        checks += 1
        try:
            r = fetch_json("https://filings.xbrl.org/api/entities/%s/filings?sort=-period_end&page%%5Bsize%%5D=6" % lei)
        except Exception as e:
            print("  %s: kunde inte hämta rapportlistan (%s)" % (lei, e))
            continue
        rep["checked"] = TODAY.isoformat()
        files = [f["attributes"] for f in (r or {}).get("data", []) if f["attributes"].get("json_url")]
        if not files:
            continue
        newest_end = files[0]["period_end"]
        same = [f for f in files if f["period_end"] == newest_end]
        # Svensk version om det finns, annars den första
        f = next((x for x in same if re.search(r"[-_]sv\.json$", x["json_url"])), same[0])
        if rep.get("file") == f["json_url"] and rep.get("v") == PARSER_VERSION and not args.reparse:
            continue
        raw_path = os.path.join(args.raw_cache, lei + "-" + newest_end + ".slim.json") if args.raw_cache else None
        slim = None
        if raw_path and os.path.exists(raw_path):
            slim = json.load(open(raw_path, encoding="utf-8"))
        else:
            if args.reparse and args.raw_cache:
                continue
            try:
                body = fetch("https://filings.xbrl.org" + f["json_url"], timeout=180)
            except Exception as e:
                print("  %s: kunde inte hämta rapporten (%s)" % (lei, e))
                continue
            downloads += 1
            if not body:
                continue
            try:
                slim = slim_report(json.loads(body))
            except ValueError:
                print("  %s: rapporten gick inte att läsa" % lei)
                continue
            if raw_path:
                os.makedirs(args.raw_cache, exist_ok=True)
                json.dump(slim, open(raw_path, "w", encoding="utf-8"), ensure_ascii=False)
        try:
            res = read_report(slim, newest_end)
        except Exception as e:
            print("  %s: fel vid tolkning (%s)" % (lei, e))
            continue
        res["url"] = "https://filings.xbrl.org" + f["viewer_url"] if f.get("viewer_url") else None
        rep.update({"file": f["json_url"], "v": PARSER_VERSION, "data": res})
        time.sleep(0.3)
    print("  Rapporter: %d kontrollerade, %d nedladdade, %d bolag med rapport" % (checks, downloads, sum(1 for l in leis if reports.get(l, {}).get("data"))))

    # 3. Wikidata och Wikipedia (en gång i månaden per bolag)
    if not out_of_time():
        missing_ids = [i for i in stocks if "wd" not in st.get(i, {}) or (st[i]["wd"] is None and days_since(st[i].get("wdChecked")) > 30)]
        if missing_ids:
            ids = wikidata_ids(missing_ids, [st.get(i, {}).get("lei") for i in missing_ids])
            for i in missing_ids:
                s = st.setdefault(i, {})
                s["wd"] = ids.get(i) or ids.get(s.get("lei") or "-")
                s["wdChecked"] = TODAY.isoformat()
        # Många bolag finns på Wikidata utan ISIN och LEI (Epiroc, AAK, Bilia): sök på namnet i stället
        by_name = [i for i in stocks if not st.get(i, {}).get("wd") and days_since(st[i].get("wdNameChecked")) > 30]
        found_names = 0
        for i in by_name:
            if out_of_time():
                break
            try:
                st[i]["wd"] = wikidata_by_name(stocks[i])
            except Exception:
                continue
            st[i]["wdNameChecked"] = TODAY.isoformat()
            found_names += 1 if st[i]["wd"] else 0
        if by_name:
            print("  Wikidata: %d av %d hittade på namnet" % (found_names, len(by_name)))
        qids = sorted({st[i]["wd"] for i in stocks if st.get(i, {}).get("wd")})
        due_q = [q for q in qids if days_since(wiki.get(q, {}).get("checked")) > 30][:400]
        if due_q:
            ents = wd_entities(due_q)
            refs = set()
            for e in ents.values():
                for prop in ("P112", "P159", "P169", "P488", "P1056", "P1716", "P452", "P127"):
                    for _, _, v in claim_values(e, prop):
                        if isinstance(v, dict) and v.get("id"):
                            refs.add(v["id"])
            labels = {q: label(e) for q, e in wd_entities(sorted(refs), props="labels").items()} if refs else {}
            for q in due_q:
                e = ents.get(q)
                if not e or out_of_time():
                    continue
                facts = wiki_facts(e, labels)
                summary = None
                if facts.get("svwiki"):
                    try:
                        summary = wiki_summary(facts["svwiki"])
                    except Exception:
                        summary = None
                    time.sleep(0.2)
                wiki[q] = {"checked": TODAY.isoformat(), "facts": facts, "summary": summary}
        print("  Wikidata: %d bolag, %d med beskrivning från Wikipedia" % (len(qids), sum(1 for q in qids if (wiki.get(q) or {}).get("summary"))))

    # 4. En fil per aktie, plus placering bland alla bolag (störst försäljning, flest anställda, äldst)
    merged = {}
    for isin in stocks:
        s = st.get(isin, {})
        rep = reports.get(s.get("lei") or "-", {}).get("data")
        w = wiki.get(s.get("wd") or "-") or {}
        if not rep and not w.get("facts") and not w.get("summary"):
            continue
        merged[isin] = {"lei": s.get("lei"), "report": rep, "facts": w.get("facts") or {}, "wiki": w.get("summary")}

    by_company = {}
    for isin, m in merged.items():
        by_company.setdefault(m["lei"] or isin, m)
    def rank(getter):
        vals = sorted(((getter(m), k) for k, m in by_company.items() if getter(m) is not None), reverse=True)
        return {k: [n + 1, len(vals)] for n, (_, k) in enumerate(vals)}
    rev_rank = rank(lambda m: m["report"]["fin"]["rev"][0] if m["report"] and m["report"]["cur"] == "SEK" and m["report"]["fin"].get("rev", [None])[0] else None)
    emp_rank = rank(lambda m: m["facts"].get("employees", [None])[0])
    age_rank = rank(lambda m: -m["facts"]["founded"] if m["facts"].get("founded") else None)

    written = set()
    for isin, m in merged.items():
        key = m["lei"] or isin
        doc = {"built": TODAY.isoformat()}
        if m["report"]:
            doc["report"] = m["report"]
        f = dict(m["facts"])
        f.pop("svwiki", None)
        f.pop("industry", None)  # Wikidatas branschord är ofta för snäva ("järnframställning" för Sandvik)
        # Står grundåret i Wikipedias text gäller det: Wikidata har ibland året då aktiebolaget bildades (Sandvik 1897
        # i stället för 1862) eller ett år från ett annat bolag (Desenio 1905 i stället för 2008)
        if m["wiki"]:
            ys = [int(y) for y in re.findall(r"(?:grundades|grundat|grundlades|startades|bildades)\D{0,40}?\b(1[5-9]\d\d|20[0-2]\d)\b", m["wiki"]["text"])]
            if ys:
                f["founded"] = min(ys)
        # "Göteborgs kommun" blir "Göteborg", "Borås kommun" blir "Borås"
        if f.get("hq"):
            hq = re.sub(r"\s+(kommun|stad)$", "", f["hq"])
            if hq != f["hq"] and re.search(r"[^aeiouyåäöAEIOUYÅÄÖs]s$", hq):
                hq = hq[:-1]
            f["hq"] = hq
        if f:
            doc["facts"] = f
        if m["wiki"]:
            doc["wiki"] = m["wiki"]
        rk = {k: v[key] for k, v in (("rev", rev_rank), ("emp", emp_rank), ("age", age_rank)) if key in v}
        if rk:
            doc["rank"] = rk
        path = os.path.join(out_dir, isin + ".json")
        text = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
        old = open(path, encoding="utf-8").read() if os.path.exists(path) else None
        # Datumet ändras inte om innehållet är detsamma, så att filen inte sparas om i onödan
        if old:
            try:
                o = json.loads(old)
                o["built"] = doc["built"]
                if json.dumps(o, ensure_ascii=False, separators=(",", ":")) == text:
                    written.add(isin)
                    continue
            except ValueError:
                pass
        open(path, "w", encoding="utf-8").write(text)
        written.add(isin)
    if not args.only:
        for name in os.listdir(out_dir):
            if name.endswith(".json") and not name.startswith("_") and name[:-5] not in written:
                os.remove(os.path.join(out_dir, name))
    # Vilka aktier som har en fil, så att sajten inte frågar efter filer som inte finns
    have = sorted(n[:-5] for n in os.listdir(out_dir) if n.endswith(".json") and not n.startswith("_"))
    json.dump({"built": TODAY.isoformat(), "isins": have}, open(os.path.join(out_dir, "_index.json"), "w", encoding="utf-8"), separators=(",", ":"))
    json.dump(state, open(state_file, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    with_seg = sum(1 for m in by_company.values() if m["report"] and m["report"].get("seg"))
    with_geo = sum(1 for m in by_company.values() if m["report"] and m["report"].get("geo"))
    print("  Klart: %d aktier har bolagsfakta, %d bolag med affärsområden, %d med länder (%.0f s)" % (len(written), with_seg, with_geo, time.time() - started))


if __name__ == "__main__":
    sys.exit(main())
