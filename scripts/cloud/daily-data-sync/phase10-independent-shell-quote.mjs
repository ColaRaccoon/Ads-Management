import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash,createPublicKey,verify} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation';
const external=root+'/dependency-shell-quote-20261019-v7';
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const [before,after,pkgBefore,pkgAfter]=await Promise.all([
 json(root+'/candidate-20261019-v6/package-lock.json'),json('package-lock.json'),
 json(root+'/candidate-20261019-v6/package.json'),json('package.json')]);
assert.deepEqual(Object.keys(after.packages),Object.keys(before.packages));
const changed=Object.keys(before.packages).filter(k=>JSON.stringify(before.packages[k])!==JSON.stringify(after.packages[k]));
assert.deepEqual(changed,['node_modules/shell-quote']);
const prior=before.packages[changed[0]],next=after.packages[changed[0]];
assert.deepEqual(Object.keys(next).filter(k=>JSON.stringify(next[k])!==JSON.stringify(prior[k])).sort(),['integrity','resolved','version']);
assert.equal(prior.version,'1.10.0');assert.equal(next.version,'1.11.0');assert.equal(next.dev,true);
assert.deepEqual(pkgAfter,{...pkgBefore,overrides:{...pkgBefore.overrides,'shell-quote':'1.11.0'}});
const get=async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(15000),redirect:'error'});assert.equal(r.status,200);return r;};
const [metadata,keys]=await Promise.all([
 get('https://registry.npmjs.org/shell-quote/1.11.0').then(r=>r.json()),
 get('https://registry.npmjs.org/-/npm/v1/keys').then(r=>r.json())]);
assert.equal(metadata.name,'shell-quote');assert.equal(metadata.version,'1.11.0');assert.equal(metadata.dist.integrity,next.integrity);
assert.equal(metadata.dist.tarball,'https://registry.npmjs.org/shell-quote/-/shell-quote-1.11.0.tgz');
const tar=Buffer.from(await (await get(metadata.dist.tarball)).arrayBuffer());
assert.equal('sha512-'+createHash('sha512').update(tar).digest('base64'),next.integrity);
let valid=false;
for(const signature of metadata.dist.signatures){const key=keys.keys.find(k=>k.keyid===signature.keyid);if(!key)continue;
 const pub=createPublicKey({key:Buffer.from(key.key,'base64'),format:'der',type:'spki'});
 valid||=verify('sha256',Buffer.from('shell-quote@1.11.0:'+next.integrity),pub,Buffer.from(signature.sig,'base64'));
}
assert(valid);
const tests=spawnSync(process.execPath,['--test',external+'/shell-quote-regression.test.cjs'],{encoding:'utf8',windowsHide:true,timeout:15000});
assert.equal(tests.status,0);assert.match(tests.stdout,/(?:pass 6|# pass 6)/);
const out={kind:'PHASE10_INDEPENDENT_SHELL_QUOTE_PATCH_REVIEW',at:new Date().toISOString(),
 oldVersion:prior.version,version:next.version,changedLockEntries:changed,other523LockEntriesUnchanged:true,
 changedLockFields:['integrity','resolved','version'],onlyRootOverrideAdded:true,devDependency:true,
 independentlyFetchedRegistrySignatureValid:valid,independentlyFetchedTarballIntegrityValid:true,
 tarballBytes:tar.length,regressionTests:6,regressionExit:tests.status,shellCommandsExecuted:0,
 sourceFilesModified:0,remoteApplicationOrProviderRequests:0,
 officialMaintainerAdvisory:'https://github.com/ljharb/shell-quote/security/advisories/GHSA-pqg4-j6r4-53mv',
 rootLockSha256:createHash('sha256').update(await readFile('package-lock.json')).digest('hex')};
await writeFile(root+'/independent/shell-quote-review-20261019.json',JSON.stringify(out,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(out));
