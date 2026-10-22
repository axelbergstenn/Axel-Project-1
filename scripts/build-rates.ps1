<#
.SYNOPSIS
  Bygger räntedatan: fondernas räntepapper och fondandelar ur FI:s kvartalsfiler, och marknadsräntor från Riksbanken.

.DESCRIPTION
  Fondbolagen rapporterar alla innehav till Finansinspektionen, inte bara aktier. Skriptet läser samma zip-filer
  som build-data.ps1 (i .cache) och skriver för varje kvartalspar:

    site/data/<kvartal>-rates.json        Emittenter, kategorier, löptider och nyckeltal per fond (läses av sajten)
    site/data/<kvartal>-rates-funds.json  Varje fonds räntepapper och fondandelar (delas upp per fond av build-pages.ps1)

  Emittenten står inte som ett eget fält hos FI, bara i instrumentnamnet, och fondbolagen skriver samma obligation på
  olika sätt ("SGB 1 3/4 11/11/33", "Svenska staten 1,75% 2033"). Obligationerna grupperas därför först per ISIN och
  namnvarianterna knyts ihop till en emittent när minst två obligationer binder ihop dem (eller när ett namn bara
  förekommer på en obligation). Ett felmärkt innehav hos en enskild fond slår alltså inte ihop två bolag.

  Marknadsräntorna (styrränta, statsobligationer, bostadsobligationer) hämtas varje dag från Riksbankens öppna
  API och skrivs till site/data/rates-market.json, som inte sparas i repot.
