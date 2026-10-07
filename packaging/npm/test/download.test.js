'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { download, secureURL } = require('../lib/download');
const { digest } = require('./fixtures');

function transport(responses, calls = []) {
  return (url, options, callback) => {
    calls.push({ url: url.href, options });
    const req = new EventEmitter();
    const fixture = responses.shift();
    const response = fixture.neverEnd ? new Readable({ read() {} }) : Readable.from(fixture.chunks || []);
    response.statusCode = fixture.status || 200;
    response.headers = fixture.headers || {};
    options.signal.addEventListener('abort', () => {
      response.destroy(new Error('owned timeout fixture'));
      req.emit('error', new Error('owned timeout fixture'));
    }, { once: true });
    queueMicrotask(() => callback(response));
    return req;
  };
}
async function owned(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stackbite-download-owned-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const body = Buffer.from('fixed download fixture bytes');
const spec = { url: 'https://github.com/Shinick-Han/stackbite/releases/download/v0.5.10/fixture.zip',
  size: body.length, sha256: digest(body) };

test('HTTPS download follows approved CDN redirects and verifies exact size/SHA-256', async t => {
  const root = await owned(t), destination = path.join(root, 'archive'), calls = [];
  await download(spec, destination, { request: transport([
    { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/owned?signature=fixture' } },
    { chunks: [body.subarray(0, 5), body.subarray(5)], headers: { 'content-length': String(body.length) } }
  ], calls) });
  assert.deepEqual(await fs.readFile(destination), body);
  assert.equal(calls.length, 2); assert.equal(calls[0].url, spec.url);
  for (const call of calls) assert.equal(call.options.headers.Authorization, undefined);
});
test('downloads reject digest/size mismatch, excess bytes, unexpected encoding and HTTP errors', async t => {
  const root = await owned(t);
  const cases = [
    { selected: { ...spec, sha256: '0'.repeat(64) }, response: { chunks: [body] } },
    { selected: spec, response: { chunks: [body.subarray(0, 3)] } },
    { selected: spec, response: { chunks: [Buffer.concat([body, Buffer.from('extra')])] } },
    { selected: spec, response: { chunks: [body], headers: { 'content-length': '1' } } },
    { selected: spec, response: { chunks: [body], headers: { 'content-encoding': 'gzip' } } },
    { selected: spec, response: { status: 404 } }
  ];
  for (let index = 0; index < cases.length; index++) {
    const entry = cases[index];
    await assert.rejects(download(entry.selected, path.join(root, 'archive-' + index), { request: transport([entry.response]) }), /SHA-256|size|available/);
  }
});
test('redirects reject insecure or unapproved origins, credentials, ports and endless chains', async t => {
  const root = await owned(t);
  for (const location of ['http://github.com/owned', 'https://attacker.invalid/owned', 'https://user:secret@github.com/owned', 'https://github.com:444/owned']) {
    assert.throws(() => secureURL(location), /HTTPS origin/);
    await assert.rejects(download(spec, path.join(root, 'archive'), { request: transport([{ status: 302, headers: { location } }]) }), /HTTPS origin/);
  }
  const redirects = Array.from({ length: 6 }, () => ({ status: 302, headers: { location: 'https://github.com/owned' } }));
  await assert.rejects(download(spec, path.join(root, 'loop'), { request: transport(redirects) }), /redirect/);
});
test('an unending response is aborted within the fixed download deadline', async t => {
  const root = await owned(t), start = Date.now();
  await assert.rejects(download(spec, path.join(root, 'timeout'), { request: transport([{ neverEnd: true }]), timeout: 30 }), /abort|timeout/i);
  assert.ok(Date.now() - start < 2000);
});
