import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// A fresh CommonJS process reproduces the production import order; transformed test
// modules can hide an undefined decorator token caused by a circular import.
const root = path.resolve(process.argv[2] ?? 'apps/api/dist');
for (const first of ['common/http-security.config.js', 'auth/request-security.service.js']) {
  const source = `require('reflect-metadata');
    const root=process.argv[1];
    require(require('node:path').join(root,process.argv[2]));
    const {HTTP_SECURITY_CONFIG}=require(require('node:path').join(root,'common/http-security.config.js'));
    const {AuthRequestSecurityService}=require(require('node:path').join(root,'auth/request-security.service.js'));
    const injection=Reflect.getMetadata('self:paramtypes',AuthRequestSecurityService).find(x=>x.index===3);
    require('node:assert/strict').equal(typeof HTTP_SECURITY_CONFIG,'symbol');
    require('node:assert/strict').equal(injection.param,HTTP_SECURITY_CONFIG);`;
  const result = spawnSync(process.execPath,['-e',source,root,first],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);
}
console.log('AUTH_INJECTION_COLD_IMPORT_BOTH_ORDERS_PASS');
