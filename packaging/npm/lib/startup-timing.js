'use strict';
// Optional bounded launcher phase timing; the same off-by-default JSONL contract as
// private_pty/startup_timing.py (docs/startup-timing.md). Only fixed phase names,
// monotonic offsets from Node process start, wall-clock start and ok/raised are
// written: never arguments, paths, URLs, errors or credentials. Recording failures
// are ignored and never change verification, refusal or launch.
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const ENVIRONMENT = 'STACKBITE_STARTUP_TIMING_FILE';
const SCHEMA = 'stackbite-startup-timing-v1';
const MAX_RECORDS = 128;
const NAME = /^[a-z][a-z0-9_.-]{0,63}$/;
let written = 0;

function target(environment) {
  const value = environment[ENVIRONMENT];
  return typeof value === 'string' && value && path.isAbsolute(value) ? value : null;
}
function record(environment, name, started, outcome, ended = performance.now()) {
  const file = target(environment);
  if (file === null || !NAME.test(name) || written >= MAX_RECORDS) return;
  written++;
  const line = JSON.stringify({ schema: SCHEMA, pid: process.pid, phase: name,
    start_ms: Math.round(started * 1000) / 1000, ms: Math.round((ended - started) * 1000) / 1000,
    wall_ms: Math.round(performance.timeOrigin + started), outcome }) + '\n';
  const { O_WRONLY, O_CREAT, O_APPEND, O_NOFOLLOW = 0 } = fs.constants;
  try {
    const descriptor = fs.openSync(file, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW, 0o600);
    try { fs.writeSync(descriptor, line); } finally { fs.closeSync(descriptor); }
  } catch { /* advisory only */ }
}
// Times one awaited step; its result or rejection passes through unchanged.
async function phase(environment, name, step) {
  const started = performance.now();
  try {
    const result = await step();
    record(environment, name, started, 'ok');
    return result;
  } catch (error) {
    record(environment, name, started, 'raised');
    throw error;
  }
}
// A zero-length phase: the moment a step (such as the native exec) begins.
function mark(environment, name) {
  const now = performance.now();
  record(environment, name, now, 'ok', now);
}
function resetForTest() { written = 0; }

module.exports = { ENVIRONMENT, SCHEMA, MAX_RECORDS, phase, mark, resetForTest };
