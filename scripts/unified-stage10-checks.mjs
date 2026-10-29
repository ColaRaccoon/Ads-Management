// Reproducible local static/build and UI regression checks. No database connection.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const output = 'docs/product-performance/research/10-checks-result.json';
const evidence = { stage: '10', startedAt: new Date().toISOString(), databaseConnections: 0, checks: [] };
const run = (name, args, env = {}) => {
  const result = spawnSync(process.execPath, args, { windowsHide: true, encoding: 'utf8', timeout: 600000,
    maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...env } });
  const check = { name, command: ['node', ...args].join(' '), exitCode: result.status,
    signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr };
  evidence.checks.push(check);
  console.log(`${name}: ${result.status === 0 ? 'PASS' : 'FAIL'}`);
  return result.status === 0;
};
const npm = resolve(process.env.ProgramFiles ?? 'C:/Program Files', 'nodejs/node_modules/npm/bin/npm-cli.js');
const tests = ['product-performance', 'product-mappings'].flatMap(feature => {
  const dir = `apps/web/src/features/${feature}`;
  return readdirSync(dir).filter(name => /\.test\.tsx?$/.test(name)).map(name => `${dir}/${name}`);
}).concat(['apps/web/src/components/storefront-overview.test.tsx', 'apps/web/src/components/google-report.test.tsx']);
const nextEnv = 'apps/web/next-env.d.ts';
const originalNextEnv = readFileSync(nextEnv, 'utf8');
try {
  run('web regression', ['--import', 'tsx', '--test', ...tests], { TSX_TSCONFIG_PATH: 'apps/web/tsconfig.storefront-test.json' });
  run('prisma schema', [npm, 'run', 'prisma:validate']);
  run('type checks', [npm, 'run', 'lint']);
  run('production builds', [npm, 'run', 'build']);
} finally {
  // next build rewrites its generated reference; preserve the checked-in starting content.
  writeFileSync(nextEnv, originalNextEnv);
  evidence.finishedAt = new Date().toISOString();
  evidence.status = evidence.checks.length === 4 && evidence.checks.every(check => check.exitCode === 0) ? 'PASS' : 'FAIL';
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
  if (evidence.status !== 'PASS') process.exitCode = 1;
}
