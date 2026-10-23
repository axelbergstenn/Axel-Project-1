<#
.SYNOPSIS
  Bygger en fast sida per aktie, fond och fondbolag, delningsbilder, sitemap.xml och robots.txt.

.DESCRIPTION
  Sajten är en enda sida där vyn styrs av det som står efter # (fondinsyn.se/#/aktie/SE0000115446).
  Sökmotorer läser inte det som står efter #, och en delad länk får ingen egen förhandsbild. Skriptet
  skapar därför en riktig sida för varje aktie, fond och fondbolag (fondinsyn.se/aktie/volvo-b/) med
  egen titel, beskrivning, delningsbild och innehållet förifyllt. När sidan har laddats tar appen över
  och visar samma vy som vanligt (sidan anger vyn i <body data-route="...">).

  Sidorna utgår från site/index.html och körs därför efter att versionsnumret satts i bygget.
  Delningsbilderna (1200 x 630) ritas som SVG och görs om till PNG med rsvg-convert. Finns inte
  rsvg-convert (till exempel lokalt i Windows) blir SVG-filerna kvar och sidorna använder standardbilden.
#>
param(
  [string]$Site = "site",
  [string]$BaseUrl = "https://www.fondinsyn.se",
  # Skriver även om site/index.html med förifyllt innehåll. Används bara i bygget, inte lokalt.
  [switch]$WriteHome
)

$ErrorActionPreference = "Stop"
$Inv = [System.Globalization.CultureInfo]::InvariantCulture
$Utf8 = New-Object System.Text.UTF8Encoding $false
$DataDir = Join-Path $Site "data"
$NB = [string][char]0xA0
$MINUS = [string][char]0x2212
$MONTHS = @("januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december")
$FONT = "Roboto, 'Roboto Flex', 'DejaVu Sans', Arial, sans-serif"

# Samma regler som i app.js
$INDEX_RE = '(?i)index|indx|\bomx|passiv|tracker|\betf\b|\bzero\b|\baccess\b'
$MIXED_RE = '(?i)balanser|generation|stratega|\bmix|fokus \d|pension|flex|ränt|obligation|allokering|försiktig|offensiv \d'
$CLOSET_AR = 3
$CLOSET_FEE = 0.7

# ---------- Hjälpfunktioner ----------

