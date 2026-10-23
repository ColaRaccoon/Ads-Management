param(
  [Parameter(Mandatory=$true)][string]$CsvPath,
  [Parameter(Mandatory=$true)][ValidatePattern('^\d{4}-\d{2}-\d{2}$')][string]$Day,
  [Parameter(Mandatory=$true)][ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$ExpectedSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Amount([string]$raw, [int]$scale) {
  $text = $raw.Trim()
  if ($text -cnotmatch "^(0|[1-9][0-9]{0,14})(?:\.[0-9]{1,$scale})?$") {
    throw 'INVALID_AMOUNT'
  }
  return [decimal]::Parse($text, [Globalization.NumberStyles]::AllowDecimalPoint,
    [Globalization.CultureInfo]::InvariantCulture)
}

try {
  if (-not [IO.File]::Exists($CsvPath)) { throw 'CSV_MISSING' }
  if ((Get-FileHash -LiteralPath $CsvPath -Algorithm SHA256).Hash -cne
      $ExpectedSha256.ToUpperInvariant()) { throw 'CSV_HASH_MISMATCH' }
  $parser = [Microsoft.VisualBasic.FileIO.TextFieldParser]::new($CsvPath,
    [Text.Encoding]::UTF8)
  $parser.SetDelimiters(',')
  $parser.HasFieldsEnclosedInQuotes = $true
  $orders = [Collections.Generic.Dictionary[string,object]]::new(
    [StringComparer]::Ordinal)
  $itemKeys = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $methodLabels = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $itemCount = 0
  $itemPriceTimesQuantity = [decimal]0
  try {
    if ($parser.EndOfData) { throw 'CSV_EMPTY' }
    $header = $parser.ReadFields()
    $required = @('주문번호', '품목별 주문번호', '총 주문금액', '총 결제금액',
      '판매가', '수량', '결제수단', '발주일')
    $indexes = @{}
    foreach ($name in $required) {
      $positions = @(0..($header.Length - 1) | Where-Object { $header[$_] -ceq $name })
      if ($positions.Count -ne 1) { throw 'CSV_HEADER_INVALID' }
      $indexes[$name] = [int]$positions[0]
    }
    $optionalColumns = @('취소금액', '환불금액', '쿠폰할인금액', '할인금액', '배송비')
    $availableOptional = @($optionalColumns | Where-Object { $header -ccontains $_ })
    while (-not $parser.EndOfData) {
      $fields = $parser.ReadFields()
      if ($fields.Length -ne $header.Length) { throw 'CSV_ROW_SHAPE' }
      $itemCount += 1
      if ($itemCount -gt 10000) { throw 'CSV_ROW_LIMIT' }
      $orderId = $fields[$indexes['주문번호']].Trim()
      $itemId = $fields[$indexes['품목별 주문번호']].Trim()
      $date = $fields[$indexes['발주일']].Trim()
      if ($orderId -cnotmatch '^[A-Za-z0-9_-]{1,128}$' -or
          $itemId -cnotmatch '^[A-Za-z0-9_-]{1,128}$' -or
          ($date -ne '' -and $date -cnotmatch "^$Day(?: [0-9]{2}:[0-9]{2}:[0-9]{2})?$")) {
        throw 'CSV_KEY_OR_DAY_INVALID'
      }
      if (-not $itemKeys.Add("$orderId`0$itemId")) { throw 'CSV_DUPLICATE_ITEM' }
      $orderPrice = Amount $fields[$indexes['총 주문금액']] 2
      $paid = Amount $fields[$indexes['총 결제금액']] 2
      $salePrice = Amount $fields[$indexes['판매가']] 2
      $quantity = Amount $fields[$indexes['수량']] 4
      $method = $fields[$indexes['결제수단']].Trim()
      if ($method.Length -gt 128 -or $method -match '[\u0000-\u001f\u007f]') {
        throw 'CSV_METHOD_SHAPE'
      }
      $itemPriceTimesQuantity += $salePrice * $quantity
      if ($orders.ContainsKey($orderId)) {
        $previous = $orders[$orderId]
        if ($previous.orderPrice -ne $orderPrice -or $previous.paid -ne $paid -or
            $previous.method -cne $method) { throw 'CSV_ORDER_FIELDS_INCONSISTENT' }
      } else {
        $orders.Add($orderId, [pscustomobject]@{
          orderPrice = $orderPrice; paid = $paid; method = $method })
      }
    }
    $orderPriceTotal = [decimal]0
    $paidTotal = [decimal]0
    $below = 0; $equal = 0; $above = 0; $nonemptyMethods = 0
    $couponTokenOrders = 0
    foreach ($order in $orders.Values) {
      $orderPriceTotal += $order.orderPrice
      $paidTotal += $order.paid
      if ($order.orderPrice -lt $order.paid) { $below += 1 }
      elseif ($order.orderPrice -eq $order.paid) { $equal += 1 }
      else { $above += 1 }
      if ($order.method -ne '') {
        $nonemptyMethods += 1
        $null = $methodLabels.Add($order.method)
        $tokens = $order.method.Normalize([Text.NormalizationForm]::FormKC).Split(',')
        if (@($tokens | ForEach-Object { $_.Trim() } | Where-Object { $_ -ceq '쿠폰' }).Count -gt 0) {
          $couponTokenOrders += 1
        }
      }
    }
    if ($orders.Count -gt 0 -and $orders.Count -lt 10) {
      throw 'CSV_AGGREGATE_SUPPRESSED'
    }
    $culture = [Globalization.CultureInfo]::InvariantCulture
    Write-Output ([ordered]@{ day = $Day; orderCount = $orders.Count;
      itemCount = $itemCount;
      orderPriceTotalKrw = $orderPriceTotal.ToString('F2', $culture);
      paidTotalKrw = $paidTotal.ToString('F2', $culture);
      itemPriceTimesQuantityTotalKrw = $itemPriceTimesQuantity.ToString('F2', $culture);
      orderPriceBelowPaid = $below; orderPriceEqualPaid = $equal;
      orderPriceAbovePaid = $above;
      paymentMethodNonemptyOrders = $nonemptyMethods;
      distinctPaymentMethodLabels = $methodLabels.Count;
      couponTokenOrders = $couponTokenOrders;
      availableOptionalAmountColumns = $availableOptional;
      source = 'CSV_ORDER_ONCE'; semanticVerified = $false } |
      ConvertTo-Json -Compress -Depth 3)
  } finally { $parser.Close() }
} catch {
  $codes = @('CSV_MISSING', 'CSV_HASH_MISMATCH', 'CSV_EMPTY', 'CSV_HEADER_INVALID',
    'CSV_ROW_SHAPE', 'CSV_ROW_LIMIT', 'CSV_KEY_OR_DAY_INVALID', 'CSV_DUPLICATE_ITEM',
    'CSV_ORDER_FIELDS_INCONSISTENT', 'CSV_METHOD_SHAPE', 'INVALID_AMOUNT',
    'CSV_AGGREGATE_SUPPRESSED')
  $code = if ($_.Exception.Message -cin $codes) { $_.Exception.Message }
    else { 'CSV_BUSINESS_COMPARE_FAILED' }
  Write-Output $code
  exit 1
}
