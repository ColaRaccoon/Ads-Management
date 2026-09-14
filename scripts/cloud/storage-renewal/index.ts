import { SignJWT, importJWK, createLocalJWKSet, jwtVerify, decodeJwt } from 'npm:jose@5.10.0';
import { TARGET, renewStorage } from './core.mjs';

Deno.serve(async (request: Request) => {
  const expected = Deno.env.get('STORAGE_RENEWAL_CALL_SECRET');
  if(request.method!=='POST'||!expected||request.headers.get('authorization')!==`Bearer ${expected}`) return new Response('Forbidden',{status:403});
  try {
    const input=await request.json();
    if(!input || !['renew','check','renew-now'].includes(input.mode) || Object.keys(input).some(k=>k!=='mode')) return new Response('Invalid mode',{status:400});
    const railwayToken=Deno.env.get('STORAGE_RENEWAL_RAILWAY_PROJECT_TOKEN');
    const jwk=JSON.parse(Deno.env.get('STORAGE_RENEWAL_SIGNING_JWK')??'null');
    if(!railwayToken||jwk?.kid!==TARGET.kid) throw Error('CONFIG_INVALID');
    const jwksResponse=await fetch(TARGET.origin+'/auth/v1/.well-known/jwks.json',{signal:AbortSignal.timeout(15000),redirect:'error'});
    if(!jwksResponse.ok)throw Error('JWKS_FAILED');
    const jwks=await jwksResponse.json();
    const publicKey=jwks.keys?.find((k:Record<string,string>)=>k.kid===TARGET.kid);
    if(!publicKey||['kty','crv','x','y'].some(k=>publicKey[k]!==jwk[k]))throw Error('KEY_MISMATCH');
    const localJwks=createLocalJWKSet(jwks);
    const railway=async(query:string,variables:unknown)=>{
      const response=await fetch('https://backboard.railway.com/graphql/v2',{method:'POST',headers:{'Project-Access-Token':railwayToken,'Content-Type':'application/json'},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(20000),redirect:'error'});
      const body=await response.json();
      if(!response.ok||body.errors)throw Error('RAILWAY_REQUEST_FAILED');
      return body.data;
    };
    const result=await renewStorage({
      checkOnly:input.mode==='check',
      force:input.mode==='renew-now',
      readiness:async(variables:Record<string,string>,iat:number)=>{
        const data=await railway('query($e:String!,$s:String!){serviceInstance(environmentId:$e,serviceId:$s){activeDeployments{id status createdAt}}}',{e:TARGET.environmentId,s:TARGET.serviceId});
        if(!data.serviceInstance.activeDeployments.some((d:{status:string;createdAt:string})=>d.status==='SUCCESS' && Date.parse(d.createdAt)>=iat*1000)) throw Error('DEPLOYMENT_NOT_APPLIED');
        if(!variables.INTERNAL_PROBE_TOKEN)throw Error('PROBE_CONFIG_MISSING');
        const response=await fetch('https://patimagroup-work.com/backend-api/health/ready',{headers:{'x-internal-probe-token':variables.INTERNAL_PROBE_TOKEN},signal:AbortSignal.timeout(20000),redirect:'error'});
        if(!response.ok)throw Error('APPLICATION_NOT_READY');
      },
      api: async (operation:string, token?:string)=>{
        const query=operation==='read'
          ? 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s,unrendered:true)}'
          : 'mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}';
        const variables=operation==='read'?{p:TARGET.projectId,e:TARGET.environmentId,s:TARGET.serviceId}:{input:{projectId:TARGET.projectId,environmentId:TARGET.environmentId,serviceId:TARGET.serviceId,replace:false,skipDeploys:false,variables:{SUPABASE_STORAGE_ACCESS_TOKEN:token}}};
        const data=await railway(query,variables);
        return operation==='read'?data.variables:data.variableCollectionUpsert;
      },
      verify:async (token:string,subject:string,oldConfiguration=false)=>{
        const iat=decodeJwt(token).iat;
        // A stored expired token may be replaced, never used for Storage access.
        // Signature/issuer/subject are still verified and core validates lifetime.
        const currentDate=oldConfiguration&&Number.isSafeInteger(iat)?new Date(Math.min(Date.now(),(iat!+1)*1000)):undefined;
        const verified=await jwtVerify(token,localJwks,{issuer:TARGET.origin+'/auth/v1',audience:'authenticated',subject,algorithms:['ES256'],currentDate});
        if(verified.protectedHeader.kid!==TARGET.kid)throw Error('TOKEN_KEY_MISMATCH');
        return verified.payload;
      },
      issue:async (subject:string,iat:number,exp:number)=>new SignJWT({role:'storage_app'}).setProtectedHeader({alg:'ES256',kid:TARGET.kid,typ:'JWT'}).setIssuer(TARGET.origin+'/auth/v1').setAudience('authenticated').setSubject(subject).setIssuedAt(iat).setExpirationTime(exp).sign(await importJWK(jwk,'ES256')),
      probe:async(token:string,apiKey:string)=>{
        const response=await fetch(TARGET.origin+'/storage/v1/object/'+TARGET.bucket+'/health/readiness-sentinel',{method:'HEAD',headers:{apikey:apiKey,authorization:'Bearer '+token},signal:AbortSignal.timeout(15000),redirect:'error'});
        if(!response.ok)throw Error('STORAGE_PROBE_FAILED');
      }
    });
    console.log(JSON.stringify(result));
    return Response.json(result,{headers:{'Cache-Control':'no-store'}});
  }catch{
    console.error('STORAGE_RENEWAL_FAILED_INSPECT_PROVIDER_STATE');
    return Response.json({state:'FAILED',automaticRetry:false},{status:503,headers:{'Cache-Control':'no-store'}});
  }
});