function ReadJson($name) { [System.IO.File]::ReadAllText((Join-Path $DataDir $name), [System.Text.Encoding]::UTF8) | ConvertFrom-Json }
function Save($rel, $text) {
  $path = Join-Path $Site $rel
  $dir = Split-Path $path -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($path, $text, $Utf8)
}
function Esc($s) { ([string]$s).Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace('"', "&quot;") }
# Sidtitel "Namn – beskrivning | Fondinsyn". Blir den för lång för Googles träfflista (cirka 65 tecken) används den
# korta beskrivningen, som skiljer t.ex. aktien Electrolux Professional från samma bolag som obligationsemittent.
function PageTitle($name, $what, $short) {
  foreach ($t in @("$name – $what | Fondinsyn", "$name – $short | Fondinsyn")) { if ($t.Length -le 65) { return $t } }
  return "$name – $short"
}
# Beskrivningen i träfflistan kortas vid ett ordslut till cirka 160 tecken
function ShortDesc($d) {
  $d = [string]$d
  if ($d.Length -le 160) { return $d }
  $cut = $d.Substring(0, 157)
  $sp = $cut.LastIndexOf(" ")
  if ($sp -gt 100) { $cut = $cut.Substring(0, $sp) }
  return $cut.TrimEnd(",", ";", ":", " ") + "…"
}
function J($s) { '"' + (([string]$s) -replace '[\x00-\x1f]+', ' ').Replace('\', '\\').Replace('"', '\"') + '"' }
function Num($x) { if ($null -eq $x) { return $null }; return [double]$x }

# "Atlas Copco AB ser. A" -> "atlas-copco-ab-ser-a"
function Slug($s) {
  $t = ([string]$s).ToLowerInvariant().Replace("&", " och ").Normalize([System.Text.NormalizationForm]::FormD)
  $t = [regex]::Replace($t, '\p{Mn}', '')
  $t = [regex]::Replace($t, '[^a-z0-9]+', '-').Trim('-')
  if ($t.Length -gt 70) { $t = $t.Substring(0, 70).Trim('-') }
  if (-not $t) { $t = "x" }
  return $t
}
function Uniq($used, $slug, $suffix) {
  if ($used.ContainsKey($slug)) { $slug = $slug + "-" + (Slug $suffix) }
  $used[$slug] = 1
  return $slug
}

# Samma som prettyName i app.js: "VOLVO AB SER. B" -> "Volvo AB SER. B"
function Pretty($name) {
  $name = [string]$name
  if (-not $name) { return $name }
  if ($name -ceq $name.ToUpperInvariant()) {
    $parts = [regex]::Split($name, '(\s+|-)') | ForEach-Object {
      if ($_.Length -gt 3 -and $_ -cmatch '^[A-ZÅÄÖÉÜ]') { $_.Substring(0, 1) + $_.Substring(1).ToLowerInvariant() } else { $_ }
    }
    $name = $parts -join ""
  }
  return [regex]::Replace($name, '\b(INC|LTD|CORP)\b', [System.Text.RegularExpressions.MatchEvaluator] { param($m) $m.Value.Substring(0, 1) + $m.Value.Substring(1).ToLowerInvariant() })
}

# Svensk talformatering: 1 574,2 och −5,3
function Fmt($v, [int]$dec) {
  $r = [math]::Round([double]$v, $dec)
  if ($r -eq 0) { $r = 0.0 }
  $s = $r.ToString("N$dec", $Inv).Replace(",", "_").Replace(".", ",").Replace("_", $NB)
  if ($s.StartsWith("-")) { $s = $MINUS + $s.Substring(1) }
  return $s
}
function Num0($n) { Fmt $n 0 }
function Signed($s, $v) { if ($v -gt 0) { return "+" + $s }; return $s }
function Mkr($v, [switch]$Sign) {
  $m = [double]$v / 1e6
  $s = if ([math]::Abs($m) -ge 100) { Fmt $m 0 } else { Fmt $m 1 }
  if ($Sign) { return Signed $s $m }; return $s
}
function BigSek($v, [switch]$Sign) {
  if ($null -eq $v) { return "–" }
  $v = [double]$v
  $a = [math]::Abs($v)
  if ($a -eq 0) { return "0 kr" }
  # Samma som bigSek i app.js: en decimal under 100 mkr, och "<0,1 mkr" i stället för "0 mkr"
  if ($a -gt 0 -and $a -lt 5e4) { return "<0,1 mkr" }
  $s = if ($a -ge 1e9) { (Fmt ($v / 1e9) 1) + " mdkr" } elseif ($a -ge 1e8) { (Fmt ($v / 1e6) 0) + " mkr" } else { (Fmt ($v / 1e6) 1) + " mkr" }
  if ($Sign) { return Signed $s $v }; return $s
}
function PctChange($v) { if ($null -eq $v) { return "–" }; return Signed ((Fmt ($v * 100) 1) + " %") $v }
function PctPlain($v) { if ($null -eq $v) { return "–" }; return (Fmt $v 1) + " %" }
function FeeText($fi) {
  if ($null -eq $fi.feeMax) { return "–" }
  if ($null -ne $fi.feeMin -and $fi.feeMin -lt $fi.feeMax) { return (Fmt $fi.feeMin 2) + "–" + (Fmt $fi.feeMax 2) + " %" }
  return (Fmt $fi.feeMax 2) + " %"
}
function QLabel($id) { return "Q" + $id.Substring(5) + " " + $id.Substring(0, 4) }
function DateText($iso) {
  $p = ([string]$iso).Split("-")
  if ($p.Count -ne 3) { return [string]$iso }
  return "{0} {1} {2}" -f [int]$p[2], $MONTHS[[int]$p[1] - 1], $p[0]
}
function Plural($n, $one, $many) { if ($n -eq 1) { return "1 $one" }; return (Num0 $n) + " $many" }
function JoinSv($items) {
  $items = @($items)
  if ($items.Count -eq 0) { return "" }
  if ($items.Count -eq 1) { return $items[0] }
  return (($items[0..($items.Count - 2)]) -join ", ") + " och " + $items[-1]
}
function SignClass($v) { if ($null -eq $v) { return "" }; if ($v -gt 0) { return "pos" }; if ($v -lt 0) { return "neg" }; return "" }
function Colored($v, $text) { return '<span class="' + (SignClass $v) + '">' + $text + "</span>" }
function A($url, $text) { return '<a href="' + (Esc $url) + '">' + (Esc $text) + "</a>" }
function Fig($label, $value) { return "<div><dt>$label</dt><dd>$value</dd></div>" }
function Block($title, $inner, $cls) { return '<section class="block ' + $cls + '"><div class="block-head"><h2>' + $title + "</h2></div>" + $inner + "</section>" }

# Tabell: första kolumnen är vänsterställd (namn), resten högerställda (tal)
# Kolumn fyra och framåt döljs på mobil (hide-sm), som i appens tabeller
function Table($heads, $rows) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('<div class="table-wrap"><table><thead><tr>')
  for ($i = 0; $i -lt $heads.Count; $i++) {
    [void]$sb.Append($(if ($i -eq 0) { '<th class="l" scope="col">' } elseif ($i -ge 3) { '<th class="hide-sm" scope="col">' } else { '<th scope="col">' }) + $heads[$i] + "</th>")
  }
  [void]$sb.Append("</tr></thead><tbody>")
  foreach ($r in $rows) {
    [void]$sb.Append("<tr>")
    for ($i = 0; $i -lt $r.Count; $i++) { [void]$sb.Append($(if ($i -eq 0) { '<td class="l name">' } elseif ($i -ge 3) { '<td class="hide-sm">' } else { "<td>" }) + $r[$i] + "</td>") }
    [void]$sb.Append("</tr>")
  }
  if ($rows.Count -eq 0) { [void]$sb.Append('<tr><td class="empty" colspan="' + $heads.Count + '">Inga rader.</td></tr>') }
  [void]$sb.Append("</tbody></table></div>")
  return $sb.ToString()
}
function NewList { return , (New-Object System.Collections.Generic.List[object]) }

# ---------- Data ----------

$index = ReadJson "index.json"
$qMeta = $index.quarters[0]
$Q = [string]$qMeta.id
$QL = QLabel $Q
$asOf = DateText $qMeta.curr
# Läser ett kvartal och räknar som compute() i app.js (utan att exkludera indexfonder)
# $suffix "-world" läser utländska aktier. $Light hoppar över listorna per fond och aktie (räcker för rapporterna).
function LoadQuarter($qid, $suffix = "", [switch]$Light) {
  $raw = ReadJson "$qid$suffix.json"

  $stocks = NewList
  foreach ($x in $raw.stocks) {
    $stocks.Add([pscustomobject]@{
        isin = [string]$x[0]; name = (Pretty $x[1]); sector = $(if ($x[2]) { [string]$x[2] } else { "Övrigt" })
        price = $(if ($x[3]) { [double]$x[3] } else { 0.0 })
        h2 = 0.0; f2 = 0; h1b = 0.0; h2b = 0.0; flow = 0.0; nNew = 0; nExit = 0; val2 = 0.0; chg = $null
        isNew = $false; isGone = $false; netFlow = $null; slug = $null; split = $x[4]; country = [string]$x[5]
        holders = (NewList); trades = (NewList)
      })
  }

  $funds = NewList
  $fundById = @{}
  foreach ($x in $raw.funds) {
    $f = [pscustomobject]@{
      id = [string]$x[0]; name = [string]$x[1]; co = [string]$x[2]; aum2 = $x[5]; h = $x[6]
      both = ($null -ne $x[4] -and $null -ne $x[5]); val = 0.0; nHold = 0; rows = (NewList)
    }
    $funds.Add($f)
    $fundById[$f.id] = $f
  }

  foreach ($f in $funds) {
    $has2 = $null -ne $f.aum2
    foreach ($r in $f.h) {
      $s = $stocks[[int]$r[0]]
      $s1 = if ($r[1]) { [double]$r[1] } else { 0.0 }
      $s2 = if ($r[2]) { [double]$r[2] } else { 0.0 }
      $d = ($s2 - $s1) * $s.price
      if (-not $Light) { $f.rows.Add([pscustomobject]@{ s = $s; s1 = $s1; s2 = $s2; v = $s2 * $s.price; d = $d }) }
      if ($s2 -and $has2) {
        $f.val += $s2 * $s.price; $f.nHold++
        $s.h2 += $s2; $s.f2++
        if (-not $Light) { $s.holders.Add([pscustomobject]@{ f = $f; v = $s2 * $s.price; s1 = $s1; s2 = $s2 }) }
      }
      if (-not $f.both) { continue }
      $s.h1b += $s1; $s.h2b += $s2; $s.flow += $d
      if (-not $s1 -and $s2) { $s.nNew++ }
      if ($s1 -and -not $s2) { $s.nExit++ }
      if ($s1 -ne $s2 -and -not $Light) { $s.trades.Add([pscustomobject]@{ f = $f; d = $d; s1 = $s1; s2 = $s2 }) }
    }
  }
  $tFunds = @($funds | Where-Object { $_.both }).Count
  $tHeld = 0; $tValue = 0.0; $tNet = 0.0
  foreach ($s in $stocks) {
    $s.val2 = $s.h2 * $s.price
    if ($s.h1b) { $s.chg = ($s.h2b - $s.h1b) / $s.h1b }
    $s.isNew = $s.h1b -eq 0 -and $s.h2b -gt 0
    $s.isGone = $s.h2b -eq 0 -and $s.h1b -gt 0
    if (-not ($s.isNew -or $s.isGone)) { $s.netFlow = $s.flow; $tNet += $s.flow }
    if ($s.f2) { $tHeld++ }
    $tValue += $s.val2
  }
  return [pscustomobject]@{ raw = $raw; meta = $raw.meta; stocks = $stocks; funds = $funds; fundById = $fundById; tFunds = $tFunds; tHeld = $tHeld; tValue = $tValue; tNet = $tNet }
}

Write-Host "Sidor: bygger från $QL"
$cur = LoadQuarter $Q
$raw = $cur.raw; $stocks = $cur.stocks; $funds = $cur.funds; $fundById = $cur.fundById
$tFunds = $cur.tFunds; $tHeld = $cur.tHeld; $tValue = $cur.tValue; $tNet = $cur.tNet

$infos = NewList
$infoById = @{}
foreach ($x in $raw.fundInfo) {
  $fi = [pscustomobject]@{
    id = [string]$x[0]; name = [string]$x[1]; co = [string]$x[2]; bench = [string]$x[3]; aum = (Num $x[4])
    feeMin = (Num $x[5]); feeMax = (Num $x[6]); ar = (Num $x[8]); sd = (Num $x[9]); slug = $null; m = $fundById[[string]$x[0]]
    eq = (Num $x[10]); isIndex = ([string]$x[1] -match $INDEX_RE)
  }
  $infos.Add($fi)
  $infoById[$fi.id] = $fi
}

# Fondbolag (skiftlägeskänsliga nycklar, precis som i appen)
$companies = New-Object 'System.Collections.Generic.Dictionary[string,object]'
foreach ($fi in $infos) {
  if (-not $companies.ContainsKey($fi.co)) {
    $companies[$fi.co] = [pscustomobject]@{ name = $fi.co; funds = (NewList); aum = 0.0; feeAum = 0.0; feeBase = 0.0; se = 0.0; slug = $null }
  }
  $c = $companies[$fi.co]
  $c.funds.Add($fi)
  if ($fi.aum) { $c.aum += $fi.aum }
  if ($null -ne $fi.feeMax -and $fi.aum) { $c.feeAum += $fi.aum * $fi.feeMax; $c.feeBase += $fi.aum }
  if ($fi.m) { $c.se += $fi.m.val }
}
function CoFee($c) { if ($c.feeBase) { return (Fmt ($c.feeAum / $c.feeBase) 2) + " %" }; return "–" }

# Historik för staplarna i delningsbilden
$hist = $null; $hq = -1
try {
  $hist = ReadJson "history-se.json"
  $hq = [array]::IndexOf([string[]]@($hist.quarters), $Q)
} catch { Write-Host "  ingen historik: $($_.Exception.Message)" }
function FlowBars($isin) {
  if (-not $hist -or $hq -lt 1) { return $null }
  $e = $hist.stocks.$isin
  if (-not $e) { return $null }
  $byQ = @{}
  foreach ($r in $e[3]) { $byQ[[int]$r[0]] = $r }
  $out = @()
  for ($k = [math]::Max(1, $hq - 11); $k -le $hq; $k++) {
    $r = $byQ[$k]
    $out += [double]$(if ($r -and $null -ne $r[3]) { $r[3] } else { 0 })
  }
  return , $out
}

# ---------- Adresser ----------

$pageStocks = @($stocks | Where-Object { $_.f2 -gt 0 } | Sort-Object isin)
$used = @{}
foreach ($s in $pageStocks) { $s.slug = Uniq $used (Slug $s.name) $s.isin }
# Två aktieslag med samma namn (t.ex. stam- och preferensaktie) skiljs åt med ISIN i sidtiteln
$nameCount = @{}; foreach ($s in $pageStocks) { $nameCount[$s.name] = 1 + [int]$nameCount[$s.name] }
$used = @{}
foreach ($fi in @($infos | Sort-Object id)) { $fi.slug = Uniq $used (Slug $fi.name) $fi.id }
$used = @{}
$coList = @($companies.Values | Sort-Object name)
$n = 0
foreach ($c in $coList) { $n++; $c.slug = Uniq $used (Slug $c.name) $n }

function StockUrl($s) { if ($s.slug) { return "/aktie/$($s.slug)/" }; return "/#/aktie/$($s.isin)" }
function FundUrl($id) { $fi = $infoById[$id]; if ($fi) { return "/fond/$($fi.slug)/" }; return "/#/fond/" + [uri]::EscapeDataString($id) }
function CoUrl($co) { if ($companies.ContainsKey($co)) { return "/fondbolag/$($companies[$co].slug)/" }; return "/#/fondbolag/" + [uri]::EscapeDataString($co) }

# Gamla sidor tas bort så att aktier och fonder som försvunnit inte ligger kvar
foreach ($dir in @("aktie", "fond", "fondbolag", "aktier", "fonder", "ordlista", "rapport", "og", "data/fund", "data/hist", "data/csv", "oppen-data", "data/insyn", "data/rf", "data/re", "rantor", "emittent", "integritet", "dubbelsignal", "sparande", "signaler", "agarandel", "toppfonder", "backtest", "metod", "rss", "data/dataset")) {
  $p = Join-Path $Site $dir
  if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}

# ---------- Små datafiler för appen ----------
# En fond- eller aktiesida hämtar bara det den behöver i stället för de stora filerna (se fundWorld,
# needStockHistory, needProfiles och needSearchNames i app.js):
#   data/fund/<id>.json    fondens utländska innehav
#   data/hist/<isin>.json  historiken för en svensk aktie
#   data/profiles.json     aktiv andel, tio största och antal aktier per fond
#   data/search.json       utländska aktier att söka bland

# JSON utan ConvertTo-Json, som i Windows PowerShell 5.1 gör om listor till objekt
function JVal($v) {
  if ($null -eq $v) { return "null" }
  if ($v -is [string]) { return J $v }
  if ($v -is [bool]) { if ($v) { return "true" }; return "false" }
  if ($v -is [System.Collections.IList]) {
    $parts = New-Object 'System.Collections.Generic.List[string]'
    foreach ($x in $v) { $parts.Add((JVal $x)) }
    return "[" + [string]::Join(",", $parts) + "]"
  }
  if ($v -is [int] -or $v -is [long]) { return $v.ToString($Inv) }
  return ([double]$v).ToString("R", $Inv)
}

$rawW = $null
try { $rawW = ReadJson "$Q-world.json" } catch { Write-Host "  ingen utlandsdata: $($_.Exception.Message)" }

# Alla aktieinnehav per fond med värde i kronor, som fundPositions() i app.js
$pos = @{}
function AddPos($id, $isin, $v) {
  if (-not $pos.ContainsKey($id)) { $pos[$id] = New-Object System.Collections.Generic.List[object] }
  $pos[$id].Add(@([string]$isin, [double]$v))
}
foreach ($f in $funds) {
  if ($null -eq $f.aum2) { continue }
  foreach ($r in $f.rows) { if ($r.s2 -and $r.s.price) { AddPos $f.id $r.s.isin $r.v } }
}

$fundFiles = @{}; $wF2 = @{}; $wH2 = @{}
if ($rawW) {
  $wStocks = $rawW.stocks
  foreach ($x in $rawW.funds) {
    $id = [string]$x[0]; $has2 = $null -ne $x[5]
    $idx = @{}
    $sub = New-Object System.Collections.Generic.List[object]
    $h = New-Object System.Collections.Generic.List[object]
    foreach ($r in $x[6]) {
      $i = [int]$r[0]; $st = $wStocks[$i]
      if (-not $idx.ContainsKey($i)) { $idx[$i] = $sub.Count; $sub.Add($st) }
      $h.Add(@($idx[$i], $r[1], $r[2]))
      $s2 = if ($r[2]) { [double]$r[2] } else { 0.0 }
      if ($s2 -and $has2) {
        if (-not $wF2.ContainsKey($i)) { $wF2[$i] = 0; $wH2[$i] = 0.0 }
        $wF2[$i] = $wF2[$i] + 1; $wH2[$i] = $wH2[$i] + $s2
        if ($st[3]) { AddPos $id $st[0] ($s2 * [double]$st[3]) }
      }
    }
    $fundFiles[$id] = '{"q":' + (J $Q) + ',"stocks":' + (JVal $sub) + ',"funds":[' + (JVal @($x[0], $x[1], $x[2], $x[3], $x[4], $x[5], $h)) + "]}"
  }
}

$allIds = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($fi in $infos) { [void]$allIds.Add($fi.id) }
foreach ($f in $funds) { [void]$allIds.Add($f.id) }
foreach ($k in $fundFiles.Keys) { [void]$allIds.Add($k) }
if ($rawW) {
  $empty = '{"q":' + (J $Q) + ',"stocks":[],"funds":[]}'
  foreach ($id in $allIds) { Save "data/fund/$id.json" $(if ($fundFiles.ContainsKey($id)) { $fundFiles[$id] } else { $empty }) }
}

# Vikter per fond och region (minst 80 % svenska eller utländska aktier), som stockWeights() och regionOf()
$wts = @{}
foreach ($id in @($pos.Keys)) {
  $w = @{}; $tot = 0.0; $seV = 0.0
  foreach ($o in $pos[$id]) { $tot += $o[1]; if ($o[0].StartsWith("SE")) { $seV += $o[1] } }
  $div = if ($tot) { $tot } else { 1.0 }
  foreach ($o in $pos[$id]) { $w[$o[0]] = [double]$w[$o[0]] + $o[1] / $div }
  $region = $null
  if ($tot) { $share = $seV / $tot; if ($share -ge 0.8) { $region = "se" } elseif ($share -le 0.2) { $region = "world" } }
  $wts[$id] = @{ w = $w; n = $pos[$id].Count; region = $region }
}

# Index = indexfondernas sammanlagda innehav viktat efter storlek, som indexProxy()
$proxy = @{}; $proxyTot = @{}
foreach ($reg in @("se", "world")) {
  $sum = @{}; $tot = 0.0
  foreach ($fi in $infos) {
    if (-not $fi.isIndex -or -not $fi.aum -or -not $wts.ContainsKey($fi.id) -or $wts[$fi.id].region -ne $reg) { continue }
    $fw = $wts[$fi.id].w
    foreach ($k in $fw.Keys) { $sum[$k] = [double]$sum[$k] + $fw[$k] * $fi.aum }
    $tot += $fi.aum
  }
  if ($tot) {
    $t2 = 0.0
    foreach ($k in @($sum.Keys)) { $sum[$k] = $sum[$k] / $tot; $t2 += $sum[$k] }
    $proxy[$reg] = $sum; $proxyTot[$reg] = $t2
  }
}

# Aktiv andel = halva summan av viktskillnaderna mot index, som fundProfile()
$profiles = @{}
foreach ($id in $allIds) {
  if (-not $wts.ContainsKey($id)) { continue }
  $x = $wts[$id]
  $ws = @($x.w.Values | Sort-Object -Descending)
  if (-not $ws.Count) { continue }
  $top10 = 0.0
  for ($i = 0; $i -lt [math]::Min(10, $ws.Count); $i++) { $top10 += $ws[$i] }
  $active = $null
  $px = if ($x.region) { $proxy[$x.region] } else { $null }
  $fi = $infoById[$id]
  if ($px -and -not ($fi -and $fi.isIndex)) {
    $diff = 0.0; $pIn = 0.0
    foreach ($k in $x.w.Keys) { $pv = [double]$px[$k]; $diff += [math]::Abs($x.w[$k] - $pv); $pIn += $pv }
    $active = ($diff + $proxyTot[$x.region] - $pIn) / 2
  }
  $profiles[$id] = @($active, $top10, $x.n, $x.region)
}
if ($rawW) {
  $pp = foreach ($id in $profiles.Keys) {
    $p = $profiles[$id]
    (J $id) + ":" + (JVal @($(if ($null -ne $p[0]) { [math]::Round($p[0], 5) } else { $null }), [math]::Round($p[1], 5), $p[2], $p[3]))
  }
  Save "data/profiles.json" ('{"q":' + (J $Q) + ',"p":{' + (@($pp) -join ",") + "}}")

  $names = New-Object 'System.Collections.Generic.List[string]'
  foreach ($i in $wF2.Keys) {
    $st = $wStocks[$i]
    $price = if ($st[3]) { [double]$st[3] } else { 0.0 }
    $names.Add((JVal @($st[0], $st[1], $st[2], $st[5], $wF2[$i], [math]::Round($wH2[$i] * $price))))
  }
  Save "data/search.json" ('{"q":' + (J $Q) + ',"stocks":[' + [string]::Join(",", $names) + "]}")
}

if ($hist) {
  $qs = JVal @($hist.quarters)
  foreach ($prop in $hist.stocks.PSObject.Properties) {
    Save "data/hist/$($prop.Name).json" ('{"quarters":' + $qs + ',"s":' + (JVal $prop.Value) + "}")
  }
}
Write-Host "  små datafiler: $($allIds.Count) fonder, $($profiles.Count) fondprofiler, $($wF2.Count) utländska aktier"

# ---------- Insynsarkivet: en fil per aktie och en sammanställning för tolv månader ----------
# site/data/insyn-arkiv/ fylls på av scripts/build-insider.ps1. Här delas det upp så att aktiesidan bara hämtar sin aktie.
$archDir = Join-Path $DataDir "insyn-arkiv"
if (Test-Path $archDir) {
  $byIsin = @{}
  $yearRows = New-Object System.Collections.Generic.List[string]
  $since = (Get-Date).Date.AddDays(-365).ToString("yyyy-MM-dd")
  $rx = [regex]'^\["[^"]*","([^"]*)","(?:[^"\\]|\\.)*","([^"]*)"'
  foreach ($file in (Get-ChildItem $archDir -Filter *.json | Sort-Object Name -Descending)) {
    foreach ($line in [System.IO.File]::ReadAllLines($file.FullName, [System.Text.Encoding]::UTF8)) {
      if (-not $line.StartsWith('["')) { continue }
      $row = $line.TrimEnd(",")
      $m = $rx.Match($row)
      if (-not $m.Success) { continue }
      $isin = $m.Groups[2].Value
      if (-not $isin) { continue }
      if (-not $byIsin.ContainsKey($isin)) { $byIsin[$isin] = New-Object System.Collections.Generic.List[string] }
      $byIsin[$isin].Add($row)
      if ($m.Groups[1].Value -ge $since) { $yearRows.Add($row) }
    }
  }
  foreach ($isin in $byIsin.Keys) { Save "data/insyn/$isin.json" ('{"rows":[' + ($byIsin[$isin] -join ",") + "]}") }
  $insynArchive = @{}
  foreach ($isin in $byIsin.Keys) { $insynArchive[$isin] = 1 }
  # Köp, sälj och antal köpare per aktie de senaste tolv månaderna
  $agg = @{}
  if ($yearRows.Count) {
    foreach ($r in ("[" + ($yearRows -join ",") + "]" | ConvertFrom-Json)) {
      if ($null -eq $r[11] -or ($r[7] -ne "Förvärv" -and $r[7] -ne "Avyttring")) { continue }
      $k = [string]$r[3]
      if (-not $agg.ContainsKey($k)) { $agg[$k] = @{ name = [string]$r[2]; buy = 0.0; sell = 0.0; buyers = @{} } }
      if ($r[7] -eq "Förvärv") { $agg[$k].buy += [double]$r[11]; $agg[$k].buyers[[string]$r[4]] = 1 } else { $agg[$k].sell += [double]$r[11] }
    }
  }
  $yr = foreach ($k in $agg.Keys) { "[" + (J $k) + "," + (J $agg[$k].name) + "," + [math]::Round($agg[$k].buy).ToString($Inv) + "," + [math]::Round($agg[$k].sell).ToString($Inv) + "," + $agg[$k].buyers.Count + "]" }
  Save "data/insider-year.json" ('{"from":' + (J $since) + ',"rows":[' + (@($yr) -join ",") + "]}")
  Write-Host "  insynsarkiv: $($byIsin.Count) aktier, $($yearRows.Count) affärer senaste året"
}

# ---------- Räntor: en fil per fond och per emittent ----------
# site/data/<kvartal>-rates-funds.json byggs av scripts/build-rates.ps1. Här delas den upp så att fondsidan och
# emittentsidan bara hämtar sitt: data/rf/<fond>.json och data/re/<emittent>.json, med alla kvartal som finns.
$rfParts = @{}; $reParts = @{}; $rateQs = 0; $issLatest = $null
foreach ($rq in $index.quarters) {
  $hp = Join-Path $DataDir "$($rq.id)-rates-funds.json"
  if (-not (Test-Path $hp)) { continue }
  $rateQs++
  $heavyText = [System.IO.File]::ReadAllText($hp, [System.Text.Encoding]::UTF8)
  $heavy = $heavyText | ConvertFrom-Json
  # build-rates.ps1 skriver en fond per rad: fondens del sparas som den är, utan att göras om till JSON igen
  $rawFund = @{}
  foreach ($m in [regex]::Matches($heavyText, '(?m)^"([^"]+)":(\{.*\}),?\r?$')) { $rawFund[$m.Groups[1].Value] = $m.Groups[2].Value }
  $iss = @{}
  foreach ($prop in $heavy.funds.PSObject.Properties) {
    $fid = $prop.Name; $x = $prop.Value
    if (-not $rfParts.ContainsKey($fid)) { $rfParts[$fid] = New-Object System.Collections.Generic.List[string] }
    if ($rawFund.ContainsKey($fid)) { $rfParts[$fid].Add((J $rq.id) + ":" + $rawFund[$fid]) }
    foreach ($b in $x.b) {
      $key = [string]$b[2]
      if (-not $key) { continue }
      if (-not $iss.ContainsKey($key)) { $iss[$key] = @{ f = @{}; b = @{} } }
      $e = $iss[$key]
      if (-not $e.f.ContainsKey($fid)) { $e.f[$fid] = @{ v1 = 0.0; v2 = 0.0; flow = $null } }
      $ef = $e.f[$fid]
      $ef.v1 += [double]$b[8]; $ef.v2 += [double]$b[9]
      if ($null -ne $b[11]) { $ef.flow = [double]$ef.flow + [double]$b[11] }
      $isin = [string]$b[0]
      if (-not $e.b.ContainsKey($isin)) { $e.b[$isin] = @{ name = [string]$b[1]; mat = $b[4]; fl = $b[5]; v2 = 0.0; v1 = 0.0; n = 0 } }
      $eb = $e.b[$isin]
      $eb.v1 += [double]$b[8]; $eb.v2 += [double]$b[9]
      if ([double]$b[9] -gt 0) { $eb.n++ }
    }
  }
  if ($rq.id -eq $Q) { $issLatest = $iss }
  foreach ($key in $iss.Keys) {
    $e = $iss[$key]
    $fr = foreach ($fid in $e.f.Keys) { $ef = $e.f[$fid]; "[" + (J $fid) + "," + [math]::Round($ef.v1).ToString($Inv) + "," + [math]::Round($ef.v2).ToString($Inv) + "," + $(if ($null -eq $ef.flow) { "null" } else { [math]::Round($ef.flow).ToString($Inv) }) + "]" }
    $br = foreach ($isin in $e.b.Keys) { $eb = $e.b[$isin]; "[" + (J $isin) + "," + (J $eb.name) + "," + (J $eb.mat) + "," + $(if ($null -eq $eb.fl) { "null" } else { $eb.fl }) + "," + [math]::Round($eb.v2).ToString($Inv) + "," + $eb.n + "," + [math]::Round($eb.v1).ToString($Inv) + "]" }
    if (-not $reParts.ContainsKey($key)) { $reParts[$key] = New-Object System.Collections.Generic.List[string] }
    $reParts[$key].Add((J $rq.id) + ':{"f":[' + (@($fr) -join ",") + '],"b":[' + (@($br) -join ",") + "]}")
  }
}
foreach ($fid in $rfParts.Keys) { Save "data/rf/$fid.json" ("{" + ($rfParts[$fid] -join ",") + "}") }
foreach ($key in $reParts.Keys) { Save "data/re/$key.json" ("{" + ($reParts[$key] -join ",") + "}") }
Write-Host "  räntor: $rateQs kvartal, $($rfParts.Count) fonder, $($reParts.Count) emittenter"

# ---------- Delningsbilder ----------

$HasRsvg = [bool](Get-Command rsvg-convert -ErrorAction SilentlyContinue)
function FitSize($text, $size, $min, $maxW, $factor) {
  while ($size -gt $min -and $text.Length * $size * $factor -gt $maxW) { $size -= 2 }
  return $size
}
function Clip($text, $size, $maxW, $factor) {
  $max = [math]::Floor($maxW / ($size * $factor))
  if ($text.Length -le $max) { return $text }
  return $text.Substring(0, [math]::Max(1, $max - 1)).TrimEnd(" ", ",", "·") + "…"
}
function TextEl($x, $y, $size, $color, $text, $extra) {
  return '<text x="' + $x + '" y="' + $y + '" font-family="' + $FONT + '" font-size="' + $size + '" fill="' + $color + '"' + $extra + ">" + (Esc $text) + "</text>"
}

# stats: lista med @(etikett, värde, färg). bars: nettoköp per kvartal (eller $null). Annars en textrad.
function OgSvg($title, $sub, $stats, $label, $bars, $line) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">')
  [void]$sb.Append('<rect width="1200" height="630" fill="#ffffff"/><rect width="1200" height="8" fill="#2f6bff"/>')
  # Loggan: Kvartal-symbolen (fyra delar, senaste kvartalet i blått) och namnet
  [void]$sb.Append('<g transform="translate(72,50) scale(1.3)"><path d="M17.5 2.08A14 14 0 0 1 29.92 14.5H17.5Z" fill="#2f6bff"/><path d="M29.92 17.5A14 14 0 0 1 17.5 29.92V17.5ZM14.5 29.92A14 14 0 0 1 2.08 17.5H14.5ZM2.08 14.5A14 14 0 0 1 14.5 2.08V14.5Z" fill="#0b1f3a"/></g>')
  [void]$sb.Append((TextEl 128 84 32 "#0b1f3a" "Fondinsyn" ' font-weight="800" letter-spacing="-0.9"'))
  $ts = FitSize $title 64 40 1056 0.6
  [void]$sb.Append((TextEl 72 205 $ts "#1f2328" (Clip $title $ts 1056 0.6) ' font-weight="700"'))
  [void]$sb.Append((TextEl 72 255 28 "#59636e" (Clip $sub 28 1056 0.55) ""))
  for ($i = 0; $i -lt $stats.Count; $i++) {
    $x = 72 + $i * 352
    $v = [string]$stats[$i][1]
    $vs = FitSize $v 50 28 330 0.6
    [void]$sb.Append((TextEl $x 335 24 "#59636e" $stats[$i][0] ""))
    [void]$sb.Append((TextEl $x 392 $vs $stats[$i][2] $v ' font-weight="700"'))
  }
  [void]$sb.Append('<line x1="72" y1="432" x2="1128" y2="432" stroke="#d1d9e0" stroke-width="2"/>')
  [void]$sb.Append((TextEl 72 476 22 "#59636e" $label ""))
  if ($bars) {
    $pos = 0.0; $neg = 0.0
    foreach ($b in $bars) { if ($b -gt $pos) { $pos = $b }; if (-$b -gt $neg) { $neg = -$b } }
    $span = $pos + $neg
    if ($span -le 0) { $span = 1 }
    $top = 500; $h = 92
    $base = $top + $h * $pos / $span
    $slot = 1056 / $bars.Count
    $w = [math]::Round($slot * 0.62, 1)
    for ($i = 0; $i -lt $bars.Count; $i++) {
      $b = $bars[$i]
      $bh = [math]::Max([double]2, [math]::Abs($b) / $span * $h)
      if ($b -eq 0) { $bh = 0 }
      $x = [math]::Round(72 + $i * $slot + ($slot - $w) / 2, 1)
      $y = if ($b -ge 0) { $base - $bh } else { $base }
      $color = if ($b -ge 0) { "#1a7f37" } else { "#cf222e" }
      $op = if ($i -eq $bars.Count - 1) { "1" } else { "0.55" }
      [void]$sb.Append('<rect x="' + $x + '" y="' + [math]::Round($y, 1) + '" width="' + $w + '" height="' + [math]::Round($bh, 1) + '" rx="3" fill="' + $color + '" fill-opacity="' + $op + '"/>')
    }
    [void]$sb.Append('<line x1="72" y1="' + [math]::Round($base, 1) + '" x2="1128" y2="' + [math]::Round($base, 1) + '" stroke="#8c959f" stroke-width="1.5"/>')
  } elseif ($line) {
    [void]$sb.Append((TextEl 72 535 34 "#1f2328" (Clip $line 34 1056 0.56) ' font-weight="600"'))
  }
  [void]$sb.Append("</svg>")
  return $sb.ToString()
}
function FlowColor($v) { if ($null -eq $v) { return "#1f2328" }; if ($v -gt 0) { return "#1a7f37" }; if ($v -lt 0) { return "#cf222e" }; return "#1f2328" }
# Delningsbild för en kvartalsrapport: rubriken, nettoköpet och de fem största köpen som staplar.
# $items: lista med @(namn, nettoköp i kr)
function ReportOgSvg($kicker, $headline, $netLabel, $net, $items) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">')
  [void]$sb.Append('<rect width="1200" height="630" fill="#ffffff"/>')
  [void]$sb.Append('<g transform="translate(64,46) scale(1.15)"><path d="M17.5 2.08A14 14 0 0 1 29.92 14.5H17.5Z" fill="#2f6bff"/><path d="M29.92 17.5A14 14 0 0 1 17.5 29.92V17.5ZM14.5 29.92A14 14 0 0 1 2.08 17.5H14.5ZM2.08 14.5A14 14 0 0 1 14.5 2.08V14.5Z" fill="#0b1f3a"/></g>')
  [void]$sb.Append((TextEl 112 76 30 "#0b1f3a" "Fondinsyn" ' font-weight="800" letter-spacing="-0.6"'))
  [void]$sb.Append((TextEl 1136 76 24 "#1d5bd6" $kicker ' font-weight="600" text-anchor="end"'))
  # Rubriken på högst två rader
  $size = 50; $maxW = 1072; $factor = 0.54
  $words = ([string]$headline).Split(" "); $lines = @("");
  foreach ($w in $words) {
    $try = ($lines[-1] + " " + $w).Trim()
    if ($try.Length * $size * $factor -le $maxW -or -not $lines[-1]) { $lines[-1] = $try } elseif ($lines.Count -lt 2) { $lines += $w } else { $lines[-1] = Clip ($lines[-1] + " " + $w) $size $maxW $factor }
  }
  for ($i = 0; $i -lt $lines.Count; $i++) { [void]$sb.Append((TextEl 64 (170 + $i * 60) $size "#0c1424" $lines[$i] ' font-weight="700" letter-spacing="-1"')) }
  $top = 170 + $lines.Count * 60 + 18
  # Nettoköpet till vänster
  [void]$sb.Append((TextEl 64 ($top + 40) 24 "#627084" $netLabel ""))
  [void]$sb.Append((TextEl 64 ($top + 112) 76 (FlowColor $net) (BigSek $net -Sign) ' font-weight="700" letter-spacing="-2"'))
  # De största köpen till höger
  $x0 = 560; $rowH = [math]::Min([double]44, (630 - 48 - ($top + 52)) / [math]::Max(1, $items.Count))
  [void]$sb.Append((TextEl $x0 ($top + 40) 22 "#627084" "Mest köpta aktier" ""))
  $max = 1.0
  foreach ($it in $items) { if ([double]$it[1] -gt $max) { $max = [double]$it[1] } }
  for ($i = 0; $i -lt $items.Count; $i++) {
    $y = $top + 52 + $i * $rowH
    $name = Clip ([string]$items[$i][0]) 24 225 0.55
    $w = [math]::Max([double]4, [double]$items[$i][1] / $max * 150)
    [void]$sb.Append((TextEl $x0 ($y + 28) 24 "#0c1424" $name ' font-weight="600"'))
    [void]$sb.Append('<rect x="800" y="' + ($y + 12) + '" width="' + [math]::Round($w, 1).ToString($Inv) + '" height="18" rx="5" fill="#1f9d63"/>')
    [void]$sb.Append((TextEl 1136 ($y + 28) 24 "#0a7a4a" (BigSek ([double]$items[$i][1]) -Sign) ' font-weight="700" text-anchor="end"'))
  }
  [void]$sb.Append('<rect y="606" width="1200" height="24" fill="#0b1f3a"/>')
  [void]$sb.Append((TextEl 64 623 14 "#c9d3e0" "www.fondinsyn.se · Källa: Finansinspektionens fondinnehav" ""))
  [void]$sb.Append("</svg>")
  return $sb.ToString()
}

