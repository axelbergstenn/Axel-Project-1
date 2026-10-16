<#
.SYNOPSIS
  Bygger data/flows.json: spararnas nettoflöden per fondtyp och månad (Fondbolagens förening) och uppskattade
  nettoflöden per fond och kvartal (ur Finansinspektionens fondinnehav).

.DESCRIPTION
  Fondbolagens förening publicerar varje månad insättningar, uttag och fondförmögenhet per fondtyp (aktie-, bland-,
  ränte- och hedgefonder) och för aktiefonder per placeringsinriktning (Sverige, Global, Nordamerika ...).
  Filerna är Excel-filer med flera tabeller under varandra. Varje tabell har en rad med "Månad" och fondtypernas namn,
  en rad med "insättn.", "uttag", "netto" och förmögenhet, och sedan en rad per månad. Tabellerna "exkl. PPM" längre
  ner hoppas över, de är en delmängd av samma siffror.

  Flöden per fond finns inte öppet, så de uppskattas ur FI:s kvartalsdata (site/data/<kvartal>.json och -world.json):
  fondförmögenheten i slutet av kvartalet minus förmögenheten i början, minus kursförändringen på de aktier fonden
  ägde i början av kvartalet. Det som blir kvar är i huvudsak spararnas insättningar minus uttag. Utdelningar som
  fonden får räknas också dit, så kvartal med många utdelningar (det andra kvartalet) ser för positiva ut, och
  räntepappers kursrörelser räknas inte bort. Därför visas siffrorna som en uppskattning.

  Går hämtningen från Fondbolagens förening fel behålls månadsdatan från förra körningen. Hela år som redan finns
  i flows.json (alla tolv månader) laddas inte ner igen, bara de två senaste åren hämtas varje gång.
#>
param(
  [string]$OutDir = "site/data",
  # Första året med Excel-filer (xlsx) hos Fondbolagens förening. Äldre år finns bara som xls.
  [int]$FirstYear = 2014
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$Inv = [System.Globalization.CultureInfo]::InvariantCulture
$Utf8 = New-Object System.Text.UTF8Encoding $false
$Base = "https://www.fondbolagen.se/globalassets/faktaindex/manadsstatistik"
$OutFile = Join-Path $OutDir "flows.json"

function J($s) {
  if ($null -eq $s) { return "null" }
  return '"' + (([string]$s) -replace '[\x00-\x1f]+', ' ').Replace('\', '\\').Replace('"', '\"') + '"'
}
function N1($v) { if ($null -eq $v) { return "null" }; return ([math]::Round([double]$v, 1)).ToString($Inv) }
function Num($s) {
  if ([string]::IsNullOrWhiteSpace($s)) { return $null }
  $d = 0.0
  if ([double]::TryParse(([string]$s).Replace(",", "."), [System.Globalization.NumberStyles]::Float, $Inv, [ref]$d)) { return $d }
  return $null
}

# ---------------------------------------------------------------------------
# Excel (xlsx är en zip med XML): första bladet som rader, varje rad en tabell kolumn -> text

function ColIndex([string]$ref) {
  $letters = ($ref -replace '[0-9]', '')
  $n = 0
  foreach ($ch in $letters.ToCharArray()) { $n = $n * 26 + ([int][char]$ch - 64) }
  return $n - 1
}

function Read-Xlsx([string]$path) {
  $zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path $path).Path)
  try {
    $shared = New-Object System.Collections.Generic.List[string]
    $ssEntry = $zip.GetEntry("xl/sharedStrings.xml")
    if ($ssEntry) {
      $x = New-Object System.Xml.XmlDocument
      $st = $ssEntry.Open(); try { $x.Load($st) } finally { $st.Dispose() }
      foreach ($si in $x.DocumentElement.ChildNodes) {
        if ($si.LocalName -ne "si") { continue }
        $t = ""
        foreach ($node in $si.SelectNodes(".//*[local-name()='t']")) { $t += $node.InnerText }
        $shared.Add($t)
      }
    }
    $sheet = $zip.GetEntry("xl/worksheets/sheet1.xml")
    $x = New-Object System.Xml.XmlDocument
    $st = $sheet.Open(); try { $x.Load($st) } finally { $st.Dispose() }
    $rows = New-Object System.Collections.Generic.List[object]
    foreach ($r in $x.SelectNodes("//*[local-name()='sheetData']/*[local-name()='row']")) {
      $cells = @{}
      foreach ($c in $r.ChildNodes) {
        if ($c.LocalName -ne "c") { continue }
        $v = $c.SelectSingleNode("*[local-name()='v']")
        $text = $null
        if ($c.GetAttribute("t") -eq "s" -and $v) { $text = $shared[[int]$v.InnerText] }
        elseif ($c.GetAttribute("t") -eq "inlineStr") { $text = $c.InnerText }
        elseif ($v) { $text = $v.InnerText }
        if ($null -ne $text) { $cells[(ColIndex $c.GetAttribute("r"))] = $text }
      }
      $rows.Add($cells)
    }
    return $rows
  } finally { $zip.Dispose() }
}

