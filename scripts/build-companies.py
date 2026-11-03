#!/usr/bin/env python3
"""
Bygger data/bolag/<ISIN>.json: en lättläst bild av varje svenskt bolag som fonderna äger ("Känn bolaget" på aktiesidan).

Bara bolagens egna rapporter och pressmeddelanden, utan nycklar:
  - Årsredovisningen i ESEF-format (maskinläsbar, obligatorisk för bolag på reglerad marknad), via filings.xbrl.org.
    Därifrån kommer helårets omsättning, resultat, utdelning, anställda, affärsområden (segmentsnoten) och
    försäljning per land. ISIN kopplas till bolagets LEI-kod via GLEIF. De tre äldre årsredovisningarna ger fem år av
    resultat, kassaflöde (löpande verksamhet, investeringar, utbetald utdelning) och balansräkning (lån, kassa, eget kapital).
  - Kvartalsrapporterna på MFN (mfn.se): resultaträkningen läses ur rapportens PDF (omsättning, rörelseresultat,
    resultat och resultat per aktie för senaste kvartalet och samma kvartal året innan), pressmeddelandet ger vd:ns
    namn och kommentar och bolagets egen beskrivning ("Om oss"). MFN:s kalender ger nästa rapport, årsstämman och
    utdelningarna, och bolagssidan grundår och huvudkontor.
  - Investmentbolagens substansvärde per aktie och fastighetsbolagens EPRA NRV och belåningsgrad, ur samma
    kvartalsrapporter. Substansrabatten räknas mot kursen vid kvartalsslut (fondernas rapporter till FI) för den
    rapport som gäller samma dag, eller tas ur rapporten om bolaget själv anger den.
  - Branschens viktigaste nyckeltal ur samma rapporter: räntenetto och kreditförluster för banker, uthyrningsgrad,
    snittränta och räntetäckningsgrad för fastighetsbolag, produktion, leveranser och metallpriser för gruv- och
    skogsbolag, kassan för läkemedelsbolag, bruttomarginal och skuldsättning för övriga. Ett värde sparas bara om
    det står likadant i rapportens nyckeltalstabell och i texten (eller, för produktion, i nästa rapport).

Tabellerna ser olika ut hos olika bolag, så allt kontrolleras innan det används. Affärsområden och länder måste
gå ihop med bolagets totala omsättning (inom 10 %). Kvartalets siffror måste gå att hitta i pressmeddelandet
(eller omsättningen stämma ungefär med årsredovisningen). Hellre ingen uppgift än en felaktig.

Allt hämtas om bara när det behövs, och bara så mycket som hinns med per körning:
  - LEI-koden och bolaget på MFN en gång (saknas de, en gång i månaden),
  - nya årsredovisningar en gång i veckan per bolag, och bara nya rapporter laddas ner och läses,
  - bolagets sida på MFN när kalendern säger att en rapport har kommit eller MFN listar en ny rapport,
    annars en gång i månaden. Bara nya kvartalsrapporter laddas ner.
Läget sparas i data/bolag-state.json i repot (utanför site/, så att det inte publiceras).

Kräver pypdfium2 för att läsa PDF:erna (pip install pypdfium2). Utan den hämtas allt utom kvartalssiffrorna.

  python3 scripts/build-companies.py
  py scripts/build-companies.py --raw-cache .cache/bolag --only SE0000667891    (lokalt, sparar nedladdade rapporter)
"""
import argparse
import datetime as dt
import gzip
import hashlib
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

try:
    import pypdfium2 as pdfium
    import pypdfium2.raw as pdfraw
except ImportError:
    pdfium = pdfraw = None

# Höjs när tolkningen av rapporterna ändras, så att alla rapporter läses om
PARSER_VERSION = 7
INTERIM_VERSION = 5  # samma sak för kvartalsrapporterna
NAV_VERSION = 1      # substansvärdet i investment- och fastighetsbolagens rapporter (läses om utan att resten läses om)
NAV_INDUSTRIES = {"Investeringar", "Förvaltning"}  # MFN:s branscher för investmentbolag och fastighetsbolag
KPI_VERSION = 1     # branschens nyckeltal (läses om utan att resten läses om)
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

# Kassaflöde och balansräkning år för år. Samma sak kan ha flera taggar: den första som finns används.
CAPEX_PPE = ["ifrs-full:PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities", "ifrs-full:PurchaseOfPropertyPlantAndEquipment"]
CAPEX_ALL = ["ifrs-full:PurchaseOfPropertyPlantAndEquipmentIntangibleAssetsOtherThanGoodwillInvestmentPropertyAndOtherNoncurrentAssets"]
CAPEX_INT = ["ifrs-full:PurchaseOfIntangibleAssetsClassifiedAsInvestingActivities"]
# bolagets egen tagg för investeringar i materiella anläggningstillgångar (Volvo), när standardtaggen saknas
CUSTOM_CAPEX = re.compile(r":(InvesteringarIMateriellaAnlaggningstillgangar|InvestmentsInPropertyPlantAndEquipment|PurchaseOfTangibleAssets|"
                          r"AcquisitionOfPropertyPlantAndEquipment)$", re.I)
DIV_PAID = ["ifrs-full:DividendsPaidToEquityHoldersOfParentClassifiedAsFinancingActivities", "ifrs-full:DividendsPaidClassifiedAsFinancingActivities",
            "ifrs-full:DividendsPaid"]
BORROW_LONG = ["ifrs-full:NoncurrentPortionOfNoncurrentBorrowings", "ifrs-full:LongtermBorrowings", "ifrs-full:NoncurrentPortionOfNoncurrentLoansReceived"]
BORROW_SHORT = ["ifrs-full:CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings", "ifrs-full:CurrentLoansReceivedAndCurrentPortionOfNoncurrentLoansReceived"]
# Många bolag (Atlas Copco, Essity, Hexagon) märker raden för lån i balansräkningen som finansiella skulder
BORROW_LONG_FIN = ["ifrs-full:NoncurrentFinancialLiabilities", "ifrs-full:OtherNoncurrentFinancialLiabilities"]
BORROW_SHORT_FIN = ["ifrs-full:CurrentFinancialLiabilities", "ifrs-full:OtherCurrentFinancialLiabilities"]
BORROW_SHORT_PARTS = ["ifrs-full:ShorttermBorrowings", "ifrs-full:CurrentPortionOfLongtermBorrowings"]
LEASE_PARTS = ["ifrs-full:NoncurrentLeaseLiabilities", "ifrs-full:CurrentLeaseLiabilities"]
HIST_KEYS = ["rev", "ebit", "net", "netOwn", "ocf", "capex", "div", "equity", "eqOwn", "assets", "debt", "cash"]
OLD_REPORTS = 3  # så många äldre årsredovisningar läses per bolag (ger fem år)


def year_rows(raw, fin, fy):
    """Ett år per kolumn i rapporten (året och året innan): resultat, kassaflöde och balansräkning.
    Belopp som inte är rimliga i förhållande till bolagets tillgångar och försäljning tas bort."""
    def first(names, w):
        for n in names:
            if (n, w) in raw:
                return raw[(n, w)]
        return None

    def parts(names, w):
        vals = [first([n], w) for n in names]
        return sum(v or 0 for v in vals) if any(v is not None for v in vals) else None

    out = {}
    for w, year in ((0, fy), (1, fy - 1)):
        row = {k: fin[k][w] for k in ("rev", "ebit", "net", "ocf", "equity", "assets") if fin.get(k) and fin[k][w] is not None}
        row["netOwn"] = first(["ifrs-full:ProfitLossAttributableToOwnersOfParent"], w)
        row["eqOwn"] = first(["ifrs-full:EquityAttributableToOwnersOfParent"], w)
        row["cash"] = first(["ifrs-full:CashAndCashEquivalents"], w)
        # Investeringar (capex): materiella anläggningstillgångar plus immateriella (t.ex. utveckling), som utbetalningar
        capex = first(CAPEX_PPE, w)
        if capex is None:
            capex = first(CAPEX_ALL, w)
            intang = None if capex is not None else first(CAPEX_INT, w)
        else:
            intang = first(CAPEX_INT, w)
        if capex is None:
            capex = raw.get(("custom-capex", w))
        if capex is not None:
            capex = abs(capex) + abs(intang or 0)
        row["capex"] = capex
        div = first(DIV_PAID, w)
        row["div"] = abs(div) if div is not None else None
        # Räntebärande skulder: lån och leasingskulder. Bara när lånen är märkta, annars går det inte att veta vad som saknas.
        long_, short = first(BORROW_LONG, w), first(BORROW_SHORT, w)
        if short is None:
            short = parts(BORROW_SHORT_PARTS, w)
        if long_ is None and short is None:
            long_ = first(["ifrs-full:Borrowings"], w)
        if long_ is None and short is None:
            long_, short = first(BORROW_LONG_FIN, w), first(BORROW_SHORT_FIN, w)
        if long_ is not None or short is not None:
            lease = first(["ifrs-full:LeaseLiabilities"], w)
            row["debt"] = (long_ or 0) + (short or 0) + (lease if lease is not None else parts(LEASE_PARTS, w) or 0)
        # Rimlighet
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
        if row.get("eqOwn") is not None and eq is not None and abs(row["eqOwn"]) > abs(eq) * 1.5 + 1:
            row["eqOwn"] = None
        row = {k: v for k, v in row.items() if v is not None}
        if len(row) >= 2:
            out[str(year)] = row
    return out


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
    raw = {}  # alla taggar för året (0) och året innan (1), till kassaflödet och balansräkningen
    currency = None
    for c, period, unit, v in slim["nums"]:
        try:
            x = float(v)
        except (TypeError, ValueError):
            continue
        if unit.startswith("iso4217:"):
            de = duration_end(period)
            inst = period[:10] if "/" not in period else None
            w = 0 if after_end in (de, inst) else 1 if prev_end and prev_end in (de, inst) else None
            if w is not None:
                raw.setdefault((c, w), x)
                if not c.startswith("ifrs-full:") and CUSTOM_CAPEX.search(c):
                    raw.setdefault(("custom-capex", w), x)
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
    hist = year_rows(raw, fin, fy)
    # Bolag som lånar ut till sina kunder (Volvos finansieringsverksamhet): koncernens kassaflöde binds när utlåningen växer
    lease_rec = sum(raw.get((c, 0)) or 0 for c in ("ifrs-full:NoncurrentFinanceLeaseReceivables", "ifrs-full:CurrentFinanceLeaseReceivables"))
    assets_now = (fin.get("assets") or [None])[0]
    cust_fin = round(lease_rec / assets_now, 2) if assets_now and lease_rec / assets_now >= 0.15 else None
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
            "geo": [[n, round(v)] for n, v in geo] if geo else None, "about": about, "hist": hist, "custFin": cust_fin}


def history(rep):
    """Åren ur den senaste årsredovisningen och de äldre, som kolumner {"fy": [...], "rev": [...], ...}.
    Ett äldre år tas bara med om året som finns i båda rapporterna stämmer (samma valuta, försäljning och eget kapital
    inom 10 %). Annars har bolaget räknat om siffrorna eller bytt räkenskapsår, och de äldre åren jämförs inte."""
    data = rep.get("data") or {}
    years = {int(y): r for y, r in (data.get("hist") or {}).items()}
    if not years:
        return None

    def close(a, b):
        return a is None or b is None or (a == b == 0) or (a * b > 0 and 0.9 <= a / b <= 1.1)

    for end in sorted(rep.get("old") or {}, reverse=True):
        o = rep["old"][end]
        h = {int(y): r for y, r in (o.get("hist") or {}).items()}
        both = [y for y in h if y in years]
        if o.get("cur") != data.get("cur") or not both:
            break
        y = max(both)
        a, b = years[y], h[y]
        if not all(close(a.get(k), b.get(k)) for k in ("rev", "equity", "assets")) or not any(k in a and k in b for k in ("rev", "equity")):
            break
        for y, r in h.items():
            years.setdefault(y, r)
    fys = sorted(years)
    # bara en obruten följd av år, räknat bakifrån
    while len(fys) >= 2 and fys[-1] - fys[0] != len(fys) - 1:
        fys = fys[1:]
    out = {"fy": fys}
    for k in HIST_KEYS:
        vals = [years[y].get(k) for y in fys]
        if any(v is not None for v in vals):
            out[k] = [round(v) if v is not None and abs(v) >= 1000 else v for v in vals]
    return out


# ---------- Kvartalsrapporten (PDF) ----------
# Resultaträkningen läses tecken för tecken med positioner: tal som står på samma höjd som en rad hör till raden, och
# kolumnrubrikerna ovanför ("Jul–sep 2026", "Kv 3 2025") avgör vilken kolumn som är det senaste kvartalet.

def pdf_lines(tp):
    """Rader med celler [(x0, x1, text)]. Ett mellanrum större än ungefär en halv teckenhöjd delar cellen
    (kolumngräns), mindre mellanrum (tusentalsavgränsare, ordmellanrum) gör det inte."""
    chars = []
    for i in range(tp.count_chars()):
        u = pdfraw.FPDFText_GetUnicode(tp.raw, i)
        if u in (0, 2, 10, 13, 32, 0xA0, 0x202F, 0x2009, 0xFFFE, 0xFEFF):
            continue
        ch = chr(u)
        if not ch.strip():
            continue
        l, b, r, t = tp.get_charbox(i, loose=True)
        if t - b <= 0.1:
            continue
        chars.append(((b + t) / 2, l, r, t - b, ch))
    lines = []
    for c in sorted(chars, key=lambda c: -c[0]):
        if lines and abs(lines[-1][0] - c[0]) < min(c[3], lines[-1][2]) * 0.35:
            lines[-1][1].append(c)
        else:
            lines.append([c[0], [c], c[3]])
    out = []
    for y, cs, h in lines:
        cs.sort(key=lambda c: c[1])
        cells = []
        for yc, l, r, hh, ch in cs:
            if cells:
                gap = l - cells[-1][1]
                if gap < -hh * 0.3 and abs(l - cells[-1][3]) < 0.5:
                    continue  # samma tecken två gånger (fetstil ritad dubbelt)
                if gap <= max(hh * 0.5, 2.2):
                    cells[-1][2] += (" " if gap > hh * 0.12 else "") + ch
                    cells[-1][1] = max(cells[-1][1], r)
                    cells[-1][3] = l
                    continue
            cells.append([l, r, ch, l])
        out.append((y, [(c[0], c[1], c[2]) for c in cells]))
    return out


NUM_CELL = re.compile(r"^\(?[-−–]?\s?\d{1,3}(?:[ ,.]\d{3})*(?:[.,]\d+)?\)?\s?%?$|^\(?[-−–]?\s?\d+(?:[.,]\d+)?\)?\s?%?$")
DASH = {"-", "–", "—", "−", "neg", "n/a", "n.a.", "nm", "n.m.", "neg.", ">100", ">100%", ">200"}


def pdf_number(s, dec):
    s = s.strip().replace("−", "-").replace("–", "-")
    neg = s.startswith("(") and s.endswith(")")
    s = s.strip("()").strip()
    if s.startswith("-"):
        neg = True
        s = s[1:].strip()
    if dec == ",":
        if not re.fullmatch(r"\d{1,3}([ .]\d{3})+(,\d+)?|\d+(,\d+)?", s):
            return None
        s = s.replace(" ", "").replace(".", "").replace(",", ".")
    else:
        if not re.fullmatch(r"\d{1,3}([ ,]\d{3})+(\.\d+)?|\d+(\.\d+)?", s):
            return None
        s = s.replace(" ", "").replace(",", "")
    v = float(s)
    return -v if neg else v


def decimal_sep(text):
    """Svenska rapporter skriver "1 234,5", engelska "1,234.5"."""
    sv = len(re.findall(r"(?<![\d,.])\d{1,3}(?: \d{3})+(?![\d,.])", text)) + len(re.findall(r"(?<![\d,.])\d+,\d{1,2}(?![\d,.])", text))
    en = len(re.findall(r"(?<![\d,.])\d{1,3}(?:,\d{3})+(?![\d,.])", text)) + len(re.findall(r"(?<![\d,.])\d+\.\d{1,2}(?![\d,.])", text))
    return "," if sv >= en else "."


def split_row(cells, dec):
    """(etikett, [(xmitt, värde eller None, text, procent)])"""
    label, vals = [], []
    for x0, x1, s in cells:
        st = s.strip()
        if not vals and not NUM_CELL.match(st) and st.lower() not in DASH:
            # siffror som hamnat i samma cell som etiketten ("Intäkter 29 218"): dela vid talet
            m = re.match(r"^(.*?[A-Za-zÅÄÖåäöé\)\.:])\s+(\(?[-−–]?\d[\d ,.]*\)?)$", st)
            if m and pdf_number(m.group(2), dec) is not None and len(m.group(1)) > 2:
                w = (x1 - x0) / max(len(st), 1)
                label.append(m.group(1))
                xs = x0 + w * (len(st) - len(m.group(2)))
                vals.append(((xs + x1) / 2, pdf_number(m.group(2), dec), m.group(2), False))
                continue
            label.append(st)
            continue
        if st.lower() in DASH:
            vals.append(((x0 + x1) / 2, None, st, False))
            continue
        v = pdf_number(st.rstrip("%").strip(), dec)
        if v is None:
            if vals:
                if re.search(r"[A-Za-zÅÄÖåäö]{3}", st):
                    break  # en ny etikett efter talen: nästa tabell på samma rad
                continue
            label.append(st)
            continue
        vals.append(((x0 + x1) / 2, v, st, st.endswith("%")))
    return re.sub(r"\s+", " ", " ".join(label)).strip(), vals


Q_ROWS = {
    "rev": re.compile(r"^(summa |totala? |total )?(nettoomsättning(en)?|net ?sales|revenues?|net revenues?|intäkter|rörelsens intäkter|totala intäkter|"
                      r"rörelseintäkter|omsättning|försäljningsintäkter|sales)( och övriga rörelseintäkter| m ?m| totalt| total)?$", re.I),
    "ebit": re.compile(r"^(rörelseresultat(et)?|operating (profit|income|result|earnings)|ebit|rörelseresultat \(ebit\)|ebit \(rörelseresultat\)|"
                       r"resultat före finansiella poster( och (inkomst)?skatt(er)?)?( \(ebit\))?|rörelseresultat,? \(?ebit\)?|operating profit/loss|"
                       r"rörelseresultat/ebit|resultat före räntor och skatt(er)?( \(ebit\))?)$", re.I),
    "net": re.compile(r"^(periodens (net(to)?)?resultat|periodens vinst|periodens resultat efter skatt|resultat efter skatt|nettoresultat|årets resultat|"
                      r"profit for the (period|year)|net (profit|income|result)( for the period)?|income for the period|result for the period|"
                      r"profit/loss for the period|periodens vinst/förlust)$", re.I),
    "eps": re.compile(r"^(resultat per aktie|earnings per share|vinst per aktie|basic earnings per share)(,? (före|före och efter|efter) utspädning)?"
                      r"(,? (kr|kronor|sek|eur))?( \((kr|kronor|sek|eur)\))?$", re.I),
}
STATEMENT_HEAD = re.compile(r"(koncernens resultaträkning|resultaträkning|income statement|statement of (comprehensive )?income|"
                            r"rapport över (koncernens )?(total)?resultat|statement of profit or loss|resultatrapport)", re.I)
UNIT_HDR = [
    (re.compile(r"\b(msek|mkr|sek ?m|sekm|mnkr|mn ?sek|sek ?million|mln ?sek|miljoner kronor|sek mn|sek miljoner|miljoner sek)\b", re.I), 1e6, "SEK"),
    (re.compile(r"\b(tsek|ksek|tkr|kkr|sek ?thousands?|sek ?000|sek ?k|tusen kronor|tusentals kronor|kr ?000)\b", re.I), 1e3, "SEK"),
    (re.compile(r"\b(mdkr|sek ?bn|sek ?billion|mdsek|sek miljarder|miljarder kronor|mdr kr|mdr sek)\b", re.I), 1e9, "SEK"),
    (re.compile(r"\b(meur|eur ?m|eurm|eur ?million|mn ?eur|eur ?mn|m ?eur)\b", re.I), 1e6, "EUR"),
    (re.compile(r"\b(teur|keur|eur ?thousands?|eur ?000|eur ?k)\b", re.I), 1e3, "EUR"),
    (re.compile(r"\b(musd|usd ?m|usdm|usd ?million|usd ?mn)\b", re.I), 1e6, "USD"),
    (re.compile(r"\b(tusd|kusd|usd ?thousands?)\b", re.I), 1e3, "USD"),
    (re.compile(r"\b(mnok|nok ?m|nok ?million)\b", re.I), 1e6, "NOK"),
    (re.compile(r"\b(tnok|knok|nok ?thousands?)\b", re.I), 1e3, "NOK"),
    (re.compile(r"\b(mdkk|dkk ?m|dkk ?million)\b", re.I), 1e6, "DKK"),
]
MONTH_NO = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "maj": 5, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "okt": 10, "oct": 10, "nov": 11, "dec": 12}
MONTH_RANGE = re.compile(r"\b(jan|feb|mar|apr|maj|may|jun|jul|aug|sep|okt|oct|nov|dec)[a-zé]*\.?\s*[-–—]\s*(?:\d{1,2}\s)?"
                         r"(jan|feb|mar|apr|maj|may|jun|jul|aug|sep|okt|oct|nov|dec)", re.I)


