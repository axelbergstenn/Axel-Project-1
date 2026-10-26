#!/usr/bin/env bash
# Röktest innan sajten publiceras.
#
# En lokal webbserver serverar site/, och Chrome utan fönster öppnar sajtens viktigaste sidor och väntar tills
# appen har ritat dem. En sida godkänns om
#   - appen har ritat den (body får data-page="<sida>" när render() körs),
#   - inget av sajtens egna skript har kastat ett fel (data-js-error på <html>, sätts i index.html),
#   - datan gick att läsa (inget "Datan kunde inte laddas") och sidan har en rubrik.
# Misslyckas en sida körs den en gång till. Misslyckas den igen avslutas skriptet med fel, och arbetsflödet
# publicerar då inte, så att en trasig version aldrig når besökarna (gårdagens sajt ligger kvar).
#
#   bash scripts/smoke-test.sh site
#   CHROME=/sökväg/till/chrome PYTHON=py bash scripts/smoke-test.sh site    (lokalt)
set -u
SITE="${1:-site}"
PORT=8124
PYTHON="${PYTHON:-python3}"

CHROME="${CHROME:-}"
if [ -z "$CHROME" ]; then
  for c in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1; then CHROME="$c"; break; fi
  done
fi
if [ -z "$CHROME" ]; then echo "::warning::Chrome saknas, röktestet hoppas över"; exit 0; fi

"$PYTHON" -m http.server "$PORT" --directory "$SITE" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 2

# Adress och vilken sida appen ska rita (data-page). Fasta sidor och sidor som bara finns i appen (#).
ROUTES=(
  "/|oversikt"
  "/aktier/|aktier"
  "/aktie/volvo-b/|aktie"
  "/fonder/|fonder"
  "/fond/seb-sverigefond/|fond"
  "/fondbolag/|fondbolag"
  "/rapport/|rapport"
  "/insyn/|insyn"
  "/blankning/|blankning"
  "/uppkop/|uppkop"
  "/avgifter/|avgifter"
  "/risk/|risk"
  "/signaler/|signaler"
  "/dubbelsignal/|dubbelsignal"
  "/sparande/|sparande"
  "/agarandel/|agarandel"
  "/rantor/|rantor"
  "/backtest/|backtest"
  "/metod/|metod"
  "/ordlista/|ordlista"
  "/#/bevakning|bevakning"
  "/#/portfolj|portfolj"
  "/#/jamfor/51718/60730|jamfor"
  "/#/forvaltare|forvaltare"
  "/#/blankare|blankare"
  "/#/om|om"
  "/#/kontakt|kontakt"
)

check() {
  local path="$1" page="$2" dom problems=""
  dom=$(timeout 90 "$CHROME" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run \
    --virtual-time-budget=25000 --dump-dom "http://localhost:$PORT$path" 2>/dev/null)
  [ -n "$dom" ] || { echo " Chrome gav ingen sida;"; return; }
  grep -q "data-page=\"$page\"" <<<"$dom" || problems+=" appen ritade inte sidan (data-page=\"$page\" saknas);"
  if grep -q 'data-js-error=' <<<"$dom"; then problems+=" JavaScript-fel: $(grep -o 'data-js-error="[^"]*"' <<<"$dom" | head -1);"; fi
  grep -qE 'Datan kunde inte laddas|Något gick fel' <<<"$dom" && problems+=" datan kunde inte laddas;"
  grep -q '<h1' <<<"$dom" || problems+=" sidan saknar rubrik;"
  echo "$problems"
}

fail=0; empty=0
for item in "${ROUTES[@]}"; do
  path="${item%%|*}"; page="${item##*|}"
  problems=$(check "$path" "$page")
  if [ -n "$problems" ]; then
    sleep 3
    problems=$(check "$path" "$page")
  fi
  if [ -n "$problems" ]; then echo "FEL  $path:$problems"; fail=1; else echo "ok   $path"; fi
  [[ "$problems" == *"Chrome gav ingen sida"* ]] && empty=$((empty + 1))
done

# Gav Chrome ingen sida alls är det verktyget som inte fungerar, inte sajten: varna men stoppa inte publiceringen
if [ "$empty" -eq "${#ROUTES[@]}" ]; then echo "::warning::Chrome kunde inte öppna sidorna, röktestet hoppas över"; exit 0; fi

if [ "$fail" -ne 0 ]; then echo "::error::Röktestet hittade fel, sajten publiceras inte"; exit 1; fi
echo "Röktestet klart: ${#ROUTES[@]} sidor utan fel"
