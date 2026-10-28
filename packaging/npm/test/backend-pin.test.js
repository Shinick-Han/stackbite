'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { ensureBackendPin, readBackendPin, BackendPinError, FILE } = require('../lib/backend-pin');

const SCHEMA = 'stackbite.workstack-backend.v1';
async function state(t) {
  const area = await fs.mkdtemp(path.join(os.tmpdir(), 'stackbite-pin-'));
  t.after(() => fs.rm(area, { recursive: true, force: true }));
  return area;
}
const code = expected => error => error instanceof BackendPinError && error.code === expected;
function patchLink(t, replacement) {
  const original = fs.link;
  fs.link = replacement(original);
  t.after(() => { fs.link = original; });
}

test('first setup creates one exact private pin and reuse keeps it stable', async t => {
  const dir = await state(t);
  assert.equal(await readBackendPin(dir), null);
  const first = await ensureBackendPin(dir);
  assert.equal(first.state, 'created');
  assert.match(first.backendId, /^stackbite-[0-9a-f]{24}$/);
  const file = path.join(dir, FILE);
  assert.equal(await fs.readFile(file, 'utf8'), JSON.stringify({ schema: SCHEMA, backend_id: first.backendId }) + '\n');
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(dir), [FILE]);
  assert.deepEqual(await ensureBackendPin(dir), { backendId: first.backendId, state: 'reused' });
  assert.equal(await readBackendPin(dir), first.backendId);
});

test('an existing WorkBite pin is reused unchanged, whatever prefix is requested', async t => {
  const dir = await state(t), file = path.join(dir, FILE);
  const bytes = `{"schema": "${SCHEMA}", "backend_id": "workbite-0123456789abcdef01234567"}`;
  await fs.writeFile(file, bytes);
  assert.deepEqual(await ensureBackendPin(dir, { prefix: 'other-' }),
    { backendId: 'workbite-0123456789abcdef01234567', state: 'reused' });
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
  await assert.rejects(ensureBackendPin(dir, { prefix: 'Bad prefix' }), code('prefix_invalid'));
});

test('concurrent setup publishes exactly one pin that every caller returns', async t => {
  const dir = await state(t);
  const results = await Promise.all(Array.from({ length: 16 }, () => ensureBackendPin(dir)));
  assert.equal(new Set(results.map(result => result.backendId)).size, 1);
  assert.equal(results.filter(result => result.state === 'created').length, 1);
  assert.deepEqual(await fs.readdir(dir), [FILE]);
});

test('malformed, oversized and non-file pins are refused and left untouched', async t => {
  const dir = await state(t), file = path.join(dir, FILE);
  const cases = [
    `{"schema":"${SCHEMA}","backend_id":"bad id"}`,
    `{"schema":"${SCHEMA}","backend_id":"x","extra":1}`,
    `{"schema":"${SCHEMA}","backend_id":"a","backend_id":"b"}`,
    `{"schema":"stackbite.workstack-backend.v2","backend_id":"x"}`,
    `﻿{"schema":"${SCHEMA}","backend_id":"x"}`,
    Buffer.concat([Buffer.from(`{"schema":"${SCHEMA}","backend_id":"x`), Buffer.from([0xff]), Buffer.from('"}')]),
    `{"schema":"${SCHEMA}","backend_id":"x"}` + ' '.repeat(4096),
    '[]', 'null', '', '{"schema":',
  ];
  for (const bytes of cases) {
    await fs.writeFile(file, bytes);
    await assert.rejects(ensureBackendPin(dir), code('pin_invalid'));
    await assert.rejects(readBackendPin(dir), code('pin_invalid'));
    assert.deepEqual(await fs.readFile(file), Buffer.from(bytes));
  }
  await fs.rm(file);
  await fs.mkdir(file);
  await assert.rejects(ensureBackendPin(dir), code('pin_invalid'));
  assert.ok((await fs.lstat(file)).isDirectory());
});

test('a symlinked pin is refused rather than followed or replaced', async t => {
  const dir = await state(t), target = path.join(dir, 'elsewhere.json');
  await fs.writeFile(target, JSON.stringify({ schema: SCHEMA, backend_id: 'linked' }));
  try { await fs.symlink(target, path.join(dir, FILE), 'file'); } catch (error) {
    if (error.code === 'EPERM') return t.skip('symlink creation needs privilege on this host');
    throw error;
  }
  await assert.rejects(ensureBackendPin(dir), code('pin_invalid'));
  assert.ok((await fs.lstat(path.join(dir, FILE))).isSymbolicLink());
});

test('an unreadable pin is reported, not replaced', async t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('POSIX non-root permission check');
  const dir = await state(t), file = path.join(dir, FILE);
  await fs.writeFile(file, JSON.stringify({ schema: SCHEMA, backend_id: 'kept' }));
  await fs.chmod(file, 0o000);
  await assert.rejects(ensureBackendPin(dir), code('pin_unreadable'));
  await fs.chmod(file, 0o600);
  assert.equal(await readBackendPin(dir), 'kept');
});

