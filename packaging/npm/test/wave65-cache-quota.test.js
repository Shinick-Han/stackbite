'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { main } = require('../lib/bootstrap');
const { fixture } = require('./fixtures');

async function owned(t) {
  const area = await fs.mkdtemp(path.join(os.tmpdir(), 'sb65-'));
  t.after(() => fs.rm(area, { recursive: true, force: true }));
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT'].includes(key.toUpperCase())) environment[key] = value;
  }
  for (const [key, leaf] of Object.entries({ HOME: 'home', USERPROFILE: 'home', LOCALAPPDATA: 'local',
    APPDATA: 'config', XDG_DATA_HOME: 'data', XDG_STATE_HOME: 'states', XDG_CACHE_HOME: 'cache',
    STACKBITE_STATE_DIR: 'state' })) environment[key] = path.join(area, leaf);
  environment.PYTHONDONTWRITEBYTECODE = '1';
  // npm's preparation creates parent paths. Establish the owned custom state's
  // private ACL first, as the Python publication fixtures do on Windows.
  await new Promise((resolve, reject) => {
    const child = spawn(process.env.STACKBITE_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
      ['-B', '-c', 'import os; from private_pty.private_state import ensure_directory; ensure_directory(os.environ["STACKBITE_STATE_DIR"])'],
      { cwd: path.resolve(__dirname, '../../..'), env: environment, stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnostic = '';
    child.stderr.on('data', bytes => { diagnostic += bytes; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(diagnostic)));
  });
  const cache = process.platform === 'win32' ? path.join(area, 'local/Stackbite/cache') : path.join(area, 'cache/stackbite');
  const value = fixture(process.platform, {}, {
    [process.platform === 'win32' ? 'install.ps1' : 'install.sh']: Buffer.from('# inert installer'),
  });
  return { area, environment, cache, value };
}

function sourceEngine(c, calls, diagnostics, inject = '') {
  const entry = path.resolve(__dirname, '../../../stackbite.py');
  const program = `import os,runpy,shutil,sys\n${inject}\nsys.argv=[sys.argv[1],*sys.argv[2:]]\nrunpy.run_path(sys.argv[0],run_name='__main__')`;
  return (engine, args, config) => {
    calls.push({ engine, args });
    assert.equal(args[0], '--record-install', 'failed publication must not launch an ephemeral runtime');
    const child = spawn(process.env.STACKBITE_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
      ['-B', '-c', program, entry, ...args], { ...config, cwd: path.dirname(entry), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume();
    child.stderr.on('data', bytes => diagnostics.push(bytes));
    return child;
  };
}

const quotaAndCleanup = `
original_remove=shutil.rmtree
def copy(*args,**kwargs):
    raise shutil.Error([('private-source','private-file','[Errno 122] Disk quota exceeded')]*2000)
def remove(directory,*args,**kwargs):
    if os.path.basename(directory).startswith('.staging-'):
        raise OSError(39,'Directory not empty')
    return original_remove(directory,*args,**kwargs)
shutil.copytree=copy
shutil.rmtree=remove
`;

for (const argv of [['--version'], ['--help'], ['restart']]) {
  test(`${argv[0]} reports quota and cleanup without a traceback or ephemeral launch`, async t => {
    const c = await owned(t), calls = [], diagnostics = [];
    const sibling = path.join(c.cache, 'v1-' + 'b'.repeat(64));
    await fs.mkdir(sibling, { recursive: true });
    await fs.writeFile(path.join(sibling, 'keep'), 'existing runtime');
    await assert.rejects(main(argv, { manifest: c.value.manifest, platform: process.platform, arch: process.arch,
      environment: c.environment, progress: () => {},
      downloadImpl: async (_, destination) => fs.writeFile(destination, c.value.bytes),
      spawnImpl: sourceEngine(c, calls, diagnostics, quotaAndCleanup) }), /Runtime publication was refused/);
    const message = Buffer.concat(diagnostics).toString('utf8');
    assert.match(message, /Disk quota exceeded/);
    assert.ok(message.includes(c.cache));
    assert.match(message, /cleanup deferred/);
    assert.match(message, process.platform === 'win32' ? /LOCALAPPDATA/ : /XDG_CACHE_HOME/);
    assert.doesNotMatch(message, /Traceback|private-source|private-file/);
    assert.ok(message.length < 1500, message.length);
    assert.equal(calls.length, 1);
    assert.equal(await fs.readFile(path.join(sibling, 'keep'), 'utf8'), 'existing runtime');
    const entries = await fs.readdir(c.cache);
    assert.equal(entries.filter(name => name.startsWith('.staging-')).length, 1);
    assert.deepEqual(entries.filter(name => name.startsWith('v1-')), [path.basename(sibling)]);
  });
}

test('a failed publication can retry successfully and reuse its verified cache', async t => {
  const c = await owned(t), calls = [], diagnostics = [];
  let downloads = 0;
  const options = { manifest: c.value.manifest, platform: process.platform, arch: process.arch,
    environment: c.environment, progress: () => {},
    downloadImpl: async (_, destination) => { downloads++; await fs.writeFile(destination, c.value.bytes); },
    spawnImpl: sourceEngine(c, calls, diagnostics, quotaAndCleanup) };
  await assert.rejects(main(['setup'], options), /Runtime publication was refused/);
  options.spawnImpl = sourceEngine(c, calls, diagnostics);
  assert.deepEqual(await main(['setup'], options), { code: 0, signal: null });
  assert.equal(downloads, 2);
  const root = process.platform === 'win32' ? path.join(c.area, 'local/Stackbite') : path.join(c.area, 'data/stackbite');
  const locator = await fs.readFile(path.join(root, 'default-install.json'));
  assert.deepEqual(await main(['setup'], options), { code: 0, signal: null });
  assert.equal(downloads, 2);
  assert.deepEqual(await fs.readFile(path.join(root, 'default-install.json')), locator);
});
