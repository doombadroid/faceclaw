// IosBleCentral must never call its listeners on the CoreBluetooth delegate queue. A listener
// can call back into the central (a charging-ended teardown disconnects), and disconnect's
// dispatch_sync onto the queue already running it traps in libdispatch (build 42 crash). Every
// listener call has to sit inside a deliver { } block, which hops to the callback queue.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.join(__dirname, '../native/kotlin/shared/src/iosMain/kotlin/com/faceclaw/app/ble/IosBleCentral.kt');

// Lines that call session/stock/ANCS listeners, each with whether it sits inside deliver(...) { }.
function listenerCalls(source) {
  const calls = [];
  const stack = []; // one entry per open brace: true when it opened a deliver block
  let pendingDeliver = false;
  source.split('\n').forEach((line, index) => {
    const code = line.replace(/\/\/.*$/, '');
    if (/\bdeliver\(/.test(code) && !/fun deliver\(/.test(code)) pendingDeliver = true;
    if (/\b(sessionListener|stockListener|ancsListener)\?\.on[A-Z]/.test(code)) {
      calls.push({ line: index + 1, inside: stack.includes(true) || pendingDeliver && code.indexOf('{') !== -1 });
    }
    for (const ch of code) {
      if (ch === '{') { stack.push(pendingDeliver); pendingDeliver = false }
      else if (ch === '}') stack.pop();
    }
  });
  return calls;
}

test('every IosBleCentral listener call goes through the callback queue', () => {
  const calls = listenerCalls(fs.readFileSync(SOURCE, 'utf8'));
  assert.ok(calls.length >= 5, `expected the notification, connection and ANCS calls, found ${calls.length}`);
  assert.deepEqual(calls.filter(call => !call.inside).map(call => call.line), []);
});

test('the checker flags a listener call made on the delegate queue', () => {
  const calls = listenerCalls([
    'private fun onValue() {',
    '    sessionListener?.onNotification(a, b, c)',
    '    deliver("x") {',
    '        stockListener?.onNotification(a, b, c)',
    '    }',
    '}',
  ].join('\n'));
  assert.deepEqual(calls.map(call => call.inside), [false, true]);
});
