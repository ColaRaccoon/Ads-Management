import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { assembleFullApp } from './assemble-full-app.mjs';
test('reviewed dirty source snapshot includes every application module, hashes bytes, and refuses overwrite',async()=>{
  const parent=await mkdtemp(join(tmpdir(),'phase08-source-snapshot-'));
  try {
    const output=join(parent,'snapshot');await assembleFullApp(output);
    const manifest=JSON.parse(await readFile(join(output,'source-content-manifest.json'),'utf8'));
    const names=new Set(manifest.files.map(f=>f.name));
    async function allModules(path) {
      for(const entry of await readdir(path,{withFileTypes:true})) {
        const next=`${path}/${entry.name}`;
        if(entry.isDirectory()) await allModules(next);
        else if(entry.isFile()) assert.ok(names.has(next),`required module omitted: ${next}`);
      }
    }
    for(const root of ['apps/api/src','apps/web/src','packages/shared/src']) await allModules(root);
    assert.ok(manifest.files.some(f=>f.name.startsWith('apps/api/src/storage/')));
    assert.equal(manifest.files.some(f=>/^apps\/api\/storage\/|(?:^|\/)\.env(?:\.|$)|\.dpapi$/.test(f.name)),false);
    for(const file of manifest.files) {
      const bytes=await readFile(join(output,file.name));
      assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);
    }
    assert.equal(createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex'),manifest.sourceContentSha256);
    await assert.rejects(assembleFullApp(output));
  } finally { await rm(parent,{recursive:true,force:true}); }
});