#>
param(
  [string]$OutDir = "site/data",
  [string]$CacheDir = ".cache",
  [int]$History = 4,
  [switch]$Force,
  [switch]$SkipMarket
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$FormatVersion = 7
$Inv = [System.Globalization.CultureInfo]::InvariantCulture
$Utf8 = New-Object System.Text.UTF8Encoding $false

function Num($s) {
  if ([string]::IsNullOrWhiteSpace($s)) { return $null }
  $d = 0.0
  if ([double]::TryParse(([string]$s).Replace(",", "."), [System.Globalization.NumberStyles]::Float, $Inv, [ref]$d)) { return $d }
  return $null
}
function J($s) {
  if ($null -eq $s) { return "null" }
  return '"' + (([string]$s) -replace '[\x00-\x1f]+', ' ').Replace('\', '\\').Replace('"', '\"') + '"'
}
function N($v, $fmt = "0.####") { if ($null -eq $v) { return "null" }; return ([double]$v).ToString($fmt, $Inv) }
function Whole($v) { if ($null -eq $v) { return "null" }; return [math]::Round([double]$v).ToString($Inv) }
function Write-Utf8($path, $text) { [System.IO.File]::WriteAllText($path, $text, $Utf8) }

# ---------------------------------------------------------------------------
# Marknadsräntor från Riksbanken (dagligen)

$MarketSeries = [ordered]@{
  "SECBREPOEFF"  = "Styrränta"
  "SETB3MBENCH"  = "Statsskuldväxel 3 mån"
  "SEGVB2YC"     = "Statsobligation 2 år"
  "SEGVB5YC"     = "Statsobligation 5 år"
  "SEGVB10YC"    = "Statsobligation 10 år"
  "SEMB2YCACOMB" = "Bostadsobligation 2 år"
  "SEMB5YCACOMB" = "Bostadsobligation 5 år"
}

function Build-Market {
  $from = (Get-Date).AddYears(-20).AddDays(-14).ToString("yyyy-MM-dd")   # 20 år, för diagrammets längsta period
  $to = (Get-Date).ToString("yyyy-MM-dd")
  $parts = New-Object System.Collections.Generic.List[string]
  foreach ($id in $MarketSeries.Keys) {
    $obs = $null
    for ($try = 1; $try -le 4 -and -not $obs; $try++) {
      try { $obs = Invoke-RestMethod -Uri "https://api.riksbank.se/swea/v1/Observations/$id/$from/$to" -TimeoutSec 60 }
      catch { if ($try -eq 4) { throw }; Start-Sleep -Seconds (20 * $try) }   # Riksbanken begränsar antalet anrop per minut
    }
    $obs = @($obs | Where-Object { $null -ne $_.value } | Sort-Object date)
    if (-not $obs.Count) { continue }
    # En punkt per vecka (veckans sista notering) räcker för diagrammen, plus den senaste noteringen
    $weekly = New-Object System.Collections.Generic.List[string]
    $lastWeek = ""
    for ($k = 0; $k -lt $obs.Count; $k++) {
      $d = [datetime]::ParseExact($obs[$k].date, "yyyy-MM-dd", $Inv)
      $wk = $d.AddDays(-((([int]$d.DayOfWeek) + 6) % 7)).ToString("yyyy-MM-dd")
      $next = if ($k + 1 -lt $obs.Count) { $d2 = [datetime]::ParseExact($obs[$k + 1].date, "yyyy-MM-dd", $Inv); $d2.AddDays(-((([int]$d2.DayOfWeek) + 6) % 7)).ToString("yyyy-MM-dd") } else { "" }
      if ($wk -ne $next) { $weekly.Add("[" + (J $obs[$k].date) + "," + (N $obs[$k].value) + "]") }
    }
    $parts.Add((J $id) + ':{"label":' + (J $MarketSeries[$id]) + ',"points":[' + ($weekly -join ",") + "]}")
    Start-Sleep -Seconds 3
  }
  if (-not $parts.Count) { throw "Inga serier från Riksbanken" }
  Write-Utf8 (Join-Path $OutDir "rates-market.json") ('{"built":' + (J (Get-Date -Format "yyyy-MM-dd")) + ',"source":"Sveriges Riksbank","series":{' + ($parts -join ",") + "}}")
  Write-Host "  marknadsräntor: $($parts.Count) serier"
}

if (-not $SkipMarket) {
  Write-Host "Räntor: hämtar marknadsräntor från Riksbanken"
  try { Build-Market } catch {
    # Riksbanken svarar inte: behåll gårdagens räntor från sajten, så att sidan inte saknar diagrammet
    Write-Host "  varning: Riksbanken svarade inte ($($_.Exception.Message)), använder gårdagens räntor"
    try { Invoke-WebRequest -Uri "https://www.fondinsyn.se/data/rates-market.json" -OutFile (Join-Path $OutDir "rates-market.json") -UseBasicParsing -TimeoutSec 60 }
    catch { Write-Host "  varning: inga marknadsräntor i dag" }
  }
}

# ---------------------------------------------------------------------------
# Fondernas räntepapper och fondandelar (kvartalsvis)

$BondRe = '\d{1,2}/\d{1,2}/\d{2,4}|\bFloat\b|FRN|%|(?<!\d)\d{6}(?!\d)|\d{4}-\d{2}-\d{2}|PERP'
$EquityBondRe = '\d{1,2}/\d{1,2}/\d{2,4}|\bFloat\b|\bFRN\b|%|fond\b'   # samma som $BondRe i build-data.ps1
# Ord som inte hör till emittentnamnet ("Svenska Handelsbanken AB FIX" -> "Svenska Handelsbanken AB")
$NoiseWords = @("FIX", "FIXED", "FC", "FRN", "FLOAT", "ADJ", "PRP", "SNP", "SP", "SR", "GREEN", "GRN", "MTN", "EMTN", "COVERED", "COV", "CB", "SUB", "T2", "AT1", "PERP", "BOND", "BONDS", "NOTE", "NOTES", "OBL", "DI", "BAC", "CP", "CERT", "CERTIFIKAT", "FÖRETAGSCERTIFIKAT", "VAR", "STEP", "ZERO", "SUST", "SLL", "HYB")
$LegalWords = @("AB", "PUBL", "ASA", "OYJ", "AS", "PLC", "LTD", "INC", "SA", "NV", "BV", "GMBH", "AG", "SPA", "CORP", "LIMITED", "AKTIEBOLAG", "THE", "HF", "AS")

# Emittentdelen av ett instrumentnamn: allt före första kupong-, datum- eller räntemarkering
function IssuerPart($nm) {
  $s = ([string]$nm).Trim()
  $s = [regex]::Replace($s, '(?i)[\s_/]+(\d|float\b|frn|perp|var\b|zero\b|step\b|\(|\[|//).*$', '')
  $s = [regex]::Replace($s, '(?<=[A-Za-zÅÄÖåäö])\d+[,\.]\d.*$', '')        # "INDUVÄRD3,557 260814"
  $s = [regex]::Replace($s, '(?<=[A-Za-zÅÄÖåäö])\d{6,}.*$', '')            # "CIBUS300318"
  $words = @($s -split '\s+' | Where-Object { $_ })
  while ($words.Count -gt 1 -and ($NoiseWords -contains $words[-1].ToUpperInvariant().Trim(".,"))) { $words = @($words[0..($words.Count - 2)]) }
  return (($words -join " ").Trim(" -_,.".ToCharArray()))
}
function KeyOf($s) {
  $k = " " + ((([string]$s).ToUpperInvariant() -replace '[^A-Z0-9ÅÄÖØÆÜÉ ]', ' ') -replace '\s+', ' ') + " "
  foreach ($w in $LegalWords + $NoiseWords) { $k = $k.Replace(" $w ", " ") }
  return ($k -replace '\s+', '')
}

# Förfallodag ur namnet: 05/12/28 (Bloomberg, MM/DD/YY), 2028-05-12, 280512 (YYMMDD) eller bara ett årtal
function ValidDate($s) { $d = [datetime]::MinValue; return [datetime]::TryParseExact($s, "yyyy-MM-dd", $Inv, [System.Globalization.DateTimeStyles]::None, [ref]$d) }
function MaturityOf($nm, $qEnd) {
  $r = MaturityRaw $nm
  if ($r -and $r -ne "perp" -and -not (ValidDate $r)) { return "" }
  return $r
}
function MaturityRaw($nm) {
  $s = [string]$nm
  if ($s -match '(?i)\bperp') { return "perp" }
  $m = [regex]::Match($s, '(?<!\d)(\d{2})/(\d{2})/(\d{2,4})(?!\d)')
  if ($m.Success) {
    $y = [int]$m.Groups[3].Value; if ($y -lt 100) { $y += 2000 }
    $mo = [int]$m.Groups[1].Value; $d = [int]$m.Groups[2].Value
    if ($mo -ge 1 -and $mo -le 12 -and $d -ge 1 -and $d -le 31) { return "{0:0000}-{1:00}-{2:00}" -f $y, $mo, $d }
  }
  $m = [regex]::Match($s, '(20\d{2})-(\d{2})-(\d{2})')
  if ($m.Success) { return $m.Value }
  foreach ($m in [regex]::Matches($s, '(?<![\d,\.])(\d{2})(\d{2})(\d{2})(?!\d)')) {
    $y = 2000 + [int]$m.Groups[1].Value; $mo = [int]$m.Groups[2].Value; $d = [int]$m.Groups[3].Value
    if ($y -ge 2015 -and $y -le 2060 -and $mo -ge 1 -and $mo -le 12 -and $d -ge 1 -and $d -le 31) { return "{0:0000}-{1:00}-{2:00}" -f $y, $mo, $d }
  }
  $m = [regex]::Match($s, '(?<!\d)(20[2-5]\d)(?!\d)')
  if ($m.Success) { return $m.Value + "-12-31" }
  return ""
}
# 1 = rörlig ränta, 0 = fast, null = okänt
function FloatOf($nm) {
  $s = [string]$nm
  if ($s -match '(?i)float|frn|stibor|euribor|nibor|cibor|\bvar\b|rörlig') { return 1 }
  if ($s -match '\d+\s+\d/\d+|\d+[,\.]\d+\s*%?|%|\bfix') { return 0 }
  return $null
}

# Läser ett kvartal: per fond räntepapper, fondandelar och likvida medel
function Read-Rates($id) {
  $zipPath = Join-Path $CacheDir "$id.zip"
  if (-not (Test-Path $zipPath)) { throw "Saknar $zipPath. Kör build-data.ps1 först." }
  Write-Host "  läser $id"
  $funds = @{}; $date = $null
  $zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path $zipPath).Path)
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
      $bonds = New-Object System.Collections.Generic.List[object]
      $units = New-Object System.Collections.Generic.List[object]
      $equity = 0.0
      foreach ($i in $fi.FinansiellaInstrument.FinansielltInstrument) {
        $cls = [string]$i.'Tillgångsslag_enligt_LVF_5_kap'
        $nm = (([string]$i.Instrumentnamn) -replace '\s+', ' ').Trim()
        $isin = ([string]$i.'ISIN-kod_instrument').Trim()
        $mv = Num $i.'Marknadsvärde_instrument'
        if ($null -eq $mv) { continue }
        if ($cls -eq 'Fondandel') {
          $units.Add(@{ isin = $isin; name = $nm; n = (Num $i.Antal); mv = $mv })
          continue
        }
        # Aktier räknas som i build-data.ps1, för fondens aktieandel
        if ($cls -eq 'ÖverlåtbartVärdepapper' -and $isin.Length -eq 12 -and (Num $i.Antal) -gt 0 -and -not (Num $i.Nominellt_belopp) -and $nm -notmatch $EquityBondRe) { $equity += $mv }
        if ($cls -ne 'ÖverlåtbartVärdepapper' -and $cls -ne 'Penningmarknadsinstrument') { continue }
        $nom = Num $i.Nominellt_belopp
        if ($cls -eq 'ÖverlåtbartVärdepapper' -and -not $nom -and $nm -notmatch $BondRe) { continue }
        if (-not $nom) { $nom = Num $i.Antal }
        if (-not $isin -or $isin.Length -ne 12) { $isin = "X:" + $nm }
        $bc = ""
        $bn = $i.SelectSingleNode("*[local-name()='Bransch']")
        if ($bn) { $bc = ($bn.InnerText -replace '\D', '') }
        $bonds.Add(@{ isin = $isin; name = $nm; nom = $nom; mv = $mv; country = [string]$i.Landkod_Emittent; cur = [string]$i.Valuta; bransch = $bc; mm = ($cls -eq 'Penningmarknadsinstrument') })
      }
      $funds[[string]$fi.Fond_institutnummer] = @{
        name = ([string]$fi.Fond_namn).Trim(); isin = ([string]$fi.'Fond_ISIN-kod').Trim()
        aum = Num $fi.'Fondförmögenhet'; cash = Num $fi.Likvida_medel
        bonds = $bonds; units = $units; equity = $equity
      }
    }
  } finally { $zip.Dispose() }
  return @{ id = $id; date = $date; funds = $funds }
}

