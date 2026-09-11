'use strict';

// Run the real POSIX deployment script in an isolated temporary checkout.
// Docker, Git and curl are stubs: no production containers, repository or
// network are touched. Unlike string checks, this exercises shell exit rules.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function findShell() {
  const candidates = ['sh'];
  if (process.platform === 'win32') {
    const result = spawnSync('where.exe', ['git'], { encoding: 'utf8' });
    for (const git of (result.stdout || '').trim().split(/\r?\n/).filter(Boolean)) {
      candidates.push(path.resolve(path.dirname(git), '../usr/bin/sh.exe'));
    }
  }
  return candidates.find(shell => spawnSync(shell, ['-c', 'exit 0'], { stdio: 'pipe' }).status === 0);
}

const shell = findShell();
if (!shell) {
  if (process.platform !== 'win32') throw new Error('POSIX sh is required for server update tests.');
  console.log('[SKIP] server update shell tests: install Git for Windows to run locally; Linux CI requires them.');
} else {
  runTests();
}

function runTests() {
  const source = fs.readFileSync(path.join(__dirname, '../infra/docker/voxhf-server.sh'), 'utf8');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'voxhf-server-update-'));
  const originalRollback = 'previous-commit\ncurrent-commit\nexisting.db\n';
  let count = 0;
  try {
    for (const mode of ['success', 'legacy-success', 'backup-empty', 'backup-output', 'verify', 'helper-mkdir', 'helper-copy', 'host-directory']) {
      exercise(mode, 'update');
    }
    exercise('backup-output', 'backup');
    exercise('verify', 'backup');
    exercise('backup-output', 'rollback');
    exercise('verify', 'rollback');
  } finally {
    // This is only the directory created by mkdtemp above, never a checkout.
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  console.log(`[OK] ${count} isolated server backup/update failure scenarios`);

  function exercise(mode, command) {
    const directory = path.join(temporary, `${command}-${mode}`);
    const infra = path.join(directory, 'infra/docker');
    const bin = path.join(directory, 'bin');
    fs.mkdirSync(infra, { recursive: true });
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(directory, '.git'));
    const script = path.join(infra, 'voxhf-server.sh');
    fs.writeFileSync(script, source.replace(/\r\n/g, '\n'));
    fs.writeFileSync(path.join(infra, '.env'), 'RELAY_DOMAIN=relay.example.test\n');
    if (mode === 'host-directory') fs.writeFileSync(path.join(infra, 'backups'), 'not a directory');
    const rollback = path.join(directory, '.voxhf-previous-release');
    fs.writeFileSync(rollback, originalRollback);
    const trace = path.join(directory, 'trace');
    const pulled = path.join(directory, 'pulled');
    stub('git', `
shift 2
op=$1
printf 'git:%s\\n' "$op" >> "$TEST_TRACE"
case "$op" in
  status) exit 0 ;;
  rev-parse) if [ -f "$TEST_PULLED" ]; then echo new-commit; else echo old-commit; fi ;;
  pull) : > "$TEST_PULLED" ;;
  *) exit 90 ;;
esac
`);
    stub('curl', 'exit 0\n');
    stub('docker', `
[ "$1" = compose ] || exit 90
shift
while [ "$#" -gt 0 ]; do
  case "$1" in -f|--env-file) shift 2 ;; *) break ;; esac
done
op=$1
shift
if [ "$op" = exec ]; then
  shift 2
  case "$1" in
    test)
      case "$TEST_MODE" in legacy-success|helper-*) exit 1 ;; esac
      exit 0 ;;
    mkdir)
      echo helper:mkdir >> "$TEST_TRACE"
      [ "$TEST_MODE" != helper-mkdir ]; exit $? ;;
    node)
      shift 2
      echo "backup:$1" >> "$TEST_TRACE"
      case "$1" in
        backup)
          [ "$TEST_MODE" != backup-empty ] || exit 7
          echo '[backup] diagnostic output, not a filename'
          [ "$TEST_MODE" != backup-output ] || exit 7
          while [ "$#" -gt 0 ]; do
            if [ "$1" = --output ]; then shift; echo "target:$1" >> "$TEST_TRACE"; break; fi
            shift
          done ;;
        verify)
          echo "verify-target:$2" >> "$TEST_TRACE"
          [ "$TEST_MODE" != verify ] || exit 8
          echo '[backup] Valid SQLite backup' ;;
        *) exit 90 ;;
      esac ;;
    *) exit 90 ;;
  esac
else
  echo "docker:$op" >> "$TEST_TRACE"
  case "$op" in
    cp) echo 'helper copy diagnostic'; [ "$TEST_MODE" != helper-copy ] || exit 9 ;;
    ps) echo voxhf-relay ;;
    up) exit 0 ;;
    *) exit 90 ;;
  esac
fi
`);
    // Preserve the shell's bundled utilities on Windows while placing stubs
    // first. MSYS converts this native PATH when launching Git's sh.exe.
    const result = spawnSync(shell, [script, command], {
      cwd: directory, encoding: 'utf8', timeout: 10000,
      env: {
        ...process.env,
        PATH: [bin, path.dirname(shell), process.env.PATH || ''].join(path.delimiter),
        TEST_MODE: mode, TEST_TRACE: trace.replace(/\\/g, '/'), TEST_PULLED: pulled.replace(/\\/g, '/'),
      },
    });
    if (result.error) throw result.error;
    const calls = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '';
    const success = mode.endsWith('success');
    const context = `${command}/${mode}: ${result.stdout}\n${result.stderr}`;
    if (success) {
      assert.strictEqual(result.status, 0, context);
      assert.ok(['backup:backup', 'backup:verify', 'git:pull'].every(step => calls.includes(step)), context);
      assert.ok(calls.indexOf('backup:backup') < calls.indexOf('backup:verify'), context);
      assert.ok(calls.indexOf('backup:verify') < calls.indexOf('git:pull'), context);
      assert.ok(calls.includes('docker:up'), context);
      const lines = fs.readFileSync(rollback, 'utf8').trim().split('\n');
      assert.deepStrictEqual(lines.slice(0, 2), ['old-commit', 'new-commit']);
      assert.match(lines[2], /^voxhf-before-update-\d{8}T\d{6}Z\.db$/);
      assert.ok(calls.includes(`target:/var/backups/voxhf/${lines[2]}\n`));
      assert.ok(calls.includes(`verify-target:/var/backups/voxhf/${lines[2]}\n`));
      assert.ok(!result.stdout.includes('diagnostic'), 'backup diagnostics must not contaminate stdout');
    } else {
      assert.notStrictEqual(result.status, 0, context);
      assert.match(result.stderr, /Database backup failed/, context);
      assert.ok(!/git:(pull|reset)|docker:(up|stop|run)/.test(calls), context);
      assert.strictEqual(fs.readFileSync(rollback, 'utf8'), originalRollback, 'failed backup must preserve rollback metadata');
      assert.ok(!result.stdout.includes('[OK]'), context);
      if (mode.startsWith('helper-') || mode === 'host-directory') assert.ok(!calls.includes('backup:backup'), context);
      if (mode.startsWith('backup-')) assert.ok(!calls.includes('backup:verify'), context);
    }
    count += 1;
    console.log(`[OK] server ${command}: ${mode}`);

    function stub(name, body) {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nset -eu\n${body}`, { mode: 0o755 });
    }
  }
}
