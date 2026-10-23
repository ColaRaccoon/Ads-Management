param(
  [string]$CsvPath,
  [switch]$CompareOnly,
  [switch]$CompareDates,
  [switch]$CompareOptions,
  [switch]$CompareAmounts,
  [switch]$ObserveOnly,
  [switch]$ProbeDetailFields,
  [switch]$ProbeOrderInputs,
  [switch]$BusinessAggregate,
  [ValidateSet('2026-09-21', '2026-09-30', '2026-10-01')][string]$Day = '2026-09-30',
  [switch]$CsvPreflight,
  [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$failureCode = 'LOCAL_INPUT_INVALID'
$origin = 'https://cafe24-callback-test-production.up.railway.app'
$day = $Day

function Convert-Paid([string]$value) {
  $text = $value.Trim()
  if ($text -cnotmatch '^(0|[1-9][0-9]{0,14})(?:\.[0-9]{1,2})?$') {
    throw 'INVALID_PAID_SHAPE'
  }
  $amount = [decimal]::Parse($text, [Globalization.NumberStyles]::AllowDecimalPoint,
    [Globalization.CultureInfo]::InvariantCulture)
  return $amount.ToString('F2', [Globalization.CultureInfo]::InvariantCulture)
}

function Get-TupleHmac([byte[]]$key, [string]$domain, [string[]]$parts) {
  $stream = [IO.MemoryStream]::new()
  $hmac = [Security.Cryptography.HMACSHA256]::new($key)
  try {
    $prefix = [Text.Encoding]::UTF8.GetBytes("cafe24-06-hmac-v1/$domain`0")
    $stream.Write($prefix)
    foreach ($part in $parts) {
      $bytes = [Text.Encoding]::UTF8.GetBytes($part)
      $length = $bytes.Length
      if ($length -gt [uint32]::MaxValue) { throw 'INVALID_TUPLE' }
      $size = [byte[]]::new(4)
      $size[0] = ($length -shr 24) -band 255
      $size[1] = ($length -shr 16) -band 255
      $size[2] = ($length -shr 8) -band 255
      $size[3] = $length -band 255
      $stream.Write($size)
      $stream.Write($bytes)
      [Array]::Clear($bytes, 0, $bytes.Length)
    }
    return [Convert]::ToHexString($hmac.ComputeHash($stream.ToArray())).ToLowerInvariant()
  } finally {
    $hmac.Dispose()
    $stream.Dispose()
  }
}

function New-OrdinalSet { return ,([Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)) }

function Read-ComparisonCsv([string]$path, [byte[]]$key, [bool]$forOptions = $false,
  [bool]$forAmounts = $false) {
  if (-not [IO.File]::Exists($path)) { throw 'CSV_MISSING' }
  $parser = [Microsoft.VisualBasic.FileIO.TextFieldParser]::new($path, [Text.Encoding]::UTF8)
  $parser.SetDelimiters(',')
  $parser.HasFieldsEnclosedInQuotes = $true
  $orders = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
  $orderDigests = New-OrdinalSet
  $itemDigests = New-OrdinalSet
  $paidDigests = New-OrdinalSet
  $paidToOrder = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
  $csvDates = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
  $dateHmacs = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
  $optionRows = [Collections.Generic.List[string]]::new()
  $amountRows = [Collections.Generic.List[string]]::new()
  $totalOrders = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
  $couponFlags = [Collections.Generic.Dictionary[string,bool]]::new([StringComparer]::Ordinal)
  $rowCount = 0
  try {
    if ($parser.EndOfData) { throw 'CSV_EMPTY' }
    $header = $parser.ReadFields()
    $names = @('주문번호', '품목별 주문번호', '총 결제금액', '발주일')
    if ($forOptions) { $names += @('상품번호', '수량', '판매가', '주문상품명(옵션포함)') }
    if ($forAmounts) { $names += @('총 주문금액', '결제수단') }
    $indexes = @{}
    foreach ($name in $names) {
      $positions = @(0..($header.Length - 1) | Where-Object { $header[$_] -ceq $name })
      if ($positions.Count -ne 1) { throw 'CSV_HEADER_INVALID' }
      $indexes[$name] = [int]$positions[0]
    }
    while (-not $parser.EndOfData) {
      $fields = $parser.ReadFields()
      if ($fields.Length -ne $header.Length) { throw 'CSV_ROW_SHAPE' }
      $rowCount += 1
      if ($rowCount -gt 10000) { throw 'CSV_ROW_LIMIT' }
      $orderId = $fields[$indexes['주문번호']].Trim()
      $itemCode = $fields[$indexes['품목별 주문번호']].Trim()
      $orderDate = $fields[$indexes['발주일']].Trim()
      if ($orderId -cnotmatch '^[A-Za-z0-9_-]{1,128}$' -or
          $itemCode -cnotmatch '^[A-Za-z0-9_-]{1,128}$' -or
          ($orderDate -ne '' -and $orderDate -cnotmatch "^$day(?: [0-9]{2}:[0-9]{2}:[0-9]{2})?$")) {
        throw 'CSV_KEY_OR_DAY_INVALID'
      }
      $paid = Convert-Paid $fields[$indexes['총 결제금액']]
      $totalOrder = $null
      $couponFlag = $false
      if ($forAmounts) {
        $totalOrder = Convert-Paid $fields[$indexes['총 주문금액']]
        $method = $fields[$indexes['결제수단']]
        if ($method.Length -gt 256 -or $method -cmatch '[\x00-\x1f\x7f]') {
          throw 'CSV_PAYMENT_METHOD_INVALID'
        }
        $couponFlag = @($method.Normalize([Text.NormalizationForm]::FormKC).Split(',') |
          ForEach-Object { $_.Trim() }) -ccontains '쿠폰'
      }
      if ($orders.ContainsKey($orderId)) {
        if ($orders[$orderId] -cne $paid) { throw 'CSV_ORDER_PAID_INCONSISTENT' }
        if ($forAmounts -and ($totalOrders[$orderId] -cne $totalOrder -or
            $couponFlags[$orderId] -ne $couponFlag)) {
          throw 'CSV_ORDER_AMOUNT_INCONSISTENT'
        }
        if ($csvDates[$orderId] -cne $orderDate) {
          if ($csvDates[$orderId] -eq '' -or $orderDate -eq '' -or
              $csvDates[$orderId].Length -ne 19 -or $orderDate.Length -ne 19) {
            throw 'CSV_ORDER_DATE_INCONSISTENT'
          }
          $parsed = [DateTimeOffset]::ParseExact("$orderDate +09:00",
            'yyyy-MM-dd HH:mm:ss zzz', [Globalization.CultureInfo]::InvariantCulture)
          $instant = $parsed.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ',
            [Globalization.CultureInfo]::InvariantCulture)
          $orderDigest = Get-TupleHmac $key 'order' @($orderId)
          $expected = $dateHmacs[$orderDigest]
          if (-not $expected -or $expected[2].Count -ge 100) {
            throw 'CSV_ORDER_DATE_INCONSISTENT'
          }
          [void]$expected[2].Add((Get-TupleHmac $key 'order-instant' @($orderId, $instant)))
          [void]$expected[3].Add((Get-TupleHmac $key 'place-instant' @($orderId, $instant)))
        }
      } else {
        $orders.Add($orderId, $paid)
        if ($forAmounts) {
          $totalOrders.Add($orderId, $totalOrder)
          $couponFlags.Add($orderId, $couponFlag)
        }
        $csvDates.Add($orderId, $orderDate)
        $orderDigest = Get-TupleHmac $key 'order' @($orderId)
        $paidDigest = Get-TupleHmac $key 'paid' @($orderId, $paid)
        if (-not $orderDigests.Add($orderDigest) -or -not $paidDigests.Add($paidDigest)) {
          throw 'CSV_DUPLICATE_DIGEST'
        }
        $paidToOrder.Add($paidDigest, $orderDigest)
        if ($orderDate -ne '') {
          $dateOnly = $orderDate.Substring(0, 10)
          $instantHmac = $null
          if ($orderDate.Length -eq 19) {
            $parsed = [DateTimeOffset]::ParseExact("$orderDate +09:00",
              'yyyy-MM-dd HH:mm:ss zzz', [Globalization.CultureInfo]::InvariantCulture)
            $instant = $parsed.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ',
              [Globalization.CultureInfo]::InvariantCulture)
            $instantHmac = Get-TupleHmac $key 'order-instant' @($orderId, $instant)
          }
          $orderInstants = New-OrdinalSet
          $placeInstants = New-OrdinalSet
          if ($instantHmac) {
            [void]$orderInstants.Add($instantHmac)
            [void]$placeInstants.Add((Get-TupleHmac $key 'place-instant' @($orderId, $instant)))
          }
          $dateHmacs.Add($orderDigest, @(
            (Get-TupleHmac $key 'order-day' @($orderId, $dateOnly)),
            (Get-TupleHmac $key 'place-day' @($orderId, $dateOnly)),
            $orderInstants, $placeInstants
          ))
        }
      }
      if (-not $itemDigests.Add((Get-TupleHmac $key 'item' @($orderId, $itemCode)))) {
        throw 'CSV_DUPLICATE_ITEM'
      }
      if ($forOptions) {
        if ($optionRows.Count -ge 600) { throw 'CSV_ROW_LIMIT' }
        $productNo = $fields[$indexes['상품번호']].Trim()
        if ($productNo.EndsWith('.0', [StringComparison]::Ordinal)) {
          $productNo = $productNo.Substring(0, $productNo.Length - 2)
        }
        if ($productNo -cnotmatch '^[A-Za-z0-9_-]{1,128}$') {
          throw 'CSV_PRODUCT_SHAPE'
        }
        $quantityText = $fields[$indexes['수량']].Trim()
        if ($quantityText -cnotmatch '^(0|[1-9][0-9]{0,6})$' -or
            [int]$quantityText -gt 1000000) { throw 'CSV_QUANTITY_SHAPE' }
        $salePrice = Convert-Paid ($fields[$indexes['판매가']].Trim().Replace(',', ''))
        $optionName = $fields[$indexes['주문상품명(옵션포함)']].Trim()
        if ($optionName.Length -lt 1 -or $optionName.Length -gt 1024) {
          throw 'CSV_OPTION_SHAPE'
        }
        $optionRows.Add((@(
          (Get-TupleHmac $key 'item' @($orderId, $itemCode)),
          (Get-TupleHmac $key 'option-product' @($orderId, $itemCode, $productNo)),
          (Get-TupleHmac $key 'option-quantity' @($orderId, $itemCode, ([int]$quantityText).ToString())),
          (Get-TupleHmac $key 'option-price' @($orderId, $itemCode, $salePrice)),
          (Get-TupleHmac $key 'option-name' @($orderId, $itemCode, $optionName))
        ) -join '.'))
      }
      $fields = $null
    }
    if ($rowCount -eq 0 -or $orders.Count -eq 0) { throw 'CSV_EMPTY' }
    $csvCouponOrders = 0
    if ($forAmounts) {
      if ($orders.Count -lt 10 -or $orders.Count -gt 500) {
        throw 'CSV_ORDER_AMOUNT_LIMIT'
      }
      foreach ($orderId in $orders.Keys) {
        $flag = if ($couponFlags[$orderId]) { 'true' } else { 'false' }
        if ($couponFlags[$orderId]) { $csvCouponOrders += 1 }
        $deltaValue = [decimal]::Parse($totalOrders[$orderId],
          [Globalization.CultureInfo]::InvariantCulture) -
          [decimal]::Parse($orders[$orderId], [Globalization.CultureInfo]::InvariantCulture)
        $delta = $deltaValue.ToString('F2', [Globalization.CultureInfo]::InvariantCulture)
        $amountRows.Add((@(
          (Get-TupleHmac $key 'order' @($orderId)),
          (Get-TupleHmac $key 'order-total' @($orderId, $totalOrders[$orderId])),
          (Get-TupleHmac $key 'paid' @($orderId, $orders[$orderId])),
          (Get-TupleHmac $key 'coupon-flag' @($orderId, $flag)),
          (Get-TupleHmac $key 'coupon-delta' @($orderId, $delta))
        ) -join '.'))
      }
    }
    return @{ orderCount = $orders.Count; itemCount = $rowCount;
      orderDigests = $orderDigests; itemDigests = $itemDigests;
      paidDigests = $paidDigests; paidToOrder = $paidToOrder;
      dateHmacs = $dateHmacs; optionRows = $optionRows;
      amountRows = $amountRows; csvCouponOrders = $csvCouponOrders }
  } finally { $parser.Dispose() }
}

