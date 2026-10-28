'use strict';
// Characterizes refusal precedence of the installer validation phases with offline fixtures only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { releaseSpec, validatePayload } = require('../lib/bootstrap');
const { validateEntries, tarEntries } = require('../lib/archive');
const { fixture, tar } = require('./fixtures');

async function owned(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stackbite-phases-owned-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function rewrite(bytes, edit) {
  const copy = Buffer.from(bytes);
  edit(copy);
  return copy;
}
function resum(header) {
  header.fill(32, 148, 156);
  const checksum = header.subarray(0, 512).reduce((sum, value) => sum + value, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
}
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (String(length).length + body.length !== length) length = String(length).length + body.length;
  return String(length) + body;
}

test('TAR headers resolve prefix, PAX and link names and refuse malformed members in order', async t => {
  const area = await owned(t), root = fixture().root;
  const valid = tar([{ name: root + '/dir', type: '5' }, { name: root + '/file', data: 'one' },
    { name: root + '/link', type: '2', link: 'file' },
    { name: 'x', type: 'x', data: paxRecord('linkpath', 'file') }, { name: root + '/long', type: '2', link: 'ignored' }]);
  const prefixed = rewrite(tar([{ name: 'leaf', data: 'two' }]), header => { header.write(root, 345, 155, 'utf8'); resum(header); });
  const cases = [
    [valid, null],
    [prefixed, null],
    [rewrite(valid, header => { header.write('posix\0', 257, 6, 'ascii'); header[148] = 49; }), /Unsupported TAR header format/],
    [rewrite(valid, header => { header[0] ^= 1; }), /Invalid TAR checksum/],
    [tar([{ name: root + '/setuid', mode: 0o4755, type: '3' }]), /Unsafe TAR size or permissions/],
    [tar([{ name: root + '/dir', type: '5', data: 'bytes' }]), /Unsupported TAR member/],
    [tar([{ name: root + '/fifo', type: '6' }]), /Unsupported TAR member/],
    [tar([{ name: 'x', type: 'x', data: paxRecord('mtime', '1') }, { name: 'y', type: 'x', data: paxRecord('mtime', '2') }]), /Chained TAR PAX headers/],
    [tar([{ name: 'x', type: 'x', data: paxRecord('uname', 'owner') }]), /Unsupported TAR PAX field/],
    [tar([{ name: 'x', type: 'x', data: paxRecord('mtime', '1') }]), /Truncated TAR trailer/],
    [tar([{ name: root + '/file', data: 'one' }]).subarray(0, 1536), /Truncated TAR trailer/],
    [Buffer.concat([tar([{ name: root + '/file', data: 'one' }]), Buffer.from([0, 1])]), /Extra TAR payload after trailer/],
    [tar([{ name: root + '/file', data: 'one' }]).subarray(0, 1024), /TAR trailer is missing/],
    [tar([{ name: root + '/file', data: 'one' }]).subarray(0, 1000), /Unsafe TAR size or permissions/]
  ];
  for (let index = 0; index < cases.length; index++) {
    const archive = path.join(area, `case-${index}.tar`);
    await fs.writeFile(archive, cases[index][0]);
    if (cases[index][1]) { await assert.rejects(tarEntries(archive), cases[index][1], `case ${index}`); continue; }
    const entries = await tarEntries(archive);
    if (index === 0) {
      assert.deepEqual(entries, [
        { name: root + '/dir', kind: 'directory', size: 0, link: '' },
        { name: root + '/file', kind: 'file', size: 3, link: '' },
        { name: root + '/link', kind: 'link', size: 0, link: 'file' },
        { name: root + '/long', kind: 'link', size: 0, link: 'file' }]);
    } else assert.deepEqual(entries, [{ name: root + '/leaf', kind: 'file', size: 3, link: '' }]);
  }
});
test('member checks finish name/root/duplicate/size for every entry before parent and link checks', () => {
  const root = fixture().root;
  const refusals = [
    [[{ name: root + '/NUL.txt', kind: 'file', size: 1 }, { name: 'outside', kind: 'file', size: 1 }], /Unsafe archive path/],
    [[{ name: root + '/a', kind: 'link', link: '/abs', size: 0 }, { name: 'outside', kind: 'file', size: 1 }], /outside its pinned root/],
    [[{ name: root + '/A', kind: 'file', size: 1 }, { name: root + '/a', kind: 'file', size: 1 }, { name: 'outside', kind: 'file', size: 1 }], /outside its pinned root/],
    [[{ name: root + '/A', kind: 'file', size: 1 }, { name: root + '/a', kind: 'file', size: 1 }], /Duplicate archive member/, true],
    [[{ name: root + '/f', kind: 'file', size: -1 }], /expansion exceeds limit/],
    [[{ name: root + '/f', kind: 'file', size: 1 }, { name: root + '/f/l', kind: 'link', link: '/abs', size: 0 }], /another member parent/],
    [[{ name: root + '/l', kind: 'link', link: 'f', size: 0 }, { name: root + '/f', kind: 'file', size: 1 }], /Unsafe archive link/, true],
    [[{ name: root + '/l', kind: 'link', link: 'a\\b', size: 0 }], /Unsafe archive link/],
    [[{ name: root + '/l', kind: 'link', link: '../outside', size: 0 }], /escaping, dangling or chained/]
  ];
  for (const [entries, pattern, windows = false] of refusals) assert.throws(() => validateEntries(entries, root, windows), pattern);
  const entries = [{ name: root + '/d/', kind: 'directory', size: 0 }, { name: root + '/d/f', kind: 'file', size: 1 },
    { name: root + '/d/l', kind: 'link', link: 'f', size: 0 }];
  assert.equal(validateEntries(entries, root, false), entries);
  assert.equal(entries[0].name, root + '/d');
  assert.throws(() => validateEntries([{ name: root + '/A', kind: 'file', size: 1 }, { name: root + '/a', kind: 'file', size: 1 }], root, true), /Duplicate/);
  assert.doesNotThrow(() => validateEntries([{ name: root + '/A', kind: 'file', size: 1 }, { name: root + '/a', kind: 'file', size: 1 }], root, false));
});
test('release spec refuses platform, glibc, identity, then pinned asset fields in order', () => {
  const base = () => fixture().manifest;
  const glibc = { glibcVersionRuntime: '2.28' };
  const refusals = [
    [m => { m.schema = 2; }, 'darwin', {}, /supported platforms/],
    [m => { m.schema = 2; }, 'linux', { glibcVersionRuntime: undefined }, /Alpine\/musl/],
    [m => { m.schema = 2; m.platforms = {}; }, 'linux', glibc, /release identity/],
    [m => { m.commit = 'A'.repeat(40); }, 'linux', glibc, /release identity/],
    [m => { m.repository = 'other/stackbite'; }, 'linux', glibc, /release identity/],
    [m => { m.platforms = {}; }, 'linux', glibc, /pinned release asset/],
    [m => { m.platforms['linux-x64'].root += 'x'; }, 'linux', glibc, /pinned release asset/],
    [m => { m.platforms['linux-x64'].asset += 'x'; }, 'linux', glibc, /pinned release asset/],
    [m => { m.platforms['linux-x64'].metadataSha256 = 'A'.repeat(64); }, 'linux', glibc, /pinned release asset/],
    [m => { m.platforms['linux-x64'].size = 0; }, 'linux', glibc, /pinned release asset/],
    [m => { m.platforms['linux-x64'].size = 1.5; }, 'linux', glibc, /pinned release asset/]
  ];
  for (const [edit, platform, runtime, pattern] of refusals) {
    const manifest = base(); edit(manifest);
    assert.throws(() => releaseSpec(manifest, platform, 'x64', runtime), pattern);
  }
  const manifest = base(), spec = releaseSpec(manifest, 'linux', 'x64', glibc);
  assert.deepEqual(spec, { ...manifest.platforms['linux-x64'], key: 'linux-x64', platform: 'linux', host: 'linux-x86_64',
    version: manifest.version, commit: manifest.commit });
});
test('cached payload refuses root, document, member set and identity defects in order', async t => {
  const area = await owned(t);
  async function payload(name, platform, edit = () => {}) {
    const value = fixture(platform), directory = path.join(area, name);
    const files = { ...value.files };
    edit(files, value);
    for (const [member, bytes] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(directory, member)), { recursive: true });
      await fs.writeFile(path.join(directory, member), bytes);
    }
    if (Object.hasOwn(files, value.image)) await fs.chmod(path.join(directory, value.image), 0o755);
    return { directory, spec: releaseSpec(value.manifest, platform, 'x64', { glibcVersionRuntime: '2.28' }), value };
  }
  const valid = await payload('valid', 'linux');
  assert.equal(await validatePayload(valid.directory, valid.spec), path.join(await fs.realpath(valid.directory), 'stackbite'));
  const file = path.join(area, 'plain'); await fs.writeFile(file, 'x');
  await assert.rejects(validatePayload(file, valid.spec), /not a regular directory/);
  const cases = [
    ['metadata', 'linux', files => { files['portable.json'] = Buffer.from('{}'); }, /manifest or metadata SHA-256/],
    ['extra', 'linux', files => { files['runtime/extra.txt'] = Buffer.from('extra'); }, /disagree with pinned manifest/],
    ['text', 'linux', files => { files.SHA256SUMS = Buffer.from('changed'); }, /Linux checksum text/],
    ['missing-text', 'linux', files => { delete files.SHA256SUMS; }, /ENOENT/],
    ['windows-text', 'win32', files => { files.SHA256SUMS = Buffer.from('unlisted'); }, /disagree with pinned manifest/]
  ];
  for (const [name, platform, edit, pattern] of cases) {
    const bad = await payload(name, platform, edit);
    await assert.rejects(validatePayload(bad.directory, bad.spec), pattern, name);
  }
  const win = await payload('win', 'win32');
  assert.equal(await validatePayload(win.directory, win.spec), path.join(await fs.realpath(win.directory), 'stackbite.exe'));
  const wrongHost = await payload('host', 'linux');
  await assert.rejects(validatePayload(wrongHost.directory, { ...wrongHost.spec, host: 'other' }), /identity mismatch/);
});
