// Entirely synthetic raw Orders/Items. No sealed normalized or live input is used.
export const MALL='phase10epochfixture',SHOP='shop1',ACCESS='synthetic-epoch-access-never-a-real-provider-credential';
export const CONNECTION='d52af7cb-2f90-48a5-a21c-18ca2ea677fa';
const fail=()=>{throw Error('SYNTHETIC_FIXTURE_SCOPE_REJECTED');};
const clone=value=>JSON.parse(JSON.stringify(value));
export function makeRawFixture(day='2026-10-16'){
 if(!['2026-10-16','2026-10-17'].includes(day))fail();
 const state={count:2,changed:false,inconsistentSecondPass:false,requests:0,itemRequests:0,countRequests:0,listRequests:0,otherNetwork:0};
 const order=n=>({order_id:'SYNTHETIC_ORDER_'+n,shop_no:1,order_date:day+'T12:00:00+09:00',place_date:null,payment_amount:'100.00',order_price_amount:'100.00',payment_method:['card'],order_status:'N00',currency:'KRW'});
 const items=n=>[{order_item_code:'SYNTHETIC_LINE_'+n,product_no:'100',product_name:'Synthetic Product',option_value:'Synthetic Option',quantity:'1.0000',product_price:state.changed&&n===0?'101.00':'100.00',order_status:'N00'}];
 const request=async(value,options)=>{
  const url=value instanceof URL?value:new URL(value);if(url.origin!==`https://${MALL}.cafe24api.com`||url.username||url.password||url.hash||options?.method!=='GET'||options.headers?.Authorization!==`Bearer ${ACCESS}`||options.headers?.Accept!=='application/json'||!(options.signal instanceof AbortSignal)){state.otherNetwork++;fail();}
  if(url.searchParams.get('shop_no')!=='1')fail();let body;
  if(url.pathname==='/api/v2/admin/orders/count'){
   if(url.searchParams.get('start_date')!==day||url.searchParams.get('end_date')!==day||url.searchParams.get('date_type')!=='order_date'||[...url.searchParams.keys()].sort().join(',')!==['shop_no','start_date','end_date','date_type'].sort().join(','))fail();body={count:state.count};state.countRequests++;
  }else if(url.pathname==='/api/v2/admin/orders'){
   if(url.searchParams.get('start_date')!==day||url.searchParams.get('end_date')!==day||url.searchParams.get('date_type')!=='order_date'||url.searchParams.get('limit')!=='100'||url.searchParams.get('offset')!=='0'||url.searchParams.get('fields')!=='order_id,shop_no,order_date,payment_amount,currency,place_date,order_price_amount,payment_method,order_status'||[...url.searchParams.keys()].sort().join(',')!==['shop_no','start_date','end_date','date_type','limit','offset','fields'].sort().join(','))fail();body={orders:Array.from({length:state.count},(_,n)=>order(n))};state.listRequests++;
  }else{
   const match=/^\/api\/v2\/admin\/orders\/SYNTHETIC_ORDER_([01])\/items$/.exec(url.pathname);if(!match||Number(match[1])>=state.count||[...url.searchParams.keys()].sort().join(',')!=='fields,shop_no'||url.searchParams.get('fields')!=='order_item_code,product_no,product_name,option_value,quantity,product_price,order_status')fail();body={items:items(Number(match[1]))};state.itemRequests++;if(state.inconsistentSecondPass&&state.itemRequests>state.count)body.items[0].product_price='999.00';
  }
  state.requests++;return new Response(JSON.stringify(clone(body)),{status:200,headers:{'content-type':'application/json','x-cafe24-api-version':'2026-09-01'}});
 };
 return {state,request,reset(){state.requests=state.itemRequests=state.countRequests=state.listRequests=0;},rawOrder:order,rawItems:items};
}
