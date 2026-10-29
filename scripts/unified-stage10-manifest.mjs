// Record exact release inputs without reading environment files or business captures.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const paths = execFileSync('git', ['ls-files', '--', 'apps/api/src/unified-performance',
  'apps/web/src/features/product-performance', 'apps/web/src/features/product-mappings',
  'apps/api/prisma', 'apps/api/src/app.module.ts', 'apps/web/src/app/products',
  'apps/web/src/components/sidebar.tsx', 'scripts/unified-aggregation-worker.ts',
  'package.json', 'package-lock.json', 'apps/api/package.json', 'apps/web/package.json'],
{ encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/).filter(Boolean).sort();
const releasePaths = [...new Set([...paths, ...readdirSync('scripts').filter(name => name.startsWith('unified-stage10-')).map(name => `scripts/${name}`)])].sort();
const files = releasePaths.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }));
const manifest = {
  stage: '10', generatedAt: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
  sourceCommitMeaning: 'Baseline HEAD at generation; file hashes include the stage10 working tree changes. Use the final stage10 Git commit for checkout.',
  contractVersion: 'product-performance-v1.1.0', calculationVersion: 'unified-report-v1',
  migrations: files.filter(file => /^apps\/api\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(file.path)),
  featureMigrations: ['20261027071504_unified_performance_foundation', '20261028003825_cafe24_separate_product_option', '20261028080000_unified_report_publication'],
  defaults: { UNIFIED_PERFORMANCE_ENABLED: false, UNIFIED_NAVER_ALLOWED_STORE_IDS: '',
    UNIFIED_REPORT_LEGACY_PLATFORMS: 'META,CAFE24', workerSchedule: 'NONE; manual sequential CLI only' },
  files,
};
writeFileSync('docs/product-performance/research/10-release-manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ sourceCommit: manifest.sourceCommit, files: files.length, migrations: manifest.migrations.length }));
