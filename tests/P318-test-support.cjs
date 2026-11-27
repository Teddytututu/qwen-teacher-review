'use strict';
const fs = require('node:fs');
const path = require('node:path');

function paths(argv = process.argv.slice(2)) {
  let root = path.resolve(__dirname, '..'), output, python = 'python3';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') {
      console.log('Usage: node tests/' + path.basename(process.argv[1]) + ' [--root REPOSITORY] --output TEMP_DIRECTORY [--python python3]');
      console.log('The repository defaults to the parent of tests/. All generated files go outside it, into --output.');
      process.exit(0);
    }
    if (!['--root', '--output', '--python'].includes(arg) || !argv[i + 1]) {
      console.error('Unknown option or missing value: ' + arg); process.exit(2);
    }
    const value = argv[++i];
    if (arg === '--root') root = path.resolve(value);
    if (arg === '--output') output = path.resolve(value);
    if (arg === '--python') python = value;
  }
  if (!output) { console.error('Provide --output TEMP_DIRECTORY. Test inputs are read-only.'); process.exit(2); }
  const relative = path.relative(root, output);
  if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    console.error('--output must be outside --root so the test source tree remains unchanged.'); process.exit(2);
  }
  fs.mkdirSync(output, {recursive: true});
  return {root, output, python, result: name => path.join(output, name)};
}

module.exports = {paths};