# Kategori per obligation. Säkerställda obligationer (bostadsobligationer) känns igen på namnet, så att en bank som
# både ger ut säkerställt och vanligt hamnar rätt per papper.
$CoveredRe = '(?i)hypotek|hyp\b|covered|säkerställ|sakerstall|s[äa]k\s*obl|boligkred|realkredit|mortgage|bolån|\bscbc\b|sveriges s[äa]kerst|\bcb\b|\bcov\b|bostadsobl|kiinnitys|asuntoluotto|pfandbrief|\bshbass\b|\bsweda\b|\bndafh\b|lanhyp|landshyp'
$StateRe = '(?i)^(sgb|sgbi|swtb|sverige|sweden|svenska staten|statens?\b|kingdom of sweden|swedish gov|sweden gov|statsobl|statsskuld|realränteobl|riksgälden|swedish government)'
$MunicipalRe = '(?i)kommun|komins|kommuninvest|\bstad\b|city of|municipality|region |regionen|landsting|kommunalbank|\bkbn\b|kunta|kuntarahoitus|\bmunifin'
$SupraRe = '(?i)^(ifc|eib|ebrd|nib|ibrd|adb|aiib|coe|kfw|bng|nwb|world bank|international finance|european investment|nordic investment|asian development|council of europe|european union|inter-american|asia|afdb|african development|international bank for|kreditanstalt|landwirtschaftliche|rentenbank|t|ust|dbr|bund|ngb|dgb|frtr|btps|ukt|bko|rfgb|spgb|rago|bgb|united states treas|us treasury)\b|kingdom of (norway|denmark|the netherlands|spain|belgium)|republic of|government of|bundesrepublik|federal republic|norwegian government|danish government'
$BankRe = '(?i)bank|sparbank|sparebank|\bspb\b|\bseb\b|nordea|handelsbanken|swedbank|danske|\bdnb\b|klarna|hoist|noba|resurs|collector|avanza|nordnet|svensk exportkredit|kreditinstitut|ikano|marginalen|santander|ziklo|volvofinans|ecster|landshypotek|länsförsäkringar|lansfors|skandia'
$Cats = @("stat", "kommun", "bostad", "bank", "fastighet", "foretag", "utland")
function CatOf($names, $bransch, $country) {
  $all = ($names -join " | ")
  if ($all -match $CoveredRe) { return "bostad" }
  foreach ($n in $names) { if ($n -match $StateRe) { return "stat" } }
  if ($all -match $MunicipalRe) { return "kommun" }
  foreach ($n in $names) { if ($n -match $SupraRe) { return "utland" } }
  if ($bransch -eq "60") { return "fastighet" }
  if ($all -match '(?i)fastighet|property|properties|real estate|bostad\b|bostäder|vasakronan|heimstaden|castellum|balder|fabege|wihlborgs|hufvudstaden|atrium|rikshem|willhem|hemsö|hemso|humlegård|humlegard|akademiska hus|specialfastigheter|jernhusen|intea|sagax|catena|platzer|nyfosa|samhällsbyggnad|\bsbb\b|corem|klövern|stenhus|wallenstam|kungsleden|vonovia') { return "fastighet" }
  if ($all -match $BankRe) { return "bank" }
  return "foretag"
}
$Gics = @{ "10" = "Energi"; "15" = "Material"; "20" = "Industri"; "25" = "Sällanköpsvaror"; "30" = "Dagligvaror"; "35" = "Hälsovård"; "40" = "Finans"; "45" = "IT"; "50" = "Kommunikationstjänster"; "55" = "Kraftförsörjning"; "60" = "Fastigheter" }

