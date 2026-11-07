// Builds both .vsix files: Chunk Stage itself and its local companion.
// They share the compiled code in out/; the companion ships only what it needs.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const vsce = path.join(root, 'node_modules', '.bin', 'vsce');
const run = (cwd, ...args) => execFileSync(vsce, ['package', ...args], { cwd, stdio: 'inherit' });

// Runs vscode:prepublish, which compiles.
run(root);

const staging = path.join(root, 'out-companion');
fs.rmSync(staging, { recursive: true, force: true });
const copy = (from, to = from) => {
  fs.mkdirSync(path.dirname(path.join(staging, to)), { recursive: true });
  fs.copyFileSync(path.join(root, from), path.join(staging, to));
};
copy('companion/package.json', 'package.json');
copy('companion/README.md', 'README.md');
copy('LICENSE');
copy('images/icon.png');
for (const file of requiredFiles(path.join(root, 'out', 'companion.js'))) {
  copy(path.relative(root, file));
}
run(staging, '--out', root);
fs.rmSync(staging, { recursive: true, force: true });

/** `entry` and the local modules it requires, transitively. */
function requiredFiles(entry, seen = new Set()) {
  if (!seen.has(entry)) {
    seen.add(entry);
    const source = fs.readFileSync(entry, 'utf8');
    for (const [, spec] of source.matchAll(/require\("(\.[^"]+)"\)/g)) {
      requiredFiles(path.resolve(path.dirname(entry), spec.endsWith('.js') ? spec : `${spec}.js`), seen);
    }
  }
  return seen;
}
