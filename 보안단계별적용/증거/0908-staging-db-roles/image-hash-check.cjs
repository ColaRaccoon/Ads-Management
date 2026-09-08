'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const release = JSON.parse(fs.readFileSync('/run/release.json', 'utf8'));
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const migrationRoot = '/srv/maintenance/prisma/migrations';
const migrationEntries = fs.readdirSync(migrationRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .map((name) => {
    const bytes = fs.readFileSync(path.join(migrationRoot, name, 'migration.sql'));
    return { name, sqlSha256: sha256(bytes), bytes: bytes.length };
  });

const checks = {
  migrationEntries: JSON.stringify(migrationEntries) === JSON.stringify(release.migrations),
  nodeSha256: sha256(fs.readFileSync(release.runtime.nodePath)) === release.runtime.nodeSha256,
  prismaCliSha256:
    sha256(fs.readFileSync(release.runtime.prismaCliPath)) === release.runtime.prismaCliSha256,
  schemaSha256: sha256(fs.readFileSync(release.runtime.schemaPath)) === release.runtime.schemaSha256
};

process.stdout.write(`${JSON.stringify({
  status: Object.values(checks).every(Boolean) ? 'R2A_IMAGE_INTERNAL_HASH_PASS' : 'R2A_IMAGE_INTERNAL_HASH_FAIL',
  migrationCount: migrationEntries.length,
  migrationBytes: migrationEntries.reduce((total, entry) => total + entry.bytes, 0),
  checks
})}\n`);

if (!Object.values(checks).every(Boolean)) process.exit(2);
