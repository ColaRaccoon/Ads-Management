"""Bounded local-only credential equality inventory. Secret input/output is never logged."""
import hashlib
import json
import os
import pathlib
import re
import sqlite3
import sys
import time

MAX_FILES = 24000
MAX_BYTES = 128 * 1024 * 1024
MAX_FILE = 1024 * 1024
EXCLUDED = {'.git', 'node_modules', '.next', 'dist', 'build', '__pycache__', 'logs', 'log'}
TEXT = {'.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.ps1', '.mjs', '.cjs', '.js', '.ts', '.tsx', '.py', '.sh', '.md', '.txt', '.log'}

def digest(value):
    return hashlib.sha256(value.encode('utf-8') if isinstance(value, str) else value).hexdigest()

def source_credentials(value):
    if not isinstance(value, dict):
        return None
    if value.get('type') == 'impersonated_service_account':
        return value.get('source_credentials')
    if value.get('type') == 'authorized_user':
        return value
    return None

def match_source(value, expected):
    candidate = source_credentials(value)
    return bool(isinstance(candidate, dict) and all(candidate.get(k) == expected[k] for k in ('client_id', 'client_secret', 'refresh_token')))

def no_reparse(path):
    p = pathlib.Path(path)
    for item in [p, *p.parents]:
        if item.exists() and (item.is_symlink() or (getattr(item.lstat(), 'st_file_attributes', 0) & 0x400)):
            raise ValueError('LOCAL_REPARSE')