function Image($name, $svg) {
  Save "og/$name.svg" $svg
  if ($HasRsvg) { return "og/$name.png" }
  return "og/fondinsyn.png"
}

# ---------- Sidor ----------

$template = [System.IO.File]::ReadAllText((Join-Path $Site "index.html"), [System.Text.Encoding]::UTF8)
function TagOf($pattern) {
  $m = [regex]::Match($template, $pattern)
  if (-not $m.Success) { throw "Hittar inte $pattern i index.html" }
  return $m.Value
}
$tag = @{
  charset = TagOf '<meta charset="utf-8">'
  title = TagOf '<title>[^<]*</title>'
  desc = TagOf '<meta name="description" content="[^"]*">'
  ogTitle = TagOf '<meta property="og:title" content="[^"]*">'
  ogDesc = TagOf '<meta property="og:description" content="[^"]*">'
  ogUrl = TagOf '<meta property="og:url" content="[^"]*">'
  ogImage = TagOf '<meta property="og:image" content="[^"]*">'
  canon = TagOf '<link rel="canonical" href="[^"]*">'
  body = TagOf '<body>'
  main = TagOf '<main id="app" class="container" tabindex="-1"></main>'
}
$sitemap = NewList

# Strukturerad data (JSON-LD) som Google läser. $crumbs är namn och adress omväxlande:
# @("Aktier", "aktier/", "Volvo B", "aktie/volvo-b/"). Startsidan läggs till först.
function LdScripts($crumbs, $extra) {
  $lds = @()
  if ($crumbs) {
    $items = @('{"@type":"ListItem","position":1,"name":"Fondinsyn","item":' + (J ($BaseUrl + "/")) + "}")
    for ($i = 0; $i -lt $crumbs.Count; $i += 2) {
      $items += '{"@type":"ListItem","position":' + ($i / 2 + 2) + ',"name":' + (J $crumbs[$i]) + ',"item":' + (J ($BaseUrl + "/" + $crumbs[$i + 1])) + "}"
    }
    $lds += '{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[' + ($items -join ",") + "]}"
  }
  if ($extra) { $lds += $extra }
  return (@($lds | ForEach-Object { '<script type="application/ld+json">' + $_.Replace("</", "<\/") + "</script>" }) -join "`n  ")
}

# Datafilerna som sidan behöver, utöver index.json, front.json och kvartalet. Sidhuvudet börjar hämta dem direkt
# (se skriptet i site/index.html) så att de inte väntar på app.js eller på varandra.
function PreList($route) {
  $r = [string]$route
  $files = switch -regex ($r) {
    '^$' { @("data/history-se.json", "data/reports-pdf.json") }
    '^aktie/(.+)$' {
      $isin = $Matches[1]
      @("data/hist/$isin.json", "data/pages.json", "data/shares.json", "data/insider.json", "data/offers.json", "data/shorts.json") +
        @($(if ($insynArchive -and $insynArchive.ContainsKey($isin)) { "data/insyn/$isin.json" }))
    }
    '^fond/(.+)$' { @("data/fund/$($Matches[1]).json", "data/pages.json", "data/flows.json", "data/perf.json", "data/profiles.json", "data/$Q-rates.json") }
    '^rapport$' { @("data/history-se.json", "data/reports-pdf.json", "data/offers.json") }
    '^rapport/(\d{4}Q\d)$' { @("data/history-se.json", "data/reports-pdf.json", "data/offers.json") + @($(if ($Matches[1] -ne $Q) { "data/$($Matches[1]).json" })) }
    '^rapport/(\d{4}Q\d)/utland$' { @("data/history-world.json", "data/reports-pdf.json", "data/$($Matches[1])-world.json") + @($(if ($Matches[1] -ne $Q) { "data/$($Matches[1]).json" })) }
    '^(rantor|emittent)' { @("data/$Q-rates.json", "data/rates-market.json") }
    '^sparande' { @("data/flows.json") }
    default { @() }
  }
  return ((@($files | Where-Object { $_ }) | ForEach-Object { ", " + (J $_) }) -join "")
}

# $rel: "aktie/volvo-b/" (sparas som index.html) eller ett filnamn som "404.html"
function Page($rel, $route, $title, $desc, $image, $content, $Crumbs, $Ld, [switch]$NoIndex, [switch]$Keep) {
  $url = $BaseUrl + "/" + $(if ($rel.EndsWith("/")) { $rel } else { "" })
  $head = $tag.charset + "`n  <base href=`"/`">" + $(if ($NoIndex) { "`n  <meta name=`"robots`" content=`"noindex`">" } else { "" })
  $t = $template.Replace($tag.charset, $head)
  $t = $t.Replace($tag.title, "<title>" + (Esc $title) + "</title>")
  $desc = ShortDesc $desc
  $t = $t.Replace($tag.desc, '<meta name="description" content="' + (Esc $desc) + '">')
  $t = $t.Replace($tag.ogTitle, '<meta property="og:title" content="' + (Esc $title) + '">')
  $t = $t.Replace($tag.ogDesc, '<meta property="og:description" content="' + (Esc $desc) + '">')
  $t = $t.Replace($tag.ogUrl, '<meta property="og:url" content="' + (Esc $url) + '">')
  $t = $t.Replace($tag.ogImage, '<meta property="og:image" content="' + (Esc ($BaseUrl + "/" + $image)) + '">')
  $t = $t.Replace($tag.canon, '<link rel="canonical" href="' + (Esc $url) + '">')
  if ($route) { $t = $t.Replace($tag.body, '<body data-route="' + (Esc $route) + '"' + $(if ($Keep) { " data-keep" } else { "" }) + '>') }
  $t = $t.Replace($tag.main, '<main id="app" class="container" tabindex="-1">' + $content + "</main>")
  $t = $t.Replace('"__LATEST__"', (J $Q)).Replace('/*PRE*/', (PreList $route))
  $ldHtml = LdScripts $Crumbs $Ld
  if ($ldHtml) { $t = $t.Replace("</head>", "  " + $ldHtml + "`n</head>") }
  if ($rel -eq "" -or $rel.EndsWith("/")) { Save ($rel + "index.html") $t } else { Save $rel $t }
  if (-not $NoIndex) { $script:sitemap.Add($url) }
}
function Source($appHref, $linkText) {
  return '<p class="desc section-gap">Källa: Finansinspektionens fondinnehav per kvartal, ' + $asOf + ". " + (A $appHref $linkText) + "</p>"
}
function ChangeText($h) {
  if (-not $h.f.both) { return "–" }
  if (-not $h.s1) { return '<span class="pos">Ny</span>' }
  $c = ($h.s2 - $h.s1) / $h.s1
  return Colored $c (PctChange $c)
}

# Aktier
foreach ($s in $pageStocks) {
  $holders = @($s.holders | Sort-Object v -Descending)
  $buys = @($s.trades | Where-Object { $_.d -gt 0 } | Sort-Object d -Descending | Select-Object -First 10)
  $sells = @($s.trades | Where-Object { $_.d -lt 0 } | Sort-Object d | Select-Object -First 10)
  $fundsText = Plural $s.f2 "svensk fond" "svenska fonder"

  $lead = "$($s.name) ägs av $fundsText med ett sammanlagt innehav på $(BigSek $s.val2) den $asOf."
  if ($null -ne $s.netFlow -and [math]::Abs($s.flow) -ge 1e6) {
    $lead += $(if ($s.flow -gt 0) { " Under $QL nettoköpte fonderna aktier för $(BigSek $s.flow)" } else { " Under $QL nettosålde fonderna aktier för $(BigSek (-$s.flow))" })
    $extra = @()
    if ($s.nNew) { $extra += (Plural $s.nNew "fond" "fonder") + " köpte in sig för första gången" }
    if ($s.nExit) { $extra += (Plural $s.nExit "fond" "fonder") + " sålde hela sitt innehav" }
    $lead += $(if ($extra.Count) { ", och " + (JoinSv $extra) + "." } else { "." })
  }
  if ($holders.Count) { $lead += " Största ägare är " + (JoinSv @($holders | Select-Object -First 3 | ForEach-Object { $_.f.name })) + "." }

  $metaParts = @((Esc $s.sector), $s.isin)
  if ($s.price) { $metaParts += "Kurs " + (Fmt $s.price 1) + " kr (" + $qMeta.curr + ")" }
  $flowText = if ($null -eq $s.netFlow) { "–" } else { Colored $s.flow (BigSek $s.flow -Sign) }

  $holderRows = NewList
  foreach ($h in ($holders | Select-Object -First 25)) { $holderRows.Add(@((A (FundUrl $h.f.id) $h.f.name), (Mkr $h.v), (ChangeText $h))) }
  $buyRows = NewList; foreach ($t in $buys) { $buyRows.Add(@((A (FundUrl $t.f.id) $t.f.name), (Colored $t.d (Mkr $t.d -Sign)))) }
  $sellRows = NewList; foreach ($t in $sells) { $sellRows.Add(@((A (FundUrl $t.f.id) $t.f.name), (Colored $t.d (Mkr $t.d -Sign)))) }

  $content = '<div class="page-head"><div class="crumbs"><a href="/aktier/">Aktier</a> / ' + (Esc $s.name) + '</div><div class="title-row"><h1>' + (Esc $s.name) + '</h1></div><p class="meta">' + ($metaParts -join " · ") + "</p></div>" +
    '<p class="lead">' + (Esc $lead) + "</p>" +
    '<dl class="figures">' + (Fig "Fonder som äger" (Num0 $s.f2)) + (Fig "Fondernas innehav" $(if ($s.price) { BigSek $s.val2 } else { "–" })) + (Fig "Nettoköp $QL" $flowText) +
    (Fig "Δ antal aktier" (Colored $s.chg (PctChange $s.chg))) + (Fig "Nya fonder" (Num0 $s.nNew)) + (Fig "Avvecklat" (Num0 $s.nExit)) + "</dl>" +
    (Block "Största fondägare" (Table @("Fond", "Innehav (mkr)", "Förändring") $holderRows) "section-gap") +
    '<div class="grid-2 section-gap">' + (Block "Köpte mest $QL" (Table @("Fond", "Netto (mkr)") $buyRows) "") + (Block "Sålde mest $QL" (Table @("Fond", "Netto (mkr)") $sellRows) "") + "</div>" +
    (Source "/#/aktie/$($s.isin)" "Visa historik sedan 2018 och alla affärer")

  $bars = FlowBars $s.isin
  $stats = @(@("Fonder som äger", (Num0 $s.f2), "#1f2328"), @("Fondernas innehav", (BigSek $s.val2), "#1f2328"),
    @("Nettoköp $QL", $(if ($null -eq $s.netFlow) { "–" } else { BigSek $s.flow -Sign }), (FlowColor $s.netFlow)))
  $svg = if ($bars) { OgSvg $s.name "$($s.sector) · svenska fonders ägande · $QL" $stats "Fondernas nettoköp per kvartal, senaste $($bars.Count) kvartalen" $bars $null }
         else { OgSvg $s.name "$($s.sector) · svenska fonders ägande · $QL" $stats "Största fondägare" $null (JoinSv @($holders | Select-Object -First 3 | ForEach-Object { $_.f.name })) }
  $img = Image "aktie-$($s.slug)" $svg

  Page "aktie/$($s.slug)/" "aktie/$($s.isin)" (PageTitle $(if ($nameCount[$s.name] -gt 1) { "$($s.name) ($($s.isin))" } else { $s.name }) "vilka fonder äger aktien?" "fondägare") `
    "$fundsText äger $($s.name)$(if ($s.val2 -gt 0) { ' för ' + (BigSek $s.val2) }) ($asOf). Se vilka fonder som köper och säljer, största ägare och historik." $img $content -Crumbs @("Aktier", "aktier/", $s.name, "aktie/$($s.slug)/")
}
Write-Host "  $($pageStocks.Count) aktiesidor"

# Fonder
foreach ($fi in $infos) {
  $m = $fi.m
  $held = if ($m) { @($m.rows | Where-Object { $_.s2 -gt 0 } | Sort-Object v -Descending) } else { @() }
  $trades = if ($m -and $m.both) { @($m.rows | Where-Object { $_.s1 -ne $_.s2 -and -not $_.s.isNew -and -not $_.s.isGone }) } else { @() }
  $buys = @($trades | Where-Object { $_.d -gt 0 } | Sort-Object d -Descending | Select-Object -First 10)
  $sells = @($trades | Where-Object { $_.d -lt 0 } | Sort-Object d | Select-Object -First 10)
  $top3 = @($held | Select-Object -First 3 | ForEach-Object { $_.s.name })
  $fee = FeeText $fi
  $seVal = if ($m) { $m.val } else { 0.0 }

  $lead = "$($fi.name) förvaltas av $($fi.co) och har en fondförmögenhet på $(BigSek $fi.aum). Förvaltningsavgiften är $fee."
  if ($held.Count) { $lead += " Fonden äger " + (Plural $held.Count "svensk aktie" "svenska aktier") + " för $(BigSek $seVal), störst är " + (JoinSv $top3) + "." }
  if ($buys.Count -and $sells.Count) { $lead += " Under $QL köpte fonden mest $($buys[0].s.name) och sålde mest $($sells[0].s.name)." }

  $heldRows = NewList
  foreach ($r in ($held | Select-Object -First 30)) {
    $chg = if (-not $m.both) { "–" } elseif (-not $r.s1) { '<span class="pos">Ny</span>' } else { $c = ($r.s2 - $r.s1) / $r.s1; Colored $c (PctChange $c) }
    $heldRows.Add(@((A (StockUrl $r.s) $r.s.name), (Mkr $r.v), (PctPlain ($r.v / [math]::Max([double]1, [double]$seVal) * 100)), $chg))
  }
  $buyRows = NewList; foreach ($t in $buys) { $buyRows.Add(@((A (StockUrl $t.s) $t.s.name), (Colored $t.d (Mkr $t.d -Sign)))) }
  $sellRows = NewList; foreach ($t in $sells) { $sellRows.Add(@((A (StockUrl $t.s) $t.s.name), (Colored $t.d (Mkr $t.d -Sign)))) }

  $content = '<div class="page-head"><div class="crumbs"><a href="/fonder/">Fonder</a> / ' + (A (CoUrl $fi.co) $fi.co) + " / " + (Esc $fi.name) + '</div><div class="title-row"><h1>' + (Esc $fi.name) + '</h1></div><p class="meta">' +
    (A (CoUrl $fi.co) $fi.co) + $(if ($fi.bench) { " · Jämförelseindex: " + (Esc $fi.bench) } else { "" }) + "</p></div>" +
    '<p class="lead">' + (Esc $lead) + "</p>" +
    '<dl class="figures">' + (Fig "Fondförmögenhet" (BigSek $fi.aum)) + (Fig "Förvaltningsavgift" $fee) + (Fig "Aktiv risk" (PctPlain $fi.ar)) +
    (Fig "Standardavvikelse" (PctPlain $fi.sd)) + (Fig "Svenska aktier" (BigSek $seVal)) + "</dl>"
  if ($held.Count) {
    $content += (Block "Svenska innehav" (Table @("Aktie", "Innehav (mkr)", "Andel", "Förändring") $heldRows) "section-gap")
    if ($m.both) { $content += '<div class="grid-2 section-gap">' + (Block "Köpt $QL" (Table @("Aktie", "Netto (mkr)") $buyRows) "") + (Block "Sålt $QL" (Table @("Aktie", "Netto (mkr)") $sellRows) "") + "</div>" }
  } else {
    $content += '<p class="desc">Fonden har inga svenska aktier i sin senaste rapport till Finansinspektionen.</p>'
  }
  $content += Source ("/#/fond/" + [uri]::EscapeDataString($fi.id)) "Visa utländska innehav, avkastning och jämförelser"

  $stats = @(@("Fondförmögenhet", (BigSek $fi.aum), "#1f2328"), @("Avgift", $fee, "#1f2328"), @("Svenska aktier", (BigSek $seVal), "#1f2328"))
  $svg = if ($top3.Count) { OgSvg $fi.name "$($fi.co) · $QL" $stats "Största svenska innehav" $null ($top3 -join " · ") }
         else { OgSvg $fi.name "$($fi.co) · $QL" $stats "Jämförelseindex" $null $(if ($fi.bench) { $fi.bench } else { "Saknas" }) }
  $img = Image "fond-$($fi.slug)" $svg

  Page "fond/$($fi.slug)/" ("fond/" + [uri]::EscapeDataString($fi.id)) (PageTitle $fi.name "innehav, avgift och affärer" "fond") `
    "Vad äger $($fi.name)? Se fondens svenska innehav, vilka aktier den köpt och sålt under $QL, avgift ($fee) och fondförmögenhet ($(BigSek $fi.aum))." $img $content -Crumbs @("Fonder", "fonder/", $fi.co, "fondbolag/$($companies[$fi.co].slug)/", $fi.name, "fond/$($fi.slug)/")
}
Write-Host "  $($infos.Count) fondsidor"

