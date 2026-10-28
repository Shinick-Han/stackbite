'use strict';
// ZIP structural parser characterization: exact accepted entries, refusal
// precedence and file I/O order before any native extraction sees an archive.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { deflateRawSync } = require('node:zlib');
const { zipEntries } = require('../lib/archive');
const { LIMITS } = require('../lib/common');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function extraField(kind, length = 0) {
  const field = Buffer.alloc(4 + length);
  field.writeUInt16LE(kind, 0); field.writeUInt16LE(length, 2);
  return field;
}
// Each record may override any central or local field; offsets are returned for byte surgery.
function build(records, { comment = Buffer.alloc(0) } = {}) {
  const local = [], central = [], localOffsets = [], centralPositions = [];
  let offset = 0, position = 0;
  for (const record of records) {
    const name = Buffer.from(record.name), data = Buffer.from(record.data || '');
    const method = record.method ?? (data.length ? 8 : 0);
    const compressed = record.raw ?? (method === 8 ? deflateRawSync(data) : data);
    const crc = record.crc ?? crc32(data), expanded = record.expanded ?? data.length;
    const flags = record.flags ?? 0x0800, extra = record.extra || Buffer.alloc(0), localExtra = record.localExtra || Buffer.alloc(0);
    const localName = Buffer.from(record.localName ?? record.name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(record.localFlags ?? flags, 6);
    header.writeUInt16LE(record.localMethod ?? method, 8);
    if (!record.zeroLocalSizes) {
      header.writeUInt32LE(record.localCrc ?? crc, 14); header.writeUInt32LE(compressed.length, 18);
      header.writeUInt32LE(record.localExpanded ?? expanded, 22);
    }
    header.writeUInt16LE(localName.length, 26); header.writeUInt16LE(localExtra.length, 28);
    localOffsets.push(offset);
    local.push(header, localName, localExtra, compressed, record.descriptor || Buffer.alloc(0));
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(flags, 8); directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(expanded, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt16LE(extra.length, 30);
    directory.writeUInt16LE(record.commentBytes?.length ?? 0, 32); directory.writeUInt16LE(record.diskStart ?? 0, 34);
    const mode = record.mode ?? (record.name.endsWith('/') ? 0o040755 : 0o100644);
    directory.writeUInt32LE(((mode << 16) | (record.attributes ?? 0)) >>> 0, 38);
    directory.writeUInt32LE(record.localOffset ?? offset, 42);
    centralPositions.push(position);
    const entry = [directory, name, extra, record.commentBytes || Buffer.alloc(0)];
    central.push(...entry); position += Buffer.concat(entry).length;
    offset += 30 + localName.length + localExtra.length + compressed.length + (record.descriptor?.length ?? 0);
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(records.length, 8); end.writeUInt16LE(records.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(comment.length, 20);
  return { bytes: Buffer.concat([...local, directory, end, comment]), centralOffset: offset, localOffsets, centralPositions,
    endOffset: offset + directory.length };
}
const VALID = [
  { name: 'top/' },
  { name: 'top/deflated.txt', data: 'deflated '.repeat(40) },
  { name: 'top/stored.bin', data: Buffer.from([0, 1, 2, 250, 251]), method: 0 },
  { name: 'top/empty' },
  { name: 'top/ünicode.txt', data: 'utf8 name' },
];
async function owned(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stackbite-zip-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
// Record every positional read and the close of the parser's file handle.
async function traced(t, bytes) {
  const archive = path.join(await owned(t), 'archive.zip');
  await fs.writeFile(archive, bytes);
  const events = [], open = fs.open;
  fs.open = async (...args) => {
    const handle = await open(...args);
    return { stat: () => handle.stat(), close: async () => { events.push('close'); return handle.close(); },
      read: (buffer, offset, length, at) => { events.push([at, length]); return handle.read(buffer, offset, length, at); } };
  };
  t.after(() => { fs.open = open; });
  let result, error;
  try { result = await zipEntries(archive); } catch (caught) { error = caught; }
  fs.open = open;
  return { result, error, events };
}
async function refused(t, bytes, message) {
  const { error, events } = await traced(t, bytes);
  assert.ok(error, 'archive must be refused');
  assert.equal(error.message, message);
  assert.equal(events.at(-1), 'close', 'the archive handle closes after a refusal');
  assert.equal(events.filter(event => event === 'close').length, 1);
  return { error, events };
}
function mutate(zip, change) { const bytes = Buffer.from(zip.bytes); change(bytes, zip); return bytes; }

test('valid ZIP entries, sizes and read order are exact', async t => {
  const zip = build(VALID);
  const { result, error, events } = await traced(t, zip.bytes);
  assert.equal(error, undefined);
  assert.deepEqual(result, [
    { name: 'top/', kind: 'directory', size: 0 },
    { name: 'top/deflated.txt', kind: 'file', size: 360 },
    { name: 'top/stored.bin', kind: 'file', size: 5 },
    { name: 'top/empty', kind: 'file', size: 0 },
    { name: 'top/ünicode.txt', kind: 'file', size: 9 },
  ]);
  const expected = [[0, zip.bytes.length], [zip.centralOffset, zip.endOffset - zip.centralOffset]];
  for (const [index, record] of VALID.entries()) {
    const at = zip.localOffsets[index], nameLength = Buffer.byteLength(record.name);
    expected.push([at, 30], [at + 30, nameLength], [at + 30 + nameLength, 0]);
  }
  assert.deepEqual(events, [...expected, 'close']);
});

test('data descriptors, timestamps, comments and trailing EOCD comments are accepted', async t => {
  const descriptor = Buffer.alloc(16);
  const zip = build([
    { name: 'a.txt', data: 'descriptor', flags: 0x0808, zeroLocalSizes: true, descriptor },
    { name: 'b.txt', data: 'stamped', extra: extraField(0x5455, 5), localExtra: extraField(0x7875, 11), commentBytes: Buffer.from('note') },
  ], { comment: Buffer.from('archive comment') });
  const { result, error } = await traced(t, zip.bytes);
  assert.equal(error, undefined);
  assert.deepEqual(result, [{ name: 'a.txt', kind: 'file', size: 10 }, { name: 'b.txt', kind: 'file', size: 7 }]);
});

test('EOCD refusals: missing, truncated, multidisk, ZIP64 count, misplaced and trailing bytes', async t => {
  const zip = build(VALID);
  await refused(t, zip.bytes.subarray(0, zip.bytes.length - 22), 'Invalid ZIP directory');
  await refused(t, zip.bytes.subarray(0, zip.bytes.length - 1), 'Invalid ZIP directory');
  await refused(t, mutate(zip, (b, z) => b.writeUInt16LE(1, z.endOffset + 4)), 'Unsafe ZIP directory');
  await refused(t, mutate(zip, (b, z) => b.writeUInt16LE(1, z.endOffset + 6)), 'Unsafe ZIP directory');
  await refused(t, mutate(zip, (b, z) => b.writeUInt16LE(4, z.endOffset + 8)), 'Unsafe ZIP directory');
  await refused(t, mutate(zip, (b, z) => { b.writeUInt16LE(65535, z.endOffset + 8); b.writeUInt16LE(65535, z.endOffset + 10); }), 'Unsafe ZIP directory');
  await refused(t, mutate(zip, (b, z) => b.writeUInt32LE(z.centralOffset - 1, z.endOffset + 16)), 'Unsafe ZIP directory');
  await refused(t, mutate(zip, (b, z) => b.writeUInt32LE(16 * 1024 * 1024 + 1, z.endOffset + 12)), 'Unsafe ZIP directory');
  await refused(t, Buffer.concat([zip.bytes, Buffer.from('x')]), 'Unsafe ZIP directory');
  const { events } = await refused(t, mutate(zip, (b, z) => b.writeUInt16LE(1, z.endOffset + 4)), 'Unsafe ZIP directory');
  assert.deepEqual(events, [[0, zip.bytes.length], 'close'], 'no central directory read before EOCD checks pass');
});

test('central record refusals and their precedence', async t => {
  const zip = build(VALID), first = zip.centralOffset;
  await refused(t, mutate(zip, b => b.writeUInt32LE(0, first)), 'Invalid ZIP member');
  await refused(t, mutate(zip, (b, z) => { b.writeUInt16LE(6, z.endOffset + 8); b.writeUInt16LE(6, z.endOffset + 10); }), 'Invalid ZIP member');
  // Total expansion is charged before the member-level support checks.
  await refused(t, build([{ name: 'bomb', data: 'x', expanded: 0xffffffff, method: 99 }]).bytes, 'ZIP total expansion exceeds limit');
  await refused(t, build([{ name: 'big', data: 'x', expanded: LIMITS.member + 1 }]).bytes, 'Unsupported ZIP member');
  await refused(t, build([{ name: 'm', data: 'x', method: 12 }]).bytes, 'Unsupported ZIP member');
  await refused(t, build([{ name: 'e', data: 'x', flags: 0x0801 }]).bytes, 'Unsupported ZIP member');
  await refused(t, build([{ name: 'd', data: 'x', diskStart: 1 }]).bytes, 'Unsupported ZIP member');
  await refused(t, build([{ name: 'l', data: 'x', mode: 0o120777 }]).bytes, 'Unsupported ZIP member');
  await refused(t, build([{ name: 's', data: 'x', mode: 0o104755 }]).bytes, 'Unsupported ZIP member');
  await refused(t, build([{ name: 'n'.repeat(1025), data: 'x' }]).bytes, 'Unsupported ZIP member');
  await refused(t, mutate(zip, b => b.writeUInt16LE(0, first + 28)), 'Unsupported ZIP member');
  await refused(t, mutate(zip, b => b.writeUInt16LE(60000, first + 32)), 'Unsupported ZIP member');
  await refused(t, build([{ name: 'é.txt', data: 'x', flags: 0 }]).bytes, 'Ambiguous ZIP filename encoding');
  const invalid = build([{ name: 'xx', data: 'x' }]);
  const { error } = await traced(t, mutate(invalid, b => { b[30] = 0xff; b[invalid.centralOffset + 46] = 0xff; }));
  assert.equal(error.code, 'ERR_ENCODING_INVALID_ENCODED_DATA');
  await refused(t, build([{ name: 'dir/', data: 'x', method: 0 }]).bytes, 'Invalid ZIP directory member');
  await refused(t, build([{ name: 'dir', mode: 0o040755 }]).bytes, 'ZIP directory identity mismatch');
  await refused(t, build([{ name: 'dos', data: 'x', attributes: 16 }]).bytes, 'ZIP directory identity mismatch');
  const { events } = await refused(t, build([{ name: 'm', data: 'x', method: 12 }]).bytes, 'Unsupported ZIP member');
  assert.equal(events.length, 3, 'no local header is read for an unsupported central record');
});

test('local header refusals, truncation and precedence before content', async t => {
  await refused(t, build([{ name: 'a', data: 'x', localFlags: 0x0808 }]).bytes, 'ZIP local/central identity mismatch');
  await refused(t, build([{ name: 'a', data: 'x', localMethod: 0 }]).bytes, 'ZIP local/central identity mismatch');
  await refused(t, build([{ name: 'a', data: 'x', localName: 'bb' }]).bytes, 'ZIP local/central identity mismatch');
  const named = await refused(t, build([{ name: 'a', data: 'x', localName: 'b' }]).bytes, 'ZIP local/central identity mismatch');
  assert.deepEqual(named.events.slice(2), [[0, 30], [30, 1], 'close']);
  const signature = build([{ name: 'a', data: 'x' }]);
  const unsigned = await refused(t, mutate(signature, b => b.writeUInt32LE(0, 0)), 'ZIP local/central identity mismatch');
  assert.deepEqual(unsigned.events.slice(2), [[0, 30], 'close'], 'local name is not read after a header mismatch');
  await refused(t, build([{ name: 'a', data: 'x', localCrc: 1 }]).bytes, 'ZIP local size mismatch');
  await refused(t, build([{ name: 'a', data: 'x', localExpanded: 2 }]).bytes, 'ZIP local size mismatch');
  await refused(t, build([{ name: 'a', data: 'x', flags: 0x0808, localFlags: 0x0808, localCrc: 1, crc: 2 }]).bytes, 'ZIP content size/CRC mismatch');
  // Member data that reaches into the central directory is an identity failure.
  const reach = build([{ name: 'a', data: 'xyz', method: 0 }]);
  await refused(t, mutate(reach, (b, z) => { b.writeUInt32LE(4, 18); b.writeUInt32LE(4, z.centralOffset + 20); }), 'ZIP local/central identity mismatch');
  const beyond = build([{ name: 'a', data: 'x', localOffset: 1 << 30 }]);
  await refused(t, beyond.bytes, 'Truncated release archive');
});

test('content, extra field, record count and overlap refusals', async t => {
  await refused(t, build([{ name: 'a', data: 'abc', method: 0, expanded: 4, localExpanded: 4 }]).bytes, 'Invalid stored ZIP size');
  await refused(t, build([{ name: 'a', data: 'abc', crc: 1 }]).bytes, 'ZIP content size/CRC mismatch');
  await refused(t, build([{ name: 'a', data: 'abc', expanded: 4 }]).bytes, 'ZIP content size/CRC mismatch');
  await refused(t, build([{ name: 'a', data: 'a'.repeat(4096), expanded: 1 }]).bytes, 'ZIP expansion exceeds declared size');
  const corrupt = await traced(t, build([{ name: 'a', data: 'x', method: 8, raw: Buffer.from([0xff, 0xff]), expanded: 1 }]).bytes);
  assert.equal(corrupt.error.code, 'Z_DATA_ERROR');
  assert.equal(corrupt.events.at(-1), 'close');
  // Content is proven before extension fields; the central extra is checked before the local one.
  await refused(t, build([{ name: 'a', data: 'abc', crc: 1, extra: extraField(0x0001, 16) }]).bytes, 'ZIP content size/CRC mismatch');
  await refused(t, build([{ name: 'a', data: 'x', extra: extraField(0x0001, 16) }]).bytes, 'Unsupported ZIP extension');
  await refused(t, build([{ name: 'a', data: 'x', extra: extraField(0x7075, 5) }]).bytes, 'Unsupported ZIP extension');
  await refused(t, build([{ name: 'a', data: 'x', localExtra: extraField(0x0001, 16) }]).bytes, 'Unsupported ZIP extension');
  await refused(t, build([{ name: 'a', data: 'x', extra: Buffer.from([0x55, 0x54]) }]).bytes, 'Invalid ZIP extra field');
  await refused(t, build([{ name: 'a', data: 'x', extra: Buffer.from([0x55, 0x54]), localExtra: extraField(0x0001) }]).bytes, 'Invalid ZIP extra field');
  const overrun = Buffer.from(extraField(0x5455, 2)); overrun.writeUInt16LE(9, 2);
  await refused(t, build([{ name: 'a', data: 'x', localExtra: overrun }]).bytes, 'Unsupported ZIP extension');
  const zip = build(VALID);
  await refused(t, mutate(zip, (b, z) => { b.writeUInt16LE(4, z.endOffset + 8); b.writeUInt16LE(4, z.endOffset + 10); }), 'Extra ZIP directory records');
  await refused(t, build([{ name: 'a', data: 'x' }, { name: 'a', data: 'x', localOffset: 0 }]).bytes, 'Overlapping ZIP members');
  const extended = await refused(t, build([{ name: 'a', data: 'x', localExtra: extraField(0x0001, 16) }]).bytes, 'Unsupported ZIP extension');
  assert.deepEqual(extended.events.slice(2), [[0, 30], [30, 1], [31, 20], 'close']);
  const central = await refused(t, build([{ name: 'a', data: 'x', extra: extraField(0x0001), localExtra: extraField(0x5455, 1) }]).bytes, 'Unsupported ZIP extension');
  assert.deepEqual(central.events.slice(2), [[0, 30], [30, 1], [31, 5], 'close'], 'the local extra is read before either extra is checked');
});
