<#
.SYNOPSIS
  Bygger data/shares.json: antalet aktier per aktieslag för svenska bolag på Nasdaq Stockholm och First North.

.DESCRIPTION
  Med antalet aktier kan sajten räkna ut hur stor andel av ett bolag som svenska fonder äger (fondernas antal aktier
  delat med antalet aktier i aktieslaget). Uppgiften hämtas från Nasdaqs öppna webbtjänst, ett anrop per aktie.

  Antalet aktier ändras sällan (nyemissioner, inlösen), så varje aktie hämtas om högst en gång i månaden och som mest
  $PerRun aktier per körning, med en kort paus mellan anropen. Nya aktier hämtas först. Filen sparas i repot, så
  uppgifterna finns kvar även om Nasdaq inte svarar en dag.

  Format: {"built": "...", "src": "Nasdaq", "shares": {"SE0011337708": [261989002, "2026-10-16"], ...}}
#>
param(
  [string]$OutDir = "site/data",
  [int]$PerRun = 60,
  [int]$MaxAgeDays = 30
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Inv = [System.Globalization.CultureInfo]::InvariantCulture
$Utf8 = New-Object System.Text.UTF8Encoding $false
$OutFile = Join-Path $OutDir "shares.json"
$Api = "https://api.nasdaq.com/api/nordic"
# Nasdaqs webbtjänst svarar bara på anrop som ser ut som en webbläsares (med Accept-Language)
$Agent = "Mozilla/5.0"

function Get-Json($url) {
  for ($try = 1; $try -le 3; $try++) {
    try { return Invoke-RestMethod -Uri $url -UserAgent $Agent -Headers @{ Accept = "application/json, text/plain, */*"; "Accept-Language" = "en-US,en;q=0.9" } -TimeoutSec 30 }
    catch { if ($try -eq 3) { throw }; Start-Sleep -Seconds (3 * $try) }
  }
}

# Tidigare hämtade uppgifter
$known = @{}
# Nasdaqs orderbok-id och kortnamn per ISIN, för länken "Dagens kurs hos Nasdaq" på aktiesidan
$nasdaqIds = @{}
if (Test-Path $OutFile) {
  try {
    $old = [System.IO.File]::ReadAllText((Resolve-Path $OutFile).Path, $Utf8) | ConvertFrom-Json
    foreach ($prop in $old.shares.PSObject.Properties) { $known[$prop.Name] = @([double]$prop.Value[0], [string]$prop.Value[1]) }
    if ($old.book) { foreach ($prop in $old.book.PSObject.Properties) { $nasdaqIds[$prop.Name] = @([string]$prop.Value[0], [string]$prop.Value[1]) } }
  } catch { Write-Host "  Kunde inte läsa $OutFile, börjar om" }
}

# Svenska aktier som fonderna äger (senaste kvartalet)
$index = [System.IO.File]::ReadAllText((Resolve-Path (Join-Path $OutDir "index.json")).Path, $Utf8) | ConvertFrom-Json
$latest = [string]$index.quarters[0].id
$qd = [System.IO.File]::ReadAllText((Resolve-Path (Join-Path $OutDir "$latest.json")).Path, $Utf8) | ConvertFrom-Json
$wanted = New-Object System.Collections.Generic.HashSet[string]
foreach ($s in $qd.stocks) { [void]$wanted.Add([string]$s[0]) }

# Nasdaqs listor ger ISIN och orderbok-id för alla aktier på Stockholmsbörsen och First North
$book = @{}
foreach ($cat in @("MAIN_MARKET", "FIRST_NORTH")) {
  try {
    $list = Get-Json "$Api/screener/shares?category=$cat&tableonly=true&market=STO"
    foreach ($r in $list.data.instrumentListing.rows) {
      if ($r.isin -and $wanted.Contains([string]$r.isin)) {
        $book[[string]$r.isin] = [string]$r.orderbookId
        $nasdaqIds[[string]$r.isin] = @([string]$r.orderbookId, [string]$r.symbol)
      }
    }
  } catch { Write-Host "  Kunde inte hämta listan $cat`: $($_.Exception.Message)" }
}
Write-Host ("  {0} av {1} svenska aktier finns hos Nasdaq" -f $book.Count, $wanted.Count)

# Nya aktier först, sedan de äldsta uppgifterna
$today = Get-Date -Format "yyyy-MM-dd"
$limit = (Get-Date).AddDays(-$MaxAgeDays).ToString("yyyy-MM-dd")
$queue = @($book.Keys | Where-Object { -not $known.ContainsKey($_) -or $known[$_][1] -lt $limit } |
  Sort-Object @{ Expression = { if ($known.ContainsKey($_)) { $known[$_][1] } else { "" } } } | Select-Object -First $PerRun)
$ok = 0; $fail = 0
foreach ($isin in $queue) {
  try {
    $d = Get-Json "$Api/instruments/$($book[$isin])/summary?assetClass=SHARES&lang=en"
    $v = [string]$d.data.summaryData.shares.value
    $n = 0.0
    if ([double]::TryParse(($v -replace '[,\s]', ''), [System.Globalization.NumberStyles]::Float, $Inv, [ref]$n) -and $n -gt 0) {
      $known[$isin] = @($n, $today); $ok++
    } else { $fail++ }
  } catch { $fail++ }
  Start-Sleep -Milliseconds 300
}
Write-Host ("  Hämtade antal aktier för {0} aktier ({1} misslyckades), {2} i filen" -f $ok, $fail, $known.Count)

$parts = foreach ($k in ($known.Keys | Sort-Object)) { '"' + $k + '":[' + ([math]::Round($known[$k][0])).ToString($Inv) + ',"' + $known[$k][1] + '"]' }
$bookParts = foreach ($k in ($nasdaqIds.Keys | Sort-Object)) { '"' + $k + '":["' + $nasdaqIds[$k][0] + '","' + ($nasdaqIds[$k][1] -replace '"', '') + '"]' }
$json = '{"built":"' + $today + '","src":"Nasdaq","shares":{' + (@($parts) -join ",") + '},"book":{' + (@($bookParts) -join ",") + '}}'
[System.IO.File]::WriteAllText((Join-Path (Resolve-Path $OutDir).Path "shares.json"), $json, $Utf8)
Write-Host "Skrev $OutFile"
