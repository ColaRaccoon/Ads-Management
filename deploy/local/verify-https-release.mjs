import { createHash, X509Certificate } from "node:crypto";
import { request } from "node:https";
import { isIP } from "node:net";
import { readFileSync } from "node:fs";

const args = new Map(process.argv.slice(2).map((item) => {
  const index = item.indexOf("=");
  if (!item.startsWith("--") || index < 3) fail();
  return [item.slice(2,index),item.slice(index+1)];
}));
const connectAddress=args.get("connect-address"),hostname=args.get("hostname"),caPath=args.get("ca"),certificatePath=args.get("certificate"),releaseId=args.get("release-id");
const expectedStatus=Number(args.get("expected-status")??"200");
if(isIP(connectAddress??"")!==4||!hostname||!caPath||!certificatePath||!releaseId||![200,503].includes(expectedStatus))fail();
const ca=readFileSync(caPath);
const expectedCertificateSha256=createHash("sha256").update(new X509Certificate(readFileSync(certificatePath)).raw).digest("hex");

const result=await new Promise((resolve)=>{
  const req=request({hostname:connectAddress,port:443,path:"/backend-api/health/live",method:"GET",servername:hostname,headers:{host:hostname},ca,rejectUnauthorized:true,minVersion:"TLSv1.2",timeout:5000},(response)=>{
    const peer=response.socket.getPeerCertificate(true);let body="";response.setEncoding("utf8");response.on("data",(chunk)=>{body+=chunk;if(body.length>4096)req.destroy()});response.on("end",()=>{
      try{
        const raw=peer?.raw;
        const certificateMatches=raw&&createHash("sha256").update(raw).digest("hex")===expectedCertificateSha256&&new X509Certificate(raw).checkHost(hostname,{wildcards:false})===hostname;
        if(expectedStatus===503)resolve(response.statusCode===503&&body==="Request rejected.\n"&&response.headers["cache-control"]==="no-store"&&certificateMatches);
        else{const value=JSON.parse(body);resolve(response.statusCode===200&&value.status==="live"&&value.releaseId===releaseId&&certificateMatches)}
      }catch{resolve(false)}
    });
  });
  req.once("timeout",()=>{req.destroy();resolve(false)});req.once("error",()=>resolve(false));req.end();
});
if(!result)fail();
process.stdout.write('{"result":"PASS"}\n');
function fail(){process.stderr.write('{"result":"FAIL"}\n');process.exit(1);}
