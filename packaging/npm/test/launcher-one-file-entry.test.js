'use strict';
// A one-file package ships the launcher role once, as the public entry its
// manifest declares; that declaration is validated even though no legacy
// `stackbite-launcher[.exe]` pin exists.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fixture, digest } = require('./fixtures');
const { validatePayload, releaseSpec } = require('../lib/bootstrap');

const TARGET = { win32: 'x86_64-pc-windows-msvc', linux: 'x86_64-unknown-linux-gnu', darwin: 'aarch64-apple-darwin' };

async function oneFile(t, platform, mutate = () => {}) {
  const suffix = platform === 'win32' ? '.exe' : '';
  const entry = 'stackbite' + suffix, legacy = 'stackbite-launcher' + suffix;
  const image = platform === 'win32' ? Buffer.from('MZ one-file entry') : platform === 'darwin'
    ? Buffer.from('cffaedfe0c0000010000000002000000', 'hex') : Buffer.from('\x7fELFone-file entry');
  const base = fixture(platform);
  const info = { product: 'Stackbite', binary: 'stackbite-launcher', version: base.manifest.version,
    commit: base.manifest.commit, target: TARGET[platform], protocol: 1 };
  const manifest = { ...info, schema: 'stackbite-rust-terminal-build-v1',
    binaries: { 'stackbite-launcher': { path: entry, sha256: digest(image), build_info: info } },
    artifacts: { [entry]: { sha256: digest(image), size: image.length, kind: 'binary' } } };
  const files = { [entry]: image };
  mutate({ manifest, files, entry, legacy, image });
  files['manifest.json'] = Buffer.from(JSON.stringify(manifest));
  const value = fixture(platform, {}, files);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'one-file-entry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, bytes] of Object.entries(value.files)) {
    const target = path.join(root, name); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { mode: 0o755 });
  }
  return { root, spec: releaseSpec(value.manifest, platform, platform === 'darwin' ? 'arm64' : 'x64'), entry, legacy };
}

for (const platform of ['win32', 'linux', 'darwin']) {
  test(`${platform} one-file package validates and opens its declared public entry`, async t => {
    const p = await oneFile(t, platform);
    assert.equal(await validatePayload(p.root, p.spec), path.join(p.root, p.entry));
    await assert.rejects(fs.stat(path.join(p.root, p.legacy)), { code: 'ENOENT' });
  });
  const invalid = {
    'a legacy path declared without its pin': m => { m.manifest.binaries['stackbite-launcher'].path = m.legacy; },
    'an alias outside the closed choice': m => { m.manifest.binaries['stackbite-launcher'].path = 'bin/' + m.entry; },
    'a wrong declared digest': m => { m.manifest.binaries['stackbite-launcher'].sha256 = 'a'.repeat(64); },
    'a wrong artifact kind': m => { m.manifest.artifacts[m.entry].kind = 'library'; },
    'the other name also declared': m => { m.manifest.artifacts[m.legacy] = { ...m.manifest.artifacts[m.entry] }; },
    'a foreign role identity': m => { m.manifest.binaries['stackbite-launcher'].build_info = { ...m.manifest.binaries['stackbite-launcher'].build_info, binary: 'stackbite-tui' }; },
    'a different package commit': m => { m.manifest.commit = 'b'.repeat(40); },
    'an extra entry key': m => { m.manifest.binaries['stackbite-launcher'].alias = m.entry; },
    'a null role': m => { m.manifest.binaries['stackbite-launcher'] = null; },
  };
  for (const [name, mutate] of Object.entries(invalid)) {
    test(`${platform} one-file package refuses ${name}`, async t => {
      const p = await oneFile(t, platform, mutate);
      await assert.rejects(validatePayload(p.root, p.spec), /Native entry package identity or pin is invalid/);
    });
  }
  test(`${platform} manifest without a launcher role keeps the frozen engine entry`, async t => {
    const p = await oneFile(t, platform, m => { delete m.manifest.binaries['stackbite-launcher']; });
    assert.equal(await validatePayload(p.root, p.spec), path.join(p.root, p.entry));
  });
}