# Fondbolag
foreach ($c in $coList) {
  $cf = @($c.funds | Sort-Object { [double]$(if ($_.aum) { $_.aum } else { 0 }) } -Descending)
  $agg = @{}
  foreach ($fi in $cf) {
    if (-not $fi.m) { continue }
    foreach ($r in $fi.m.rows) {
      if (-not $r.s2) { continue }
      if (-not $agg.ContainsKey($r.s.isin)) { $agg[$r.s.isin] = [pscustomobject]@{ s = $r.s; v = 0.0; n = 0 } }
      $agg[$r.s.isin].v += $r.v; $agg[$r.s.isin].n++
    }
  }
  $topStocks = @($agg.Values | Sort-Object v -Descending | Select-Object -First 15)
  $fee = CoFee $c

  $lead = "$($c.name) förvaltar " + (Plural $cf.Count "svensk värdepappersfond" "svenska värdepappersfonder") + " med en sammanlagd fondförmögenhet på $(BigSek $c.aum)."
  if ($c.feeBase) { $lead += " Snittavgiften, viktad efter fondernas storlek, är $fee." }
  if ($topStocks.Count) { $lead += " Fondernas största svenska innehav är " + (JoinSv @($topStocks | Select-Object -First 3 | ForEach-Object { $_.s.name })) + "." }

  $fundRows = NewList
  foreach ($fi in $cf) { $fundRows.Add(@((A (FundUrl $fi.id) $fi.name), (BigSek $fi.aum), (FeeText $fi))) }
  $stockRows = NewList
  foreach ($t in $topStocks) { $stockRows.Add(@((A (StockUrl $t.s) $t.s.name), (Mkr $t.v), (Num0 $t.n))) }

  $content = '<div class="page-head"><div class="crumbs"><a href="/fonder/">Fonder</a> / <a href="/fondbolag/">Fondbolag</a> / ' + (Esc $c.name) + '</div><div class="title-row"><h1>' + (Esc $c.name) + "</h1></div></div>" +
    '<p class="lead">' + (Esc $lead) + "</p>" +
    '<dl class="figures">' + (Fig "Fonder" (Num0 $cf.Count)) + (Fig "Fondförmögenhet" (BigSek $c.aum)) + (Fig "Snittavgift" $fee) + (Fig "Svenska aktier" (BigSek $c.se)) + "</dl>" +
    (Block "Fonder" (Table @("Fond", "Förmögenhet", "Avgift") $fundRows) "section-gap")
  if ($stockRows.Count) { $content += Block "Största svenska innehav" (Table @("Aktie", "Innehav (mkr)", "Fonder") $stockRows) "section-gap" }
  $content += Source ("/#/fondbolag/" + [uri]::EscapeDataString($c.name)) "Visa bolagets köp och sälj"

  $stats = @(@("Fonder", (Num0 $cf.Count), "#1f2328"), @("Fondförmögenhet", (BigSek $c.aum), "#1f2328"), @("Snittavgift", $fee, "#1f2328"))
  $svg = OgSvg $c.name "Fondbolag · $QL" $stats "Största fonder" $null (@($cf | Select-Object -First 3 | ForEach-Object { $_.name }) -join " · ")
  $img = Image "fondbolag-$($c.slug)" $svg

  Page "fondbolag/$($c.slug)/" ("fondbolag/" + [uri]::EscapeDataString($c.name)) (PageTitle $c.name "fonder, avgifter och innehav" "fondbolag") `
    "Alla $($cf.Count) fonder från $($c.name) med avgifter, fondförmögenhet och största innehav. Data från Finansinspektionen, $QL." $img $content -Crumbs @("Fondbolag", "fondbolag/", $c.name, "fondbolag/$($c.slug)/")
}
Write-Host "  $($coList.Count) fondbolagssidor"

# Standardbilden (startsidan och sidor utan egen bild)
$homeStats = @(@("Fonder", (Num0 $tFunds), "#1f2328"), @("Svenska aktier", (Num0 $tHeld), "#1f2328"), @("Nettoköp $QL", (BigSek $tNet -Sign), (FlowColor $tNet)))
$null = Image "fondinsyn" (OgSvg "Vad köper och säljer fonderna?" "Svenska fonders innehav, $QL" $homeStats "Öppen data från Finansinspektionen" $null "Innehav, köp och sälj, avgifter, blankning och uppköp")
$defaultImg = "og/fondinsyn.png"

# Översiktssidor med länkar till alla sidor
$rows = NewList
foreach ($s in @($pageStocks | Sort-Object val2 -Descending)) {
  $rows.Add(@((A (StockUrl $s) $s.name), (Num0 $s.f2), (Mkr $s.val2), $(if ($null -eq $s.netFlow) { "–" } else { Colored $s.flow (Mkr $s.flow -Sign) })))
}
Page "aktier/" "aktier" "Aktier som svenska fonder äger | Fondinsyn" "Alla $($pageStocks.Count) svenska aktier som fonderna äger, med antal fondägare, innehav och nettoköp under $QL." $defaultImg -Crumbs @("Aktier", "aktier/") (
  '<div class="page-head"><h1>Aktier som svenska fonder äger</h1><p class="meta">' + $QL + ", innehav den " + $asOf + "</p></div>" +
  '<p class="lead">Här är alla svenska aktier som ägs av minst en svensk värdepappersfond, sorterade efter hur mycket fonderna äger. Nettoköp är förändringen i antal aktier gånger kursen vid kvartalets slut.</p>' +
  (Table @("Aktie", "Fonder", "Innehav (mkr)", "Nettoköp (mkr)") $rows))

$rows = NewList
foreach ($fi in @($infos | Sort-Object { [double]$(if ($_.aum) { $_.aum } else { 0 }) } -Descending)) {
  $rows.Add(@((A (FundUrl $fi.id) $fi.name), (A (CoUrl $fi.co) $fi.co), (BigSek $fi.aum), (FeeText $fi)))
}
Page "fonder/" "fonder" "Alla svenska fonder – innehav och avgifter | Fondinsyn" "Alla $($infos.Count) svenska värdepappersfonder med fondbolag, fondförmögenhet och avgift. Se vad varje fond äger och har köpt och sålt." $defaultImg -Crumbs @("Fonder", "fonder/") (
  '<div class="page-head"><h1>Fonder</h1><p class="meta">' + $QL + ", innehav den " + $asOf + "</p></div>" +
  '<p class="lead">Alla svenska värdepappersfonder som rapporterar sina innehav till Finansinspektionen, sorterade efter fondförmögenhet.</p>' +
  (Table @("Fond", "Fondbolag", "Förmögenhet", "Avgift") $rows))

$rows = NewList
foreach ($c in @($coList | Sort-Object aum -Descending)) { $rows.Add(@((A (CoUrl $c.name) $c.name), (Num0 $c.funds.Count), (BigSek $c.aum), (CoFee $c))) }
Page "fondbolag/" "fondbolag" "Fondbolag – fonder, avgifter och innehav | Fondinsyn" "Alla $($coList.Count) fondbolag med svenska värdepappersfonder, med antal fonder, fondförmögenhet och snittavgift." $defaultImg -Crumbs @("Fondbolag", "fondbolag/") (
  '<div class="page-head"><h1>Fondbolag</h1><p class="meta">' + $QL + "</p></div>" +
  '<p class="lead">Fondbolagen bakom de svenska värdepappersfonderna. Snittavgiften är viktad efter fondernas storlek.</p>' +
  (Table @("Fondbolag", "Fonder", "Förmögenhet", "Snittavgift") $rows))

# ---------- Kategorier och köpsviter (samma regler som i app.js) ----------

function Category($fi) {
  if ($fi.isIndex) { return "index" }
  if ($null -eq $fi.eq -or $fi.eq -lt 0.8 -or $fi.name -match $MIXED_RE) { return "other" }
  if ($fi.ar -eq 0) { return "other" } # 0,0 betyder i praktiken att uppgiften saknas
  if ($null -ne $fi.ar -and $fi.ar -lt $CLOSET_AR -and $null -ne $fi.feeMax -and $fi.feeMax -ge $CLOSET_FEE) { return "closet" }
  return "active"
}
function InfoObj($x) {
  return [pscustomobject]@{ id = [string]$x[0]; name = [string]$x[1]; co = [string]$x[2]; aum = (Num $x[4]); feeMin = (Num $x[5]); feeMax = (Num $x[6])
    ar = (Num $x[8]); sd = (Num $x[9]); eq = (Num $x[10]); isIndex = ([string]$x[1] -match $INDEX_RE) }
}
# Antal kvartal i rad med nettoköp (eller nettosälj) fram till kvartal $qi, som streak() i app.js
function Streak($isin, $qi) {
  if (-not $hist) { return $null }
  $e = $hist.stocks.$isin
  if (-not $e) { return $null }
  $byQ = @{}
  foreach ($r in $e[3]) { $byQ[[int]$r[0]] = $r }
  $first = if ($byQ[$qi]) { $byQ[$qi][3] } else { $null }
  if ($null -eq $first -or [math]::Abs($first) -lt 0.5) { return $null }
  $sign = if ($first -gt 0) { 1 } else { -1 }
  $n = 0; $sum = 0.0
  for ($k = $qi; $k -ge 0; $k--) {
    $v = if ($byQ[$k]) { $byQ[$k][3] } else { $null }
    if ($null -eq $v -or [math]::Abs($v) -lt 0.5 -or $(if ($v -gt 0) { 1 } else { -1 }) -ne $sign) { break }
    $n++; $sum += $v
  }
  return [pscustomobject]@{ n = $n; sign = $sign; sum = $sum }
}
function StreakList($stockList, $qi, $sign) {
  $out = @()
  foreach ($s in $stockList) {
    if ($s.val2 -lt 100e6 -or $s.isNew -or $s.isGone) { continue }
    $st = Streak $s.isin $qi
    if ($st -and $st.sign -eq $sign -and $st.n -ge 2) { $out += [pscustomobject]@{ s = $s; n = $st.n; sum = $st.sum } }
  }
  return @($out | Sort-Object @{ Expression = "n"; Descending = $true }, @{ Expression = { [math]::Abs($_.sum) }; Descending = $true })
}
function LcWord($s) { if ($s -ceq $s.ToUpperInvariant()) { return $s }; return $s.ToLowerInvariant() }
# Kvartalets rubrik, samma som quarterHeadline() i app.js
function QuarterHeadline($cont, $buys, $sells) {
  $by = @{}
  foreach ($s in $cont) { if ($s.sector -and $s.sector -ne "Övrigt") { $by[$s.sector] = [double]$by[$s.sector] + $s.flow } }
  $secs = @($by.Keys | Sort-Object { $by[$_] } -Descending)
  if (-not $secs.Count) { return "Fondernas affärer" }
  if ($by[$secs[0]] -gt 0) { return "Fonderna köpte " + (LcWord $secs[0]) + $(if ($buys.Count) { " och mest av allt " + $buys[0].name } else { "" }) }
  return "Fonderna sålde " + (LcWord $secs[-1]) + $(if ($sells.Count) { " och mest av allt " + $sells[0].name } else { "" })
}
$slugByIsin = @{}
foreach ($s in $pageStocks) { $slugByIsin[$s.isin] = $s.slug }
function IsinUrl($isin) { if ($slugByIsin.ContainsKey($isin)) { return "/aktie/$($slugByIsin[$isin])/" }; return "/#/aktie/$isin" }

# ---------- Ordlista ----------
# En sida per begrepp med förklaringen och, där det går, aktuella exempel ur datan. Sidorna behåller sitt
# innehåll när appen startar (data-keep), eftersom exemplen inte finns i appens ordlista.

$gl = $null
try { $gl = ReadJson "glossary.json" } catch { Write-Host "  ingen ordlista: $($_.Exception.Message)" }
$perf = $null
try { $perf = ReadJson "perf.json" } catch { }
$insider = $null
try { $insider = ReadJson "insider.json" } catch { }

$eqFunds = @($infos | Where-Object { (Category $_) -ne "other" })
$activeFunds = @($infos | Where-Object { $c = Category $_; ($c -eq "active" -or $c -eq "closet") -and $_.aum -ge 500e6 })
function FundTable($list, $heads, $cells) {
  $rows = NewList
  foreach ($fi in $list) { $rows.Add(@(@((A (FundUrl $fi.id) $fi.name)) + @(& $cells $fi))) }
  return Table $heads $rows
}
function TwoBlocks($t1, $h1, $t2, $h2) { return '<div class="grid-2 section-gap">' + (Block $t1 $h1 "") + (Block $t2 $h2 "") + "</div>" }
function AppLink($href, $text) { return '<p class="section-gap">' + (A $href $text) + "</p>" }

function TermExample($slug) {
  switch ($slug) {
    "nettokop" {
      $top = @($pageStocks | Where-Object { $null -ne $_.netFlow -and $_.price -and $_.flow -gt 0 } | Sort-Object flow -Descending | Select-Object -First 10)
      $rows = NewList; foreach ($s in $top) { $rows.Add(@((A (StockUrl $s) $s.name), (Colored $s.flow (Mkr $s.flow -Sign)), (Num0 $s.f2))) }
      return Block "Mest nettoköpta aktier $QL" (Table @("Aktie", "Nettoköp (mkr)", "Fonder") $rows) "section-gap"
    }
    "aktiv-risk" {
      $l = @($activeFunds | Where-Object { $_.ar -gt 0 })
      return TwoBlocks "Lägst aktiv risk" (FundTable @($l | Sort-Object ar | Select-Object -First 10) @("Aktiv fond", "Aktiv risk", "Avgift") { param($f) @((PctPlain $f.ar), (FeeText $f)) }) `
        "Högst aktiv risk" (FundTable @($l | Sort-Object ar -Descending | Select-Object -First 10) @("Aktiv fond", "Aktiv risk", "Avgift") { param($f) @((PctPlain $f.ar), (FeeText $f)) })
    }
    "indexnara" {
      $l = @($infos | Where-Object { (Category $_) -eq "closet" -and $_.aum -ge 100e6 } | Sort-Object aum -Descending)
      if (-not $l.Count) { return "" }
      $cost = 0.0; foreach ($f in $l) { $cost += $f.aum * $f.feeMax / 100 }
      return '<p class="section-gap">Just nu är ' + (Plural $l.Count "aktiefond" "aktiefonder") + " med minst 100 mkr indexnära enligt den här definitionen. Tillsammans tar de ut ungefär <b>" +
        (BigSek $cost) + " per år</b> i avgifter från sina sparare.</p>" +
        (Block "Indexnära fonder $QL" (FundTable $l @("Fond", "Aktiv risk", "Avgift", "Förmögenhet") { param($f) @((PctPlain $f.ar), (FeeText $f), (BigSek $f.aum)) }) "section-gap")
    }
    "indexfond" {
      $l = @($infos | Where-Object { $_.isIndex -and $_.aum } | Sort-Object aum -Descending | Select-Object -First 15)
      return Block "Största indexfonderna" (FundTable $l @("Fond", "Avgift", "Förmögenhet") { param($f) @((FeeText $f), (BigSek $f.aum)) }) "section-gap"
    }
    "avgift" {
      $l = @($eqFunds | Where-Object { $null -ne $_.feeMax -and $_.aum -ge 100e6 })
      return TwoBlocks "Lägst avgift bland aktiefonder" (FundTable @($l | Sort-Object feeMax | Select-Object -First 10) @("Fond", "Avgift", "Förmögenhet") { param($f) @((FeeText $f), (BigSek $f.aum)) }) `
        "Högst avgift bland aktiefonder" (FundTable @($l | Sort-Object feeMax -Descending | Select-Object -First 10) @("Fond", "Avgift", "Förmögenhet") { param($f) @((FeeText $f), (BigSek $f.aum)) })
    }
    "standardavvikelse" {
      $l = @($eqFunds | Where-Object { $_.sd -gt 0 -and $_.aum -ge 500e6 })
      return TwoBlocks "Minst svängningar" (FundTable @($l | Sort-Object sd | Select-Object -First 10) @("Aktiefond", "Standardavvikelse") { param($f) @((PctPlain $f.sd)) }) `
        "Störst svängningar" (FundTable @($l | Sort-Object sd -Descending | Select-Object -First 10) @("Aktiefond", "Standardavvikelse") { param($f) @((PctPlain $f.sd)) })
    }
    "fondformogenhet" {
      $l = @($infos | Where-Object { $_.aum } | Sort-Object aum -Descending | Select-Object -First 15)
      return Block "Största fonderna" (FundTable $l @("Fond", "Fondbolag", "Förmögenhet") { param($f) @((A (CoUrl $f.co) $f.co), (BigSek $f.aum)) }) "section-gap"
    }
    "kopsvit" {
      if ($hq -lt 0) { return "" }
      $rows = NewList
      foreach ($x in @(StreakList $pageStocks $hq 1 | Select-Object -First 10)) { $rows.Add(@((A (StockUrl $x.s) $x.s.name), (Num0 $x.n), (Colored $x.sum (Fmt $x.sum 0)))) }
      return Block "Längsta köpsviterna just nu" (Table @("Aktie", "Kvartal i rad", "Summa (mkr)") $rows) "section-gap"
    }
    "sektorrotation" {
      $by = @{}
      foreach ($s in $pageStocks) { if ($null -ne $s.netFlow -and $s.sector -ne "Övrigt") { $by[$s.sector] = [double]$by[$s.sector] + $s.netFlow } }
      $rows = NewList
      foreach ($k in @($by.Keys | Sort-Object { $by[$_] } -Descending)) { $rows.Add(@((Esc $k), (Colored $by[$k] (BigSek $by[$k] -Sign)))) }
      return Block "Fondernas nettoköp per sektor $QL" (Table @("Sektor", "Nettoköp") $rows) "section-gap"
    }
    "aktiv-andel" {
      $l = @($activeFunds | Where-Object { $profiles.ContainsKey($_.id) -and $null -ne $profiles[$_.id][0] })
      $cells = { param($f) @((Fmt ($profiles[$f.id][0] * 100) 0) + " %", (FeeText $f)) }
      return TwoBlocks "Högst aktiv andel" (FundTable @($l | Sort-Object { $profiles[$_.id][0] } -Descending | Select-Object -First 10) @("Aktiv fond", "Aktiv andel", "Avgift") $cells) `
        "Lägst aktiv andel" (FundTable @($l | Sort-Object { $profiles[$_.id][0] } | Select-Object -First 10) @("Aktiv fond", "Aktiv andel", "Avgift") $cells)
    }
    "koncentration" {
      $l = @($activeFunds | Where-Object { $profiles.ContainsKey($_.id) } | Sort-Object { $profiles[$_.id][1] } -Descending | Select-Object -First 10)
      return Block "Mest koncentrerade aktiva fonderna" (FundTable $l @("Fond", "Tio största", "Antal aktier") { param($f) @((Fmt ($profiles[$f.id][1] * 100) 0) + " %", (Num0 $profiles[$f.id][2])) }) "section-gap"
    }
    "avkastning" {
      if (-not $perf) { return "" }
      $l = @($infos | Where-Object { $p = $perf.funds.($_.id); $p -and $null -ne $p[3] } | Sort-Object { $perf.funds.($_.id)[3] } -Descending | Select-Object -First 10)
      return (Block "Högst avkastning, fem år" (FundTable $l @("Fond", "Per år (CAGR)", "Totalt, ca") { param($f) $r = [double]$perf.funds.($f.id)[3]; @((PctPlain $r), ((Fmt ((([math]::Pow(1 + $r / 100, 5)) - 1) * 100) 0) + " %")) }) "section-gap") +
        '<p class="desc">Avkastning efter avgifter enligt Pensionsmyndigheten, beräknad ' + (Esc $perf.calculated) + ". Historisk avkastning är ingen garanti för framtida avkastning.</p>"
    }
    "split" {
      $l = @($stocks | Where-Object { $_.split -and $_.f2 } | Sort-Object name)
      if (-not $l.Count) { return "" }
      $rows = NewList; foreach ($s in $l) { $rows.Add(@((A (StockUrl $s) $s.name), ("×" + (Fmt $s.split 1)))) }
      return Block "Splitjusterade aktier $QL" (Table @("Aktie", "Kvot") $rows) "section-gap"
    }
    "isin" {
      $rows = NewList
      foreach ($s in @($pageStocks | Sort-Object f2 -Descending | Select-Object -First 10)) { $rows.Add(@((A (StockUrl $s) $s.name), $s.isin)) }
      return Block "Exempel: de mest ägda aktierna" (Table @("Aktie", "ISIN") $rows) "section-gap"
    }
    "insynshandel" {
      if (-not $insider) { return AppLink "/#/insyn" "Se all insynshandel" }
      $net = @{}; $name = @{}
      foreach ($r in $insider.rows) {
        if ($null -eq $r[11]) { continue }
        $v = if ($r[7] -eq "Förvärv") { [double]$r[11] } elseif ($r[7] -eq "Avyttring") { - [double]$r[11] } else { 0 }
        $net[$r[3]] = [double]$net[$r[3]] + $v; $name[$r[3]] = $r[2]
      }
      $rows = NewList
      foreach ($k in @($net.Keys | Where-Object { $net[$_] -gt 0 } | Sort-Object { $net[$_] } -Descending | Select-Object -First 10)) {
        $link = if ($slugByIsin.ContainsKey($k)) { A (IsinUrl $k) $name[$k] } else { Esc $name[$k] }
        $rows.Add(@($link, (Colored $net[$k] (BigSek $net[$k] -Sign))))
      }
      return (Block "Mest köpt av insiders, $($insider.days) dagar" (Table @("Bolag", "Köp minus sälj") $rows) "section-gap") + (AppLink "/#/insyn" "Se all insynshandel")
    }
    "kvartalsrapport" { return "" } # länkarna till rapporterna läggs till efter att de byggts
    { $_ -in "blankning", "kort-position" } { return AppLink "/#/blankning" "Se vilka aktier som blankas och vilka som blankar dem" }
    { $_ -in "uppkopserbjudande", "budpremie" } { return AppLink "/#/uppkop" "Se alla uppköpserbjudanden och vilka fonder som ägde bolagen" }
    "overlapp" { return AppLink "/#/jamfor" "Jämför två fonder och se hur lika de är" }
  }
  return ""
}

$termPages = @()
if ($gl) {
  $terms = @($gl.terms | Sort-Object { $_[1] })
  foreach ($t in $terms) {
    $slug = [string]$t[0]; $name = [string]$t[1]; $text = [string]$t[2]
    $others = (@($terms | Where-Object { $_[0] -ne $slug } | ForEach-Object { A "/ordlista/$($_[0])/" $_[1] }) -join "")
    $content = '<div class="page-head"><div class="crumbs"><a href="/ordlista/">Ordlista</a> / ' + (Esc $name) + "</div><h1>" + (Esc $name) + "</h1></div>" +
      '<p class="lead">' + (Esc $text) + "</p>" + (TermExample $slug) +
      '<section class="block section-gap"><div class="block-head"><h2>Fler begrepp</h2></div><div class="glossary-index">' + $others + "</div></section>" +
      '<p class="desc section-gap">Data från Finansinspektionens fondinnehav, ' + $QL + ". Inte investeringsrådgivning.</p>"
    $desc = if ($text.Length -gt 155) { $text.Substring(0, 152).TrimEnd() + "…" } else { $text }
    $termPages += [pscustomobject]@{ slug = $slug; name = $name; text = $text; content = $content; desc = $desc }
  }
}

# ---------- Kvartalsrapporter ----------

function ReportSlug($qid) { return $qid.Substring(0, 4) + "-q" + $qid.Substring(5) }
$reportQs = @($index.quarters | ForEach-Object { [string]$_.id })
$reportList = @()
for ($ri = 0; $ri -lt $reportQs.Count; $ri++) {
  $qid = $reportQs[$ri]
  $qd = if ($qid -eq $Q) { $cur } else { LoadQuarter $qid }
  $m = $qd.meta; $repQL = QLabel $qid; $repPL = QLabel ([string]$m.prevId)
  $cont = @($qd.stocks | Where-Object { $_.price -and $null -ne $_.netFlow })
  $buys = @($cont | Where-Object { $_.flow -gt 0 } | Sort-Object flow -Descending)
  $sells = @($cont | Where-Object { $_.flow -lt 0 } | Sort-Object flow)
  $news = @($cont | Where-Object { $_.nNew -gt 0 } | Sort-Object nNew -Descending)
  $net = $qd.tNet
  $by = @{}
  foreach ($s in $cont) { if ($s.sector -ne "Övrigt") { $by[$s.sector] = [double]$by[$s.sector] + $s.flow } }
  $sectors = @($by.Keys | Sort-Object { $by[$_] } -Descending)
  $topLinks = { param($list) JoinSv @($list | Select-Object -First 3 | ForEach-Object { (A (IsinUrl $_.isin) $_.name) + " (" + (BigSek $_.flow -Sign) + ")" }) }

  $headline = QuarterHeadline $cont $buys $sells
  $paras = @("Svenska fonder " + $(if ($net -ge 0) { "nettoköpte" } else { "nettosålde" }) + " svenska aktier för <b>" + (BigSek ([math]::Abs($net))) + "</b> under " + $repQL +
    ". Jämförelsen gäller " + (Num0 $qd.tFunds) + " fonder som rapporterade både " + $repPL + " och " + $repQL + ".")
  if ($buys.Count) { $paras += "Mest köpte fonderna " + (& $topLinks $buys) + "." }
  if ($sells.Count) { $paras += "Mest såldes " + (& $topLinks $sells) + "." }

  $rowsB = NewList; foreach ($s in @($buys | Select-Object -First 10)) { $rowsB.Add(@((A (IsinUrl $s.isin) $s.name), (Colored $s.flow (Mkr $s.flow -Sign)), (Num0 $s.f2))) }
  $rowsS = NewList; foreach ($s in @($sells | Select-Object -First 10)) { $rowsS.Add(@((A (IsinUrl $s.isin) $s.name), (Colored $s.flow (Mkr $s.flow -Sign)), (Num0 $s.f2))) }
  $content = '<article class="report"><div class="page-head"><div class="crumbs"><a href="/rapport/">Kvartalsrapporter</a> / ' + $repQL + " jämfört med " + $repPL + "</div>" +
    "<h1>" + (Esc $headline) + "</h1></div>" + '<div class="prose">' + (($paras | ForEach-Object { "<p>$_</p>" }) -join "") + "</div>" +
    '<div class="grid-2 section-gap">' + (Block "Kvartalets största köp" (Table @("Aktie", "Nettoköp (mkr)", "Fonder") $rowsB) "") +
    (Block "Kvartalets största sälj" (Table @("Aktie", "Nettoköp (mkr)", "Fonder") $rowsS) "") + "</div>"
  if ($sectors.Count) {
    $rows = NewList; foreach ($k in $sectors) { $rows.Add(@((Esc $k), (Colored $by[$k] (BigSek $by[$k] -Sign)))) }
    $content += Block "Sektorer" (Table @("Sektor", "Nettoköp") $rows) "section-gap"
  }
  $qiR = if ($hist) { [array]::IndexOf([string[]]@($hist.quarters), $qid) } else { -1 }
  if ($qiR -ge 0) {
    $bs = @(StreakList $qd.stocks $qiR 1); $ss = @(StreakList $qd.stocks $qiR -1)
    if ($bs.Count -or $ss.Count) {
      $p = ""
      if ($bs.Count) { $p += (A (IsinUrl $bs[0].s.isin) $bs[0].s.name) + " har nettoköpts <b>" + $bs[0].n + " kvartal i rad</b>" + $(if ($bs.Count -gt 1) { ", och " + (Esc $bs[1].s.name) + " " + $bs[1].n + " kvartal i rad" } else { "" }) + ". " }
      if ($ss.Count) { $p += (A (IsinUrl $ss[0].s.isin) $ss[0].s.name) + " har nettosålts " + $ss[0].n + " kvartal i rad." }
      $content += Block "Trender" "<p>$p</p>" "section-gap"
    }
  }
  if ($news.Count) {
    $content += Block "Nya favoriter" ("<p><b>" + $news[0].nNew + " fonder</b> köpte in sig i " + (A (IsinUrl $news[0].isin) $news[0].name) + " för första gången" +
      $(if ($news.Count -gt 1) { ", och " + $news[1].nNew + " i " + (Esc $news[1].name) } else { "" }) + ".</p>") "section-gap"
  }
  $closet = @($qd.raw.fundInfo | ForEach-Object { InfoObj $_ } | Where-Object { $null -ne $_.ar -and $null -ne $_.feeMax -and $_.aum -ge 100e6 -and (Category $_) -eq "closet" })
  if ($closet.Count) {
    $cost = 0.0; foreach ($f in $closet) { $cost += $f.aum * $f.feeMax / 100 }
    $content += Block "Avgifter" ("<p>" + $closet.Count + " aktiefonder har låg aktiv risk men tar ut minst " + (Fmt $CLOSET_FEE 1) + " % i avgift. Tillsammans tar de ut ungefär <b>" +
      (BigSek $cost) + ' per år</b> av sina sparare. <a href="/ordlista/indexnara/">Vad betyder indexnära?</a></p>') "section-gap"
  }
  $nav = @()
  if (Test-Path (Join-Path $DataDir "$qid-world.json")) { $nav += A "/rapport/$(ReportSlug $qid)/utland/" ("Globala aktier " + $repQL) }
  if ($ri + 1 -lt $reportQs.Count) { $nav += A "/rapport/$(ReportSlug $reportQs[$ri + 1])/" ("← " + (QLabel $reportQs[$ri + 1])) }
  if ($ri -gt 0) { $nav += A "/rapport/$(ReportSlug $reportQs[$ri - 1])/" ((QLabel $reportQs[$ri - 1]) + " →") }
  $content += '<p class="desc section-gap">' + ($nav -join " · ") + " · Källa: Finansinspektionens fondinnehav per kvartal.</p></article>"

  $top3 = @($buys | Select-Object -First 3 | ForEach-Object { $_.name })
  $desc = "Svenska fonder " + $(if ($net -ge 0) { "nettoköpte" } else { "nettosålde" }) + " svenska aktier för " + (BigSek ([math]::Abs($net))) + " under $repQL." +
    $(if ($top3.Count) { " Mest köpte de " + (JoinSv $top3) + "." } else { "" }) +
    $(if ($sells.Count) { " Mest sålde de " + (JoinSv @($sells | Select-Object -First 3 | ForEach-Object { $_.name })) + "." } else { "" })
  $stats = @(@("Fonder", (Num0 $qd.tFunds), "#1f2328"), @("Nettoköp", (BigSek $net -Sign), (FlowColor $net)), @("Största köp", $(if ($buys.Count) { BigSek $buys[0].flow -Sign } else { "–" }), "#1a7f37"))
  $rs = ReportSlug $qid
  $img = Image "rapport-$rs" (ReportOgSvg "Kvartalsrapport $repQL" $headline "Nettoköp svenska aktier" $net @($buys | Select-Object -First 5 | ForEach-Object { ,@($_.name, $_.flow) }))
  $article = '{"@context":"https://schema.org","@type":"Article","headline":' + (J "Fondernas köp och sälj $repQL") + ',"description":' + (J $desc) +
    ',"datePublished":' + (J ([string]$m.built)) + ',"dateModified":' + (J ([string]$m.built)) + ',"inLanguage":"sv-SE","image":' + (J "$BaseUrl/$img") +
    ',"author":{"@type":"Organization","name":"Fondinsyn","url":' + (J "$BaseUrl/") + '},"publisher":{"@type":"Organization","name":"Fondinsyn","url":' + (J "$BaseUrl/") + "}}"
  Page "rapport/$rs/" "rapport/$qid" "Fondernas köp och sälj $repQL – kvartalsrapport | Fondinsyn" $desc $img $content -Crumbs @("Kvartalsrapporter", "rapport/", $repQL, "rapport/$rs/") -Ld $article
  $reportList += [pscustomobject]@{ q = $qid; label = $repQL; slug = $rs; headline = $headline; desc = $desc }
}

# ---------- Kvartalsrapporter för utländska aktier (/rapport/<kvartal>/utland/) ----------

$COUNTRY = @{ US = "USA"; GB = "Storbritannien"; DE = "Tyskland"; FR = "Frankrike"; DK = "Danmark"; NO = "Norge"; FI = "Finland"; NL = "Nederländerna"
  CH = "Schweiz"; JP = "Japan"; CN = "Kina"; TW = "Taiwan"; KR = "Sydkorea"; IN = "Indien"; CA = "Kanada"; IE = "Irland"; ES = "Spanien"; IT = "Italien"
  BE = "Belgien"; LU = "Luxemburg"; AU = "Australien"; HK = "Hongkong"; BR = "Brasilien"; MX = "Mexiko"; ZA = "Sydafrika"; SG = "Singapore"; IL = "Israel"
  AT = "Österrike"; PT = "Portugal"; PL = "Polen"; IS = "Island"; EE = "Estland"; LT = "Litauen"; LV = "Lettland"; ID = "Indonesien"; TH = "Thailand"
  MY = "Malaysia"; PH = "Filippinerna"; VN = "Vietnam"; SA = "Saudiarabien"; AE = "Förenade Arabemiraten"; TR = "Turkiet"; GR = "Grekland"; CL = "Chile"
  NZ = "Nya Zeeland"; JE = "Jersey"; BM = "Bermuda"; KY = "Caymanöarna"; CZ = "Tjeckien"; HU = "Ungern"; QA = "Qatar"; KW = "Kuwait"; PE = "Peru"
  CO = "Colombia"; AR = "Argentina"; GG = "Guernsey"; CY = "Cypern"; MT = "Malta"; FO = "Färöarna"; IM = "Isle of Man"; VG = "Brittiska Jungfruöarna"
  PA = "Panama"; UY = "Uruguay"; CW = "Curaçao"; MU = "Mauritius"; EG = "Egypten"; RO = "Rumänien"; HR = "Kroatien"; SI = "Slovenien"; GI = "Gibraltar" }
function CountryName($c) { if ($c -and $COUNTRY.ContainsKey($c)) { return $COUNTRY[$c] }; if ($c) { return $c }; return "Okänt" }

$worldReports = @{}
for ($ri = 0; $ri -lt $reportQs.Count; $ri++) {
  $qid = $reportQs[$ri]
  if (-not (Test-Path (Join-Path $DataDir "$qid-world.json"))) { continue }
  $wq = LoadQuarter $qid "-world" -Light
  $repQL = QLabel $qid; $repPL = QLabel ([string]$index.quarters[$ri].prevId); $rs = ReportSlug $qid
  $cont = @($wq.stocks | Where-Object { $_.price -and $null -ne $_.netFlow })
  $buys = @($cont | Where-Object { $_.flow -gt 0 } | Sort-Object flow -Descending)
  $sells = @($cont | Where-Object { $_.flow -lt 0 } | Sort-Object flow)
  $news = @($cont | Where-Object { $_.nNew -gt 0 } | Sort-Object nNew -Descending)
  $net = $wq.tNet
  $bySec = @{}; $byCountry = @{}
  foreach ($s in $cont) {
    if ($s.sector -ne "Övrigt") { $bySec[$s.sector] = [double]$bySec[$s.sector] + $s.flow }
    $byCountry[(CountryName $s.country)] = [double]$byCountry[(CountryName $s.country)] + $s.flow
  }
  $sectors = @($bySec.Keys | Sort-Object { $bySec[$_] } -Descending)
  $countries = @($byCountry.Keys | Sort-Object { $byCountry[$_] } -Descending)
  $wLink = { param($s) (A "/#/aktie/$($s.isin)" $s.name) + " (" + (BigSek $s.flow -Sign) + ")" }

  $headline = QuarterHeadline $cont $buys $sells
  $paras = @("Svenska fonder " + $(if ($net -ge 0) { "nettoköpte" } else { "nettosålde" }) + " globala aktier för <b>" + (BigSek ([math]::Abs($net))) + "</b> under " + $repQL +
    ". Jämförelsen gäller " + (Num0 $wq.tFunds) + " fonder som rapporterade både " + $repPL + " och " + $repQL + ".")
  if ($buys.Count) { $paras += "Mest köpte fonderna " + (JoinSv @($buys | Select-Object -First 3 | ForEach-Object { & $wLink $_ })) + "." }
  if ($sells.Count) { $paras += "Mest såldes " + (JoinSv @($sells | Select-Object -First 3 | ForEach-Object { & $wLink $_ })) + "." }
  $cPos = @($countries | Where-Object { $byCountry[$_] -gt 0 } | Select-Object -First 3)
  if ($cPos.Count) { $paras += "Mest pengar gick till aktier från " + (JoinSv @($cPos | ForEach-Object { (Esc $_) + " (" + (BigSek $byCountry[$_] -Sign) + ")" })) + "." }

  $tradeRows = { param($list) $rows = NewList; foreach ($s in @($list | Select-Object -First 10)) { $rows.Add(@((A "/#/aktie/$($s.isin)" $s.name), (Esc (CountryName $s.country)), (Colored $s.flow (Mkr $s.flow -Sign)))) }; , $rows }
  $content = '<article class="report"><div class="page-head"><div class="crumbs"><a href="/rapport/">Kvartalsrapporter</a> / ' + $repQL + " · globala aktier</div>" +
    "<h1>" + (Esc $headline) + "</h1></div>" + '<div class="prose">' + (($paras | ForEach-Object { "<p>$_</p>" }) -join "") + "</div>" +
    '<div class="grid-2 section-gap">' + (Block "Kvartalets största köp" (Table @("Aktie", "Land", "Nettoköp (mkr)") (& $tradeRows $buys)) "") +
    (Block "Kvartalets största sälj" (Table @("Aktie", "Land", "Nettoköp (mkr)") (& $tradeRows $sells)) "") + "</div>"
  $rows = NewList; foreach ($k in @($countries | Select-Object -First 15)) { $rows.Add(@((Esc $k), (Colored $byCountry[$k] (BigSek $byCountry[$k] -Sign)))) }
  $content += Block "Länder" (Table @("Land", "Nettoköp") $rows) "section-gap"
  if ($sectors.Count) {
    $rows = NewList; foreach ($k in $sectors) { $rows.Add(@((Esc $k), (Colored $bySec[$k] (BigSek $bySec[$k] -Sign)))) }
    $content += Block "Sektorer" (Table @("Sektor", "Nettoköp") $rows) "section-gap"
  }
  if ($news.Count) {
    $content += Block "Nya favoriter" ("<p><b>" + $news[0].nNew + " fonder</b> köpte in sig i " + (A "/#/aktie/$($news[0].isin)" $news[0].name) + " för första gången" +
      $(if ($news.Count -gt 1) { ", och " + $news[1].nNew + " i " + (Esc $news[1].name) } else { "" }) + ".</p>") "section-gap"
  }
  $nav = @((A "/rapport/$rs/" "Svenska aktier $repQL"))
  if ($ri + 1 -lt $reportQs.Count) { $nav += A "/rapport/$(ReportSlug $reportQs[$ri + 1])/utland/" ("← " + (QLabel $reportQs[$ri + 1])) }
  if ($ri -gt 0) { $nav += A "/rapport/$(ReportSlug $reportQs[$ri - 1])/utland/" ((QLabel $reportQs[$ri - 1]) + " →") }
  $content += '<p class="desc section-gap">' + ($nav -join " · ") + " · Källa: Finansinspektionens fondinnehav per kvartal.</p></article>"

  $top3 = @($buys | Select-Object -First 3 | ForEach-Object { $_.name })
  $desc = "Svenska fonder " + $(if ($net -ge 0) { "nettoköpte" } else { "nettosålde" }) + " globala aktier för " + (BigSek ([math]::Abs($net))) + " under $repQL." +
    $(if ($top3.Count) { " Mest köpte de " + (JoinSv $top3) + "." } else { "" }) +
    $(if ($cPos.Count) { " Mest pengar gick till aktier från " + (JoinSv $cPos) + "." } else { "" })
  $stats = @(@("Fonder", (Num0 $wq.tFunds), "#1f2328"), @("Nettoköp", (BigSek $net -Sign), (FlowColor $net)), @("Största köp", $(if ($buys.Count) { BigSek $buys[0].flow -Sign } else { "–" }), "#1a7f37"))
  $img = Image "rapport-$rs-utland" (ReportOgSvg "Kvartalsrapport $repQL · globala aktier" $headline "Nettoköp globala aktier" $net @($buys | Select-Object -First 5 | ForEach-Object { ,@($_.name, $_.flow) }))
  $article = '{"@context":"https://schema.org","@type":"Article","headline":' + (J "Fondernas köp och sälj av globala aktier $repQL") + ',"description":' + (J $desc) +
    ',"datePublished":' + (J ([string]$qMeta.built)) + ',"dateModified":' + (J ([string]$qMeta.built)) + ',"inLanguage":"sv-SE","image":' + (J "$BaseUrl/$img") +
    ',"author":{"@type":"Organization","name":"Fondinsyn","url":' + (J "$BaseUrl/") + '},"publisher":{"@type":"Organization","name":"Fondinsyn","url":' + (J "$BaseUrl/") + "}}"
  Page "rapport/$rs/utland/" "rapport/$qid/utland" "Globala aktier $repQL – vad fonderna köpte och sålde | Fondinsyn" $desc $img $content `
    -Crumbs @("Kvartalsrapporter", "rapport/", "$repQL globala aktier", "rapport/$rs/utland/") -Ld $article
  $worldReports[$qid] = $headline
}
Write-Host "  $($worldReports.Count) rapporter för globala aktier"

