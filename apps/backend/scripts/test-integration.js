/**
 * Windows-safe runner for the in-band integration suite: `npm run
 * test:integration`. npm executes scripts through cmd.exe on Windows, where
 * the POSIX `TEST_INTEGRATION=1 jest --runInBand` inline-env form does not
 * work — this shim sets the flag in-process and spawns the LOCAL jest CLI
 * with `--runInBand` (parallel jest workers deadlock SERIALIZABLE loading
 * transactions).
 */
process.env.TEST_INTEGRATION = '1';

const { spawn } = require('child_process');
const path = require('path');

// `jest/bin/jest.js` is NOT exported by the jest package's "exports" map —
// resolve through jest-cli (the actual implementation package).
const jestBin = path.join(
  path.dirname(require.resolve('jest-cli/package.json')),
  'bin',
  'jest.js',
);
const child = spawn(process.execPath, [jestBin, '--runInBand', ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: path.resolve(__dirname, '..'),
});
child.on('exit', (code) => process.exit(code ?? 1));