function Test-RemoteSet($values, [int]$expectedCount) {
  if ($null -eq $values -or $values -isnot [array] -or $values.Count -ne $expectedCount) {
    throw 'REMOTE_COUNT_INVALID'
  }
  $set = New-OrdinalSet
  foreach ($value in $values) {
    if ($value -isnot [string] -or $value -cnotmatch '^[a-f0-9]{64}$' -or
        -not $set.Add($value)) { throw 'REMOTE_DIGEST_INVALID' }
  }
  return ,$set
}

function Select-PaidDifference($csv, $api, [int]$expectedDifferenceCount = 6) {
  $apiOrders = Test-RemoteSet $api.orderHmacs $csv.orderCount
  $apiItems = Test-RemoteSet $api.orderItemHmacs $csv.itemCount
  $apiPaid = Test-RemoteSet $api.orderPaidHmacs $csv.orderCount
  if (-not $csv.orderDigests.SetEquals($apiOrders) -or
      -not $csv.itemDigests.SetEquals($apiItems)) { throw 'KEY_SETS_DIFFER' }
  $selected = [Collections.Generic.List[string]]::new()
  foreach ($paidDigest in $csv.paidDigests) {
    if (-not $apiPaid.Contains($paidDigest)) {
      $selected.Add($csv.paidToOrder[$paidDigest])
    }
  }
  $extraPaid = 0
  foreach ($paidDigest in $apiPaid) {
    if (-not $csv.paidDigests.Contains($paidDigest)) { $extraPaid += 1 }
  }
  if ($extraPaid -ne $selected.Count -or
      ($expectedDifferenceCount -ge 0 -and $selected.Count -ne $expectedDifferenceCount)) {
    throw 'PAID_DIFFERENCE_COUNT'
  }
  return ,$selected.ToArray()
}

function Compare-OrderDates($csv, $api) {
  if ($api.readComplete -isnot [bool] -or $api.readComplete -ne $true -or
      $api.snapshotComplete -isnot [bool] -or $api.snapshotComplete -ne $false -or
      $api.timeZoneInterpretation -cne 'NAIVE_ASSUMED_MALL_KST' -or
      $api.orderCount -ne $csv.orderCount -or $api.rows -isnot [array] -or
      $api.rows.Count -ne $csv.orderCount) { throw 'DATE_SHAPE_INVALID' }
  $seen = New-OrdinalSet
  $placePresent = 0
  $orderDayMatches = 0
  $placeDayMatches = 0
  $orderInstantMatches = 0
  $placeInstantMatches = 0
  $orderInstantMatchesAll = 0
  $placeInstantMatchesAll = 0
  $multiInstantOrders = 0
  $csvInstantCount = 0
  foreach ($row in $api.rows) {
    if ($row -isnot [array] -or $row.Count -ne 5) { throw 'DATE_ROW_INVALID' }
    foreach ($index in 0..2) {
      if ($row[$index] -isnot [string] -or $row[$index] -cnotmatch '^[a-f0-9]{64}$') {
        throw 'DATE_DIGEST_INVALID'
      }
    }
    foreach ($index in 3..4) {
      if ($null -ne $row[$index] -and
          ($row[$index] -isnot [string] -or $row[$index] -cnotmatch '^[a-f0-9]{64}$')) {
        throw 'DATE_DIGEST_INVALID'
      }
    }
    if (($null -eq $row[3]) -ne ($null -eq $row[4]) -or
        -not $csv.orderDigests.Contains($row[0]) -or -not $seen.Add($row[0])) {
      throw 'DATE_IDENTITY_INVALID'
    }
    if ($null -ne $row[3]) { $placePresent += 1 }
    if ($csv.dateHmacs.ContainsKey($row[0])) {
      $expected = $csv.dateHmacs[$row[0]]
      if ($row[1] -ceq $expected[0]) { $orderDayMatches += 1 }
      if ($row[3] -ceq $expected[1]) { $placeDayMatches += 1 }
      if ($expected[2].Count -gt 0) {
        $csvInstantCount += 1
        if ($expected[2].Count -gt 1) { $multiInstantOrders += 1 }
        if ($expected[2].Contains($row[2])) {
          $orderInstantMatches += 1
          if ($expected[2].Count -eq 1) { $orderInstantMatchesAll += 1 }
        }
        if ($null -ne $row[4] -and $expected[3].Contains($row[4])) {
          $placeInstantMatches += 1
          if ($expected[3].Count -eq 1) { $placeInstantMatchesAll += 1 }
        }
      }
    }
  }
  if ($seen.Count -ne $csv.orderCount -or $api.placeDatePresentCount -ne $placePresent) {
    throw 'DATE_COUNT_INVALID'
  }
  $naiveOrder = Assert-SafeCount $api.naiveOrderDateCount $csv.orderCount
  $naivePlace = Assert-SafeCount $api.naivePlaceDateCount $placePresent
  return [ordered]@{ mode = 'COMPARE_DATES'; csvOrders = $csv.orderCount;
    csvDatedOrders = $csv.dateHmacs.Count;
    csvUndatedOrders = $csv.orderCount - $csv.dateHmacs.Count;
    apiPlaceDatePresent = $placePresent; orderDayMatches = $orderDayMatches;
    placeDayMatches = $placeDayMatches; csvInstantOrders = $csvInstantCount;
    orderInstantMatches = $orderInstantMatches;
    placeInstantMatches = $placeInstantMatches;
    orderInstantMatchesAny = $orderInstantMatches;
    orderInstantMatchesAll = $orderInstantMatchesAll;
    placeInstantMatchesAny = $placeInstantMatches;
    placeInstantMatchesAll = $placeInstantMatchesAll;
    csvMultiInstantOrders = $multiInstantOrders;
    naiveOrderDateCount = $naiveOrder; naivePlaceDateCount = $naivePlace;
    timeZoneInterpretation = 'NAIVE_ASSUMED_MALL_KST'; snapshotComplete = $false }
}

function Assert-SafeCount($value, [int]$maximum) {
  if (($value -isnot [int] -and $value -isnot [long]) -or
      $value -lt 0 -or $value -gt $maximum) { throw 'INVALID_AGGREGATE' }
  return [int]$value
}

function Read-SafeCountMap($value, [string[]]$keys, [int]$maximum) {
  if ($value -isnot [Collections.IDictionary] -or $value.Count -ne $keys.Count) {
    throw 'INVALID_AGGREGATE'
  }
  $safe = [ordered]@{}
  foreach ($key in $keys) {
    if (-not $value.Contains($key)) { throw 'INVALID_AGGREGATE' }
    $safe[$key] = Assert-SafeCount $value[$key] $maximum
  }
  return ,$safe
}

function Read-SuppressedCountMap($value, [string[]]$keys, [int]$maximum) {
  if ($value -isnot [Collections.IDictionary] -or $value.Count -ne $keys.Count) {
    throw 'INVALID_AGGREGATE'
  }
  $safe = [ordered]@{}
  foreach ($key in $keys) {
    if (-not $value.Contains($key)) { throw 'INVALID_AGGREGATE' }
    if ($null -eq $value[$key]) { $safe[$key] = $null; continue }
    $count = Assert-SafeCount $value[$key] $maximum
    if ($count -lt 10) { throw 'INVALID_AGGREGATE' }
    $safe[$key] = $count
  }
  return ,$safe
}

function Read-SafeObservation($value) {
  $keys = @('observedOrders', 'newOrders', 'changedOrders',
    'unchangedOrders', 'snapshotComplete')
  if ($value -isnot [Collections.IDictionary] -or $value.Count -ne $keys.Count) {
    throw 'OBSERVATION_SHAPE_INVALID'
  }
  foreach ($key in $keys) {
    if (-not $value.Contains($key)) { throw 'OBSERVATION_SHAPE_INVALID' }
  }
  $observed = Assert-SafeCount $value.observedOrders 1000
  $new = Assert-SafeCount $value.newOrders $observed
  $changed = Assert-SafeCount $value.changedOrders $observed
  $unchanged = Assert-SafeCount $value.unchangedOrders $observed
  if ($new + $changed + $unchanged -ne $observed -or
      $value.snapshotComplete -isnot [bool] -or $value.snapshotComplete -ne $false) {
    throw 'OBSERVATION_SHAPE_INVALID'
  }
  return [ordered]@{ observedOrders = $observed; newOrders = $new;
    changedOrders = $changed; unchangedOrders = $unchanged;
    snapshotComplete = $false }
}