$Rename = @{ "Obligationsfonder" = "Långa räntefonder"; "Penningmarknadsfonder" = "Korta räntefonder"; "Genrationsfonder" = "Generationsfonder" }
$MonthNo = @{ jan = 1; feb = 2; mar = 3; apr = 4; maj = 5; jun = 6; jul = 7; aug = 8; sep = 9; okt = 10; nov = 11; dec = 12 }

# Läser tabellerna i en fil till $target[fondtyp][ "YYYY-MM" ] = @(netto, förmögenhet)
function Read-Flows($rows, [int]$year, $target) {
  $cats = $null; $monthCol = $null
  for ($k = 0; $k -lt $rows.Count; $k++) {
    $row = $rows[$k]
    $joined = ($row.Values | ForEach-Object { [string]$_ }) -join " "
    if ($joined -cmatch "EXKL") { break }
    $mc = $null
    foreach ($key in $row.Keys) { if (([string]$row[$key]).Trim() -match '^M.nad$') { $mc = $key } }
    if ($null -ne $mc -and $k + 1 -lt $rows.Count) {
      $next = $rows[$k + 1]
      $cats = @{}
      foreach ($key in $next.Keys) {
        if (([string]$next[$key]).Trim() -match '^ins') {
          $name = ([string]$row[$key]).Trim() -replace '\s+', ' ' -replace '\*$', ''
          if ($name) { $cats[$key] = $name }
        }
      }
      $monthCol = $mc
      continue
    }
    if (-not $cats) { continue }
    $m = ([string]$row[$monthCol]).Trim().ToLower()
    if (-not $MonthNo.ContainsKey($m)) { continue }
    $ym = "{0}-{1:00}" -f $year, $MonthNo[$m]
    foreach ($c in $cats.Keys) {
      $ins = Num $row[$c]; $out = Num $row[$c + 1]; $net = Num $row[$c + 2]; $aum = Num $row[$c + 3]
      # Månader som inte har kommit än står som nollor
      if (-not $ins -and -not $out -and -not $aum) { continue }
      $name = $cats[$c]
      # Äldre filer använde andra namn på samma fondtyper
      if ($Rename.ContainsKey($name)) { $name = $Rename[$name] }
      if (-not $target.ContainsKey($name)) { $target[$name] = @{} }
      $target[$name][$ym] = @($net, $aum)
    }
  }
}

function Get-Workbook([string]$file, [string]$dir) {
  $path = Join-Path $dir $file
  try {
    Invoke-WebRequest -Uri "$Base/$file" -OutFile $path -UseBasicParsing -UserAgent "Mozilla/5.0 (Fondinsyn; www.fondinsyn.se)"
    return $path
  } catch {
    Write-Host "  $file saknas ($($_.Exception.Message))"
    return $null
  }
}

# ---------------------------------------------------------------------------
# Månadsstatistik

$types = @{}; $focus = @{}
$old = $null
if (Test-Path $OutFile) { try { $old = [System.IO.File]::ReadAllText((Resolve-Path $OutFile).Path, $Utf8) | ConvertFrom-Json } catch { } }

