#!/usr/bin/env bash
# Skriver ut kvartalsrapporterna som PDF med Chrome utan fönster.
#
# Körs i arbetsflödet efter build-pages.ps1, när site/rapport/<kvartal>/ finns. En lokal webbserver
# serverar site/, och Chrome öppnar varje rapport (svenska och utländska aktier) med ?pdf i adressen,
# så att appen hoppar över animationer. Utskriftsstilen i style.css ger A4-sidor.
#
#   site/rapport/2026-q2/fondinsyn-2026-q2.pdf
#   site/rapport/2026-q2/fondinsyn-2026-q2-utland.pdf
#   site/data/reports-pdf.json   ["2026-q2", "2026-q2-utland", ...] (läses av sajten)
#
# Misslyckas en rapport hoppas den över och listas inte, så sajten länkar då till webbversionen.
set -u
SITE="${1:-site}"
PORT=8123

CHROME=""
for c in google-chrome google-chrome-stable chromium chromium-browser; do
  if command -v "$c" >/dev/null 2>&1; then CHROME="$c"; break; fi
done
if [ -z "$CHROME" ]; then echo "Chrome saknas, inga PDF:er"; exit 0; fi

python3 -m http.server "$PORT" --directory "$SITE" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 2

done_list=()
for dir in "$SITE"/rapport/*/; do
  slug=$(basename "$dir")
  [[ "$slug" =~ ^[0-9]{4}-q[1-4]$ ]] || continue
  for variant in "" "utland"; do
    if [ -n "$variant" ]; then
      [ -f "$dir/utland/index.html" ] || continue
      url="http://localhost:$PORT/rapport/$slug/utland/?pdf=1"
      name="$slug-utland"
    else
      url="http://localhost:$PORT/rapport/$slug/?pdf=1"
      name="$slug"
    fi
    out="$dir/fondinsyn-$name.pdf"
    # Fönstret är ungefär lika brett som en A4-sida, och virtual-time-budget låter appen hämta datan och rita klart
    timeout 120 "$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
      --window-size=760,1100 --virtual-time-budget=30000 --run-all-compositor-stages-before-draw \
      --no-pdf-header-footer --print-to-pdf-no-header --print-to-pdf="$out" "$url" >/dev/null 2>&1
    size=$(stat -c %s "$out" 2>/dev/null || echo 0)
    if [ "$size" -gt 20000 ]; then
      done_list+=("\"$name\"")
      echo "  $name: $((size / 1024)) kB"
    else
      echo "  $name: misslyckades"
      rm -f "$out"
    fi
  done
done

(IFS=,; echo "[${done_list[*]:-}]") > "$SITE/data/reports-pdf.json"
echo "PDF:er: ${#done_list[@]}"