function Read-SafeBusinessAggregate($value) {
  $keys = @('day', 'orderCount', 'itemCount', 'orderPricePresent',
    'orderPriceAbsent', 'orderPriceTotalKrw', 'paidTotalKrw',
    'orderPriceBelowPaid', 'orderPriceEqualPaid', 'orderPriceAbovePaid',
    'itemPriceTimesQuantityTotalKrw', 'cPrefixStatusItems', 'rPrefixStatusItems',
    'otherItems', 'paymentMethodArrayLengths', 'observedItemStatusCodes', 'methodCouponExactOrders',
    'methodCouponLikeOrders', 'methodMalformedOrders',
    'discountCouponShippingRefundMeaning',
    'readComplete', 'cacheFreshness', 'snapshotComplete', 'semanticVerified')
  if ($value -isnot [Collections.IDictionary] -or $value.Count -notin @($keys.Count,($keys.Count-1)) -or
      $value.day -cne $day -or $value.readComplete -cne $true -or
      $value.snapshotComplete -cne $false -or $value.semanticVerified -cne $false -or
      $value.cacheFreshness -cne 'UNVERIFIED_PROVIDER_CACHE' -or
      $value.discountCouponShippingRefundMeaning -cne 'UNVERIFIED') {
    throw 'BUSINESS_AGGREGATE_INVALID'
  }
  if ($value.Contains('observedItemStatusCodes') -and
      ($value.observedItemStatusCodes -isnot [Array] -or $value.observedItemStatusCodes.Count -gt 32 -or
       @($value.observedItemStatusCodes | Where-Object { $_ -isnot [string] -or $_ -cnotmatch '^[A-Z][0-9]{2}$' }).Count)) {
    throw 'BUSINESS_STATUS_CODES_INVALID'
  }
  foreach ($key in $keys) {
    if ($key -eq 'observedItemStatusCodes') { continue }
    if (-not $value.Contains($key)) { throw 'BUSINESS_AGGREGATE_INVALID' }
  }
  foreach ($key in $value.Keys) {
    if ($key -notin $keys) { throw 'BUSINESS_AGGREGATE_INVALID' }
  }
  $orders = Assert-SafeCount $value.orderCount 1000
  $items = Assert-SafeCount $value.itemCount 20000
  if ($orders -gt 0 -and $orders -lt 10) { throw 'BUSINESS_AGGREGATE_INVALID' }
  $present = Assert-SafeCount $value.orderPricePresent $orders
  $absent = Assert-SafeCount $value.orderPriceAbsent $orders
  $below = Assert-SafeCount $value.orderPriceBelowPaid $orders
  $equal = Assert-SafeCount $value.orderPriceEqualPaid $orders
  $above = Assert-SafeCount $value.orderPriceAbovePaid $orders
  $c = Assert-SafeCount $value.cPrefixStatusItems $items
  $r = Assert-SafeCount $value.rPrefixStatusItems $items
  $other = Assert-SafeCount $value.otherItems $items
  if ($present + $absent -ne $orders -or $below + $equal + $above -ne $present -or
      $c + $r + $other -ne $items) { throw 'BUSINESS_AGGREGATE_INVALID' }
  foreach ($moneyKey in @('orderPriceTotalKrw', 'paidTotalKrw',
      'itemPriceTimesQuantityTotalKrw')) {
    if ($value[$moneyKey] -isnot [string] -or
        $value[$moneyKey] -cnotmatch '^(0|[1-9][0-9]{0,18})\.[0-9]{2}$') {
      throw 'BUSINESS_AGGREGATE_INVALID'
    }
  }
  if ($value.paymentMethodArrayLengths -isnot [Collections.IDictionary] -or
      $value.paymentMethodArrayLengths.Count -gt 19) {
    throw 'BUSINESS_AGGREGATE_INVALID'
  }
  $methodTotal = 0
  foreach ($name in $value.paymentMethodArrayLengths.Keys) {
    if ($name -cnotmatch '^(ABSENT|NULL|OTHER|ARRAY_(?:[0-9]|1[0-6]))$') {
      throw 'BUSINESS_AGGREGATE_INVALID'
    }
    $methodTotal += Assert-SafeCount $value.paymentMethodArrayLengths[$name] $orders
  }
  if ($methodTotal -ne $orders) { throw 'BUSINESS_AGGREGATE_INVALID' }
  $methodCouponExact = Assert-SafeCount $value.methodCouponExactOrders $orders
  $methodCouponLike = Assert-SafeCount $value.methodCouponLikeOrders $orders
  $methodMalformed = Assert-SafeCount $value.methodMalformedOrders $orders
  if ($methodCouponExact -gt $methodCouponLike -or
      $methodCouponLike + $methodMalformed -gt $orders) {
    throw 'BUSINESS_AGGREGATE_INVALID'
  }
  return [ordered]@{ day = $day; orderCount = $orders; itemCount = $items;
    orderPricePresent = $present; orderPriceAbsent = $absent;
    orderPriceTotalKrw = $value.orderPriceTotalKrw; paidTotalKrw = $value.paidTotalKrw;
    orderPriceBelowPaid = $below; orderPriceEqualPaid = $equal;
    orderPriceAbovePaid = $above;
    itemPriceTimesQuantityTotalKrw = $value.itemPriceTimesQuantityTotalKrw;
    cPrefixStatusItems = $c; rPrefixStatusItems = $r; otherItems = $other;
    paymentMethodArrayLengths = $value.paymentMethodArrayLengths;
    methodCouponExactOrders = $methodCouponExact;
    methodCouponLikeOrders = $methodCouponLike;
    methodMalformedOrders = $methodMalformed;
    discountCouponShippingRefundMeaning = 'UNVERIFIED';
    readComplete = $true; cacheFreshness = 'UNVERIFIED_PROVIDER_CACHE';
    snapshotComplete = $false; semanticVerified = $false }
}

function Read-SafeOrderInputProbe($value) {
  $top = @('day', 'sampledOrder', 'sampledItem', 'orderFields', 'itemFields',
    'actualOrderAmountFields', 'initialOrderAmountFields')
  $names = @('order_id', 'shop_no', 'order_date', 'updated_date',
    'payment_amount', 'payed_amount', 'payment_method', 'order_status',
    'order_price_amount', 'actual_order_amount', 'initial_order_amount', 'currency')
  $amountNames = @('order_price_amount', 'payment_amount', 'total_amount_due',
    'coupon_discount_price', 'coupon_shipping_fee_amount', 'shipping_fee',
    'shipping_fee_discount_amount', 'membership_discount_amount', 'points_spent_amount',
    'credits_spent_amount', 'set_product_discount_amount', 'app_discount_amount',
    'market_other_discount_amount')
  $itemNames = @('order_item_code', 'product_no', 'product_name', 'option_value',
    'quantity', 'product_price', 'order_status')
  $shapes = @('absent', 'null', 'array', 'string', 'number', 'boolean', 'object', 'no_sample')
  if ($value -isnot [Collections.IDictionary] -or $value.Count -ne $top.Count -or
      $value.day -cne $day -or $value.sampledOrder -isnot [bool] -or
      $value.sampledItem -isnot [bool] -or
      $value.orderFields -isnot [Collections.IDictionary] -or
      $value.orderFields.Count -ne $names.Count -or
      $value.itemFields -isnot [Collections.IDictionary] -or
      $value.itemFields.Count -ne $itemNames.Count -or
      $value.actualOrderAmountFields -isnot [Collections.IDictionary] -or
      $value.actualOrderAmountFields.Count -ne $amountNames.Count -or
      $value.initialOrderAmountFields -isnot [Collections.IDictionary] -or
      $value.initialOrderAmountFields.Count -ne $amountNames.Count) {
    throw 'ORDER_INPUT_PROBE_INVALID'
  }
  foreach ($name in $top) {
    if (-not $value.Contains($name)) { throw 'ORDER_INPUT_PROBE_INVALID' }
  }
  foreach ($name in $names) {
    if (-not $value.orderFields.Contains($name) -or
        $value.orderFields[$name] -cnotin $shapes) { throw 'ORDER_INPUT_PROBE_INVALID' }
  }
  foreach ($name in $itemNames) {
    if (-not $value.itemFields.Contains($name) -or
        $value.itemFields[$name] -cnotin $shapes) { throw 'ORDER_INPUT_PROBE_INVALID' }
  }
  foreach ($name in $amountNames) {
    if (-not $value.actualOrderAmountFields.Contains($name) -or
        $value.actualOrderAmountFields[$name] -cnotin $shapes -or
        -not $value.initialOrderAmountFields.Contains($name) -or
        $value.initialOrderAmountFields[$name] -cnotin $shapes) {
      throw 'ORDER_INPUT_PROBE_INVALID'
    }
  }
  $safeActual = [ordered]@{}
  $safeInitial = [ordered]@{}
  foreach ($name in $amountNames) {
    $safeActual[$name] = $value.actualOrderAmountFields[$name]
    $safeInitial[$name] = $value.initialOrderAmountFields[$name]
  }
  return [ordered]@{ day = $day; sampledOrder = $value.sampledOrder;
    orderPriceAmount = $value.orderFields.order_price_amount;
    actualOrderAmount = $value.orderFields.actual_order_amount;
    initialOrderAmount = $value.orderFields.initial_order_amount;
    paymentMethod = $value.orderFields.payment_method;
    actualOrderAmountFields = $safeActual;
    initialOrderAmountFields = $safeInitial }
}

function Read-SafeDetailFields($value) {
  if ($value -isnot [Collections.IDictionary] -or $value.Count -ne 5 -or
      $value.day -cne $day -or $value.sampledOrder -isnot [bool] -or
      $value.semanticVerified -isnot [bool] -or $value.semanticVerified -ne $false -or
      $value.snapshotComplete -isnot [bool] -or $value.snapshotComplete -ne $false -or
      $value.stages -isnot [array] -or $value.stages.Count -lt 1 -or
      $value.stages.Count -gt 4) { throw 'DETAIL_FIELDS_SHAPE_INVALID' }
  foreach ($key in @('day', 'sampledOrder', 'semanticVerified', 'snapshotComplete', 'stages')) {
    if (-not $value.Contains($key)) { throw 'DETAIL_FIELDS_SHAPE_INVALID' }
  }
  $names = @('orders_sample', 'detail_combined', 'detail_updated_date',
    'detail_order_status')
  $shapes = @('absent', 'null', 'array', 'string', 'number', 'boolean', 'object',
    'not_checked')
  $kinds = @('json', 'invalid_json', 'empty', 'http_error', 'too_large',
    'transport_error', 'deadline')
  $codes = @('400', '401', '403', '404', '422', '429', '500', '503',
    'INVALID_REQUEST', 'invalid_request')
  $safeStages = [Collections.Generic.List[object]]::new()
  for ($index = 0; $index -lt $value.stages.Count; $index++) {
    $stage = $value.stages[$index]
    if ($stage -isnot [Collections.IDictionary] -or
        $stage.stage -cne $names[$index] -or $stage.responseKind -cnotin $kinds -or
        ($null -ne $stage.httpStatus -and
          (($stage.httpStatus -isnot [int] -and $stage.httpStatus -isnot [long]) -or
           $stage.httpStatus -lt 100 -or $stage.httpStatus -gt 599)) -or
        ($null -ne $stage.providerCode -and $stage.providerCode -cnotin $codes)) {
      throw 'DETAIL_FIELDS_SHAPE_INVALID'
    }
    if ($index -eq 0) {
      if ($stage.Count -ne 5 -or $stage.orders -cnotin $shapes) {
        throw 'DETAIL_FIELDS_SHAPE_INVALID'
      }
      $safeStages.Add([ordered]@{ stage = 'orders_sample';
        httpStatus = $stage.httpStatus; responseKind = $stage.responseKind;
        providerCode = $stage.providerCode; orders = $stage.orders })
      continue
    }
    if ($stage.Count -ne 7 -or $stage.order -cnotin $shapes -or
        $stage.identity -cnotin @('UNVERIFIED', 'MISSING', 'MATCH', 'MISMATCH') -or
        $stage.fields -isnot [Collections.IDictionary]) {
      throw 'DETAIL_FIELDS_SHAPE_INVALID'
    }
    $fieldNames = if ($index -eq 1) { @('updated_date', 'order_status') }
      elseif ($index -eq 2) { @('updated_date') } else { @('order_status') }
    if ($stage.fields.Count -ne $fieldNames.Count) { throw 'DETAIL_FIELDS_SHAPE_INVALID' }
    $safeFields = [ordered]@{}
    foreach ($field in $fieldNames) {
      if (-not $stage.fields.Contains($field) -or
          $stage.fields[$field] -cnotin $shapes) { throw 'DETAIL_FIELDS_SHAPE_INVALID' }
      $safeFields[$field] = $stage.fields[$field]
    }
    $safeStages.Add([ordered]@{ stage = $stage.stage;
      httpStatus = $stage.httpStatus; responseKind = $stage.responseKind;
      providerCode = $stage.providerCode; order = $stage.order;
      identity = $stage.identity; fields = $safeFields })
  }
  if (($value.sampledOrder -and $safeStages.Count -lt 2) -or
      (-not $value.sampledOrder -and $safeStages.Count -ne 1)) {
    throw 'DETAIL_FIELDS_SHAPE_INVALID'
  }
  return [ordered]@{ day = $day; sampledOrder = $value.sampledOrder;
    stages = $safeStages.ToArray(); semanticVerified = $false;
    snapshotComplete = $false }
}

