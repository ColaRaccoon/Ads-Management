// Ephemeral, single-use loopback UI input. Credentials arrive on stdin only.
// No remote requests, cookies, provider login, or credential files are created.
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const target='https://phase08-daily-data-sync-production.up.railway.app';
const escape=(value)=>value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
export async function startCredentialBridge(value,{ttlMs=120_000}={}) {
 if(value?.origin!==target||value?.projectRef!=='ehnfrrmbkvlsbpvqcvkr'||value?.schema!=='phase08_meta_ads'||
  typeof value.email!=='string'||!/^phase08-eval-[a-f0-9-]{36}@example\.invalid$/.test(value.email)||
  typeof value.password!=='string'||value.password.length!==44) throw Error('PHASE10_UI_CREDENTIAL_IDENTITY');
 let credentials={email:value.email,password:value.password};
 const route='/phase10-input-'+randomBytes(24).toString('hex');
 let served=false,timer;
 const server=createServer((req,res)=>{
  const local=req.socket.remoteAddress==='127.0.0.1';
  const correctHost=req.headers.host===`127.0.0.1:${server.address().port}`;
  const navigation=req.headers['sec-fetch-site']==='none'&&req.headers['sec-fetch-mode']==='navigate'&&req.headers['sec-fetch-dest']==='document';
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'");
  res.setHeader('X-Content-Type-Options','nosniff');
  if(!local||!correctHost||!navigation||req.headers.origin||req.method!=='GET'||req.url!==route||served){res.writeHead(404);res.end();return;}
  served=true;
  const html='<!doctype html><html lang="ko"><meta charset="utf-8"><title>격리 검증 입력 전달</title><h1>격리 검증 입력 전달</h1><p>기존 격리 시험 계정 · 한 번 사용 · 외부 전송 없음</p>'+ 
   `<label>격리 계정<input id="phase10-email" type="password" autocomplete="off" readonly value="${escape(credentials.email)}"></label>`+
   `<label>기존 격리 암호<input id="phase10-password" type="password" autocomplete="off" readonly value="${escape(credentials.password)}"></label></html>`;
  credentials=null;res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html,()=>{clearTimeout(timer);server.close();});
 });
 server.on('clientError',(_error,socket)=>socket.destroy());
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 timer=setTimeout(()=>{credentials=null;server.close();},ttlMs);timer.unref();
 return {url:`http://127.0.0.1:${server.address().port}${route}`,close:()=>{credentials=null;clearTimeout(timer);server.close();}};
}

async function main(){
 let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>16_384)throw Error('PHASE10_UI_CREDENTIAL_SIZE');}
 const value=JSON.parse(input);input='';
 const bridge=await startCredentialBridge(value);value.password=null;value.email=null;
 process.stdout.write(JSON.stringify({kind:'PHASE10_UI_ONCE_INPUT',url:bridge.url,ttlSeconds:120,externalRequests:0})+'\n');
 for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>bridge.close());
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{process.stderr.write('PHASE10_UI_INPUT_FAILED\n');process.exitCode=1;});
