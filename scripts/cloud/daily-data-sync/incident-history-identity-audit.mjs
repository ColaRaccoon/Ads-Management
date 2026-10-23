// Offline metadata recovery only. Never emit transcript text or credentials.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { join } from 'node:path';

const root = 'C:/Users/seong/.codex/sessions/2026/09/30';
const principal = 'daily-data-automation-ads-read@meta-ads-daily-automation.iam.gserviceaccount.com';
const sha = value => createHash('sha256').update(value).digest('hex');
const results = [];
let filesRead = 0;
for (const name of readdirSync(root).filter(n => /^rollout-[a-zA-Z0-9-]+\.jsonl\.zst$/.test(n))) {
  const compressed = readFileSync(join(root, name));
  if (compressed.length > 32 * 1024 * 1024) throw Error('COMPRESSED_LIMIT');
  const bytes = zstdDecompressSync(compressed, { maxOutputLength: 128 * 1024 * 1024 });
  filesRead++;
  try {
    const lines = bytes.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes(principal)) continue;
      const context = line.includes('serviceAccountTokenCreator') ? 'TARGET_AND_TOKEN_CREATOR'
        : line.includes('application-default') ? 'TARGET_AND_ADC' : 'TARGET_MENTION';
      const candidates = [...new Set(line.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [])]
        .filter(email => !email.endsWith('.gserviceaccount.com') && !/@(?:example\.(?:com|org|net)|test\.com)$/i.test(email));
      if (!candidates.length) continue;
      results.push({ sourceFile: name, line: i + 1, context,
        candidates: candidates.map(email => ({ identitySha256: sha(email.toLowerCase()),
          domainClass: email.toLowerCase().endsWith('@gmail.com') ? 'GMAIL' : 'OTHER',
          externallyBoundToExposedRefreshToken: false })) });
    }
  } finally { bytes.fill(0); compressed.fill(0); }
}
process.stdout.write(JSON.stringify({ kind: 'INCIDENT_GOOGLE_HISTORICAL_IDENTITY_CANDIDATES',
  observedAt: new Date().toISOString(), filesRead, results,
  rawTranscriptReturned: false, rawEmailsReturned: false, rawSecretsReturned: 0,
  providerRequests: 0, remoteMutations: 0,
  historicalCooccurrenceDoesNotProveRefreshTokenOwnership: true }));