function Format-RemoteFailure([string]$kind, [string]$mode,
  [int]$status, [string]$providerCode, [string]$category = 'NONE') {
  if ($kind -cnotin @('REMOTE_ACTION_REJECTED', 'REMOTE_RESPONSE_INVALID',
      'REMOTE_TRANSPORT_FAILED', 'REMOTE_JOB_DEADLINE')) { throw 'INVALID_FAILURE_KIND' }
  if ($mode -cnotin @('hmac', 'date-hmac', 'option-compare', 'paid-diagnose',
      'observe', 'detail-fields', 'business-aggregate', 'probe', 'amount-compare')) {
    throw 'INVALID_MODE'
  }
  $safeStatus = if ($status -ge 100 -and $status -le 599) { [string]$status } else { 'NONE' }
  $allowed = @('FIELD_UNSUPPORTED', 'PARTIAL_PAGE', 'RECONCILIATION_FAILED',
    'RUN_LIMIT_EXCEEDED', 'PROVIDER_AUTH_REQUIRED', 'PROVIDER_RATE_LIMITED',
    'PROVIDER_UNAVAILABLE', 'ACCOUNT_SCOPE_MISMATCH')
  $safeCode = if ($kind -ceq 'REMOTE_ACTION_REJECTED' -and $status -eq 409 -and
      $providerCode -is [string] -and
      $providerCode -cin $allowed) { $providerCode } else { 'NONE' }
  if ($mode -ceq 'option-compare' -and $safeCode -ceq 'FIELD_UNSUPPORTED') {
    $categories = @('ITEM_SHAPE', 'ITEM_CODE', 'PRODUCT_NO', 'PRODUCT_NAME',
      'OPTION_VALUE', 'QUANTITY', 'PRODUCT_PRICE', 'OPTION_PRICE_EMPTY',
      'OPTION_PRICE_FORMAT', 'OPTION_PRICE_TYPE', 'OPTION_PRICE_UNSAFE_NUMBER',
      'ITEM_REQUEST_OR_JSON', 'ORDER_OR_SHARED_SHAPE')
    $safeCategory = if ($category -cin $categories) { $category } else { 'NONE' }
    return "$kind stage=$mode status=$safeStatus code=$safeCode category=$safeCategory"
  }
  return "$kind stage=$mode status=$safeStatus code=$safeCode"
}

function Read-SafeRemote409Code([Net.Http.HttpResponseMessage]$response) {
  $script:remoteCategory = 'NONE'
  if ([int]$response.StatusCode -ne 409) { return 'NONE' }
  $length = $response.Content.Headers.ContentLength
  if ($null -eq $length -or $length -lt 1 -or $length -gt 512) { return 'NONE' }
  try {
    $errorBody = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() |
      ConvertFrom-Json -AsHashtable
    if ($errorBody -is [Collections.IDictionary] -and
        $errorBody.code -is [string]) {
      if ($errorBody.Contains('category') -and $errorBody['category'] -is [string]) {
        $script:remoteCategory = $errorBody['category']
      }
      return $errorBody.code
    }
  } catch { return 'NONE' }
  return 'NONE'
}

function Read-IsolatedActionResponse([Net.Http.HttpResponseMessage]$response,
  [string]$mode) {
  $status = [int]$response.StatusCode
  if ($status -ne 200) {
    $providerCode = Read-SafeRemote409Code $response
    $script:failureCode = Format-RemoteFailure 'REMOTE_ACTION_REJECTED' $mode $status (
      $providerCode) $script:remoteCategory
    throw 'REMOTE_ACTION_REJECTED'
  }
  try {
    $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    if ([Text.Encoding]::UTF8.GetByteCount($content) -gt 196608) {
      throw 'REMOTE_RESPONSE_LIMIT'
    }
    return ConvertFrom-Json -InputObject $content -AsHashtable -Depth 16
  } catch {
    $script:failureCode = Format-RemoteFailure 'REMOTE_RESPONSE_INVALID' $mode 200 'NONE'
    throw 'REMOTE_RESPONSE_INVALID'
  }
}

function Read-AsyncJobEnvelope([Net.Http.HttpResponseMessage]$response,
  [string]$mode, [bool]$starting) {
  if ([int]$response.StatusCode -ne 202) {
    if ($starting -and [int]$response.StatusCode -eq 200) {
      $script:failureCode = Format-RemoteFailure 'REMOTE_RESPONSE_INVALID' $mode (
        [int]$response.StatusCode) 'NONE'
      throw 'REMOTE_RESPONSE_INVALID'
    }
    $result = Read-IsolatedActionResponse $response $mode
    if ($result -isnot [Collections.IDictionary]) {
      $script:failureCode = Format-RemoteFailure 'REMOTE_RESPONSE_INVALID' $mode 200 'NONE'
      throw 'REMOTE_RESPONSE_INVALID'
    }
    return $result
  }
  try {
    $length = $response.Content.Headers.ContentLength
    if ($null -ne $length -and $length -gt 256) { throw 'JOB_ENVELOPE_LIMIT' }
    $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    if ([Text.Encoding]::UTF8.GetByteCount($content) -gt 256) {
      throw 'JOB_ENVELOPE_LIMIT'
    }
    $value = ConvertFrom-Json -InputObject $content -AsHashtable
    if ($value -isnot [Collections.IDictionary] -or $value.status -cne 'RUNNING') {
      throw 'JOB_ENVELOPE_INVALID'
    }
    if ($starting) {
      if ($value.Count -ne 2 -or $value.jobId -isnot [string] -or
          $value.jobId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') {
        throw 'JOB_ID_INVALID'
      }
      return $value.jobId
    }
    if ($value.Count -ne 1) { throw 'JOB_ENVELOPE_INVALID' }
    return 'RUNNING'
  } catch {
    $script:failureCode = Format-RemoteFailure 'REMOTE_RESPONSE_INVALID' $mode 202 'NONE'
    throw 'REMOTE_RESPONSE_INVALID'
  }
}

function Wait-IsolatedJob([Net.Http.HttpClient]$client, [string]$operator,
  [string]$mode, [string]$jobId) {
  $deadline = [DateTimeOffset]::UtcNow.AddMinutes(11)
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    Start-Sleep -Seconds 10
    $data = [Collections.Generic.Dictionary[string,string]]::new()
    $data.Add('operator', $operator)
    $data.Add('jobId', $jobId)
    $body = [Net.Http.FormUrlEncodedContent]::new($data)
    $cancel = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(45))
    try {
      try {
        $response = $client.PostAsync("$origin/action-status", $body,
          $cancel.Token).GetAwaiter().GetResult()
      } catch {
        $script:failureCode = Format-RemoteFailure 'REMOTE_TRANSPORT_FAILED' $mode 0 'NONE'
        throw 'REMOTE_TRANSPORT_FAILED'
      }
      try {
        $result = Read-AsyncJobEnvelope $response $mode $false
        if ($result -isnot [string]) { return $result }
      } finally { $response.Dispose() }
    } finally { $cancel.Dispose(); $body.Dispose() }
  }
  $script:failureCode = Format-RemoteFailure 'REMOTE_JOB_DEADLINE' $mode 0 'NONE'
  throw 'REMOTE_JOB_DEADLINE'
}

function Invoke-IsolatedAction([Net.Http.HttpClient]$client, [string]$operator,
  [string]$mode, [string]$keyText, [string]$orderHmacs = '',
  [string]$optionRows = '', [string]$amountRows = '') {
  $data = [Collections.Generic.Dictionary[string,string]]::new()
  $data.Add('operator', $operator)
  $data.Add('mode', $mode)
  $data.Add('day', $day)
  if ($mode -cnotin @('observe', 'detail-fields', 'business-aggregate', 'probe')) {
    $data.Add('hmacKey', $keyText)
  }
  if ($mode -ceq 'paid-diagnose') { $data.Add('orderHmacs', $orderHmacs) }
  if ($mode -ceq 'option-compare') { $data.Add('optionRows', $optionRows) }
  if ($mode -ceq 'amount-compare') { $data.Add('amountRows', $amountRows) }
  $body = [Net.Http.FormUrlEncodedContent]::new($data)
  try {
    $cancel = if ($mode -cin @('hmac', 'date-hmac', 'option-compare', 'amount-compare', 'observe',
        'business-aggregate')) {
      [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(45))
    } else { $null }
    try {
      $response = if ($cancel) {
        $client.PostAsync("$origin/action", $body, $cancel.Token).GetAwaiter().GetResult()
      } else { $client.PostAsync("$origin/action", $body).GetAwaiter().GetResult() }
    }
    catch {
      $script:failureCode = Format-RemoteFailure 'REMOTE_TRANSPORT_FAILED' $mode 0 'NONE'
      throw 'REMOTE_TRANSPORT_FAILED'
    } finally { if ($cancel) { $cancel.Dispose() } }
    try {
      if ($mode -cin @('hmac', 'date-hmac', 'option-compare', 'amount-compare', 'observe',
          'business-aggregate')) {
        $jobId = Read-AsyncJobEnvelope $response $mode $true
      } else { return Read-IsolatedActionResponse $response $mode }
    } finally { $response.Dispose() }
    return Wait-IsolatedJob $client $operator $mode $jobId
  } finally { $body.Dispose() }
}

