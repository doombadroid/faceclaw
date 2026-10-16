const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loader } = require('./helpers/load-typescript.cjs');

// The real bridge client over a fake socket and clock; settings are plain values.
function harness(values = {}) {
  const sockets = [], timers = [];
  const setting = key => ({ get: () => values[key] });
  const load = loader({ global: { isIOS: true }, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {} }, {
    '../native/socket': { openSocket: (url, listener) => {
      const socket = { url, listener, sent: [], closes: 0, sendText(text) { this.sent.push(JSON.parse(text)); return true; }, close() { this.closes++; } };
      sockets.push(socket); return socket;
    } },
    './mcp-server': { AssistantMcpServer: class { handleMessage() {} sendToolsChanged() {} } },
    './tool-registry': { toolRegistry: { onToolsChanged: () => () => {} } },
    '../branding': { APP_NAME: 'OcuSmart' },
    '../ui/dashboard-settings': { assistantBackendSetting: setting('backend'), assistantBridgeHostSetting: setting('host'),
      assistantBridgePortSetting: setting('port'), assistantBridgeTokenSetting: setting('token'), assistantAllowProactiveSetting: { get: () => true } },
  });
  return { api: load('app/assistant/bridge-client.ts'), sockets, timers, values };
}

test('the bridge client handshakes, answers pings, re-dials with backoff and closes once on stop', () => {
  const h = harness();
  const client = new h.api.AssistantBridgeClient();
  client.configure({ host: '192.168.1.5', port: 8790, token: 'secret', deviceName: 'ocusmart', allowProactive: () => true });
  const first = h.sockets[0];
  assert.equal(first.url, 'ws://192.168.1.5:8790');
  first.listener.onOpen();
  assert.deepEqual([first.sent[0].type, first.sent[0].token, first.sent[0].deviceName], ['hello', 'secret', 'ocusmart']);
  first.listener.onTextMessage(JSON.stringify({ chan: 'ctl', type: 'hello-ack', serverName: 'box' }));
  assert.equal(client.isConnected(), true);
  first.listener.onTextMessage(JSON.stringify({ chan: 'ctl', type: 'ping', ts: 7 }));
  assert.deepEqual([first.sent[1].type, first.sent[1].ts], ['pong', 7]);
  first.listener.onFailure('reset');
  assert.equal(client.state().phase, 'failed');
  assert.equal(h.timers.at(-1).ms, 1000);
  h.timers.at(-1).fn();
  h.sockets[1].listener.onFailure('refused');
  assert.equal(h.timers.at(-1).ms, 2000);
  h.timers.at(-1).fn();
  client.stop(); client.stop();
  assert.equal(h.sockets[2].closes, 1);
  h.sockets[2].listener.onFailure('late');
  assert.equal(client.state().phase, 'idle');
});

test('a wss:// or ws:// host prefix picks the scheme, so a TLS front end works under ATS', () => {
  const h = harness();
  const client = new h.api.AssistantBridgeClient();
  const options = host => ({ host, port: 443, token: 't', deviceName: 'd', allowProactive: () => true });
  client.configure(options('wss://box.tail1234.ts.net'));
  client.configure(options('WS://box.local'));
  assert.deepEqual(h.sockets.map(socket => socket.url), ['wss://box.tail1234.ts.net:443', 'WS://box.local:443']);
  client.configure(options('bad host'));
  assert.equal(h.sockets.length, 2);
  assert.equal(client.state().phase, 'failed');
});

test('settings sync dials only on a bridge config change and stops when the backend leaves the bridge', () => {
  const h = harness({ backend: 'external', host: ' box.local ', port: '9000', token: 'tok' });
  h.api.syncAssistantBridgeFromSettings();
  h.api.syncAssistantBridgeFromSettings();
  assert.equal(h.sockets.length, 1);
  assert.equal(h.sockets[0].url, 'ws://box.local:9000');
  h.sockets[0].listener.onOpen();
  assert.equal(h.sockets[0].sent[0].deviceName, 'ocusmart');
  h.values.backend = 'direct';
  h.api.syncAssistantBridgeFromSettings();
  assert.equal(h.sockets[0].closes, 1);
  assert.equal(h.api.assistantBridge.state().phase, 'idle');
});

test('both controllers sync the bridge at start and on any setting change', () => {
  for (const file of ['app/g2/ios-preview-controller.ts', 'app/g2/dashboard-controller.ts']) {
    const calls = fs.readFileSync(file, 'utf8').match(/syncAssistantBridgeFromSettings\(\)/g) ?? [];
    assert.equal(calls.length, 2, file);
  }
});
