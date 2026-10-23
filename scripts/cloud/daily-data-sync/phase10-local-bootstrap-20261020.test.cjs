const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { readProtectedFrame } = require('./phase10-local-bootstrap-20261020.cjs');
test('one framed environment is consumed without waiting for Docker stdin EOF', async () => {
 const s = new PassThrough(), pending = readProtectedFrame(s); s.write('{"env":{"synthetic":"private"}}\n');
 assert.equal(await pending, '{"env":{"synthetic":"private"}}'); assert.equal(s.writableEnded, false); s.destroy();
});
test('fragmented multibyte UTF8 frame remains exact', async () => {
 const s = new PassThrough(), pending = readProtectedFrame(s), bytes = Buffer.from('{"synthetic":"합성"}\n');
 for (const byte of bytes) s.write(Buffer.from([byte])); assert.equal(await pending, '{"synthetic":"합성"}'); s.destroy();
});
test('unframed EOF fails closed', async () => { const s = new PassThrough(), p = readProtectedFrame(s); s.end('{}'); await assert.rejects(p, /LOCAL_FRAME_REJECTED/); });
test('oversized frame fails before parsing', async () => { const s = new PassThrough(), p = readProtectedFrame(s); s.write('x'.repeat(2097153)); await assert.rejects(p, /LOCAL_FRAME_REJECTED/); s.destroy(); });
test('two input frames in the same envelope fail closed', async () => { const s = new PassThrough(), p = readProtectedFrame(s); s.write('{}\n{}\n'); await assert.rejects(p, /LOCAL_FRAME_REJECTED/); s.destroy(); });
test('empty frame fails closed', async () => { const s = new PassThrough(), p = readProtectedFrame(s); s.write('\n'); await assert.rejects(p, /LOCAL_FRAME_REJECTED/); s.destroy(); });