try {
  if ($SelfTest) {
    $failureCode = 'SELF_TEST_REMOTE_FAILURE_FORMAT'
    if ((Format-RemoteFailure 'REMOTE_ACTION_REJECTED' 'date-hmac' 502 'FIELD_UNSUPPORTED') -cne
        'REMOTE_ACTION_REJECTED stage=date-hmac status=502 code=NONE' -or
        (Format-RemoteFailure 'REMOTE_ACTION_REJECTED' 'option-compare' 409 'FIELD_UNSUPPORTED' 'PHONE_01000000000') -cne
        'REMOTE_ACTION_REJECTED stage=option-compare status=409 code=FIELD_UNSUPPORTED category=NONE' -or
        (Format-RemoteFailure 'REMOTE_ACTION_REJECTED' 'hmac' 409 'FIELD_UNSUPPORTED') -cne
        'REMOTE_ACTION_REJECTED stage=hmac status=409 code=FIELD_UNSUPPORTED' -or
        (Format-RemoteFailure 'REMOTE_TRANSPORT_FAILED' 'date-hmac' 0 'UNRECOGNIZED') -cne
        'REMOTE_TRANSPORT_FAILED stage=date-hmac status=NONE code=NONE' -or
        (Format-RemoteFailure 'REMOTE_RESPONSE_INVALID' 'date-hmac' 200 'NONE') -cne
        'REMOTE_RESPONSE_INVALID stage=date-hmac status=200 code=NONE' -or
        (Format-RemoteFailure 'REMOTE_ACTION_REJECTED' 'observe' 409 'PARTIAL_PAGE') -cne
        'REMOTE_ACTION_REJECTED stage=observe status=409 code=PARTIAL_PAGE' -or
        (Format-RemoteFailure 'REMOTE_ACTION_REJECTED' 'detail-fields' 409 'FIELD_UNSUPPORTED') -cne
        'REMOTE_ACTION_REJECTED stage=detail-fields status=409 code=FIELD_UNSUPPORTED' -or
        (Format-RemoteFailure 'REMOTE_ACTION_REJECTED' 'business-aggregate' 409 'PARTIAL_PAGE') -cne
        'REMOTE_ACTION_REJECTED stage=business-aggregate status=409 code=PARTIAL_PAGE' -or
        (Format-RemoteFailure 'REMOTE_ACTION_REJECTED' 'business-aggregate' 502 'FIELD_UNSUPPORTED') -cne
        'REMOTE_ACTION_REJECTED stage=business-aggregate status=502 code=NONE' -or
        (Format-RemoteFailure 'REMOTE_TRANSPORT_FAILED' 'business-aggregate' 0 'NONE') -cne
        'REMOTE_TRANSPORT_FAILED stage=business-aggregate status=NONE code=NONE' -or
        (Format-RemoteFailure 'REMOTE_ACTION_REJECTED' 'probe' 409 'PARTIAL_PAGE') -cne
        'REMOTE_ACTION_REJECTED stage=probe status=409 code=PARTIAL_PAGE' -or
        (Format-RemoteFailure 'REMOTE_TRANSPORT_FAILED' 'probe' 0 'NONE') -cne
        'REMOTE_TRANSPORT_FAILED stage=probe status=NONE code=NONE') {
      throw 'SELF_TEST_FAILED'
    }
    $testResponse = [Net.Http.HttpResponseMessage]::new([Net.HttpStatusCode]::Conflict)
    try {
      $testResponse.Content = [Net.Http.StringContent]::new('{"code":"PARTIAL_PAGE"}')
      try { $null = Read-IsolatedActionResponse $testResponse 'date-hmac' }
      catch { }
      if ($failureCode -cne
          'REMOTE_ACTION_REJECTED stage=date-hmac status=409 code=PARTIAL_PAGE') {
        throw 'SELF_TEST_FAILED'
      }
      try { $null = Read-IsolatedActionResponse $testResponse 'probe' }
      catch { }
      if ($failureCode -cne
          'REMOTE_ACTION_REJECTED stage=probe status=409 code=PARTIAL_PAGE') {
        throw 'SELF_TEST_FAILED'
      }
    } finally { $testResponse.Dispose() }
    $failureCode = 'SELF_TEST_OBSERVATION_FAILED'
    $testObserved = Read-SafeObservation ([ordered]@{ observedOrders = 3;
      newOrders = 1; changedOrders = 1; unchangedOrders = 1;
      snapshotComplete = $false })
    if ($testObserved.observedOrders -ne 3 -or $testObserved.Count -ne 5) {
      throw 'SELF_TEST_FAILED'
    }
    foreach ($invalid in @(
      ([ordered]@{ observedOrders = 3; newOrders = 1; changedOrders = 1;
        unchangedOrders = 0; snapshotComplete = $false }),
      ([ordered]@{ observedOrders = 3; newOrders = 1; changedOrders = 1;
        unchangedOrders = 1; snapshotComplete = $true }),
      ([ordered]@{ observedOrders = 3; newOrders = 1; changedOrders = 1;
        unchangedOrders = 1; snapshotComplete = $false; extra = 'value' })
    )) {
      try { $null = Read-SafeObservation $invalid; throw 'SELF_TEST_FAILED' }
      catch { if ($_.Exception.Message -ceq 'SELF_TEST_FAILED') { throw } }
    }
    $failureCode = 'SELF_TEST_BUSINESS_AGGREGATE_FAILED'
    $business = [ordered]@{ day = $day; orderCount = 10; itemCount = 20;
      orderPricePresent = 10; orderPriceAbsent = 0;
      orderPriceTotalKrw = '1200.00'; paidTotalKrw = '1000.00';
      orderPriceBelowPaid = 0; orderPriceEqualPaid = 0; orderPriceAbovePaid = 10;
      itemPriceTimesQuantityTotalKrw = '1500.00'; cPrefixStatusItems = 1;
      rPrefixStatusItems = 0; otherItems = 19;
      paymentMethodArrayLengths = [ordered]@{ ARRAY_1 = 10 };
      methodCouponExactOrders = 0; methodCouponLikeOrders = 0;
      methodMalformedOrders = 0;
      discountCouponShippingRefundMeaning = 'UNVERIFIED'; readComplete = $true;
      cacheFreshness = 'UNVERIFIED_PROVIDER_CACHE'; snapshotComplete = $false;
      semanticVerified = $false }
    if ((Read-SafeBusinessAggregate $business).orderCount -ne 10) {
      throw 'SELF_TEST_FAILED'
    }
    $probeOrderNames = @('order_id', 'shop_no', 'order_date', 'updated_date',
      'payment_amount', 'payed_amount', 'payment_method', 'order_status',
      'order_price_amount', 'actual_order_amount', 'initial_order_amount', 'currency')
    $probeItemNames = @('order_item_code', 'product_no', 'product_name',
      'option_value', 'quantity', 'product_price', 'order_status')
    $probeAmountNames = @('order_price_amount', 'payment_amount', 'total_amount_due',
      'coupon_discount_price', 'coupon_shipping_fee_amount', 'shipping_fee',
      'shipping_fee_discount_amount', 'membership_discount_amount', 'points_spent_amount',
      'credits_spent_amount', 'set_product_discount_amount', 'app_discount_amount',
      'market_other_discount_amount')
    $probeOrder = [ordered]@{}
    $probeItem = [ordered]@{}
    $probeActual = [ordered]@{}
    $probeInitial = [ordered]@{}
    foreach ($name in $probeOrderNames) { $probeOrder[$name] = 'string' }
    foreach ($name in $probeItemNames) { $probeItem[$name] = 'string' }
    foreach ($name in $probeAmountNames) {
      $probeActual[$name] = 'string'
      $probeInitial[$name] = 'absent'
    }
    $probe = [ordered]@{ day = $day; sampledOrder = $true; sampledItem = $true;
      orderFields = $probeOrder; itemFields = $probeItem;
      actualOrderAmountFields = $probeActual; initialOrderAmountFields = $probeInitial }
    if ((Read-SafeOrderInputProbe $probe).actualOrderAmountFields.order_price_amount -cne 'string') {
      throw 'SELF_TEST_FAILED'
    }
    $probeOrder['order_id'] = 'SYNTHETIC-PII'
    try { $null = Read-SafeOrderInputProbe $probe; throw 'SELF_TEST_FAILED' }
    catch { if ($_.Exception.Message -ceq 'SELF_TEST_FAILED') { throw } }
    $probeOrder['order_id'] = 'string'
    $probeActual['order_price_amount'] = 'SYNTHETIC-PRIVATE-VALUE'
    try { $null = Read-SafeOrderInputProbe $probe; throw 'SELF_TEST_FAILED' }
    catch { if ($_.Exception.Message -ceq 'SELF_TEST_FAILED') { throw } }
    $probeActual['order_price_amount'] = 'string'
    $business['orderCount'] = 1
    try { $null = Read-SafeBusinessAggregate $business; throw 'SELF_TEST_FAILED' }
    catch { if ($_.Exception.Message -ceq 'SELF_TEST_FAILED') { throw } }
    $business['orderCount'] = 10
    $business['rawOrderId'] = 'SYNTHETIC'
    try { $null = Read-SafeBusinessAggregate $business; throw 'SELF_TEST_FAILED' }
    catch { if ($_.Exception.Message -ceq 'SELF_TEST_FAILED') { throw } }
    $failureCode = 'SELF_TEST_DETAIL_FIELDS_FAILED'
    $testDetail = [ordered]@{ day = $day; sampledOrder = $true;
      stages = @(
        ([ordered]@{ stage = 'orders_sample'; httpStatus = 200;
          responseKind = 'json'; providerCode = $null; orders = 'array' }),
        ([ordered]@{ stage = 'detail_combined'; httpStatus = 200;
          responseKind = 'json'; providerCode = $null; order = 'object';
          identity = 'MATCH'; fields = [ordered]@{ updated_date = 'absent';
            order_status = 'absent' } })
      ); semanticVerified = $false; snapshotComplete = $false }
    $safeDetail = Read-SafeDetailFields $testDetail
    if ($safeDetail.stages.Count -ne 2 -or
        $safeDetail.stages[1].fields.updated_date -cne 'absent') {
      throw 'SELF_TEST_FAILED'
    }
    $testDetail.stages[1].fields['updated_date'] = 'SYNTHETIC-ID'
    try { $null = Read-SafeDetailFields $testDetail; throw 'SELF_TEST_FAILED' }
    catch { if ($_.Exception.Message -ceq 'SELF_TEST_FAILED') { throw } }
    $testResponse = [Net.Http.HttpResponseMessage]::new([Net.HttpStatusCode]::Conflict)
    try {
      $testResponse.Content = [Net.Http.StringContent]::new('{"code":"NOT_ALLOWED"}')
      try { $null = Read-IsolatedActionResponse $testResponse 'hmac' }
      catch { }
      if ($failureCode -cne 'REMOTE_ACTION_REJECTED stage=hmac status=409 code=NONE') {
        throw 'SELF_TEST_FAILED'
      }
    } finally { $testResponse.Dispose() }
    $testResponse = [Net.Http.HttpResponseMessage]::new([Net.HttpStatusCode]::OK)
    try {
      $testResponse.Content = [Net.Http.StringContent]::new('not-json')
      try { $null = Read-IsolatedActionResponse $testResponse 'date-hmac' }
      catch { }
      if ($failureCode -cne
          'REMOTE_RESPONSE_INVALID stage=date-hmac status=200 code=NONE') {
        throw 'SELF_TEST_FAILED'
      }
    } finally { $testResponse.Dispose() }
    $testJobId = '11111111-1111-4111-8111-111111111111'
    $testResponse = [Net.Http.HttpResponseMessage]::new([Net.HttpStatusCode]::Accepted)
    try {
      $testResponse.Content = [Net.Http.StringContent]::new(
        ('{"jobId":"' + $testJobId + '","status":"RUNNING"}'))
      if ((Read-AsyncJobEnvelope $testResponse 'hmac' $true) -cne $testJobId) {
        throw 'SELF_TEST_FAILED'
      }
    } finally { $testResponse.Dispose() }
    $testResponse = [Net.Http.HttpResponseMessage]::new([Net.HttpStatusCode]::Accepted)
    try {
      $testResponse.Content = [Net.Http.StringContent]::new('{"status":"RUNNING"}')
      if ((Read-AsyncJobEnvelope $testResponse 'date-hmac' $false) -cne 'RUNNING') {
        throw 'SELF_TEST_FAILED'
      }
    } finally { $testResponse.Dispose() }
    $testResponse = [Net.Http.HttpResponseMessage]::new([Net.HttpStatusCode]::OK)
    try {
      $testResponse.Content = [Net.Http.StringContent]::new('{"orderCount":1}')
      $testResult = Read-AsyncJobEnvelope $testResponse 'date-hmac' $false
      if ($testResult.orderCount -ne 1) { throw 'SELF_TEST_FAILED' }
    } finally { $testResponse.Dispose() }
    $testResponse = [Net.Http.HttpResponseMessage]::new([Net.HttpStatusCode]::Conflict)
    try {
      $testResponse.Content = [Net.Http.StringContent]::new('{"code":"PARTIAL_PAGE"}')
      try { $null = Read-AsyncJobEnvelope $testResponse 'date-hmac' $false }
      catch { }
      if ($failureCode -cne
          'REMOTE_ACTION_REJECTED stage=date-hmac status=409 code=PARTIAL_PAGE') {
        throw 'SELF_TEST_FAILED'
      }
    } finally { $testResponse.Dispose() }
    $testResponse = [Net.Http.HttpResponseMessage]::new([Net.HttpStatusCode]::NotFound)
    try {
      $testResponse.Content = [Net.Http.StringContent]::new('Not found.')
      try { $null = Read-AsyncJobEnvelope $testResponse 'hmac' $false }
      catch { }
      if ($failureCode -cne 'REMOTE_ACTION_REJECTED stage=hmac status=404 code=NONE') {
        throw 'SELF_TEST_FAILED'
      }
    } finally { $testResponse.Dispose() }
    $testResponse = [Net.Http.HttpResponseMessage]::new([Net.HttpStatusCode]::Conflict)
    try {
      $testResponse.Content = [Net.Http.StringContent]::new(
        '{"code":"FIELD_UNSUPPORTED","category":"OPTION_PRICE_FORMAT"}')
      try { $null = Read-AsyncJobEnvelope $testResponse 'option-compare' $false }
      catch { }
      if ($failureCode -cne 'REMOTE_ACTION_REJECTED stage=option-compare status=409 code=FIELD_UNSUPPORTED category=OPTION_PRICE_FORMAT') {
        throw 'SELF_TEST_FAILED'
      }
    } finally { $testResponse.Dispose() }
    $failureCode = 'SELF_TEST_HMAC_FAILED'
    $testKey = [byte[]]::new(32)
    $testCsvPath = [IO.Path]::GetTempFileName()
    try {
      $testHeader = '주문번호,품목별 주문번호,총 결제금액,발주일,상품번호,수량,판매가,주문상품명(옵션포함)'
      $firstLine = 'SYNTHETIC-1,LINE-1,10,2026-09-30 12:00:00,1.0,2,10,Widget (Blue)'
      $secondLine = 'SYNTHETIC-1,LINE-2,10,2026-09-30 12:00:01,2,1,10,Widget (Red)'
      [IO.File]::WriteAllText($testCsvPath,
        (@($testHeader, $firstLine, $secondLine) -join "`n"), [Text.Encoding]::UTF8)
      $testOptionCsv = Read-ComparisonCsv $testCsvPath $testKey $true
      if ($testOptionCsv.orderCount -ne 1 -or $testOptionCsv.itemCount -ne 2 -or
          $testOptionCsv.optionRows.Count -ne 2 -or
          $testOptionCsv.optionRows[0].Split('.').Count -ne 5) { throw 'SELF_TEST_FAILED' }
      $testHmacCsv = Read-ComparisonCsv $testCsvPath $testKey $false
      if ($testHmacCsv.orderCount -ne 1 -or $testHmacCsv.itemCount -ne 2) {
        throw 'SELF_TEST_FAILED'
      }
      foreach ($badDate in @('', '2026-09-30', '2026-10-01 12:00:01')) {
        $badLine = "SYNTHETIC-1,LINE-2,10,$badDate,2,1,10,Widget (Red)"
        [IO.File]::WriteAllText($testCsvPath,
          (@($testHeader, $firstLine, $badLine) -join "`n"), [Text.Encoding]::UTF8)
        $expectedCode = if ($badDate.StartsWith('2026-10-01')) {
          'CSV_KEY_OR_DAY_INVALID' } else { 'CSV_ORDER_DATE_INCONSISTENT' }
        try { $null = Read-ComparisonCsv $testCsvPath $testKey $true;
          throw 'SELF_TEST_FAILED' }
        catch { if ($_.Exception.Message -cne $expectedCode) { throw } }
        try { $null = Read-ComparisonCsv $testCsvPath $testKey $false;
          throw 'SELF_TEST_FAILED' }
        catch { if ($_.Exception.Message -cne $expectedCode) { throw } }
      }
      $amountHeader = '주문번호,품목별 주문번호,총 결제금액,발주일,총 주문금액,결제수단'
      $amountLines = @(0..9 | ForEach-Object {
        $method = if ($_ -eq 0) { '쿠폰' } else { '카드' }
        "SYNTHETIC-$_,LINE-$_,90,2026-09-30 12:00:00,100,$method"
      })
      [IO.File]::WriteAllText($testCsvPath,
        (@($amountHeader) + $amountLines -join "`n"), [Text.Encoding]::UTF8)
      $testAmounts = Read-ComparisonCsv $testCsvPath $testKey $false $true
      if ($testAmounts.orderCount -ne 10 -or $testAmounts.amountRows.Count -ne 10 -or
          $testAmounts.csvCouponOrders -ne 1 -or
          $testAmounts.amountRows[0] -cnotmatch '^[a-f0-9]{64}(\.[a-f0-9]{64}){4}$') {
        throw 'SELF_TEST_FAILED'
      }
      $amountLines += 'SYNTHETIC-0,LINE-EXTRA,90,2026-09-30 12:00:01,101,쿠폰'
      [IO.File]::WriteAllText($testCsvPath,
        (@($amountHeader) + $amountLines -join "`n"), [Text.Encoding]::UTF8)
      try { $null = Read-ComparisonCsv $testCsvPath $testKey $false $true;
        throw 'SELF_TEST_FAILED' }
      catch { if ($_.Exception.Message -cne 'CSV_ORDER_AMOUNT_INCONSISTENT') { throw } }
    } finally { [IO.File]::Delete($testCsvPath) }
    $one = Get-TupleHmac $testKey 'order' @('SYNTHETIC-1')
    $two = Get-TupleHmac $testKey 'paid' @('SYNTHETIC-1', '1.00')
    $failureCode = 'SELF_TEST_PAID_FAILED'
    if ($one -ceq $two -or (Convert-Paid '1') -cne '1.00') { throw 'SELF_TEST_FAILED' }
    $failureCode = 'SELF_TEST_SELECTION_FAILED'
    $testOrders = New-OrdinalSet
    $testItems = New-OrdinalSet
    $testPaid = New-OrdinalSet
    $testApiPaid = [Collections.Generic.List[string]]::new()
    $testMap = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
    foreach ($index in 1..7) {
      $id = "SYNTHETIC-$index"
      $orderDigest = Get-TupleHmac $testKey 'order' @($id)
      $itemDigest = Get-TupleHmac $testKey 'item' @($id, 'LINE-1')
      $paidDigest = Get-TupleHmac $testKey 'paid' @($id, '1.00')
      [void]$testOrders.Add($orderDigest)
      [void]$testItems.Add($itemDigest)
      [void]$testPaid.Add($paidDigest)
      $testMap.Add($paidDigest, $orderDigest)
      $testApiPaid.Add($(if ($index -eq 7) { $paidDigest } else {
        Get-TupleHmac $testKey 'paid' @($id, '2.00') }))
    }
    $testCsv = @{ orderCount = 7; itemCount = 7; orderDigests = $testOrders;
      itemDigests = $testItems; paidDigests = $testPaid; paidToOrder = $testMap }
    $testApi = @{ orderHmacs = @($testOrders); orderItemHmacs = @($testItems);
      orderPaidHmacs = $testApiPaid.ToArray() }
    if ((Select-PaidDifference $testCsv $testApi).Count -ne 6) {
      throw 'SELF_TEST_FAILED'
    }
    $testApi.orderPaidHmacs = @($testPaid)
    if ((Select-PaidDifference $testCsv $testApi -1).Count -ne 0) {
      throw 'SELF_TEST_FAILED'
    }
    $testApi.orderPaidHmacs = @(foreach ($index in 1..7) {
      $id = "SYNTHETIC-$index"
      Get-TupleHmac $testKey 'paid' @($id, $(if ($index -le 3) { '2.00' } else { '1.00' }))
    })
    if ((Select-PaidDifference $testCsv $testApi -1).Count -ne 3) {
      throw 'SELF_TEST_FAILED'
    }
    $failureCode = 'SELF_TEST_DATE_FAILED'
    $testDateMap = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
    $testOrder = Get-TupleHmac $testKey 'order' @('SYNTHETIC-1')
    $testOrderInstants = New-OrdinalSet
    $testPlaceInstants = New-OrdinalSet
    $firstOrderInstant = Get-TupleHmac $testKey 'order-instant' @(
      'SYNTHETIC-1', '2026-09-30T03:00:00.000000Z')
    $firstPlaceInstant = Get-TupleHmac $testKey 'place-instant' @(
      'SYNTHETIC-1', '2026-09-30T03:00:00.000000Z')
    [void]$testOrderInstants.Add($firstOrderInstant)
    [void]$testPlaceInstants.Add($firstPlaceInstant)
    $testDateMap.Add($testOrder, @(
      (Get-TupleHmac $testKey 'order-day' @('SYNTHETIC-1', '2026-09-30')),
      (Get-TupleHmac $testKey 'place-day' @('SYNTHETIC-1', '2026-09-30')),
      $testOrderInstants, $testPlaceInstants
    ))
    $failureCode = 'SELF_TEST_DATE_ROW_FAILED'
    $testOrderSet = New-OrdinalSet
    [void]$testOrderSet.Add($testOrder)
    $testDateCsv = @{ orderCount = 1; orderDigests = $testOrderSet;
      dateHmacs = $testDateMap }
    $testDateApi = @{ rows = ,@($testOrder, $testDateMap[$testOrder][0],
      $firstOrderInstant, $testDateMap[$testOrder][1],
      $firstPlaceInstant); orderCount = 1; placeDatePresentCount = 1;
      naiveOrderDateCount = 0; naivePlaceDateCount = 0;
      timeZoneInterpretation = 'NAIVE_ASSUMED_MALL_KST';
      readComplete = $true; snapshotComplete = $false }
    $failureCode = 'SELF_TEST_DATE_COMPARE_FAILED'
    $testDateResult = Compare-OrderDates $testDateCsv $testDateApi
    if ($testDateResult.orderDayMatches -ne 1 -or
        $testDateResult.placeInstantMatchesAll -ne 1) { throw 'SELF_TEST_FAILED' }
    [void]$testOrderInstants.Add((Get-TupleHmac $testKey 'order-instant' @(
      'SYNTHETIC-1', '2026-09-30T03:00:01.000000Z')))
    [void]$testPlaceInstants.Add((Get-TupleHmac $testKey 'place-instant' @(
      'SYNTHETIC-1', '2026-09-30T03:00:01.000000Z')))
    $multi = Compare-OrderDates $testDateCsv $testDateApi
    if ($multi.csvMultiInstantOrders -ne 1 -or $multi.orderInstantMatchesAny -ne 1 -or
        $multi.orderInstantMatchesAll -ne 0 -or $multi.placeInstantMatchesAll -ne 0) {
      throw 'SELF_TEST_FAILED'
    }
    $testBuckets = Read-SafeCountMap ([ordered]@{ BEFORE_08 = 1;
      FROM_08_TO_BEFORE_10 = 2; AT_OR_AFTER_10 = 3; UNREADABLE = 0 }) @(
      'BEFORE_08', 'FROM_08_TO_BEFORE_10', 'AT_OR_AFTER_10', 'UNREADABLE') 6
    if ($testBuckets.AT_OR_AFTER_10 -ne 3 -or $testBuckets.Count -ne 4) {
      throw 'SELF_TEST_FAILED'
    }
    $safeCouponCells = Read-SuppressedCountMap ([ordered]@{ MATCH = $null;
      FULL = 10 }) @('MATCH', 'FULL') 10
    if ($null -ne $safeCouponCells.MATCH -or $safeCouponCells.FULL -ne 10) {
      throw 'SELF_TEST_FAILED'
    }
    try {
      [void](Read-SuppressedCountMap ([ordered]@{ MATCH = 9 }) @('MATCH') 10)
      throw 'SELF_TEST_FAILED'
    } catch {
      if ($_.Exception.Message -cne 'INVALID_AGGREGATE') { throw }
    }
    $testHandler = [Net.Http.HttpClientHandler]::new()
    $testClient = [Net.Http.HttpClient]::new($testHandler)
    try {
      $testClient.DefaultRequestHeaders.Add('Origin', $origin)
      $testData = [Collections.Generic.Dictionary[string,string]]::new()
      $testData.Add('mode', 'hmac')
      $testContent = [Net.Http.FormUrlEncodedContent]::new($testData)
      try {
        if ($testContent.ReadAsStringAsync().GetAwaiter().GetResult() -cne 'mode=hmac') {
          throw 'SELF_TEST_FAILED'
        }
      } finally { $testContent.Dispose() }
    } finally { $testClient.Dispose(); $testHandler.Dispose() }
    Write-Output 'SELF_TEST_OK'
    return
  }
  if (@(@($CompareOnly, $CompareDates, $CompareOptions, $CompareAmounts, $ObserveOnly,
      $ProbeDetailFields, $ProbeOrderInputs, $BusinessAggregate) |
      Where-Object { $_ }).Count -gt 1 -or
      (($ObserveOnly -or $ProbeDetailFields -or $ProbeOrderInputs -or $BusinessAggregate) -and
        ($CsvPreflight -or -not [string]::IsNullOrWhiteSpace($CsvPath)))) {
    throw 'MODE_CONFLICT'
  }
  if (-not $ObserveOnly -and -not $ProbeDetailFields -and -not $ProbeOrderInputs -and
      -not $BusinessAggregate -and
      [string]::IsNullOrWhiteSpace($CsvPath)) {
    throw 'CSV_PATH_REQUIRED'
  }
  if ($CsvPreflight) {
    $preflightKey = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
    try {
      $preflight = Read-ComparisonCsv $CsvPath $preflightKey ([bool]$CompareOptions) (
        [bool]$CompareAmounts)
      Write-Output (@{ csvOrders = $preflight.orderCount; csvItems = $preflight.itemCount } |
        ConvertTo-Json -Compress)
      return
    } finally { [Array]::Clear($preflightKey, 0, $preflightKey.Length) }
  }
  $secretPath = Join-Path $env:LOCALAPPDATA 'MetaAdsCafe24Isolated/operator-secret.dpapi'
  if (-not [IO.File]::Exists($secretPath)) { throw 'OPERATOR_MISSING' }
  $secure = ConvertTo-SecureString -String ([IO.File]::ReadAllText($secretPath).Trim())
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $operator = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  if ($operator -cnotmatch '^[A-Za-z0-9_-]{43,128}$') { throw 'OPERATOR_INVALID' }
  if ($ObserveOnly -or $ProbeDetailFields -or $ProbeOrderInputs -or $BusinessAggregate) {
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $client = [Net.Http.HttpClient]::new($handler)
    try {
      $client.Timeout = [TimeSpan]::FromMinutes(11)
      $client.MaxResponseContentBufferSize = 196608
      $client.DefaultRequestHeaders.Add('Origin', $origin)
      if ($ObserveOnly) {
        $failureCode = 'REMOTE_OBSERVATION_FAILED'
        $result = Invoke-IsolatedAction $client $operator 'observe' ''
        $failureCode = 'OBSERVATION_SHAPE_INVALID'
        Write-Output ((Read-SafeObservation $result) | ConvertTo-Json -Compress)
      } elseif ($ProbeDetailFields) {
        $failureCode = 'REMOTE_DETAIL_FIELDS_FAILED'
        $result = Invoke-IsolatedAction $client $operator 'detail-fields' ''
        $failureCode = 'DETAIL_FIELDS_SHAPE_INVALID'
        Write-Output ((Read-SafeDetailFields $result) | ConvertTo-Json -Compress -Depth 6)
      } elseif ($ProbeOrderInputs) {
        $failureCode = 'REMOTE_ORDER_INPUT_PROBE_FAILED'
        $result = Invoke-IsolatedAction $client $operator 'probe' ''
        $failureCode = 'ORDER_INPUT_PROBE_INVALID'
        Write-Output ((Read-SafeOrderInputProbe $result) | ConvertTo-Json -Compress -Depth 5)
      } else {
        $failureCode = 'REMOTE_BUSINESS_AGGREGATE_FAILED'
        $result = Invoke-IsolatedAction $client $operator 'business-aggregate' ''
        $failureCode = 'BUSINESS_AGGREGATE_INVALID'
        Write-Output ((Read-SafeBusinessAggregate $result) | ConvertTo-Json -Compress -Depth 5)
      }
      return
    } finally { $client.Dispose(); $handler.Dispose() }
  }
  $key = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
  try {
    $keyText = [Convert]::ToBase64String($key).TrimEnd('=').Replace('+','-').Replace('/','_')
    $csv = Read-ComparisonCsv $CsvPath $key ([bool]$CompareOptions) ([bool]$CompareAmounts)
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $client = [Net.Http.HttpClient]::new($handler)
    try {
      $client.Timeout = [TimeSpan]::FromMinutes(11)
      $client.MaxResponseContentBufferSize = 196608
      $client.DefaultRequestHeaders.Add('Origin', $origin)
      if ($CompareAmounts) {
        $failureCode = 'REMOTE_AMOUNT_COMPARISON_FAILED'
        $result = Invoke-IsolatedAction $client $operator 'amount-compare' $keyText '' '' (
          $csv.amountRows -join ';')
        $failureCode = 'AMOUNT_COMPARISON_INVALID'
        if ($result -isnot [Collections.IDictionary] -or $result.Count -ne 15 -or
            $result.day -cne $day -or
            (Assert-SafeCount $result.orderCount $csv.orderCount) -ne $csv.orderCount -or
            $result.readComplete -isnot [bool] -or $result.readComplete -ne $true -or
            $result.snapshotComplete -isnot [bool] -or $result.snapshotComplete -ne $false -or
            $result.semanticVerified -isnot [bool] -or $result.semanticVerified -ne $false) {
          throw 'AMOUNT_COMPARISON_INVALID'
        }
        $safeCounts = [ordered]@{}
        foreach ($field in @('actualOrderTotal', 'initialOrderTotal',
            'actualPayment', 'initialPayment')) {
          $safeCounts[$field] = Assert-SafeCount $result[$field] $csv.orderCount
        }
        foreach ($field in @('couponFlag', 'couponBoth', 'apiCouponOrders')) {
          if ($null -eq $result[$field]) { $safeCounts[$field] = $null; continue }
          $value = Assert-SafeCount $result[$field] $csv.orderCount
          if ($value -lt 10) { throw 'AMOUNT_COMPARISON_INVALID' }
          $safeCounts[$field] = $value
        }
        $candidateKeys = @('ACTUAL_SUBTOTAL_PLUS_SHIPPING',
          'ACTUAL_SUBTOTAL_PLUS_NET_SHIPPING', 'INITIAL_SUBTOTAL_PLUS_SHIPPING',
          'INITIAL_SUBTOTAL_PLUS_NET_SHIPPING')
        $candidateMatches = Read-SafeCountMap $result.orderTotalCandidateMatches (
          $candidateKeys) $csv.orderCount
        $candidateEvaluated = Read-SafeCountMap $result.orderTotalCandidateEvaluated (
          $candidateKeys) $csv.orderCount
        foreach ($candidate in $candidateKeys) {
          if ($candidateMatches[$candidate] -gt $candidateEvaluated[$candidate]) {
            throw 'AMOUNT_COMPARISON_INVALID'
          }
        }
        $couponInputKeys = @('ACTUAL_ORDER_TOTAL', 'INITIAL_ORDER_TOTAL',
          'ACTUAL_PAYMENT', 'INITIAL_PAYMENT', 'ACTUAL_SIGNED_DELTA',
          'INITIAL_SIGNED_DELTA', 'BOTH_ACTUAL_SIGNED_DELTA',
          'BOTH_INITIAL_SIGNED_DELTA')
        $couponInputs = Read-SuppressedCountMap $result.couponInputMatches (
          $couponInputKeys) $csv.csvCouponOrders
        foreach ($field in @('couponFlag', 'couponBoth', 'apiCouponOrders')) {
          if ($null -eq $safeCounts[$field]) { continue }
          $cohort = if ($field -ceq 'couponFlag') { $csv.orderCount } else {
            $csv.csvCouponOrders }
          $complement = $cohort - $safeCounts[$field]
          if ($complement -gt 0 -and $complement -lt 10) {
            throw 'AMOUNT_COMPARISON_INVALID'
          }
        }
        if ($null -ne $safeCounts.apiCouponOrders) {
          $gap = [Math]::Abs($safeCounts.apiCouponOrders - $csv.csvCouponOrders)
          if ($gap -gt 0 -and $gap -lt 10) { throw 'AMOUNT_COMPARISON_INVALID' }
        }
        foreach ($candidate in $couponInputKeys) {
          if ($null -eq $couponInputs[$candidate]) { continue }
          $cohort = if ($candidate.StartsWith('BOTH_', [StringComparison]::Ordinal)) {
            if ($null -eq $safeCounts.couponBoth) { throw 'AMOUNT_COMPARISON_INVALID' }
            $safeCounts.couponBoth
          } else { $csv.csvCouponOrders }
          $complement = $cohort - $couponInputs[$candidate]
          if ($complement -lt 0 -or ($complement -gt 0 -and $complement -lt 10)) {
            throw 'AMOUNT_COMPARISON_INVALID'
          }
        }
        if ($null -ne $safeCounts.couponBoth) {
          if ($safeCounts.couponBoth -gt $csv.csvCouponOrders -or
              ($null -ne $safeCounts.apiCouponOrders -and
                $safeCounts.couponBoth -gt $safeCounts.apiCouponOrders) -or
              ($null -ne $safeCounts.couponFlag -and
                $safeCounts.couponBoth -gt $safeCounts.couponFlag)) {
            throw 'AMOUNT_COMPARISON_INVALID'
          }
        }
        $csvCouponSafe = if ($csv.csvCouponOrders -ge 10) { $csv.csvCouponOrders } else { $null }
        Write-Output ([ordered]@{ mode = 'AMOUNT_COMPARE'; csvOrders = $csv.orderCount;
          csvCouponOrders = $csvCouponSafe;
          actualOrderTotalMatches = $safeCounts.actualOrderTotal;
          initialOrderTotalMatches = $safeCounts.initialOrderTotal;
          actualPaymentMatches = $safeCounts.actualPayment;
          initialPaymentMatches = $safeCounts.initialPayment;
          couponFlagMatches = $safeCounts.couponFlag;
          couponBothOrders = $safeCounts.couponBoth;
          apiCouponOrders = $safeCounts.apiCouponOrders;
          orderTotalCandidateMatches = $candidateMatches;
          orderTotalCandidateEvaluated = $candidateEvaluated;
          couponInputMatches = $couponInputs;
          readComplete = $true; snapshotComplete = $false;
          semanticVerified = $false } | ConvertTo-Json -Compress)
        return
      }
      if ($CompareOptions) {
        $failureCode = 'REMOTE_OPTION_COMPARISON_FAILED'
        $result = Invoke-IsolatedAction $client $operator 'option-compare' $keyText '' (
          $csv.optionRows -join ';')
        $failureCode = 'OPTION_COMPARISON_INVALID'
        if ($result -isnot [Collections.IDictionary] -or
            (Assert-SafeCount $result.orderCount $csv.orderCount) -ne $csv.orderCount -or
            (Assert-SafeCount $result.itemCount $csv.itemCount) -ne $csv.itemCount -or
            $result.readComplete -isnot [bool] -or $result.readComplete -ne $true -or
            $result.snapshotComplete -isnot [bool] -or $result.snapshotComplete -ne $false -or
            $result.canonicalMappingVerified -isnot [bool] -or
            $result.canonicalMappingVerified -ne $false) { throw 'OPTION_COMPARISON_INVALID' }
        $candidateKeys = @('OPTION_VALUE', 'PRODUCT_NAME', 'PRODUCT_OPTION_PARENS',
          'PRODUCT_SPACE_OPTION_PARENS', 'PRODUCT_SPACE_OPTION')
        $candidates = Read-SafeCountMap $result.optionNameCandidateMatches $candidateKeys $csv.itemCount
        $candidateMismatches = Read-SafeCountMap $result.optionNameCandidateMismatches (
          $candidateKeys) $csv.itemCount
        $productMatches = Assert-SafeCount $result.productNoMatches $csv.itemCount
        $quantityMatches = Assert-SafeCount $result.quantityMatches $csv.itemCount
        $priceMatches = Assert-SafeCount $result.salePriceMatches $csv.itemCount
        $priceWithOptionMatches = Assert-SafeCount $result.salePriceWithOptionMatches $csv.itemCount
        $productMismatches = Assert-SafeCount $result.productNoMismatches $csv.itemCount
        $quantityMismatches = Assert-SafeCount $result.quantityMismatches $csv.itemCount
        $priceMismatches = Assert-SafeCount $result.salePriceMismatches $csv.itemCount
        $priceWithOptionMismatches = Assert-SafeCount $result.salePriceWithOptionMismatches $csv.itemCount
        $optionPriceShapes = Read-SafeCountMap $result.optionPriceShapes @(
          'ABSENT', 'NULL', 'VALUE') $csv.itemCount
        $optionPriceSigns = Read-SafeCountMap $result.optionPriceSigns @(
          'NEGATIVE', 'ZERO', 'POSITIVE') $csv.itemCount
        if ($productMatches + $productMismatches -ne $csv.itemCount -or
            $quantityMatches + $quantityMismatches -ne $csv.itemCount -or
            $priceMatches + $priceMismatches -ne $csv.itemCount -or
            $priceWithOptionMatches + $priceWithOptionMismatches -ne $optionPriceShapes.VALUE -or
            $optionPriceShapes.ABSENT + $optionPriceShapes.NULL + $optionPriceShapes.VALUE -ne
              $csv.itemCount -or
            $optionPriceSigns.NEGATIVE + $optionPriceSigns.ZERO +
              $optionPriceSigns.POSITIVE -ne $optionPriceShapes.VALUE) {
          throw 'OPTION_COMPARISON_INVALID'
        }
        foreach ($candidate in $candidateKeys) {
          if ($candidates[$candidate] + $candidateMismatches[$candidate] -ne $csv.itemCount) {
            throw 'OPTION_COMPARISON_INVALID'
          }
        }
        Write-Output ([ordered]@{ mode = 'OPTION_COMPARE'; csvOrders = $csv.orderCount;
          csvItems = $csv.itemCount; matchedItemKeys = $csv.itemCount;
          productNoMatches = $productMatches; quantityMatches = $quantityMatches;
          salePriceMatches = $priceMatches; productNoMismatches = $productMismatches;
          quantityMismatches = $quantityMismatches; salePriceMismatches = $priceMismatches;
          salePriceWithOptionMatches = $priceWithOptionMatches;
          salePriceWithOptionMismatches = $priceWithOptionMismatches;
          optionPriceShapes = $optionPriceShapes;
          optionPriceSigns = $optionPriceSigns;
          optionNameCandidateMatches = $candidates;
          optionNameCandidateMismatches = $candidateMismatches;
          readComplete = $true; snapshotComplete = $false;
          canonicalMappingVerified = $false } | ConvertTo-Json -Compress -Depth 5)
        return
      }
      $failureCode = 'REMOTE_HMAC_FAILED'
      $api = Invoke-IsolatedAction $client $operator 'hmac' $keyText
      $failureCode = 'COMPARISON_FAILED'
      $selected = Select-PaidDifference $csv $api $(if ($CompareOnly -or $CompareDates) { -1 } else { 6 })
      if ($CompareDates) {
        $failureCode = 'REMOTE_DATE_HMAC_FAILED'
        $apiDates = Invoke-IsolatedAction $client $operator 'date-hmac' $keyText
        $failureCode = 'DATE_COMPARISON_FAILED'
        Write-Output ((Compare-OrderDates $csv $apiDates) | ConvertTo-Json -Compress)
        return
      }
      if ($CompareOnly) {
        Write-Output ([ordered]@{ mode = 'COMPARE_ONLY'; csvOrders = $csv.orderCount;
          csvItems = $csv.itemCount; matchedOrderKeys = $csv.orderCount;
          matchedItemKeys = $csv.itemCount;
          paidMatches = $csv.orderCount - $selected.Count;
          paidDifferences = $selected.Count; snapshotComplete = $false } |
          ConvertTo-Json -Compress)
        return
      }
      $failureCode = 'REMOTE_DIAGNOSIS_FAILED'
      $result = Invoke-IsolatedAction $client $operator 'paid-diagnose' $keyText ($selected -join ',')
      $failureCode = 'DIAGNOSIS_SHAPE_INVALID'
      if ((Assert-SafeCount $result.selectedOrderCount 6) -ne 6 -or
          $result.snapshotComplete -isnot [bool] -or $result.snapshotComplete -ne $false -or
          $result.semanticVerified -isnot [bool] -or $result.semanticVerified -ne $false -or
          $result.shapeReadComplete -isnot [bool]) { throw 'DIAGNOSIS_SHAPE_INVALID' }
      $detailMatched = Assert-SafeCount $result.detailAmountMatchedListCount 6
      $detailUnsupported = Assert-SafeCount $result.unsupportedDetailCount 6
      $timelineRows = Assert-SafeCount $result.timelineRowCount 594
      $timelineUnsupported = Assert-SafeCount $result.unsupportedTimelineRowCount $timelineRows
      if ($detailMatched + $detailUnsupported -ne 6 -or
          $result.settleTypeCodes -isnot [Collections.IDictionary]) {
        throw 'DIAGNOSIS_SHAPE_INVALID'
      }
      $settle = [ordered]@{}
      $settleTotal = 0
      foreach ($code in @('O', 'R', 'P', 'ABSENT', 'OTHER')) {
        if ($result.settleTypeCodes.Contains($code)) {
          $count = Assert-SafeCount $result.settleTypeCodes[$code] $timelineRows
          $settle[$code] = $count
          $settleTotal += $count
        }
      }
      if ($result.settleTypeCodes.Count -ne $settle.Count -or
          $settleTotal + $timelineUnsupported -ne $timelineRows) {
        throw 'DIAGNOSIS_SHAPE_INVALID'
      }
      $bucketKeys = @('BEFORE_08', 'FROM_08_TO_BEFORE_10', 'AT_OR_AFTER_10', 'UNREADABLE')
      $createdBuckets = Read-SafeCountMap $result.createdTimeBuckets $bucketKeys $timelineRows
      $zones = Read-SafeCountMap $result.createdTimeZoneCounts @(
        'EXPLICIT_OFFSET', 'NAIVE_ASSUMED_MALL_KST', 'UNREADABLE') $timelineRows
      $createdByType = $result.createdTimeBySettleType
      if ($createdByType -isnot [Collections.IDictionary] -or $createdByType.Count -ne 5) {
        throw 'DIAGNOSIS_SHAPE_INVALID'
      }
      $allTypeBuckets = [ordered]@{}
      foreach ($code in @('O', 'R', 'P', 'ABSENT', 'OTHER')) {
        if (-not $createdByType.Contains($code)) { throw 'DIAGNOSIS_SHAPE_INVALID' }
        $allTypeBuckets[$code] = Read-SafeCountMap $createdByType[$code] $bucketKeys $timelineRows
      }
      $bucketTotal = 0
      foreach ($count in $createdBuckets.Values) { $bucketTotal += $count }
      $zoneTotal = 0
      foreach ($count in $zones.Values) { $zoneTotal += $count }
      $typeTotal = 0
      foreach ($typeBuckets in $allTypeBuckets.Values) {
        foreach ($count in $typeBuckets.Values) { $typeTotal += $count }
      }
      if ($bucketTotal -ne $timelineRows -or $zoneTotal -ne $timelineRows -or
          $typeTotal -ne $timelineRows) { throw 'DIAGNOSIS_SHAPE_INVALID' }
      $lateOrders = Assert-SafeCount $result.ordersWithCreatedAtOrAfter10 6
      $safe = [ordered]@{ csvOrders = $csv.orderCount; csvItems = $csv.itemCount;
        matchedOrderKeys = $csv.orderCount; matchedItemKeys = $csv.itemCount;
        paidDifferences = 6; detailAmountMatchedListCount = $detailMatched;
        unsupportedDetailCount = $detailUnsupported;
        timelineRowCount = $timelineRows;
        unsupportedTimelineRowCount = $timelineUnsupported;
        settleTypeCodes = $settle;
        createdTimeBuckets = $createdBuckets;
        createdTimeZoneCounts = $zones;
        createdTimeBySettleType = $allTypeBuckets;
        ordersWithCreatedAtOrAfter10 = $lateOrders;
        shapeReadComplete = $result.shapeReadComplete;
        semanticVerified = $false; snapshotComplete = $false;
        temporalComparison = 'NOT_ASSESSED' }
      Write-Output ($safe | ConvertTo-Json -Compress -Depth 8)
    } finally { $client.Dispose(); $handler.Dispose() }
  } finally { [Array]::Clear($key, 0, $key.Length) }
} catch {
  $safeLocalCodes = @('MODE_CONFLICT', 'CSV_PATH_REQUIRED',
    'CSV_MISSING', 'CSV_EMPTY', 'CSV_HEADER_INVALID',
    'CSV_ROW_SHAPE', 'CSV_ROW_LIMIT', 'CSV_KEY_OR_DAY_INVALID',
    'CSV_ORDER_PAID_INCONSISTENT', 'CSV_ORDER_DATE_INCONSISTENT',
    'CSV_ORDER_AMOUNT_INCONSISTENT', 'CSV_ORDER_AMOUNT_LIMIT',
    'CSV_PAYMENT_METHOD_INVALID',
    'CSV_DUPLICATE_DIGEST', 'CSV_DUPLICATE_ITEM', 'CSV_PRODUCT_SHAPE',
    'CSV_QUANTITY_SHAPE', 'CSV_OPTION_SHAPE', 'INVALID_PAID_SHAPE')
  if ($failureCode -ceq 'LOCAL_INPUT_INVALID' -and
      $_.Exception.Message -cin $safeLocalCodes) {
    $failureCode = $_.Exception.Message
  }
  Write-Output $failureCode
  exit 1
}
