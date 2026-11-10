// Build guard: electron-builder copies/creates files inside `dist/`.
//
// If the workspace itself carries a Low mandatory integrity label (folders that
// were created by a sandboxed agent session do), every packaged exe inherits
// that label. Windows then starts those exes at Low integrity, so the app cannot
// write its own userData, Chromium's sandbox initialization fails, and NSIS
// installers cannot write their install directory ("无法关闭" / silent no-op).
//
// `icacls /setintegritylevel Medium /T` is cheap and idempotent, so run it after
// every build. The second call verifies that no Low label survived.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const target = path.resolve(process.argv[2] || 'dist');
if (!fs.existsSync(target)) {
  console.error(`fix-label: ${target} does not exist (build first)`);
  process.exit(1);
}

const set = spawnSync('icacls', [target, '/setintegritylevel', 'Medium', '/T'], {
  encoding: 'utf8',
  windowsHide: true,
});
if (set.status !== 0) {
  console.error('fix-label: icacls /setintegritylevel failed');
  console.error(set.stdout || '', set.stderr || '');
  process.exit(set.status || 1);
}

const listing = spawnSync('icacls', [target, '/T'], { encoding: 'utf8', windowsHide: true });
const low = (listing.stdout || '')
  .split(/\r?\n/)
  .filter((line) => /Low Mandatory Level/.test(line));
if (low.length > 0) {
  console.error(`fix-label: ${low.length} path(s) still carry a Low integrity label:`);
  for (const line of low.slice(0, 10)) console.error('  ' + line.trim());
  process.exit(1);
}

console.log(`fix-label: integrity labels are Medium under ${target}`);