test('the state directory must be an explicit existing real directory and is never created', async t => {
  const dir = await state(t), missing = path.join(dir, 'missing');
  await assert.rejects(ensureBackendPin('relative/state'), code('state_invalid'));
  await assert.rejects(ensureBackendPin(undefined), code('state_invalid'));
  await assert.rejects(ensureBackendPin(missing), code('state_invalid'));
  await assert.rejects(readBackendPin(missing), code('state_invalid'));
  assert.deepEqual(await fs.readdir(dir), []);
  const real = path.join(dir, 'real'), linked = path.join(dir, 'linked');
  await fs.mkdir(real);
  try { await fs.symlink(real, linked, 'junction'); } catch (error) {
    if (error.code === 'EPERM') return;
    throw error;
  }
  await assert.rejects(ensureBackendPin(linked), code('state_invalid'));
  assert.deepEqual(await fs.readdir(real), []);
});

const eio = () => Object.assign(new Error('interrupted'), { code: 'EIO' });

test('a failure before linking reports no pin and leaves no pin or temporary file', async t => {
  const dir = await state(t);
  await fs.writeFile(path.join(dir, `.${FILE}.stale.tmp`), '{"schema":');
  const original = fs.open;
  fs.open = async (...args) => Object.assign(await original(...args), { writeFile: async () => { throw eio(); } });
  t.after(() => { fs.open = original; });
  await assert.rejects(ensureBackendPin(dir), code('pin_unpublished'));
  assert.deepEqual(await fs.readdir(dir), [`.${FILE}.stale.tmp`]);
  assert.equal(await readBackendPin(dir), null);
});

test('a link error with no pin reports an unknown outcome, never absence', async t => {
  const dir = await state(t);
  patchLink(t, () => async () => { throw eio(); });
  await assert.rejects(ensureBackendPin(dir),
    error => code('pin_outcome_unknown')(error) && !/no pin|not configured|did not configure/.test(error.message));
  assert.deepEqual(await fs.readdir(dir), []);
  assert.equal(await readBackendPin(dir), null);
});

test('a link that lands before its error is unknown, kept in place and reused on the next call', async t => {
  const dir = await state(t), file = path.join(dir, FILE);
  let linked = 0;
  patchLink(t, original => async (from, to) => { await original(from, to); linked += 1; throw eio(); });
  await assert.rejects(ensureBackendPin(dir),
    error => code('pin_outcome_unknown')(error) && !/no pin|not configured|did not configure/.test(error.message));
  assert.equal(linked, 1);
  assert.deepEqual(await fs.readdir(dir), [FILE]);
  const bytes = await fs.readFile(file);
  const backendId = JSON.parse(bytes.toString('utf8')).backend_id;
  assert.match(backendId, /^stackbite-[0-9a-f]{24}$/);
  assert.equal(bytes.toString('utf8'), JSON.stringify({ schema: SCHEMA, backend_id: backendId }) + '\n');
  assert.equal(await readBackendPin(dir), backendId);
  assert.deepEqual(await ensureBackendPin(dir), { backendId, state: 'reused' });
  assert.equal(linked, 1);
  assert.deepEqual(await fs.readFile(file), bytes);
  assert.deepEqual(await fs.readdir(dir), [FILE]);
});

test('a pin replaced during publication is never reported as created', async t => {
  const dir = await state(t), file = path.join(dir, FILE);
  patchLink(t, original => async (from, to) => {
    await original(from, to);
    await fs.rm(to);
    await fs.writeFile(to, JSON.stringify({ schema: SCHEMA, backend_id: 'someone-else' }));
  });
  await assert.rejects(ensureBackendPin(dir), code('pin_unverified'));
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).backend_id, 'someone-else');
});

test('a pin raced in by another writer is reused, not overwritten', async t => {
  const dir = await state(t), file = path.join(dir, FILE);
  const theirs = JSON.stringify({ schema: SCHEMA, backend_id: 'workbite-raced' }) + '\n';
  patchLink(t, original => async (from, to) => { await fs.writeFile(to, theirs, { flag: 'wx' }); return original(from, to); });
  assert.deepEqual(await ensureBackendPin(dir), { backendId: 'workbite-raced', state: 'reused' });
  assert.equal(await fs.readFile(file, 'utf8'), theirs);
  assert.deepEqual(await fs.readdir(dir), [FILE]);
});

test('importing the module or launching the package never creates a pin', async t => {
  const dir = await state(t);
  const script = `require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'backend-pin.js'))});`
    + `require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'bootstrap.js'))});`;
  const result = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, STACKBITE_STATE_DIR: dir }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await fs.readdir(dir), []);
  const bootstrap = await fs.readFile(path.join(__dirname, '..', 'lib', 'bootstrap.js'), 'utf8');
  assert.doesNotMatch(bootstrap, /backend-pin/);
});