# Snyggare visningsnamn för de största emittenterna. Nyckeln är en emittentnyckel (KeyOf) som ingår i gruppen.
$IssuerNames = [ordered]@{
  "SVENSKASTATEN" = "Svenska staten"; "SGB" = "Svenska staten"; "KINGDOMOFSWEDEN" = "Svenska staten"
  "KOMMUNINVEST" = "Kommuninvest"; "KOMINS" = "Kommuninvest"
  "STADSHYPOTEK" = "Handelsbanken och Stadshypotek"; "SVENSKAHANDELSBANKEN" = "Handelsbanken och Stadshypotek"
  "SWEDBANKHYPOTEK" = "Swedbank och Swedbank Hypotek"; "SWEDBANK" = "Swedbank och Swedbank Hypotek"
  "NORDEAHYPOTEK" = "Nordea och Nordea Hypotek"; "NORDEABANK" = "Nordea och Nordea Hypotek"
  "SBAB" = "SBAB och SCBC"; "SCBC" = "SBAB och SCBC"
  "SKANDINAVISKAENSKILDABANKEN" = "SEB"; "SEB" = "SEB"
  "LANSFORSAKRINGARHYPOTEK" = "Länsförsäkringar Bank och Hypotek"; "LÄNSFÖRSÄKRINGARHYPOTEK" = "Länsförsäkringar Bank och Hypotek"; "LFBANK" = "Länsförsäkringar Bank och Hypotek"
  "DANSKEBANK" = "Danske Bank"; "DNBBANK" = "DNB"; "LANDSHYPOTEKBANK" = "Landshypotek Bank"
  "INTERNATIONALFINANCECORP" = "International Finance Corporation"; "IFC" = "International Finance Corporation"
  "NORDICINVESTMENTBANK" = "Nordiska investeringsbanken"; "NIB" = "Nordiska investeringsbanken"
  "EUROPEANINVESTMENTBANK" = "Europeiska investeringsbanken"; "EIB" = "Europeiska investeringsbanken"
  "EBRD" = "Europeiska banken för återuppbyggnad och utveckling"; "ASIANDEVELOPMENTBANK" = "Asiatiska utvecklingsbanken"
  "SVENSKEXPORTKREDIT" = "Svensk Exportkredit"; "KOMMUNALBANKEN" = "Kommunalbanken (Norge)"; "KUNTA" = "Kuntarahoitus (Finland)"
  "ASIA" = "Asiatiska utvecklingsbanken"; "AFDB" = "Afrikanska utvecklingsbanken"; "AFRICANDEVELOPMENTBANK" = "Afrikanska utvecklingsbanken"
  "IBRD" = "Världsbanken"; "INTERNATIONALBANKFORRECONSTRUCTIONDEVELOPMENT" = "Världsbanken"; "KFW" = "KfW"; "SPAREBANK" = "Norska sparbanker"
  "VOLVOTREASURY" = "Volvo"; "REGIONSTOCKHOLM" = "Region Stockholm"; "CITYOFGOTHENBURG" = "Göteborgs stad"; "CITYOFSTOCKHOLM" = "Stockholms stad"
}

function Slug($s) {
  $t = ([string]$s).ToLowerInvariant().Replace("å", "a").Replace("ä", "a").Replace("ö", "o").Replace("ø", "o").Replace("æ", "ae").Replace("é", "e").Replace("ü", "u")
  return (($t -replace '[^a-z0-9]+', '-').Trim('-'))
}
$SwedishPlaces = @{
  "Malmo" = "Malmö"; "Goteborg" = "Göteborg"; "Gothenburg" = "Göteborg"; "Norrkoping" = "Norrköping"; "Linkoping" = "Linköping"; "Jonkoping" = "Jönköping"
  "Orebro" = "Örebro"; "Vasteras" = "Västerås"; "Umea" = "Umeå"; "Lulea" = "Luleå"; "Gavle" = "Gävle"; "Boras" = "Borås"; "Vaxjo" = "Växjö"
  "Ostersund" = "Östersund"; "Skelleftea" = "Skellefteå"; "Sodertalje" = "Södertälje"; "Taby" = "Täby"; "Lidingo" = "Lidingö"; "Jarfalla" = "Järfälla"
  "Varmdo" = "Värmdö"; "Hassleholm" = "Hässleholm"; "Angelholm" = "Ängelholm"; "Molndal" = "Mölndal"; "Ornskoldsvik" = "Örnsköldsvik"
  "Skane" = "Skåne"; "Vastra Gotaland" = "Västra Götaland"; "Ostergotland" = "Östergötland"; "Varmland" = "Värmland"; "Vasterbotten" = "Västerbotten"
  "Jamtland" = "Jämtland"; "Harjedalen" = "Härjedalen"; "Sormland" = "Sörmland"; "Vastmanland" = "Västmanland"; "Gavleborg" = "Gävleborg"; "Vasternorrland" = "Västernorrland"
  "Trollhattan" = "Trollhättan"; "Nykoping" = "Nyköping"; "Borlange" = "Borlänge"; "Tyreso" = "Tyresö"; "Osteraker" = "Österåker"; "Ekero" = "Ekerö"
  "Nynashamn" = "Nynäshamn"; "Norrtalje" = "Norrtälje"; "Enkoping" = "Enköping"; "Pitea" = "Piteå"; "Varnamo" = "Värnamo"; "Soderhamn" = "Söderhamn"
  "Harnosand" = "Härnösand"; "Kungalv" = "Kungälv"; "Skovde" = "Skövde"; "Lidkoping" = "Lidköping"; "Koping" = "Köping"; "Strangnas" = "Strängnäs"
  "Vastervik" = "Västervik"; "Nassjo" = "Nässjö"; "Eslov" = "Eslöv"; "Kavlinge" = "Kävlinge"; "Hoganas" = "Höganäs"; "Alingsas" = "Alingsås"; "Solvesborg" = "Sölvesborg"
}
# Svenska kommuner som emittenter. Kommunerna med "stad" i sitt officiella namn; övriga heter "<ort>s kommun".
$CityMunicipalities = @("Stockholm", "Göteborg", "Malmö", "Helsingborg", "Västerås", "Borås", "Lidingö", "Solna", "Sundbyberg", "Vaxholm", "Mölndal", "Trollhättan", "Landskrona", "Haparanda")
$KnownPlaces = @{}
foreach ($pl in @($SwedishPlaces.Values) + $CityMunicipalities + @("Lund", "Uppsala", "Huddinge", "Nacka", "Trelleborg", "Sundsvall", "Halmstad", "Kalmar", "Karlstad",
    "Kristianstad", "Eskilstuna", "Falun", "Sollentuna", "Botkyrka", "Haninge", "Kungsbacka", "Varberg", "Uddevalla", "Karlskrona", "Kiruna", "Motala", "Katrineholm",
    "Sigtuna", "Danderyd", "Vallentuna", "Hudiksvall", "Sandviken", "Ystad", "Vellinge", "Lerum", "Partille", "Falkenberg", "Mora", "Ludvika", "Avesta", "Arboga",
    "Oskarshamn", "Ljungby", "Staffanstorp", "Lomma", "Svedala", "Karlshamn", "Ronneby", "Gotland", "Kristinehamn", "Nyköping", "Gävle")) { $KnownPlaces[$pl] = $pl }
