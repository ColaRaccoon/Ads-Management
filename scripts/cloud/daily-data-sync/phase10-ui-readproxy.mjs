// Local rendering helper: GET-only access through one real, protected test
// session. No browser authentication cookies or synthetic provider responses.
import {createServer} from 'node:http';
const origin='https://phase08-daily-data-sync-production.up.railway.app';
const allowed=new Set(['/auth/me','/dashboard/summary','/dashboard/trends','/dashboard/meta-collection','/metrics/products','/metrics/adsets','/metrics/ads','/metrics/ads/creatives','/uploads','/sales/cafe24/uploads','/sales/product-performance','/sales/cafe24/unmatched','/sales/cafe24/coupon-matches','/coupang/dashboard','/coupang/uploads','/coupang/manual-purchases/options','/coupang/daily-report','/coupang/daily-report/categories','/reports','/source-coverage/schedule-warnings','/storefront/summary','/storefront/ad-spend']);
let payload='';for await(const chunk of process.stdin){payload+=chunk;if(Buffer.byteLength(payload)>32_768)throw Error('PHASE10_UI_PROXY_INPUT_SIZE');}
const input=JSON.parse(payload);payload='';
if(input.origin!==origin||input.projectRef!=='ehnfrrmbkvlsbpvqcvkr'||input.schema!=='phase08_meta_ads'||typeof input.cookie!=='string'||input.cookie.length<100||input.cookie.length>16_384||/[\r\n]/.test(input.cookie))throw Error('PHASE10_UI_PROXY_IDENTITY');
let cookie=input.cookie;input.cookie=null;
const calls=[];let timer,closed=false;
const server=createServer(async(req,res)=>{
 const port=server.address().port;
 if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==`127.0.0.1:${port}`){res.writeHead(403);res.end();return;}
 res.setHeader('Cache-Control','no-store');
 if(req.method==='POST'&&req.url==='/__phase10/close'&&req.headers['x-phase10-local']==='test-only'){
  res.end('closed');close();return;
 }
 const url=new URL(req.url,'http://127.0.0.1');const path=url.pathname.replace(/^\/api(?=\/)/,'');
 if(req.method!=='GET'||!url.pathname.startsWith('/api/')||!allowed.has(path)||[...url.searchParams.keys()].some(key=>!['from','to','groupBy','deliveryStatus','limit','page','q','date','categoryIds','includeUncategorized'].includes(key))){res.writeHead(403);res.end(JSON.stringify({code:'PHASE10_READONLY_PROXY_DENIED'}));return;}
 try {
  const before=performance.now();
  const response=await fetch(origin+'/backend-api'+path+url.search,{headers:{Cookie:cookie,'x-user-activity-age':'0'},redirect:'manual',signal:AbortSignal.timeout(30_000)});
  const body=await response.text();
  if(Buffer.byteLength(body)>2_097_152||cookie.split('; ').some(pair=>body.includes(pair.slice(pair.indexOf('=')+1))))throw Error('response-boundary');
  calls.push({path:path+url.search,status:response.status,at:new Date().toISOString(),elapsedMs:Math.round(performance.now()-before)});
  res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')||'application/json'});res.end(body);
 }catch{calls.push({path:path+url.search,status:502,at:new Date().toISOString()});res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({code:'PHASE10_READONLY_PROXY_FAILED'}));}
});
function close(){if(closed)return;closed=true;clearTimeout(timer);cookie='';server.close();process.stdout.write(JSON.stringify({kind:'PHASE10_UI_READ_PROXY_CLOSED',calls,remoteMutations:0,providerCollectionRequests:0,browserAuthCookies:0})+'\n');}
server.on('clientError',(_error,socket)=>socket.destroy());
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
timer=setTimeout(close,8*60_000);timer.unref();
process.stdout.write(JSON.stringify({kind:'PHASE10_UI_READ_PROXY_READY',port:server.address().port,ttlSeconds:480,syntheticAuth:false,browserLogin:false})+'\n');
process.once('SIGTERM',close);process.once('SIGINT',close);
