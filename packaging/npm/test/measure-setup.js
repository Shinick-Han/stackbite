'use strict';
// Bounded fake bytes only; no network, providers, application or backend startup.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { EventEmitter } = require('node:events');
const { main } = require('../lib/bootstrap');
const { fixture } = require('./fixtures');

async function measure() {
  const area = await fs.mkdtemp(path.join(os.tmpdir(), 'stackbite-measure-owned-'));
  try {
    const files = {};
    let seed = 1008;
    for (let index = 0; index < 32; index++) {
      const bytes = Buffer.alloc(64 * 1024);
      for (let offset = 0; offset < bytes.length; offset++) {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        bytes[offset] = seed & 255;
      }
      files[`runtime/fixture-${index}.bin`] = bytes;
    }
    const platform = process.platform, value = fixture(platform, {}, files);
    const stages = [], config = { manifest: value.manifest, platform, arch: 'x64',
      cache: path.join(area, 'cache'), environment: {},
      downloadImpl: (_, destination) => fs.writeFile(destination, value.bytes, { flag: 'wx' }),
      progress: stage => stages.push({ stage, at: performance.now() }),
      spawnImpl: () => { throw new Error('setup must never spawn'); } };
    const coldStart = performance.now();
    await main(['setup'], config);
    const coldMs = performance.now() - coldStart;
    const coldStages = stages.slice(0, -1).map((item, index) => ({ stage: item.stage,
      ms: +(stages[index + 1].at - item.at).toFixed(2) }));
    config.downloadImpl = () => { throw new Error('warm path must never download'); };
    config.progress = () => {};
    const warmChecks = [], warmLaunches = [];
    for (let index = 0; index < 5; index++) {
      const start = performance.now();
      await main(['setup', '--check'], config);
      warmChecks.push(+(performance.now() - start).toFixed(2));
    }
    config.spawnImpl = () => {
      const child = new EventEmitter(); child.kill = () => {};
      queueMicrotask(() => child.emit('exit', 0, null)); return child;
    };
    for (let index = 0; index < 5; index++) {
      const start = performance.now();
      await main(['--version'], config);
      warmLaunches.push(+(performance.now() - start).toFixed(2));
    }
    console.log(JSON.stringify({ platform, node: process.version, archiveBytes: value.bytes.length,
      payloadBytes: Object.values(value.files).reduce((total, bytes) => total + bytes.length, 0),
      payloadFiles: Object.keys(value.files).length, coldMs: +coldMs.toFixed(2), coldStages,
      warmCheckMs: warmChecks, warmLaunchWithInertChildMs: warmLaunches }, null, 2));
  } finally {
    // area is exclusively owned by this mkdtemp invocation.
    await fs.rm(area, { recursive: true, force: true });
  }
}
measure().catch(error => { console.error(error.message); process.exitCode = 1; });