function MunicipalName($place) {
  $gen = if ($place -match '[sxzaeiouyåäöé]$') { $place } else { $place + "s" }
  return $gen + $(if ($CityMunicipalities -contains $place) { " stad" } else { " kommun" })
}
# "Stockholm", "Stockholms" eller "Linkopings" blir orten med å, ä och ö, om den är en känd svensk kommun
function SwedishPlace($w) {
  foreach ($cand in @($w, $(if ($w.EndsWith("s")) { $w.Substring(0, $w.Length - 1) } else { $null }))) {
    if (-not $cand) { continue }
    $fixed = if ($SwedishPlaces.ContainsKey($cand)) { $SwedishPlaces[$cand] } else { $cand }
    if ($KnownPlaces.ContainsKey($fixed)) { return $KnownPlaces[$fixed] }
  }
  return $null
}
function PrettyIssuer($s) {
  $s = ([string]$s).Trim()
  # "City of Malmo Sweden" blir "Malmö stad" och "Municipality of Huddinge Sweden" blir "Huddinge kommun"
  $m = [regex]::Match($s, '(?i)^(city|municipality|county|region) of ([A-Za-zÅÄÖåäö\- ]+?)(,? sweden)?$')
  if ($m.Success) {
    $place = (Get-Culture).TextInfo.ToTitleCase($m.Groups[2].Value.ToLowerInvariant())
    # Engelska namn saknar ofta å, ä och ö ("City of Malmo")
    foreach ($pl in $SwedishPlaces.Keys) { $place = [regex]::Replace($place, "\b$pl\b", $SwedishPlaces[$pl]) }
    if ($m.Groups[1].Value -match '(?i)county|region') { return "Region $place" }
    $sw = SwedishPlace $place
    if ($sw) { return MunicipalName $sw }
    if ($m.Groups[3].Success) { return "$place " + $(if ($m.Groups[1].Value -match '(?i)city') { "stad" } else { "kommun" }) }
    return "City of $place"
  }
  # Svenska namn i olika former ("Lunds stad", "Göteborgs kommun", "Stockholm stad") blir kommunens officiella namn
  $m = [regex]::Match($s, '(?i)^([A-Za-zÅÄÖåäö\-]+) (stad|kommun)$')
  if ($m.Success) {
    $w = (Get-Culture).TextInfo.ToTitleCase($m.Groups[1].Value.ToLowerInvariant())
    $sw = SwedishPlace $w
    if ($sw) { return MunicipalName $sw }
  }
  $s = [regex]::Replace($s, '(?i),?\s+sweden$', '')
  # Ett ensamt kortnamn i versaler ("PFSI") behålls som det är i stället för att bli ett påhittat ord ("Pfsi")
  if ($s -cmatch '^[A-Z0-9&]{2,8}$') { return $s }
  if ($s -cne $s.ToUpperInvariant()) { return $s }
  $words = foreach ($w in ($s -split '\s+')) {
    if ($w.Length -le 3 -and $w -notmatch '^(BANK|CITY)$') { $w } else { $w.Substring(0, 1) + $w.Substring(1).ToLowerInvariant() }
  }
  return ($words -join " ")
}

