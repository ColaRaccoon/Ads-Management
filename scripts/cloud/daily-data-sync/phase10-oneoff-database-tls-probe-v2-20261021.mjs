import net from 'node:net';
import tls from 'node:tls';
import {readFileSync,writeFileSync} from 'node:fs';
const ca=readFileSync('deploy/cloud/certs/supabase-prod-ca-2021.crt','utf8');
const host='aws-0-ap-northeast-2.pooler.supabase.com';
const allowed=new Set(['SELF_SIGNED_CERT_IN_CHAIN','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_GET_ISSUER_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID','ECONNRESET','ETIMEDOUT','ECONNREFUSED']);
const result={kind:'ONEOFF_POSTGRES_STRICT_TLS_HANDSHAKE_ONLY',at:new Date().toISOString(),status:'FAIL',tcpConnected:false,postgresSslAccepted:false,tlsAuthorized:false,credentialReads:0,authenticationPackets:0,providerRequests:0,remoteMutations:0,rawValuesReturned:0};
let socket,secure;
await new Promise(resolve=>{
 let done=false;const finish=code=>{if(done)return;done=true;if(code)result.safeCode=allowed.has(code)?code:'OTHER_SUPPRESSED';secure?.destroy();socket?.destroy();resolve();};
 socket=net.createConnection({host,port:5432});socket.setTimeout(10000,()=>finish('ETIMEDOUT'));socket.on('error',e=>finish(e.code));
 socket.once('connect',()=>{result.tcpConnected=true;socket.write(Buffer.from([0,0,0,8,4,210,22,47]));});
 socket.once('data',chunk=>{if(chunk.length!==1||chunk[0]!==83){finish('UNEXPECTED_SSL_REPLY');return;}result.postgresSslAccepted=true;
  secure=tls.connect({socket,servername:host,rejectUnauthorized:true,ca,minVersion:'TLSv1.2'},()=>{result.tlsAuthorized=secure.authorized;result.status=secure.authorized?'PASS':'FAIL';finish();});secure.setTimeout(10000,()=>finish('ETIMEDOUT'));secure.on('error',e=>finish(e.code));
 });
});
writeFileSync('C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/continuation-20261021/oneoff-database-tls-handshake-v2.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(result));