$rows = NewList
foreach ($r in $reportList) {
  $w = if ($worldReports.ContainsKey($r.q)) { A "/rapport/$($r.slug)/utland/" ("Globala aktier " + $r.label) } else { "–" }
  $rows.Add(@((A "/rapport/$($r.slug)/" $r.label), (Esc $r.headline), $w))
}
Page "rapport/" "rapport" "Kvartalsrapporter – vad fonderna köpte och sålde | Fondinsyn" "Varje kvartal: vilka svenska aktier fonderna köpte och sålde mest, sektorerna de flyttade pengar till och de längsta köpsviterna." $defaultImg -Crumbs @("Kvartalsrapporter", "rapport/") -Keep (
  '<div class="page-head"><h1>Kvartalsrapporter</h1></div><p class="lead">En sammanfattning per kvartal av vad svenska fonder köpte och sålde, både svenska och globala aktier. Byggd på innehaven som fondbolagen rapporterar till Finansinspektionen.</p>' +
  (Table @("Kvartal", "Svenska aktier", "Globala aktier") $rows))
Write-Host "  $($reportList.Count) kvartalsrapporter"

# Ordlistans sidor (efter rapporterna, så att begreppet kvartalsrapport kan länka till dem)
foreach ($tp in $termPages) {
  $extra = ""
  if ($tp.slug -eq "kvartalsrapport" -and $reportList.Count) {
    $extra = Block "Fondinsyns kvartalsrapporter" ("<ul>" + (($reportList | ForEach-Object { "<li>" + (A "/rapport/$($_.slug)/" $_.label) + " – " + (Esc $_.headline) + "</li>" }) -join "") + "</ul>") "section-gap"
  }
  $content = $tp.content.Replace('<section class="block section-gap"><div class="block-head"><h2>Fler begrepp', $extra + '<section class="block section-gap"><div class="block-head"><h2>Fler begrepp')
  $term = '{"@context":"https://schema.org","@type":"DefinedTerm","name":' + (J $tp.name) + ',"description":' + (J $tp.text) + ',"inDefinedTermSet":' + (J "$BaseUrl/ordlista/") + "}"
  Page "ordlista/$($tp.slug)/" "ordlista/$($tp.slug)" "$($tp.name) – vad betyder det? | Fondinsyn" $tp.desc $defaultImg $content -Crumbs @("Ordlista", "ordlista/", $tp.name, "ordlista/$($tp.slug)/") -Ld $term -Keep
}
if ($gl) {
  $faq = (@($gl.faq | ForEach-Object { "<details><summary>" + (Esc $_[0]) + "</summary><p>" + (Esc $_[1]) + "</p></details>" }) -join "")
  $list = (@($termPages | ForEach-Object { '<div class="g-item"><dt>' + (A "/ordlista/$($_.slug)/" $_.name) + "</dt><dd>" + (Esc $_.text) + "</dd></div>" }) -join "")
  Page "ordlista/" "ordlista" "Ordlista och vanliga frågor om fonder | Fondinsyn" "Vad betyder aktiv andel, indexnära, nettoköp och blankning? Förklaringar av begreppen på Fondinsyn och svar på vanliga frågor om fonddatan." $defaultImg -Crumbs @("Ordlista", "ordlista/") (
    '<div class="page-head"><h1>Vanliga frågor och ordlista</h1></div><div class="faq">' + $faq + '</div><h2 class="section-title">Ordlista</h2><dl class="glossary">' + $list + "</dl>")
  Write-Host "  $($termPages.Count) sidor i ordlistan"
}

