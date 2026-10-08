'use strict';

function parseSetup(argv) {
  if (argv[0] !== 'setup') return null;
  if (argv.length === 1) return { checkOnly: false };
  if (argv.length === 2 && argv[1] === '--check') return { checkOnly: true };
  throw new Error('Usage: stackbite setup [--check]');
}

// Only static text goes to stderr: no URLs, environment, credentials or state.
function stageReporter(stderr) {
  const messages = {
    download: 'Downloading pinned runtime...',
    archive: 'Verifying archive...',
    extract: 'Extracting runtime...',
    validate: 'Validating runtime files...',
    publish: 'Publishing runtime cache...',
    'validate-published': 'Validating published runtime...',
    ready: 'Pinned runtime is ready.'
  };
  return stage => stderr.write(`Stackbite: ${messages[stage]}\n`);
}

module.exports = { parseSetup, stageReporter };
