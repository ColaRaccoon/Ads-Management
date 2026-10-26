-- Google-only sale configuration; existing exact mappings retain their meaning.
ALTER TABLE google_performance_mappings
  ADD COLUMN option_scope varchar(16) NOT NULL DEFAULT 'EXACT',
  ADD COLUMN sale_price_krw_override numeric(14,2),
  ADD COLUMN product_cost_krw_override numeric(14,2),
  ADD COLUMN shipping_krw_override numeric(14,2),
  ADD COLUMN extra_cost_krw_override numeric(14,2),
  ADD COLUMN sale_unit_label varchar(64),
  ADD CONSTRAINT google_mapping_option_scope CHECK (option_scope IN ('EXACT','PRODUCT')),
  ADD CONSTRAINT google_mapping_product_scope CHECK (option_scope <> 'PRODUCT' OR (kind='SALE' AND option_name='')),
  ADD CONSTRAINT google_mapping_configuration_complete CHECK (
    num_nonnulls(sale_price_krw_override,product_cost_krw_override,shipping_krw_override,extra_cost_krw_override) IN (0,4)),
  ADD CONSTRAINT google_mapping_unit_label_configuration CHECK (sale_unit_label IS NULL OR sale_price_krw_override IS NOT NULL),
  ADD CONSTRAINT google_mapping_configuration_nonnegative CHECK (
    sale_price_krw_override BETWEEN 0 AND 999999999999.99 AND product_cost_krw_override BETWEEN 0 AND 999999999999.99
    AND shipping_krw_override BETWEEN 0 AND 999999999999.99 AND extra_cost_krw_override BETWEEN 0 AND 999999999999.99),
  ADD CONSTRAINT google_mapping_campaign_configuration CHECK (
    kind='SALE' OR (option_scope='EXACT' AND sale_price_krw_override IS NULL AND product_cost_krw_override IS NULL
      AND shipping_krw_override IS NULL AND extra_cost_krw_override IS NULL AND sale_unit_label IS NULL));

-- Product-wide ranges overlap every exact option range, including future options.
-- Exact options occupy stable 64-bit hash points. A hash collision can only reject
-- an otherwise valid write (fail closed), never permit overlapping allocations.
ALTER TABLE google_performance_mappings ADD CONSTRAINT google_sale_scope_no_overlap
  EXCLUDE USING gist (
    connection_id WITH =,
    product_no WITH =,
    (CASE WHEN option_scope='PRODUCT' THEN numrange(NULL,NULL)
      ELSE numrange(hashtextextended(option_name,0)::numeric,hashtextextended(option_name,0)::numeric,'[]') END) WITH &&,
    daterange(start_date,end_date,'[]') WITH &&
  ) WHERE (kind='SALE');
