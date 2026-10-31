'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fixture, digest } = require('./fixtures');
const { validatePayload, releaseSpec } = require('../lib/bootstrap');

async function payload(t, platform, mode) {
  const entry = 'stackbite-launcher' + (platform === 'win32' ? '.exe' : '');
  const image = platform === 'win32' ? Buffer.from('MZ inert entry') : platform === 'darwin'
    ? Buffer.from('cffaedfe0c0000010000000002000000', 'hex') : Buffer.from('\x7fELFinert entry');
  const base = fixture(platform);
  const info = { product: 'Stackbite', binary: 'stackbite-launcher', version: base.manifest.version,
    commit: base.manifest.commit, target: {win32:'x86_64-pc-windows-msvc',linux:'x86_64-unknown-linux-gnu',darwin:'aarch64-apple-darwin'}[platform], protocol:1 };
  if (mode === 'identity') info.commit = 'b'.repeat(40);
  const manifest = { ...info, schema:'stackbite-rust-terminal-build-v1',
    binaries:{'stackbite-launcher':{path:entry,sha256:digest(image),build_info:info}},
    artifacts:{[entry]:{sha256:digest(image),size:image.length,kind:'binary'}} };
  const files = mode === 'old' ? {} : { [entry]: mode === 'magic' ? Buffer.from('invalid image') : image,
    'manifest.json': Buffer.from(JSON.stringify(manifest)) };
  const value = fixture(platform, {}, files), root = await fs.mkdtemp(path.join(os.tmpdir(),'s37-entry-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  for (const [name, bytes] of Object.entries(value.files)) {
    const target = path.join(root,name); await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.writeFile(target,bytes,{mode:0o755});
  }
  return { root, value, spec:releaseSpec(value.manifest,platform,platform==='darwin'?'arm64':'x64'), entry };
}
for (const platform of ['win32','linux','darwin']) {
  test(`public ${platform} entry selects pinned Rust and keeps original engine`,async t=>{
    const p=await payload(t,platform,'native');
    assert.equal(await validatePayload(p.root,p.spec),path.join(p.root,p.entry));
    assert.ok((await fs.stat(path.join(p.root,platform==='win32'?'stackbite.exe':'stackbite'))).isFile());
    await fs.appendFile(path.join(p.root,p.entry),'tamper');
    await assert.rejects(validatePayload(p.root,p.spec),/SHA-256 mismatch/);
  });
  test(`old ${platform} bundle keeps original engine entry`,async t=>{
    const p=await payload(t,platform,'old');
    assert.equal(await validatePayload(p.root,p.spec),path.join(p.root,platform==='win32'?'stackbite.exe':'stackbite'));
  });
  for (const mode of ['identity','magic']) test(`present invalid ${platform} entry ${mode} refuses`,async t=>{
    const p=await payload(t,platform,mode);
    await assert.rejects(validatePayload(p.root,p.spec),/Native entry|native executable/);
  });
}
