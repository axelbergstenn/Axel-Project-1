<#
.SYNOPSIS
  Hämtar Finansinspektionens fondinnehav och bygger site/data/*.json.

.DESCRIPTION
  Läser listan över publicerade kvartal på fi.se, laddar ner de zip-filer som behövs och skriver:

    site/data/<kvartal>.json        Svenska aktier, jämfört med kvartalet innan, samt nyckeltal för alla fonder
    site/data/<kvartal>-world.json  Utländska aktier, samma format
    site/data/history.json          Fondernas ägande och nettoköp per aktie för alla kvartal sedan 2018
    site/data/index.json            Lista över byggda kvartal

  Filer byggs om bara när FI har publicerat nya versioner av källfilerna (eller när formatet ändrats).
  Fungerar i både Windows PowerShell 5.1 och PowerShell 7 (pwsh).

.EXAMPLE
  pwsh scripts/build-data.ps1 -History 4
  pwsh scripts/build-data.ps1 -History 1 -HistoryQuarters 2   # snabbt lokalt test
#>
param(
  [string]$OutDir = "site/data",
  [string]$CacheDir = ".cache",
  [int]$History = 4,              # antal kvartal (jämförelser) som byggs i detalj
  [int]$HistoryQuarters = 0,      # 0 = alla kvartal FI har publicerat
  [int]$OffersFrom = 2020,        # första året för uppköpserbjudanden
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$FormatVersion = 2
$FiBase = "https://www.fi.se"
$FiList = "https://www.fi.se/sv/vara-register/fondinnehav-per-kvartal/"
$Inv = [System.Globalization.CultureInfo]::InvariantCulture
$IndexRe = '(?i)index|indx|\bomx|passiv|tracker|\betf\b|\bzero\b|\baccess\b|aktiespararna topp'
$BondRe = '\d{1,2}/\d{1,2}/\d{2,4}|\bFloat\b|\bFRN\b|%|fond\b'
$WorldMinValue = 20e6           # utländska aktier: minsta sammanlagda fondinnehav för att tas med
$HistoryMinSe = 1e6             # historik: minsta toppvärde för svenska aktier
$HistoryMinWorld = 200e6        # historik: minsta toppvärde för utländska aktier

# GICS-sektorer (FI anger branschkod enligt GICS nivå 1)
$Gics = @{
  "10" = "Energi"; "15" = "Material"; "20" = "Industri"; "25" = "Sällanköpsvaror"; "30" = "Dagligvaror"
  "35" = "Hälsovård"; "40" = "Finans"; "45" = "IT"; "50" = "Kommunikationstjänster"; "55" = "Kraftförsörjning"; "60" = "Fastigheter"
}

# ---------------------------------------------------------------------------
# Hjälpfunktioner

function Num($s) {
  if ([string]::IsNullOrWhiteSpace($s)) { return $null }
  $d = 0.0
  if ([double]::TryParse(([string]$s).Replace(",", "."), [System.Globalization.NumberStyles]::Float, $Inv, [ref]$d)) { return $d }
  return $null
}
function J($s) {
  if ($null -eq $s) { return "null" }
  return '"' + ([string]$s).Replace('\', '\\').Replace('"', '\"').Replace("`t", " ").Replace("`r", "").Replace("`n", " ") + '"'
}
function N($v, $fmt = "0.####") {
  if ($null -eq $v) { return "null" }
  return ([double]$v).ToString($fmt, $Inv)
}
function Top($tally) {
  if (-not $tally) { return $null }
  $best = $null; $max = -1
  foreach ($e in $tally.GetEnumerator()) { if ($e.Value -gt $max) { $max = $e.Value; $best = $e.Key } }
  return $best
}
function Tally($table, $key, $value) {
  if (-not $value) { return }
  if (-not $table.ContainsKey($key)) { $table[$key] = @{} }
  $table[$key][$value] = 1 + [int]$table[$key][$value]
}
function Write-Utf8($path, $text) {
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding $false))
}

# ---------------------------------------------------------------------------
# FI

function Get-Releases {
  $html = (Invoke-WebRequest -Uri $FiList -UseBasicParsing).Content
  $seen = @{}
  $list = foreach ($m in [regex]::Matches($html, 'filnamn=(Fondinnehav_(\d{4})Q(\d)_[^"''<>]+?\.zip)')) {
    $file = [System.Net.WebUtility]::UrlDecode([System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value))
    $id = $m.Groups[2].Value + "Q" + $m.Groups[3].Value
    if ($seen.ContainsKey($id)) { continue }
    $seen[$id] = $true
    [pscustomobject]@{ Id = $id; Year = [int]$m.Groups[2].Value; Q = [int]$m.Groups[3].Value; File = $file }
  }
  if (-not $list) { throw "Hittade inga kvartalsfiler på $FiList. Har sidan ändrat format?" }
  return @($list | Sort-Object Year, Q -Descending)
}

function Get-Zip($release) {
  New-Item -ItemType Directory -Force $CacheDir | Out-Null
  $path = Join-Path $CacheDir ($release.Id + ".zip")
  $stamp = "$path.src"
  if ((Test-Path $path) -and (Test-Path $stamp) -and ((Get-Content $stamp -Raw).Trim() -eq $release.File)) { return $path }
  $url = "$FiBase/FondInnehavLista/download?filnamn=" + [uri]::EscapeDataString($release.File)
  Write-Host "  Laddar ner $($release.File)"
  Invoke-WebRequest -Uri $url -OutFile $path -UseBasicParsing
  Set-Content -Path $stamp -Value $release.File
  return $path
}

# Läser ett kvartal: alla fonder med nyckeltal och innehav i aktier (antal per ISIN)
$QuarterCache = @{}
function Read-Quarter($release) {
  if ($QuarterCache.ContainsKey($release.Id)) { return $QuarterCache[$release.Id] }
  Write-Host "  Läser $($release.Id)"
  $funds = @{}; $names = @{}; $sect = @{}; $country = @{}; $price = @{}; $prices = @{}; $date = $null
  $zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path (Get-Zip $release)).Path)
  try {
    foreach ($entry in $zip.Entries) {
      if (-not $entry.FullName.EndsWith(".xml")) { continue }
      $x = New-Object System.Xml.XmlDocument
      $stream = $entry.Open()
      try { $x.Load($stream) } finally { $stream.Dispose() }
      $root = $x.DocumentElement
      if (-not $date) { $date = [string]$root.Rapportinformation.Kvartalsslut }
      $fi = $root.Fondinformation
      if (-not $fi) { continue }

      $holdings = @{}
      $equity = 0.0
      foreach ($i in $fi.FinansiellaInstrument.FinansielltInstrument) {
        if ($i.'Tillgångsslag_enligt_LVF_5_kap' -ne 'ÖverlåtbartVärdepapper') { continue }
        $isin = [string]$i.'ISIN-kod_instrument'
        if (-not $isin -or $isin.Length -ne 12) { continue }
        $n = Num $i.Antal
        if (-not $n -or $n -le 0) { continue }
        # Obligationer och fondandelar som rapporterats med antal hoppas över
        if (Num $i.Nominellt_belopp) { continue }
        $nm = ([string]$i.Instrumentnamn).Trim()
        if ($nm -match $BondRe) { continue }

        if ($holdings.ContainsKey($isin)) { $holdings[$isin] += $n } else { $holdings[$isin] = $n }
        $mv = Num $i.'Marknadsvärde_instrument'
        if ($mv -and $mv -gt 0) {
          if (-not $prices.ContainsKey($isin)) { $prices[$isin] = New-Object System.Collections.Generic.List[double] }
          $prices[$isin].Add($mv / $n); $equity += $mv
        }
        Tally $names $isin $nm
        $code = [string]$i.Bransch.'Branschkod_instrument'
        if ($code -ne "0") { Tally $sect $isin $code }
        Tally $country $isin ([string]$i.Landkod_Emittent)
      }

      $fees = @()
      $feeNode = $fi.ChildNodes | Where-Object { $_.LocalName -eq 'Förvaltningsavgift' } | Select-Object -First 1
      $perf = $false
      if ($feeNode) {
        foreach ($f in $feeNode.SelectNodes(".//*[local-name()='Förvaltningsavgift_fast']")) { $v = Num $f.InnerText; if ($null -ne $v) { $fees += $v } }
        $perf = $null -ne $feeNode.SelectSingleNode(".//*[local-name()='Förvaltningsavgift_Prestationsbaserad']")
      }
      $aum = Num $fi.'Fondförmögenhet'
      $name = ([string]$fi.Fond_namn).Trim()
      $funds[[string]$fi.Fond_institutnummer] = @{
        name   = $name
        co     = ([string]$root.Bolagsinformation.Fondbolag_namn).Trim()
        aum    = $aum
        bench  = (@($fi.'Jämförelseindex'.'Jämförelseindex') -join ", ")
        feeMin = $(if ($fees.Count) { ($fees | Measure-Object -Minimum).Minimum } else { $null })
        feeMax = $(if ($fees.Count) { ($fees | Measure-Object -Maximum).Maximum } else { $null })
        perf   = $perf
        ar     = Num $fi.Aktiv_risk
        sd     = Num $fi.'Standardavvikelse_24_månader'
        # [double] på båda: med heltalet 1 väljer PowerShell Min(int, int) och avrundar andelen till 0 eller 1
        eq     = $(if ($aum -and $aum -gt 0) { [math]::Min([double]1, [double]$equity / $aum) } else { $null })
        index  = $name -match $IndexRe
        h      = $holdings
      }
    }
  } finally { $zip.Dispose() }
  # Kursen är medianen av fondernas rapporterade kurser (marknadsvärde / antal), så att ett felrapporterat
  # innehav hos en enskild fond inte slår igenom
  foreach ($isin in $prices.Keys) {
    $l = $prices[$isin]; $l.Sort()
    $price[$isin] = if ($l.Count % 2) { $l[($l.Count - 1) / 2] } else { ($l[$l.Count / 2 - 1] + $l[$l.Count / 2]) / 2 }
  }
  $q = @{ id = $release.Id; funds = $funds; names = $names; sect = $sect; country = $country; price = $price; date = $date }
  $QuarterCache[$release.Id] = $q
  return $q
}

# Splitjustering: en split ger samma kvot nu/förra hos de flesta fonder som ägt aktien båda
# kvartalen. En nyemission ger spridda kvoter och justeras inte.
function Get-SplitFactors($P, $C) {
  $ratios = @{}
  foreach ($id in $C.funds.Keys) {
    $fp = $P.funds[$id]
    if (-not $fp) { continue }
    $hc = $C.funds[$id].h
    foreach ($isin in $hc.Keys) {
      $before = $fp.h[$isin]
      if (-not $before) { continue }
      if (-not $ratios.ContainsKey($isin)) { $ratios[$isin] = New-Object System.Collections.Generic.List[double] }
      $ratios[$isin].Add($hc[$isin] / $before)
    }
  }
  $factor = @{}
  foreach ($isin in $ratios.Keys) {
    $list = $ratios[$isin]
    if ($list.Count -lt 3) { continue }
    # Fonder som inte handlat i aktien får exakt splitkvoten. Om minst tre fonder (och minst 15 %)
    # har exakt samma kvot långt från 1 är det en split, även om andra fonder handlat samtidigt.
    $buckets = @{}
    foreach ($r in $list) {
      if ($r -lt 1.8 -and $r -gt 0.55) { continue }
      $key = [math]::Round([math]::Log($r) / 0.002)
      if (-not $buckets.ContainsKey($key)) { $buckets[$key] = New-Object System.Collections.Generic.List[double] }
      $buckets[$key].Add($r)
    }
    $best = $null
    foreach ($b in $buckets.Values) { if (-not $best -or $b.Count -gt $best.Count) { $best = $b } }
    if ($best -and $best.Count -ge 3 -and $best.Count / $list.Count -ge 0.15) {
      $s = @($best | Sort-Object)
      $factor[$isin] = $s[[int][math]::Floor($s.Count / 2)]
    }
  }
  # Splittar där fonderna också handlat samma kvartal: de flesta fonder har fått ungefär k gånger fler aktier
  # samtidigt som kursen fallit till ungefär 1/k (eller tvärtom vid sammanläggning). Kvoten avrundas till en vanlig splitkvot.
  foreach ($isin in $ratios.Keys) {
    if ($factor.ContainsKey($isin)) { continue }
    $list = $ratios[$isin]
    if ($list.Count -lt 3) { continue }
    $s = @($list | Sort-Object); $med = [double]$s[[int][math]::Floor($s.Count / 2)]
    if ($med -lt 1.8 -and $med -gt 0.55) { continue }
    $p1 = $P.price[$isin]; $p2 = $C.price[$isin]
    if (-not $p1 -or -not $p2) { continue }
    $inv = [double]$p1 / [double]$p2
    if ([math]::Abs([math]::Log($inv / $med)) -gt [math]::Log(1.3)) { continue }
    $best = $null
    foreach ($k in @(2, 3, 4, 5, 6, 8, 10, 15, 20, 25, 50, 100, 200)) {
      foreach ($cand in @([double]$k, (1.0 / $k))) {
        if ($null -eq $best -or [math]::Abs([math]::Log($inv / $cand)) -lt [math]::Abs([math]::Log($inv / $best))) { $best = $cand }
      }
    }
    if ([math]::Abs([math]::Log($inv / $best)) -lt [math]::Log(1.15)) { $factor[$isin] = $best }
  }
  return $factor
}

function Get-Totals($Q) {
  $tot = @{}
  foreach ($fd in $Q.funds.Values) {
    foreach ($isin in $fd.h.Keys) { $tot[$isin] = [double]$tot[$isin] + $fd.h[$isin] * [double]$Q.price[$isin] }
  }
  return $tot
}

function Stock-Meta($P, $C, $isin, $factor) {
  $nm = $C.names[$isin]; if (-not $nm) { $nm = $P.names[$isin] }
  $sc = $C.sect[$isin]; if (-not $sc) { $sc = $P.sect[$isin] }
  $ct = $C.country[$isin]; if (-not $ct) { $ct = $P.country[$isin] }
  $sec = $null; $code = Top $sc; if ($code) { $sec = $Gics[$code] }
  $px = $C.price[$isin]
  if (-not $px) { $px = $P.price[$isin]; if ($px -and $factor[$isin]) { $px = $px / $factor[$isin] } }
  return @{ name = (Top $nm); sector = $sec; country = (Top $ct); price = $px }
}

# Skriver en marknadsfil (svenska eller utländska aktier) för ett kvartalspar
function Write-Market($P, $C, $factor, [string[]]$isins, $meta, $extra, $file) {
  $isins = @($isins | Sort-Object)
  $idx = @{}
  for ($k = 0; $k -lt $isins.Count; $k++) { $idx[$isins[$k]] = $k }

  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('{"meta":' + $meta + ',"stocks":[')
  for ($k = 0; $k -lt $isins.Count; $k++) {
    $isin = $isins[$k]
    $m = Stock-Meta $P $C $isin $factor
    if ($k -gt 0) { [void]$sb.Append(",") }
    [void]$sb.Append("[" + (J $isin) + "," + (J $m.name) + "," + (J $m.sector) + "," + (N $m.price) + "," + (N $factor[$isin]) + "," + (J $m.country) + "]")
  }
  [void]$sb.Append('],"funds":[')

  $ids = New-Object System.Collections.Generic.HashSet[string]
  foreach ($id in $P.funds.Keys) { [void]$ids.Add($id) }
  foreach ($id in $C.funds.Keys) { [void]$ids.Add($id) }
  $first = $true
  foreach ($id in ($ids | Sort-Object)) {
    $fp = $P.funds[$id]; $fc = $C.funds[$id]
    $info = if ($fc) { $fc } else { $fp }
    $keys = New-Object System.Collections.Generic.HashSet[string]
    if ($fp) { foreach ($k in $fp.h.Keys) { if ($idx.ContainsKey($k)) { [void]$keys.Add($k) } } }
    if ($fc) { foreach ($k in $fc.h.Keys) { if ($idx.ContainsKey($k)) { [void]$keys.Add($k) } } }
    if ($keys.Count -eq 0) { continue }
    $rows = foreach ($isin in $keys) {
      $s1 = if ($fp) { $fp.h[$isin] } else { $null }
      if ($s1 -and $factor[$isin]) { $s1 = $s1 * $factor[$isin] }
      $s2 = if ($fc) { $fc.h[$isin] } else { $null }
      "[" + $idx[$isin] + "," + (N $s1) + "," + (N $s2) + "]"
    }
    if (-not $first) { [void]$sb.Append(",") }; $first = $false
    $aumPrev = if ($fp) { $fp.aum } else { $null }
    $aumCurr = if ($fc) { $fc.aum } else { $null }
    [void]$sb.Append("[" + (J $id) + "," + (J $info.name) + "," + (J $info.co) + "," + (J $info.bench) + "," + (N $aumPrev) + "," + (N $aumCurr) + ",[")
    [void]$sb.Append(($rows -join ",") + "]]")
  }
  [void]$sb.Append("]" + $extra + "}")
  Write-Utf8 $file $sb.ToString()
  return $isins.Count
}

function Build-Pair($prevRel, $currRel) {
  Write-Host "Bygger $($currRel.Id) (jämfört med $($prevRel.Id))"
  $P = Read-Quarter $prevRel
  $C = Read-Quarter $currRel
  $factor = Get-SplitFactors $P $C

  $all = New-Object System.Collections.Generic.HashSet[string]
  foreach ($q in @($P, $C)) { foreach ($fd in $q.funds.Values) { foreach ($k in $fd.h.Keys) { [void]$all.Add($k) } } }
  $totP = Get-Totals $P; $totC = Get-Totals $C
  $se = @($all | Where-Object { $_.StartsWith("SE") })
  $world = @($all | Where-Object { -not $_.StartsWith("SE") -and [math]::Max([double]$totP[$_], [double]$totC[$_]) -ge $WorldMinValue })

  $meta = '{"v":' + $FormatVersion + ',"id":' + (J $currRel.Id) + ',"prevId":' + (J $prevRel.Id) + ',"prev":' + (J $P.date) + ',"curr":' + (J $C.date) +
    ',"built":' + (J (Get-Date -Format "yyyy-MM-dd")) + ',"src":[' + (J $prevRel.File) + ',' + (J $currRel.File) + ']}'

  # Nyckeltal för alla fonder i det senaste kvartalet (avgifter, aktiv risk, aktieandel)
  $info = foreach ($id in ($C.funds.Keys | Sort-Object)) {
    $f = $C.funds[$id]
    "[" + (J $id) + "," + (J $f.name) + "," + (J $f.co) + "," + (J $f.bench) + "," + (N $f.aum) + "," + (N $f.feeMin) + "," + (N $f.feeMax) + "," +
      $(if ($f.perf) { "1" } else { "0" }) + "," + (N $f.ar) + "," + (N $f.sd) + "," + (N $f.eq "0.###") + "," + $f.h.Count + "]"
  }
  $extra = ',"fundInfo":[' + (@($info) -join ",") + "]"

  $nSe = Write-Market $P $C $factor $se $meta $extra (Join-Path $OutDir ($currRel.Id + ".json"))
  $nWorld = Write-Market $P $C $factor $world $meta "" (Join-Path $OutDir ($currRel.Id + "-world.json"))
  $splits = ($factor.Keys | ForEach-Object { "$_ x" + [math]::Round($factor[$_], 3) }) -join ", "
  Write-Host ("  {0} svenska och {1} utländska aktier. Splitjusterade: {2}" -f $nSe, $nWorld, $(if ($splits) { $splits } else { "inga" }))
}

# Historik: per aktie och kvartal antal fonder som äger, fondernas innehav och nettoköp
function Build-History($releases, $file) {
  $ordered = @($releases | Sort-Object Year, Q)
  Write-Host "Bygger historik för $($ordered.Count) kvartal ($($ordered[0].Id)–$($ordered[-1].Id))"
  $series = @{}; $peak = @{}; $metaOf = @{}
  $prev = $null; $prevCount = $null; $prevValue = $null
  for ($qi = 0; $qi -lt $ordered.Count; $qi++) {
    $C = Read-Quarter $ordered[$qi]
    $factor = if ($prev) { Get-SplitFactors $prev $C } else { @{} }
    $count = @{}; $value = @{}; $flow = @{}; $flowA = @{}
    foreach ($id in $C.funds.Keys) {
      $fc = $C.funds[$id]
      $fp = if ($prev) { $prev.funds[$id] } else { $null }
      foreach ($isin in $fc.h.Keys) {
        $count[$isin] = 1 + [int]$count[$isin]
        $value[$isin] = [double]$value[$isin] + $fc.h[$isin] * [double]$C.price[$isin]
      }
      if (-not $fp) { continue }
      $keys = New-Object System.Collections.Generic.HashSet[string]
      foreach ($k in $fc.h.Keys) { [void]$keys.Add($k) }
      foreach ($k in $fp.h.Keys) { [void]$keys.Add($k) }
      foreach ($isin in $keys) {
        $px = $C.price[$isin]
        if (-not $px -and $prev.price[$isin]) { $px = $prev.price[$isin] / $(if ($factor[$isin]) { $factor[$isin] } else { 1 }) }
        if (-not $px) { continue }
        $s1 = [double]$fp.h[$isin]; if ($factor[$isin]) { $s1 = $s1 * $factor[$isin] }
        $d = ([double]$fc.h[$isin] - $s1) * $px
        $flow[$isin] = [double]$flow[$isin] + $d
        if (-not $fc.index) { $flowA[$isin] = [double]$flowA[$isin] + $d }
      }
    }
    $isins = New-Object System.Collections.Generic.HashSet[string]
    foreach ($k in $count.Keys) { [void]$isins.Add($k) }
    foreach ($k in $flow.Keys) { [void]$isins.Add($k) }
    foreach ($isin in $isins) {
      if (-not $series.ContainsKey($isin)) { $series[$isin] = New-Object System.Collections.Generic.List[string] }
      $v = [double]$value[$isin]
      $fl = if ($prev) { N ($flow[$isin] / 1e6) "0.#" } else { "null" }
      $fa = if ($prev) { N ($flowA[$isin] / 1e6) "0.#" } else { "null" }
      # Nytt eller försvunnet aktieslag (notering, byte av ISIN vid split, uppköp): nästan inget innehav ena kvartalet.
      # Det räknas inte som köp eller sälj, samma regel som i kvartalsfilerna.
      if ($prevValue) {
        $pv = [double]$prevValue[$isin]
        if ($pv -lt 0.02 * $v -or $v -lt 0.02 * $pv) { $fl = "null"; $fa = "null" }
      }
      # Kursförändring sedan förra kvartalet, splitjusterad (används av backtestet). Saknas kurs något av kvartalen blir den null.
      $ret = "null"
      # Rasar antalet fonder som äger aktien med mer än 70 % är det oftast ett byte av ISIN (split med nytt aktieslag),
      # en avnotering eller en fusion. Kursen bygger då på några få kvarglömda rapporter och räknas inte.
      $collapsed = $prevCount -and $prevCount[$isin] -and [int]$count[$isin] -lt 0.3 * [int]$prevCount[$isin]
      if ($prev -and -not $collapsed -and $C.price[$isin] -and $prev.price[$isin]) {
        $fac = if ($factor[$isin]) { [double]$factor[$isin] } else { 1.0 }
        $ret = N ([double]$C.price[$isin] * $fac / [double]$prev.price[$isin] - 1) "0.####"
      }
      $series[$isin].Add("[" + $qi + "," + [int]$count[$isin] + "," + (N ($v / 1e6) "0.#") + "," + $fl + "," + $fa + "," + $ret + "]")
      if ($v -gt [double]$peak[$isin]) { $peak[$isin] = $v }
    }
    # Spara metadata (namn, sektor, land) från senaste kvartalet aktien förekom
    foreach ($isin in $count.Keys) {
      $m = Stock-Meta $C $C $isin @{}
      $metaOf[$isin] = $m
    }
    if ($prev) { $QuarterCache.Remove($prev.id) }
    $prev = $C
    $prevCount = $count
    $prevValue = $value
  }

  # Två filer: svenska och utländska aktier, så att sajten bara laddar det den behöver
  $head = '{"v":' + $FormatVersion + ',"ret":3,"built":' + (J (Get-Date -Format "yyyy-MM-dd")) + ',"quarters":[' + ((@($ordered | ForEach-Object { J $_.Id })) -join ",") + ']' +
    ',"src":[' + ((@($ordered | ForEach-Object { J $_.File })) -join ",") + '],"stocks":{'
  foreach ($part in @("se", "world")) {
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append($head)
    $first = $true; $kept = 0
    foreach ($isin in ($series.Keys | Sort-Object)) {
      $isSe = $isin.StartsWith("SE")
      if ($isSe -ne ($part -eq "se")) { continue }
      $min = if ($isSe) { $HistoryMinSe } else { $HistoryMinWorld }
      if ([double]$peak[$isin] -lt $min) { continue }
      $m = $metaOf[$isin]
      if (-not ($m -is [hashtable])) { continue }
      if (-not $first) { [void]$sb.Append(",") }; $first = $false
      [void]$sb.Append((J $isin) + ":[" + (J $m.name) + "," + (J $m.sector) + "," + (J $m.country) + ",[" + ($series[$isin] -join ",") + "]]")
      $kept++
    }
    [void]$sb.Append("}}")
    Write-Utf8 (Join-Path $OutDir "history-$part.json") $sb.ToString()
    Write-Host "  Historik ($part) för $kept aktier."
  }
}

# ---------------------------------------------------------------------------
# Uppköp: erbjudandehandlingar från FI:s prospektregister

function Get-OfferList([int]$fromYear) {
  $list = @()
  for ($y = $fromYear; $y -le (Get-Date).Year; $y++) {
    $html = (Invoke-WebRequest -Uri "$FiBase/sv/vara-register/prospektregistret/?dokumenttyp=erbjudandehandling&year=$y" -UseBasicParsing).Content
    foreach ($m in [regex]::Matches($html, '(?s)<td class="date">(\d{4}-\d{2}-\d{2})</td>\s*<td>(.*?)</td>\s*<td>(.*?)</td>\s*<td><a href="details\?id=([\d-]+)"')) {
      $list += [pscustomobject]@{
        Id = $m.Groups[4].Value; Date = $m.Groups[1].Value
        Bidder = [System.Net.WebUtility]::HtmlDecode($m.Groups[2].Value).Trim()
        Type = [System.Net.WebUtility]::HtmlDecode($m.Groups[3].Value).Trim()
      }
    }
  }
  return $list
}

# Läser de första sidorna i erbjudandehandlingen med pdftotext (poppler)
function Get-OfferText($id) {
  New-Item -ItemType Directory -Force $CacheDir | Out-Null
  $pdf = Join-Path $CacheDir "offer-$id.pdf"
  $txt = Join-Path $CacheDir "offer-$id.txt"
  if (-not (Test-Path $txt)) {
    Write-Host "  Läser erbjudandehandling $id"
    Invoke-WebRequest -Uri "$FiBase/sv/vara-register/prospektregistret/GetFile?id=$id" -OutFile $pdf -UseBasicParsing
    & pdftotext -f 1 -l 15 -enc UTF-8 $pdf $txt 2>$null
    Remove-Item $pdf -ErrorAction SilentlyContinue
    if (-not (Test-Path $txt)) { return $null }
  }
  return [System.IO.File]::ReadAllText($txt, [System.Text.Encoding]::UTF8)
}

function Parse-Offer($text) {
  $r = @{ target = $null; price = $null; premium = $null; currency = $null }
  if (-not $text) { return $r }
  $t = $text -replace '­', '' -replace '[‐-–]', '-'
  # Fotnotsmarkeringar som "aktier3)" eller "Fortnox4)" stör tolkningen
  $t = $t -replace '(?<=\p{L})\d{1,2}\)', ''
  $head = ($t -split "`n" | Select-Object -First 60) -join "`n"
  $patterns = @(
    '(?im)erbjudande\s+till\s+aktieägarna\s+i\s+(.+?)\s*$',
    '(?im)^\s*(?:offentligt\s+)?(?:kontant\s+)?(?:uppköps)?erbjudande\s+avseende\s+(?:samtliga\s+)?(?:aktier(?:na)?\s+i\s+)?(.+?)\s*$',
    '(?i)(?:uppköpserbjudande|kontanterbjudande|budpliktserbjudande|erbjudande)\s+avseende\s+(?:förvärv\s+av\s+)?(?:samtliga\s+(?:utestående\s+)?)?(?:(?:stam)?aktier(?:na)?\s+i\s+)?(.+?)\s*[\(,]',
    '(?im)offer\s+to\s+the\s+shareholders\s+(?:of|in)\s+(.+?)\s*$'
  )
  foreach ($p in $patterns) {
    $m = [regex]::Match($head, $p)
    $cand = $m.Groups[1].Value.Trim()
    if ($m.Success -and $cand.Length -ge 2 -and $cand.Length -le 80 -and $cand -notmatch '(?i)^(?:stam)?aktier|\baktier\s+i\b') { $r.target = $cand; break }
  }
  # Första premien mot stängningskursen, även när den står i en punktlista efter "en premie om:"
  $pm = [regex]::Match($t, '(?is)premie\s+(?:om|på).{0,250}?(\d{1,3}(?:[,.]\d+)?)\s*(?:procent|%)\s+(?:jämfört\s+med|i\s+förhållande\s+till|i\s+relation\s+till)\s+(?:den\s+)?(?:stängnings|slut)kurs')
  if ($pm.Success) { $r.premium = Num $pm.Groups[1].Value }
  # Budpriset: tydliga formuleringar först, aldrig utdelningar eller stängningskurser
  $num = '(\d{1,4}(?:[  ]\d{3})*(?:,\d{1,2})?)\s*(kronor|SEK|EUR|USD|NOK|DKK)'
  foreach ($p in @(
      "(?i)(?:erbjuder|erbjudandepriset\s+(?:om|är)|priset\s+i\s+erbjudandet\s+(?:är|om))\s+$num",
      "(?i)$num\s+(?:kontant\s+|i\s+kontanter\s+)per\s+(?:stam)?aktie",
      "(?i)(?:offers?|offer\s+price\s+of)\s+$num\s+in\s+cash")) {
    $pr = [regex]::Match($t, $p)
    if ($pr.Success) {
      $r.price = Num ($pr.Groups[1].Value -replace '[  ]', '')
      $r.currency = $(if ($pr.Groups[2].Value -eq 'kronor') { 'SEK' } else { $pr.Groups[2].Value.ToUpper() })
      break
    }
  }
  return $r
}

function Norm-Company($s) {
  $s = ([string]$s).ToLowerInvariant()
  $s = $s -replace '\(publ\)|\bpubl\b', ' ' -replace "[\.,'’`"\(\)&/\-]", ' '
  $s = $s -replace '\b(ab|aktiebolag|asa|oyj|plc|inc|ltd|sa|se|nv|corp|co)\b', ' '
  $s = $s -replace '\b(ser|class|series|shs|aktie|aktier|sdb|b|a|c|d)\b', ' '
  return ($s -replace '\s+', ' ').Trim()
}

# Kvartalet före ett datum, t.ex. 2025-05-12 -> 2025Q1
function Quarter-Before($date) {
  $y = [int]$date.Substring(0, 4); $mo = [int]$date.Substring(5, 2)
  $q = [math]::Ceiling($mo / 3) - 1
  if ($q -eq 0) { $y--; $q = 4 }
  return "$($y)Q$q"
}

$NormCache = @{}
$OfferParser = 3   # höj när tolkningen av erbjudandehandlingar ändras, så läses alla om en gång
function Build-Offers($releases, $file, [int]$fromYear) {
  $hasPdf = $null -ne (Get-Command pdftotext -ErrorAction SilentlyContinue)
  $existing = @{}
  if (Test-Path $file) {
    $old = Get-Content $file -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($o in $old.offers) { $existing[$o.id] = $o }
  }
  $offers = Get-OfferList $fromYear
  Write-Host "Uppköp: $($offers.Count) erbjudandehandlingar sedan $fromYear"
  $byId = @{}; foreach ($r in $releases) { $byId[$r.Id] = $r }
  $out = @(); $changed = $false
  foreach ($o in ($offers | Sort-Object Date -Descending)) {
    $prev = $existing[$o.Id]
    # Ett dokument läses bara om en gång om tolkningen ändrats (parsed = versionen av tolkningsreglerna)
    if ($prev -and ([int]$prev.parsed -ge $OfferParser -or -not $hasPdf)) { $out += ($prev | ConvertTo-Json -Depth 5 -Compress); continue }
    if (-not $hasPdf) { Write-Host "  pdftotext saknas, hoppar över $($o.Id)"; continue }
    $parsed = Parse-Offer (Get-OfferText $o.Id)
    $changed = $true

    # Hitta målbolaget bland aktierna i kvartalet före budet
    $qid = Quarter-Before $o.Date
    $rel = $byId[$qid]; if (-not $rel) { $rel = $releases[0]; $qid = $rel.Id }
    $Q = Read-Quarter $rel
    $isins = @()
    if ($parsed.target) {
      $tn = Norm-Company $parsed.target
      if (-not $NormCache.ContainsKey($Q.id)) {
        $tot = Get-Totals $Q
        $NormCache[$Q.id] = @(foreach ($isin in $Q.names.Keys) {
          if ($isin -notmatch '^(SE|FI|DK|NO)') { continue }
          foreach ($nm in $Q.names[$isin].Keys) { [pscustomobject]@{ Isin = $isin; Norm = (Norm-Company $nm); Value = [double]$tot[$isin] } }
        })
      }
      $cands = foreach ($c in $NormCache[$Q.id]) {
        $sn = $c.Norm
        if ($sn.Length -lt 4 -or $tn.Length -lt 4) { continue }
        if ($sn -eq $tn -or $tn.StartsWith($sn + " ") -or $sn.StartsWith($tn + " ") -or ($sn.Length -ge 12 -and $tn.StartsWith($sn)) -or ($tn.Length -ge 12 -and $sn.StartsWith($tn))) { $c }
      }
      $isins = @($cands | Sort-Object Value -Descending | Select-Object -ExpandProperty Isin -Unique)
    }
    $holders = @()
    if ($isins.Count) {
      foreach ($id in $Q.funds.Keys) {
        $f = $Q.funds[$id]; $v = 0.0
        foreach ($isin in $isins) { if ($f.h[$isin]) { $v += $f.h[$isin] * [double]$Q.price[$isin] } }
        if ($v -gt 0) { $holders += [pscustomobject]@{ id = $id; name = $f.name; v = [math]::Round($v); w = $(if ($f.aum) { [math]::Round($v / $f.aum, 5) } else { $null }) } }
      }
      $holders = @($holders | Sort-Object v -Descending)
    }
    $rec = [ordered]@{
      id = $o.Id; parsed = $OfferParser; date = $o.Date; bidder = $o.Bidder; type = $o.Type; target = $parsed.target
      isins = $isins; quarter = $qid; price = $parsed.price; currency = $parsed.currency; premium = $parsed.premium
      holders = @($holders | ForEach-Object { , @($_.id, $_.name, $_.v, $_.w) })
    }
    $out += ($rec | ConvertTo-Json -Depth 5 -Compress)
    Write-Host ("  {0} {1}: {2} -> {3} ({4} fonder){5}" -f $o.Date, $o.Bidder, $(if ($parsed.target) { $parsed.target } else { "MÅLBOLAG OKÄNT" }), ($isins -join ","), $holders.Count, $(if ($parsed.premium) { ", premie $($parsed.premium) %" } else { "" }))
  }
  if (-not $changed -and (Test-Path $file)) { Write-Host "Uppköpen är aktuella"; return $false }
  Write-Utf8 $file ('{"built":' + (J (Get-Date -Format "yyyy-MM-dd")) + ',"offers":[' + ($out -join ",") + "]}")
  return $true
}

# ---------------------------------------------------------------------------

New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$releases = Get-Releases
Write-Host ("FI har publicerat {0} kvartal, senast {1}" -f $releases.Count, $releases[0].Id)

$built = 0
for ($k = 0; $k -lt [math]::Min($History, $releases.Count - 1); $k++) {
  $curr = $releases[$k]; $prev = $releases[$k + 1]
  $outFile = Join-Path $OutDir ($curr.Id + ".json")
  if (-not $Force -and (Test-Path $outFile) -and (Test-Path (Join-Path $OutDir ($curr.Id + "-world.json")))) {
    $head = [System.IO.File]::ReadAllText($outFile)
    $m = [regex]::Match($head, '^\{"meta":\{"v":(\d+),.*?"src":\["([^"]*)","([^"]*)"\]')
    if ($m.Success -and [int]$m.Groups[1].Value -eq $FormatVersion -and $m.Groups[2].Value -eq $prev.File -and $m.Groups[3].Value -eq $curr.File) {
      Write-Host "$($curr.Id) är aktuell"
      continue
    }
  }
  Build-Pair $prev $curr
  $built++
}

$histReleases = if ($HistoryQuarters -gt 0) { @($releases | Select-Object -First $HistoryQuarters) } else { $releases }
$histFile = Join-Path $OutDir "history-se.json"
$histSrc = '"src":[' + ((@($histReleases | Sort-Object Year, Q | ForEach-Object { J $_.File })) -join ",") + ']'
$histCurrent = (Test-Path $histFile) -and ([System.IO.File]::ReadAllText($histFile).Contains($histSrc)) -and ([System.IO.File]::ReadAllText($histFile).StartsWith('{"v":' + $FormatVersion + ',"ret":3,'))
if ($Force -or -not $histCurrent) {
  Build-History $histReleases $histFile
  $built++
} else {
  Write-Host "Historiken är aktuell"
}

if (Build-Offers $releases (Join-Path $OutDir "offers.json") $OffersFrom) { $built++ }

# index.json listar alla kvartal som finns byggda, nyast först
$indexFile = Join-Path $OutDir "index.json"
if ($built -eq 0 -and (Test-Path $indexFile)) { Write-Host "Inget nytt från FI."; return }
$entries = Get-ChildItem $OutDir -Filter "*.json" | Where-Object { $_.Name -match '^\d{4}Q\d\.json$' } | Sort-Object Name -Descending | ForEach-Object {
  $txt = [System.IO.File]::ReadAllText($_.FullName)
  $meta = [regex]::Match($txt, '^\{"meta":(\{[^{}]*?"src":\[[^\]]*\]\})').Groups[1].Value
  if (-not $meta) { throw "Saknar meta i $($_.Name)" }
  if ($meta -notmatch '"v":' + $FormatVersion + ',') { Write-Host "  Hoppar över $($_.Name) (gammalt format)"; return }
  $meta
}
$index = '{"updated":' + (J (Get-Date -Format "yyyy-MM-dd")) + ',"quarters":[' + (@($entries) -join ",") + ']}'
Write-Utf8 $indexFile $index
Write-Host "Klart."
