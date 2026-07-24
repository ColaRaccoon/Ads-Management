-- Read-only pre-migration audit. This script does not modify data.
SELECT count(*) AS product_count FROM coupang_products;
SELECT count(*) AS cost_rule_count FROM coupang_cost_rules;

SELECT p.id AS product_id, p.display_name, count(r.id) AS history_count
FROM coupang_products p
LEFT JOIN coupang_cost_rules r ON r.coupang_product_id = p.id
GROUP BY p.id, p.display_name
ORDER BY history_count DESC, p.display_name;

SELECT r.coupang_product_id, p.display_name, r.effective_from, count(*) AS duplicate_count,
       json_agg(json_build_object(
         'id', r.id, 'salePriceKrw', r.sale_price_krw, 'supplyPriceKrw', r.supply_price_krw,
         'productCostKrw', r.product_cost_krw, 'sellerShippingFeeKrw', r.seller_shipping_fee_krw,
         'hanaroShippingFeeKrw', r.hanaro_shipping_fee_krw, 'growthInboundFeeKrw', r.growth_inbound_fee_krw,
         'growthShippingFeeKrw', r.growth_shipping_fee_krw, 'returnRate', r.return_rate,
         'returnCostPerUnitKrw', r.return_cost_per_unit_krw, 'extraCostKrw', r.extra_cost_krw,
         'effectiveTo', r.effective_to, 'createdAt', r.created_at, 'updatedAt', r.updated_at
       ) ORDER BY r.created_at DESC, r.id DESC) AS rows
FROM coupang_cost_rules r
JOIN coupang_products p ON p.id = r.coupang_product_id
GROUP BY r.coupang_product_id, p.display_name, r.effective_from
HAVING count(*) > 1
ORDER BY p.display_name, r.effective_from;

SELECT earlier.id AS earlier_id, later.id AS later_id, earlier.coupang_product_id,
       earlier.effective_from AS earlier_from, earlier.effective_to AS earlier_to,
       later.effective_from AS later_from, later.effective_to AS later_to
FROM coupang_cost_rules earlier
JOIN coupang_cost_rules later
  ON later.coupang_product_id = earlier.coupang_product_id
 AND later.id <> earlier.id
 AND daterange(earlier.effective_from, coalesce(earlier.effective_to, 'infinity'::date), '[]')
     && daterange(later.effective_from, coalesce(later.effective_to, 'infinity'::date), '[]')
WHERE earlier.id < later.id;

SELECT * FROM coupang_cost_rules WHERE effective_to IS NOT NULL AND effective_to < effective_from;
SELECT count(*) AS seller_shipping_fee_not_2800
FROM coupang_cost_rules
WHERE seller_shipping_fee_krw IS NULL OR seller_shipping_fee_krw <> 2800;
