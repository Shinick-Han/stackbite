'use strict';
const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const { createGunzip, createInflateRaw } = require('node:zlib');
const { Transform, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { LIMITS, fail, memberPath } = require('./common');
const utf8 = new TextDecoder('utf-8', { fatal: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

async function readAt(file, offset, length) {
  const bytes = Buffer.alloc(length);
  const { bytesRead } = await file.read(bytes, 0, length, offset);
  if (bytesRead !== length) fail('Truncated release archive');
  return bytes;
}
function validateEntries(entries, root, windows) {
  if (!entries.length || entries.length > LIMITS.members) fail('Invalid archive member count');
  const names = memberNames(entries, root, windows);
  for (const entry of entries) {
    checkMemberParents(entry, names, windows);
    if (entry.kind === 'link') checkMemberLink(entry, names, root, windows);
  }
  return entries;
}
// Normalizes names in place, then charges root, duplicate (case-folded on Windows) and size checks in member order.
function memberNames(entries, root, windows) {
  const names = new Map();
  let expanded = 0;
  for (const entry of entries) {
    entry.name = memberPath(entry.name);
    if (entry.name !== root && !entry.name.startsWith(root + '/')) fail('Archive member is outside its pinned root');
    const key = windows ? entry.name.toLowerCase() : entry.name;
    if (names.has(key)) fail('Duplicate archive member');
    names.set(key, entry);
    expanded += entry.size;
    if (entry.size < 0 || entry.size > LIMITS.member || expanded > LIMITS.expanded) fail('Archive expansion exceeds limit');
  }
  return names;
}
function checkMemberParents(entry, names, windows) {
  for (let parent = path.posix.dirname(entry.name); parent !== '.'; parent = path.posix.dirname(parent)) {
    const ancestor = names.get(windows ? parent.toLowerCase() : parent);
    if (ancestor && ancestor.kind !== 'directory') fail('Archive link/file is another member parent');
  }
}
function checkMemberLink(entry, names, root, windows) {
  if (windows || !entry.link || entry.link.length > 1024 || /[\\:\x00-\x1f\x7f]/.test(entry.link)
      || path.posix.isAbsolute(entry.link)) fail('Unsafe archive link');
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(entry.name), entry.link));
  const destination = names.get(target);
  if (!target.startsWith(root + '/') || !destination || destination.kind !== 'file') fail('Archive link is escaping, dangling or chained');
}
// End of central directory: one disk, no ZIP64 count, directory ending exactly at the EOCD.
async function zipDirectory(file) {
  const size = (await file.stat()).size;
  const tailStart = Math.max(0, size - 65557);
  const tail = await readAt(file, tailStart, size - tailStart);
  const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > tail.length) fail('Invalid ZIP directory');
  const count = tail.readUInt16LE(end + 10), directorySize = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
  if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || tail.readUInt16LE(end + 8) !== count
      || count === 65535 || count > LIMITS.members || directorySize > 16 * 1024 * 1024
      || offset + directorySize !== tailStart + end || end + 22 + tail.readUInt16LE(end + 20) !== tail.length) fail('Unsafe ZIP directory');
  return { count, offset, central: await readAt(file, offset, directorySize) };
}
function zipSupported(central, position, { flags, method, expanded, nameSize, extraSize, commentSize, mode }) {
  if (!nameSize || nameSize > 1024 || position + 46 + nameSize + extraSize + commentSize > central.length
      || central.readUInt16LE(position + 34) || (flags & ~0x080e) || ![0, 8].includes(method)
      || expanded > LIMITS.member || ![0, 0o100000, 0o040000].includes(mode & 0o170000) || (mode & 0o7000)) fail('Unsupported ZIP member');
}
function zipName(rawName, flags) {
  if (!(flags & 0x0800) && rawName.some(value => value > 127)) fail('Ambiguous ZIP filename encoding');
  return utf8.decode(rawName);
}
function zipDirectoryIdentity({ directory, expanded, compressed, mode, attributes }) {
  if (directory && (expanded || compressed)) fail('Invalid ZIP directory member');
  const directoryMode = (mode & 0o170000) === 0o040000 || !!(attributes & 16);
  if (directoryMode && !directory) fail('ZIP directory identity mismatch');
}
// One central record; the running expansion total is charged before member support checks.
function zipCentralRecord(central, position, totalExpanded) {
  if (position + 46 > central.length || central.readUInt32LE(position) !== 0x02014b50) fail('Invalid ZIP member');
  const expanded = central.readUInt32LE(position + 24), attributes = central.readUInt32LE(position + 38);
  const record = { flags: central.readUInt16LE(position + 8), method: central.readUInt16LE(position + 10),
    crc: central.readUInt32LE(position + 16), compressed: central.readUInt32LE(position + 20), expanded,
    total: totalExpanded + expanded };
  if (record.total > LIMITS.expanded) fail('ZIP total expansion exceeds limit');
  Object.assign(record, { nameSize: central.readUInt16LE(position + 28), extraSize: central.readUInt16LE(position + 30),
    commentSize: central.readUInt16LE(position + 32), localOffset: central.readUInt32LE(position + 42),
    mode: attributes >>> 16, attributes });
  zipSupported(central, position, record);
  record.rawName = central.subarray(position + 46, position + 46 + record.nameSize);
  record.name = zipName(record.rawName, record.flags);
  record.directory = record.name.endsWith('/');
  zipDirectoryIdentity(record);
  record.extra = central.subarray(position + 46 + record.nameSize, position + 46 + record.nameSize + record.extraSize);
  record.next = position + 46 + record.nameSize + record.extraSize + record.commentSize;
  return record;
}
// The local header must repeat the central identity; sizes too unless a data descriptor follows.
async function zipLocalHeader(file, record, directoryOffset) {
  const { localOffset, flags, method, nameSize, compressed } = record;
  const local = await readAt(file, localOffset, 30);
  const localNameSize = local.readUInt16LE(26), localExtraSize = local.readUInt16LE(28);
  const dataStart = localOffset + 30 + localNameSize + localExtraSize;
  if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method
      || localNameSize !== nameSize || dataStart + compressed > directoryOffset
      || !(await readAt(file, localOffset + 30, localNameSize)).equals(record.rawName)) fail('ZIP local/central identity mismatch');
  if (!(flags & 8) && (local.readUInt32LE(14) !== record.crc
      || local.readUInt32LE(18) !== compressed || local.readUInt32LE(22) !== record.expanded)) fail('ZIP local size mismatch');
  return { dataStart, extraStart: localOffset + 30 + localNameSize, extraSize: localExtraSize };
}
function zipDigest(expanded) {
  const digest = { size: 0, crc: 0xffffffff };
  digest.sink = new Writable({ write(chunk, encoding, callback) {
    digest.size += chunk.length;
    if (digest.size > expanded) return callback(new Error('ZIP expansion exceeds declared size'));
    for (const byte of chunk) digest.crc = (digest.crc >>> 8) ^ crcTable[(digest.crc ^ byte) & 255];
    callback();
  } });
  return digest;
}
// Bound the actual inflated bytes, not only the central-directory claim,
// before handing the same archive to the native extraction command.
async function zipContent(archive, { method, compressed, expanded, crc }, dataStart, signal) {
  if (method === 0 && compressed !== expanded) fail('Invalid stored ZIP size');
  const digest = zipDigest(expanded);
  if (compressed) {
    const input = createReadStream(archive, { start: dataStart, end: dataStart + compressed - 1 });
    if (method === 8) await pipeline(input, createInflateRaw(), digest.sink, { signal });
    else await pipeline(input, digest.sink, { signal });
  }
  if (digest.size !== expanded || ((digest.crc ^ 0xffffffff) >>> 0) !== crc) fail('ZIP content size/CRC mismatch');
}
// Reject Unicode-path/ZIP64 extra fields: native tar must use the same name
// and sizes checked here, without a second interpretation of this entry.
function zipExtraFields(extra) {
  for (let at = 0; at < extra.length;) {
    if (at + 4 > extra.length) fail('Invalid ZIP extra field');
    const kind = extra.readUInt16LE(at), length = extra.readUInt16LE(at + 2);
    if (![0x5455, 0x7875].includes(kind) || at + 4 + length > extra.length) fail('Unsupported ZIP extension');
    at += 4 + length;
  }
}
// Local identity, then content, then both extra fields; returns the member's byte range.
async function zipMember(file, archive, record, directoryOffset, signal) {
  const local = await zipLocalHeader(file, record, directoryOffset);
  if (!record.directory) await zipContent(archive, record, local.dataStart, signal);
  const localExtra = await readAt(file, local.extraStart, local.extraSize);
  zipExtraFields(record.extra);
  zipExtraFields(localExtra);
  return [record.localOffset, local.dataStart + record.compressed];
}
function zipRanges(ranges) {
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((range, index) => index && range[0] < ranges[index - 1][1])) fail('Overlapping ZIP members');
}
async function zipEntries(archive) {
  const file = await fs.open(archive, 'r');
  const signal = AbortSignal.timeout(LIMITS.timeout);
  try {
    const { count, offset, central } = await zipDirectory(file);
    const entries = [], ranges = [];
    let position = 0, totalExpanded = 0;
    for (let index = 0; index < count; index++) {
      signal.throwIfAborted();
      const record = zipCentralRecord(central, position, totalExpanded);
      ranges.push(await zipMember(file, archive, record, offset, signal));
      entries.push({ name: record.name, kind: record.directory ? 'directory' : 'file', size: record.expanded });
      totalExpanded = record.total;
      position = record.next;
    }
    if (position !== central.length) fail('Extra ZIP directory records');
    zipRanges(ranges);
    return entries;
  } finally { await file.close(); }
}
function tarNumber(bytes) {
  const value = bytes.toString('ascii').replace(/\0.*$/, '').trim();
  if (value && !/^[0-7]+$/.test(value)) fail('Unsupported TAR numeric field');
  const result = Number.parseInt(value || '0', 8);
  if (!Number.isSafeInteger(result)) fail('Invalid TAR size');
  return result;
}
function tarText(bytes) { return utf8.decode(bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0))); }
function paxFields(bytes) {
  const fields = {};
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset);
    if (space < 0 || !/^\d+$/.test(bytes.subarray(offset, space).toString())) fail('Invalid TAR PAX length');
    const length = Number(bytes.subarray(offset, space).toString());
    if (!Number.isSafeInteger(length) || length <= space - offset + 2 || offset + length > bytes.length || bytes[offset + length - 1] !== 10) fail('Invalid TAR PAX record');
    const record = utf8.decode(bytes.subarray(space + 1, offset + length - 1));
    const equal = record.indexOf('=');
    const key = record.slice(0, equal), value = record.slice(equal + 1);
    if (equal < 1 || !['path', 'linkpath', 'mtime', 'atime', 'ctime'].includes(key) || Object.hasOwn(fields, key)) fail('Unsupported TAR PAX field');
    fields[key] = value;
    offset += length;
  }
  return fields;
}
// The first zero block ends the archive: at least one more block, then only zero bytes to EOF.
async function tarTrailer(file, offset, total, pax) {
  if (pax || offset + 512 > total) fail('Truncated TAR trailer');
  for (let at = offset; at < total; at += 65536) {
    if (!(await readAt(file, at, Math.min(65536, total - at))).every(value => value === 0)) fail('Extra TAR payload after trailer');
  }
}
// ustar identity, checksum, then size and permission bounds for the member data after offset.
function tarHeader(header, offset, total) {
  if (header.subarray(257, 263).toString('ascii') !== 'ustar\0') fail('Unsupported TAR header format');
  let checksum = 0;
  for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index];
  if (checksum !== tarNumber(header.subarray(148, 156))) fail('Invalid TAR checksum');
  const size = tarNumber(header.subarray(124, 136));
  const kind = String.fromCharCode(header[156]);
  if (size > (kind === 'x' ? 65536 : LIMITS.member) || offset + Math.ceil(size / 512) * 512 > total
      || tarNumber(header.subarray(100, 108)) & 0o7000) fail('Unsafe TAR size or permissions');
  return { size, kind };
}
// A pending PAX record overrides the header name and link target.
function tarMember(header, kind, size, pax) {
  if (!['\0', '0', '5', '2'].includes(kind) || (kind !== '0' && kind !== '\0' && size)) fail('Unsupported TAR member');
  const prefix = tarText(header.subarray(345, 500));
  const name = pax && Object.hasOwn(pax, 'path') ? pax.path : (prefix ? prefix + '/' : '') + tarText(header.subarray(0, 100));
  return { name, kind: kind === '5' ? 'directory' : kind === '2' ? 'link' : 'file', size,
    link: pax && Object.hasOwn(pax, 'linkpath') ? pax.linkpath : tarText(header.subarray(157, 257)) };
}
async function tarEntries(archive) {
  const file = await fs.open(archive, 'r');
  try {
    const total = (await file.stat()).size;
    const entries = [];
    let offset = 0, pax = null, headers = 0;
    while (offset + 512 <= total) {
      const header = await readAt(file, offset, 512);
      offset += 512;
      if (header.every(value => value === 0)) {
        await tarTrailer(file, offset, total, pax);
        return entries;
      }
      if (++headers > LIMITS.members * 2) fail('Too many TAR headers');
      const { size, kind } = tarHeader(header, offset, total);
      if (kind === 'x') {
        if (pax) fail('Chained TAR PAX headers');
        pax = paxFields(await readAt(file, offset, size));
      } else {
        entries.push(tarMember(header, kind, size, pax));
        pax = null;
      }
      offset += Math.ceil(size / 512) * 512;
    }
    fail('TAR trailer is missing');
  } finally { await file.close(); }
}
async function boundedGunzip(archive, destination) {
  let size = 0;
  const bounded = new Transform({ transform(chunk, encoding, callback) {
    size += chunk.length;
    callback(size > LIMITS.expanded ? new Error('TAR expansion exceeds limit') : null, chunk);
  } });
  await pipeline(createReadStream(archive), createGunzip(), bounded,
    createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal: AbortSignal.timeout(LIMITS.timeout) });
}
function nativeTar() {
  return process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
}
async function extractArchive(archive, destination, spec, { spawnImpl = spawn } = {}) {
  let input = archive;
  const windows = spec.asset.endsWith('.zip');
  if (!windows) { input = archive + '.tar'; await boundedGunzip(archive, input); }
  const entries = windows ? await zipEntries(input) : await tarEntries(input);
  validateEntries(entries, spec.root, windows);
  await new Promise((resolve, reject) => {
    const child = spawnImpl(nativeTar(), ['-xf', input, '-C', destination, '--no-same-owner', ...(spec.platform === 'darwin' ? ['-p'] : ['--no-same-permissions'])],
      { shell: false, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let errorBytes = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Native tar extraction timed out')); }, LIMITS.timeout);
    child.stderr.on('data', chunk => { errorBytes += chunk.length; if (errorBytes > 65536) { child.kill(); } });
    child.once('error', () => { clearTimeout(timer); reject(new Error('Native tar is unavailable; install the operating system tar command')); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Native tar rejected the release archive')); });
  });
  return entries;
}
module.exports = { validateEntries, zipEntries, tarEntries, extractArchive, nativeTar };
