'use strict';

// WebSocket uses a numeric OPEN state internally. Keeping the value here avoids
// depending on a specific `ws` instance while still making call sites readable.
const WS_OPEN = 1;

function isWsOpen(ws) {
  // Browser tabs and relay sockets can close between scheduling and send time.
  // This small guard keeps normal reconnects from becoming noisy send errors.
  return Boolean(ws && ws.readyState === WS_OPEN);
}

function isSocketOpen(socket) {
  // Node TCP sockets expose `destroyed`; using one helper keeps proxy pairs
  // consistent across PilotUI, FSD, TS2, and remote relay forwarding.
  return Boolean(socket && !socket.destroyed);
}

function writeIfOpen(socket, data) {
  // Network callbacks often race with disconnects. Return false instead of
  // throwing so command paths can report a friendly "not connected" state.
  if (!isSocketOpen(socket)) return false;
  socket.write(data);
  return true;
}

function destroyIfOpen(socket) {
  // Proxy sockets are paired. When one side closes, the other side must be
  // destroyed too or PilotCore/Altitude may keep waiting on a dead connection.
  if (isSocketOpen(socket)) socket.destroy();
}

function safeEnd(stream) {
  // ffmpeg stdin may already be closing when RX stops or Web TX releases PTT.
  try { stream?.end?.(); } catch (_) {}
}

function safeKill(processHandle) {
  // Killing an already-exited child is harmless for our flow and should never
  // interrupt proxy cleanup.
  try { processHandle?.kill?.(); } catch (_) {}
}

module.exports = {
  WS_OPEN,
  isWsOpen,
  isSocketOpen,
  writeIfOpen,
  destroyIfOpen,
  safeEnd,
  safeKill,
};
