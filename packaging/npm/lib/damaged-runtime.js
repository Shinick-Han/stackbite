'use strict';
// A published runtime of this package's exact pin that fails validation is
// never run. These entries answer from the pin, name the repair, and remove
// through a private, verified copy of the pinned runtime.
const fs = require('node:fs/promises');
const path = require('node:path');
const { inside } = require('./common');

const HELP = ['--help', '-h'];
const removal = argv => ['uninstall', 'delete'].includes(argv[0]);
const done = { code: 1, signal: null };

// Static text plus the pinned version and the validation reason; no paths or state.
function advice(spec, damaged) {
  return `the installed Stackbite ${spec.version} runtime failed verification (${damaged.reason}) and was not run.\n`
    + 'Repair: run stackbite uninstall --keep-data (data and hooks are kept), then stackbite setup; if removal\n'
    + `also removed the npm command, first run npm install --global stackbite@${spec.version}.\n`
    + 'Remove: run stackbite uninstall (stackbite uninstall --preview lists the plan first).\n'
    + 'Removal downloads a private verified copy of the pinned runtime for that command only.\n';
}

// --help/--version and uninstall --help answer from the pin. The exit code is
// 1: the question is answered on stdout, and the installation is not usable.
function answer(argv, spec, damaged, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const single = argv.length === 1 ? argv[0] : null;
  if (single === '--version') stdout.write(`Stackbite ${spec.version} (${spec.commit})\n`);
  else if (HELP.includes(single)) {
    stdout.write('usage: stackbite [--help | --version] | stackbite setup [--check] | stackbite uninstall [--preview] [--keep-data | --all]\n\n'
      + `This is the pinned Stackbite ${spec.version} launcher. Its installed runtime is damaged, so the full\n`
      + 'reference is unavailable until it is repaired.\n');
  } else if (removal(argv) && argv.slice(1).some(arg => HELP.includes(arg))) {
    stdout.write(`usage: stackbite ${argv[0]} [-h] [--keep-data | --all] [--preview] [--apply] [--resume] [--yes]\n\n`
      + 'Remove Stackbite. --preview lists removal targets without changes; --keep-data keeps data and\n'
      + 'hooks; --all also removes selected product data and owned provider hooks.\n');
  } else return null;
  stderr.write('Stackbite: ' + advice(spec, damaged));
  return done;
}

// The validation error, unchanged, followed by the repair and removal commands.
function explain(error, spec, damaged) {
  error.message = `${error.message}\nStackbite: ${advice(spec, damaged).trimEnd()}`;
  error.code ??= 'STACKBITE_RUNTIME_DAMAGED';
  return error;
}

// The stage holds the runtime of a helper the engine handed this removal to
// while the installation's journal names an image inside it. An unreadable
// journal keeps the stage.
async function stageNeeded(journal, staging, request) {
  let record;
  try {
    const info = await fs.lstat(journal);
    if (!info.isFile() || info.size > 8 * 1024 * 1024) return true;
    record = JSON.parse((await fs.readFile(journal, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) { return error.code !== 'ENOENT'; }
  if (request !== undefined && record?.request_id !== request) return false;
  const runtime = record?.parent_resume?.runtime?.path;
  if (typeof runtime !== 'string' || !path.isAbsolute(runtime)) return false;
  return [staging, await fs.realpath(staging)].some(root => inside(root, path.resolve(runtime)));
}

// Removal and its preview run the original argv in a private, verified copy of
// this package's pinned runtime. Nothing is published and the damaged image is
// only read. The engine keeps every identity, ownership and process guard; it
// alone decides what is removed. `tools` are bootstrap's own stage/launch
// functions; `tools.diagnose` repeats the diagnosis that selected this entry.
async function remove(argv, spec, damaged, environment, tools, options = {}) {
  const registrationTools = require('./uninstall-registration');
  const apply = registrationTools.explicitApply(argv);
  if (!apply && !(removal(argv) && argv.length === 2 && argv[1] === '--preview')) return null;
  const stderr = options.stderr || process.stderr;
  stderr.write(`Stackbite: the installed Stackbite ${spec.version} runtime failed verification (${damaged.reason}) and is not run.\n`
    + 'Stackbite: this command uses a private verified copy of the pinned runtime instead.\n');
  // The stage is this invocation's own (tools.createStage records its identity),
  // so tools.removeStage may remove it; a failed removal is cleanup debt and
  // never replaces the outcome of the command.
  const staging = await tools.createStage();
  const outcome = { failed: false, error: undefined };
  let retained = false;
  try {
    let staged;
    try { staged = await tools.stageRelease(spec, staging); }
    catch (error) {
      throw new Error(`${damaged.reason}\nStackbite: a private verified copy of the pinned runtime could not be prepared (${error.message}). `
        + 'Nothing was run or removed. Retry when GitHub release downloads are reachable.');
    }
    const current = await tools.diagnose();
    if (!current || current.target !== damaged.target || current.reason !== damaged.reason) {
      throw new Error('Stackbite installation changed while staging its runtime; nothing was run');
    }
    const { npm, unavailable } = apply ? await registrationTools.optionalDescriptor(options) : { npm: null, unavailable: null };
    const result = await tools.launchNative(staged.executable, argv, { ...environment,
      ...(npm ? { STACKBITE_NPM_REGISTRATION: JSON.stringify(npm) } : {}),
      STACKBITE_HOME: path.resolve(staged.payload) }, options);
    retained = await stageNeeded(tools.journal, staging);
    return registrationTools.settleWithoutNpm(argv, result, unavailable, options.platform || process.platform);
  } catch (error) { outcome.failed = true; outcome.error = error; throw error; }
  finally {
    if (!retained) {
      await tools.settleCleanup(outcome, () => tools.removeStage(staging), { kind: 'staging', path: staging }, tools.reportDebt);
    }
  }
}

module.exports = { answer, explain, remove, stageNeeded };
