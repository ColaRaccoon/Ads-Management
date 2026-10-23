// Local evidence inventory only. Never opens protected credential material.
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const workspace = process.cwd();
const evidenceRoot = 'C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = args => execFileSync('git', args, { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const selected = [];
for (const dir of [evidenceRoot, join(evidenceRoot, 'evidence'), join(evidenceRoot, 'independent')]) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:json|txt|log)$/.test(entry.name) && entry.name !== 'closeout.json') selected.push(join(dir, entry.name));
  }
}
for (const entry of await readdir(evidenceRoot, { withFileTypes: true })) {
  if (entry.isDirectory() && /^api-(?:20261019|baseline-catalog-20261019)/.test(entry.name)) {
    const file = join(evidenceRoot, entry.name, 'result.json');
    try { if ((await stat(file)).isFile()) selected.push(file); } catch { /* failed rehearsal may have no result */ }
  }
}
for (const version of ['v3', 'v4', 'v5', 'v6', 'v7']) {
  const directory = join(evidenceRoot, 'evidence', version);
  try { for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isFile()) selected.push(join(directory, entry.name)); } catch { /* unused version */ }
}
for (const relative of ['docs/daily-data-automation/records/10_배포판정.md', 'docs/daily-data-automation/records/10_배포명세.md',
  'docs/daily-data-automation/records/10_결과.md', 'docs/daily-data-automation/10_배포전통합검증.md', 'docs/daily-data-automation/진행표.md']) selected.push(join(workspace, relative));
const files = [];
const suspicious = [];
for (const file of [...new Set(selected)].sort()) {
  const bytes = await readFile(file);
  files.push({ path: file.replaceAll('\\', '/'), size: bytes.length, sha256: hash(bytes) });
  // Pattern-only secondary check; the known transcript incident still fails secret-output acceptance.
  if (/(?:sb_secret_[A-Za-z0-9_-]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/.test(bytes.toString('utf8'))) suspicious.push(file.replaceAll('\\', '/'));
}
const status = git(['status', '--porcelain=v1', '-uall']);
const deleted = git(['diff', '--name-only', '--diff-filter=D']).split(/\r?\n/).filter(Boolean).sort();
const staged = git(['diff', '--cached', '--name-only']);
const record = {
  kind: 'PHASE10_LOCAL_CLOSEOUT_INVENTORY', observedAt: new Date().toISOString(),
  branch: git(['branch', '--show-current']), startHead: '9e9a1f82bb02346575565b031a43e17e13758dc8', endHead: git(['rev-parse', 'HEAD']),
  originalHeadPreserved: git(['rev-parse', 'HEAD']) === '9e9a1f82bb02346575565b031a43e17e13758dc8',
  originalBranchPreserved: git(['branch', '--show-current']) === 'codex/daily-data-automation-01',
  stagedFileCount: staged ? staged.split(/\r?\n/).length : 0,
  trackedDirtyEntries: status.split(/\r?\n/).filter(line => line && !line.startsWith('?? ')).length,
  untrackedEntries: status.split(/\r?\n/).filter(line => line.startsWith('?? ')).length,
  deletedFileCount: deleted.length, deletedPathsDigest: hash(deleted.join('\n')), statusDigest: hash(status),
  originalDeletedCountPreserved: deleted.length === 240,
  files, fileManifestDigest: hash(JSON.stringify(files)), suspiciousPatternFilePaths: suspicious,
  secretScanScope: 'Selected saved evidence/doc text, limited patterns only; no protected files, runtime secret comparison or tool-transcript scan',
  knownToolTranscriptSecretExposure: true, credentialIncidentResolved: false,
  productionMutations: 0, deploymentBranchPushes: 0, phase11Started: false, phase12Started: false,
  finalDecision: 'BLOCKED/NO-GO'
};
await writeFile(join(evidenceRoot, 'closeout.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ ...record, files: undefined }));
