// Offline only. Diagnostic predicates mirror the strict PURCHASE_V1 proof; never authorize zero inference.
import {Prisma} from '@prisma/client';
import {selectMetaMcpDay} from '../../../apps/api/src/daily-sync/meta-mcp-capture.ts';
import {createMetaMcpResidualProof} from '../../../apps/api/src/daily-sync/meta-mcp-residual-proof.ts';
const LEVELS=['ad','adset','campaign','ad_account'];
const COUNT_DEFINITION="The number of purchase events attributed to your ads, based on information received from one or more of your connected Meta Business Tools, or that occur directly on Meta technologies. This doesn't include purchases from messaging ads delivered to and from Europe and Japan.";
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const validInteger=v=>typeof v==='string'&&/^(0|[1-9]\d{0,9})$/.test(v)&&BigInt(v)<=2147483647n;
const validMoney=v=>object(v)&&v.unit==='USD'&&typeof v.value==='string'&&/^(0|[1-9]\d{0,9})(\.\d{1,4})?$/.test(v.value);
export function inspectPurchaseGates(capture,catalog){
 const result={diagnosticVersion:1,firstCandidate:null,gateCounts:{},parents:[],parentCount:0,parentDetailsTruncated:false,providerRequests:0,rawValuesReturned:0};
 const add=(reason,level='ALL',pair='CANONICAL')=>{if(!result.firstCandidate)result.firstCandidate=reason;const code=reason+':'+level.toUpperCase()+':'+pair;result.gateCounts[code]=(result.gateCounts[code]??0)+1;};
 let selected;try{selected=selectMetaMcpDay(capture);}catch{add('CAPTURE_SELECTION_INVALID');return result;}const wire=selected.wire;
 if(wire.profile!=='PURCHASE_V1')add('PURCHASE_PROFILE_INVALID');
 if(!object(catalog)||catalog.version!==1||catalog.client_conversation_id!==wire.clientConversationId||catalog.server!=='https://mcp.facebook.com/ads'||catalog.tool!=='ads_get_field_context'||!Array.isArray(catalog.fields))add('PURCHASE_CATALOG_SCOPE');
 else for(const [name,type,description]of [['omni_purchase','INTEGER',COUNT_DEFINITION],['omni_purchase_values','CURRENCY','The total value of purchases.']]){
  const matches=catalog.fields.filter(field=>object(field)&&field.name===name);if(matches.length!==1)add('PURCHASE_CATALOG_CARDINALITY');else{const field=matches[0];if(field.type!==type||field.is_metric!==true||field.description!==description||!Array.isArray(field.levels)||[...field.levels].sort().join()!==[...LEVELS].sort().join())add('PURCHASE_CATALOG_DEFINITION');}
 }
 for(const level of LEVELS)for(const row of wire.levels[level])for(const [count,value,pair]of [['omni_purchase','omni_purchase_values','CANONICAL'],['offsite_conversion_fb_pixel_purchase','offsite_conversion_fb_pixel_purchase_values','PIXEL_ALIAS']]){
  if((row[count]===null)!==(row[value]===null))add('PURCHASE_NULL_PAIR_MISMATCH',level,pair);
  if(row[count]!==null&&!validInteger(row[count]))add('PURCHASE_COUNT_FORMAT',level,pair);
  if(row[count]!==null&&validInteger(row[count])&&BigInt(row[count])===0n&&object(row[value])){try{if(!new Prisma.Decimal(row[value].value).isZero())add('ZERO_COUNT_NONZERO_VALUE',level,pair);}catch{add('PURCHASE_VALUE_FORMAT',level,pair);}}
 }
 if(wire.levels.ad.some(row=>row.link_click===null))try{createMetaMcpResidualProof(wire,catalog);}catch{add('LINK_RESIDUAL_FAILED');}
 for(const [level,rows]of [['ad',wire.levels.ad],['adset',selected.selectedAdsets],['campaign',wire.levels.campaign],['ad_account',wire.levels.ad_account]])for(const row of rows){
  if(row.omni_purchase===null){if(row.omni_purchase_values!==null)add('TARGET_NULL_HAS_VALUE',level);}
  else if(!validMoney(row.omni_purchase_values))add('PURCHASE_VALUE_FORMAT',level);
 }
 const total=(rows,field)=>{if(rows.some(row=>row[field]!==null&&!validInteger(row[field])))return null;return rows.reduce((sum,row)=>sum+(row[field]===null?0n:BigInt(row[field])),0n);};
 const compare=(parent,children,descendants,level,ordinal)=>{
  const item={level:level.toUpperCase(),ordinal,parentPurchasePresent:validInteger(parent.omni_purchase),childrenKnownPurchaseEqualsParent:false,descendantKnownPurchaseEqualsParent:false,childrenSpendEqualsParent:false,childrenImpressionsEqualParent:false,descendantImpressionsEqualParent:false,childrenClicksEqualParent:false,descendantClicksEqualParent:false,childrenLinksEqualParent:false,descendantLinksEqualParent:false,parentValueValid:validMoney(parent.omni_purchase_values),descendantValuesValid:descendants.filter(row=>row.omni_purchase_values!==null).every(row=>validMoney(row.omni_purchase_values))};
  if(!item.parentPurchasePresent)add('PARENT_PURCHASE_COUNT_INVALID',level);
  const parentCount=item.parentPurchasePresent?BigInt(parent.omni_purchase):null;
  item.childrenKnownPurchaseEqualsParent=parentCount!==null&&total(children,'omni_purchase')===parentCount;
  item.descendantKnownPurchaseEqualsParent=parentCount!==null&&total(descendants,'omni_purchase')===parentCount;
  if(!item.childrenKnownPurchaseEqualsParent)add('CHILD_PURCHASE_RESIDUAL_NONZERO',level);
  if(!item.descendantKnownPurchaseEqualsParent)add('AD_PURCHASE_RESIDUAL_NONZERO',level);
  try{item.childrenSpendEqualsParent=children.reduce((sum,row)=>sum.plus(row.amount_spent.value),new Prisma.Decimal(0)).eq(parent.amount_spent.value);}catch{}
  if(!item.childrenSpendEqualsParent)add('CHILD_SPEND_MISMATCH',level);
  for(const [field,label]of [['impressions','Impressions'],['clicks','Clicks'],['link_click','Links']]){
   const valid=validInteger(parent[field]),expected=valid?BigInt(parent[field]):null;
   item['children'+label+'EqualParent']=valid&&total(children,field)===expected;item['descendant'+label+'EqualParent']=valid&&total(descendants,field)===expected;
   if(!item['children'+label+'EqualParent'])add('CHILD_'+label.toUpperCase()+'_MISMATCH',level);
   if(!item['descendant'+label+'EqualParent'])add('AD_'+label.toUpperCase()+'_MISMATCH',level);
  }
  if(!item.parentValueValid||!item.descendantValuesValid)add('PARENT_OR_AD_VALUE_FORMAT',level);
  result.parentCount++;if(result.parents.length<200)result.parents.push(item);else result.parentDetailsTruncated=true;
 };
 selected.selectedAdsets.forEach((parent,index)=>{const children=wire.levels.ad.filter(row=>row.adset_id===parent.id);compare(parent,children,children,'adset',index);});
 wire.levels.campaign.forEach((parent,index)=>compare(parent,selected.selectedAdsets.filter(row=>row.campaign_id===parent.id),wire.levels.ad.filter(row=>row.campaign_id===parent.id),'campaign',index));
 compare(wire.levels.ad_account[0],wire.levels.campaign,wire.levels.ad,'ad_account',0);
 return result;
}