# Grupperar obligationerna i två kvartal till emittenter
function Build-Issuers($P, $C) {
  $byIsin = @{}
  foreach ($Q in @($P, $C)) {
    foreach ($f in $Q.funds.Values) {
      foreach ($b in $f.bonds) {
        if (-not $byIsin.ContainsKey($b.isin)) { $byIsin[$b.isin] = @{ names = @{}; mv = 0.0; bransch = @{}; country = @{} } }
        $e = $byIsin[$b.isin]
        $e.names[$b.name] = [double]$e.names[$b.name] + [math]::Abs($b.mv) + 1
        $e.mv += [math]::Abs($b.mv)
        if ($b.bransch) { $e.bransch[$b.bransch] = 1 + [int]$e.bransch[$b.bransch] }
        if ($b.country) { $e.country[$b.country] = 1 + [int]$e.country[$b.country] }
      }
    }
  }
  # Nycklar per ISIN och hur ofta nycklarna förekommer
  $keyIsins = @{}; $pair = @{}; $keyNames = @{}
  foreach ($isin in $byIsin.Keys) {
    $e = $byIsin[$isin]
    $keys = New-Object System.Collections.Generic.List[string]
    $kw = @{}
    foreach ($nm in $e.names.Keys) {
      $ip = IssuerPart $nm
      $k = KeyOf $ip
      if ($k.Length -lt 3) { continue }
      if (-not $keys.Contains($k)) { $keys.Add($k) }
      $kw[$k] = [double]$kw[$k] + $e.names[$nm]
      if (-not $keyNames.ContainsKey($k)) { $keyNames[$k] = @{} }
      $keyNames[$k][$ip] = [double]$keyNames[$k][$ip] + $e.names[$nm]
    }
    $e.keys = $keys
    $e.kw = $kw
    foreach ($k in $keys) { $keyIsins[$k] = 1 + [int]$keyIsins[$k] }
    for ($a = 0; $a -lt $keys.Count; $a++) { for ($b = $a + 1; $b -lt $keys.Count; $b++) {
      $pk = if ($keys[$a] -lt $keys[$b]) { $keys[$a] + "|" + $keys[$b] } else { $keys[$b] + "|" + $keys[$a] }
      $pair[$pk] = 1 + [int]$pair[$pk]
    } }
  }
  $parent = @{}
  foreach ($k in $keyIsins.Keys) { $parent[$k] = $k }
  function Find($k) { while ($parent[$k] -ne $k) { $parent[$k] = $parent[$parent[$k]]; $k = $parent[$k] }; return $k }
  function Join-Keys($a, $b) { $ra = Find $a; $rb = Find $b; if ($ra -ne $rb) { $parent[$rb] = $ra } }
  # Två namn hör till samma emittent om minst två obligationer och minst en fjärdedel av det mindre namnets obligationer
  # binder ihop dem. Ett namn som bara förekommer på en obligation (ett alias) knyts till obligationens dominerande namn.
  # En enstaka felmärkning hos en fond slår alltså inte ihop två bolag.
  foreach ($pk in $pair.Keys) {
    $ab = $pk.Split("|")
    $minIsins = [math]::Min($keyIsins[$ab[0]], $keyIsins[$ab[1]])
    if ($minIsins -gt 1 -and $pair[$pk] -ge 2 -and $pair[$pk] / $minIsins -ge 0.25) { Join-Keys $ab[0] $ab[1] }
  }
  foreach ($isin in $byIsin.Keys) {
    $e = $byIsin[$isin]
    if ($e.keys.Count -lt 2) { continue }
    $dom = $null; $best = -1.0
    foreach ($k in $e.keys) { $w = $e.kw[$k] + $(if ($keyIsins[$k] -gt 1) { 1e15 } else { 0 }); if ($w -gt $best) { $best = $w; $dom = $k } }
    foreach ($k in $e.keys) { if ($k -ne $dom -and $keyIsins[$k] -eq 1) { Join-Keys $dom $k } }
  }
  if ($env:RATES_DEBUG) {
    foreach ($pk in $pair.Keys) { if ($pk -match $env:RATES_DEBUG) { $ab = $pk.Split("|"); Write-Host ("  par {0}: {1} gemensamma, {2}/{3} obligationer, samma grupp: {4}" -f $pk, $pair[$pk], $keyIsins[$ab[0]], $keyIsins[$ab[1]], ((Find $ab[0]) -eq (Find $ab[1]))) } }
  }
  # Varje ISIN till den grupp där dess vanligaste namn hör hemma
  $groups = @{}
  foreach ($isin in $byIsin.Keys) {
    $e = $byIsin[$isin]
    if (-not $e.keys.Count) { $e.group = "OKAND"; continue }
    $best = ($e.names.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1).Key
    $bk = KeyOf (IssuerPart $best)
    if (-not $keyIsins.ContainsKey($bk)) { $bk = $e.keys[0] }
    $g = Find $bk
    $e.group = $g
    if (-not $groups.ContainsKey($g)) { $groups[$g] = @{ keys = @{}; isins = New-Object System.Collections.Generic.List[string]; mv = 0.0; bransch = @{}; country = @{} } }
    $gr = $groups[$g]
    $gr.isins.Add($isin); $gr.mv += $e.mv
    foreach ($k in $e.keys) { if ((Find $k) -eq $g) { $gr.keys[$k] = 1 } }
    foreach ($bc in $e.bransch.Keys) { $gr.bransch[$bc] = [int]$gr.bransch[$bc] + $e.bransch[$bc] }
    foreach ($ct in $e.country.Keys) { $gr.country[$ct] = [int]$gr.country[$ct] + $e.country[$ct] }
  }
  # Namn, kategori och sektor per grupp
  $issuers = @{}; $usedSlugs = @{}; $byName = @{}
  foreach ($g in ($groups.Keys | Sort-Object { -$groups[$_].mv })) {
    $gr = $groups[$g]
    $name = $null
    foreach ($k in $IssuerNames.Keys) { if ($gr.keys.ContainsKey($k)) { $name = $IssuerNames[$k]; break } }
    if (-not $name) {
      # Det namn med mest kapital, och helst ett skrivet med gemener ("Fabege AB" före "FABGSS")
      $cands = @{}
      foreach ($k in $gr.keys.Keys) { foreach ($n in $keyNames[$k].Keys) { $cands[$n] = [double]$cands[$n] + $keyNames[$k][$n] } }
      $name = ($cands.GetEnumerator() | Sort-Object { $(if ($_.Key -cmatch '[a-zåäö]' -and $_.Key.Length -ge 4) { 1e18 } else { 0 }) + $_.Value } -Descending | Select-Object -First 1).Key
      $name = PrettyIssuer $name
    }
    $grNames = @($gr.keys.Keys | ForEach-Object { $keyNames[$_].Keys })
    # Grupper som fått samma namn (t.ex. "ASIA" och "Asian Development Bank" som inte binds ihop av gemensamma
    # obligationer) är samma emittent och får samma sida
    if ($name -and $byName.ContainsKey($name)) { $issuers[$g] = $byName[$name]; $byName[$name].names = @($byName[$name].names) + $grNames; continue }
    $bc = ($gr.bransch.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1).Key
    $ct = ($gr.country.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1).Key
    $slug = Slug $name
    if (-not $slug) { $slug = "emittent" }
    if ($usedSlugs.ContainsKey($slug)) { $n2 = 2; while ($usedSlugs.ContainsKey("$slug-$n2")) { $n2++ }; $slug = "$slug-$n2" }
    $usedSlugs[$slug] = 1
    $issuers[$g] = @{ key = $slug; name = $name; bransch = $bc; country = $ct; names = $grNames }
    if ($name) { $byName[$name] = $issuers[$g] }
  }
  # Kategori per obligation (alla namnvarianter, plus emittentens namn)
  foreach ($isin in $byIsin.Keys) {
    $e = $byIsin[$isin]
    if ($e.group -eq "OKAND") { $e.cat = "foretag"; $e.issuer = $null; continue }
    $iss = $issuers[$e.group]
    $bc = ($e.bransch.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1).Key
    if (-not $bc) { $bc = $iss.bransch }
    $e.cat = CatOf (@($e.names.Keys) + @($iss.name)) $bc $iss.country
    $e.issuer = $iss
  }
  return @{ byIsin = $byIsin; issuers = $issuers }
}

function YearsTo($mat, $qEnd) {
  if (-not $mat -or $mat -eq "perp") { return $null }
  $d = [datetime]::ParseExact($mat, "yyyy-MM-dd", $Inv)
  return ($d - $qEnd).TotalDays / 365.25
}
$Buckets = @("0-1", "1-3", "3-5", "5-10", "10+")
function BucketOf($y) { if ($null -eq $y) { return $null }; if ($y -lt 1) { return 0 }; if ($y -lt 3) { return 1 }; if ($y -lt 5) { return 2 }; if ($y -lt 10) { return 3 }; return 4 }