# ---------- Räntor: /rantor/ och en sida per större emittent ----------
$ratesLight = if (Test-Path (Join-Path $DataDir "$Q-rates.json")) { ReadJson "$Q-rates.json" } else { $null }
if ($ratesLight -and $issLatest) {
  $RateCat = [ordered]@{ bostad = "Bostadsobligationer"; stat = "Svenska staten"; kommun = "Kommuner och regioner"; bank = "Banker"; fastighet = "Fastighetsbolag"; foretag = "Övriga företag"; utland = "Utländska stater och utvecklingsbanker" }
  $rIss = @($ratesLight.issuers | ForEach-Object { [pscustomobject]@{ key = [string]$_[0]; name = [string]$_[1]; cat = [string]$_[2]; v1 = [double]$_[5]; v2 = [double]$_[6]; flow = [double]$_[7]; f1 = [int]$_[9]; f2 = [int]$_[10]; n = [int]$_[11] } })
  $rTot = [double]$ratesLight.totals[1]; $rFlow = [double]$ratesLight.totals[2]
  $issPages = @($rIss | Where-Object { $_.v2 -ge 300e6 } | Sort-Object v2 -Descending)
  $issUrl = @{}; foreach ($i in $issPages) { $issUrl[$i.key] = "/emittent/$($i.key)/" }
  function IssuerUrl($key) { if ($issUrl.ContainsKey($key)) { return $issUrl[$key] }; return "/#/emittent/" + [uri]::EscapeDataString($key) }

  # En sida per emittent med minst 300 mkr i fondernas innehav
  foreach ($i in $issPages) {
    $e = $issLatest[$i.key]
    if (-not $e) { continue }
    $holders = @($e.f.GetEnumerator() | Where-Object { $_.Value.v2 -gt 0 } | Sort-Object { $_.Value.v2 } -Descending)
    $hRows = foreach ($h in ($holders | Select-Object -First 15)) {
      $fi = $infoById[$h.Key]
      $nm = if ($fi) { A (FundUrl $h.Key) $fi.name } else { Esc $h.Key }
      ,@($nm, (Mkr $h.Value.v2), $(if ($null -eq $h.Value.flow) { "–" } else { Colored $h.Value.flow (Mkr $h.Value.flow -Sign) }))
    }
    $bRows = foreach ($b in (@($e.b.GetEnumerator() | Where-Object { $_.Value.v2 -gt 0 } | Sort-Object { $_.Value.v2 } -Descending) | Select-Object -First 15)) {
      ,@((Esc $b.Value.name), (Mkr $b.Value.v2), (Num0 $b.Value.n))
    }
    $top = @($holders | Select-Object -First 3 | ForEach-Object { $fi = $infoById[$_.Key]; if ($fi) { $fi.name } })
    $catName = $RateCat[$i.cat]
    $lead = "Svenska fonder äger obligationer och certifikat från $($i.name) för $(BigSek $i.v2) ($asOf), fördelat på $(Plural $i.f2 'fond' 'fonder')."
    if ([math]::Abs($i.flow) -ge 1e6) { $lead += $(if ($i.flow -gt 0) { " Under $QL nettoköpte fonderna för $(BigSek $i.flow)." } else { " Under $QL nettosålde fonderna för $(BigSek (-$i.flow))." }) }
    if ($top.Count) { $lead += " Största ägare är " + (JoinSv $top) + "." }
    $content = '<div class="page-head"><div class="crumbs">' + (A "/rantor/" "Räntor") + " / " + (Esc $i.name) + '</div><h1>' + (Esc $i.name) + '</h1><p class="meta">' + (Esc $catName) + "</p></div>" +
      '<p class="lead">' + (Esc $lead) + "</p>" +
      '<dl class="figures">' + (Fig "Fondernas innehav" (BigSek $i.v2)) + (Fig "Nettoköp $QL" (Colored $i.flow (BigSek $i.flow -Sign))) + (Fig "Fonder som äger" (Num0 $i.f2)) + (Fig "Värdepapper" (Num0 $i.n)) + "</dl>" +
      '<div class="grid-2 section-gap">' + (Block "Fonder som äger" (Table @("Fond", "Innehav (mkr)", "Nettoköp (mkr)") @($hRows)) "") + (Block "Värdepapper" (Table @("Värdepapper", "Innehav (mkr)", "Fonder") @($bRows)) "") + "</div>" +
      (Source ("/#/emittent/" + [uri]::EscapeDataString($i.key)) "Se alla fonder och värdepapper")
    $stats = @(@("Fondernas innehav", (BigSek $i.v2), "#1f2328"), @("Nettoköp $QL", (BigSek $i.flow -Sign), (FlowColor $i.flow)), @("Fonder som äger", (Num0 $i.f2), "#1f2328"))
    $img = Image "emittent-$($i.key)" (OgSvg $i.name "$catName · obligationer som svenska fonder äger" $stats "Största ägare" $null (($top | Select-Object -First 3) -join " · "))
    Page "emittent/$($i.key)/" "emittent/$($i.key)" (PageTitle $i.name "obligationer som fonderna äger" "obligationer") `
      "$($i.name): svenska fonder äger obligationer för $(BigSek $i.v2) ($asOf). Se vilka fonder som äger, köper och säljer bolagets obligationer och certifikat." `
      $img $content -Crumbs @("Räntor", "rantor/", $i.name, "emittent/$($i.key)/")
  }

  # Översikten /rantor/
  $catRows = foreach ($c in $RateCat.Keys) {
    $row = @($ratesLight.cats | Where-Object { $_[0] -eq $c })[0]
    if (-not $row -or [double]$row[2] -le 0) { continue }
    ,@((Esc $RateCat[$c]), (BigSek ([double]$row[2])), (Colored ([double]$row[3]) (BigSek ([double]$row[3]) -Sign)), (PctPlain ([double]$row[2] / $rTot * 100)))
  }
  $flowRows = { param($list) foreach ($i in $list) { ,@((A (IssuerUrl $i.key) $i.name), (Colored $i.flow (Mkr $i.flow -Sign)), (Mkr $i.v2)) } }
  $rBuys = @($rIss | Where-Object { $_.flow -gt 0 } | Sort-Object flow -Descending | Select-Object -First 10)
  $rSells = @($rIss | Where-Object { $_.flow -lt 0 } | Sort-Object flow | Select-Object -First 10)
  $topIss = @($rIss | Sort-Object v2 -Descending | Select-Object -First 25)
  $content = '<div class="page-head"><h1>Räntor</h1><p class="meta lead">Marknadsräntorna från Riksbanken och vad svenska fonder äger för räntepapper: statsobligationer, bostadsobligationer, bankers och företags obligationer.</p></div>' +
    '<dl class="figures">' + (Fig "Fondernas räntepapper" (BigSek $rTot)) + (Fig "Nettoköp $QL" (Colored $rFlow (BigSek $rFlow -Sign))) + (Fig "Emittenter" (Num0 @($rIss | Where-Object { $_.v2 -gt 0 }).Count)) + "</dl>" +
    (Block "Vad fonderna äger, $QL" (Table @("Emittent", "Innehav", "Nettoköp", "Andel") @($catRows)) "section-gap") +
    '<div class="grid-2 section-gap">' + (Block "Köpte mest" (Table @("Emittent", "Netto (mkr)", "Innehav (mkr)") @(& $flowRows $rBuys)) "") + (Block "Sålde mest" (Table @("Emittent", "Netto (mkr)", "Innehav (mkr)") @(& $flowRows $rSells)) "") + "</div>" +
    (Block "Största emittenterna" (Table @("Emittent", "Netto (mkr)", "Innehav (mkr)") @(& $flowRows $topIss)) "section-gap") +
    (Source "/#/rantor" "Se marknadsräntor och alla emittenter")
  $stats = @(@("Fondernas räntepapper", (BigSek $rTot), "#1f2328"), @("Nettoköp $QL", (BigSek $rFlow -Sign), (FlowColor $rFlow)), @("Emittenter", (Num0 @($rIss | Where-Object { $_.v2 -gt 0 }).Count), "#1f2328"))
  $img = Image "rantor" (OgSvg "Räntor" "Vad svenska fonder äger, köper och säljer för räntepapper" $stats "Mest köpta emittenter" $null ((@($rBuys | Select-Object -First 3 | ForEach-Object { $_.name })) -join " · "))
  Page "rantor/" "rantor" "Räntor och räntefonder – vad fonderna äger | Fondinsyn" "Vilka obligationer svenska räntefonder äger, köper och säljer: statsobligationer, bostadsobligationer och företagsobligationer per emittent, plus Riksbankens räntor." `
    $img $content -Crumbs @("Räntor", "rantor/")
  Write-Host "  räntesidor: /rantor/ och $($issPages.Count) emittenter"
}
# ---------- Öppen data: CSV-filer och sidan /oppen-data/ ----------
# CSV med semikolon och decimalkomma så att filerna öppnas rätt i svenska Excel.

function CsvCell($v) {
  if ($null -eq $v) { return "" }
  if ($v -is [double] -or $v -is [single] -or $v -is [decimal] -or $v -is [int] -or $v -is [long]) { return ([double]$v).ToString("0.####", $Inv).Replace(".", ",") }
  $s = [string]$v
  if ($s -match '[;"\r\n]') { return '"' + $s.Replace('"', '""') + '"' }
  return $s
}
function SaveCsv($rel, $heads, $rows) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append(($heads -join ";") + "`r`n")
  foreach ($r in $rows) {
    $cells = New-Object string[] $r.Count
    for ($i = 0; $i -lt $r.Count; $i++) { $cells[$i] = CsvCell $r[$i] }
    [void]$sb.Append([string]::Join(";", $cells) + "`r`n")
  }
  $path = Join-Path $Site $rel
  $dir = Split-Path $path -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($path, $sb.ToString(), (New-Object System.Text.UTF8Encoding $true))
  return [pscustomobject]@{ rel = $rel; rows = $rows.Count; kb = [math]::Round((Get-Item $path).Length / 1024) }
}

$csvRows = NewList
foreach ($s in @($pageStocks | Sort-Object val2 -Descending)) {
  $csvRows.Add(@($s.isin, $s.name, $s.sector, $s.f2, [math]::Round($s.val2), $(if ($null -ne $s.netFlow) { [math]::Round($s.flow) } else { $null }),
    $(if ($null -ne $s.chg) { [math]::Round($s.chg * 100, 2) } else { $null }), $s.nNew, $s.nExit))
}
$fileStocks = SaveCsv "data/csv/aktier-$Q.csv" @("ISIN", "Aktie", "Sektor", "Fonder som äger", "Fondernas innehav (kr)", "Nettoköp (kr)", "Förändring antal aktier (%)", "Nya fonder", "Avvecklat") $csvRows

$csvRows = NewList
foreach ($fi in @($infos | Sort-Object { [double]$(if ($_.aum) { $_.aum } else { 0 }) } -Descending)) {
  $p = if ($profiles.ContainsKey($fi.id)) { $profiles[$fi.id] } else { $null }
  $csvRows.Add(@($fi.id, $fi.name, $fi.co, $(if ($fi.aum) { [math]::Round($fi.aum) } else { $null }), $fi.feeMin, $fi.feeMax, $fi.ar, $fi.sd,
    $(if ($fi.m) { [math]::Round($fi.m.val) } else { 0 }), $(if ($p -and $null -ne $p[0]) { [math]::Round($p[0] * 100, 1) } else { $null }),
    $(if ($p) { [math]::Round($p[1] * 100, 1) } else { $null }), $(if ($p) { $p[2] } else { $null })))
}
$fileFunds = SaveCsv "data/csv/fonder-$Q.csv" @("FI-nummer", "Fond", "Fondbolag", "Fondförmögenhet (kr)", "Lägsta avgift (%)", "Högsta avgift (%)", "Aktiv risk (%)", "Standardavvikelse (%)", "Svenska aktier (kr)", "Aktiv andel (%)", "Tio största (%)", "Antal aktier") $csvRows

$csvRows = NewList
foreach ($f in $funds) {
  foreach ($r in $f.rows) {
    if (-not $r.s1 -and -not $r.s2) { continue }
    $csvRows.Add(@($f.id, $f.name, $f.co, $r.s.isin, $r.s.name, $r.s2, $(if ($f.both) { $r.s1 } else { $null }), [math]::Round($r.v), $(if ($f.both) { [math]::Round($r.d) } else { $null })))
  }
}
$fileHold = SaveCsv "data/csv/innehav-$Q.csv" @("FI-nummer", "Fond", "Fondbolag", "ISIN", "Aktie", "Antal aktier", "Antal förra kvartalet", "Värde (kr)", "Förändring (kr)") $csvRows

$prevQL = QLabel ([string]$qMeta.prevId)
$srcRows = NewList
$srcRows.Add(@("Fondernas innehav", (A "https://www.fi.se/sv/vara-register/fondinnehav-per-kvartal/" "Finansinspektionen, fondinnehav per kvartal"), "Varje kvartal, ungefär tolv veckor efter kvartalsslut", "$QL (innehav $asOf)"))
$srcRows.Add(@("Avgifter och risk", "Samma kvartalsrapporter till FI", "Varje kvartal", $QL))
$srcRows.Add(@("Räntepapper och fondandelar", "Samma kvartalsrapporter till FI", "Varje kvartal", $QL))
$srcRows.Add(@("Marknadsräntor", (A "https://www.riksbank.se/sv/statistik/rantor-och-valutakurser/" "Riksbanken"), "Varje bankdag", "Hämtas varje morgon"))
$srcRows.Add(@("Blankning", (A "https://www.fi.se/sv/vara-register/blankningsregistret/" "Finansinspektionen, blankningsregistret"), "Varje dag", "Hämtas varje morgon"))
$srcRows.Add(@("Insynshandel", (A "https://marknadssok.fi.se/publiceringsklient" "Finansinspektionen, insynsregistret"), "Varje dag, arkiv sedan 2019", "Hämtas varje morgon"))
$srcRows.Add(@("Uppköpserbjudanden", (A "https://www.fi.se/sv/vara-register/prospektregistret/" "Finansinspektionen, prospektregistret"), "Varje dag", "Hämtas varje morgon"))
$srcRows.Add(@("Avkastning", (A "https://www.pensionsmyndigheten.se/" "Pensionsmyndighetens fonddata"), "Varje vecka", "Fonder på premiepensionens fondtorg"))

$dlRows = NewList
foreach ($x in @(@($fileStocks, "Aktier: fondägare, innehav och nettoköp"), @($fileFunds, "Fonder: avgift, risk, aktiv andel och storlek"), @($fileHold, "Alla fonders svenska aktieinnehav, rad för rad"))) {
  $dlRows.Add(@((A "/$($x[0].rel)" (Split-Path $x[0].rel -Leaf)), (Esc $x[1]), (Num0 $x[0].rows), ((Num0 $x[0].kb) + " kB")))
}
$apiRows = NewList
foreach ($x in @(@("data/index.json", "Vilka kvartal som finns"), @("data/$Q.json", "Svenska aktier, fondernas innehav och nyckeltal för alla fonder"),
    @("data/$Q-world.json", "Utländska aktier och innehav"), @("data/history-se.json", "Ägande och nettoköp per svensk aktie sedan 2018"),
    @("data/profiles.json", "Aktiv andel, tio största och antal aktier per fond"), @("data/shorts.json", "Blankning per bolag och innehavare"),
    @("data/insider.json", "Insynshandel i aktier, senaste 90 dagarna"), @("data/offers.json", "Uppköpserbjudanden och budpremier"), @("data/perf.json", "Avkastning per fond"),
    @("data/$Q-rates.json", "Räntepapper: emittenter, kategorier, löptider och nyckeltal per fond"), @("data/rates-market.json", "Marknadsräntor från Riksbanken, en notering per vecka"))) {
  $apiRows.Add(@(('<code>/' + $x[0] + '</code>'), (Esc $x[1])))
}
# ---------- Inbäddning, RSS-flöden och öppet dataset ----------

# Nettoköp av insiders per bolag, de senaste 90 dagarna
$insNet = @{}
if ($insider) {
  foreach ($r in $insider.rows) {
    $k = [string]$r[3]
    if (-not $k -or $null -eq $r[11]) { continue }
    if ($r[7] -eq "Förvärv") { $insNet[$k] = [double]$insNet[$k] + [double]$r[11] } elseif ($r[7] -eq "Avyttring") { $insNet[$k] = [double]$insNet[$k] - [double]$r[11] }
  }
}
$shareCount = @{}
try { if (Test-Path (Join-Path $DataDir "shares.json")) { foreach ($pr in (ReadJson "shares.json").shares.PSObject.Properties) { $shareCount[$pr.Name] = [double]$pr.Value[0] } } } catch { }
$shortPct = @{}
try { foreach ($a in (ReadJson "shorts.json").aggregate) { if ($a[1]) { $shortPct[[string]$a[1]] = [double]$a[2] } } } catch { }

# 1. data/embed.json: nyckeltal per svensk aktie för den inbäddningsbara rutan (site/embed.html)
#    [namn, slug, fonder, nettoköp kr, förändring antal aktier, ägarandel, insiders netto 90 d kr, blankning %]
$embParts = foreach ($s in $pageStocks) {
  $own = if ($shareCount[$s.isin]) { ([math]::Min([double]1, [double]$s.h2 / $shareCount[$s.isin])).ToString("0.####", $Inv) } else { "null" }
  $fl = if ($null -ne $s.netFlow -and $s.price) { [math]::Round([double]$s.flow).ToString($Inv) } else { "null" }
  $ch = if ($null -ne $s.chg) { ([double]$s.chg).ToString("0.####", $Inv) } else { "null" }
  $iv = if ($insNet.ContainsKey($s.isin)) { [math]::Round($insNet[$s.isin]).ToString($Inv) } else { "null" }
  $sp = if ($shortPct.ContainsKey($s.isin)) { $shortPct[$s.isin].ToString("0.##", $Inv) } else { "null" }
  (J $s.isin) + ":[" + (J $s.name) + "," + (J $s.slug) + "," + $s.f2 + "," + $fl + "," + $ch + "," + $own + "," + $iv + "," + $sp + "]"
}
Save "data/embed.json" ('{"q":' + (J $Q) + ',"ql":' + (J $QL) + ',"built":' + (J (Get-Date -Format "yyyy-MM-dd")) + ',"stocks":{' + (@($embParts) -join ",") + "}}")
Write-Host "  inbäddning: $(@($embParts).Count) aktier"

# 2. RSS-flöden: kvartalsrapporter, större insynshandel och insynshandel per aktie
function XmlEsc($t) { return ([string]$t).Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace('"', "&quot;") }
function RssDate($d) { try { return ([datetime]::ParseExact([string]$d, "yyyy-MM-dd", $Inv)).ToString("ddd, dd MMM yyyy 07:00:00 '+0000'", $Inv) } catch { return "" } }
# $items: lista med @{ title; link; desc; date; guid }
function SaveRss($rel, $title, $link, $desc, $items) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('<?xml version="1.0" encoding="UTF-8"?>' + "`n" + '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>')
  [void]$sb.Append("<title>" + (XmlEsc $title) + "</title><link>" + (XmlEsc ($BaseUrl + $link)) + "</link><description>" + (XmlEsc $desc) + "</description><language>sv-se</language>")
  [void]$sb.Append('<atom:link href="' + (XmlEsc "$BaseUrl/$rel") + '" rel="self" type="application/rss+xml"/>')
  foreach ($it in $items) {
    [void]$sb.Append("<item><title>" + (XmlEsc $it.title) + "</title><link>" + (XmlEsc ($BaseUrl + $it.link)) + "</link><description>" + (XmlEsc $it.desc) + "</description>")
    [void]$sb.Append('<guid isPermaLink="false">' + (XmlEsc $it.guid) + "</guid><pubDate>" + (RssDate $it.date) + "</pubDate></item>")
  }
  [void]$sb.Append("</channel></rss>")
  Save $rel $sb.ToString()
}
$qEndOf = @{ "1" = "03-31"; "2" = "06-30"; "3" = "09-30"; "4" = "12-31" }
$repItems = foreach ($r in $reportList) {
  @{ title = "Kvartalsrapport $($r.label): $($r.headline)"; link = "/rapport/$($r.slug)/"; desc = $r.desc
     date = ([string]$r.q).Substring(0, 4) + "-" + $qEndOf[([string]$r.q).Substring(5)]; guid = "rapport-$($r.q)" }
}
SaveRss "rss/rapporter.xml" "Fondinsyn – kvartalsrapporter" "/rapport/" "Vad svenska fonder köpte och sålde, varje kvartal." @($repItems)

