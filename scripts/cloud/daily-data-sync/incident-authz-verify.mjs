// Protected stdin only; outputs booleans and source hashes, never MACs or keys.
import {pathToFileURL} from 'node:url';
import {AuthCookieService} from '../../../apps/api/src/auth/cookie.service.ts';
import {checkedCookieSource} from './incident-auth-verify.mjs';
const reject=()=>{throw Error('INCIDENT_AUTHZ_INPUT_REJECTED');};
export function verifyAuthzActivation(input){
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.appId??'')||!Number.isSafeInteger(input.authzVersion)||input.authzVersion<1||input.authzVersion>2147483647||typeof input.oldSecret!=='string'||typeof input.newSecret!=='string'||input.oldSecret.length<32||input.newSecret.length<32||input.oldSecret===input.newSecret||!/^[A-Za-z0-9_-]{43}$/.test(input.serverAuthorizationVersion??''))reject();
 const current=new AuthCookieService({authorizationVersionSecret:input.newSecret}),old=new AuthCookieService({authorizationVersionSecret:input.oldSecret});
 const newMatchesServer=current.authorizationVersion(input.appId,input.authzVersion)===input.serverAuthorizationVersion;
 const oldMatchesServer=old.authorizationVersion(input.appId,input.authzVersion)===input.serverAuthorizationVersion;
 return {pass:newMatchesServer&&!oldMatchesServer,actualCookieService:true,actualDatabaseVersionInput:true,newMatchesServer,oldMatchesServer,macValuesReturned:0,secretValuesReturned:0,roleWrites:0};
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){try{let wire='';for await(const c of process.stdin){wire+=c;if(wire.length>262144)reject();}const input=JSON.parse(wire);wire='';if(input.operation!=='verify-authz')reject();const source=checkedCookieSource();process.stdout.write(JSON.stringify({...verifyAuthzActivation(input),source}));}catch{process.stdout.write('{"safeCode":"INCIDENT_AUTHZ_INPUT_REJECTED","rawErrorSuppressed":true}');process.exitCode=1;}}
