'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// Attach a clearer message to ports that are expected to be owned by VoxHF.
// The most common failure is PilotCore taking 4827 before the proxy starts.
function failListen(label, host, port, hint = '') {
  return (err) => {
    if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
      console.error(`[${label}] Cannot listen on ${host}:${port}: ${err.message}`);
      if (hint) console.error(`[${label}] ${hint}`);
      diagnosePort(port).finally(() => process.exit(1));
      return;
    }
    throw err;
  };
}

// Windows users usually need the owning process, not just EADDRINUSE/EACCES.
// This helper keeps startup failures actionable without adding dependencies.
async function diagnosePort(port) {
  if (process.platform !== 'win32') {
    console.error(`[PORT] Inspect the owner with: netstat -ano | grep :${port}`);
    return;
  }

  try {
    const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true });
    const lines = stdout.split(/\r?\n/).filter((line) => line.includes(`:${port}`));
    if (!lines.length) {
      console.error(`[PORT] No TCP owner found for port ${port}.`);
      return;
    }

    console.error(`[PORT] TCP entries for port ${port}:`);
    for (const line of lines) console.error(`[PORT] ${line.trim()}`);

    const pids = [...new Set(lines
      .map((line) => line.trim().split(/\s+/).pop())
      .filter((value) => /^\d+$/.test(value)))];

    for (const pid of pids) {
      try {
        const { stdout: task } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true });
        const row = task.trim().split(/\r?\n/).find((line) => line && !line.startsWith('INFO:'));
        if (row) console.error(`[PORT] PID ${pid}: ${row}`);
      } catch (_) {}
    }
  } catch (err) {
    console.error(`[PORT] Could not inspect port ${port}: ${err.message}`);
    console.error(`[PORT] Run manually: netstat -ano -p tcp | findstr :${port}`);
  }
}

module.exports = {
  failListen,
  diagnosePort,
};
