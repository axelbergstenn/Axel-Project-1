<#
.SYNOPSIS
  Hämtar Finansinspektionens blankningsregister och bygger site/data/shorts.json.

.DESCRIPTION
  FI publicerar tre filer (OpenDocument-kalkylblad) som uppdateras varje dag:
    - Aktuella positioner: varje innehavare med en kort nettoposition på minst 0,5 %
    - Aggregerade positioner: total blankning per bolag (alla positioner över 0,1 %)
    - Historiska positioner: alla tidigare ändringar av positioner på minst 0,5 %

  Ur dessa byggs en lista över mest blankade bolag, aktuella blankare och en tidsserie per aktie
  (summan av offentliga positioner, vecka för vecka de senaste två åren).

.EXAMPLE
  pwsh scripts/build-shorts.ps1
#>
param(
  [string]$OutFile = "site/data/shorts.json",
  [string]$CacheDir = ".cache/shorts",
  [int]$Weeks = 104
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Inv = [System.Globalization.CultureInfo]::InvariantCulture

function J($s) {
  if ($null -eq $s) { return "null" }
  return '"' + ([string]$s).Replace('\', '\\').Replace('"', '\"').Trim() + '"'
}
function Pct($s) {
  $s = ([string]$s).Trim()
  if ($s -match '^<') { return 0.0 }
  $d = 0.0
  if ([double]::TryParse($s.Replace(",", "."), [System.Globalization.NumberStyles]::Float, $Inv, [ref]$d)) { return $d }
  return $null
}

# Laddar ner en fil från FI. Provar flera adressvarianter; om allt misslyckas används den senast
# hämtade filen i cachen (FI:s server har ibland svarat 404 till GitHubs servrar).
function Get-File($name) {
  New-Item -ItemType Directory -Force $CacheDir | Out-Null
  $path = Join-Path $CacheDir "$name.ods"
  $tmp = "$path.part"
  $ticks = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $urls = @(
    "https://www.fi.se/BlankningsRegister/$name",
    "https://www.fi.se/BlankningsRegister/$name`?_=$ticks",
    "https://fi.se/BlankningsRegister/$name"
  )
  $headers = @{ "User-Agent" = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    "Referer" = "https://www.fi.se/sv/vara-register/fis-marknadsregister/blankning/register/"; "X-Requested-With" = "XMLHttpRequest"; "Accept" = "*/*" }
  foreach ($u in $urls) {
    for ($try = 1; $try -le 2; $try++) {
      try {
        Invoke-WebRequest -Uri $u -OutFile $tmp -UseBasicParsing -TimeoutSec 120 -Headers $headers
        $head = [System.IO.File]::ReadAllBytes($tmp) | Select-Object -First 2
        if ($head.Count -eq 2 -and $head[0] -eq 0x50 -and $head[1] -eq 0x4B) { Move-Item -Force $tmp $path; return (Resolve-Path $path).Path }
        Write-Host "  $u gav inte en kalkylfil"
      } catch {
        Write-Host ("  {0} misslyckades: {1}" -f $u, $_.Exception.Message.Split("`n")[0])
      }
      Start-Sleep -Seconds (5 * $try)
    }
  }
  if (Test-Path $path) { Write-Host "  Använder sparad $name från cachen"; return (Resolve-Path $path).Path }
  throw "Kunde inte hämta $name från FI"
}

# Läser alla rader i ett ODS-kalkylblad. Datumceller har värdet i attributet date-value.
function Read-Ods($path) {
  $rows = New-Object System.Collections.Generic.List[object]
  $zip = [System.IO.Compression.ZipFile]::OpenRead($path)
  try {
    $settings = New-Object System.Xml.XmlReaderSettings
    $settings.IgnoreWhitespace = $true
    $r = [System.Xml.XmlReader]::Create($zip.GetEntry("content.xml").Open(), $settings)
    $row = $null
    while ($r.Read()) {
      if ($r.NodeType -eq 'Element' -and $r.LocalName -eq 'table-row') { $row = New-Object System.Collections.Generic.List[string] }
      elseif ($r.NodeType -eq 'Element' -and $r.LocalName -eq 'table-cell' -and $null -ne $row) {
        $rep = 1; $a = $r.GetAttribute('number-columns-repeated'); if ($a) { $rep = [math]::Min([int]$a, 8) }
        $val = $r.GetAttribute('date-value')
        if (-not $val -and -not $r.IsEmptyElement) {
          $sub = $r.ReadSubtree(); $t = ''
          while ($sub.Read()) { if ($sub.NodeType -eq 'Text' -or $sub.NodeType -eq 'SignificantWhitespace') { $t += $sub.Value } }
          $sub.Close(); $val = $t
        }
        for ($i = 0; $i -lt $rep; $i++) { $row.Add([string]$val) }
      }
      elseif ($r.NodeType -eq 'EndElement' -and $r.LocalName -eq 'table-row' -and $null -ne $row) {
        if ($row.Count -ge 4) { $rows.Add($row.ToArray()) }
        $row = $null
      }
    }
    $r.Close()
  } finally { $zip.Dispose() }
  return $rows
}

function IsDate($s) { return ([string]$s) -match '^\d{4}-\d{2}-\d{2}' }

Write-Host "Blankning: laddar ner FI:s filer"
$current = @(Read-Ods (Get-File "GetAktuellFile") | Where-Object { (IsDate $_[4]) -and $_[2] -match '^[A-Z]{2}[A-Z0-9]{10}$' })
$aggregate = @(Read-Ods (Get-File "GetBlankningsregisterAggregat") | Where-Object { IsDate $_[3] })
$history = @(Read-Ods (Get-File "GetHistFile") | Where-Object { (IsDate $_[4]) -and $_[2] -match '^[A-Z]{2}[A-Z0-9]{10}$' })
Write-Host ("  {0} aktuella positioner, {1} bolag i aggregatet, {2} historiska ändringar" -f $current.Count, $aggregate.Count, $history.Count)

# Bolag: namn -> ISIN (från positionsfilerna; aggregatet saknar ISIN)
$isinOf = @{}; $nameOf = @{}
function Norm($s) { return (([string]$s).ToLowerInvariant() -replace '\(publ\)', '' -replace '[^a-z0-9åäöéü]+', ' ').Trim() }
foreach ($r in @($history) + @($current)) {
  $isin = $r[2].Trim(); $nm = $r[1].Trim()
  $nameOf[$isin] = $nm
  $isinOf[(Norm $nm)] = $isin
}

# Samma innehavare har stavats olika genom åren ("MAVERICK CAPITAL, LTD" / "Maverick Capital Ltd")
function NormHolder($s) {
  $s = ([string]$s).ToLowerInvariant() -replace '[^a-z0-9]+', ' '
  $s = $s -replace '\b(ltd|limited|llc|lp|llp|l p|sa|inc|plc|corp|corporation|ab|as|gmbh|ag|co|the)\b', ' '
  return ($s -replace '\s+', ' ').Trim()
}
$currentHolders = @{}
foreach ($r in $current) { $currentHolders[$r[2].Trim() + "|" + (NormHolder $r[0])] = $true }

# Tidslinje per aktie: senaste position per innehavare, summerad vecka för vecka
$events = @{}
foreach ($r in @($history) + @($current)) {
  $isin = $r[2].Trim(); $p = Pct $r[3]
  if ($null -eq $p) { continue }
  if (-not $events.ContainsKey($isin)) { $events[$isin] = New-Object System.Collections.Generic.List[object] }
  $events[$isin].Add(@($r[4].Substring(0, 10), (NormHolder $r[0]), $p))
}
# En position som inte uppdaterats på 180 dagar och inte finns bland de aktuella räknas som stängd
$StaleDays = 180
$today = (Get-Date).Date
$weekEnds = @(); for ($w = $Weeks; $w -ge 0; $w--) { $weekEnds += $today.AddDays(-7 * $w).ToString("yyyy-MM-dd") }
$series = New-Object System.Collections.Generic.List[string]
$change30 = @{}
$d30 = $today.AddDays(-30).ToString("yyyy-MM-dd")
foreach ($isin in $events.Keys) {
  $ev = @($events[$isin] | Sort-Object { $_[0] })
  $pos = @{}; $seenAt = @{}; $i = 0; $points = @(); $last = -1.0; $at30 = 0.0
  $sumAt = {
    param($dateStr)
    $limit = ([datetime]::ParseExact($dateStr, "yyyy-MM-dd", $Inv)).AddDays(-$StaleDays).ToString("yyyy-MM-dd")
    $s = 0.0
    foreach ($h in $pos.Keys) {
      if ($seenAt[$h] -ge $limit -or $currentHolders.ContainsKey($isin + "|" + $h)) { $s += $pos[$h] }
    }
    [math]::Round($s, 2)
  }
  foreach ($we in $weekEnds) {
    while ($i -lt $ev.Count -and $ev[$i][0] -le $we) { $pos[$ev[$i][1]] = $ev[$i][2]; $seenAt[$ev[$i][1]] = $ev[$i][0]; $i++ }
    $sum = & $sumAt $we
    if ($we -le $d30) { $at30 = $sum }
    if ($sum -ne $last) { $points += "[" + [array]::IndexOf($weekEnds, $we) + "," + $sum.ToString("0.##", $Inv) + "]"; $last = $sum }
  }
  while ($i -lt $ev.Count) { $pos[$ev[$i][1]] = $ev[$i][2]; $seenAt[$ev[$i][1]] = $ev[$i][0]; $i++ }
  # Nu gäller den aktuella listan: bara innehavare som finns där räknas
  $now = 0.0; foreach ($h in $pos.Keys) { if ($currentHolders.ContainsKey($isin + "|" + $h)) { $now += $pos[$h] } }
  $now = [math]::Round($now, 2)
  if ($now -ne $last) { $points += "[" + ($weekEnds.Count - 1) + "," + $now.ToString("0.##", $Inv) + "]"; $last = $now }
  $change30[$isin] = [math]::Round($now - $at30, 2)
  if ($last -gt 0 -or $points.Count -gt 1) { $series.Add((J $isin) + ":[" + ($points -join ",") + "]") }
}

# Alla ändringar senaste året, för blankarnas egna sidor (egen fil som bara laddas där)
$d365 = $today.AddDays(-365).ToString("yyyy-MM-dd")
$yearRows = @(@($history) + @($current) | Where-Object { $_[4].Substring(0, 10) -ge $d365 } | Sort-Object { $_[4] } -Descending |
  ForEach-Object { "[" + (J $_[4].Substring(0, 10)) + "," + (J $_[0]) + "," + (J $_[2]) + "," + $(if ($_[3] -match '^<') { "0" } else { (Pct $_[3]).ToString("0.##", $Inv) }) + "]" } |
  Select-Object -Unique)
$histFile = Join-Path (Split-Path $OutFile -Parent) "shorts-history.json"
[System.IO.File]::WriteAllText((Join-Path (Get-Location) $histFile), ('{"from":' + (J $d365) + ',"rows":[' + ($yearRows -join ",") + "]}"), (New-Object System.Text.UTF8Encoding $false))
Write-Host ("  {0} ändringar senaste året" -f $yearRows.Count)

# Senaste ändringar (30 dagar)
$recent = @(@($history) + @($current) | Where-Object { $_[4].Substring(0, 10) -ge $d30 } | Sort-Object { $_[4] } -Descending |
  ForEach-Object { "[" + (J $_[4].Substring(0, 10)) + "," + (J $_[0]) + "," + (J $_[2]) + "," + $(if ($_[3] -match '^<') { "0" } else { (Pct $_[3]).ToString("0.##", $Inv) }) + "]" } |
  Select-Object -Unique)

$cur = foreach ($r in $current) { "[" + (J $r[0]) + "," + (J $r[2]) + "," + (Pct $r[3]).ToString("0.##", $Inv) + "," + (J $r[4].Substring(0, 10)) + "]" }
$agg = foreach ($r in $aggregate) {
  $isin = $isinOf[(Norm $r[0])]
  "[" + (J $r[0]) + "," + (J $isin) + "," + (Pct $r[2]).ToString("0.##", $Inv) + "," + (J $r[3].Substring(0, 10)) + "," + $(if ($isin -and $change30.ContainsKey($isin)) { $change30[$isin].ToString("0.##", $Inv) } else { "null" }) + "]"
}
$names = foreach ($k in $nameOf.Keys) { (J $k) + ":" + (J $nameOf[$k]) }

$json = '{"built":' + (J (Get-Date -Format "yyyy-MM-dd")) + ',"weeks":[' + (($weekEnds | ForEach-Object { J $_ }) -join ",") + ']' +
  ',"names":{' + ($names -join ",") + '},"aggregate":[' + (@($agg) -join ",") + '],"current":[' + (@($cur) -join ",") + ']' +
  ',"recent":[' + (@($recent) -join ",") + '],"series":{' + ($series -join ",") + "}}"
$dir = Split-Path $OutFile -Parent
if ($dir) { New-Item -ItemType Directory -Force $dir | Out-Null }
[System.IO.File]::WriteAllText((Join-Path (Get-Location) $OutFile), $json, (New-Object System.Text.UTF8Encoding $false))
$mapped = @($aggregate | Where-Object { $isinOf[(Norm $_[0])] }).Count
Write-Host ("Klart: {0} bolag ({1} kopplade till ISIN), {2} aktuella positioner, {3:N0} kB" -f $aggregate.Count, $mapped, $current.Count, ($json.Length / 1024))
