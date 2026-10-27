#!/usr/bin/env bash
# Larm för bolagsfakta: öppnar ett ärende på GitHub (GitHub mejlar om nya ärenden) när hämtningen från MFN eller
# läsningen av kvartalsrapporterna slutar fungera, och stänger ärendet när det fungerar igen.
#   bash scripts/company-alarm.sh <hälsokollen.json>     (miljö: GH_TOKEN, OUTCOME = utfallet av steget "Bygg bolagsfakta")
set -u
health="$1"
title="Larm: bolagsfakta från MFN fungerar inte"

if [ "${OUTCOME:-success}" != "success" ]; then
  problems="- Skriptet scripts/build-companies.py kraschade eller tog för lång tid (steget \"Bygg bolagsfakta\")."
elif [ -f "$health" ]; then
  problems=$(python3 -c 'import json, sys; print("\n".join("- " + p for p in json.load(open(sys.argv[1], encoding="utf-8"))["problems"]))' "$health") ||
    problems="- Hälsokollen gick inte att läsa ($health)."
else
  problems="- Hälsokollen saknas: skriptet avslutades innan den skrevs."
fi

open=$(gh issue list --state open --search "\"$title\" in:title" --json number --jq '.[0].number // empty')
run="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
today=$(date +%Y-%m-%d)

if [ -n "$problems" ]; then
  body=$(printf 'Den dagliga kontrollen %s hittade problem:\n\n%s\n\nKörningen: %s\n\nÄrendet stängs automatiskt när det fungerar igen.' "$today" "$problems" "$run")
  if [ -n "$open" ]; then
    gh issue comment "$open" --body "$body"
  else
    gh issue create --title "$title" --body "$body"
  fi
  echo "$problems"
elif [ -n "$open" ]; then
  gh issue close "$open" --comment "Fungerar igen $today: $run"
  echo "Larmet stängt."
else
  echo "Bolagsfakta fungerar."
fi
