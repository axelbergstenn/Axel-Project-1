# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Fondinsyn (www.fondinsyn.se) är en statisk sajt på GitHub Pages som visar vad svenska fonder köper och säljer. Repot heter axelbergstenn/Axel-Project-1 på GitHub. Ägaren skriver på svenska; svara på svenska och skriv kodkommentarer och commit-meddelanden på svenska, som resten av repot.

## Kommandon

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/serve.ps1     # lokal server på http://localhost:8765 (launch.json: "fondfloden")
node --check site/assets/app.js                                          # syntaxkontroll efter varje JS-ändring
pwsh scripts/build-data.ps1 -History 1 -HistoryQuarters 2                # snabb lokal databyggnad (FI-zippar cachas i .cache/)
powershell -File scripts/build-pages.ps1 -WriteHome                      # statiska sidor, sitemap, delningsbilder (körs efter versionsnumret i CI)
py scripts/build-companies.py --raw-cache .cache/bolag --only SE0000115446   # "Känn bolaget" för ett bolag
CHROME=... PYTHON=py bash scripts/smoke-test.sh site                     # röktestet som stoppar publicering
```

- Lokalt finns Windows PowerShell 5.1 (CI kör pwsh 7). Python heter `py`, inte `python3`; kör `py`, inte `py -I`, eftersom pypdfium2 ligger i användarens site-packages. Sätt `PYTHONIOENCODING=utf-8`.
- Det finns inga enhetstester. Verifiering sker i webbläsaren: ladda om förhandsvisningen, läs konsolfel och `data-js-error` på `<html>`, och kontrollera att `document.documentElement.scrollWidth` inte är större än fönstret (ingen sidledsscroll).

## Arkitektur

**Publicering.** `.github/workflows/update.yml` körs 05, 11 och 17 UTC, vid push till `main` och manuellt. Datastegen körs i ordning: build-data → build-rates → build-shares → build-companies → build-flows → build-shorts → build-insider → build-perf → validate-data. Sedan committas `site/data` och `data`, versionsnumret sätts (`__VERSION__` i index.html och app.js), därefter körs build-pages, PDF:erna byggs, röktestet körs och `site/` publiceras. Körningarna 11 och 17 (`MIDDAY=true`) hoppar över nyhetsbrev, bevakningsmejl, release, PDF och IndexNow. Datakommittar kommer från github-actions-boten, så `git pull --rebase` före push.

**Committad eller genererad data.** Kvartalsfiler (`site/data/<Q>.json`, `<Q>-rates*.json`) och `site/data/bolag/` committas. Allt som ändras dagligen och alla sidor som byggs av build-pages är gitignorerade (se `.gitignore`); ändra dem inte för hand.

**Klienten.** `site/assets/app.js` är en enda IIFE utan beroenden.
- Hash-routing: `route()` och `render()` väljer en `view*()`-funktion per sida, och `body[data-page]` sätts per sida.
- Vyerna bygger HTML som strängar. Ett `"` i fel citatnivå förstör hela sajten tyst, så kör `node --check`.
- Data laddas lat via `need(key, fn)`, och `render()` körs om när den kommit.
- Diagram registreras med `chart(draw)` och ritas efter att HTML:en satts in, med `FFCharts` i `charts.js` (SVG, färger från CSS-klasser).
- Händelser hanteras centralt med delegering på `document`, till exempel `data-rep-pick` och `id="repQ"`.

**Statiska sidor.** `scripts/build-pages.ps1` skapar en sida per aktie, fond, fondbolag och så vidare utifrån `site/index.html` (med `<base href="/">`), plus sitemap, RSS, delningsbilder (SVG→PNG med rsvg-convert) och sökdata. Appen tar över sidan när den laddats; `body[data-route]` talar om vilken vy den ska rita.

**"Känn bolaget"** (`scripts/build-companies.py`).
- Källor: endast bolagens egna rapporter. Det är MFN (mfn.se) och ESEF-årsredovisningar via filings.xbrl.org. **Använd aldrig Wikipedia eller Wikidata.**
- Kvartalssiffror läses ur rapport-PDF:erna med pypdfium2 och sparas bara om pressmeddelandet eller årsomsättningen bekräftar dem.
- MFN:s robots.txt förbjuder `*.json`, så använd HTML-sidorna.
- Höj `INTERIM_VERSION` eller `PARSER_VERSION` för att läsa om allt. Läget sparas i `data/bolag-state.json`.
- Om hämtningen slutar fungera öppnas ett ärende på GitHub (`scripts/company-alarm.sh`).

## Design

Ägarens designregler finns i `CLAUDEwebdesign copy.md` (ligger bara lokalt). Viktigast:

- **Grundstil:** skogsgrön och SEB-inspirerad.
  - Grågrön bakgrund (`--canvas`) med vita ytor ovanpå.
  - Skogsgrönt (`--navy` #0c2e23, `--brand` #0e6b4e) är enda accentfärgen.
  - Kvartalets rubrik är en skogsgrön panel överst på startsidan, med kvartalets största köp och sälj som staplar.
- **Upp är blått (`--pos`) och ner rött (`--neg`), aldrig grönt för upp.**
- **Typsnitt:** rubriker och stora tal i Schibsted Grotesk med proportionella siffror, text och tabeller i Inter Tight. Båda ligger på sajten själv i `site/assets/fonts`. TTF-filerna för delningsbilderna ligger i `scripts/fonts`.
- **Färger:** använd tokens i `:root` och `:root[data-theme="dark"]` i `style.css`, inga hårdkodade färger. Mörkt läge ska alltid fungera.
- **Förbjudet:** lila, toningar i rubriker, glas och oskärpa, rader med stora meningslösa siffror, emoji i rubriker, etiketter i versaler med spärrning, och sex likadana kort i rad.
- **Mobil:** ingen sidledsscroll någonstans. Testa på 375, 768, 1024 och 1440 px, i ljust och mörkt läge.
- Visa en lokal förhandsvisning med skärmbilder innan en visuell ändring publiceras.

## Arbetssätt

- Bekräfta innan något publiceras utåt eller inte går att ångra. Skicka aldrig mejl automatiskt; nyhetsbrev och bevakningsmejl skapas som utkast.
- Inloggningar och hemligheter sköter ägaren själv.
- Committa med e-post `338019774+axelbergstenn@users.noreply.github.com`.
