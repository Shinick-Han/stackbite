'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { main, releaseSpec } = require('../lib/bootstrap');
const { fixture } = require('./fixtures');
const pythonOracle = require('./python-oracle');

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
      { cwd: pythonOracle.root(), env: environment, stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnostic = '';
    child.stderr.on('data', bytes => { diagnostic += bytes; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(diagnostic)));
  });
  const cache = process.platform === 'win32' ? path.join(area, 'local/Stackbite/cache') : path.join(area, 'cache/stackbite');
  const root = process.platform === 'win32' ? path.join(area, 'local/Stackbite') : path.join(area, 'data/stackbite');
  const value = fixture(process.platform, {}, {
    [process.platform === 'win32' ? 'install.ps1' : 'install.sh']: Buffer.from('# inert installer'),
  });
  return { area, environment, cache, root, app: path.join(root, 'app'), value };
}

function sourceEngine(c, calls, diagnostics, inject = '') {
  const entry = path.join(pythonOracle.root(), 'stackbite.py');
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
    if os.path.basename(directory).startswith('.install-'):
        raise OSError(39,'Directory not empty')
    return original_remove(directory,*args,**kwargs)
shutil.copytree=copy
shutil.rmtree=remove
`;

function launcher(c, calls, diagnostics, inject, counter = { downloads: 0 }) {
  const stdout = [];
  return { manifest: c.value.manifest, platform: process.platform, arch: process.arch,
    environment: c.environment, progress: () => {}, counter, stdout: { write: text => stdout.push(text) }, printed: stdout,
    stderr: { write: () => {} },
    downloadImpl: async (_, destination) => { counter.downloads++; await fs.writeFile(destination, c.value.bytes); },
    spawnImpl: sourceEngine(c, calls, diagnostics, inject) };
}
const locator = async c => JSON.parse(await fs.readFile(path.join(c.root, 'default-install.json'), 'utf8'));

for (const argv of [['--version'], ['--help']]) {
  test(`cold ${argv[0]} answers from the pinned release without download, publication or spawn`, async t => {
    const c = await owned(t), calls = [], diagnostics = [];
    const options = launcher(c, calls, diagnostics);
    options.downloadImpl = () => assert.fail('cold help/version must not download');
    options.spawnImpl = () => assert.fail('cold help/version must not start a runtime');
    assert.deepEqual(await main(argv, options), { code: 0, signal: null });
    const text = options.printed.join('');
    if (argv[0] === '--version') assert.equal(text, `Stackbite ${c.value.manifest.version} (${c.value.manifest.commit})\n`);
    else assert.match(text, /stackbite setup/);
    await assert.rejects(fs.lstat(c.app), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(c.cache), { code: 'ENOENT' });
  });
}

test('restart reports quota at the durable runtime root without a traceback or ephemeral launch', async t => {
  const c = await owned(t), calls = [], diagnostics = [];
  const sibling = path.join(c.app, '0.0.1-bbbbbbbbbbbb');
  await fs.mkdir(sibling, { recursive: true });
  await fs.writeFile(path.join(sibling, 'keep'), 'existing runtime');
  await assert.rejects(main(['restart'], launcher(c, calls, diagnostics, quotaAndCleanup)), /Runtime publication was refused/);
  const message = Buffer.concat(diagnostics).toString('utf8');
  assert.match(message, /Disk quota exceeded/);
  assert.ok(message.includes(c.app), message);
  assert.match(message, /cleanup deferred/);
  assert.match(message, process.platform === 'win32' ? /LOCALAPPDATA/ : /XDG_DATA_HOME/);
  assert.doesNotMatch(message, /Traceback|private-source|private-file/);
  assert.ok(message.length < 1500, message.length);
  assert.equal(calls.length, 1);
  assert.equal(await fs.readFile(path.join(sibling, 'keep'), 'utf8'), 'existing runtime');
  const entries = await fs.readdir(c.app);
  assert.equal(entries.filter(name => name.startsWith('.install-')).length, 1);
  assert.deepEqual(entries.filter(name => !name.startsWith('.')), [path.basename(sibling)]);
  await assert.rejects(fs.lstat(path.join(c.root, 'default-install.json')), { code: 'ENOENT' });
});

test('a failed publication retries; the durable runtime survives clearing the disposable cache', async t => {
  const c = await owned(t), calls = [], diagnostics = [];
  const options = launcher(c, calls, diagnostics, quotaAndCleanup);
  await assert.rejects(main(['setup'], options), /Runtime publication was refused/);
  options.spawnImpl = sourceEngine(c, calls, diagnostics);
  assert.deepEqual(await main(['setup'], options), { code: 0, signal: null });
  assert.equal(options.counter.downloads, 2);
  const saved = await locator(c);
  assert.equal(path.dirname(saved.home), c.app);
  const bytes = await fs.readFile(path.join(c.root, 'default-install.json'));
  await fs.rm(c.cache, { recursive: true, force: true });
  await fs.rm(c.environment.XDG_CACHE_HOME, { recursive: true, force: true });
  assert.deepEqual(await main(['setup'], options), { code: 0, signal: null });
  assert.equal(options.counter.downloads, 2);
  assert.deepEqual(await fs.readFile(path.join(c.root, 'default-install.json')), bytes);
});

test('a selection in the previous cache layout is copied to the durable root with its state and identity', async t => {
  const c = await owned(t), calls = [], diagnostics = [];
  const options = launcher(c, calls, diagnostics);
  assert.deepEqual(await main(['setup'], options), { code: 0, signal: null });
  const before = await locator(c), image = before.home;
  // Recreate the previous layout: the cache image is the selected home.
  const spec = releaseSpec(c.value.manifest, process.platform, process.arch);
  const legacy = path.join(c.cache, 'v1-' + createHash('sha256').update(JSON.stringify([spec.version, spec.commit, spec.key, spec.sha256])).digest('hex'));
  await fs.mkdir(c.cache, { recursive: true });
  await fs.cp(image, legacy, { recursive: true });
  await fs.writeFile(path.join(c.root, 'default-install.json'), JSON.stringify({ ...before, home: legacy }));
  await fs.rm(image, { recursive: true });
  options.downloadImpl = () => assert.fail('a verified previous-layout image must not download');
  assert.deepEqual(await main(['setup'], options), { code: 0, signal: null });
  const after = await locator(c);
  assert.equal(after.home, image);
  assert.equal(after.state, before.state);
  assert.equal(after.installation_id, before.installation_id);
  // The previous image is only read: a live process may still run from it.
  assert.ok((await fs.stat(path.join(legacy, path.basename(c.value.image)))).isFile());
  assert.deepEqual(await main(['setup'], options), { code: 0, signal: null });
  assert.deepEqual(await locator(c), after);
});

test('a different archive of the same release publishes a pin-qualified sibling and leaves the image intact', async t => {
  const c = await owned(t), calls = [], diagnostics = [];
  const options = launcher(c, calls, diagnostics);
  assert.deepEqual(await main(['setup'], options), { code: 0, signal: null });
  const before = await locator(c);
  const next = fixture(process.platform, {}, { [process.platform === 'win32' ? 'install.ps1' : 'install.sh']: Buffer.from('# inert installer'),
    'runtime/next.txt': Buffer.from('a re-signed archive of the same build') });
  const spec = releaseSpec(next.manifest, process.platform, process.arch);
  options.manifest = next.manifest;
  options.downloadImpl = async (_, destination) => fs.writeFile(destination, next.bytes);
  assert.deepEqual(await main(['setup'], options), { code: 0, signal: null });
  const sibling = path.basename(before.home).replace(spec.version, `${spec.version}-pin${spec.sha256.slice(0, 10)}`);
  assert.deepEqual((await fs.readdir(c.app)).filter(name => !name.startsWith('.')).sort(), [path.basename(before.home), sibling].sort());
  await fs.access(path.join(c.app, sibling, 'runtime', 'next.txt'));
  await assert.rejects(fs.access(path.join(before.home, 'runtime', 'next.txt')), { code: 'ENOENT' });
  // The established selection is unchanged; the pinned launcher runs its own image.
  assert.deepEqual(await locator(c), before);
});
