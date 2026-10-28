'use strict';
// Operator backend pin for a standalone StackBite state directory: the
// <state>/workstack-backend.json document that private_pty/workstack_deploy.py
// read_backend_id validates. Same schema, file and create-once rule as the
// WorkBite launcher's ensureBackendId; the ID pins this owner only and grants no
// phone execution or Work Stack Task authority. Nothing runs on import: callers
// (Phone enablement) invoke ensureBackendPin with an explicit trusted state directory.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const SCHEMA = 'stackbite.workstack-backend.v1';
const FILE = 'workstack-backend.json';
const MAXIMUM = 4096;
const BACKEND_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PREFIX = /^[a-z][a-z0-9]{0,30}-$/;
const KEY = /"(?:[^"\\]|\\.)*"\s*:/g;

class BackendPinError extends Error {
  constructor(code, message) { super(message); this.name = 'BackendPinError'; this.code = code; }
}
function refuse(code, message) { throw new BackendPinError(code, message); }

// The state directory must already exist: the native runtime owns state discovery and creation.
async function stateFile(stateDir) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir) || /[\x00-\x1f]/.test(stateDir)) {
    refuse('state_invalid', 'The StackBite state directory must be an explicit absolute path.');
  }
  let info;
  try { info = await fs.lstat(stateDir); } catch { info = null; }
  if (!info || !info.isDirectory() || info.isSymbolicLink()) {
    refuse('state_invalid', 'The StackBite state directory is missing or not a real directory; initialize StackBite first.');
  }
  return path.join(stateDir, FILE);
}

// Mirrors read_backend_id: strict UTF-8 JSON, exactly {schema, backend_id}, no duplicate keys.
function parsePin(bytes) {
  let text, document;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    document = JSON.parse(text);
  } catch { return null; }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return null;
  const keys = Object.keys(document);
  if (keys.length !== 2 || (text.match(KEY) || []).length !== 2 || document.schema !== SCHEMA) return null;
  return typeof document.backend_id === 'string' && BACKEND_ID.test(document.backend_id) ? document.backend_id : null;
}

async function readBytes(file) {
  let info;
  try { info = await fs.lstat(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    refuse('pin_unreadable', 'The StackBite backend pin is unreadable; inspect it rather than replacing it.');
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAXIMUM) {
    refuse('pin_invalid', 'The StackBite backend pin is not a small regular file; inspect it rather than replacing it.');
  }
  try { return await fs.readFile(file); } catch {
    return refuse('pin_unreadable', 'The StackBite backend pin is unreadable; inspect it rather than replacing it.');
  }
}

async function readExisting(file) {
  const bytes = await readBytes(file);
  if (bytes === null) return null;
  const backendId = bytes.length <= MAXIMUM ? parsePin(bytes) : null;
  if (!backendId) refuse('pin_invalid', 'The StackBite backend pin is invalid; inspect it rather than replacing it.');
  return backendId;
}

// Returns the configured backend ID, or null when this state has no pin yet. Never writes.
async function readBackendPin(stateDir) {
  return readExisting(await stateFile(stateDir));
}

// Publishes complete bytes with a create-new hard link: a reader sees no pin or the whole
// pin, and an existing destination (valid or not) is never replaced. Returns false if raced.
// A link error other than EEXIST leaves the outcome unknown (the link may have landed), so it
// is never reported as absence and the destination is not removed, rewritten or retried here.
async function publish(file, bytes) {
  const temporary = path.join(path.dirname(file), `.${FILE}.${randomBytes(8).toString('hex')}.tmp`);
  let handle, linking = false;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close(); handle = null;
    linking = true;
    await fs.link(temporary, file);
    return true;
  } catch (error) {
    if (linking && error.code === 'EEXIST') return false;
    if (linking) {
      refuse('pin_outcome_unknown', 'The StackBite backend pin publication outcome is unknown; read the pin again before retrying.');
    }
    return refuse('pin_unpublished', 'The StackBite backend pin could not be prepared; this attempt did not configure a pin.');
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

// Creates the pin once or reuses the existing valid one. Result state is 'created' only when
// the published file reads back byte-identical; invalid or unreadable pins are refused, not repaired.
async function ensureBackendPin(stateDir, { prefix = 'stackbite-' } = {}) {
  if (typeof prefix !== 'string' || !PREFIX.test(prefix)) refuse('prefix_invalid', 'Backend pin prefix is invalid.');
  const file = await stateFile(stateDir);
  const existing = await readExisting(file);
  if (existing) return { backendId: existing, state: 'reused' };
  const backendId = `${prefix}${randomBytes(12).toString('hex')}`;
  const bytes = Buffer.from(JSON.stringify({ schema: SCHEMA, backend_id: backendId }) + '\n');
  if (!await publish(file, bytes)) {
    const raced = await readExisting(file);
    if (!raced) refuse('pin_unverified', 'The StackBite backend pin disappeared during creation; inspect the state directory.');
    return { backendId: raced, state: 'reused' };
  }
  const published = await readBytes(file);
  if (!published || !published.equals(bytes)) {
    refuse('pin_unverified', 'The StackBite backend pin changed during creation; inspect it before use.');
  }
  return { backendId, state: 'created' };
}

module.exports = { ensureBackendPin, readBackendPin, BackendPinError, SCHEMA, FILE };
