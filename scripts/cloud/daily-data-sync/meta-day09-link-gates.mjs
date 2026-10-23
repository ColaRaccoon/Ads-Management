// Offline diagnostic only. This result never authorizes normalization or publishing.
import {Prisma} from '@prisma/client';
import {selectMetaMcpDay} from '../../../apps/api/src/daily-sync/meta-mcp-capture.ts';
import {createMetaMcpResidualProof} from '../../../apps/api/src/daily-sync/meta-mcp-residual-proof.ts';
const DEFINITION='The number of clicks on links within the ad that led to advertiser-specified destinations, on or off Meta technologies.';
const levels=['ad','adset','campaign','ad_account'];
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const integer=x=>{if(typeof x!=='string'||!/^(0|[1-9]\d{0,18})$/.test(x)||BigInt(x)>9223372036854775807n)throw Error('SCALAR');return BigInt(x);};
const spend=x=>{if(!object(x.amount_spent)||x.amount_spent.unit!=='USD'||typeof x.amount_spent.value!=='string')throw Error('SCALAR');const n=new Prisma.Decimal(x.amount_spent.value);if(n.isNegative()||n.decimalPlaces()>4||n.gte('10000000000'))throw Error('SCALAR');return n;};
export function inspectDay09LinkGates(capture,catalog){
 const result={classification:'MANUAL_DIAGNOSTIC',day:'2026-10-09',stage:'LINK_GATE_DIAGNOSTIC',originalProofAccepted:false,firstRejectGate:'CAPTURE_SELECTION_INVALID',nullCounts:{ads:0,adsets:0,campaigns:0,account:0},parentCount:0,parentDetailsTruncated:false,parents:[],accountLinkObserved:false,accountKnownCampaignLinksEqual:false,accountKnownAdsetLinksEqual:false,accountKnownAdLinksEqual:false,accountAdSpendPreserved:false,accountAdsetSpendPreserved:false,accountAdImpressionsPreserved:false,accountAdsetImpressionsPreserved:false,accountAdClicksPreserved:false,accountAdsetClicksPreserved:false,candidateParentZeroCount:0,candidateStrictZeroParentDerivationPossible:false,providerRequests:0,databaseWrites:0,rawValuesReturned:0};
 let selected;try{if(capture?.day!=='2026-10-09'||capture?.accountId!=='2138525300002203')return result;selected=selectMetaMcpDay(capture);}catch{return result;}
 const wire=selected.wire,sets=selected.selectedAdsets,campaigns=wire.levels.campaign,ads=wire.levels.ad,account=wire.levels.ad_account[0];
 result.nullCounts={ads:ads.filter(r=>r.link_click===null).length,adsets:sets.filter(r=>r.link_click===null).length,campaigns:campaigns.filter(r=>r.link_click===null).length,account:wire.levels.ad_account.filter(r=>r.link_click===null).length};
 const fields=object(catalog)&&Array.isArray(catalog.fields)?catalog.fields.filter(f=>object(f)&&f.name==='link_click'):[];
 const catalogValid=object(catalog)&&catalog.version===1&&catalog.server==='https://mcp.facebook.com/ads'&&catalog.tool==='ads_get_field_context'&&catalog.client_conversation_id===wire.clientConversationId&&fields.length===1&&fields[0].type==='INTEGER'&&fields[0].is_metric===true&&fields[0].description===DEFINITION&&Array.isArray(fields[0].levels)&&[...fields[0].levels].sort().join()===[...levels].sort().join();
 if(!catalogValid){result.firstRejectGate='LINK_CATALOG_INVALID';return result;}if(result.nullCounts.ads===0){result.firstRejectGate='NO_NULL_AD_LINKS';return result;}
 try{
  const scoped=[...ads,...sets,...campaigns,account];for(const row of scoped){spend(row);for(const key of ['impressions','clicks','reach'])integer(row[key]);if(typeof row.frequency!=='string'||!/^(0|[1-9]\d{0,5})(\.\d{1,6})?$/.test(row.frequency))throw Error('SCALAR');if(row.link_click!==null)integer(row.link_click);}
  const total=(rows,key)=>rows.reduce((sum,row)=>sum+(row[key]===null?0n:integer(row[key])),0n),sumSpend=rows=>rows.reduce((sum,row)=>sum.plus(spend(row)),new Prisma.Decimal(0));
  result.accountLinkObserved=account.link_click!==null;
  const observed=result.accountLinkObserved?integer(account.link_click):null;
  result.accountKnownCampaignLinksEqual=observed!==null&&total(campaigns,'link_click')===observed;result.accountKnownAdsetLinksEqual=observed!==null&&total(sets,'link_click')===observed;result.accountKnownAdLinksEqual=observed!==null&&total(ads,'link_click')===observed;
  for(const[label,rows]of [['Ad',ads],['Adset',sets]]){result['account'+label+'SpendPreserved']=sumSpend(rows).eq(spend(account));for(const[key,metric]of [['impressions','Impressions'],['clicks','Clicks']])result['account'+label+metric+'Preserved']=total(rows,key)===integer(account[key]);}
  const effectiveCampaign=new Map(),effectiveSet=new Map();
  for(const row of campaigns)if(row.link_click!==null)effectiveCampaign.set(row.id,integer(row.link_click));else if(result.accountKnownCampaignLinksEqual){effectiveCampaign.set(row.id,0n);result.candidateParentZeroCount++;}
  for(const parent of campaigns){const target=effectiveCampaign.get(parent.id),children=sets.filter(row=>row.campaign_id===parent.id),canDerive=target!==undefined&&total(children,'link_click')===target;for(const row of children)if(row.link_click!==null)effectiveSet.set(row.id,integer(row.link_click));else if(canDerive){effectiveSet.set(row.id,0n);result.candidateParentZeroCount++;}}
  let conservation=true;
  const check=(parent,children,descendants,level,ordinal,effective)=>{
   const value=parent.link_click!==null?integer(parent.link_click):effective;
   const item={level,ordinal,parentLinkObserved:parent.link_click!==null,candidateParentZero:parent.link_click===null&&value===0n,childrenKnownLinksEqual:value!==undefined&&total(children,'link_click')===value,descendantKnownLinksEqual:value!==undefined&&total(descendants,'link_click')===value,spendPreserved:sumSpend(children).eq(spend(parent)),impressionsPreserved:total(children,'impressions')===integer(parent.impressions),clicksPreserved:total(children,'clicks')===integer(parent.clicks)};
   if(!item.childrenKnownLinksEqual||!item.descendantKnownLinksEqual||!item.spendPreserved||!item.impressionsPreserved||!item.clicksPreserved)conservation=false;result.parentCount++;if(result.parents.length<200)result.parents.push(item);else result.parentDetailsTruncated=true;
  };
  sets.forEach((row,i)=>{const children=ads.filter(ad=>ad.adset_id===row.id);check(row,children,children,'ADSET',i,effectiveSet.get(row.id));});campaigns.forEach((row,i)=>check(row,sets.filter(set=>set.campaign_id===row.id),ads.filter(ad=>ad.campaign_id===row.id),'CAMPAIGN',i,effectiveCampaign.get(row.id)));check(account,campaigns,ads,'AD_ACCOUNT',0,undefined);
  const direct=result.accountLinkObserved&&result.accountKnownCampaignLinksEqual&&result.accountKnownAdsetLinksEqual&&result.accountKnownAdLinksEqual&&result.accountAdSpendPreserved&&result.accountAdsetSpendPreserved&&result.accountAdImpressionsPreserved&&result.accountAdsetImpressionsPreserved&&result.accountAdClicksPreserved&&result.accountAdsetClicksPreserved;
  result.candidateStrictZeroParentDerivationPossible=direct&&conservation&&result.nullCounts.account===0&&result.candidateParentZeroCount===result.nullCounts.adsets+result.nullCounts.campaigns;
  result.firstRejectGate=result.nullCounts.adsets+result.nullCounts.campaigns+result.nullCounts.account>0?'PARENT_LINK_NULL':!conservation?'PARENT_LINK_OR_BASE_CONSERVATION':!direct?'ACCOUNT_LINK_OR_BASE_CONSERVATION':'NONE';
  try{createMetaMcpResidualProof(wire,catalog);result.originalProofAccepted=true;}catch{if(result.firstRejectGate==='NONE')result.firstRejectGate='ORIGINAL_LINK_PROOF_REJECTED';}
  return result;
 }catch{result.firstRejectGate='LINK_OR_BASE_SCALAR_INVALID';return result;}
}
export function projectDay09LinkGates(value){
 const booleans=['originalProofAccepted','parentDetailsTruncated','accountLinkObserved','accountKnownCampaignLinksEqual','accountKnownAdsetLinksEqual','accountKnownAdLinksEqual','accountAdSpendPreserved','accountAdsetSpendPreserved','accountAdImpressionsPreserved','accountAdsetImpressionsPreserved','accountAdClicksPreserved','accountAdsetClicksPreserved','candidateStrictZeroParentDerivationPossible','offlineOnly','originalFailureReproduced'];
 const counts=['parentCount','candidateParentZeroCount','providerRequests','databaseWrites','rawValuesReturned'];
 const fixed=['state','classification','day','stage','firstRejectGate','nullCounts','parents',...booleans,...counts];
 if(!object(value)||Object.keys(value).sort().join()!==fixed.sort().join()||value.state!=='PHASE08_META_DAY09_LINK_GATES'||value.classification!=='MANUAL_DIAGNOSTIC'||value.day!=='2026-10-09'||value.stage!=='LINK_GATE_DIAGNOSTIC'||!['CAPTURE_SELECTION_INVALID','LINK_CATALOG_INVALID','NO_NULL_AD_LINKS','PARENT_LINK_NULL','PARENT_LINK_OR_BASE_CONSERVATION','ACCOUNT_LINK_OR_BASE_CONSERVATION','ORIGINAL_LINK_PROOF_REJECTED','LINK_OR_BASE_SCALAR_INVALID','NONE'].includes(value.firstRejectGate)||booleans.some(k=>typeof value[k]!=='boolean')||!value.offlineOnly||value.originalFailureReproduced||counts.some(k=>!Number.isSafeInteger(value[k])||value[k]<0||value[k]>50000)||value.providerRequests!==0||value.databaseWrites!==0||value.rawValuesReturned!==0)throw Error('LINK_PUBLIC_REJECTED');
 if(!object(value.nullCounts)||Object.keys(value.nullCounts).sort().join()!=='account,ads,adsets,campaigns'||Object.values(value.nullCounts).some(x=>!Number.isSafeInteger(x)||x<0||x>50000)||!Array.isArray(value.parents)||value.parents.length>200)throw Error('LINK_PUBLIC_REJECTED');
 const fields=['parentLinkObserved','candidateParentZero','childrenKnownLinksEqual','descendantKnownLinksEqual','spendPreserved','impressionsPreserved','clicksPreserved'];
 for(const row of value.parents)if(!object(row)||Object.keys(row).sort().join()!==['level','ordinal',...fields].sort().join()||!['ADSET','CAMPAIGN','AD_ACCOUNT'].includes(row.level)||!Number.isSafeInteger(row.ordinal)||row.ordinal<0||row.ordinal>50000||fields.some(k=>typeof row[k]!=='boolean'))throw Error('LINK_PUBLIC_REJECTED');
 return structuredClone(value);
}
