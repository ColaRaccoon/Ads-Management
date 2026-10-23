// Public bootstrap source; the protected environment arrives through one stdin frame.
const LIMIT = 2 * 1024 * 1024;
function readProtectedFrame(stream, progress = () => {}) {
  return new Promise((resolve, reject) => {
    let wire = '', bytes = 0;
    stream.setEncoding('utf8');
    const cleanup = () => { stream.off('data', data); stream.off('end', end); stream.off('error', error); };
    const error = () => { cleanup(); wire = ''; reject(Error('LOCAL_FRAME_REJECTED')); };
    const end = () => error(); // A terminating newline is mandatory; EOF is not the trigger.
    const data = chunk => {
      if (bytes === 0) progress('DATA_RECEIVED');
      bytes += Buffer.byteLength(chunk);
      if (bytes > LIMIT) return error();
      wire += chunk;
      const at = wire.indexOf('\n');
      if (at < 0) return;
      if (wire.slice(at + 1).trim()) return error();
      const frame = wire.slice(0, at); wire = ''; cleanup(); stream.pause();
      if (!frame.trim()) return reject(Error('LOCAL_FRAME_REJECTED'));
      progress('FRAME_COMPLETE');
      resolve(frame);
    };
    stream.on('data', data); stream.once('end', end); stream.once('error', error);
  });
}
async function runProtectedBootstrap() {
  let stage = 'FRAME', prepared, expiry, wire = '';
  const mark = value => { stage = value; process.stderr.write('PHASE10_LOCAL_WRAPPER_STAGE ' + value + '\n'); };
  try {
    mark('FRAME'); wire = await readProtectedFrame(process.stdin, mark);
    mark('PARSE'); const input = JSON.parse(wire); wire = '';
    mark('TTL'); const until = Date.parse(input.testDeadline);
    if (!Number.isFinite(until) || until <= Date.now() || until > Date.now() + 1200000) throw Error();
    const env = { ...process.env, ...input.env, PORT: '8000' }; input.env = undefined;
    mark('PREPARE');
    const { preparePhase08Runtime } = await import('/srv/app/deploy/cloud/phase08-launch.mjs');
    const { launchBundle } = await import('/srv/app/deploy/launch-bundle.mjs');
    prepared = await preparePhase08Runtime(env); const e = prepared.env;
    mark('CONFIG'); const f = require('fs');
    const cfg = require('/srv/app/apps/api/dist/common/http-security.config.js').loadHttpSecurityConfig(e);
    process.stdout.write('PHASE10_LOCAL_RUNTIME_PROOF ' + JSON.stringify({
      imageReleaseMatches: e.IMAGE_RELEASE_GIT_SHA === '7e6e03ed8a72c3c7c7cac57ec965e87d4c697c3b',
      sourceMatches: e.PHASE08_SOURCE_CONTENT_SHA256 === 'a10f3510c5f1e613579ca002f2ec8e05f57e69ff02c6862af4e111735adc05d2',
      sourceFileMatches: f.readFileSync('/srv/app/phase08-source-content-sha256', 'utf8').trim() === 'a10f3510c5f1e613579ca002f2ec8e05f57e69ff02c6862af4e111735adc05d2',
      pool3: e.PRISMA_CONNECTION_LIMIT === '3', heavy1: e.HEAVY_OPERATION_CONCURRENCY === '1',
      featureOn: e.DAILY_SYNC_FEATURE_ENABLED === 'true', scheduleOff: e.DAILY_SYNC_SCHEDULE_ENABLED === 'false',
      runtimeConfigFingerprint: cfg.runtimeConfigFingerprint
    }) + '\n');
    mark('LAUNCH'); if (Date.now() >= until) throw Error();
    const bundle = launchBundle({ env: e, logError: v => console.error('LOCAL_BUNDLE_SAFE_FAILURE ' + JSON.stringify({
      event: v.event, child: v.child, code: typeof v.code === 'number' || /^[A-Z_0-9]{1,64}$/.test(v.code ?? '') ? v.code : null
    })) });
    expiry = setTimeout(() => bundle.stop('SIGTERM', 'LOCAL_TEST_DEADLINE'), Math.max(1, until - Date.now()));
    expiry.unref(); mark('RUNNING'); await bundle.completion;
  } catch {
    process.stderr.write('PHASE10_LOCAL_WRAPPER_FAILURE ' + stage + '\n'); process.exitCode = 1;
  } finally {
    wire = ''; clearTimeout(expiry);
    if (prepared) { try { await prepared.cleanup(); } catch { process.stderr.write('PHASE10_LOCAL_WRAPPER_FAILURE CLEANUP\n'); process.exitCode = 1; } }
  }
}
module.exports = { readProtectedFrame, runProtectedBootstrap };
