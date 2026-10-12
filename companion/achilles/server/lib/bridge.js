import net from 'node:net';

const PIPE_PATH = '\\\\.\\pipe\\AchillesModManagerBridge';
const TIMEOUT_MS = 1500;

/**
 * Asks the in-game BepInEx bridge plugin (see BepInExBridge/Plugin.cs) for its current status -
 * which plugin GUIDs are actually loaded right now, and which save slot was most recently written
 * to. Returns { connected: false } quickly (not an error) if the game isn't running or the bridge
 * plugin isn't installed - this is a "is it there right now" check, not a persistent connection.
 */
export function getBridgeStatus() {
  return new Promise((resolve) => {
    const socket = net.createConnection(PIPE_PATH);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => finish({ connected: false }), TIMEOUT_MS);

    socket.on('connect', () => socket.write('status\n'));
    socket.on('error', () => {
      clearTimeout(timer);
      finish({ connected: false });
    });

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (!buffer.includes('\n')) return;
      clearTimeout(timer);
      try {
        const status = JSON.parse(buffer.split('\n')[0]);
        finish({ connected: true, ...status });
      } catch {
        finish({ connected: false });
      }
    });
  });
}
