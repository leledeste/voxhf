'use strict';

function createWebCommandHandler(deps) {
  return function handleWebCommand(ws, cmd) {
    // Browser actions are intentionally tiny commands. This dispatcher decides
    // which local subsystem should receive them, while proxy.js owns the actual
    // PilotCore/FSD/TS2 functions.
    if (cmd.action === 'ping') {
      return ws.send(JSON.stringify({
        kind: 'pong',
        at: Date.now(),
        ...deps.getPongState(),
      }));
    }

    if (cmd.action === 'test_audio') return deps.sendTestTone();
    if (cmd.action === 'voice_tx_start') {
      return deps.startWebTx(ws, Number(cmd.com) === 2 ? 2 : 1, { monitor: cmd.monitor === true });
    }
    if (cmd.action === 'voice_tx_monitor_start') return deps.startWebTx(ws, 1, { monitorOnly: true });
    if (cmd.action === 'voice_tx_stop') return deps.stopWebTx(ws);
    if (cmd.action === 'remote_pairing_renew') {
      return deps.remoteAgent.renewPairingCode((text) => deps.sendSystem(ws, text));
    }

    if (cmd.action === 'sim_com1') {
      return sendCommandResult(deps, ws, deps.setCom(1, cmd.freq, cmd.station), `COM1 -> ${cmd.freq} MHz`);
    }
    if (cmd.action === 'sim_com2') {
      return sendCommandResult(deps, ws, deps.setCom(2, cmd.freq, cmd.station), `COM2 -> ${cmd.freq} MHz`);
    }
    if (cmd.action === 'sim_squawk') {
      return sendCommandResult(deps, ws, deps.setSquawk(cmd.code), `Squawk -> ${cmd.code}`);
    }
    if (cmd.action === 'sim_xpdr') return sendCommandResult(deps, ws, deps.toggleXpdr(cmd.mode), 'Transponder toggle');
    if (cmd.action === 'sim_ident') return sendCommandResult(deps, ws, deps.sendIdent(), 'IDENT sent');

    if (cmd.action === 'weather_request') {
      deps.sendWeatherRequest(cmd.kind, cmd.icao, (text) => deps.sendSystem(ws, text), {
        source: cmd.source,
        role: cmd.role,
      });
      return;
    }
    if (cmd.action === 'atis_request') {
      deps.sendAtisRequest(cmd.callsign, (text) => deps.sendSystem(ws, text));
      return;
    }

    if (cmd.action === 'send_message') {
      // The browser sends intent; the local proxy translates it to FSD #TM
      // syntax and mirrors it back to PilotCore so Altitude stays consistent.
      return deps.sendChatCommand(cmd, (text) => deps.sendSystem(ws, text));
    }
  };
}

function sendCommandResult(deps, ws, ok, text) {
  // Simulator commands report locally because PilotCore binary commands do not
  // have a convenient textual acknowledgment.
  deps.sendSystem(ws, ok ? text : 'PilotCore is not connected');
}

module.exports = {
  createWebCommandHandler,
};
