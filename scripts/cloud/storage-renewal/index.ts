import { SignJWT, importJWK, createLocalJWKSet, jwtVerify, decodeJwt } from 'npm:jose@5.10.0';
import { TARGET, renewStorage } from './core.mjs';
import { INVOCATION_BUDGET_MS, requestTimeout, checkApplicationReadiness, assertAppliedDeployment } from './readiness.mjs';
import { replaceTokenAndDeploy } from './railway-deployment.mjs';
import { createRenewalDiagnostics } from './safe-diagnostics.mjs';

Deno.serve(async (request: Request) => {
  const deadlineMs = Date.now() + INVOCATION_BUDGET_MS;
  const expected = Deno.env.get('STORAGE_RENEWAL_CALL_SECRET');
  if(request.method!=='POST'||!expected||request.headers.get('authorization')!==`Bearer ${expected}`) return new Response('Forbidden',{status:403});
  const diagnostics = createRenewalDiagnostics();
  try {
    const input=await request.json();
    if(!input || !['renew','check','renew-now'].includes(input.mode) || Object.keys(input).some(k=>k!=='mode')) return new Response('Invalid mode',{status:400});
    diagnostics.at('CONFIG_CHECK');
    const railwayToken=Deno.env.get('STORAGE_RENEWAL_RAILWAY_PROJECT_TOKEN');
    const jwk=JSON.parse(Deno.env.get('STORAGE_RENEWAL_SIGNING_JWK')??'null');
    if(!railwayToken||jwk?.kid!==TARGET.kid) throw Error('CONFIG_INVALID');
    diagnostics.at('JWKS_FETCH');
    const jwksResponse=await fetch(TARGET.origin+'/auth/v1/.well-known/jwks.json',{signal:requestTimeout(deadlineMs,15000),redirect:'error'});
    if(!jwksResponse.ok)throw Error('JWKS_FAILED');
    diagnostics.at('JWKS_PARSE');
    const jwks=await jwksResponse.json();
    diagnostics.at('KEY_MATCH');
    const publicKey=jwks.keys?.find((k:Record<string,string>)=>k.kid===TARGET.kid);
    if(!publicKey||['kty','crv','x','y'].some(k=>publicKey[k]!==jwk[k]))throw Error('KEY_MISMATCH');
    const localJwks=createLocalJWKSet(jwks);
    const railway=async(query:string,variables:unknown,operation='TOKEN_REPLACE_OR_DEPLOY')=>{
      diagnostics.railway(operation);
      const response=await fetch('https://backboard.railway.com/graphql/v2',{method:'POST',headers:{'Project-Access-Token':railwayToken,'Content-Type':'application/json'},body:JSON.stringify({query,variables}),signal:requestTimeout(deadlineMs,20000),redirect:'error'});
      diagnostics.status(response.status);
      diagnostics.at('RAILWAY_RESPONSE_PARSE');
      const body=await response.json();
      diagnostics.graphql(body.errors);
      if(!response.ok||body.errors)throw Error('RAILWAY_REQUEST_FAILED');
      return body.data;
    };
    const result=await renewStorage({
      checkOnly:input.mode==='check',
      force:input.mode==='renew-now',
      readiness:async(variables:Record<string,string>,iat:number)=>{
        const data=await railway('query($e:String!,$s:String!){serviceInstance(environmentId:$e,serviceId:$s){activeDeployments{id status createdAt}}}',{e:TARGET.environmentId,s:TARGET.serviceId},'DEPLOYMENT_STATUS');
        diagnostics.at('DEPLOYMENT_VALIDATE');
        assertAppliedDeployment(data.serviceInstance?.activeDeployments,iat);
        diagnostics.at('APPLICATION_READINESS');
        await checkApplicationReadiness({token:variables.INTERNAL_PROBE_TOKEN,deadlineMs});
      },
      api: async (operation:string, token?:string)=>{
        if(operation==='replace-token-and-deploy') return replaceTokenAndDeploy(railway, token);
        if(operation!=='read') throw Error('UNSUPPORTED_OPERATION');
        const data=await railway('query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s,unrendered:true)}',{p:TARGET.projectId,e:TARGET.environmentId,s:TARGET.serviceId},'VARIABLE_READ');
        diagnostics.at('VARIABLES_VALIDATE');
        return data.variables;
      },
      verify:async (token:string,subject:string,oldConfiguration=false)=>{
        diagnostics.at('TOKEN_VERIFY');
        const iat=decodeJwt(token).iat;
        // A stored expired token may be replaced, never used for Storage access.
        // Signature/issuer/subject are still verified and core validates lifetime.
        const currentDate=oldConfiguration&&Number.isSafeInteger(iat)?new Date(Math.min(Date.now(),(iat!+1)*1000)):undefined;
        const verified=await jwtVerify(token,localJwks,{issuer:TARGET.origin+'/auth/v1',audience:'authenticated',subject,algorithms:['ES256'],currentDate});
        if(verified.protectedHeader.kid!==TARGET.kid)throw Error('TOKEN_KEY_MISMATCH');
        return verified.payload;
      },
      issue:async (subject:string,iat:number,exp:number)=>{
        diagnostics.at('TOKEN_ISSUE');
        return new SignJWT({role:'storage_app'}).setProtectedHeader({alg:'ES256',kid:TARGET.kid,typ:'JWT'}).setIssuer(TARGET.origin+'/auth/v1').setAudience('authenticated').setSubject(subject).setIssuedAt(iat).setExpirationTime(exp).sign(await importJWK(jwk,'ES256'));
      },
      probe:async(token:string,apiKey:string)=>{
        diagnostics.at('STORAGE_PROBE');
        const response=await fetch(TARGET.origin+'/storage/v1/object/'+TARGET.bucket+'/health/readiness-sentinel',{method:'HEAD',headers:{apikey:apiKey,authorization:'Bearer '+token},signal:requestTimeout(deadlineMs,15000),redirect:'error'});
        if(!response.ok)throw Error('STORAGE_PROBE_FAILED');
      }
    });
    console.log(JSON.stringify(result));
    return Response.json(result,{headers:{'Cache-Control':'no-store'}});
  }catch(error){
    console.error(JSON.stringify(diagnostics.failure(error)));
    return Response.json({state:'FAILED',automaticRetry:false},{status:503,headers:{'Cache-Control':'no-store'}});
  }
});