def classify_header(t):
    """Kolumnrubrik -> (typ, antal månader, år, kvartal) där typ är "pct", "note" eller "per" (en period)."""
    tl = t.lower()
    if re.search(r"%|förändr|change|\bδ|diff\b|utveckling", tl):
        return ("pct", None, None, None)
    if re.fullmatch(r"\s*(not|note|noter|notes)\s*", tl):
        return ("note", None, None, None)
    years = [int(y) for y in re.findall(r"(?<!\d)(20\d\d)(?:/\d\d)?(?!\d)", tl)]
    if not years:
        # tvåsiffrigt år efter kvartal eller månader: "Q3 26", "jan-sep 26"
        years = [2000 + int(y) for y in re.findall(r"(?:\bq[1-4]|kv\.? ?[1-4]|[a-zé]{3})\.?\s(\d\d)(?![\d-])", tl) if 15 <= int(y) <= 40]
    months = None
    q = re.search(r"\b(?:q|kv\.?|kvartal)\s?([1-4])\b|\b([1-4])\s?(?:kv|q)\b|\b20\d\d:([1-4])\b", tl)
    qnum = int(next(g for g in q.groups() if g)) if q else None
    d = re.findall(r"(?<!\d)(20)?(\d\d)-(\d\d)-\d\d(?!\d)", tl)
    if len(d) >= 2:
        (c1, y1, m1), (c2, y2, m2) = d[0], d[1]
        months = (int(y2) * 12 + int(m2)) - (int(y1) * 12 + int(m1)) + 1
        return ("per", months if 1 <= months <= 12 else None, 2000 + int(y2), qnum)
    m = MONTH_RANGE.search(tl)
    qq = re.search(r"\b(?:kvartal|kv\.?|q)\s?([1-4])\s?[-–]\s?(?:kvartal|kv\.?|q)?\s?([1-4])\b", tl)
    if qq:
        months = (int(qq.group(2)) - int(qq.group(1)) + 1) * 3
        qnum = None
    elif m:
        months = (MONTH_NO[m.group(2)] - MONTH_NO[m.group(1)]) % 12 + 1
    elif re.search(r"\b(q|kv|kv\.|kvartal)\s?[1-4]\b|\b[1-4]\s?(kv|q)\b|kvartal(et)?\b|quarter|\b3 ?(mån|months)|tre ?mån|\b20\d\d:[1-4]\b", tl):
        months = 3
    elif re.search(r"\b6 ?(mån|months)|sex ?mån|halvår|six months|half[- ]year|\bh[12]\b", tl):
        months = 6
    elif re.search(r"\b9 ?(mån|months)|nio ?mån|nine months", tl):
        months = 9
    elif re.search(r"helår|full[- ]year|\b12 (mån|months)|rullande|rolling|ltm|r12|räkenskapsår", tl):
        months = 12
    return ("per", months, max(years) if years else None, qnum)


def clean_row_label(lab):
    lab = re.sub(r"\s*[\*¹²³⁴⁵]+$|\s*\(?(not|note)\s*\d+\)?", "", lab, flags=re.I)
    lab = re.sub(r"\s+\d{1,2}(\)|(,\s?\d{1,2})*)$", "", lab)
    lab = re.sub(r"\s*,?\s*\(?(mkr|msek|sek ?m|tkr|ksek|tsek)\)?$", "", lab, flags=re.I)
    return lab.strip(" :*,")


def statement_rows(lines, dec):
    rows = {}
    for idx, (y, cells) in enumerate(lines):
        lab, vals = split_row(cells, dec)
        lab = clean_row_label(lab)
        if len(vals) < 2 or not any(v[1] is not None for v in vals):
            continue
        for k, rx in Q_ROWS.items():
            if k not in rows and rx.match(lab):
                rows[k] = (lab, vals, idx)
    return rows


def header_columns(lines, top, xs, table_left, label_right):
    """Rubriker ovanför tabellen, per kolumn (x-mitt). Bara korta rader direkt ovanför räknas: brödtext och
    tabellrubriker stoppar. Varje rubrikcell hör till de kolumner som ligger närmast den, så att en grupprubrik
    ("Q3" över två kolumner) hamnar på båda."""
    heads = {x: [] for x in xs}
    left = (label_right + 4) if label_right else min(xs) - 20
    right = max(xs) + 30
    spacing = (max(xs) - min(xs)) / max(len(xs) - 1, 1) if len(xs) > 1 else 50

    def near(x0, x1):
        return min(abs((x0 + x1) / 2 - x) for x in xs) <= (x1 - x0) / 2 + 45

    taken = []
    for y, cells in reversed(lines[max(0, top - 6):top]):
        # inte en annan tabell bredvid (balansräkningen, totalresultatet)
        cells = [c for c in cells if table_left - 15 <= c[0] <= right]
        vcells, straddle = [], False
        for x0, x1, s in cells:
            if x1 <= left:
                continue
            if x0 < left:
                # cellen börjar i etikettkolumnen ("Rapport över totalresultat 2026-04-01 - 2026-06-30"): bara delen till höger
                cut = int(len(s) * (left - x0) / max(x1 - x0, 1))
                rest = s[cut:]
                rest = rest[rest.find(" ") + 1:] if " " in rest and cut else rest
                if not re.search(r"\d", rest):
                    continue  # en etikett som råkar sticka ut ("Resultaträkningar, msek")
                x0, s, straddle = left, rest.strip(), True
            if re.fullmatch(r"\(?(msek|mkr|tkr|tsek|ksek|sek ?m|meur|teur|keur|eur ?m|not|note|noter)\)?", s, re.I):
                continue
            if s:
                vcells.append((x0, x1, s))
        if any(x1 - x0 > 1.6 * spacing and not re.search(r"\d|jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec|kvartal|quarter|mån|month|helår|year|halvår", s, re.I)
               for x0, x1, s in vcells):
            break  # en tabellrubrik ovanför kolumnerna ("Koncernens rapport över totalresultat")
        if not vcells:
            label = " ".join(s for _, _, s in cells)
            if cells and (re.search(r"koncern|rapport|sammandrag|räkning|finansiell|statement|consolidated|summary", label, re.I)
                          or (label.isupper() and len(label) > 14)):
                break  # tabellens rubrik ("Koncernen i sammandrag"): ovanför den är det något annat
            continue  # en mellanrubrik i tabellen ("Rörelsens intäkter")
        if any(len(s) > 30 for _, _, s in vcells) or not all(near(x0, x1) for x0, x1, _ in vcells):
            break  # brödtext eller något som inte står ovanför kolumnerna
        if straddle and len(vcells) == 1:
            break
        taken.append(vcells)
    for cells in reversed(taken):
        mids = [((x0 + x1) / 2, (x1 - x0) / 2, s) for x0, x1, s in cells]
        for x in xs:
            best = min(mids, key=lambda m: abs(m[0] - x))
            if abs(best[0] - x) <= best[1] + 45:
                heads[x].append(best[2])
    return {x: " ".join(v) for x, v in heads.items()}


def pick_columns(rows, lines):
    """Kolumnen för den senaste perioden (det kortaste perioden, senaste året) och samma period året innan."""
    first_idx = min(r[2] for r in rows.values())
    # tabellens kolumner är den första radens. Tal längre till höger hör till en annan tabell på samma rad.
    main = min(rows.values(), key=lambda r: r[2])
    lo, hi = min(v[0] for v in main[1]) - 30, max(v[0] for v in main[1]) + 30
    for k in list(rows):
        lab, vals, idx = rows[k]
        rows[k] = (lab, [v for v in vals if lo <= v[0] <= hi], idx)
        if not rows[k][1]:
            del rows[k]
    clusters = []
    for x in sorted({round(v[0]) for r in rows.values() for v in r[1]}):
        if clusters and x - clusters[-1][-1] <= 14:
            clusters[-1].append(x)
        else:
            clusters.append([x])
    centers = [sum(c) / len(c) for c in clusters]
    table_left = min(lines[r[2]][1][0][0] for r in rows.values())
    # etikettkolumnens högerkant: det som står till vänster om den i rubrikraderna är inte kolumnrubriker
    label_right = None
    for r in rows.values():
        first_val = min(v[0] for v in r[1])
        lab_cells = [c for c in lines[r[2]][1] if c[1] < first_val - 2]
        if lab_cells:
            label_right = max(label_right or 0, max(c[1] for c in lab_cells))
    if label_right and label_right > min(centers) - 8:
        label_right = None
    # tabellens översta rad: uppåt så länge raderna har tal i samma kolumner (eller är mellanrubriker)
    top = first_idx
    for i in range(first_idx - 1, max(-1, first_idx - 40), -1):
        cells = [c for c in lines[i][1] if table_left - 15 <= c[0] <= max(centers) + 30]
        nums = [c for c in cells if NUM_CELL.match(c[2].strip()) and any(abs((c[0] + c[1]) / 2 - x) <= 14 for x in centers)
                and not re.fullmatch(r"(19|20)\d\d", c[2].strip())]  # årtal är rubriker, inte värden
        labels_only = cells and all(c[1] <= (label_right or min(centers) - 20) + 4 for c in cells)
        if len(nums) >= 2:
            top = i
        elif labels_only and not re.search(r"koncern|rapport|sammandrag|räkning|finansiell|statement|consolidated", " ".join(c[2] for c in cells), re.I):
            continue
        else:
            break
    heads = header_columns(lines, top, centers, table_left, label_right)

    usable = []
    for c in centers:
        h = classify_header(heads[c])
        vs = [v for r in rows.values() for v in r[1] if abs(v[0] - c) <= 14]
        nums = [v[1] for v in vs if v[1] is not None]
        if h[0] != "per" or any(v[3] for v in vs):
            continue  # procent- och notkolumner
        if nums and all(0 < v <= 40 for v in nums) and (len(vs) < len(rows) or c == centers[0] and len(centers) > 2) \
                and (all(float(v).is_integer() for v in nums) or c == centers[0]):
            continue  # notkolumn utan rubrik ("2" eller "2,3" längst till vänster)
        usable.append((c, h, heads[c]))
    if len(usable) < 2:
        return None
    months = [h[1] for c, h, t in usable]
    years = [h[2] for c, h, t in usable]
    known = [m for m in months if m]
    short = min(known) if known else None
    cand = [i for i in range(len(usable)) if short is None or months[i] == short]
    loose = [i for i in range(len(usable)) if months[i] in (short, None)]
    cur = prev = None
    ys = [years[i] for i in cand if years[i]]
    if ys:
        ymax = max(ys)
        cur = next(i for i in cand if years[i] == ymax)
        qn = usable[cur][1][3]
        prev = next((i for i in cand if years[i] == ymax - 1 and (qn is None or usable[i][1][3] in (None, qn))), None)
        if prev is None:
            # en kolumn utan känd periodlängd: inte helåret ("Q1 2026, Q1 2025, Helår 2025" där "Q1" bara står en gång)
            def plausible(i):
                if "rev" not in rows:
                    return True
                a = next((v[1] for v in rows["rev"][1] if abs(v[0] - usable[cur][0]) <= 14), None)
                b = next((v[1] for v in rows["rev"][1] if abs(v[0] - usable[i][0]) <= 14), None)
                return not (a and b and a > 0 and b / a > 2.5)
            prev = next((i for i in loose if i > cur and years[i] == ymax - 1 and plausible(i)), None)
    if cur is None:
        cur = cand[0]
    if prev is None:
        rest = [i for i in cand if i > cur]
        prev = rest[0] if rest else None
    if prev is None:
        return None
    return {"cur": usable[cur][0], "prev": usable[prev][0], "months": months[cur], "head": usable[cur][2]}


def read_statement(pdf_bytes):
    """Resultaträkningen i en kvartalsrapport: {rad: (aktuell period, samma period året innan)}, enhet och rubrik."""
    pdf = pdfium.PdfDocument(pdf_bytes)
    best = None
    try:
        for pi in range(len(pdf)):
            tp = pdf[pi].get_textpage()
            txt = tp.get_text_range()
            if not re.search(r"nettoomsättning|net sales|intäkter|revenue|rörelseresultat|operating", txt, re.I):
                continue
            dec = decimal_sep(txt)
            lines = pdf_lines(tp)
            rows = statement_rows(lines, dec)
            if not rows:
                continue
            first = min(r[2] for r in rows.values())
            near = " ".join(c[2] for _, cells in lines[max(0, first - 8):first + 1] for c in cells)
            # Koncernens resultaträkning före nyckeltalstabeller, segmentstabeller och moderbolagets siffror
            score = len(rows) + (2 if STATEMENT_HEAD.search(txt) else 0) + (2 if STATEMENT_HEAD.search(near) else 0) + (1 if "eps" in rows and "net" in rows else 0)
            if re.search(r"segment|översikt|overview|per kvartal|by quarter|quarterly", near, re.I):
                score -= 4
            if re.search(r"moderbolag|parent company", near, re.I):
                score -= 8
            if best is None or score > best[0]:
                best = (score, rows, lines, near, txt)
    finally:
        pdf.close()
    if not best:
        return None
    _, rows, lines, near, txt = best
    cols = pick_columns(rows, lines)
    if not cols:
        return None

    def at(row, x):
        return next((v[1] for v in row[1] if abs(v[0] - x) <= 14), None)

    unit = None
    for text in (near, txt):
        unit = next(((sc, cur) for rx, sc, cur in UNIT_HDR if rx.search(text)), None)
        if unit:
            break
    return {"vals": {k: [at(r, cols["cur"]), at(r, cols["prev"])] for k, r in rows.items()},
            "all": {k: [v[1] for v in r[1] if v[1] is not None and not v[3]] for k, r in rows.items()},
            "months": cols["months"], "head": cols["head"], "unit": unit}


# ---------- Pressmeddelandet: belopp, vd, "om bolaget" ----------

TEXT_UNITS = [
    (r"miljarder kronor|mdkr|mdr kr|miljarder sek|sek miljarder|sek ?bn|sek billion|billion sek|mdsek|bnsek", 1e9, "SEK"),
    (r"miljoner kronor|mkr|msek|mnkr|mn kr|miljoner sek|sek ?m\b|sek ?million|sek ?mn|sekm|mln sek|sek mln", 1e6, "SEK"),
    (r"tusen kronor|tkr|tsek|ksek|kkr|sek ?thousand|sek ?k\b|tusen sek", 1e3, "SEK"),
    (r"miljarder euro|eur ?bn|eur billion", 1e9, "EUR"),
    (r"miljoner euro|meur|eur ?m\b|eur ?million|eur ?mn|mn eur|m eur|eurm|eur ?mln|euro million", 1e6, "EUR"),
    (r"tusen euro|teur|keur|eur thousand|eur ?k\b", 1e3, "EUR"),
    (r"miljoner dollar|musd|usd ?m\b|usd ?million|usd ?mn|usdm", 1e6, "USD"),
    (r"tusen dollar|tusd|kusd|usd thousand", 1e3, "USD"),
    (r"mnok|nok ?m\b|nok million|miljoner norska kronor", 1e6, "NOK"),
    (r"mdkk|dkk ?m\b|dkk million", 1e6, "DKK"),
    (r"miljarder(?![a-zåäö])|mdr(?![a-zåäö])", 1e9, "SEK"),
    (r"miljoner(?![a-zåäö])|mn(?![a-zåäö])|mln(?![a-zåäö])", 1e6, "SEK"),
    (r"kronor|sek", 1, "SEK"),
]
TEXT_UNIT_RE = "|".join("(?:%s)" % u for u, _, _ in TEXT_UNITS)
TEXT_NUM = re.compile(r"(?<![\w.,])[-−–]?\d{1,3}(?:[  .,]\d{3})*(?:[.,]\d+)?(?![\w])|(?<![\w.,])[-−–]?\d+(?:[.,]\d+)?(?![\w])")


def readings(s):
    """Möjliga tolkningar av ett tal i löptext, med halva avrundningssteget: "14.693" kan vara 14 693 eller 14,693."""
    s = s.replace("−", "-").replace("–", "-")
    neg = s.startswith("-")
    s = s.lstrip("-").replace(" ", " ")
    res = []
    if re.fullmatch(r"\d+", s):
        res.append((float(s), 0.5))
    if re.fullmatch(r"\d{1,3}( \d{3})+([.,]\d+)?", s):
        a = s.replace(" ", "")
        if "," in a or "." in a:
            ip, fp = re.split(r"[.,]", a)
            res.append((float(ip + "." + fp), 0.5 * 10 ** -len(fp)))
        else:
            res.append((float(a), 0.5))
    for sep, other in ((",", "."), (".", ",")):
        if re.fullmatch(r"\d+\%s\d+" % sep, s):
            ip, fp = s.split(sep)
            res.append((float(ip + "." + fp), 0.5 * 10 ** -len(fp)))
            if len(fp) == 3:
                res.append((float(ip + fp), 0.5))
        if re.fullmatch(r"\d{1,3}(\%s\d{3})+(\%s\d+)?" % (sep, other), s):
            a = s.replace(sep, "")
            if other in a:
                ip, fp = a.split(other)
                res.append((float(ip + "." + fp), 0.5 * 10 ** -len(fp)))
            else:
                res.append((float(a), 0.5))
    return [(-v if neg else v, h) for v, h in res]


def text_amounts(text):
    """Belopp med enhet i pressmeddelandet: [(belopp, halvt avrundningssteg, valuta, texten)]. Ett tal inom parentes
    direkt efter ett belopp ("119,5 miljarder kronor (110,7)") har samma enhet."""
    out, last = [], None
    for m in TEXT_NUM.finditer(text):
        s, after, before = m.group(0), text[m.end():m.end() + 30], text[max(0, m.start() - 14):m.start()]
        if re.match(r"\s*(%|procent|percent|st\b|aktier|personer|anställda|medarbetare)", after):
            last = None
            continue
        unit = None
        # enheten kan stå efter jämförelsetalet: "59,5 (56,2) miljarder"
        for mm in (re.match(r"\s*(?:\(\s*[-−–]?[\d  .,]+\s*\)\s*)?(%s)" % TEXT_UNIT_RE, after, re.I), re.search(r"(%s)\s*$" % TEXT_UNIT_RE, before, re.I)):
            if mm:
                w = mm.group(1).lower()
                unit = next(((sc, cur) for u, sc, cur in TEXT_UNITS if re.fullmatch(u, w, re.I)), None)
                if unit:
                    break
        if unit is None and last and re.match(r"\s*\)", after) and re.search(r"\(\s*$", before):
            unit = last
        if unit is None:
            continue
        last = unit
        for v, half in readings(s):
            out.append((v * unit[0], half * unit[0], unit[1], s))
    return out


def confirmations(values, amounts):
    """Skalor (1, tusen, miljoner, miljarder) där tabellens tal också står i pressmeddelandet: {(skala, valuta): {tal}}."""
    hits = {}
    for v in values:
        if v is None or abs(v) < 1:
            continue
        for sc in (1, 1e3, 1e6, 1e9):
            for a, half, cur, s in amounts:
                # minst tre siffror, annars är det för lätt att träffa av en slump
                if len(re.sub(r"\D", "", s)) >= 3 and abs(a - v * sc) <= half * 1.0001:
                    hits.setdefault((sc, cur), set()).add(s)
    return hits


def html_text(s):
    s = re.sub(r"<script.*?</script>|<style.*?</style>", "", s, flags=re.S)
    s = re.sub(r"<br\s*/?>|</p>|</div>|</h\d>|</li>|</tr>", "\n", s)
    s = html.unescape(re.sub(r"<[^>]+>", "", s)).replace("\xa0", " ")
    s = re.sub(r"[ \t]+", " ", s)
    return re.sub(r"\n\s*\n*", "\n", s).strip()


ABOUT_WORDS = re.compile(r"grundades|grundat|noterad|huvudkontor|medarbetare|anställda|verksam|marknader|länder|koncernen|bolaget", re.I)


