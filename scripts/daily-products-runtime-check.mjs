// Run after the Dockerfile's static source/map cleanup. This checks real web
// assets using the unchanged runtime guard; the full image is checked in Docker.
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertRuntimeClosure } from '../deploy/cloud/assert-runtime-closure.mjs';

const output = path.resolve('reports/daily-products-export');
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(output, 'static-closure-'));
for (const name of ['apps/api/dist/main.js', 'apps/web/server.js', 'deploy/launch-bundle.mjs', 'deploy/cloud/ready-barrier.mjs']) {
  const target = path.join(root, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, '// Required-file fixture; this check covers web static assets only.\n');
}
await cp(path.resolve('apps/web/.next/static'), path.join(root, 'apps/web/.next/static'), { recursive: true });
const result = { ...(await assertRuntimeClosure(root)), scope: 'real-web-static-assets', sourceMapsAndRawWorkerExcluded: true };
await writeFile(path.join(output, 'static-closure-result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
