// Pure protected-caller helper. Returns equality booleans only, not tokens or
// hashes of tokens. Different opaque tokens alone never prove distinct grants.
import {createDecipheriv,timingSafeEqual} from 'node:crypto';
const ID='0c35defe-45fc-4a54-bc79-704df7bca5b1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=()=>{throw Error('CAFE_OWNER_COMPARISON_SAFE_REJECTED');};
export function compareCafeCredentialOwners(input){
 const memory=[];try{
  if(input?.phase08?.connectionId!==ID||input?.callback?.connectionId===ID||!UUID.test(input?.callback?.connectionId??'')||input.callback.storeClass!=='PHASE06_RAILWAY_POSTGRES'||input.phase08.storeClass!=='PHASE08_SUPABASE_SCHEMA'||input.scope?.separateStoresVerified!==true||input.scope?.bothProviderMallShopVerified!==true)fail();
  const open=owner=>{const key=Buffer.from(owner.key??'','base64');memory.push(key);if(key.length!==32||key.toString('base64')!==owner.key||!Array.isArray(owner.rows)||owner.rows.length!==2||new Set(owner.rows.map(r=>r.kind)).size!==2)fail();
   const result=new Map();for(const row of owner.rows){if(!['CAFE24_ACCESS','CAFE24_REFRESH'].includes(row.kind)||!Number.isSafeInteger(row.keyVersion)||row.keyVersion<1||row.keyVersion>2||row.refreshOwner!==null||row.refreshUntil!==null)fail();
    const iv=Buffer.from(row.ivB64??'','base64'),tag=Buffer.from(row.authTagB64??'','base64'),cipher=Buffer.from(row.ciphertextB64??'','base64');memory.push(iv,tag,cipher);if(iv.length!==12||tag.length!==16||cipher.length<20||cipher.length>8192)fail();
    const d=createDecipheriv('aes-256-gcm',key,iv);d.setAAD(Buffer.from(`${owner.connectionId}:${row.kind}:${row.keyVersion}`));d.setAuthTag(tag);const plain=Buffer.concat([d.update(cipher),d.final()]);memory.push(plain);if([...plain].some(byte=>byte<33||byte>126))fail();result.set(row.kind,plain);
   }return result;};
  const a=open(input.phase08),b=open(input.callback),same=kind=>a.get(kind).length===b.get(kind).length&&timingSafeEqual(a.get(kind),b.get(kind));
  const access=same('CAFE24_ACCESS'),refresh=same('CAFE24_REFRESH');return{authenticatedDecryptionBothStores:true,accessExactlyEqual:access,refreshExactlyEqual:refresh,anyTokenShared:access||refresh,entirePairEqual:access&&refresh,bothTokensDifferent:!access&&!refresh,distinctOAuthFamiliesProven:false,refreshSafeForOtherConsumersProven:false,providerRequests:0,rawValuesReturned:0};
 }catch{fail();}finally{memory.forEach(buffer=>buffer.fill(0));}
}
