'use strict';
const { createHash } = require('node:crypto');
const { gzipSync, deflateRawSync } = require('node:zlib');
const COMMIT = '5af83c540e88354a05caa789bb64a663580d5a50';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function tar(records) {
  const blocks = [];
  for (const record of records) {
    const data = Buffer.from(record.data || '');
    const header = Buffer.alloc(512);
    header.write(record.name, 0, 100, 'utf8');
    const octal = (value, offset, length) => header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii');
    octal(record.mode || 0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
    octal(data.length, 124, 12); octal(0, 136, 12);
    header.fill(32, 148, 156); header[156] = (record.type || '0').charCodeAt(0);
    if (record.link) header.write(record.link, 157, 100, 'utf8');
    header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(records) {
  const local = [], central = [];
  let offset = 0;
  for (const record of records) {
    const name = Buffer.from(record.name), data = Buffer.from(record.data || ''), crc = crc32(data);
    const method = record.method ?? 8, compressed = method === 8 ? deflateRawSync(data) : data;
    const expandedSize = record.declaredSize ?? data.length;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(expandedSize, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(expandedSize, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((record.mode || 0o100644) << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    central.push(directory, name); offset += 30 + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(records.length, 8); end.writeUInt16LE(records.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function fixture(platform = 'linux', changes = {}) {
  const host = platform === 'win32' ? 'windows-x64' : 'linux-x86_64';
  const root = `stackbite-0.5.10-${host}-${COMMIT.slice(0, 12)}`;
  const asset = root + (platform === 'win32' ? '.zip' : '.tar.gz');
  const metadata = Buffer.from(JSON.stringify({ version: '0.5.10', commit: COMMIT, product: 'Stackbite', command: 'stackbite', platform: host, ...changes }));
  const image = platform === 'win32' ? 'stackbite.exe' : 'stackbite';
  const files = { 'portable.json': metadata, 'runtime/build-info.json': metadata,
    [image]: platform === 'win32' ? Buffer.from('MZfixture image') : Buffer.from('\x7fELFfixture image'),
    'runtime/owned.txt': Buffer.from('fixed runtime fixture') };
  const hashes = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, digest(bytes)]));
  const manifestBytes = Buffer.from(JSON.stringify(hashes));
  files['SHA256SUMS.json'] = manifestBytes;
  if (platform === 'linux') files.SHA256SUMS = Buffer.from(Object.entries(hashes).map(([name, value]) => `${value}  ${name}\n`).join(''));
  const records = Object.entries(files).map(([name, data]) => ({ name: root + '/' + name, data, mode: name === image ? 0o100755 : 0o100644 }));
  const bytes = platform === 'win32' ? zip(records) : gzipSync(tar(records));
  const pinned = { asset, url: `https://github.com/Shinick-Han/stackbite/releases/download/v0.5.10/${asset}`, root,
    sha256: digest(bytes), size: bytes.length, manifestSha256: digest(manifestBytes), metadataSha256: digest(metadata) };
  const manifest = { schema: 1, version: '0.5.10', commit: COMMIT, repository: 'Shinick-Han/stackbite', platforms: { [`${platform}-x64`]: pinned } };
  return { bytes, pinned, manifest, root, files, image };
}
module.exports = { COMMIT, digest, tar, zip, fixture };