$slugOf = @{}; foreach ($s in $pageStocks) { $slugOf[$s.isin] = $s.slug }
function InsItem($r) {
  $kind = if ($r[7] -eq "Förvärv") { "köpte" } elseif ($r[7] -eq "Avyttring") { "sålde" } else { [string]$r[7] }
  $who = ([string]$r[4] -replace '\s+', ' ').Trim()
  $amt = if ($null -ne $r[11]) { BigSek ([double]$r[11]) } else { "–" }
  $link = if ($slugOf.ContainsKey([string]$r[3])) { "/aktie/" + $slugOf[[string]$r[3]] + "/" } else { "/#/insyn" }
  return @{ title = "$($r[2]): $who $kind för $amt"; link = $link
    desc = "$who ($(([string]$r[5]) -replace '\s+', ' ')) $kind aktier i $($r[2]) för $amt. Affärsdag $($r[0]), publicerad $($r[1]). Källa: Finansinspektionens insynsregister."
    date = [string]$r[1]; guid = "insyn-" + [string]$r[3] + "-" + $who + "-" + [string]$r[0] + "-" + [string]$r[8] }
}
if ($insider) {
  $big = @($insider.rows | Where-Object { $null -ne $_[11] -and [double]$_[11] -ge 500000 -and ($_[7] -eq "Förvärv" -or $_[7] -eq "Avyttring") } | Sort-Object { [string]$_[1] } -Descending | Select-Object -First 100)
  SaveRss "rss/insyn.xml" "Fondinsyn – insynshandel" "/#/insyn" "Insiders köp och sälj för minst 500 000 kr i svenska bolag, från Finansinspektionens insynsregister." @($big | ForEach-Object { InsItem $_ })
  $rssByIsin = @{}
  foreach ($r in $insider.rows) { $k = [string]$r[3]; if ($slugOf.ContainsKey($k)) { if (-not $rssByIsin.ContainsKey($k)) { $rssByIsin[$k] = New-Object System.Collections.Generic.List[object] }; $rssByIsin[$k].Add($r) } }
  foreach ($k in $rssByIsin.Keys) {
    $rows = @($rssByIsin[$k] | Sort-Object { [string]$_[1] } -Descending | Select-Object -First 50)
    $nm = [string]$rows[0][2]
    SaveRss "rss/insyn/$($slugOf[$k]).xml" "Fondinsyn – insynshandel i $nm" "/aktie/$($slugOf[$k])/" "Insiders köp och sälj i $nm, från Finansinspektionens insynsregister." @($rows | ForEach-Object { InsItem $_ })
  }
  Write-Host "  rss: rapporter, insyn och $($rssByIsin.Count) aktier"
}

# 3. Öppet dataset (data/dataset/): hela historiken per aktie och kvartal, fondsparandet per månad och en beskrivning.
#    Standard-CSV (komma, punkt som decimaltecken, UTF-8) så att den fungerar i Python, R och på Kaggle.
function CsvField($v) { if ($null -eq $v) { return "" }; $t = [string]$v; if ($t -match '[",\n]') { return '"' + $t.Replace('"', '""') + '"' }; return $t }
$dsDir = Join-Path $Site "data/dataset"
New-Item -ItemType Directory -Force $dsDir | Out-Null
$dsLines = New-Object System.Collections.Generic.List[string]
$dsLines.Add("market,isin,name,sector,country,quarter,funds,holdings_msek,net_buy_msek,net_buy_active_msek,price_return")
$dsRows = 0
foreach ($part in @("se", "world")) {
  $hh = $null; try { $hh = ReadJson "history-$part.json" } catch { }
  if (-not $hh) { continue }
  $dsQuarters = @($hh.quarters)
  foreach ($pr in $hh.stocks.PSObject.Properties) {
    $v = $pr.Value
    # Textfälten citeras vid behov en gång per aktie. Tal skrivs med punkt (PowerShell använder invariant format vid +).
    $pre = $part + "," + $pr.Name + "," + (CsvField $v[0]) + "," + (CsvField $v[1]) + "," + (CsvField $v[2]) + ","
    foreach ($r in $v[3]) {
      $ret = if ($r.Count -gt 5) { $r[5] } else { $null }
      $dsLines.Add($pre + $dsQuarters[[int]$r[0]] + "," + $r[1] + "," + $r[2] + "," + $r[3] + "," + $r[4] + "," + $ret)
      $dsRows++
    }
  }
}
[System.IO.File]::WriteAllText((Join-Path $dsDir "stock_quarters.csv"), ($dsLines -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false))
$flLines = New-Object System.Collections.Generic.List[string]
$flLines.Add("month,group,category,net_flow_msek,assets_msek")
try {
  $fd = ReadJson "flows.json"
  $fm = @($fd.months)
  foreach ($grp in @(@("fund_type", $fd.types), @("equity_focus", $fd.focus))) {
    foreach ($pr in $grp[1].PSObject.Properties) {
      $vals = @($pr.Value)
      for ($i = 0; $i -lt $fm.Count; $i++) { if ($null -ne $vals[$i]) { $flLines.Add(((@($fm[$i], $grp[0], $pr.Name, $vals[$i][0], $vals[$i][1]) | ForEach-Object { CsvField $_ }) -join ",")) } }
    }
  }
} catch { }
[System.IO.File]::WriteAllText((Join-Path $dsDir "fund_flows_monthly.csv"), ($flLines -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false))
$firstQ = if ($hist) { [string]$hist.quarters[0] } else { $Q }
$readme = @"
# Fondinsyn dataset – Swedish mutual fund holdings and flows

What Swedish mutual funds own, buy and sell, quarter by quarter since $firstQ, built from the holdings every Swedish fund
company reports to Finansinspektionen (the Swedish FSA). Maintained by Fondinsyn ($BaseUrl) and updated automatically.
Latest quarter: $QL. Generated $(Get-Date -Format "yyyy-MM-dd").

## Files

**stock_quarters.csv** – one row per stock and quarter ($dsRows rows).

| Column | Description |
|---|---|
| market | se = Swedish stocks, world = foreign stocks (foreign stocks with smaller fund holdings are left out) |
| isin, name, sector, country | Stock identity. Sector is GICS as reported by the funds |
| quarter | Quarter, e.g. 2026Q2 (holdings at quarter end) |
| funds | Number of Swedish funds that own the stock |
| holdings_msek | Total value of the funds' holdings, million SEK |
| net_buy_msek | Net buying during the quarter: change in shares x quarter-end price, summed over funds that reported both quarters, split adjusted |
| net_buy_active_msek | Same, excluding index funds |
| price_return | Price change since the previous quarter (median of the funds' reported prices, split adjusted, excluding dividends). Empty when unreliable, e.g. at a change of share class |

Net buying is empty for share classes that appear or disappear (listings, ISIN changes at splits, takeovers).

**fund_flows_monthly.csv** – savers' net flows into Swedish funds per month from the Swedish Investment Fund Association
(Fondbolagens förening), by fund type (fund_type) and by investment focus for equity funds (equity_focus), million SEK.

## Method

See the method report: $BaseUrl/metod/ (in Swedish). Key points: prices are the median of reported prices, splits are
detected from the share-count ratios across funds, and quarters where most funds stop holding a share class are excluded
from price returns.

## Sources and licence

Source data: Finansinspektionen (fund holdings) and Fondbolagens förening (fund flows), published as open data.
Fondinsyn's compilation may be used freely with attribution: "Fondinsyn ($BaseUrl), source: Finansinspektionen" (CC BY 4.0).
Nothing here is investment advice.
"@
[System.IO.File]::WriteAllText((Join-Path $dsDir "README.md"), $readme, (New-Object System.Text.UTF8Encoding $false))
$zipName = "fondinsyn-dataset-$Q.zip"
$zipPath = Join-Path $dsDir $zipName
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $dsDir "stock_quarters.csv"), (Join-Path $dsDir "fund_flows_monthly.csv"), (Join-Path $dsDir "README.md") -DestinationPath $zipPath
# Samma fil med fast namn, för tjänster som hämtar senaste versionen automatiskt (t.ex. Kaggle)
Copy-Item $zipPath (Join-Path $dsDir "fondinsyn-dataset-latest.zip") -Force
$zipKb = [math]::Round((Get-Item $zipPath).Length / 1024)
Write-Host "  dataset: $dsRows rader, $zipKb kB"

$odContent = '<div class="page-head"><h1>Data och API</h1></div>' +
  '<p class="lead">Allt på Fondinsyn bygger på öppna data från Finansinspektionen och Pensionsmyndigheten. Här ser du var datan kommer ifrån, hur ofta den uppdateras, och hur du laddar ner den.</p>' +
  (Block "Källor och uppdatering" (Table @("Data", "Källa", "Uppdateras", "Senast") $srcRows) "section-gap") +
  '<p class="desc">Fondinsyn hämtar alla källor automatiskt varje morgon. Köp och sälj räknas som förändringen i antal aktier gånger kursen vid kvartalets slut, jämfört med ' + $prevQL + ". " + (A "/#/om" "Mer om metoden") + "</p>" +
  (Block "Ladda ner för Excel" (Table @("Fil", "Innehåll", "Rader", "Storlek") $dlRows) "section-gap") +
  '<p class="desc">CSV med semikolon och decimalkomma, ' + $QL + ". Öppnas direkt i svenska Excel och Google Kalkylark.</p>" +
  (Block "JSON för utvecklare" (Table @("Adress", "Innehåll") $apiRows) "section-gap") +
  '<p class="desc">Filerna ligger på https://www.fondinsyn.se och kan hämtas fritt utan nyckel, även från andra webbplatser. Formatet kan ändras. Ange gärna Fondinsyn och Finansinspektionen som källa.</p>' +
  (Block "Öppet dataset för analys" ('<p>Hela historiken per aktie och kvartal sedan ' + (QLabel $firstQ) + ' (' + (Num0 $dsRows) + ' rader: fonder, innehav, nettoköp och kursförändring) och spararnas fondflöden per månad. ' +
    'Standard-CSV för Python, R, Excel och Kaggle, med beskrivning av varje kolumn. Uppdateras automatiskt, och varje nytt kvartal publiceras också som en release på GitHub.</p>' +
    '<p><a class="btn" href="/data/dataset/' + $zipName + '">Ladda ner datasetet (' + $zipKb + ' kB)</a> <a href="/data/dataset/README.md">Beskrivning (README)</a> · ' +
    '<a href="https://github.com/axelbergstenn/fondinsyn/releases">Alla versioner på GitHub</a></p>') "section-gap") +
  (Block "RSS-flöden" ('<p>Prenumerera i valfri RSS-läsare, utan konto:</p><ul>' +
    '<li><a href="/rss/rapporter.xml">Kvartalsrapporter</a>: en notis när ett nytt kvartal har kommit.</li>' +
    '<li><a href="/rss/insyn.xml">Insynshandel</a>: insiders köp och sälj för minst 500 000 kr.</li>' +
    '<li>Insynshandel i en viss aktie: på varje aktiesida, till exempel <code>/rss/insyn/volvo-b.xml</code>.</li></ul>') "section-gap") +
  (Block "Bädda in på din sajt" ('<p>Visa fondernas köp och sälj, ägarandel, insynshandel och blankning för en aktie på din blogg eller i ditt forum. ' +
    'Gå till aktiens sida och tryck på Bädda in, eller använd koden nedan med aktiens namn i adressen.</p>' +
    '<p class="md-formula">&lt;iframe src="' + $BaseUrl + '/embed.html?aktie=volvo-b" width="100%" height="260" style="border:0" loading="lazy" title="Fondinsyn"&gt;&lt;/iframe&gt;</p>' +
    '<p>Kvartalets mest köpta eller sålda aktier: byt adressen mot <code>embed.html?lista=kopta</code> eller <code>?lista=salda</code> och höjden mot 300. ' +
    'Rutan följer besökarens ljusa eller mörka läge, eller lägg till <code>&amp;tema=ljust</code> eller <code>&amp;tema=morkt</code>.</p>') "section-gap") +
  (Block "Villkor" "<p>Uppgifterna kommer från myndigheternas öppna register och får användas fritt. Fondinsyns uträkningar får också användas om du anger källan (CC BY 4.0). Inget här är investeringsrådgivning.</p>" "section-gap")
# ---------- Dubbelsignal: /dubbelsignal/ (samma regler som viewDouble i app.js) ----------
if ($insider) {
  $insBy = @{}
  foreach ($r in $insider.rows) {
    if ($null -eq $r[11] -or ($r[7] -ne "Förvärv" -and $r[7] -ne "Avyttring")) { continue }
    $k = [string]$r[3]
    if (-not $insBy.ContainsKey($k)) { $insBy[$k] = @{ buy = 0.0; sell = 0.0 } }
    if ($r[7] -eq "Förvärv") { $insBy[$k].buy += [double]$r[11] } else { $insBy[$k].sell += [double]$r[11] }
  }
  $dBuy = New-Object System.Collections.Generic.List[object]; $dSell = New-Object System.Collections.Generic.List[object]
  foreach ($s in $pageStocks) {
    if ($null -eq $s.netFlow -or -not $insBy.ContainsKey($s.isin)) { continue }
    $net = $insBy[$s.isin].buy - $insBy[$s.isin].sell
    if ([math]::Abs([double]$s.flow) -lt 1e6 -or [math]::Abs($net) -lt 5e5 -or (([double]$s.flow -gt 0) -ne ($net -gt 0))) { continue }
    $x = [pscustomobject]@{ s = $s; net = $net }
    if ($s.flow -gt 0) { $dBuy.Add($x) } else { $dSell.Add($x) }
  }
  $dRows = { param($list) foreach ($x in $list) { ,@((A (StockUrl $x.s) $x.s.name), (Colored $x.s.flow (BigSek $x.s.flow -Sign)), (Colored $x.net (BigSek $x.net -Sign))) } }
  $topBuy = @($dBuy | Sort-Object net -Descending | Select-Object -First 15)
  $topSell = @($dSell | Sort-Object net | Select-Object -First 15)
  $days = $insider.days
  $content = '<div class="page-head"><h1>Dubbelsignal</h1><p class="meta lead">Aktier där både fonderna och bolagets egna insiders har köpt, eller där båda har sålt. Fondernas affärer gäller ' + $QL +
    ", insidernas köp och sälj de senaste $days dagarna enligt Finansinspektionens insynsregister.</p></div>" +
    '<dl class="figures">' + (Fig "Dubbel köpsignal" "$($dBuy.Count) aktier") + (Fig "Dubbel säljsignal" "$($dSell.Count) aktier") + "</dl>" +
    (Block "Både fonder och insiders köper" (Table @("Aktie", "Fonderna $QL", "Insiders $days dagar") @(& $dRows $topBuy)) "section-gap") +
    (Block "Både fonder och insiders säljer" (Table @("Aktie", "Fonderna $QL", "Insiders $days dagar") @(& $dRows $topSell)) "section-gap") +
    '<p class="desc section-gap">En dubbelsignal är en observation, inte en köp- eller säljrekommendation. Insiders kan sälja av skäl som skatt eller lån, och fondernas affärer kan spegla in- och utflöden. ' + (A "/#/dubbelsignal" "Se hela listan") + "</p>"
  Page "dubbelsignal/" "dubbelsignal" "Dubbelsignal – aktier som både fonder och insiders köper | Fondinsyn" `
    "Aktier där både svenska fonder och bolagets egna insiders köper ($($dBuy.Count) st) eller säljer ($($dSell.Count) st). Fondernas affärer $QL och insidernas de senaste $days dagarna." `
    $defaultImg $content -Crumbs @("Dubbelsignal", "dubbelsignal/")
  Write-Host "  dubbelsignal: $($dBuy.Count) köp, $($dSell.Count) sälj"
}

# ---------- Fondsparandet: /sparande/ (månadsstatistik ur data/flows.json, samma sida som viewSavings i app.js) ----------
$flowsData = $null
try { if (Test-Path (Join-Path $DataDir "flows.json")) { $flowsData = ReadJson "flows.json" } } catch { }
if ($flowsData -and $flowsData.months -and $flowsData.types.TOTALT) {
  $fm = @($flowsData.months); $li = $fm.Count - 1
  while ($li -gt 0 -and $null -eq $flowsData.types.TOTALT[$li]) { $li-- }
  $mNames = @("januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december")
  $lmText = $mNames[[int]$fm[$li].Substring(5) - 1] + " " + $fm[$li].Substring(0, 4)
  $msekText = { param($v) if ($null -eq $v) { "–" } else { Colored ([double]$v) (BigSek ([double]$v * 1e6) -Sign) } }
  $sum12 = { param($name) $t = 0.0; for ($i = [math]::Max(0, $li - 11); $i -le $li; $i++) { $v = $flowsData.types.$name[$i]; if ($null -ne $v) { $t += [double]$v[0] } }; $t }
  $tRows = NewList
  foreach ($n in @("Aktiefonder", "Blandfonder", "Långa räntefonder", "Korta räntefonder", "Hedgefonder", "Övriga fonder", "TOTALT")) {
    $ser = $flowsData.types.$n
    if (-not $ser) { continue }
    $lastV = $ser[$li]
    $tRows.Add(@($(if ($n -eq "TOTALT") { "Alla fonder" } else { Esc $n }), (& $msekText $(if ($lastV) { $lastV[0] } else { $null })), (& $msekText (& $sum12 $n))))
  }
  $totNow = $flowsData.types.TOTALT[$li][0]
  $content = '<div class="page-head"><h1>Fondsparandet</h1><p class="meta lead">Hur mycket svenskarna sätter in i och tar ut ur fonder varje månad, vilka sorters fonder som får pengarna och vilka enskilda fonder som växer mest. ' +
    'Månadssiffrorna kommer från Fondbolagens förening, flödena per fond är uppskattade ur Finansinspektionens fondinnehav.</p></div>' +
    '<dl class="figures">' + (Fig "Nettosparande $lmText" (& $msekText $totNow)) + (Fig "Aktiefonder" (& $msekText $flowsData.types.Aktiefonder[$li][0])) + "</dl>" +
    (Block "Per fondtyp" (Table @("Fondtyp", $lmText, "12 månader") $tRows) "section-gap") +
    '<p class="desc section-gap">Källa: Fondbolagens förening och Finansinspektionen. ' + (A "/#/sparande" "Se diagram och flöden per fond") + "</p>"
  Page "sparande/" "sparande" "Fondsparandet $lmText – vart spararnas pengar går | Fondinsyn" `
    ("Svenskarnas nettosparande i fonder var " + (BigSek ([double]$totNow * 1e6) -Sign) + " i $lmText. Insättningar och uttag per fondtyp, aktiefonder per inriktning och vilka fonder som växer mest.") `
    $defaultImg $content -Crumbs @("Fondsparandet", "sparande/")
  Write-Host "  fondsparandet: $lmText"
}

# ---------- Samlad signal: /signaler/ (listan räknas i appen, här står metoden för sökmotorer) ----------
$content = '<div class="page-head"><h1>Samlad signal</h1><p class="meta lead">Fondernas köp och sälj, insidernas affärer och blankningen vägda ihop till ett tal per aktie, från −100 till +100. ' +
  'Ett sätt att se var flera signaler pekar åt samma håll. Det är inte en rekommendation att köpa eller sälja.</p></div>' +
  '<section class="block section-gap text-page"><div class="block-head"><h2>Så räknas signalen</h2></div>' +
  '<p><b>Fonderna (40 %).</b> Hur många fonder som ökade jämfört med hur många som minskade i aktien senaste kvartalet, och hur mycket fondernas antal aktier ändrades.</p>' +
  '<p><b>Insiders (40 %).</b> Köp minus sälj i bolaget de senaste 90 dagarna enligt Finansinspektionens insynsregister.</p>' +
  '<p><b>Blankning (20 %).</b> Hur den blankade andelen ändrats de senaste 30 dagarna.</p>' +
  '<p>' + (A "/#/signaler" "Se listan med aktierna") + '</p></section>'
Page "signaler/" "signaler" "Samlad signal – fonder, insiders och blankning ihop | Fondinsyn" `
  "Svenska aktier där fonderna köper, insiders köper och blankningen minskar, eller tvärtom. Tre signaler vägda ihop till ett tal per aktie." `
  $defaultImg $content -Crumbs @("Samlad signal", "signaler/")

# ---------- Fondernas ägarandel och Toppfonderna (listorna räknas i appen) ----------
$content = '<div class="page-head"><h1>Fondernas ägarandel</h1><p class="meta lead">Hur stor del av bolagen på Stockholmsbörsen och First North som svenska fonder äger tillsammans, ' +
  'och var fonderna ökade och minskade sin andel under ' + $QL + '.</p></div><p class="desc">' + (A "/#/agarandel" "Se listan med alla bolag") + '</p>'
Page "agarandel/" "agarandel" "Fondernas ägarandel – hur mycket fonderna äger av bolagen | Fondinsyn" `
  "Hur stor andel av svenska börsbolag som ägs av svenska fonder, vilka bolag fonderna äger mest av och var de ökade och minskade sin andel $QL." `
  $defaultImg $content -Crumbs @("Fondernas ägarandel", "agarandel/")