function Build-RatesPair($prevId, $currId, $srcPrev, $srcCurr) {
  Write-Host "Räntor: bygger $currId (jämfört med $prevId)"
  $P = Read-Rates $prevId
  $C = Read-Rates $currId
  $qEnd = [datetime]::ParseExact($C.date, "yyyy-MM-dd", $Inv)
  $I = Build-Issuers $P $C
  $byIsin = $I.byIsin

  # Fondandelar: koppla fondens ISIN (eller namn) till en fond hos FI
  $fundByIsin = @{}; $fundByName = @{}
  foreach ($Q in @($P, $C)) { foreach ($id in $Q.funds.Keys) {
    $f = $Q.funds[$id]
    if ($f.isin) { $fundByIsin[$f.isin] = $id }
    $fundByName[(KeyOf ($f.name -replace '\(.*?\)', ''))] = $id
  } }

  $issAgg = @{}; $catAgg = @{}; $matAgg = @(0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
  $tot = @{ prev = 0.0; curr = 0.0; flow = 0.0; matured = 0.0 }
  foreach ($ct in $Cats) { $catAgg[$ct] = @(0.0, 0.0, 0.0) }
  $fundRows = New-Object System.Collections.Generic.List[string]
  $heavy = New-Object System.Collections.Generic.List[string]
  $ids = New-Object System.Collections.Generic.HashSet[string]
  foreach ($id in $P.funds.Keys) { [void]$ids.Add($id) }
  foreach ($id in $C.funds.Keys) { [void]$ids.Add($id) }

  foreach ($id in ($ids | Sort-Object)) {
    $fp = $P.funds[$id]; $fc = $C.funds[$id]
    $both = $fp -and $fc
    # Räntepapper per ISIN: nominellt belopp och värde förra och detta kvartal
    $h = @{}
    foreach ($pair in @(@($fp, 0), @($fc, 1))) {
      $f = $pair[0]; $w = $pair[1]
      if (-not $f) { continue }
      foreach ($b in $f.bonds) {
        if (-not $h.ContainsKey($b.isin)) { $h[$b.isin] = @{ n = @(0.0, 0.0); v = @(0.0, 0.0); name = $b.name; cur = $b.cur; mm = $b.mm } }
        $x = $h[$b.isin]
        $x.n[$w] += [double]$b.nom; $x.v[$w] += [double]$b.mv
        if ($w -eq 1) { $x.name = $b.name }
      }
    }
    $bondV = 0.0; $floatV = 0.0; $fixedV = 0.0; $yearsW = 0.0; $yearsV = 0.0; $fundFlow = 0.0
    $fCat = @{}; foreach ($ct in $Cats) { $fCat[$ct] = 0.0 }
    $rows = New-Object System.Collections.Generic.List[string]
    foreach ($isin in $h.Keys) {
      $x = $h[$isin]; $e = $byIsin[$isin]
      $iss = $e.issuer
      $mat = MaturityOf $x.name $qEnd
      if (-not $mat) { foreach ($nm in $e.names.Keys) { $mat = MaturityOf $nm $qEnd; if ($mat) { break } } }
      $fl = FloatOf $x.name
      if ($null -eq $fl) { foreach ($nm in $e.names.Keys) { $fl = FloatOf $nm; if ($null -ne $fl) { break } } }
      $yrs = YearsTo $mat $qEnd
      $v1 = $x.v[0]; $v2 = $x.v[1]; $n1 = $x.n[0]; $n2 = $x.n[1]
      # Flöde = förändrat nominellt belopp gånger värdet per nominell krona. Papper som förfallit räknas inte som sålda.
      $flow = 0.0; $matured = 0.0
      if ($both) {
        $unit = if ($n2 -gt 0) { $v2 / $n2 } elseif ($n1 -gt 0) { $v1 / $n1 } else { 0 }
        $flow = ($n2 - $n1) * $unit
        # Olika enheter för det nominella beloppet mellan kvartalen (t.ex. 100 gånger för stort ena kvartalet): räkna på värdet
        if ($n1 -gt 0 -and $n2 -gt 0 -and $v1 -gt 0 -and $v2 -gt 0) { $ratio = ($v2 / $n2) / ($v1 / $n1); if ($ratio -gt 2 -or $ratio -lt 0.5) { $flow = $v2 - $v1 } }
        if ($n2 -le 0 -and $n1 -gt 0 -and $mat -and $mat -ne "perp" -and $mat -le $C.date) { $matured = $v1; $flow = 0.0 }
      }
      if ($fc) {
        $bondV += $v2
        if ($fl -eq 1) { $floatV += $v2 } elseif ($fl -eq 0) { $fixedV += $v2 }
        if ($null -ne $yrs -and $yrs -ge 0) { $yearsW += $yrs * $v2; $yearsV += $v2 }
        $fCat[$e.cat] += $v2
        $bk = BucketOf $yrs; if ($null -eq $bk) { $bk = 5 }; $matAgg[$bk] += $v2
      }
      $fundFlow += $flow
      $catAgg[$e.cat][0] += $v1; $catAgg[$e.cat][1] += $v2; $catAgg[$e.cat][2] += $flow
      $tot.prev += $v1; $tot.curr += $v2; $tot.flow += $flow; $tot.matured += $matured
      if ($iss) {
        $k = $iss.key
        if (-not $issAgg.ContainsKey($k)) { $issAgg[$k] = @{ iss = $iss; v1 = 0.0; v2 = 0.0; flow = 0.0; mat = 0.0; f1 = @{}; f2 = @{}; isins = @{}; cat = @{} } }
        $a = $issAgg[$k]
        $a.v1 += $v1; $a.v2 += $v2; $a.flow += $flow; $a.mat += $matured
        if ($v1 -gt 0) { $a.f1[$id] = 1 }; if ($v2 -gt 0) { $a.f2[$id] = 1; $a.isins[$isin] = 1 }
        $a.cat[$e.cat] = [double]$a.cat[$e.cat] + $v2 + $v1
      }
      $rows.Add("[" + (J $isin) + "," + (J $x.name) + "," + (J $(if ($iss) { $iss.key } else { $null })) + "," + (J $e.cat) + "," + (J $mat) + "," +
        $(if ($null -eq $fl) { "null" } else { $fl }) + "," + (Whole $n1) + "," + (Whole $n2) + "," + (Whole $v1) + "," + (Whole $v2) + "," + $(if ($matured) { "1" } else { "0" }) + "," + $(if ($both) { Whole $flow } else { "null" }) + "]")
    }
    # Fondandelar
    $u = @{}
    foreach ($pair in @(@($fp, 0), @($fc, 1))) {
      $f = $pair[0]; $w = $pair[1]
      if (-not $f) { continue }
      foreach ($x in $f.units) {
        $k = if ($x.isin) { $x.isin } else { "X:" + $x.name }
        if (-not $u.ContainsKey($k)) { $u[$k] = @{ name = $x.name; n = @(0.0, 0.0); v = @(0.0, 0.0) } }
        $u[$k].n[$w] += [double]$x.n; $u[$k].v[$w] += [double]$x.mv
        if ($w -eq 1) { $u[$k].name = $x.name }
      }
    }
    $unitV = 0.0; $unitFlow = 0.0
    $urows = New-Object System.Collections.Generic.List[string]
    foreach ($k in $u.Keys) {
      $x = $u[$k]
      $target = $null
      if ($fundByIsin.ContainsKey($k)) { $target = $fundByIsin[$k] }
      else { $nk = KeyOf ($x.name -replace '\(.*?\)', ''); if ($fundByName.ContainsKey($nk)) { $target = $fundByName[$nk] } }
      if ($target -eq $id) { $target = $null }
      $flow = 0.0
      if ($both) {
        $unit = if ($x.n[1] -gt 0) { $x.v[1] / $x.n[1] } elseif ($x.n[0] -gt 0) { $x.v[0] / $x.n[0] } else { 0 }
        $flow = ($x.n[1] - $x.n[0]) * $unit
        if ($x.n[0] -gt 0 -and $x.n[1] -gt 0 -and $x.v[0] -gt 0 -and $x.v[1] -gt 0) { $ratio = ($x.v[1] / $x.n[1]) / ($x.v[0] / $x.n[0]); if ($ratio -gt 2 -or $ratio -lt 0.5) { $flow = $x.v[1] - $x.v[0] } }
      }
      if ($fc) { $unitV += $x.v[1] }
      $unitFlow += $flow
      $urows.Add("[" + (J $k) + "," + (J $x.name) + "," + (J $target) + "," + (Whole $x.v[0]) + "," + (Whole $x.v[1]) + "," + $(if ($both) { Whole $flow } else { "null" }) + "]")
    }
    if ($fc) {
      $catVals = ($Cats | ForEach-Object { Whole $fCat[$_] }) -join ","
      $avgY = if ($yearsV -gt 0) { N ($yearsW / $yearsV) "0.##" } else { "null" }
      $floatShare = if (($floatV + $fixedV) -gt 0) { N ($floatV / ($floatV + $fixedV)) "0.###" } else { "null" }
      $fundRows.Add("[" + (J $id) + "," + (Whole $bondV) + "," + (Whole $unitV) + "," + (Whole $fc.cash) + "," + $floatShare + "," + $avgY + ",[" + $catVals + "]," +
        $h.Count + "," + $(if ($both) { Whole $fundFlow } else { "null" }) + "," + $(if ($both) { Whole $unitFlow } else { "null" }) + "," +
        $(if ($fc.aum -gt 0) { N ([math]::Min([double]1, [double]$fc.equity / $fc.aum)) "0.###" } else { "null" }) + "]")
    }
    if (-not $rows.Count -and -not $urows.Count) { continue }
    $heavy.Add((J $id) + ':{"b":[' + ($rows -join ",") + '],"u":[' + ($urows -join ",") + "]}")
  }

  $issRows = foreach ($k in ($issAgg.Keys | Sort-Object { -$issAgg[$_].v2 })) {
    $a = $issAgg[$k]
    if ($a.v1 -le 0 -and $a.v2 -le 0) { continue }
    $cat = ($a.cat.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1).Key
    $sector = if ($cat -in @("foretag", "fastighet") -and $a.iss.bransch -and $Gics.ContainsKey($a.iss.bransch)) { $Gics[$a.iss.bransch] } else { $null }
    "[" + (J $k) + "," + (J $a.iss.name) + "," + (J $cat) + "," + (J $sector) + "," + (J $a.iss.country) + "," + (Whole $a.v1) + "," + (Whole $a.v2) + "," + (Whole $a.flow) + "," + (Whole $a.mat) + "," +
      $a.f1.Count + "," + $a.f2.Count + "," + $a.isins.Count + "]"
  }
  $catRows = ($Cats | ForEach-Object { "[" + (J $_) + "," + (Whole $catAgg[$_][0]) + "," + (Whole $catAgg[$_][1]) + "," + (Whole $catAgg[$_][2]) + "]" }) -join ","
  $meta = '{"v":' + $FormatVersion + ',"id":' + (J $currId) + ',"prevId":' + (J $prevId) + ',"prev":' + (J $P.date) + ',"curr":' + (J $C.date) +
    ',"built":' + (J (Get-Date -Format "yyyy-MM-dd")) + ',"src":[' + (J $srcPrev) + "," + (J $srcCurr) + "]}"
  $light = '{"meta":' + $meta + ',"totals":[' + (Whole $tot.prev) + "," + (Whole $tot.curr) + "," + (Whole $tot.flow) + "," + (Whole $tot.matured) + ']' +
    ',"cats":[' + $catRows + '],"maturity":[' + (($matAgg | ForEach-Object { Whole $_ }) -join ",") + ']' +
    ',"issuers":[' + (@($issRows) -join ",") + '],"funds":[' + ($fundRows -join ",") + "]}"
  Write-Utf8 (Join-Path $OutDir "$currId-rates.json") $light
  # En fond per rad, så att build-pages.ps1 kan dela upp filen utan att göra om den till JSON
  Write-Utf8 (Join-Path $OutDir "$currId-rates-funds.json") ('{"meta":' + $meta + ',"funds":{' + "`n" + ($heavy -join ",`n") + "`n}}")
  Write-Host ("  {0} emittenter, räntepapper {1:N0} mdkr, nettoflöde {2:N1} mdkr, förfallet {3:N1} mdkr" -f @($issRows).Count, ($tot.curr / 1e9), ($tot.flow / 1e9), ($tot.matured / 1e9))
}

# FI:s zip-fil för ett kvartal, från cachen eller nedladdad (samma cache och format som build-data.ps1)
function Get-FiZip($id, $file) {
  New-Item -ItemType Directory -Force $CacheDir | Out-Null
  $path = Join-Path $CacheDir "$id.zip"
  $stamp = "$path.src"
  if ((Test-Path $path) -and (Test-Path $stamp) -and ((Get-Content $stamp -Raw).Trim() -eq $file)) { return }
  if ((Test-Path $path) -and -not (Test-Path $stamp)) { return }
  Write-Host "  laddar ner $file"
  Invoke-WebRequest -Uri ("https://www.fi.se/FondInnehavLista/download?filnamn=" + [uri]::EscapeDataString($file)) -OutFile $path -UseBasicParsing
  Set-Content -Path $stamp -Value $file
}

# Vilka kvartal: samma som build-data.ps1 har byggt (index.json)
$indexFile = Join-Path $OutDir "index.json"
if (-not (Test-Path $indexFile)) { throw "Saknar $indexFile. Kör build-data.ps1 först." }
$index = [System.IO.File]::ReadAllText($indexFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$built = 0
foreach ($q in @($index.quarters | Select-Object -First $History)) {
  $out = Join-Path $OutDir "$($q.id)-rates.json"
  $src = @($q.src)
  if (-not $Force -and (Test-Path $out) -and (Test-Path (Join-Path $OutDir "$($q.id)-rates-funds.json"))) {
    $head = [System.IO.File]::ReadAllText($out); $head = $head.Substring(0, [math]::Min(600, $head.Length))
    $m = [regex]::Match($head, '^\{"meta":\{"v":(\d+),.*?"src":\["([^"]*)","([^"]*)"\]')
    if ($m.Success -and [int]$m.Groups[1].Value -eq $FormatVersion -and $m.Groups[2].Value -eq $src[0] -and $m.Groups[3].Value -eq $src[1]) { Write-Host "Räntor: $($q.id) är aktuell"; continue }
  }
  try { Get-FiZip $q.prevId $src[0]; Get-FiZip $q.id $src[1] } catch { Write-Host "Räntor: kunde inte hämta FI:s filer för $($q.id) ($($_.Exception.Message)), hoppar över"; continue }
  Build-RatesPair $q.prevId $q.id $src[0] $src[1]
  $built++
}
Write-Host "Räntor klara ($built kvartal byggda)."