# Hela år från förra körningen återanvänds
$kept = @{}
if ($old -and $old.months) {
  $om = @($old.months)
  foreach ($pair in @(@($old.types, $types), @($old.focus, $focus))) {
    $src = $pair[0]; $dst = $pair[1]
    if (-not $src) { continue }
    foreach ($prop in $src.PSObject.Properties) {
      $vals = @($prop.Value)
      for ($k = 0; $k -lt $om.Count; $k++) {
        $yy = [int]([string]$om[$k]).Substring(0, 4)
        if ($yy -ge (Get-Date).Year - 1 -or $null -eq $vals[$k]) { continue }
        if (-not ($om -contains "$yy-12")) { continue }
        if (-not $dst.ContainsKey($prop.Name)) { $dst[$prop.Name] = @{} }
        $dst[$prop.Name][[string]$om[$k]] = @($vals[$k][0], $vals[$k][1])
        $kept[$yy] = $true
      }
    }
  }
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("fondflode-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $tmp | Out-Null
$thisYear = (Get-Date).Year
$fetched = 0
try {
  for ($y = $FirstYear; $y -le $thisYear; $y++) {
    if ($kept[$y]) { continue }
    # Filnamnen har skiftat genom åren (formogenhet/fondformogenhet, aktiefonder först eller sist)
    $p = Get-Workbook "nysparande-och-formogenhet-$y.xlsx" $tmp
    if (-not $p) { $p = Get-Workbook "nysparande-och-fondformogenhet-$y.xlsx" $tmp }
    if ($p) { Read-Flows (Read-Xlsx $p) $y $types; $fetched++ }
    $p = Get-Workbook "aktiefonder-$y.xlsx" $tmp
    if (-not $p) { $p = Get-Workbook "nysparande-och-formogenhet-$y-aktiefonder.xlsx" $tmp }
    if ($p) { Read-Flows (Read-Xlsx $p) $y $focus }
  }
  Write-Host ("  Hämtade {0} år, återanvände {1}" -f $fetched, $kept.Count)
} catch {
  Write-Host "Kunde inte läsa månadsstatistiken: $($_.Exception.Message)"
  $types = @{}; $focus = @{}
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

function Series-Json($set, $months) {
  $parts = foreach ($name in ($set.Keys | Sort-Object)) {
    $vals = foreach ($m in $months) { $v = $set[$name][$m]; if ($v) { "[" + (N1 $v[0]) + "," + (N1 $v[1]) + "]" } else { "null" } }
    (J $name) + ":[" + ($vals -join ",") + "]"
  }
  return "{" + ($parts -join ",") + "}"
}

$monthly = $null
if ($types.Count -and $types.ContainsKey("Aktiefonder")) {
  $all = New-Object System.Collections.Generic.HashSet[string]
  foreach ($set in @($types, $focus)) { foreach ($n in $set.Keys) { foreach ($m in $set[$n].Keys) { [void]$all.Add($m) } } }
  $months = @($all | Sort-Object)
  $monthly = '"months":[' + (($months | ForEach-Object { J $_ }) -join ",") + '],"types":' + (Series-Json $types $months) + ',"focus":' + (Series-Json $focus $months)
  Write-Host ("  Månadsstatistik: {0} månader ({1} till {2}), {3} fondtyper, {4} inriktningar" -f $months.Count, $months[0], $months[-1], $types.Count, $focus.Count)
} elseif ($old -and $old.months) {
  Write-Host "  Behåller månadsstatistiken från förra körningen"
  $monthly = '"months":' + ($old.months | ConvertTo-Json -Compress) + ',"types":' + ($old.types | ConvertTo-Json -Compress -Depth 5) + ',"focus":' + ($old.focus | ConvertTo-Json -Compress -Depth 5)
}

# ---------------------------------------------------------------------------
# Uppskattade flöden per fond och kvartal

function ReadData($name) {
  $p = Join-Path $OutDir $name
  if (-not (Test-Path $p)) { return $null }
  return [System.IO.File]::ReadAllText((Resolve-Path $p).Path, $Utf8) | ConvertFrom-Json
}

$index = ReadData "index.json"
$fundParts = New-Object System.Collections.Generic.List[string]
foreach ($q in $index.quarters) {
  $qid = [string]$q.id; $prevQ = [string]$q.prevId
  $prevPrice = @{}
  foreach ($suf in @("", "-world")) {
    $pd = ReadData "$prevQ$suf.json"
    if ($pd) { foreach ($s in $pd.stocks) { if ($s[3]) { $prevPrice[[string]$s[0]] = [double]$s[3] } } }
  }
  if ($prevPrice.Count -eq 0) { Write-Host "  $qid`: saknar kurser för $prevQ, hoppar över"; continue }
  $acc = @{}
  foreach ($suf in @("", "-world")) {
    $d = ReadData "$qid$suf.json"
    if (-not $d) { continue }
    $st = $d.stocks
    foreach ($f in $d.funds) {
      $id = [string]$f[0]
      if (-not $acc.ContainsKey($id)) { $acc[$id] = @{ name = [string]$f[1]; co = [string]$f[2]; a1 = $f[4]; a2 = $f[5]; mkt = 0.0; v1 = 0.0 } }
      $e = $acc[$id]
      foreach ($h in $f[6]) {
        $s1 = $h[1]
        if (-not $s1) { continue }
        $s = $st[[int]$h[0]]
        $p2 = $s[3]; $p1 = $prevPrice[[string]$s[0]]
        if (-not $p2 -or -not $p1) { continue }
        if ($s[4]) { $p1 = [double]$p1 / [double]$s[4] }
        $e.mkt += [double]$s1 * ([double]$p2 - [double]$p1)
        $e.v1 += [double]$s1 * [double]$p1
      }
    }
  }
  $rows = foreach ($id in ($acc.Keys | Sort-Object)) {
    $e = $acc[$id]
    if (-not $e.a1 -or -not $e.a2 -or [double]$e.a1 -lt 1e8) { continue }
    $flow = [double]$e.a2 - [double]$e.a1 - $e.mkt
    # Andel av förmögenheten som består av aktier vi har kurser för (låg andel = osäkrare uppskattning)
    $cover = [math]::Min([double]1, [double]$e.v1 / [double]$e.a1)
    "[" + (J $id) + "," + (J $e.name) + "," + (J $e.co) + "," + [math]::Round([double]$e.a1).ToString($Inv) + "," + [math]::Round($flow).ToString($Inv) + "," + ([math]::Round($cover, 2)).ToString($Inv) + "]"
  }
  $fundParts.Add((J $qid) + ":[" + (@($rows) -join ",") + "]")
  Write-Host ("  {0}: uppskattade flöden för {1} fonder" -f $qid, @($rows).Count)
}

$json = "{" + '"built":' + (J (Get-Date -Format "yyyy-MM-dd")) + ',"src":"Fondbolagens förening, Finansinspektionen"' +
  $(if ($monthly) { "," + $monthly } else { "" }) + ',"funds":{' + ($fundParts -join ",") + "}}"
[System.IO.File]::WriteAllText($OutFile, $json, $Utf8)
Write-Host "Skrev $OutFile"
