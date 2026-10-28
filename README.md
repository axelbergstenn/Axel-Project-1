# Fondinsyn

Insyn i svenska fonder: vilka aktier de köper och säljer, vad de kostar, hur lika de är och vilka bolag de ägde när uppköpsbud kom. Allt bygger på [Finansinspektionens öppna data](https://www.fi.se/sv/vara-register/fondinnehav-per-kvartal/).

**Sajten:** https://www.fondinsyn.se/

## Funktioner

- **Översikt** – mest köpta och sålda aktier, längsta köp- och säljsviter, nya och avvecklade innehav.
- **Aktier** – alla svenska eller utländska aktier som fonderna äger, med historik sedan 2018.
- **Fonder** – varje fonds affärer, avgift, aktiva risk, aktiv andel, koncentration och avkastning (Pensionsmyndigheten). Alla fondbolag med samlade affärer.
- **Förvaltare** – vad Sveriges kända aktiva fonder har köpt och sålt, och var de är överens.
- **Avgifter** – aktiv risk mot avgift för alla aktiefonder, med indexnära fonder som tar ut höga avgifter.
- **Kvartalsrapport** – en automatiskt skriven sammanfattning av kvartalet, med prenumeration på nyhetsbrev via Buttondown.
- **Blankning** – mest blankade aktier, blankarna och förändringar från FI:s blankningsregister, uppdateras dagligen och kopplas till fondernas köp.
- **Uppköp** – offentliga uppköpserbjudanden från FI:s prospektregister med pris, premie och vilka fonder som ägde bolaget.
- **Min portfölj, Jämför, Sök och Bevakning** – genomlysning av egna fonder, överlapp mellan fonder, snabbsök och bevakningslista.

## Struktur

```
site/                       Den statiska sajten (publiceras med GitHub Pages)
  index.html
  assets/app.js             Klientlogik, inga beroenden
  assets/charts.js          SVG-diagram
  assets/style.css
  data/index.json           Lista över byggda kvartal
  data/2026Q2.json          Svenska aktier, jämfört med kvartalet innan, + nyckeltal för alla fonder
  data/2026Q2-world.json    Utländska aktier
  data/history-se.json      Ägande och nettoköp per svensk aktie för alla kvartal sedan 2018
  data/history-world.json   Samma för utländska aktier
  data/perf.json            Avkastning från Pensionsmyndigheten (byggs vid varje körning)
  data/offers.json          Uppköpserbjudanden (målbolag, pris, premie, ägande fonder)
  data/shorts.json          Blankning (byggs vid varje körning, sparas inte i git)
scripts/
  build-data.ps1            Hämtar FI:s zip-filer och bygger site/data
  build-shorts.ps1          Hämtar blankningsregistret och bygger site/data/shorts.json
  build-perf.ps1            Hämtar avkastning från Pensionsmyndighetens öppna fonddata
  validate-data.ps1         Stoppar publiceringen om datan ser fel ut
  newsletter.ps1            Skapar utkast till kvartalets nyhetsbrev hos Buttondown
  serve.ps1                 Lokal webbserver för utveckling
.github/workflows/
  update.yml                Hämtar ny data varje dag och publicerar sajten
```

## Utveckling

Bygg data (laddar ner det som saknas till `.cache/`). Historiken läser alla kvartal, vilket tar en stund första gången:

```bash
pwsh scripts/build-data.ps1 -History 4
```

Snabbare lokalt test med bara två kvartal i historiken:

```bash
pwsh scripts/build-data.ps1 -History 1 -HistoryQuarters 2
```

Starta en lokal server och öppna http://localhost:8765:

```bash
pwsh scripts/serve.ps1
```

Skripten fungerar även i Windows PowerShell 5.1 (`powershell -File ...`).

## Automatisk uppdatering

GitHub Actions kör `update.yml` tre gånger om dagen (kl. 05, 11 och 17 UTC), vid varje push till `main` och manuellt via fliken Actions. Arbetsflödet:

1. Läser vilka kvartal FI har publicerat och bygger de fyra senaste kvartalen och historiken om FI har publicerat nya versioner av källfilerna.
2. Hämtar det som ändras oftare: räntor, insynshandel, blankning, fondsparande, avkastning och bolagens kvartalsrapporter (MFN).
3. Kontrollerar datan och committar det som ändrats till repot.
4. Bygger de statiska sidorna, delningsbilderna och kvartalsrapporterna som PDF, och kör ett röktest i Chrome.
5. Publicerar `site/` till GitHub Pages. Misslyckas röktestet ligger den förra versionen kvar.

Körningarna kl. 11 och 17 är till för bolagens kvartalsrapporter samma dag. Nyhetsbrev, bevakningsmejl, release och PDF görs bara på morgonen. FI:s zip-filer cachas mellan körningar.

## Metod

- Nettoköp = förändring i antal aktier × kurs vid senaste kvartalsslut.
- Endast fonder som rapporterat båda kvartalen ingår i förändringarna.
- Aktier som är nya eller har försvunnit helt ur fonderna (noteringar, avknoppningar, uppköp) redovisas separat.
- Aktiesplittar upptäcks när minst tre fonder (och minst 15 %) har exakt samma förändringskvot långt från 1.
- Utländska aktier tas med när svenska fonder sammanlagt äger minst 20 mkr. Obligationer och fondandelar filtreras bort.
- Indexnära med hög avgift: aktiefond med aktiv risk under 3 % och förvaltningsavgift på minst 0,7 %.

## Uppköp

Erbjudandehandlingar hämtas från [FI:s prospektregister](https://www.fi.se/sv/vara-register/prospektregistret/). Målbolag, pris och premie läses ur de första sidorna med `pdftotext` (poppler-utils), som installeras i GitHub Actions och finns i Git för Windows. Varje dokument läses en gång; resultatet sparas i `site/data/offers.json`.

## Nyhetsbrev

1. Skapa ett gratiskonto på [Buttondown](https://buttondown.com).
2. Sätt `NEWSLETTER` i `site/assets/app.js` till ditt Buttondown-användarnamn, så visas prenumerationsrutan.
3. Lägg in din API-nyckel från Buttondown som repo-hemlighet `BUTTONDOWN_API_KEY` (Settings → Secrets and variables → Actions). Då skapas ett utkast automatiskt när ett nytt kvartal kommer. Utkastet skickas aldrig av sig självt.