def inspect_database(path, expected):
    """Only fixed gcloud DBs; never returns DB rows, account names, tokens, or SQL."""
    result = {'exists': path.is_file(), 'readonlyUri': True, 'queryOnly': True,
              'matchingCredentialRows': 0, 'matchingAccountIdentityHashes': [],
              'cachedAccessSameCredentialBindingProven': False, 'cachedUnexpiredAccessEligible': False}
    if not result['exists']:
        return result
    no_reparse(path)
    if path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError('DATABASE_SIZE')
    connection = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=1)
    try:
        connection.execute('PRAGMA query_only=ON')
        tables = {r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        result['tableCount'] = len(tables)
        if path.name != 'credentials.db' or 'credentials' not in tables:
            return result
        columns = {r[1] for r in connection.execute('PRAGMA table_info(credentials)')}
        result['knownCredentialSchema'] = {'account_id', 'value'}.issubset(columns)
        if not result['knownCredentialSchema']:
            return result
        if connection.execute('SELECT count(*) FROM credentials').fetchone()[0] > 100:
            raise ValueError('CREDENTIAL_ROW_BOUND')
        for account, value in connection.execute('SELECT account_id, value FROM credentials'):
            if not isinstance(value, (str, bytes)) or len(value) > 65536:
                continue
            try:
                decoded = json.loads(value)
            except (ValueError, UnicodeError):
                continue
            if match_source(decoded, expected):
                result['matchingCredentialRows'] += 1
                result['matchingAccountIdentityHashes'].append(digest(str(account)))
        # An account key alone cannot bind an access token to this refresh/client tuple.
        # Do not open access_tokens value columns or request userinfo on that assumption.
        return result
    finally:
        connection.close()

def inventory(payload):
    expected = payload['expected']
    assert all(isinstance(expected.get(k), str) and len(expected[k]) >= 8 for k in ('client_id', 'client_secret', 'refresh_token'))
    capsule = payload['capsule']
    results = []
    counters = {'filesRead': 0, 'bytesRead': 0, 'oversizedSkipped': 0, 'encryptedProtectedSkipped': 0,
                'reparseSkipped': 0, 'excludedDirectories': 0, 'unreadableSkipped': 0, 'budgetReached': False, 'timeBudgetReached': False, 'entriesSeen': 0}
    forbidden = [expected[k] for k in ('client_id', 'client_secret', 'refresh_token')] + [capsule]
    deadline = time.monotonic() + 60
    for root in payload['roots']:
        base = pathlib.Path(root['path'])
        if not base.exists():
            continue
        no_reparse(base)
        for parent, dirs, files in os.walk(base, followlinks=False):
            if time.monotonic() > deadline or counters['entriesSeen'] >= 100000:
                counters['budgetReached'] = True; counters['timeBudgetReached'] = time.monotonic() > deadline; break
            retained = []
            for name in sorted(dirs):
                p = pathlib.Path(parent, name)
                if name in EXCLUDED or re.match(r'^(?:candidate-|upload-|dependency-|portable-build-)', name):
                    counters['excludedDirectories'] += 1
                elif p.is_symlink() or (getattr(p.lstat(), 'st_file_attributes', 0) & 0x400):
                    counters['reparseSkipped'] += 1
                else:
                    retained.append(name)
            dirs[:] = retained
            for name in sorted(files):
                counters['entriesSeen'] += 1
                if time.monotonic() > deadline or counters['entriesSeen'] >= 100000:
                    counters['budgetReached'] = True; counters['timeBudgetReached'] = time.monotonic() > deadline; break
                p = pathlib.Path(parent, name)
                if p.suffix.lower() in {'.dpapi', '.db', '.db-shm', '.db-wal', '.sqlite'}:
                    if p.suffix.lower() == '.dpapi':
                        counters['encryptedProtectedSkipped'] += 1
                    continue
                if not (p.suffix.lower() in TEXT or name.startswith('.env') or root['label'] == 'GCLOUD' and name.startswith('config_')):
                    continue
                try:
                    if p.is_symlink() or (getattr(p.lstat(), 'st_file_attributes', 0) & 0x400):
                        counters['reparseSkipped'] += 1; continue
                    size = p.stat().st_size
                    if size > MAX_FILE:
                        counters['oversizedSkipped'] += 1
                        continue
                    if counters['filesRead'] >= MAX_FILES or counters['bytesRead'] + size > MAX_BYTES:
                        counters['budgetReached'] = True
                        dirs[:] = []
                        break
                    wire = p.read_bytes()
                    text = wire.decode('utf-8-sig')
                    counters['filesRead'] += 1
                    counters['bytesRead'] += len(wire)
                    matches = {k: expected[k] in text for k in ('client_id', 'client_secret', 'refresh_token')}
                    has_capsule = capsule in text
                    if any(matches.values()) or has_capsule:
                        exact_json = False
                        try:
                            exact_json = match_source(json.loads(text), expected)
                        except ValueError:
                            pass
                        results.append({'scope': root['label'], 'pathSha256': digest(str(p.resolve()).casefold()),
                                        'fileSha256': digest(wire), 'clientIdLiteralMatch': matches['client_id'],
                                        'clientSecretLiteralMatch': matches['client_secret'],
                                        'refreshTokenLiteralMatch': matches['refresh_token'],
                                        'exactCapsuleLiteralMatch': has_capsule, 'exactAuthorizedUserTupleParsed': exact_json,
                                        'executionConsumerProven': root['label'] == 'GCLOUD' and name == 'application_default_credentials.json' and exact_json})
                except (OSError, UnicodeError):
                    counters['unreadableSkipped'] += 1
            if counters['budgetReached']:
                break
        if counters['budgetReached']:
            break
    gcloud = pathlib.Path(payload['gcloud'])
    databases = {name: inspect_database(gcloud / name, expected) for name in ('credentials.db', 'access_tokens.db', 'default_configs.db')}
    output = {'kind': 'GOOGLE_BOUNDED_LOCAL_CONSUMER_EQUALITY_INVENTORY', 'status': 'PASS_BOUNDED_LOCAL_READ_ONLY',
              'roots': [{'scope': r['label'], 'exists': pathlib.Path(r['path']).is_dir()} for r in payload['roots']],
              'limits': {'fileCount': MAX_FILES, 'totalBytes': MAX_BYTES, 'perFileBytes': MAX_FILE, 'seconds': 60, 'entries': 100000},
              'counters': counters, 'matches': results, 'databases': databases,
              'providerRequests': 0, 'oauthRefreshPosts': 0, 'credentialDatabaseWrites': 0,
              'cachedAccessRead': False, 'userIdentityExternallyVerified': False,
              'limitations': ['Bounded selected local roots, not all machines or consumers',
                              'Literal occurrence is a storage/reference hit, not proof of live consumption',
                              'Encrypted historical artifacts are not traversed or decrypted by this child',
                              'No refresh/client-bound cached access token was proven; no userinfo/tokeninfo request permitted']}
    encoded = json.dumps(output, separators=(',', ':'))
    if len(encoded) > 262144 or any(v in encoded for v in forbidden if len(v) >= 8):
        raise ValueError('OUTPUT_SECRET_GUARD')
    return output

if __name__ == '__main__':
    try:
        wire = sys.stdin.buffer.read(131073)
        if len(wire) > 131072:
            raise ValueError('INPUT_BOUND')
        print(json.dumps(inventory(json.loads(wire)), separators=(',', ':')))
    except Exception as error:
        allowed = {'INPUT_BOUND', 'LOCAL_REPARSE', 'DATABASE_SIZE', 'CREDENTIAL_ROW_BOUND', 'OUTPUT_SECRET_GUARD'}
        print(json.dumps({'status': 'SAFE_REJECTION', 'fixedCode': str(error) if str(error) in allowed else 'LOCAL_SHAPE_OR_IO', 'rawErrorSuppressed': True, 'providerRequests': 0}))
        sys.exit(1)