def about_text(body_html, body):
    """Bolagets egen beskrivning ("Om oss") i slutet av pressmeddelandet."""
    m = re.search(r'<div class="mfn-footer mfn-about[^"]*">(.*?)</div>', body_html, re.S)
    if m:
        t = re.sub(r"^\s*(om oss|om [^\n]{2,40}|about [^\n]{2,40})\n", "", html_text(m.group(1)), flags=re.I)
        t = re.sub(r"\s*\n\s*", " ", re.sub(r"\n\s*www\.\S+\s*$", "", t)).strip()
        return t if len(t) >= 120 else None
    lines = [l.strip() for l in body.split("\n")]
    t = next((lines[i + 1] for i, l in enumerate(lines[:-1])
              if re.fullmatch(r"(om|kort om|about) [^.]{2,50}", l, re.I) and len(lines[i + 1]) >= 120), None)
    if not t:
        # Utan rubrik: bara ett stycke efter kontaktuppgifterna som beskriver bolaget (inte vd:ns "vi" och "kvartalet")
        start = max([i for i, l in enumerate(lines) if re.search(r"för (ytterligare|mer) information|denna information är sådan|kontaktperson|"
                                                                    r"for further information", l, re.I)] or [len(lines) // 2])
        cands = [l for l in lines[start:] if 120 <= len(l) <= 1600 and len(ABOUT_WORDS.findall(l)) >= 2
                 and re.search(r"\b(är (en|ett|världens|nordens|sveriges|europas|den|det)|grundades|noterad|huvudkontor|erbjuder|utvecklar|tillverkar|levererar)\b", l, re.I)
                 and not re.search(r"\b(vi|vår|våra|vårt|jag)\b|kvartalet|under perioden|@|tel\.|telefon|\+46|offentliggörande|marknadsmissbruk|webcast|telefonkonferens", l, re.I)]
        if not cands:
            return None
        t = cands[-1]
    return tidy_about(t)


def tidy_about(t):
    # rubriken kan sitta ihop med texten: "Sandvik-koncernen Sandvik är …", "Om Peab Peab är …"
    t = re.sub(r"^[A-ZÅÄÖ][\w&.\-]*-(?:koncernen|gruppen)\s+(?=[A-ZÅÄÖ])", "", t.strip())
    return re.sub(r"^(?:Om|Kort om)\s+([A-ZÅÄÖ][\w&\-]+)\s+(?=\1)", "", t)


def ceo_name(body):
    m = re.search(r"(?:säger|kommenterar|says)\s+([A-ZÅÄÖ][a-zåäöéü\-]+(?:\s[A-ZÅÄÖ][a-zåäöéü\-]+){1,2}),?\s+(?:tillförordnad\s+|tf\.?\s+|t\.f\.\s+)?"
                  r"(?:vd|VD|Vd|verkställande direktör|koncernchef|CEO|President)", body)
    if m:
        return m.group(1)
    m = re.search(r"\n([A-ZÅÄÖ][a-zåäöéü\-]+(?:\s[A-ZÅÄÖ][a-zåäöéü\-]+){1,2})\n(?:vd|VD|Vd|verkställande direktör|Verkställande direktör)", body)
    return m.group(1) if m else None


def ceo_quote(body, ceo):
    """Vd:ns kommentar, de första meningarna."""
    if not ceo:
        return None
    for l in body.split("\n"):
        i = l.find(ceo)
        if i < 0 or not re.search(r"(säger|kommenterar)\s+$", l[:i]):
            continue
        q = re.sub(r"[,–—-]?\s*(säger|kommenterar)\s+$", "", l[:i]).strip().strip("\"”“'-–— ,")
        if len(q) < 60:
            continue
        sents = re.split(r"(?<=[.!?])\s+", q)
        out = ""
        for s in sents:
            if len(out) + len(s) > 320 and out:
                break
            out = (out + " " + s).strip()
        return out
    return None


# ---------- MFN: bolaget, kalendern och rapporterna ----------

MFN = "https://mfn.se"
MFN_REPORTS = '(and(or(.properties.tags@>["sub:report"]))(or(.properties.lang="%s")))'
NOT_INTERIM = re.compile(r"årsredovisning|annual report|hållbarhet|sustainability|bolagsstyrning|kallelse|inbjudan|invitation|presentation|"
                         r"webcast|telefonkonferens|conference call|prospekt|ersättningsrapport", re.I)


FILE_CACHE = None  # mapp för pressmeddelanden och PDF:er (lokalt, --raw-cache), så att de kan läsas om utan att hämtas igen


def cached_fetch(url, accept, keep=True):
    path = None
    if FILE_CACHE and keep:
        path = os.path.join(FILE_CACHE, "mfn", hashlib.md5(url.encode()).hexdigest())
        if os.path.exists(path):
            return open(path, "rb").read()
    b = fetch(url, accept=accept, timeout=120)
    time.sleep(0.5)
    if path and b:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, "wb").write(b)
    return b


def network_error(e):
    """Nätet borta eller servern svarar inte (inte ett svar som 403 eller 404): försök igen nästa gång."""
    return isinstance(e, (urllib.error.URLError, TimeoutError, ConnectionError, OSError)) and not isinstance(e, urllib.error.HTTPError)


def mfn_get(url, keep=False):
    b = cached_fetch(url if url.startswith("http") else MFN + url, "text/html,application/json,*/*", keep)
    return b.decode("utf-8", "replace") if b else ""


def plain_name(n):
    """"VOLVO AB SER. B" -> "volvo", "Hennes & Mauritz AB" -> "hennes & mauritz"."""
    n = re.sub(r"\s*\(publ\)", "", (n or "").lower())
    n = re.sub(r"[\s-]+(ser\.?\s*|series\s+|class\s+)?[a-d]\d?(\s+shs)?$|\s+shs$|\s+sdb$|\s+pref$", "", n)
    n = re.sub(r"\b(ab|aktiebolag|group|holding|ltd|plc|asa|oyj|inc|the|corp)\b|[^\wåäöéü& ]+", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def base_name(name):
    """Bolagets namn utan tillfälligt aktieslag: "Qliro AB Right 2026" -> "Qliro AB", "ALZECURE BTA 26" -> "ALZECURE"."""
    return re.sub(r"\s*\(.*?\)\s*|[\s-]+\b(bta|btu|ta|to\s?\d+|rts|rights?|interim( share)?|temp|ia|wd|subs rt|warrants?|tr|uniträtt|"
                  r"teckningsrätt|pref)\b.*$", "", name or "", flags=re.I).strip(" -")


def same_company(short, full):
    """"isofol med" och "isofol medical" är samma bolag: varje ord i det korta namnet börjar som ordet i det långa."""
    a, b = short.split(), full.split()
    return bool(a) and len(a) <= len(b) and all(b[i].startswith(a[i]) for i in range(len(a))) and len(short) >= 4


def mfn_company(isin, name=None):
    swe = ("XSTO", "FNSE", "XNGM", "XSAT", "NSME")
    tickers = lambda c: [t.split(":", 1)[1] for t in c.get("tickers", []) if t.split(":")[0] in swe]
    for c in json.loads(mfn_get("/search/companies?limit=5&query=" + isin, keep=True) or "[]"):
        if isin in c.get("isins", []):
            return {"slug": c["slug"], "tickers": tickers(c)}
    # ISIN finns inte hos MFN (nytt aktieslag, nytt ISIN efter en omstrukturering): sök på namnet, och bara exakt samma namn
    want = plain_name(base_name(name))
    if len(want) < 3:
        return None
    found = [c for c in json.loads(mfn_get("/search/companies?limit=8&query=" + urllib.parse.quote(want), keep=True) or "[]") if tickers(c)]
    hits = [c for c in found if plain_name(c.get("name")) == want] or [c for c in found if same_company(want, plain_name(c.get("name")))]
    return {"slug": hits[0]["slug"], "tickers": tickers(hits[0])} if len(hits) == 1 else None


def mfn_page(slug, lang="sv"):
    """Bolagets sida på MFN: beskrivning, kalender och de senaste rapporterna."""
    t = mfn_get("/all/a/%s?%s" % (slug, urllib.parse.urlencode({"filter": MFN_REPORTS % lang, "limit": 20})))
    out = {"items": [], "cal": []}
    m = re.search(r'class="description-tray">(.*?)</div>', t, re.S)
    if m:
        for k, v in re.findall(r"<th>(.*?)</th>\s*<td>(.*?)</td>", m.group(1)):
            out[html.unescape(k).strip()] = html.unescape(v).strip()
        out["desc"] = re.sub(r"\s+", " ", html_text(re.sub(r"<table.*?</table>", "", m.group(1), flags=re.S)))
    m = re.search(r'<table class="table-calender">(.*?)</table>', t, re.S)
    if m:
        for row in re.findall(r"<tr[^>]*>(.*?)</tr>", m.group(1), re.S):
            cells = [re.sub(r"\s+", " ", html_text(c)) for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)]
            if len(cells) == 3 and re.match(r"\d{4}-\d\d-\d\d$", cells[0]):
                out["cal"].append([cells[0], cells[2]])
    for blk in re.split(r'<div class="short-item compressible\s*"', t)[1:]:
        d = re.search(r'compressed-date">([^<]+)', blk)
        a = re.search(r'title-link item-link" href="([^"]+)" title="([^"]*)"', blk)
        if d and a:
            pdfs = [u for u in re.findall(r'class="attachment-icon" title="[^"]*" href="([^"]+)"', blk) if u.lower().split("?")[0].endswith(".pdf")]
            out["items"].append({"date": d.group(1).strip(), "url": MFN + a.group(1), "title": html.unescape(a.group(2)), "pdfs": pdfs})
    return out


def mfn_fresh_slugs(since):
    """Nya kvartalsrapporter på MFN sedan ett datum, per bolag: {slug: {publiceringsdatum}} (en sida med de senaste
    rapporterna från alla nordiska bolag). Datum i stället för adress, eftersom samma rapport finns på två språk."""
    t = mfn_get("/all/s/nordic?" + urllib.parse.urlencode({"filter": '(and(or(.properties.tags@>["sub:report"])))', "limit": 300}))
    out = {}
    for blk in re.split(r'<div class="short-item compressible\s*"', t)[1:]:
        d = re.search(r'compressed-date">([^<]+)', blk)
        a = re.search(r'title-link item-link" href="/(?:[a-z]+/)?a/([^/"]+)/[^"]*" title="([^"]*)"', blk)
        if d and a and d.group(1).strip() >= since and not NOT_INTERIM.search(html.unescape(a.group(2))):
            out.setdefault(a.group(1), set()).add(d.group(1).strip())
    return out


def period_end(pub_date, head, title):
    """Sista dagen i rapportens period. Månaden kommer ur kolumnrubriken eller rubriken ("januari–september",
    "Q3"), året är det senaste som slutar före publiceringen."""
    month = None
    for text in (head or "", title or ""):
        ms = list(MONTH_RANGE.finditer(text.lower()))
        if ms:
            month = MONTH_NO[ms[-1].group(2)]
            break
    if month is None:
        q = re.search(r"\b(?:q|kv\.?|kvartal)\s?([1-4])\b|(första|andra|tredje|fjärde) kvartalet|(bokslutskommuniké|year-end)|(halvårsrapport)", (title or "").lower())
        if q:
            month = (int(q.group(1)) * 3 if q.group(1) else {"första": 3, "andra": 6, "tredje": 9, "fjärde": 12}[q.group(2)] if q.group(2)
                     else 12 if q.group(3) else 6)
    pub = dt.date.fromisoformat(pub_date)
    latest = pub - dt.timedelta(days=3)
    if month is None:
        # senaste kvartalsskiftet minst en vecka före publiceringen
        latest = pub - dt.timedelta(days=7)
        month = (latest.month - 1) // 3 * 3 or 12
        if month == 12 and latest.month < 12:
            return dt.date(latest.year - 1, 12, 31)
    year = latest.year
    end = dt.date(year, month, 28) + dt.timedelta(days=4)
    end = end - dt.timedelta(days=end.day)
    if end > latest:
        end = dt.date(year - 1, month, 28) + dt.timedelta(days=4)
        end = end - dt.timedelta(days=end.day)
    return end if (pub - end).days <= 200 else None


def read_interim(item, annual_rev):
    """En kvartalsrapport: pressmeddelandet och PDF:en. Siffrorna godkänns bara om de går att bekräfta:
    samma tal står i pressmeddelandet, eller omsättningen stämmer ungefär med årsredovisningen."""
    page = mfn_get(item["url"], keep=True)
    m = re.search(r'<div class="content s-[a-z]+">(.*?)</article>', page, re.S)
    body_html = m.group(1) if m else ""
    body = html_text(body_html)
    res = {"date": item["date"], "title": item["title"]}
    ceo = ceo_name(body)
    if ceo:
        res["ceo"] = ceo
        quote = ceo_quote(body, ceo)
        if quote:
            res["quote"] = quote
    about = about_text(body_html, body)
    if about:
        res["about"] = about
    interim_numbers(item, body, annual_rev, res)
    full = pdf_text(res.pop("_pdf", None))
    res.update(report_text_fields(page, body_html, body, res.get("q"), full))
    read_nav(item, body, full, res)
    return res


def nav_period(item, q, body):
    """Dagen då rapportens substansvärde gäller: periodens sista dag, ur rubriken ("januari–september") eller
    kvartalssiffrorna. Utan månad i rubriken, och när pressmeddelandet bara nämner andra månadsskiften (brutna
    räkenskapsår: Svolders tredje kvartal slutar 31 maj), gäller det månadsskifte som nämns oftast."""
    title = (item.get("title") or "").lower()
    if MONTH_RANGE.search(title) or re.search(r"\b(?:q|kv\.?|kvartal)\s?[1-4]\b|(första|andra|tredje|fjärde) kvartalet|halvårsrapport", title):
        end = period_end(item["date"], None, item["title"])
        if end:
            return end
    end = None
    if q and q.get("p"):
        y, m = int(q["p"][:4]), int(q["p"][5:7])
        end = dt.date(y, m, 28) + dt.timedelta(days=4)
        end -= dt.timedelta(days=end.day)
    end = end or period_end(item["date"], None, item["title"])
    pub, counts = dt.date.fromisoformat(item["date"]), {}
    for d, mon, y in re.findall(r"\b(\d{1,2})\s+(%s)\s+(\d{4})\b" % "|".join(SV_MONTHS), body, re.I):
        try:
            x = dt.date(int(y), SV_MONTHS.index(mon.lower()) + 1, int(d))
        except ValueError:
            continue
        if (x + dt.timedelta(days=1)).day == 1 and 3 <= (pub - x).days <= 120:
            counts[x] = counts.get(x, 0) + 1
    if not counts or end in counts:
        return end
    return max(counts, key=lambda x: (counts[x], x))


def read_nav(item, body, full, res, full_url=None):
    """Substansvärdet ur rapporten (se nav_figures). Står det inte i PDF:en med resultaträkningen (Balder lägger
    bara en kort sammanfattning där) prövas rapportens andra PDF:er, men bara om pressmeddelandet nämner det."""
    end = nav_period(item, res.get("q"), body)
    res["navv"] = NAV_VERSION
    nav = nav_figures(body, full, end)
    if (not nav or "v" not in nav) and pdfium and NAV_WORD.search(body):
        for url in item["pdfs"][:3]:
            if url == (full_url or res.get("pdf")) and full:
                continue
            try:
                b = cached_fetch(url, "application/pdf,*/*")
            except Exception as e:
                if network_error(e):
                    raise
                continue
            other = nav_figures(body, pdf_text(b), end)
            if other and "v" in other:
                nav = dict(nav or {}, **other)
                nav["pdf"] = url
                break
    if nav and end:
        nav["end"] = end.isoformat()
        res["nav"] = nav
    else:
        res.pop("nav", None)


def pdf_text(pdf_bytes):
    """Hela rapportens text (för teman och ton, som blir säkrare ur hela rapporten än ur pressmeddelandet)."""
    if not pdf_bytes or not pdfium:
        return None
    try:
        pdf = pdfium.PdfDocument(pdf_bytes)
        try:
            return "\n".join(pdf[i].get_textpage().get_text_range() for i in range(len(pdf)))
        finally:
            pdf.close()
    except Exception:
        return None


def refresh_text_fields(r, url):
    """Läser om bara pressmeddelandets text (ur --raw-cache), utan PDF:en."""
    page = mfn_get(url, keep=True)
    m = re.search(r'<div class="content s-[a-z]+">(.*?)</article>', page, re.S)
    body_html = m.group(1) if m else ""
    body = html_text(body_html)
    for k in ("events", "outlook", "bank", "themes", "tone", "react", "orders", "cash", "organic", "headline"):
        r.pop(k, None)
    full = pdf_text(cached_fetch(r["pdf"], "application/pdf,*/*")) if r.get("pdf") else None
    r.update(report_text_fields(page, body_html, body, r.get("q"), full))
    h = report_headline(r.get("title"), body)
    if h:
        r["headline"] = h
    refresh_nav(r, url)


def refresh_nav(r, url):
    """Läser bara om substansvärdet (efter att NAV_VERSION höjts), med pressmeddelandet och rapportens PDF:er."""
    page = mfn_get(url, keep=True)
    m = re.search(r'<div class="content s-[a-z]+">(.*?)</article>', page, re.S)
    body = html_text(m.group(1) if m else "")
    # rapportens PDF:er står som länkar på pressmeddelandet; den med resultaträkningen först
    pdfs = list(dict.fromkeys([p for p in (r.get("pdf"),) if p] + re.findall(r'<a[^>]+href="(https://[^"]+\.pdf)"', page, re.I)))[:3]
    full = pdf_text(cached_fetch(pdfs[0], "application/pdf,*/*")) if pdfs and pdfium else None
    read_nav({"url": url, "date": r["date"], "title": r["title"], "pdfs": pdfs}, body, full, r, pdfs[0] if pdfs else None)


def interim_numbers(item, body, annual_rev, res):
    """Siffrorna ur rapportens PDF (resultaträkningen och affärsområdena), om de går att bekräfta."""
    h = report_headline(item.get("title"), body)
    if h:
        res["headline"] = h
    if not pdfium:
        return res
    st = pdf_bytes = None
    for url in item["pdfs"][:3]:
        try:
            pdf_bytes = cached_fetch(url, "application/pdf,*/*")
            st = read_statement(pdf_bytes) if pdf_bytes else None
        except Exception as e:
            if network_error(e):
                raise
            print("  %s: PDF:en gick inte att läsa (%s)" % (item["url"], e))
            st = None
        if st:
            res["pdf"] = url
            res["_pdf"] = pdf_bytes
            break
    if not st or not st["months"]:
        return res
    amounts = text_amounts(body)
    conf = confirmations([v for k in ("rev", "ebit", "net") for v in st["all"].get(k, [])], amounts)
    unit, via = st["unit"], None
    if unit and unit in conf:
        via = "text"
    elif not unit:
        best = max(conf.items(), key=lambda kv: len(kv[1]), default=None)
        if best and len(best[1]) >= 2:
            unit, via = best[0], "text"
    if not via and unit and annual_rev and st["vals"].get("rev", [None])[0]:
        ratio = st["vals"]["rev"][0] * unit[0] * 12 / st["months"] / annual_rev
        if 0.5 <= ratio <= 2:
            via = "annual"
    if not via:
        return res
    end = period_end(item["date"], st["head"], item["title"])
    if not end:
        return res
    sc, cur = unit
    q = {"p": end.isoformat()[:7], "m": st["months"], "cur": cur, "via": via}
    for k, (a, b) in st["vals"].items():
        if k == "rev" and ((a is not None and a < 0) or (b is not None and b < 0)):
            continue  # negativ omsättning betyder att det är fel rad
        if k == "eps":
            if all(x is None or abs(x) < 1000 for x in (a, b)):
                q[k] = [a, b]
        else:
            q[k] = [round(a * sc) if a is not None else None, round(b * sc) if b is not None else None]
    res["q"] = q
    rev = (q.get("rev") or [None])[0]
    if rev and rev > 0:
        try:
            seg = read_segments(pdf_bytes, q)
        except Exception as e:
            print("  %s: affärsområdena gick inte att läsa (%s)" % (item["url"], e))
            seg = None
        if seg:
            res["seg"] = seg
    return res


# ---------- Mer ur rapporten: händelser, utsikter, orderingång och affärsområden ----------

BORING_EVENT = re.compile(r"årsstämma|bolagsstämma|kallelse|valberedning|certified adviser|utdelning|bokslutskommuniké|delårsrapport|"
                          r"kvartalsrapport|årsredovisning|finansiell kalender|lämnade .{0,20}rapport", re.I)


def events_and_outlook(body):
    """Väsentliga händelser (högst fyra punkter) och bolagets syn framåt, med bolagets egna ord."""
    lines = [l.strip() for l in body.split("\n") if l.strip()]
    events, outlook = [], None
    for i, l in enumerate(lines):
        if len(events) < 4 and len(l) <= 80 and re.match(r"(väsentliga |viktiga |övriga )?händelser\b", l, re.I) and not re.search(r"finansiella", l, re.I):
            for x in lines[i + 1:i + 12]:
                if len(x) < 30 and not re.match(r"[•●·\-–]", x):
                    if x is lines[i + 1] and len(x) < 40:
                        continue  # underrubrik ("Andra kvartalet")
                    break
                if re.match(r"(väsentliga |viktiga )?händelser|vd har ordet|vd-ord|för ytterligare information|denna information", x, re.I):
                    break
                x = re.sub(r"^[•●·\-–]\s*", "", x)
                x = re.sub(r"^\d{1,2} (januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december)( \d{4})?:\s*", "", x, flags=re.I)
                if BORING_EVENT.search(x) or not swedish(x + " och är av för"):
                    continue
                first = re.split(r"(?<=[a-zåäö0-9)])\.\s+(?=[A-ZÅÄÖ])", x)[0].rstrip(".")
                if 25 <= len(first) <= 240 and first not in events:
                    events.append(first)
                if len(events) >= 4:
                    break
        if not outlook:
            m = re.match(r"[-•●–]?\s*((?:framtids|marknads)?utsikter(?: för \d{4})?(?: \(\w+\))?|prioriteringar framåt och utsikter)\s*:?\s*(.*)$", l, re.I)
            if m and len(m.group(1)) < 60:
                text = m.group(2) if len(m.group(2)) >= 60 else next((x for x in lines[i + 1:i + 3] if len(x) >= 60), None)
                if text and swedish(text) and not re.search(r"framtidsinriktade uttalanden|forward-looking", text, re.I):
                    out = ""
                    for s in re.split(r"(?<=[.!?])\s+", text):
                        if out and len(out) + len(s) > 320:
                            break
                        out = (out + " " + s).strip()
                    outlook = out
    return events, outlook


def bank_figures(body):
    """Bankernas egna nyckeltal för kvartalet: avkastning på eget kapital (%), K/I-tal (kostnad per intjänad krona) och
    kärnprimärkapitalrelation (%). Står som en rad i nyckeltalstabellen ("K/I-tal 0,41 0,43 …", första talet är
    kvartalet) eller i en mening ("med en avkastning på eget kapital om 13,0 procent")."""
    num = r"(-?\d{1,2},\d{1,2})"
    specs = {
        "roe": (r"(?:räntabilitet|avkastning)(?:en)? på eget kapital", -50, 60),
        "ci": (r"k/i-tal(?:et)?", 0.1, 2),
        "cet1": (r"kärnprimärkapital(?:relation|kvot)(?:en)?", 4, 45),
    }
    out = {}
    lines = body.split("\n")
    for key, (word, lo, hi) in specs.items():
        v = None
        for l in lines:
            m = re.match(r"\s*%s(?:,\s*%%)?\s*[¹²³*]*\s+%s(?:\s|$)" % (word, num), l, re.I)
            if m and not re.search(r"justera|exklusive|exkl\.", l[:m.end()], re.I):
                v = float(m.group(1).replace(",", "."))
                break
        if v is None:
            m = re.search(r"%s\s+(?:om|på|var|blev|uppgick till|landade på)\s+%s" % (word, num), body, re.I)
            if m:
                v = float(m.group(1).replace(",", "."))
        if v is not None and lo <= v <= hi:
            out[key] = v
    return out or None


# ---------- Substansvärde, substansrabatt och belåningsgrad (investmentbolag och fastighetsbolag) ----------

SV_MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"]
TEXT_DATE = re.compile(r"\b(\d{1,2})\s+(%s)\b" % "|".join(SV_MONTHS), re.I)
NRV_WORD = r"epra nrv|långsiktig[ta]? substansvärde(?:t|n)?(?![a-zåäö])|net reinstatement value"
NAV_WORD = re.compile(r"%s|(?:justerat |justerade |rapporterat |rapporterade )?substansvärde(?:t|n)?(?![a-zåäö])" % NRV_WORD, re.I)
SH_NUM = r"\d{1,3}(?:[  ]\d{3})*(?:,\d{1,2})?"
PER_SHARE = r"(?:per|/)\s*(?:[a-d]-\s*och\s*[a-d]-)?(?:stam)?aktie"
# "411 kr per aktie", "59,40 (57,20) SEK per aktie", "147 kr (146) per aktie"
NAV_AMOUNT = re.compile(r"(?P<v>%s)\s*(?:\(\s*[-−–]?%s\s*\)\s*)?(?:kr|kronor|sek)\s*(?:\(\s*[-−–]?%s\s*\)\s*)?%s" % (SH_NUM, SH_NUM, SH_NUM, PER_SHARE), re.I)
# "EPRA NRV per aktie … till 101,59 kr", "Substansvärde per A- och B-aktie uppgick till 144,49 kronor"
NAV_AFTER = re.compile(r"\s*(?:\([\w ]{2,12}\)\s*)?%s" % PER_SHARE, re.I)
NAV_LATE = re.compile(r"(?P<v>%s)\s*(?:kr|kronor|sek)\b" % SH_NUM, re.I)
# en förändring, inte själva värdet ("ökade med 74 kronor per aktie", "motsvarande 12 kr")
NAV_CHANGE = re.compile(r"(ökade|ökat|ökning|minskade|minskat|minskning|steg|sjönk|förändring\w*|motsvarande|med|utdelning\w*(?: om| på)?|ca\.?|cirka|drygt|nästan)\s*[+−–-]?\s*$", re.I)
LTV_TEXT = re.compile(r"belåningsgrad\w*(?:\s+(?:uppgick till|uppgår till|till|var|om|blev|på|landade på))?\s+(\d{1,2}(?:,\d{1,2})?)\s*(?:procent|%)(?!\s*[-–])", re.I)
DISC_TEXT = re.compile(r"(?P<w>rabatt|premie)\w*\s+(?:(?:om|på|var|uppgick till|till|motsvarande)\s+)?(?P<v>\d{1,2}(?:,\d)?)\s*(?:procent|%)(?!\s*[-–])", re.I)


def nav_label(word):
    w = word.lower()
    if "nrv" in w or "reinstatement" in w:
        return "nrv", "EPRA NRV"
    if w.startswith("långsiktig"):
        return "nrv", "Långsiktigt substansvärde"
    if w.startswith("justera"):
        return "nav", "Justerat substansvärde"
    if w.startswith("rapportera"):
        return "nav", "Rapporterat substansvärde"
    return "nav", "Substansvärde"


def sentences(text):
    text = re.sub(r"[￾­]\s*", "", text)
    # PDF:ens radbrytningar mitt i en mening ("… uppgick till\n156,6 mdkr (631 kronor per aktie)")
    text = re.sub(r"(?<![.:!?])[ \t]*\n(?=[a-zåäö(\d])", " ", text)
    out = []
    for part in re.split(r"\n|[•■◼▪●]", text):
        out += [s for s in re.split(r"(?<=[a-zåäö0-9)%])[.!?]\s+(?=[A-ZÅÄÖ])", part) if s.strip()]
    return out


def half_step(s):
    """Halva avrundningssteget för ett tal som "411" (0,5) eller "107,75" (0,005)."""
    return 0.5 * 10 ** -len(s.split(",")[1]) if "," in s else 0.5


def nav_in_text(text, end):
    """Substansvärdet per aktie i löptext: [(värde, halvt avrundningssteg, slag, etikett)]. Bara meningar där värdet
    gäller periodens slut: står ett annat datum först ("den 19 augusti", "den 11 september") gäller det inte perioden."""
    out = []
    for s in sentences(text):
        for lm in NAV_WORD.finditer(s):
            rest = s[lm.end():lm.end() + 220]
            m = NAV_AMOUNT.search(rest)
            if not m and NAV_AFTER.match(rest):
                m = NAV_LATE.search(rest, NAV_AFTER.match(rest).end())
            if not m or NAV_CHANGE.search(rest[max(0, m.start() - 28):m.start()]):
                continue
            upto = s[:lm.end() + m.end() + 40]
            dates = TEXT_DATE.findall(upto)
            if dates and (not end or (int(dates[0][0]), SV_MONTHS.index(dates[0][1].lower()) + 1) != (end.day, end.month)):
                break
            v = pdf_number(m.group("v"), ",")
            if v and v > 0:
                out.append((v, half_step(m.group("v")), ) + nav_label(lm.group(0)))
            break  # bara första värdet efter ordet: resten är jämförelser ("jämfört med 267,2 kr vid årsskiftet")
    return out


def clean_row(line):
    """Fotnoter bort ur en nyckeltalsrad: "Substansvärde per aktie, kronor1, 2) 94 96" -> "Substansvärde per aktie, kronor 94 96"."""
    l = re.sub(r"[*¹²³⁴⁵⁶⁷⁸⁹⁰’]+", "", line.replace("−", "-").replace("–", "-"))
    l = re.sub(r"(?<=[a-zåäö%)])\d(?:,\s*\d)*\)", " ", l)
    l = re.sub(r"(?<=\s)\d(?:,\s*\d)*\)(?=\s)", " ", l)
    return re.sub(r"\s+", " ", l).strip()


def table_rows(text):
    """Nyckeltalsrader i PDF:en: [(etikett, [tal som text])]. Första talet är nästan alltid perioden."""
    out = []
    for line in text.split("\n"):
        m = re.match(r"^(?P<lab>[A-Za-zÅÄÖåäöÉé][^\d]*?)\s+(?P<rest>[-(]?\d[\d ,.%()-]*)$", clean_row(line))
        if m:
            out.append((m.group("lab").strip(" ,:"), m.group("rest").split()))
    return out


def first_value(tokens, want_pct=False):
    if want_pct and not tokens[0].endswith("%"):
        tokens = [t for t in tokens if t.endswith("%")] or tokens
    v = pdf_number(tokens[0].rstrip("%").strip("()"), ",") if tokens else None
    return v, tokens[0].rstrip("%") if tokens else ""


def nav_figures(body, full, end):
    """Substansvärde per aktie (eller EPRA NRV för fastighetsbolag), substansrabatten och belåningsgraden ur
    kvartalsrapporten. Ett värde sparas bara om det går att bekräfta:
      - "pm": samma tal står i pressmeddelandet och i PDF:en,
      - "text": samma tal står i rapportens nyckeltalstabell och i rapportens löptext,
      - "calc": tabellens substansvärde, aktiekurs och rabatt går ihop med varandra.
    Rabatten som rapporten själv anger sparas bara om den stämmer med rapportens egen aktiekurs (eller, senare,
    med kvartalskursen från fonderna samma dag)."""
    if not full or not (NAV_WORD.search(body) or NAV_WORD.search(full) or re.search(r"belåningsgrad", full, re.I)):
        return None
    full = re.sub(r"[￾­]\s*", "", full)
    rows = table_rows(full)
    nav_rows, price, disc_rows = [], None, []
    for lab, toks in rows:
        low = lab.lower()
        lm = NAV_WORD.search(low)
        # bara kronor: Cibus och Eastnine redovisar i euro, och kursen från fonderna är i kronor
        if lm and lm.start() <= 12 and re.search(r"%s|\b(kr|kronor|sek)\b" % PER_SHARE, low) and \
                not re.search(r"förändring|tillväxt|rabatt|premie|avkastning|mkr|mnkr|msek|mdkr|sek ?mn|sek ?m\b|miljon|miljard|\bnta\b|\bndv\b|kurs|%|utdelning|"
                              r"\b(eur|euro|usd|nok|dkk)\b", low):
            v, s = first_value(toks)
            if v and v > 0:
                nav_rows.append((v, half_step(s)) + nav_label(lm.group(0)))
        elif price is None and re.match(r"(aktiens )?(aktiekurs|börskurs|senaste betalkurs)(en)?\b", low) and re.search(r"\b(kr|kronor|sek)\b", low) and \
                not re.search(r"%|procent|förändring|utveckling|relation|genomsnitt|högsta|lägsta", low):
            price = first_value(toks)[0]
        elif re.search(r"rabatt|premie", low) and re.search(r"substans|nav\b|nrv", low) and not re.search(r"likvid|justering", low):
            v = first_value(toks, True)[0]
            if v is not None and abs(v) < 95:
                disc_rows.append(v)
        elif re.search(r"(börskurs|aktiekurs)\w*\s*(i % av|i procent av|/)\s*(epra nrv|substansvärde|långsiktigt substansvärde)", low):
            v = first_value(toks, True)[0]
            if v and 5 < v < 500:
                disc_rows.append(round(v - 100, 2))
    pm = nav_in_text(body, end)
    in_pdf = nav_in_text(full, end)
    # Bekräftelsen: samma värde två gånger, och då det mest exakta (tabellens 107,75 framför pressmeddelandets 108)
    nav = None
    close = lambda a, b: abs(a[0] - b[0]) <= max(a[1], b[1]) + 1e-9
    for src, via in ((pm, "pm"), (in_pdf, "text")):
        if not src:
            continue
        first = src[0]
        others = nav_rows + (in_pdf if via == "pm" else [])
        match = [x for x in others if close(first, x) and x[2] == first[2]]
        if match:
            best = min(match + [first], key=lambda x: x[1])
            nav = {"k": first[2], "lbl": first[3], "v": best[0], "via": via}
            break
    if nav is None and len(nav_rows) >= 2:
        # "tabeller": samma värde först i två olika nyckeltalstabeller (Castellum: "EPRA NRV, kr/aktie 169 160 …" och
        # "EPRA NRV, kr 169 160 160 157 …"), så att kolumnen inte är fel vald
        first = nav_rows[0]
        if any(close(first, x) and x[2] == first[2] for x in nav_rows[1:]):
            nav = {"k": first[2], "lbl": first[3], "v": first[0], "via": "tabeller"}
    disc = None
    if price and nav_rows and disc_rows:
        calc = (price / nav_rows[0][0] - 1) * 100
        disc = next((d for d in disc_rows if abs(d - calc) <= 1.5), next((-d for d in disc_rows if d > 0 and abs(-d - calc) <= 1.5), None))
        if nav is None and disc is not None:
            nav = {"k": nav_rows[0][2], "lbl": nav_rows[0][3], "v": nav_rows[0][0], "via": "calc"}
    out = {}
    if nav:
        out.update(nav)
        if disc is None and price and disc_rows and abs(price / nav["v"] - 1) < 5:
            calc = (price / nav["v"] - 1) * 100
            disc = next((d for d in disc_rows if abs(d - calc) <= 1.5), None)
        if disc is not None and price:
            out["disc"] = disc
            out["discVia"] = "pris"
        elif disc is None:
            # Rabatten bara i text ("värderades till en rabatt om 3,2 procent i förhållande till substansvärdet"),
            # eller i tabellen utan kurs: kontrolleras mot fondernas kvartalskurs om den gäller samma dag
            for s in sentences(full) + sentences(body):
                if NAV_WORD.search(s) or re.search(r"substans", s, re.I):
                    m = DISC_TEXT.search(s)
                    if m and not re.search(r"(ca\.?|cirka|omkring|intervallet)\s*$", s[:m.start("v")], re.I):
                        disc = float(m.group("v").replace(",", ".")) * (-1 if m.group("w").lower() == "rabatt" else 1)
                        break
            if disc is None and disc_rows:
                disc = disc_rows[0]
            if disc is not None:
                out["disc"] = disc
    # Belåningsgraden: nyckeltalsraden ("Belåningsgrad, % 37,4 36,5") och samma tal i texten
    ltv_rows = []
    for lab, toks in rows:
        low = lab.lower()
        if re.match(r"belåningsgrad(en)?( fastighet(er)?| vid periodens (utgång|slut))?,?\s*(%|\(%\)|procent)?$", low):
            v = first_value(toks)[0]
            if v and 5 <= v <= 85:
                ltv_rows.append((0 if low.startswith("belåningsgrad,") or low in ("belåningsgrad", "belåningsgrad %", "belåningsgrad (%)") else 1, v))
    ltv_rows.sort(key=lambda x: x[0])
    for text, via in ((body, "pm"), (full, "text")):
        found = [float(m.group(1).replace(",", ".")) for s in sentences(text) for m in [LTV_TEXT.search(s)] if m]
        hit = next((v for v in found if any(abs(v - r[1]) < 1e-9 for r in ltv_rows)), None)
        if hit is not None:
            out["ltv"] = hit
            out["ltvVia"] = via
            break
    return out or None


# ---------- Branschens nyckeltal: det som betyder mest i just bolagets bransch ----------
#
# Banker: räntenetto, kreditförluster, utlåning. Fastighetsbolag: uthyrningsgrad, räntetäckningsgrad, snittränta.
# Gruvor och skogsbolag: produktion, leveranser och metallpriser. Butikskedjor: bruttomarginal och antal butiker. Och så vidare.
# Ett värde sparas bara om det går att bekräfta:
#   - "tabell": samma tal (och samma jämförelsetal) står i rapportens nyckeltalstabell och i texten,
#   - "text": tabellen saknas, men samma tal med samma jämförelsetal står i både pressmeddelandet och rapporten,
#   - "rapporter": produktions- och prisrader som bara finns i tabeller bekräftas av nästa rapport, där kvartalets tal
#     står igen som jämförelsetal (se kpi_doc).

KPI_GROUPS = {
    "bank": {"Storbank", "Bank", "Nischbank"},
    "ins": {"Försäkring"},
    "prop": {"Förvaltning"},
    "mine": {"Gruvdrift & metaller"},
    "forest": {"Skog & Cellulosa"},
    "retail": {"Detaljhandel", "Sällanköpsvaror", "Dagligvaror", "Handel & distribution"},
    "tele": {"Telekommunikation och -tjänster"},
    "pharma": {"Bioteknik", "Läkemedel & Handel", "Medicinteknik", "Forskning & Utveckling"},
    "games": {"Gaming", "Betting"},
    "tech": {"Programvara", "IT-konsult & onlinetjänster"},
    "ind": {"Industriprodukter", "Maskinindustri", "Elektronisk utrustning", "Anläggning & bygg", "Fordon", "Fordon & Transport", "Industri",
            "Projektering", "Teknik-konsult", "Plast, kemikalier & fetter", "Infrastruktur", "Energikällor", "Miljö & Återvinning",
            "Shipping & Offshore", "Bemanning & Rekrytering", "Allmänna tjänster", "Kommunikation", "Media", "Resor & Fritid", "Vård & Omsorg"},
}
NONFIN = {"mine", "forest", "retail", "tele", "pharma", "games", "tech", "ind"}


def kpi_group(industry):
    return next((g for g, s in KPI_GROUPS.items() if industry in s), None)


# (nyckel, grupper, slag, radens början i nyckeltalstabellen, ordet i texten, lägsta, högsta, flöde)
# slag: pct (procent), x (gånger), yr (år), amt (belopp), n (antal). Flöden (räntenetto, förvaltningsresultat) gäller
# kvartalet och läses bara där texten handlar om kvartalet; ställningar (utlåning, uthyrningsgrad) gäller en dag.
KPIS = [
    # banker
    ("nii", {"bank"}, "amt", r"räntenetto", r"räntenettot?", 1e6, 1e12, True),
    ("fee", {"bank"}, "amt", r"provisionsnetto", r"provisionsnettot?", 1e6, 1e12, True),
    ("kf", {"bank"}, "amt", r"kreditförluster(?:,? netto)?", r"kreditförlusterna?(?:,? netto)?", -1e11, 1e11, True),
    ("kfn", {"bank"}, "pct", r"kreditförlustnivå", r"kreditförlustnivån?", -2, 5, False),
    ("lend", {"bank"}, "amt", r"utlåning till allmänheten", r"utlåningen? till allmänheten", 1e8, 1e13, False),
    ("dep", {"bank"}, "amt", r"inlåning från allmänheten", r"inlåningen? från allmänheten", 1e8, 1e13, False),
    ("lcr", {"bank"}, "pct", r"likviditetstäckning(?:sgrad|skvot)", r"likviditetstäckning(?:sgrad|skvot)(?:en)?", 50, 600, False),
    ("aum", {"bank"}, "amt", r"sparkapital(?: vid periodens slut)?", r"sparkapital(?:et)?", 1e9, 1e13, False),
    ("cust", {"bank"}, "n", r"(?:antal )?kunder(?: vid periodens slut)?", r"antal(?:et)? kunder", 1000, 5e7, False),
    ("inflow", {"bank"}, "amt", r"nettoinflöde", r"nettoinflöde(?:t)?", -1e12, 1e12, True),
    # försäkring
    ("tkp", {"ins"}, "pct", r"totalkostnadsprocent", r"totalkostnadsprocenten?", 40, 160, True),
    ("skp", {"ins"}, "pct", r"skadeprocent", r"skadeprocenten?", 10, 150, True),
    ("prem", {"ins"}, "amt", r"premieintäkter(?:,? (?:för egen räkning|f\.e\.r\.))?", r"premieintäkterna?(?:,? (?:för egen räkning|f\.e\.r\.))?", 1e6, 1e12, True),
    # fastigheter
    ("occ", {"prop"}, "pct", r"(?:ekonomisk )?uthyrningsgrad(?:,? (?:- )?ekonomisk)?", r"(?:ekonomiska? )?uthyrningsgrade?n?", 40, 100, False),
    ("surplus", {"prop"}, "pct", r"överskottsgrad", r"överskottsgraden?", 20, 100, True),
    ("icr", {"prop"}, "x", r"räntetäckningsgrad", r"räntetäckningsgraden?", 0, 15, False),
    ("rate", {"prop"}, "pct", r"(?:genomsnittlig (?:ränta|räntekostnad|låneränta)|snittränta)(?: (?:per bokslutsdagen?|per balansdagen|vid periodens (?:slut|utgång)))?",
     r"(?:genomsnittliga? (?:räntan?|räntekostnaden?|låneräntan?)|snitträntan?)", 0.2, 12, False),
    ("fixyr", {"prop"}, "yr", r"(?:genomsnittlig )?räntebindning(?:stid)?", r"(?:genomsnittliga? )?räntebindning(?:en|stiden)?", 0, 20, False),
    ("capyr", {"prop"}, "yr", r"(?:genomsnittlig )?kapitalbindning(?:stid)?", r"(?:genomsnittliga? )?kapitalbindning(?:en|stiden)?", 0, 25, False),
    ("pv", {"prop"}, "amt", r"(?:fastigheternas (?:verkliga |redovisade )?(?:marknads)?värde|förvaltningsfastigheter(?:nas)?,? verkligt värde|"
                            r"verkligt värde (?:på )?förvaltningsfastigheter|marknadsvärde (?:på )?fastigheter(?:na)?)",
     r"(?:fastigheternas|fastighetsbeståndets|förvaltningsfastigheternas) (?:verkliga |bedömda |totala |redovisade )?(?:marknads)?värde", 1e8, 1e13, False),
    ("mgmt", {"prop"}, "amt", r"förvaltningsresultat", r"förvaltningsresultat(?:et)?", -1e11, 1e11, True),
    ("noi", {"prop"}, "amt", r"driftnetto", r"driftnetto(?:t)?", -1e11, 1e11, True),
    ("rent", {"prop"}, "amt", r"hyresintäkter", r"hyresintäkter(?:na)?", 1e6, 1e11, True),
    ("netlet", {"prop"}, "amt", r"nettouthyrning", r"nettouthyrning(?:en)?", -1e10, 1e10, True),
    # butiker och konsument
    ("stores", {"retail"}, "n", r"(?:antal )?butiker(?: vid periodens (?:slut|utgång))?", r"antal(?:et)? butiker", 2, 20000, False),
    ("lfl", {"retail"}, "pct", r"(?:försäljning(?:sutveckling|stillväxt)? i )?jämförbara butiker", r"(?:i )?jämförbara butiker", -60, 100, True),
    # spel och betting
    ("active", {"games"}, "n", r"(?:antal )?aktiva (?:kunder|spelare|användare)", r"aktiva (?:kunder|spelare|användare)", 100, 5e8, True),
    ("deposits", {"games"}, "amt", r"kundinsättningar", r"kundinsättningar(?:na)?", 1e6, 1e12, True),
    # mjukvara
    ("arr", {"tech"}, "amt", r"(?:arr|årligt återkommande intäkter)", r"(?:arr|årligt? återkommande intäkter(?:na)?)", 1e6, 1e12, False),
    # läkemedel och bioteknik: kassan och hur mycket verksamheten förbrukar
    ("cash", {"pharma"}, "amt", r"likvida medel(?: vid periodens slut)?", r"likvida medel", 1e5, 1e12, False),
    ("ocf", {"pharma"}, "amt", r"kassaflöde(?:,? netto,?)? från (?:den )?löpande verksamhet(?:en)?", r"kassaflödet från (?:den )?löpande verksamhet(?:en)?", -1e11, 1e11, True),
    # alla bolag utom banker, försäkrings- och fastighetsbolag
    ("gm", NONFIN, "pct", r"bruttomarginal", r"bruttomarginal(?:en)?", -50, 100, True),
    ("ebitdam", NONFIN, "pct", r"ebitda[- ]?marginal", r"ebitda[- ]?marginal(?:en)?", -200, 100, True),
    ("ndebitda", NONFIN, "x", r"nettoskuld(?:sättning)?\s*/\s*ebitda", r"nettoskuld(?:en|sättningen)?\s*(?:/|i förhållande till|i relation till)\s*ebitda", -10, 20, False),
    ("roce", NONFIN, "pct", r"avkastning på sysselsatt kapital", r"avkastning(?:en)? på sysselsatt kapital", -80, 200, False),
]
KPI_BAD_ROW = re.compile(r"justera|exkl|exklusive|underliggande|rullande|r12|förändring|tillväxt| i % av|per aktie|per kvartal|uppdelning|mål\b|"
                         r"genomsnitt(?!lig (?:ränta|räntekostnad|låneränta|räntebindning|kapitalbindning))|ifrs ?16|före\b", re.I)
KPI_BAD_TEXT = re.compile(r"justera|exkl|exklusive|underliggande|rullande|mål(?:et|sättning)?\b|ska\b|skall\b|över tid|bör\b|förväntas|bedöm|före\b", re.I)

# Produktion, leveranser och metallpriser (gruvor och skogsbolag): raderna i rapportens tabeller, med bolagets egna namn
VOL_UNIT = r"(?:kton|kt|ton|tusen ton|1 ?000 ton|mton|m3|m³|km3|km³|tusen m3|tusen m³|1 ?000 m3|1 ?000 m³|m3fub|m³fub|m3sk|m³sk|gwh|twh|kg|oz|koz|moz|uns)"
VOL_ROW = re.compile(r"^(?P<lab>[A-Za-zÅÄÖåäöé][^\d/]{1,60}?)(?:,\s*|\s+|\s*\()(?P<unit>%s(?: fub| sk)?)\)?\s*\*?$" % VOL_UNIT, re.I)
VOL_BAD = re.compile(r"co2|utsläpp|scope|vatten|energiförbrukning|energianvändning|avfall|intensitet|per ton|/ton råstål|kapacitet|reserv|tillgång|"
                     r"inkluderar|leasing|varav|summa|totalt?\b", re.I)
PRICE_ROW = re.compile(r"^(?P<lab>[A-Za-zÅÄÖåäö][A-Za-zÅÄÖåäö \-]{1,30}?),?\s*\(?(?P<unit>(?:usd|sek|kr|eur)\s*/\s*(?:ton|t|oz|lb|kg|m3|m³))\)?\s*\*?$", re.I)
GRADE_ROW = re.compile(r"^(?P<lab>(?:genomsnittlig )?[A-Za-zÅÄÖåäö]+halt\w*),?\s*\(?(?P<unit>g\s*/\s*t(?:on)?|%)\)?\s*\*?$", re.I)

KPI_NUM = r"[-−–]?\s?\d{1,3}(?:[  ]\d{3})+(?:[,.]\d+)?|[-−–]?\s?\d+(?:[,.]\d+)?"
KPI_PCT = r"\s*(?:%|procent(?!enhet)|percent)"
KPI_X = r"\s*(?:ggr|gånger|x)(?![a-zåäö])"
KPI_YR = r"\s*år(?![a-zåäö])"
YTD_MARK = re.compile(r"(jan\w*|feb\w*|mar\w*|apr\w*|maj|jun\w*|jul\w*|aug\w*|sep\w*|okt\w*|nov\w*|dec\w*)\.?\s*[-–—]\s*(jan\w*|feb\w*|mar\w*|apr\w*|maj|jun\w*|jul\w*|aug\w*|sep\w*|okt\w*|nov\w*|dec\w*)|"
                      r"(niomånaders|nio månader|sex månader|första halvåret|halvåret|delårsperioden|helåret|helår)|"
                      r"((?:första|andra|tredje|fjärde) kvartalet|kvartalet|\bq[1-4]\b|\bkv\.? ?[1-4]\b|\bkvartal [1-4]\b)", re.I)


def kpi_number(s, kind):
    """Ett tal i texten eller tabellen: (värde, halvt avrundningssteg). "10 051" -> 10051, "0,00" -> 0, "20.6" -> 20,6."""
    s = s.replace("−", "-").replace("–", "-").replace(" ", " ").replace(" ", " ").strip()
    neg = s.startswith("-")
    s = s.lstrip("- ")
    if re.fullmatch(r"\d{1,3}(?: \d{3})+(?:,\d+)?", s):
        ip, _, fp = s.replace(" ", "").partition(",")
    elif re.fullmatch(r"\d+,\d+", s):
        ip, _, fp = s.partition(",")
    elif re.fullmatch(r"\d+\.\d{1,2}", s) or (re.fullmatch(r"\d+\.\d+", s) and kind in ("pct", "x", "yr")):
        ip, _, fp = s.partition(".")
    elif re.fullmatch(r"\d{1,3}(?:\.\d{3})+", s):
        ip, fp = s.replace(".", ""), ""
    elif re.fullmatch(r"\d+", s):
        ip, fp = s, ""
    else:
        return None
    v = float(ip + ("." + fp if fp else ""))
    return (-v if neg else v), 0.5 * 10 ** -len(fp)


def kpi_text(text):
    """Texten med PDF:ens radbrytningar mitt i meningar ihopsatta (positionerna behövs för att avgöra perioden)."""
    text = re.sub(r"[￾­]\s*", "", text or "")
    return re.sub(r"(?<![.:!?])[ \t]*\r?\n(?=[a-zåäö(\d−–-])", " ", text)


def ytd_before(text, pos):
    """Handlar texten vid pos om mer än ett kvartal ("januari–september", "helåret")? Avgörs av närmaste periodord före."""
    last = None
    for m in YTD_MARK.finditer(text, max(0, pos - 1500), pos):
        if m.group(1) and re.search(r"(rapport\w*|kommuniké)\s*(?:för\s*)?$", text[max(0, m.start() - 30):m.start()], re.I):
            continue  # rapportens namn i sidhuvudet ("Delårsrapport januari–september 2026")
        last = m
    if not last:
        return False
    if last.group(1):
        a, b = (MONTH_NO.get(last.group(i)[:3].lower()) for i in (1, 2))
        return bool(a and b and (b - a) % 12 + 1 > 3)
    return bool(last.group(3))


def kpi_unit(after, before):
    """Enheten för ett belopp: efter talet ("10 051 mkr"), efter jämförelsetalet ("14 129 (13 392) MSEK") eller före ("MSEK 13 789")."""
    for mm in (re.match(r"\s*(?:\(\s*[-−–]?[\d  .,]+\s*\)\s*)?(%s)(?![a-zåäö])" % TEXT_UNIT_RE, after, re.I),
               re.search(r"(?<![a-zåäö])(%s)\s*$" % TEXT_UNIT_RE, before, re.I)):
        if mm:
            w = mm.group(1).lower()
            u = next(((sc, cur) for rx, sc, cur in TEXT_UNITS if re.fullmatch(rx, w, re.I)), None)
            if u and u[0] >= 1e3:
                return u
    return None


OTHER_UNIT = r"\s*(?:%%|procent|ggr|gånger|år(?![a-zåäö])|%s)" % TEXT_UNIT_RE


def kpi_in_text(text, word, kind, flow):
    """Värdet efter ordet i texten: [(värde, halvt steg, jämförelsetal eller None, valuta)]. Hoppar över förändringar
    ("ökade med 43 mkr till 10 051 mkr (10 008)") och, för flöden, text om flera kvartal ("januari–september")."""
    out = []
    for m in re.finditer(r"(?<![a-zåäö])%s(?![a-zåäö])" % word, text, re.I):
        end = re.search(r"\n|[•■◼▪●]|(?<=[a-zåäö0-9)%])[.!?;]\s+(?=[A-ZÅÄÖ])", text[m.end():m.end() + 180])
        rest = text[m.end():m.end() + (end.start() if end else 180)]
        head = text[max(0, m.start() - 40):m.start()]
        if KPI_BAD_TEXT.search(rest[:40]) or re.search(r"(justera\w*|underliggande|exkl\.?|mål\w*)\s*$", head, re.I):
            continue
        if flow and ytd_before(text, m.start()):
            continue
        skipped = 0
        for t in re.finditer(KPI_NUM, rest):
            before, after = rest[:t.start()], rest[t.end():]
            if re.search(r"\b(med|på|om)\s*$|\+\s*$", before) and re.search(r"\btill\b", after[:60]):
                continue  # en förändring före själva värdet: "ökade med 43 mkr till …"
            if re.match(r"\s*(procentenheter|%-enheter|pe\b|bps|baspunkter|kvartal|månader|dagar|veckor)", after, re.I) \
                    or (re.fullmatch(r"(19|20)\d\d", t.group(0).strip()) and not re.match(OTHER_UNIT, after, re.I)):
                skipped += 1
                if skipped > 2:
                    break
                continue
            v = kpi_number(t.group(0), kind)
            if v is None:
                break
            cur, x, u = None, v[0], None
            if kind == "pct":
                um = re.match(KPI_PCT, after, re.I)
            elif kind == "x":
                um = re.match(KPI_X, after, re.I)
            elif kind == "yr":
                um = re.match(KPI_YR, after, re.I)
            elif kind == "amt":
                u = kpi_unit(after, before)
                um = bool(u)
                if u:
                    x, cur = x * u[0], u[1]
                    v = (x, v[1] * u[0])
            else:  # antal
                um = not re.match(OTHER_UNIT, after, re.I)
            if not um:
                if kind == "n" or re.match(OTHER_UNIT, after, re.I):
                    break  # ett tal med en annan enhet: det här är inte värdet
                skipped += 1
                if skipped > 2:
                    break
                continue
            y = None
            ym = re.match(r"(?:%s)?\s*\(\s*(%s)\s*(?:%%|procent|ggr|gånger|x|år|%s)?\s*\)" % (OTHER_UNIT, KPI_NUM, TEXT_UNIT_RE), after, re.I)
            if ym:
                yv = kpi_number(ym.group(1), kind)
                if yv:
                    y = yv[0] * (u[0] if u else 1)
            out.append((x, v[1], y, cur))
            break
    return out


def kpi_rows(pdf_bytes, words):
    """Nyckeltalsrader i PDF:en, med tal delade efter var de står på sidan (så att "10 051 10 008" blir två tal):
    [(etikett, [värden], halvt steg för första värdet, texten ovanför, rubrikraden ovanför)]. Bara sidor där något av orden står."""
    out = []
    if not pdf_bytes or not pdfium:
        return out
    try:
        pdf = pdfium.PdfDocument(pdf_bytes)
    except Exception:
        return out
    try:
        for pi in range(len(pdf)):
            tp = pdf[pi].get_textpage()
            txt = tp.get_text_range()
            if not re.search(words, txt, re.I):
                continue
            dec = decimal_sep(txt)
            lines = pdf_lines(tp)
            for li, (y, cells) in enumerate(lines):
                label, vals = split_row(cells, dec)
                label = clean_row(label).strip(" ,:")
                nums = [v for v in vals if v[1] is not None]
                if len(nums) >= 3 and re.fullmatch(r"[1-9]\)?", nums[0][2].strip()) and abs(nums[1][1]) >= 100:
                    nums = nums[1:]  # en fotnot som hamnat först bland talen ("Hyresintäkter 1 2 346 2 321")
                if not label or not nums:
                    continue
                first = nums[0][2].strip("()% ")
                dm = re.search(r"[.,](\d{1,2})$", first)
                half = 0.5 * 10 ** -len(dm.group(1)) if dm else 0.5
                # texten ovanför raden (för gruvornas metaller: "Metaller i koncentrat")
                ctx = " ".join(c[2] for _, cs in lines[max(0, li - 14):li] for c in cs)
                # rubrikraden närmast ovanför (för enheten: "Kton Kv3 Kv3 Kv2 Jan-Sep")
                head = next((" ".join(c[2] for c in cs) for _, cs in reversed(lines[max(0, li - 3):li])
                             if not split_row(cs, dec)[1] or re.match(r"\s*(kton|ton|tusen|1 ?000|m3|m³|gwh|twh|mkr|msek)\b", " ".join(c[2] for c in cs), re.I)), "")
                out.append((label, [v[1] for v in nums], half, ctx, head))
    except Exception:
        pass
    finally:
        pdf.close()
    return out


def kpi_table_unit(label):
    m = re.search(r"(?<![a-zåäö])(%s)(?![a-zåäö])" % TEXT_UNIT_RE, label, re.I)
    if m:
        w = m.group(1).lower()
        return next((sc for rx, sc, cur in TEXT_UNITS if re.fullmatch(rx, w, re.I)), None)
    return None


def kpi_figures(body, full, pdf_bytes, group):
    """Branschens nyckeltal ur en kvartalsrapport: {nyckel: {"v": värde, "y": jämförelsetal, "via": …}} och
    produktionsrader {"vol": [[namn, enhet, slag, [värden]]]} som bekräftas av nästa rapport."""
    specs = [s for s in KPIS if group in s[1]]
    if not specs and group not in ("mine", "forest"):
        return None
    pm, pdf = kpi_text(body), kpi_text(full)
    words = "|".join(s[3] for s in specs) + ("|ton|m3|m³|gwh|usd" if group in ("mine", "forest") else "")
    rows = kpi_rows(pdf_bytes, words) if words else []
    tail = r"\s*[,(]?\s*(?:%%|\(%%\)|procent|ggr|gånger|x|år|st|antal|\(antal\)|%s)?\s*\)?\s*$" % TEXT_UNIT_RE
    res = {}
    for key, _, kind, row_rx, word, lo, hi, flow in specs:
        cands = [r for r in rows if re.match(r"(?:%s)%s" % (row_rx, tail), r[0], re.I) and not KPI_BAD_ROW.search(r[0])]
        hits_pm, hits_pdf = kpi_in_text(pm, word, kind, flow), kpi_in_text(pdf, word, kind, flow)
        found = None
        # Bara det första värdet i pressmeddelandet och i rapporten som gäller kvartalet: senare i rapporten handlar
        # texten ofta om ett affärsområde eller ett land ("Räntenettot i Storbritannien minskade till 2 219 mkr").
        def try_hit(x, half, y):
            if not lo <= x <= hi:
                return None
            if flow and x > 0 and any(0 < r[1][0] * sc < x * 0.62 and any(abs(v * sc - x) <= half + 1e-9 for v in r[1][1:])
                                      for r in cands for sc in (1, 1e3, 1e6, 1e9)):
                return "skip"  # talet står längre till höger i en tabell där kvartalet står först: det gäller flera kvartal
            for lab, vals, rhalf, _, _ in cands:
                unit = kpi_table_unit(lab) if kind == "amt" else None
                for sc in ([unit] if unit else [1e3, 1e6, 1e9]) if kind == "amt" else [1]:
                    tol = max(half, rhalf * sc) + 1e-9
                    if abs(vals[0] * sc - x) > tol:
                        continue
                    if y is not None and len(vals) >= 2:
                        if not any(abs(v * sc - y) <= tol for v in vals[1:]):
                            continue
                    elif kind in ("amt", "n") and len(re.sub(r"\D", "", "%g" % abs(vals[0]))) < 3:
                        continue  # ett kort belopp utan jämförelsetal kan träffa av en slump
                    if flow and x > 0 and any(0.2 < v / vals[0] < 0.62 for v in vals[1:4] if v > 0):
                        return "skip"  # tabellen har flera kvartal först och kvartalet längre till höger
                    return vals[0] * sc if rhalf * sc <= half else x  # tabellens tal är ofta mer exakt
            return None
        for src in (hits_pm, hits_pdf):
            tried = 0
            for (x, half, y, cur) in src:
                v = try_hit(x, half, y)
                if v == "skip":
                    continue
                if v is not None:
                    found = {"v": v, "via": "tabell"}
                    if y is not None:
                        found["y"] = y
                    if cur:
                        found["cur"] = cur
                    break
                tried += 1
                if tried >= 2:  # bara de två första värdena i texten (sedan handlar den ofta om ett affärsområde)
                    break
            if found:
                break
        if not found and not cands and hits_pm and hits_pdf:
            for (x, half, y, cur) in hits_pm[:1]:
                if y is None:
                    continue
                if any(abs(x - x2) <= max(half, h2) + 1e-9 and y2 is not None and abs(y - y2) <= max(half, h2) + 1e-9 for x2, h2, y2, _ in hits_pdf[:2]):
                    found = {"v": x, "y": y, "via": "text"}
                    if cur:
                        found["cur"] = cur
                    break
        if found and lo <= found["v"] <= hi:
            res[key] = found
    if group in ("mine", "forest"):
        # Samma rad kan stå i flera tabeller (koncernen först, sedan varje gruva eller division): den första är koncernens
        best, order = {}, []
        for lab, vals, _, ctx, head in rows:
            m, kind = (PRICE_ROW.match(lab), "pris") if group == "mine" else (None, None)
            if not m:
                m, kind = VOL_ROW.match(lab), "vol"
            if not m and group == "mine":
                m, kind = GRADE_ROW.match(lab), "halt"
            unit = m.group("unit") if m else None
            if not m and re.match(r"^[A-Za-zÅÄÖåäö]*(produktion|leveranser)(, [a-zåäö ]+)?$", lab, re.I):
                # enheten står i tabellens rubrik: "Kton Kv3 Kv3 Kv2" ovanför "Råstålsproduktion 1 902 1 813 2 041"
                hm = re.match(r"\s*(%s)\b" % VOL_UNIT, head, re.I)
                if hm:
                    m, kind, unit = True, "vol", hm.group(1)
            if not m or VOL_BAD.search(lab) or len(vals) < 2:
                continue
            name = re.sub(r"\s+", " ", m.group("lab") if m is not True else lab).strip(" ,")
            # gruvornas metall i koncentrat eller smältverkens metall (Boliden har båda, med samma radnamn)
            if kind == "vol" and group == "mine" and not re.search(r"koncentrat|malm|anrik|halt|smält", name, re.I):
                if re.search(r"smält", ctx, re.I):
                    name += " från smältverken"
                elif re.search(r"koncentrat", ctx, re.I):
                    name += " i koncentrat"
            if not name[:1].isupper():
                continue  # en etikett som börjar mitt i ett ord eller en mening ("vindkraft" av "… egen vindkraft")
            if kind == "vol" and any(x[2] == "vol" and x[0].lower().replace(" i koncentrat", "") == name.lower() for x in best.values()):
                continue  # samma metall en gång till (smältverkens "Zink" efter gruvornas "Zink i koncentrat"): oklart vilket
            k = (name.lower(), re.sub(r"\s", "", unit.lower()))
            if k not in best:
                order.append(k)
                best[k] = [name, unit, kind, vals[:8]]
        vol = [best[k] for k in order]
        # "Leveranser" och "Produktion" utan mer: bara om ingen annan rad har samma enhet (SSAB:s plåtleveranser i kton)
        generic = lambda x: re.fullmatch(r"(leveranser|produktion)", x[0], re.I)
        units = {re.sub(r"\s", "", x[1].lower()) for x in vol if not generic(x)}
        vol = [x for x in vol if not generic(x) or re.sub(r"\s", "", x[1].lower()) not in units]
        if vol:
            res["vol"] = vol[:30]
    return res or None


def read_kpis(r, url, group):
    """Läser branschens nyckeltal ur en sparad rapport (pressmeddelandet och rapportens PDF)."""
    page = mfn_get(url, keep=True)
    m = re.search(r'<div class="content s-[a-z]+">(.*?)</article>', page, re.S)
    body = html_text(m.group(1) if m else "")
    pdfs = list(dict.fromkeys([p for p in (r.get("pdf"),) if p] + re.findall(r'<a[^>]+href="(https://[^"]+\.pdf)"', page, re.I)))
    pdf_bytes = cached_fetch(pdfs[0], "application/pdf,*/*") if pdfs and pdfium else None
    k = kpi_figures(body, pdf_text(pdf_bytes), pdf_bytes, group)
    r["kv"] = KPI_VERSION
    if k:
        r["kpi"] = k
    else:
        r.pop("kpi", None)
    tp = text_period(r["date"], body)
    if tp:
        r["tp"] = tp
    else:
        r.pop("tp", None)


SPLIT_YEAR = re.compile(r"\b20\d\d\s*/\s*(?:20)?\d\d\b")


def text_period(pub_date, body):
    """Periodens sista dag enligt pressmeddelandets text: det månadsskifte ("31 juli 2026") som nämns oftast, 3–120 dagar
    före publiceringen. Behövs för bolag med brutet räkenskapsår, där "Q1 2026/2027" är maj–juli och inte januari–mars."""
    pub, counts = dt.date.fromisoformat(pub_date), {}
    for d, mon, y in re.findall(r"\b(\d{1,2})\s+(%s)(?:\s+(\d{4}))?\b" % "|".join(SV_MONTHS), body or "", re.I):
        # utan årtal ("1 maj till 31 juli"): det år som ger ett datum före publiceringen
        for year in ([int(y)] if y else [pub.year, pub.year - 1]):
            try:
                x = dt.date(year, SV_MONTHS.index(mon.lower()) + 1, int(d))
            except ValueError:
                continue
            if (x + dt.timedelta(days=1)).day == 1 and 3 <= (pub - x).days <= 120:
                counts[x] = counts.get(x, 0) + 1
                break
    if not counts:
        return None
    return max(counts, key=lambda x: (counts[x], x)).isoformat()[:7]


def fixed_quarter(r):
    """Kvartalssiffrorna med rätt period: för brutna räkenskapsår ("Q1 2026/2027") gäller textens datum, inte rubrikens
    kvartalsnummer, om rubriken inte själv anger månaderna ("Första kvartalet, maj–juli 2026/27")."""
    q = r.get("q")
    if not q or not r.get("tp") or not SPLIT_YEAR.search(r.get("title") or "") or MONTH_RANGE.search((r.get("title") or "").lower()):
        return q
    return dict(q, p=r["tp"]) if r["tp"] != q.get("p") else q


def report_period(r):
    """Rapportens period ("2026-09"): ur kvartalssiffrorna, annars ur rubriken och datumet."""
    split = SPLIT_YEAR.search(r.get("title") or "") and not MONTH_RANGE.search((r.get("title") or "").lower())
    if split:
        return r.get("tp")  # brutet räkenskapsår: bara textens datum går att lita på
    q = r.get("q")
    if q and q.get("p"):
        return q["p"]
    e = period_end(r["date"], None, r.get("title"))
    return e.isoformat()[:7] if e else None


def month_index(p):
    return int(p[:4]) * 12 + int(p[5:7])


def kpi_doc(reps, group, cur):
    """Nyckeltalen på aktiesidan: senaste värdet per mått och värdena ur tidigare rapporter som en tidsserie.
    reps är bolagets rapporter, nyast först. Produktionsraderna visas bara när två rapporter i följd stämmer med
    varandra: förra rapportens tal står som jämförelsetal i nästa rapport."""
    per = [(report_period(r), u, r) for u, r in reps if r.get("kpi")]
    per = [x for x in per if x[0]]
    if not per or days_since(per[0][2]["date"]) > 200:
        return None
    latest = per[0][0]
    spec = {s[0]: s for s in KPIS}
    vals = {}  # {nyckel: {period: (värde, jämförelsetal, via)}}
    for p, u, r in per:
        for key, val in r["kpi"].items():
            if key in spec and not (val.get("cur") and cur and val["cur"] != cur):
                vals.setdefault(key, {}).setdefault(p, (val["v"], val.get("y"), val["via"]))
    # Kreditförluster: bankerna skriver dem med olika tecken (Handelsbanken -5 för en förlust, Swedbank -701 för
    # återförda reserver). Tecknet bestäms av kreditförlustnivån, som alla skriver positiv för förluster.
    if "kf" in vals:
        signs = [(v[0] > 0) == (vals["kfn"][p][0] > 0) for p, v in vals["kf"].items()
                 if v[0] and p in vals.get("kfn", {}) and abs(vals["kfn"][p][0]) >= 0.01]
        if signs and all(signs):
            pass
        elif signs and not any(signs):
            vals["kf"] = {p: (-v[0], -v[1] if v[1] is not None else None, v[2]) for p, v in vals["kf"].items()}
        else:
            del vals["kf"]
    out = []
    for key in [s[0] for s in KPIS]:
        s = vals.get(key)
        if not s or latest not in s:
            continue  # måttet saknas i senaste rapporten: visas inte
        kind, flow = spec[key][2], spec[key][7]
        # Ett belopp som avviker mycket från bolagets andra kvartal är troligen ett affärsområde eller flera kvartal
        if kind in ("amt", "n") and len(s) >= 3 and key not in ("kf", "netlet", "inflow", "ocf", "mgmt"):
            for p in list(s):
                others = sorted(v[0] for q, v in s.items() if q != p)
                med = others[len(others) // 2]
                if med > 0 and not med / 2.5 <= s[p][0] <= med * 2.5:
                    del s[p]
            if latest not in s:
                continue
        series = {p: v[0] for p, v in s.items()}
        # Flödenas jämförelsetal är samma kvartal året innan, eller kvartalet innan. Det senare syns på att det är
        # samma tal som förra rapporten; annars gäller det året innan.
        if flow:
            for p, v in s.items():
                y = v[1]
                pm = month_index(p) - 3
                pq = "%04d-%02d" % ((pm - 1) // 12, (pm - 1) % 12 + 1)
                if y is None or pq not in s:
                    continue
                if abs(s[pq][0] - y) > max(abs(y) * 0.002, 1e-9):
                    series.setdefault("%04d%s" % (int(p[:4]) - 1, p[4:]), y)
        v0 = s[latest]
        it = {"k": key, "v": v0[0], "via": v0[2], "s": sorted([p, v] for p, v in series.items())[-8:]}
        out.append(it)
    # produktion, leveranser och priser
    vols = {}
    for i in range(len(per) - 1):
        (p1, u1, r1), (p0, u0, r0) = per[i], per[i + 1]
        if not 1 <= month_index(p1) - month_index(p0) <= 3:
            continue
        older = {(n.lower(), un.lower()): v for n, un, k, v in r0["kpi"].get("vol") or []}
        for n, un, k, vv in r1["kpi"].get("vol") or []:
            ov = older.get((n.lower(), un.lower()))
            if not ov or not any(abs(v - ov[0]) <= max(0.5, abs(ov[0]) * 1e-6) for v in vv[1:]):
                continue
            it = vols.setdefault((n.lower(), un.lower()), {"lbl": n, "unit": un, "kind": k, "s": {}})
            it["s"].setdefault(p1, vv[0])
            it["s"].setdefault(p0, ov[0])
    vol_out = []
    for it in vols.values():
        if latest in it["s"]:  # bara rader som är bekräftade i senaste rapporten
            it["s"] = sorted([p, v] for p, v in it["s"].items())[-8:]
            vol_out.append(it)
    if not out and not vol_out:
        return None
    doc = {"g": group, "p": latest, "date": per[0][2]["date"], "title": per[0][2]["title"], "url": per[0][1]}
    if out:
        doc["items"] = out
    if vol_out:
        doc["vol"] = vol_out[:14]
    return doc


def sv_amount(num, unit_word):
    """"18 336" + "Mkr" -> belopp i valutan (kronor), "23,2" + "MdSEK" -> 23,2 miljarder."""
    s = num.replace(" ", "").replace(" ", "")
    if re.fullmatch(r"\d{1,3}(\.\d{3})+", s):
        s = s.replace(".", "")
    s = s.replace(",", ".")
    try:
        v = float(s)
    except ValueError:
        return None
    w = (unit_word or "").lower()
    sc = next((sc for u, sc, cur in TEXT_UNITS if re.fullmatch(u, w, re.I)), None)
    return v * sc if sc else None


THEMES = [
    ("Tullar", r"\btull(ar|arna|en|kostnad\w*|avgift\w*)?\b"), ("AI", r"\bAI\b|artificiell intelligens"), ("Förvärv", r"\bförvärv"),
    ("Efterfrågan", r"efterfrågan"), ("Prishöjningar", r"pris(höjning|ökning)\w*"), ("Besparingar", r"besparing\w*|kostnadsminskning\w*|effektiviseringsprogram|åtgärdsprogram"),
    ("Omstrukturering", r"varsel|omstrukturering\w*|neddragning\w*"), ("Försvar", r"\bförsvar\w*"), ("Elektrifiering", r"elektrifiering|\belbil\w*|\bbatteri\w*"),
    ("Hållbarhet", r"hållbar\w*|koldioxid|utsläpp\w*|klimat\w*"), ("Osäker omvärld", r"\bosäker\w*|geopolitisk\w*"),
    ("Räntor", r"\bränte(läge|höjning\w*|sänkning\w*|nivå\w*)|\bräntor(na)?\b"), ("Kina", r"\bKina\b"), ("USA", r"\bUSA\b|Nordamerika"),
    ("Rekord", r"\brekord\w*"), ("Nya produkter", r"\blanser\w*|nya produkter|ny produkt"), ("Digitalisering", r"\bdigital\w*"),
    ("Lager", r"lagernivå\w*|lageruppbyggnad|lagerneddragning|lagerjustering\w*"), ("Nya marknader", r"nya marknader|etablering\w*|expansion\w*"),
    ("Kunder och avtal", r"\bnya kunder\b|\bramavtal\w*|\bkontrakt\w*"), ("Energi", r"\benergi(priser|kris|omställning)\w*|\belpris\w*"),
]
TONE_POS = re.compile(r"\b(stark\w*|ökade|ökning\w*|förbättr\w*|rekord\w*|tillväxt\w*|växte|växer|positiv\w*|god|goda|gott|högre|framgång\w*|"
                      r"lyckad\w*|glad\w*|stolt\w*|nöjd\w*|robust\w*|solid\w*|solitt|starkt)\b", re.I)
TONE_NEG = re.compile(r"\b(svag\w*|minskade|minskning\w*|försämr\w*|lägre|negativ\w*|utmanande|utmaning\w*|osäker\w*|nedgång\w*|förlust\w*|"
                      r"dämpad\w*|tuff\w*|vikande|nedskrivning\w*|motvind)\b", re.I)


def report_headline(title, body):
    """Bolagets egen sammanfattning av rapporten ("Förbättrad marginal och ökad efterfrågan"), inte bara "Delårsrapport Q3"."""
    report_words = re.compile(r"rapport|kvartal|delår|bokslut|halvår|interim|\bQ[1-4]\b|\bkv\.? ?[1-4]\b|resultat för|januari|september|juni|mars|december|"
                              r"publicerar|offentliggör", re.I)
    cands = []
    parts = re.split(r":\s+|\s+[–-]\s+", title or "")
    cands += parts[1:] + parts[:1]
    first = next((l.strip() for l in body.split("\n") if l.strip()), "")
    cands.append(first)
    for c in cands:
        c = c.strip().strip('"”“').rstrip(".")
        if 15 <= len(c) <= 110 and not report_words.search(c) and swedish(c + " och är av för") and not re.search(r"\d{4}-\d\d", c) \
                and len(re.findall(r"\d+", c)) < 2 \
                and not re.search(r"\b(AB|ASA|Oyj|plc|publ|Group|Holding)\b|^sammanfattning", c, re.I):
            # en nyckeltalsrad ("Orderingång 36 948 Mkr (30 769)") eller ett bolagsnamn är ingen rubrik
            if c == c.upper():
                c = c[:1] + c[1:].lower()
            return c[:1].upper() + c[1:]
    return None


def price_reaction(page, pub_time):
    """Aktiens rörelse den dag rapporten kom (MFN visar den på pressmeddelandet). Bara när rapporten kom före
    börsöppning, annars handlar dagens rörelse inte om rapporten."""
    if not pub_time or pub_time >= "09:00":
        return None
    m = re.search(r'share-price-widget-heading">\s*<div>\s*Kurs\s*</div>\s*<div class="[^"]*">\s*([+-−]?\d+,\d+)%', page)
    if not m:
        return None
    v = float(m.group(1).replace("−", "-").replace(",", "."))
    return v if abs(v) <= 60 else None


def report_text_fields(page, body_html, body, q, full_text=None):
    """Allt som läses ur pressmeddelandets text: rubrik, händelser, utsikter, bankmått, teman, ton, orderingång,
    kassaflöde, organisk tillväxt och börsens reaktion. Teman och ton räknas i hela rapporten om den finns."""
    res = {}
    events, outlook = events_and_outlook(body)
    if events:
        res["events"] = events
    if outlook:
        res["outlook"] = outlook
    bank = bank_figures(body)
    if bank and ("ci" in bank or "cet1" in bank):
        res["bank"] = bank
    # teman: hur ofta bolaget tar upp olika ämnen (bara själva rapporttexten, inte kontaktuppgifter och ansvarsfriskrivning)
    text = re.split(r"för (ytterligare|mer) information|denna information är sådan", body, flags=re.I)[0]
    whole = full_text if full_text and len(full_text) > len(text) and swedish(full_text[:20000]) else text
    counts = [(name, len(re.findall(rx, whole, re.I))) for name, rx in THEMES]
    themes = sorted(((n, c) for n, c in counts if c >= (3 if whole is not text else 1)), key=lambda x: -x[1])[:6]
    if themes and swedish(text):
        res["themes"] = themes
    p, n = len(TONE_POS.findall(whole)), len(TONE_NEG.findall(whole))
    if p + n >= 6 and swedish(text):
        res["tone"] = [p, n]
    t = re.search(r'<div class="publish-date">\s*\d{4}-\d\d-\d\d (\d\d:\d\d)', page)
    react = price_reaction(page, t.group(1) if t else None)
    if react is not None:
        res["react"] = react
    rev = ((q or {}).get("rev") or [None])[0]
    if q and rev and rev > 0:
        orders = order_figures(body, rev, q["cur"], q["m"])
        if orders:
            res["orders"] = orders
        cf = amount_pair(body, r"(?:det )?(?:operativa kassaflöde\w*|kassaflöde\w* från (?:den löpande verksamheten|rörelsen|rörelseverksamheten|löpande verksamhet))",
                         rev, -1.5, 1.5, q["cur"], signed=True)
        if cf:
            res["cash"] = cf
    m = re.search(r"organisk\w*\s+(?:försäljnings|intäkts)?tillväxt\w*\D{0,30}?(-?\d+(?:,\d+)?)\s?(?:%|procent)|"
                  r"(-?\d+(?:,\d+)?)\s?(?:%|procent),?\s+(?:varav\s+\d+\s?%\s+)?organiskt|organisk\w* ökning med\s+(-?\d+(?:,\d+)?)\s?(?:%|procent)", text, re.I)
    if m:
        v = float(next(g for g in m.groups() if g).replace(",", "."))
        if -60 <= v <= 200:
            res["organic"] = v
    return res


def amount_pair(body, word, rev, lo, hi, cur, signed=False):
    """Belopp med jämförelsetal efter ett ord ("Orderingång 18 336 Mkr (13 183)"): [nu, året innan] i valutan."""
    N = r"-?\d{1,3}(?:[  .]\d{3})+(?:,\d+)?|-?\d+(?:,\d+)?" if signed else r"\d{1,3}(?:[  .]\d{3})+(?:,\d+)?|\d+(?:,\d+)?"
    U = TEXT_UNIT_RE
    pre = r"^(?:[^()\d\n]|\d+(?:[,.]\d+)?\s?(?:%|procent))*?"
    patterns = [re.compile(pre + r"(?P<unit>%s)\s*(?P<x>%s)\s*\(\s*(?P<y>%s)\s*\)" % (U, N, N), re.I),
                re.compile(pre + r"(?P<x>%s)\s*(?P<unit>%s)\s*\(\s*(?P<y>%s)\s*\)" % (N, U, N), re.I),
                re.compile(pre + r"(?P<x>%s)\s*\(\s*(?P<y>%s)\s*\)\s*(?P<unit>%s)" % (N, N, U), re.I)]
    for m in re.finditer(r"\b%s\b([^\n]{0,120})" % word, body, re.I):
        rest = m.group(1)
        if re.match(r"\s+i\s+[A-ZÅÄÖ]", rest) or re.match(r"\s+(i fast valuta|organisk|exklusive|justerad|per aktie)", rest, re.I):
            continue
        a = next((p.search(rest) for p in patterns if p.search(rest)), None)
        if not a:
            continue
        unit = a.group("unit")
        if cur != "SEK" and cur.lower() not in unit.lower():
            return None
        v, p = sv_amount(a.group("x").replace("−", "-"), unit), sv_amount(a.group("y").replace("−", "-"), unit)
        if v is not None and p is not None and lo <= v / rev <= hi and v != 0:
            return [round(v), round(p)]
        return None
    return None


def order_figures(body, rev, cur, months):
    """Orderingång och orderstock för kvartalet: [nu, året innan]. Bara om beloppet står med enhet och jämförelsetal
    och är rimligt stort jämfört med kvartalets omsättning (annars är det troligen niomånaderssiffran)."""
    N = r"\d{1,3}(?:[  .]\d{3})+(?:,\d+)?|\d+(?:,\d+)?"
    U = TEXT_UNIT_RE
    pre = r"^(?:[^()\d\n]|\d+(?:[,.]\d+)?\s?(?:%|procent))*?"  # "ökade 29 % till"
    patterns = [re.compile(pre + r"(?P<unit>%s)\s*(?P<x>%s)\s*\(\s*(?P<y>%s)\s*\)" % (U, N, N), re.I),   # MSEK 52 338 (40 517)
                re.compile(pre + r"(?P<x>%s)\s*(?P<unit>%s)\s*\(\s*(?P<y>%s)\s*\)" % (N, U, N), re.I),   # 18 336 Mkr (13 183)
                re.compile(pre + r"(?P<x>%s)\s*\(\s*(?P<y>%s)\s*\)\s*(?P<unit>%s)" % (N, N, U), re.I)]   # 14 129 (13 392) MSEK
    out = {}
    for key, word, lo, hi in (("in", r"orderingång(?:en)?", 0.2, 5), ("book", r"orderstock(?:en)?", 0.2, 40)):
        for m in re.finditer(r"\b%s\b([^\n]{0,120})" % word, body, re.I):
            rest = m.group(1)
            if re.match(r"\s+i\s+[A-ZÅÄÖ]", rest) or re.match(r"\s+(i fast valuta|organisk|exklusive|justerad)", rest, re.I):
                continue  # ett affärsområde, eller bara en procentsats
            a = next((p.search(rest) for p in patterns if p.search(rest)), None)
            if not a:
                continue
            unit, x, y = a.group("unit"), a.group("x"), a.group("y")
            if cur != "SEK" and cur.lower() not in unit.lower():
                break
            v, p = sv_amount(x, unit), sv_amount(y, unit)
            if v and p and lo <= v / rev <= hi:
                out[key] = [round(v), round(p)]
            break
    return out or None


SEG_HEAD = re.compile(r"^(?P<metric>(justerad |justerat |underliggande )?(nettoomsättning|intäkter|omsättning|försäljning|försäljningsintäkter|net sales|revenues?|"
                      r"rörelseresultat|ebita|ebit|operating (profit|income)))\b.{0,40}?\b(per|by|för|fördelat på|och \w+ per)\s+(affärsområde|segment|division|"
                      r"rörelsesegment|verksamhetsområde|business area|affärsenhet)", re.I)
SEG_SKIP = re.compile(r"varav|i % av|^%|marginal|organisk|förändring|tillväxt|^-|valuta", re.I)
SEG_TOTAL = re.compile(r"^(summa|totalt?|koncernen|gruppen|group|total)\b|(koncernen|group|totalt|total)\s*\d?\)?$", re.I)
SEG_NOT = re.compile(r"eliminer|koncerngemensam|gruppgemensam|gemensamma|centrala|corporate|moderbolag|avyttrade|avvecklade|justering|övriga poster|"
                     r"ofördelad|oallokerad|ej allokerad|unallocated", re.I)


def read_segments(pdf_bytes, q):
    """Affärsområdenas försäljning och resultat för kvartalet ur rapportens tabeller ("Intäkter per affärsområde").
    Kolumnen väljs så att affärsområdenas summa blir kvartalets omsättning (som redan är kontrollerad)."""
    if not pdf_bytes:
        return None
    rev_q, ebit_q = q["rev"][0], (q.get("ebit") or [None])[0]
    pdf = pdfium.PdfDocument(pdf_bytes)
    tables = []
    try:
        for pi in range(len(pdf)):
            tp = pdf[pi].get_textpage()
            txt = tp.get_text_range()
            if not re.search(r"affärsområde|segment|division|business area|affärsenhet|verksamhetsområde", txt, re.I):
                continue
            dec = decimal_sep(txt)
            lines = pdf_lines(tp)
            for i, (y, cells) in enumerate(lines):
                head = " ".join(c[2] for c in cells)
                m = SEG_HEAD.match(head)
                if not m or len(head) > 110 or re.search(r"marginal|%", head):
                    continue
                kind = "rev" if re.search(r"omsättning|intäkter|försäljning|sales|revenue", m.group("metric"), re.I) else "profit"
                rows, total, misses, first = [], None, 0, None
                for j in range(i + 1, min(len(lines), i + 45)):
                    lab, vals = split_row(lines[j][1], dec)
                    t = " ".join(c[2] for c in lines[j][1])
                    if SEG_HEAD.match(t) and j > i + 1:
                        break
                    nums = [v for v in vals if v[1] is not None and not v[3]]
                    if not lab or not vals:
                        misses += 1
                        if misses > 3 and rows:
                            break
                        continue
                    misses = 0
                    if re.fullmatch(r"(msek|mkr|sek ?m|tkr|tsek|ksek|meur|teur|keur|eur ?m|%)( \(per kvartal\))?", lab, re.I):
                        continue  # rubrikraden med enheten
                    first = first if first is not None else j
                    lab = re.sub(r"\s*\d\)$|\s*[¹²³*]+$", "", lab).strip()
                    if SEG_SKIP.search(lab):
                        continue
                    if SEG_TOTAL.search(lab):
                        total = vals
                        break
                    if nums:
                        rows.append((lab, vals))
                if len(rows) >= 2:
                    headers = " ".join(c[2] for _, cs in lines[i:first or i + 1] for c in cs)
                    unit = next(((sc, cur) for rx, sc, cur in UNIT_HDR if rx.search(head + " " + headers + " " + txt[:3000])), None)
                    tables.append({"kind": kind, "metric": re.sub(r"\s+", " ", m.group("metric")).strip(), "rows": rows, "total": total,
                                   "lines": lines, "i": i, "first": first, "unit": unit})
    finally:
        pdf.close()

    def at(vals, x):
        return next((v[1] for v in vals if abs(v[0] - x) <= 14 and not v[3]), None)

    found = by_rows(tables, rev_q, ebit_q, q, at)
    return found or by_columns(pdf_bytes, rev_q, q)


def seg_result(q, names, revs, profits, metric):
    total = sum(revs)
    items = []
    for n, r, p in zip(names, revs, profits):
        if p is not None and abs(p) > r:
            p = None
        items.append([n, round(r), round(p) if p is not None else None, round(r / total, 4), round(p / r, 4) if p is not None else None,
                      1 if re.match(r"övrig|other", n, re.I) else 0])
    metric = re.sub(r"\s+", " ", metric or "").strip()
    if re.fullmatch(r"(segmentets |segmentens )?(rörelseresultat|operating (profit|income))", metric, re.I):
        metric = "Rörelseresultat"
    metric = metric.upper() if metric.lower() in ("ebita", "ebit") else metric[:1].upper() + metric[1:]
    return {"p": q["p"], "m": q["m"], "metric": metric, "items": items}


SEG_REV_ROW = re.compile(r"^(extern(a)? |summa |total )?(nettoomsättning|intäkter|omsättning|försäljning|försäljningsintäkter|net sales|revenues?)"
                         r"( från externa kunder| externt| extern| totalt| total)?$|^intäkter från externa kunder$", re.I)
SEG_PROFIT_ROW = re.compile(r"^(segmentets |segmentens )?(justerad |justerat )?(rörelseresultat|ebita|ebit|operating (profit|income)|resultat)( per segment)?$", re.I)


def by_columns(pdf_bytes, rev_q, q):
    """Affärsområden som kolumner ("Rapportering per division": en kolumn per division, raderna Nettoomsättning och
    Rörelseresultat). Kolumnerna där summan blir kvartalets omsättning är affärsområdena."""
    pdf = pdfium.PdfDocument(pdf_bytes)
    try:
        for pi in range(len(pdf)):
            tp = pdf[pi].get_textpage()
            txt = tp.get_text_range()
            if not re.search(r"affärsområde|segment|division|business area|affärsenhet", txt, re.I):
                continue
            dec = decimal_sep(txt)
            lines = pdf_lines(tp)
            unit = next(((sc, cur) for rx, sc, cur in UNIT_HDR if rx.search(txt)), None)
            for i, (y, cells) in enumerate(lines):
                lab, vals = split_row(cells, dec)
                lab = clean_row_label(lab)
                if not SEG_REV_ROW.match(lab):
                    continue
                pts = [(v[0], v[1]) for v in vals if v[1] is not None and not v[3]]
                if len(pts) < 3:
                    continue
                for sc in ((unit[0],) if unit else (1e6, 1e3, 1e9)):
                    # en totalkolumn (koncernen) och kolumnerna före den, eller alla kolumner
                    k = next((j for j, (x, v) in enumerate(pts) if abs(v * sc - rev_q) <= 0.015 * rev_q), None)
                    seg_pts = pts[:k] if k is not None and k >= 2 else pts if abs(sum(v for _, v in pts) * sc - rev_q) <= 0.015 * rev_q else None
                    if not seg_pts or len(seg_pts) < 2:
                        continue
                    xs = [x for x, _ in seg_pts]
                    table_left = cells[0][0]
                    label_right = max(c[1] for c in cells if c[1] < xs[0] - 2) if any(c[1] < xs[0] - 2 for c in cells) else None
                    heads = header_columns(lines, i, xs, table_left, label_right)
                    names = [re.sub(r"\b(\w+)( \1\b)+", r"\1", re.sub(r"\s+", " ", heads[x]).strip()) for x in xs]
                    # perioder eller tal i rubriken betyder att kolumnerna inte är affärsområden
                    if any(not n or classify_header(n)[1] or classify_header(n)[2] or re.search(r"\d", n) for n in names):
                        continue
                    keep = [j for j, n in enumerate(names) if not SEG_NOT.search(n) and not SEG_TOTAL.search(n) and seg_pts[j][1] > 0]
                    if len(keep) < 2 or len(set(names)) < len(names):
                        continue
                    # det som inte är affärsområden (centralt, elimineringar) får inte vara en stor del av försäljningen
                    if sum(v for t, (x, v) in enumerate(seg_pts) if t not in keep and v > 0) * sc > 0.1 * rev_q:
                        continue
                    # resultatraden längre ned i samma tabell
                    profits, metric = [None] * len(keep), None
                    for j in range(i + 1, min(len(lines), i + 30)):
                        plab, pvals = split_row(lines[j][1], dec)
                        plab = clean_row_label(plab)
                        if SEG_PROFIT_ROW.match(plab):
                            cand = [next((v[1] for v in pvals if abs(v[0] - xs[t]) <= 14 and not v[3]), None) for t in keep]
                            if all(c is not None for c in cand):
                                profits, metric = [c * sc for c in cand], plab
                                break
                    return seg_result(q, [names[t] for t in keep], [seg_pts[t][1] * sc for t in keep], profits, metric)
    finally:
        pdf.close()
    return None


def by_rows(tables, rev_q, ebit_q, q, at):
    def columns(t):
        xs = sorted({round(v[0]) for _, vals in t["rows"] for v in vals})
        cl = []
        for x in xs:
            if cl and x - cl[-1][-1] <= 14:
                cl[-1].append(x)
            else:
                cl.append([x])
        return [sum(c) / len(c) for c in cl]

    for t in (t for t in tables if t["kind"] == "rev"):
        for x in columns(t):
            # "–" betyder noll (en avyttrad verksamhet), och ett affärsområde utan värde i kolumnen är inte med
            vals_all = [at(vals, x) or 0 for _, vals in t["rows"]]
            segs = [(n, vals) for n, vals in t["rows"] if not SEG_NOT.search(n) and at(vals, x)]
            if len(segs) < 2 or not any(vals_all):
                continue
            total = at(t["total"], x) if t["total"] else None
            for sc in ((t["unit"][0],) if t["unit"] else (1e6, 1e3, 1e9, 1)):
                ok = (total is not None and abs(total * sc - rev_q) <= 0.015 * rev_q) or abs(sum(vals_all) * sc - rev_q) <= 0.015 * rev_q
                if not ok:
                    continue
                seg_rev = {n: at(vals, x) * sc for n, vals in segs}
                if any(v <= 0 for v in seg_rev.values()) or rev_q - sum(seg_rev.values()) > 0.1 * rev_q:
                    break  # det som inte är affärsområden får inte vara en stor del av försäljningen
                # resultatet: samma kolumn i en resultattabell med samma affärsområden, eller en resultatkolumn i samma tabell
                profit, metric = {}, None
                for pt in (p for p in tables if p["kind"] == "profit"):
                    names = {n: vals for n, vals in pt["rows"]}
                    if not all(n in names for n, _ in segs):
                        continue
                    if pt["lines"] is t["lines"] or len(columns(pt)) == len(columns(t)):
                        cand = {n: at(names[n], x) for n, _ in segs}
                        if all(v is not None for v in cand.values()):
                            profit, metric = {n: v * sc for n, v in cand.items()}, pt["metric"]
                            break
                    if pt["total"] and ebit_q:
                        for px in columns(pt):
                            tv = at(pt["total"], px)
                            if tv is not None and abs(tv * sc - ebit_q) <= 0.03 * abs(ebit_q):
                                cand = {n: at(names[n], px) for n, _ in segs}
                                if all(v is not None for v in cand.values()):
                                    profit, metric = {n: v * sc for n, v in cand.items()}, pt["metric"]
                                break
                    if profit:
                        break
                if not profit:
                    # Trelleborg: "Extern | Intern | Summa | EBITA" i samma tabell
                    head_cells = [c for _, cs in t["lines"][t["i"] + 1:t["first"]] for c in cs]
                    pcol = next(((c[0] + c[1]) / 2 for c in head_cells if re.fullmatch(r"(justerad |justerat )?(ebita|ebit|rörelseresultat)", c[2], re.I)), None)
                    if pcol:
                        cand = {n: at(vals, pcol) for n, vals in segs}
                        if all(v is not None for v in cand.values()):
                            profit, metric = {n: v * sc for n, v in cand.items()}, next(c[2] for c in head_cells if abs((c[0] + c[1]) / 2 - pcol) < 1)
                total_rev = sum(seg_rev.values())
                items = []
                for n, _ in segs:
                    r, p = seg_rev[n], profit.get(n)
                    if p is not None and abs(p) > r:
                        p = None
                    items.append([n, round(r), round(p) if p is not None else None, round(r / total_rev, 4),
                                  round(p / r, 4) if p is not None else None, 1 if re.match(r"övrig|other", n, re.I) else 0])
                metric = metric or ""
                if re.fullmatch(r"rörelseresultat|operating (profit|income)", metric, re.I):
                    metric = "Rörelseresultat"
                return {"p": q["p"], "m": q["m"], "metric": metric.upper() if metric.lower() in ("ebita", "ebit") else metric[:1].upper() + metric[1:],
                        "items": items}
    return None


def sane_quarter(q, annual):
    """Sista kontrollen av ett kvartal mot årsredovisningen (valuta, omsättning). Ett stort bolags kvartal som inte går
    ihop med helåret visas inte alls, och en jämförelsekolumn som egentligen är helåret tas bort."""
    if not annual or annual[0] != q["cur"] or not annual[1] or annual[1] <= 0:
        return q
    a, rev = annual[1], q.get("rev") or [None, None]
    if rev[0] and a >= 1e9 and not 1 / 3 <= rev[0] * 12 / q["m"] / a <= 3:
        return None
    if q["m"] == 3 and rev[0] and rev[1] and 0.7 <= rev[1] / a <= 1.4 and rev[1] / rev[0] > 2.5:
        q = dict(q)
        for k in ("rev", "ebit", "net", "eps"):
            if q.get(k):
                q[k] = [q[k][0], None]
    return q


def nav_doc(reps, prices, name):
    """Substansvärdet på aktiesidan: det senaste ur rapporterna, rabatten som rapporten själv anger (om den stämmer
    med en kurs samma dag) och rabatten räknad mot fondernas kvartalskurs för den rapport som gäller samma dag.
    reps är bolagets rapporter, nyast först, och prices {kvartalsslut: (kvartal, kurs)} för just den här aktien."""
    if re.search(r"(\bser\.?\s*|[\s-])d$|\bpref\b|preferens", (name or "").strip(), re.I):
        return None  # D-aktier och preferensaktier har en fast utdelning, inte en del av substansvärdet per stamaktie
    found = [(u, r) for u, r in reps if (r.get("nav") or {}).get("end") and days_since(r["date"]) <= 200]
    if not found:
        return None
    u, r = found[0]
    n = r["nav"]
    out = {"end": n["end"], "date": r["date"], "url": u, "title": r["title"]}
    if n.get("ltv") is not None:
        out["ltv"], out["ltvVia"] = n["ltv"], n["ltvVia"]
    latest_px = prices[max(prices)][1] if prices else None
    if "v" in n and (not latest_px or 0.2 <= latest_px / n["v"] <= 5):
        out.update({"k": n["k"], "lbl": n["lbl"], "v": n["v"], "via": n["via"]})
        if n.get("disc") is not None:
            fi = prices.get(n["end"])
            if n.get("discVia") == "pris" or (fi and abs((fi[1] / n["v"] - 1) * 100 - n["disc"]) <= 1.5):
                out["disc"] = n["disc"]
        same = [(u2, r2["nav"], r2["date"]) for u2, r2 in found if r2["nav"].get("v") and r2["nav"].get("lbl") == n["lbl"]]
        # Kvartalskursen (fondernas rapporter till FI) mot substansvärdet samma dag
        for u2, n2, d2 in same:
            if n2["end"] in prices:
                qid, px = prices[n2["end"]]
                if 0.2 <= px / n2["v"] <= 5:
                    out["calc"] = {"q": qid, "end": n2["end"], "px": px, "v": n2["v"], "disc": round((px / n2["v"] - 1) * 100, 1), "url": u2, "date": d2}
                break
        hist = {}
        for _, n2, _ in same:
            hist.setdefault(n2["end"], n2["v"])
        if len(hist) >= 2:
            out["hist"] = sorted([e, v] for e, v in hist.items())
    return out if "v" in out or "ltv" in out else None


def sane_segments(seg):
    """Affärsområden ur kvartalsrapporten som går att visa: riktiga namn (inte "Miljoner euro", "Kvartal" eller
    flera rubriker som klistrats ihop) och avstavningar ihopsatta ("Commun- ications")."""
    if not seg:
        return None
    items = [list(i) for i in seg["items"]]
    for i in items:
        i[0] = re.sub(r"(\w)- (?=[a-zåäö])", r"\1", i[0]).strip()
    names = [i[0] for i in items]
    if any(re.match(r"(miljoner|tusen|msek|mkr|tkr|meur|teur|kvartal|nettoomsättning|intäkter|försäljning|förvärv|organisk|valuta|summa|totalt|"
                    r"jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec)\b", n, re.I) or len(n) < 2 or len(n) > 60 for n in names):
        return None
    for a in names:
        if any(b != a and len(b) >= 4 and b in a for b in names) and len(a.split()) >= 2:
            return None  # "Husvagnar Tillbehör Husbilar": rubriker som hamnat i samma cell
    return dict(seg, items=items)


def calendar_facts(cal, ticker):
    """Nästa rapport, nästa årsstämma och utdelningarna det senaste året ur MFN-kalendern."""
    today = TODAY.isoformat()
    out = {}
    cal = sorted(cal)
    for d, text in cal:
        if d >= today and "next" not in out and re.match(r"(kvartalsrapport|bokslutskommuniké|delårsrapport|halvårsrapport)", text, re.I):
            out["next"] = [d, text]
        if d >= today and "agm" not in out and re.match(r"årsstämma", text, re.I):
            out["agm"] = d
    divs, years = [], {}
    year_ago = (TODAY - dt.timedelta(days=380)).isoformat()
    for d, text in cal:
        m = re.match(r"x-dag (ordinarie |extra |bonus|halvårs|kvartals|special|extra)?(?:utdelning)\s+(.+?)\s+([\d.,]+)(?:\s+([A-Z]{3}))?$", text, re.I)
        if not m or not ticker or m.group(2).strip().upper() != ticker.upper():
            continue
        kind = "extra" if m.group(1) and m.group(1).strip().lower() in ("extra", "bonus", "special") else "ord"
        amount = float(m.group(3).replace(",", "."))
        cur = m.group(4) or "SEK"
        # utdelning per år (ordinarie och extra var för sig), för historiken
        y = years.setdefault(d[:4], [0, 0, cur])
        y[0 if kind == "ord" else 1] += amount
        if amount > 0 and d >= year_ago:
            divs.append([d, amount, cur, kind])
    if divs:
        out["div"] = sorted(divs)
    hist = [[int(y), round(v[0], 2), round(v[1], 2)] for y, v in sorted(years.items()) if v[0] + v[1] > 0 or y < max(years)]
    if len(hist) >= 3:
        out["divHist"] = hist
    return out


def share_ticker(tickers, stock_name):
    """Kortnamnet för just den här aktien ("VOLV B") bland bolagets aktieslag."""
    if len(tickers) == 1:
        return tickers[0]
    m = re.search(r"(?:\bser\.?\s*|\bclass\s+|[\s-])([A-D])(?:\s+shs)?$", stock_name or "", re.I)
    if m:
        same = [t for t in tickers if t.upper().endswith(" " + m.group(1).upper())]
        if len(same) == 1:
            return same[0]
    return None


def company_facts_from_text(desc, about):
    f = {}
    for text in (about or "", desc or ""):
        if "founded" not in f:
            y = re.search(r"(?:grundades|grundad|grundat|grundlades|startades|bildades|skapades)\D{0,80}?\b(1[5-9]\d\d|20[0-2]\d)\b", text)
            if y:
                f["founded"] = int(y.group(1))
        if "hq" not in f:
            h = re.search(r"[Hh]uvudkontor(?:et)?\s+(?:ligger\s+|finns\s+|är\s+beläget\s+)?i\s+([A-ZÅÄÖ][\wåäöé\-]+(?:\s[A-ZÅÄÖ][\wåäöé\-]+)?)", text)
            if h and h.group(1) not in ("Sverige", "Sweden", "Norge", "Danmark", "Finland", "Europa", "Norden"):
                f["hq"] = h.group(1)
    # "närmare 100.000 medarbetare", "cirka 23 400 anställda"
    e = re.search(r"(?:cirka|ca\.?|omkring|närmare|drygt|över|knappt|runt|nästan)?\s*(\d{1,3}(?:[  .]\d{3})+|\d{2,6})\s+(?:medarbetare|anställda)", about or "")
    if e:
        n = int(re.sub(r"\D", "", e.group(1)))
        if n >= 5:
            f["employees"] = n
    w = re.search(r"\b(www\.[a-z0-9\-]+(?:\.[a-z0-9\-]+)+)", about or "", re.I)
    if w and not re.search(r"cision|mfn\.se|nasdaq|outlook", w.group(1), re.I):
        f["web"] = "https://" + w.group(1).lower().rstrip(".")
    return f


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
    ap.add_argument("--max-mfn", type=int, default=250, help="högst så många bolagssidor på MFN per körning")
    ap.add_argument("--max-interim", type=int, default=80, help="högst så många nya kvartalsrapporter per körning")
    ap.add_argument("--interim-depth", type=int, default=4, help="så många av de senaste kvartalsrapporterna läses per bolag")
    ap.add_argument("--reinterim", action="store_true", help="läs om sparade kvartalsrapporter ur --raw-cache (efter att INTERIM_VERSION höjts)")
    ap.add_argument("--retext", action="store_true", help="läs bara om pressmeddelandenas text ur --raw-cache (snabbt, utan PDF:erna)")
    ap.add_argument("--max-nav", type=int, default=80, help="högst så många rapporter per körning läses om för substansvärdet")
    ap.add_argument("--max-kpi", type=int, default=150, help="högst så många rapporter per körning läses för branschens nyckeltal")
    ap.add_argument("--health", default=None, help="fil där hälsokollen sparas (problem blir ett ärende på GitHub)")
    args = ap.parse_args()
    global FILE_CACHE
    FILE_CACHE = args.raw_cache
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
    reports = state.setdefault("reports", {})   # per LEI: senast lästa årsredovisning och resultatet
    mfn = state.setdefault("mfn", {})           # per bolag på MFN: kalender, beskrivning och kvartalsrapporterna
    # Wikidata och Wikipedia används inte längre
    state.pop("wiki", None)
    for s in st.values():
        for k in ("wd", "wdChecked", "wdNameChecked"):
            s.pop(k, None)

    def out_of_time():
        return time.time() - started > args.max_minutes * 60

    def save_state():
        # sparas också under körningen, så att inget går förlorat om den avbryts
        tmp = state_file + ".tmp"
        json.dump(state, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        os.replace(tmp, state_file)

    index = json.load(open(os.path.join(args.out, "index.json"), encoding="utf-8"))
    latest = index["quarters"][0]["id"]
    qd = json.load(open(os.path.join(args.out, latest + ".json"), encoding="utf-8"))
    stocks = {s[0]: s[1] for s in qd["stocks"] if s[0].startswith("SE")}
    if args.only:
        stocks = {i: stocks.get(i, i) for i in args.only.split(",")}
    print("  %d svenska aktier" % len(stocks))
    # Kursen vid de senaste kvartalssluten (fondernas rapporter till FI), för substansrabatten: {ISIN: {datum: (kvartal, kurs)}}
    prices = {}
    for qi in index["quarters"][:4]:
        y, n = int(qi["id"][:4]), int(qi["id"][-1])
        qend = dt.date(y, n * 3, 28) + dt.timedelta(days=4)
        qend -= dt.timedelta(days=qend.day)
        path = os.path.join(args.out, qi["id"] + ".json")
        if not os.path.exists(path):
            continue
        for row in (qd if qi["id"] == latest else json.load(open(path, encoding="utf-8")))["stocks"]:
            if row[0] in stocks and row[3]:
                prices.setdefault(row[0], {})[qend.isoformat()] = (qi["id"], row[3])

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
    # (också när tolkningen ändrats, men högst 40 % av tiden, så att kvartalsrapporterna på MFN hinns med)
    due = sorted((l for l in leis if args.reparse or days_since(reports.get(l, {}).get("checked")) > 7
                  or (reports.get(l, {}).get("data") and reports[l].get("v") != PARSER_VERSION)),
                 key=lambda l: (l in reports, reports.get(l, {}).get("checked", "")))
    checks = downloads = 0

    def slim_of(lei, end, url):
        """Rapporten i liten form, ur --raw-cache eller hämtad. None om den inte gick att hämta (försöks igen nästa gång),
        False om den inte gick att läsa."""
        nonlocal downloads
        raw_path = os.path.join(args.raw_cache, lei + "-" + end + ".slim.json") if args.raw_cache else None
        if raw_path and os.path.exists(raw_path):
            return json.load(open(raw_path, encoding="utf-8"))
        if args.reparse and args.raw_cache:
            return None
        try:
            body = fetch("https://filings.xbrl.org" + url, timeout=180)
        except Exception as e:
            print("  %s: kunde inte hämta rapporten (%s)" % (lei, e))
            return None
        downloads += 1
        if not body:
            return False
        try:
            slim = slim_report(json.loads(body))
        except ValueError:
            print("  %s: rapporten gick inte att läsa" % lei)
            return False
        if raw_path:
            os.makedirs(args.raw_cache, exist_ok=True)
            json.dump(slim, open(raw_path, "w", encoding="utf-8"), ensure_ascii=False)
        return slim

    for lei in due:
        if out_of_time() or checks >= args.max_checks or downloads >= args.max_reports or time.time() - started > args.max_minutes * 60 * 0.4:
            break
        rep = reports.setdefault(lei, {})
        checks += 1
        try:
            r = fetch_json("https://filings.xbrl.org/api/entities/%s/filings?sort=-period_end&page%%5Bsize%%5D=20" % lei)
        except Exception as e:
            print("  %s: kunde inte hämta rapportlistan (%s)" % (lei, e))
            continue
        rep["checked"] = TODAY.isoformat()
        files = [f["attributes"] for f in (r or {}).get("data", []) if f["attributes"].get("json_url")]
        if not files:
            continue
        # En rapport per år: den svenska om det finns, annars den första
        by_end = {}
        for x in files:
            by_end.setdefault(x["period_end"], []).append(x)
        for same in by_end.values():
            same.sort(key=lambda x: not re.search(r"[-_]sv\.json$", x["json_url"]))
        rep["files"] = [[e, by_end[e][0]["json_url"]] for e in sorted(by_end, reverse=True)[:OLD_REPORTS + 1]]
        newest_end = files[0]["period_end"]
        f = by_end[newest_end][0]
        if rep.get("file") == f["json_url"] and rep.get("v") == PARSER_VERSION and not args.reparse:
            continue
        slim = slim_of(lei, newest_end, f["json_url"])
        if not slim:
            continue
        try:
            res = read_report(slim, newest_end)
        except Exception as e:
            print("  %s: fel vid tolkning (%s)" % (lei, e))
            continue
        res["url"] = "https://filings.xbrl.org" + f["viewer_url"] if f.get("viewer_url") else None
        rep.update({"file": f["json_url"], "v": PARSER_VERSION, "data": res})
        time.sleep(0.3)
    print("  Rapporter: %d kontrollerade, %d nedladdade, %d bolag med rapport" % (checks, downloads, sum(1 for l in leis if reports.get(l, {}).get("data"))))

    # 3. MFN: bolaget, kalendern och kvartalsrapporterna
    if pdfium is None:
        print("  pypdfium2 saknas: kvartalsrapporternas siffror läses inte")
    for isin in stocks:
        s = st.setdefault(isin, {})
        if out_of_time():
            break
        if s.get("mfn") or (days_since(s.get("mfnChecked")) <= 30 and s.get("mfnByName")):
            continue
        try:
            c = mfn_company(isin, stocks.get(isin))
            s["mfnByName"] = True
        except Exception as e:
            print("  %s: kunde inte söka på MFN (%s)" % (isin, e))
            if network_error(e):
                break
            continue
        s["mfnChecked"] = TODAY.isoformat()
        if c:
            s["mfn"] = c["slug"]
            mfn.setdefault(c["slug"], {})["tickers"] = c["tickers"]
        if sum(1 for x in st.values() if x.get("mfnChecked") == TODAY.isoformat()) % 50 == 0:
            save_state()
    slugs = sorted({st[i]["mfn"] for i in stocks if st.get(i, {}).get("mfn")})
    # Årets omsättning ur årsredovisningen, för att kontrollera kvartalets
    annual = {}
    for i in stocks:
        rep = reports.get(st.get(i, {}).get("lei") or "-", {}).get("data") or {}
        rev = (rep.get("fin") or {}).get("rev", [None])[0]
        if rev and st[i].get("mfn"):
            annual[st[i]["mfn"]] = rev
    fresh = {}
    if state.get("mfnRun") and not out_of_time():
        try:
            fresh = mfn_fresh_slugs(min(state["mfnRun"], (TODAY - dt.timedelta(days=3)).isoformat()))
        except Exception as e:
            print("  Kunde inte hämta MFN:s senaste rapporter (%s)" % e)
    today = TODAY.isoformat()

    def priority(slug):
        m = mfn.get(slug, {})
        checked = m.get("checked")
        if not checked:
            return 1
        # en rapport på MFN som inte är inläst än (även om bolaget redan kollats tidigare samma dag)
        if fresh.get(slug, set()) - {r["date"] for r in (m.get("reports") or {}).values()}:
            return 0
        if checked < today and any(checked <= d <= today for d, t in m.get("cal", [])
                                   if re.match(r"(kvartalsrapport|bokslutskommuniké|delårsrapport|halvårsrapport)", t, re.I)):
            return 0  # kalendern säger att en rapport har kommit
        # annars en gång i veckan, så att kalendern (nästa rapport, utdelning) hålls aktuell
        return 2 if days_since(checked) > 7 else None

    due = sorted((p, s) for s, p in ((s, priority(s)) for s in slugs) if p is not None)
    pages = interims = failures = failed_pages = empty_pages = 0
    if args.retext:
        due = []
        for slug in slugs:
            for url, r in ((mfn.get(slug) or {}).get("reports") or {}).items():
                try:
                    refresh_text_fields(r, url)
                    interims += 1
                except Exception as e:
                    print("  %s: fel vid tolkning (%s)" % (url, e))
    if args.reinterim:
        # Läs om de sparade kvartalsrapporterna (ur --raw-cache) utan att hämta bolagssidorna igen
        due = []
        for slug in slugs:
            reps = (mfn.get(slug) or {}).get("reports") or {}
            for url, r in list(reps.items()):
                if r.get("v") == INTERIM_VERSION or out_of_time():
                    continue
                item = {"url": url, "date": r["date"], "title": r["title"], "pdfs": [r["pdf"]] if r.get("pdf") else []}
                try:
                    nr = read_interim(item, annual.get(slug))
                except Exception as e:
                    print("  %s: fel vid tolkning (%s)" % (url, e))
                    continue
                nr["v"] = INTERIM_VERSION
                reps[url] = nr
                interims += 1
    for _, slug in due:
        if out_of_time() or pages >= args.max_mfn:
            break
        if failures >= 10:
            print("  MFN svarar inte (nätet borta?), resten tas nästa gång")
            break
        try:
            pg = mfn_page(slug)
            if sum(1 for i in pg["items"] if not NOT_INTERIM.search(i["title"])) < 2:
                # bolag som bara skriver på engelska
                dates = {i["date"] for i in pg["items"]}
                pg["items"] += [i for i in mfn_page(slug, "en")["items"] if i["date"] not in dates]
        except Exception as e:
            print("  %s: kunde inte hämta bolagssidan på MFN (%s)" % (slug, e))
            failures += 1
            failed_pages += 1
            continue
        failures = 0
        pages += 1
        if not pg["items"] and not pg.get("desc"):
            empty_pages += 1  # sidan gick att hämta men innehöll varken rapporter eller beskrivning
        if pages % 25 == 0:
            save_state()
        m = mfn.setdefault(slug, {})
        m.update({"checked": today, "cal": pg["cal"], "desc": pg.get("desc"), "industry": pg.get("Industri"), "list": pg.get("Lista")})
        reps = m.setdefault("reports", {})
        chosen, dates = [], set()
        for it in sorted((i for i in pg["items"] if not NOT_INTERIM.search(i["title"])), key=lambda i: i["date"], reverse=True):
            if it["date"] not in dates:  # en rapport per dag (den svenska om båda finns)
                dates.add(it["date"])
                chosen.append(it)
        for it in chosen[:args.interim_depth]:
            if reps.get(it["url"], {}).get("v") == INTERIM_VERSION:
                continue
            if out_of_time() or interims >= args.max_interim:
                break
            try:
                r = read_interim(it, annual.get(slug))
            except Exception as e:
                print("  %s: fel vid tolkning (%s)" % (it["url"], e))
                if network_error(e):
                    failures += 1
                    break  # försöks igen nästa gång
                r = {"date": it["date"], "title": it["title"]}
            r["v"] = INTERIM_VERSION
            reps[it["url"]] = r
            interims += 1
        for k in sorted(reps, key=lambda k: reps[k]["date"], reverse=True)[8:]:
            del reps[k]
    # Substansvärdet i investment- och fastighetsbolagens tre senaste rapporter, för rapporter som lästes innan det
    # fanns (eller när NAV_VERSION höjts). Nya rapporter får det redan i read_interim.
    navs = 0
    for slug in slugs:
        m = mfn.get(slug) or {}
        if m.get("industry") not in NAV_INDUSTRIES or out_of_time() or navs >= args.max_nav or failures >= 10:
            continue
        for url, r in sorted((m.get("reports") or {}).items(), key=lambda x: x[1]["date"], reverse=True)[:3]:
            if r.get("navv") == NAV_VERSION or navs >= args.max_nav:
                continue
            try:
                refresh_nav(r, url)
            except Exception as e:
                print("  %s: substansvärdet gick inte att läsa (%s)" % (url, e))
                if network_error(e):
                    failures += 1
                    break
                r["navv"] = NAV_VERSION
            navs += 1
    # Branschens nyckeltal i bolagens sparade rapporter: först den senaste rapporten för alla bolag, sedan den
    # näst senaste, osv. Nya rapporter (och alla när KPI_VERSION höjts) läses på det här sättet.
    kpis = 0
    for depth in range(8):
        for slug in slugs:
            m = mfn.get(slug) or {}
            group = kpi_group(m.get("industry"))
            reps = sorted((m.get("reports") or {}).items(), key=lambda x: x[1]["date"], reverse=True)
            if not group or len(reps) <= depth or out_of_time() or kpis >= args.max_kpi or failures >= 10:
                continue
            url, r = reps[depth]
            if r.get("kv") == KPI_VERSION or days_since(r["date"]) > 750:
                continue
            try:
                read_kpis(r, url, group)
            except Exception as e:
                print("  %s: nyckeltalen gick inte att läsa (%s)" % (url, e))
                if network_error(e):
                    failures += 1
                    continue
                r["kv"] = KPI_VERSION
            kpis += 1
    with_kpi = sum(1 for s in slugs if any(r.get("kpi") for r in (mfn.get(s, {}).get("reports") or {}).values()))
    print("  Branschens nyckeltal: %d rapporter lästa, %d bolag med nyckeltal" % (kpis, with_kpi))
    if not out_of_time():
        state["mfnRun"] = today
    with_q = sum(1 for s in slugs if any(r.get("q") for r in (mfn.get(s, {}).get("reports") or {}).values()))
    print("  MFN: %d bolag, %d sidor hämtade, %d nya kvartalsrapporter, %d bolag med kvartalssiffror" % (len(slugs), pages, interims, with_q))
    with_nav = sum(1 for s in slugs if any((r.get("nav") or {}).get("v") for r in (mfn.get(s, {}).get("reports") or {}).values()))
    print("  Substansvärde: %d rapporter lästa om, %d bolag med substansvärde" % (navs, with_nav))

    # Hälsokoll: fungerar hämtningen och läsningen fortfarande? Problemen blir ett ärende på GitHub (se update.yml).
    problems = []
    if pdfium is None:
        problems.append("PDF-läsaren pypdfium2 saknas, så inga kvartalssiffror läses.")
    if failed_pages >= 5 and failed_pages > pages:
        problems.append("MFN svarade inte: %d bolagssidor gick inte att hämta (%d gick bra)." % (failed_pages, pages))
    if pages >= 5 and empty_pages >= 0.8 * pages:
        problems.append("MFN:s sidor ser annorlunda ut: %d av %d bolagssidor saknade både rapporter och beskrivning." % (empty_pages, pages))
    # Bolag som enligt kalendern rapporterade för 2–6 dagar sedan ska ha fått sina siffror inlästa
    lo, hi = (TODAY - dt.timedelta(days=6)).isoformat(), (TODAY - dt.timedelta(days=2)).isoformat()
    expected = [s for s in slugs if any(lo <= d <= hi for d, t in (mfn.get(s, {}).get("cal") or [])
                                        if re.match(r"(kvartalsrapport|bokslutskommuniké|delårsrapport|halvårsrapport)", t, re.I))]
    read_ok = [s for s in expected if any(lo <= r["date"] <= hi and r.get("q") for r in (mfn.get(s, {}).get("reports") or {}).values())]
    if len(expected) >= 8 and len(read_ok) < 0.25 * len(expected):
        problems.append("Kvartalsrapporterna läses inte: bara %d av %d bolag som rapporterat de senaste dagarna fick sina siffror inlästa." % (len(read_ok), len(expected)))
    health = {"date": today, "pages": pages, "failedPages": failed_pages, "emptyPages": empty_pages, "newReports": interims,
              "expected": len(expected), "readOk": len(read_ok), "withQuarter": with_q, "problems": problems}
    if args.health:
        json.dump(health, open(args.health, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    for p in problems:
        print("  LARM: " + p)

    # 3b. Äldre årsredovisningar, för kassaflöde och lönsamhet över flera år. Läses en gång (de ändras inte) och efter
    # MFN, så att nya kvartalsrapporter alltid går före. Först den näst senaste för alla bolag, sedan den före den, osv.
    old_read = 0
    for depth in range(1, OLD_REPORTS + 1):
        for lei in leis:
            rep = reports.get(lei) or {}
            if not rep.get("data") or len(rep.get("files") or []) <= depth:
                continue
            end, url = rep["files"][depth]
            old = rep.setdefault("old", {})
            if old.get(end, {}).get("v") == PARSER_VERSION and old[end].get("file") == url and not args.reparse:
                continue
            if out_of_time() or downloads >= args.max_reports * 2:
                break
            slim = slim_of(lei, end, url)
            if slim is None:
                continue
            try:
                res = read_report(slim, end) if slim else {}
            except Exception as e:
                print("  %s: fel vid tolkning av %s (%s)" % (lei, end, e))
                res = {}
            old[end] = {"v": PARSER_VERSION, "file": url, "cur": res.get("cur"), "hist": res.get("hist") or {}}
            old_read += 1
    for lei in leis:
        rep = reports.get(lei) or {}
        keep = {e for e, _ in (rep.get("files") or [])[1:]}
        for end in list(rep.get("old") or {}):
            if end not in keep:
                del rep["old"][end]
    print("  Äldre årsredovisningar: %d lästa, %d bolag med minst tre år" % (
        old_read, sum(1 for l in leis if len((history(reports.get(l) or {}) or {}).get("fy", [])) >= 3)))

    # 4. En fil per aktie, plus placering bland alla bolag (störst försäljning, flest anställda, äldst)
    merged = {}
    for isin in stocks:
        s = st.get(isin, {})
        rep = reports.get(s.get("lei") or "-", {})
        rep = dict(rep["data"], hist=history(rep)) if rep.get("data") else None
        for k in ("hist", "custFin"):
            if rep and not rep.get(k):
                rep.pop(k, None)
        mm = mfn.get(s.get("mfn") or "-") or {}
        reps = sorted(((u, r) for u, r in (mm.get("reports") or {}).items()), key=lambda x: x[1]["date"], reverse=True)
        recent = [(u, r) for u, r in reps if days_since(r["date"]) <= 200]
        about = next(((u, r["about"]) for u, r in reps if r.get("about") and swedish(r["about"])), None)
        f = company_facts_from_text(mm.get("desc"), about[1] if about else None)
        if f.get("employees"):
            f["employees"] = [f["employees"], int(mm["reports"][about[0]]["date"][:4])]
        emp = (rep or {}).get("fin", {}).get("employees", [None])[0]
        if emp:
            f["employees"] = [round(emp), rep["fy"]]
        ceo = next((r["ceo"] for u, r in recent[:2] if r.get("ceo")), None)
        if ceo:
            f["ceo"] = ceo
        if mm.get("industry"):
            f["industry"] = mm["industry"]
        if mm.get("list"):
            f["list"] = mm["list"]
        if not rep and not recent and not f:
            continue
        merged[isin] = {"lei": s.get("lei"), "report": rep, "facts": f, "mm": mm, "reps": reps, "recent": recent, "about": about,
                        "slug": s.get("mfn")}

    by_company = {}
    for isin, m in merged.items():
        by_company.setdefault(m["lei"] or m["slug"] or isin, m)
    def rank(getter):
        vals = sorted(((getter(m), k) for k, m in by_company.items() if getter(m) is not None), reverse=True)
        return {k: [n + 1, len(vals)] for n, (_, k) in enumerate(vals)}
    rev_rank = rank(lambda m: m["report"]["fin"]["rev"][0] if m["report"] and m["report"]["cur"] == "SEK" and m["report"]["fin"].get("rev", [None])[0] else None)
    emp_rank = rank(lambda m: m["facts"].get("employees", [None])[0])
    age_rank = rank(lambda m: -m["facts"]["founded"] if m["facts"].get("founded") else None)

    written = set()
    for isin, m in merged.items():
        key = m["lei"] or m["slug"] or isin
        doc = {"built": TODAY.isoformat()}
        if m["report"]:
            doc["report"] = m["report"]
        if m["facts"]:
            doc["facts"] = m["facts"]
        # Beskrivningen med bolagets egna ord: ur pressmeddelandet, annars ur årsredovisningen
        if m["about"]:
            doc["about"] = {"text": first_sentences(tidy_about(m["about"][1]), 600), "src": "pm", "url": m["about"][0]}
        elif m["report"] and m["report"].get("about"):
            doc["about"] = {"text": m["report"]["about"], "src": "ar", "url": m["report"].get("url")}
        elif m["mm"].get("desc") and len(m["mm"]["desc"]) >= 80 and m["slug"]:
            # bolagsbeskrivningen på MFN, när bolaget inte har någon egen i pressmeddelanden eller årsredovisning
            doc["about"] = {"text": first_sentences(m["mm"]["desc"], 600), "src": "mfn", "url": MFN + "/all/a/" + m["slug"]}
        # Senaste kvartalet (bara om rapporten är från det senaste halvåret) och kvartalen innan
        annual_rev = None
        if m["report"] and (m["report"].get("fin") or {}).get("rev", [None])[0]:
            annual_rev = (m["report"]["cur"], m["report"]["fin"]["rev"][0])
        checked = {u: sane_quarter(fixed_quarter(r), annual_rev) for u, r in m["reps"] if r.get("q")}
        latest = next(((u, r) for u, r in m["recent"] if checked.get(u)), None)
        if latest:
            u, r = latest
            q = dict(checked[u], title=r["title"], date=r["date"], url=u)
            if r.get("quote") and latest == m["recent"][0]:
                q["quote"] = r["quote"]
            for k in ("events", "outlook", "orders", "bank", "headline", "themes", "tone", "cash", "organic"):
                if r.get(k):
                    q[k] = r[k]
            if r.get("react") is not None:
                q["react"] = r["react"]
            doc["q"] = q
            # Börsens reaktion på de senaste rapporterna
            reacts = [[x["date"], x["react"]] for _, x in m["reps"] if x.get("react") is not None][:6]
            if len(reacts) >= 2:
                doc["reacts"] = reacts
            # Affärsområdena senaste kvartalet (samma valuta och samma rapport som siffrorna ovan)
            if r.get("seg") and r["seg"]["p"] == r["q"]["p"] and sane_segments(r["seg"]):
                doc["qseg"] = dict(sane_segments(r["seg"]), p=q["p"])
            pts = {}
            for x in (checked.get(u) for u, _ in m["reps"]):
                if x and x["m"] == 3 and x["cur"] == q["cur"] and x["p"] not in pts:
                    pts[x["p"]] = [x.get(k, [None])[0] for k in ("rev", "ebit", "net")]
            for xq in (checked.get(u) for u, _ in m["reps"]):
                if xq and xq["m"] == 3 and xq["cur"] == q["cur"]:
                    prev = "%04d%s" % (int(xq["p"][:4]) - 1, xq["p"][4:])
                    pts.setdefault(prev, [xq.get(k, [None, None])[1] for k in ("rev", "ebit", "net")])
            series = [[p] + v for p, v in sorted(pts.items())][-8:]
            if len(series) >= 4:
                doc["qs"] = series
        nav = nav_doc(m["reps"], prices.get(isin, {}), stocks.get(isin))
        if nav:
            doc["nav"] = nav
        group = kpi_group(m["mm"].get("industry"))
        if group:
            kcur = doc["q"]["cur"] if doc.get("q") else (m["report"] or {}).get("cur") or "SEK"
            kpi = kpi_doc(m["reps"], group, kcur)
            if kpi:
                doc["kpi"] = kpi
        cal = calendar_facts(m["mm"].get("cal") or [], share_ticker(m["mm"].get("tickers") or [], stocks.get(isin)))
        if cal:
            doc["cal"] = cal
        if m["slug"]:
            doc["mfn"] = m["slug"]
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
    # Teckningsoptioner, rätter och interimsaktier ("Qliro AB Right 2026", "ALZECURE BTA 26") får moderbolagets fakta
    by_name = {}
    for isin in written:
        by_name.setdefault(plain_name(stocks.get(isin)), isin)
    for isin, name in stocks.items():
        if isin in written:
            continue
        want = plain_name(base_name(name))
        parent = by_name.get(want)
        if not parent:
            cands = [i for n, i in by_name.items() if same_company(want, n)]
            parent = cands[0] if len(cands) == 1 else None
        if parent and parent != isin:
            src = os.path.join(out_dir, parent + ".json")
            doc = json.load(open(src, encoding="utf-8"))
            doc["parent"] = parent
            doc.pop("nav", None)  # rabatten gäller moderbolagets aktie, inte rätten eller interimsaktien
            open(os.path.join(out_dir, isin + ".json"), "w", encoding="utf-8").write(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
            written.add(isin)
    if not args.only:
        for name in os.listdir(out_dir):
            # bara svenska aktier; de amerikanska byggs av scripts/build-us-companies.py
            if name.startswith("SE") and name.endswith(".json") and name[:-5] not in written:
                os.remove(os.path.join(out_dir, name))
    # Vilka aktier som har en fil, så att sajten inte frågar efter filer som inte finns
    have = sorted(n[:-5] for n in os.listdir(out_dir) if n.endswith(".json") and not n.startswith("_"))
    json.dump({"built": TODAY.isoformat(), "isins": have}, open(os.path.join(out_dir, "_index.json"), "w", encoding="utf-8"), separators=(",", ":"))
    save_state()
    with_seg = sum(1 for m in by_company.values() if m["report"] and m["report"].get("seg"))
    with_geo = sum(1 for m in by_company.values() if m["report"] and m["report"].get("geo"))
    print("  Klart: %d aktier har bolagsfakta, %d bolag med affärsområden, %d med länder (%.0f s)" % (len(written), with_seg, with_geo, time.time() - started))


if __name__ == "__main__":
    sys.exit(main())