$content = '<div class="page-head"><h1>Toppfonderna</h1><p class="meta lead">De aktivt förvaltade fonderna med bäst avkastning de senaste fem åren, och vilka aktier de köpte och sålde under ' + $QL + '.</p></div>' +
  '<p class="desc">' + (A "/#/toppfonder" "Se fonderna och deras affärer") + '</p>'
Page "toppfonder/" "toppfonder" "Toppfonderna – vad fonderna med bäst avkastning köper | Fondinsyn" `
  "Vilka aktier de svenska fonderna med bäst avkastning de senaste fem åren köpte och sålde under $QL." `
  $defaultImg $content -Crumbs @("Toppfonderna", "toppfonder/")

# ---------- Backtest och metodrapport (räknas i appen, här står en sammanfattning för sökmotorer) ----------
$content = '<div class="page-head"><h1>Lönar det sig att följa fonderna?</h1><p class="meta lead">Ett backtest på historisk data sedan 2019: går de svenska aktier som fonderna köper mest bättre än de som de säljer? ' +
  'Bara med information som fanns när den behövdes.</p></div><p class="desc">' + (A "/#/backtest" "Se resultatet") + '</p>'
Page "backtest/" "backtest" "Lönar det sig att följa fonderna? Backtest | Fondinsyn" `
  "Backtest sedan 2019: går de svenska aktier som fonderna köper mest bättre än de som fonderna säljer? Metod, resultat och begränsningar." `
  $defaultImg $content -Crumbs @("Backtest", "backtest/")
$content = '<div class="page-head"><h1>Metodrapport</h1><p class="meta lead">Hur Fondinsyn samlar in och räknar sin data: källor, nettoköp, splitjustering, fondflöden, ägarandel, signaler och backtest.</p></div>' +
  '<p class="desc">' + (A "/#/metod" "Läs metodrapporten") + '</p>'
Page "metod/" "metod" "Metodrapport – så räknar Fondinsyn | Fondinsyn" `
  "Källor, definitioner och begränsningar bakom Fondinsyn: hur fondernas nettoköp, ägarandel, fondflöden och signaler räknas ur Finansinspektionens data." `
  $defaultImg $content -Crumbs @("Metodrapport", "metod/")

# ---------- Integritet och villkor: /integritet/ ----------
$privacy = '<div class="page-head"><h1>Integritet och villkor</h1><p class="meta">Senast uppdaterad 22 oktober 2026</p></div>' +
  '<p class="lead">Fondinsyn sätter inga kakor, kräver inget konto och säljer inga uppgifter. Här beskrivs vilka uppgifter som ändå hanteras när du använder sajten, och vilka villkor som gäller för innehållet.</p>' +
  (Block "Vem ansvarar" ("<p>Fondinsyn drivs som ett privat projekt och är personuppgiftsansvarig för de uppgifter som beskrivs här. Frågor om dina uppgifter skickar du via " + (A "/#/kontakt" "kontaktsidan") + ".</p>") "section-gap") +
  (Block "Besöksstatistik" ("<p>Fondinsyn räknar besök med " + (A "https://www.goatcounter.com/help/privacy" "GoatCounter") + ", som inte använder kakor och inte sparar IP-adresser. " +
    "Det som registreras är vilken sida som visas, vilken sajt du kom ifrån, webbläsare, operativsystem, skärmstorlek och land. Uppgifterna kan inte knytas till dig som person och används bara för att se vilka delar av sajten som används.</p>") "section-gap") +
  (Block "Det som sparas i din webbläsare" ("<p>Vissa val sparas i din egen webbläsare (lokal lagring) så att sajten kommer ihåg dem nästa gång: mörkt eller ljust läge, valt kvartal, Sverige eller utland, om indexfonder ska tas bort, " +
    "dina bevakade aktier och fonder och det du lagt in i Min portfölj. Uppgifterna skickas aldrig till Fondinsyn eller någon annan, och du tar bort dem genom att rensa webbplatsdata i webbläsaren.</p>") "section-gap") +
  (Block "Villkor för innehållet" ("<p>Allt på Fondinsyn är information och inte investeringsrådgivning. Innehållet tar inte hänsyn till din ekonomi eller dina mål, och historiska affärer säger inget säkert om framtiden.</p>" +
    "<p>Uppgifterna kommer från Finansinspektionen, Riksbanken och Pensionsmyndigheten och bearbetas automatiskt av Fondinsyn. Källorna kan innehålla fel, och Fondinsyns uträkningar, till exempel nettoköp och vilken emittent en obligation hör till, kan bli fel. " +
    "Kontrollera därför viktiga uppgifter mot källan innan du fattar beslut. Fondinsyn ansvarar inte för förluster som uppstår när innehållet används.</p>" +
    "<p>Du får gärna använda och dela uppgifterna om du anger Fondinsyn och Finansinspektionen som källa. Se " + (A "/oppen-data/" "Data och API") + " för nedladdning.</p>") "section-gap")
Page "integritet/" "integritet" "Integritet och villkor | Fondinsyn" "Hur Fondinsyn hanterar uppgifter: inga kakor, besöksstatistik utan personuppgifter och vad som sparas i webbläsaren. Plus villkoren för innehållet." $defaultImg ('<div class="text-page">' + $privacy + '</div>') -Crumbs @("Integritet och villkor", "integritet/") -Keep

Page "oppen-data/" "data" "Data och API – ladda ner fonddata | Fondinsyn" "Var Fondinsyns data kommer ifrån, hur ofta den uppdateras och hur du laddar ner den som CSV eller JSON. Öppna data från Finansinspektionen." $defaultImg ('<div class="text-page">' + $odContent + '</div>') -Crumbs @("Data och API", "oppen-data/") -Keep
Write-Host "  öppen data: $($fileStocks.rows) aktier, $($fileFunds.rows) fonder, $($fileHold.rows) innehav"

# ---------- Startsidans moduler och marknadsremsan: data/front.json ----------
# En liten fil med det startsidan och remsan överst behöver, så att de inte hämtar de stora datafilerna.
$front = New-Object System.Collections.Generic.List[string]
$front.Add('"q":' + (J $Q) + ',"ql":' + (J $QL) + ',"net":' + [math]::Round([double]$tNet).ToString($Inv))
$mkt = $null
try { if (Test-Path (Join-Path $DataDir "rates-market.json")) { $mkt = ReadJson "rates-market.json" } } catch { }
if ($mkt) {
  $rs = foreach ($id in @("SECBREPOEFF", "SEGVB10YC", "SEMB5YCACOMB", "SEGVB2YC")) {
    $ser = $mkt.series.$id
    if (-not $ser -or -not $ser.points.Count) { continue }
    $pts = @($ser.points); $lp = $pts[-1]
    $yearAgoDate = ([datetime]::ParseExact([string]$lp[0], "yyyy-MM-dd", $Inv)).AddDays(-365).ToString("yyyy-MM-dd")
    $ya = @($pts | Where-Object { [string]$_[0] -le $yearAgoDate } | Select-Object -Last 1)
    $chg = if ($ya.Count) { [double]$lp[1] - [double]$ya[0][1] } else { $null }
    # De senaste 52 veckorna för en liten kurva
    $spark = (@($pts | Select-Object -Last 52 | ForEach-Object { ([double]$_[1]).ToString("0.###", $Inv) })) -join ","
    "[" + (J $id) + "," + (J $ser.label) + "," + ([double]$lp[1]).ToString("0.###", $Inv) + "," + (J ([string]$lp[0])) + "," + $(if ($null -eq $chg) { "null" } else { $chg.ToString("0.###", $Inv) }) + ",[" + $spark + "]]"
  }
  $front.Add('"rates":[' + (@($rs) -join ",") + "]")
}
if ($ratesLight) { $front.Add('"bonds":[' + [math]::Round([double]$ratesLight.totals[1]).ToString($Inv) + "," + [math]::Round([double]$ratesLight.totals[2]).ToString($Inv) + "]") }
if ($insider) {
  $since30 = (Get-Date).AddDays(-30).ToString("yyyy-MM-dd"); $since14 = (Get-Date).AddDays(-14).ToString("yyyy-MM-dd")
  $b30 = 0.0; $n30 = 0; $s30 = 0.0
  foreach ($r in $insider.rows) { if ([string]$r[0] -ge $since30 -and $null -ne $r[11]) { if ($r[7] -eq "Förvärv") { $b30 += [double]$r[11]; $n30++ } elseif ($r[7] -eq "Avyttring") { $s30 += [double]$r[11] } } }
  $big = @($insider.rows | Where-Object { $_[7] -eq "Förvärv" -and $null -ne $_[11] -and [double]$_[11] -ge 1e6 -and [string]$_[1] -ge $since14 } | Sort-Object { -[double]$_[11] } | Select-Object -First 12)
  $bigJ = foreach ($r in $big) { "[" + (J $r[2]) + "," + (J $r[3]) + "," + (J (([string]$r[4]) -replace '\s+', ' ')) + "," + (J (([string]$r[5]) -replace '\s+', ' ')) + "," + [math]::Round([double]$r[11]).ToString($Inv) + "," + (J ([string]$r[0])) + "]" }
  $front.Add('"insider":{"buy30":' + [math]::Round($b30).ToString($Inv) + ',"sell30":' + [math]::Round($s30).ToString($Inv) + ',"n30":' + $n30 + ',"top":[' + (@($bigJ) -join ",") + "]}")
}
if ($dBuy) {
  $dj = foreach ($x in @($dBuy | Sort-Object net -Descending | Select-Object -First 6)) { "[" + (J $x.s.name) + "," + (J $x.s.isin) + "," + [math]::Round([double]$x.s.flow).ToString($Inv) + "," + [math]::Round([double]$x.net).ToString($Inv) + "]" }
  $front.Add('"double":{"buy":' + $dBuy.Count + ',"sell":' + $dSell.Count + ',"top":[' + (@($dj) -join ",") + "]}")
}
try {
  $sh = ReadJson "shorts.json"
  $shTop = foreach ($a in @($sh.aggregate | Sort-Object { -[double]$_[2] } | Select-Object -First 6)) { "[" + (J $a[0]) + "," + (J $a[1]) + "," + ([double]$a[2]).ToString("0.##", $Inv) + "]" }
  $front.Add('"shorts":[' + (@($shTop) -join ",") + "]")
} catch { }
# Spararnas nettosparande senaste månaden (data/flows.json från build-flows.ps1), i MSEK
try {
  if (Test-Path (Join-Path $DataDir "flows.json")) {
    $fl = ReadJson "flows.json"
    $fmo = @($fl.months); $ser = @($fl.types.TOTALT)
    for ($k = $fmo.Count - 1; $k -ge 0; $k--) { if ($null -ne $ser[$k]) { $front.Add('"savings":[' + (J ([string]$fmo[$k])) + "," + ([double]$ser[$k][0]).ToString("0.#", $Inv) + "]"); break } }
  }
} catch { }
$front.Add('"built":' + (J (Get-Date -Format "yyyy-MM-dd HH:mm")))
Save "data/front.json" ("{" + ($front -join ",") + "}")

# Startsidan och 404
$introCont = @($cur.stocks | Where-Object { $_.price -and $null -ne $_.netFlow })
$introBuys = @($introCont | Where-Object { $_.flow -gt 0 } | Sort-Object flow -Descending)
$introSells = @($introCont | Where-Object { $_.flow -lt 0 } | Sort-Object flow)
# Samma markup som reportCard() i app.js, så att sidan inte hoppar när appen tar över
$repOpts = (@($index.quarters | ForEach-Object { '<a href="/rapport/' + (ReportSlug ([string]$_.id)) + '/">' + (QLabel ([string]$_.id)) + '</a>' })) -join " · "
$about = '<section class="about-card" aria-label="Om Fondinsyn"><div class="ac-text"><h2>Vad är Fondinsyn?</h2>' +
  '<p>Fondinsyn visar vad svenska fonder köper och säljer. Varje kvartal rapporterar fondbolagen alla sina innehav till Finansinspektionen. ' +
  'Vi jämför kvartalen och räknar ut vad som köpts och sålts per aktie, fond och fondbolag, och lägger till insynshandel, blankning, fondsparande och räntor. ' +
  'Gratis och oberoende. <a href="/#/om">Så funkar det</a></p></div><dl class="ac-freq">' +
  '<div><dt>Fondernas innehav</dt><dd>Varje kvartal</dd><span>Finansinspektionen</span></div>' +
  '<div><dt>Insynshandel och blankning</dt><dd>Varje dag</dd><span>Finansinspektionen</span></div>' +
  '<div><dt>Fondsparandet</dt><dd>Varje månad</dd><span>Fondbolagens förening</span></div>' +
  '<div><dt>Räntor och avkastning</dt><dd>Dag och vecka</dd><span>Riksbanken, Pensionsmyndigheten</span></div></dl></section>'
$intro = $about + '<section class="rep-card"><div class="rc-main"><p class="kicker">Kvartalsrapport ' + $QL + '</p>' +
  '<a class="rc-title" href="/rapport/' + (ReportSlug $Q) + '/">' + (Esc (QuarterHeadline $introCont $introBuys $introSells)) + '</a>' +
  '<p class="rc-meta">Nettoköp svenska aktier <b class="' + (SignClass $tNet) + '">' + (BigSek $tNet -Sign) + '</b> · ' + (Num0 $tFunds) + ' fonder · innehaven den ' + $asOf + '</p>' +
  '<p class="rc-meta">Alla rapporter: ' + $repOpts + '</p></div></section>'
if ($WriteHome) {
  $cont = @($pageStocks | Where-Object { $null -ne $_.netFlow -and $_.price })
  $rowsB = NewList; foreach ($s in @($cont | Where-Object { $_.flow -gt 0 } | Sort-Object flow -Descending | Select-Object -First 15)) { $rowsB.Add(@((A (StockUrl $s) $s.name), (Colored $s.flow (Mkr $s.flow -Sign)), (Num0 $s.f2))) }
  $rowsS = NewList; foreach ($s in @($cont | Where-Object { $_.flow -lt 0 } | Sort-Object flow | Select-Object -First 15)) { $rowsS.Add(@((A (StockUrl $s) $s.name), (Colored $s.flow (Mkr $s.flow -Sign)), (Num0 $s.f2))) }
  $homeContent = '<h1 class="visually-hidden">Fondinsyn: vad svenska fonder köper och säljer</h1>' + $intro + '<div class="grid-2 section-gap">' + (Block "Störst nettoköp $QL" (Table @("Aktie", "Nettoköp (mkr)", "Fonder") $rowsB) "") +
    (Block "Störst nettosälj $QL" (Table @("Aktie", "Nettoköp (mkr)", "Fonder") $rowsS) "") + "</div>" +
    '<p class="desc section-gap"><a href="/rapport/' + (ReportSlug $Q) + '/">Kvartalsrapport ' + $QL + '</a> · <a href="/aktier/">Alla aktier</a> · <a href="/fonder/">Alla fonder</a> · <a href="/fondbolag/">Alla fondbolag</a> · <a href="/ordlista/">Ordlista</a></p>'
  # Webbplatsen och datan som dataset (syns i Google Dataset Search)
  $first = if ($hist) { [string]$hist.quarters[0] } else { $Q }
  $qEnd = @{ "1" = "03-31"; "2" = "06-30"; "3" = "09-30"; "4" = "12-31" }
  $homeLd = @(
    ('{"@context":"https://schema.org","@type":"WebSite","name":"Fondinsyn","url":' + (J ($BaseUrl + "/")) + ',"inLanguage":"sv-SE"}'),
    # Loggan som Google och Bing visar bredvid sajten i sökresultaten
    ('{"@context":"https://schema.org","@type":"Organization","name":"Fondinsyn","url":' + (J ($BaseUrl + "/")) + ',"logo":' + (J ($BaseUrl + "/assets/icon-512.png")) +
      ',"image":' + (J ($BaseUrl + "/og/fondinsyn.png")) + '}'),
    ('{"@context":"https://schema.org","@type":"Dataset","name":"Svenska fonders aktieinnehav per kvartal","description":' +
      (J ("Vilka aktier svenska värdepappersfonder äger, köper och säljer, kvartal för kvartal sedan " + $first.Substring(0, 4) +
        ". Bygger på fondinnehaven som fondbolagen rapporterar till Finansinspektionen, med avgifter, aktiv risk och förändringar per aktie, fond och fondbolag.")) +
      ',"url":' + (J ($BaseUrl + "/")) + ',"inLanguage":"sv","isAccessibleForFree":true,"spatialCoverage":"Sverige"' +
      ',"keywords":["fonder","fondinnehav","aktier","fondbolag","avgifter","Finansinspektionen"]' +
      ',"temporalCoverage":' + (J ($first.Substring(0, 4) + "-" + $qEnd[$first.Substring(5)] + "/" + $qMeta.curr)) +
      ',"dateModified":' + (J $qMeta.built) +
      ',"isBasedOn":"https://www.fi.se/sv/vara-register/fondinnehav-per-kvartal/"' +
      ',"creator":{"@type":"Organization","name":"Fondinsyn","url":' + (J ($BaseUrl + "/")) + "}" +
      ',"distribution":[{"@type":"DataDownload","encodingFormat":"application/json","contentUrl":' + (J "$BaseUrl/data/$Q.json") + "}]}")
  )
  $homeTitle = [regex]::Match($tag.title, '<title>([^<]*)</title>').Groups[1].Value
  $homeDesc = [regex]::Match($tag.desc, 'content="([^"]*)"').Groups[1].Value
  Page "" "" ([System.Net.WebUtility]::HtmlDecode($homeTitle)) ([System.Net.WebUtility]::HtmlDecode($homeDesc)) $defaultImg $homeContent -Ld $homeLd
} else {
  $sitemap.Add($BaseUrl + "/")
}
Page "404.html" "finnsinte" "Sidan finns inte | Fondinsyn" "Sidan finns inte på Fondinsyn. Sök efter aktien eller fonden, eller gå till översikten." $defaultImg '<div class="page-head"><h1>Sidan finns inte</h1><p class="meta lead">Adressen kan vara felstavad, eller så har aktien eller fonden bytt namn. <a href="/">Till översikten</a></p></div>' -NoIndex

# ---------- Sitemap, robots.txt och adresslistan för Dela-knappen ----------

$sb = New-Object System.Text.StringBuilder
[void]$sb.Append('<?xml version="1.0" encoding="UTF-8"?>' + "`n" + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + "`n")
foreach ($u in ($sitemap | Sort-Object -Unique)) { [void]$sb.Append("<url><loc>" + (Esc $u) + "</loc><lastmod>" + $qMeta.built + "</lastmod></url>`n") }
[void]$sb.Append("</urlset>`n")
Save "sitemap.xml" $sb.ToString()
Save "robots.txt" ("User-agent: *`nAllow: /`n`nSitemap: $BaseUrl/sitemap.xml`n")

$map = @()
$map += '"aktie":{' + ((@($pageStocks | ForEach-Object { (J $_.isin) + ":" + (J $_.slug) })) -join ",") + "}"
$map += '"fond":{' + ((@($infos | ForEach-Object { (J $_.id) + ":" + (J $_.slug) })) -join ",") + "}"
$map += '"fondbolag":{' + ((@($coList | ForEach-Object { (J $_.name) + ":" + (J $_.slug) })) -join ",") + "}"
# Aktiesidor som har ett insynsarkiv (data/insyn/<isin>.json), så att appen inte frågar efter filer som saknas
$map += '"insyn":[' + ((@($pageStocks | Where-Object { $insynArchive -and $insynArchive.ContainsKey($_.isin) } | ForEach-Object { J $_.isin })) -join ",") + "]"
Save "data/pages.json" ("{" + ($map -join ",") + "}")
Write-Host "  sitemap med $($sitemap.Count) adresser"

# ---------- SVG till PNG ----------

if ($HasRsvg) {
  $svgs = @(Get-ChildItem (Join-Path $Site "og") -Filter *.svg | ForEach-Object { $_.FullName })
  Write-Host "  ritar $($svgs.Count) delningsbilder"
  if ($PSVersionTable.PSVersion.Major -ge 7) {
    $svgs | ForEach-Object -ThrottleLimit 8 -Parallel {
      & rsvg-convert -w 1200 -h 630 -b white -o ($_ -replace '\.svg$', '.png') $_
      if ($LASTEXITCODE -eq 0) { Remove-Item $_ }
    }
  } else {
    foreach ($p in $svgs) {
      & rsvg-convert -w 1200 -h 630 -b white -o ($p -replace '\.svg$', '.png') $p
      if ($LASTEXITCODE -eq 0) { Remove-Item $p }
    }
  }
  $left = @(Get-ChildItem (Join-Path $Site "og") -Filter *.svg).Count
  if ($left) { Write-Host "  varning: $left bilder kunde inte göras om till PNG" }
} else {
  Write-Host "  rsvg-convert saknas, delningsbilderna sparas bara som SVG"
}
Write-Host "Sidor klara."
