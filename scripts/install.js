// Builds and installs Chunk Stage everywhere it's used:
//  - into every local editor found (Cursor, VS Code): Chunk Stage and its companion;
//  - onto each SSH host given, into every editor server found there
//    (~/.cursor-server, ~/.vscode-server): Chunk Stage.
//
//   npm run deploy -- [ssh-host[:user]...]
//
// With `:user`, installs for that user (through `sudo -u`), for hosts where the
// editor's server runs as someone other than the SSH login, e.g. via RemoteCommand.
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');

const hosts = process.argv.slice(2);
const root = path.resolve(__dirname, '..');
const { version } = require('../package.json');
const main = path.join(root, `chunk-stage-${version}.vsix`);
const companion = path.join(root, `chunk-stage-companion-${version}.vsix`);
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const ssh = ['-o', 'BatchMode=yes', '-o', 'RemoteCommand=none', '-o', 'RequestTTY=no'];
const LOCAL_EDITORS = { cursor: 'Cursor', code: 'VS Code' };
/** Server folder on the remote machine, and where each editor version keeps its server binary. */
const SERVERS = {
  '.cursor-server': ['bin/*/*/bin/cursor-server', 'bin/*/bin/cursor-server', 'cli/servers/*/server/bin/cursor-server'],
  '.vscode-server': ['cli/servers/*/server/bin/code-server', 'bin/*/bin/code-server'],
};

sh('node', [path.join(__dirname, 'package.js')]);

for (const [cli, name] of Object.entries(LOCAL_EDITORS)) {
  if (spawnSync('which', [cli], { stdio: 'ignore' }).status !== 0) {
    continue;
  }
  console.log(`\nInstalling into local ${name}…`);
  // The companion first: Chunk Stage bundles it as an extension pack.
  sh(cli, ['--install-extension', companion, '--force']);
  sh(cli, ['--install-extension', main, '--force']);
}

for (const target of hosts) {
  const [host, user] = target.split(':');
  console.log(`\nInstalling on ${host}${user ? ` for ${user}` : ''}…`);
  const remoteVsix = `/tmp/chunk-stage-${version}-${process.pid}.vsix`;
  sh('scp', [...ssh, main, `${host}:${remoteVsix}`]);
  // Readable by the other user; removed by the login user once installed.
  sh('ssh', [...ssh, host, `chmod 644 ${remoteVsix}`]);
  const script = [
    'cd ~',
    'found=0',
    ...Object.entries(SERVERS).map(([dir, patterns]) =>
      [
        // Every editor version leaves its own server behind; the newest is the one in use.
        `server=$(ls -td ${patterns.map((p) => `~/${dir}/${p}`).join(' ')} 2>/dev/null | head -n 1)`,
        'if [ -n "$server" ]; then',
        `  echo "  ${dir}"`,
        `  "$server" --extensions-dir ~/${dir}/extensions --install-extension ${remoteVsix} --force || exit 1`,
        '  found=1',
        'fi',
      ].join('\n'),
    ),
    '[ "$found" = 1 ] || { echo "No editor server found; connect to this host from Cursor or VS Code once first." >&2; exit 1; }',
  ].join('\n');
  try {
    execFileSync('ssh', [...ssh, host, ...(user ? ['sudo', '-n', '-u', user] : []), 'bash', '-s'], {
      input: script,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
  } finally {
    sh('ssh', [...ssh, host, `rm -f ${remoteVsix}`]);
  }
}

console.log('\nDone. Reload open windows (Developer: Reload Window) to pick up the new version.');
if (hosts.length > 0) {
  console.log('A host first connected to from another editor later needs this run again.');
}
