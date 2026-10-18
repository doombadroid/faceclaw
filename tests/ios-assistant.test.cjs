const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));

function assistant(provider) {
  const requests = [], calls = [], deltas = [], errors = [], done = [];
  const registry = { listTools: () => [{ name: 'timer.set', description: 'Set a timer', inputSchema: { type: 'object' } }],
    callTool: async (name, args) => { calls.push({ name, args }); return { ok: true, content: 'Timer set' }; } };
  const load = loader({ global: { isIOS: true, isAndroid: false }, setTimeout, clearTimeout }, {
    './sse': { openSseRequest: (url, body, headers, listener) => {
      const request = { url, body: JSON.parse(body), headers, listener, cancelled: false };
      requests.push(request); return { cancel: () => { request.cancelled = true; } };
    } },
    '../native/llama': { streamLocalQwen: () => assert.fail('iOS must not invoke a local LLM') },
    './bridge-client': { assistantBridge: {} }, './tool-registry': { toolRegistry: registry },
    '../prompts': { ASSISTANT_SYSTEM_PROMPT_BASE: 'test', buildAssistantSystemPrompt: () => 'test', describeAssistantContext: () => '' },
  });
  const { AssistantSession } = load('app/assistant/session.ts');
  const session = new AssistantSession({ kind: 'direct', llm: { selection: 'auto', provider, model: 'fixture-model', apiKey: 'fixture-key', effort: 'low' } }, registry);
  const send = text => session.sendUtterance(text, {}, { onTextDelta: (_delta, full) => deltas.push(full),
    onToolActivity() {}, onError: error => errors.push(error), onTurnDone: result => done.push(result) });
  const event = (request, event) => request.listener.onLine('data: ' + JSON.stringify(event));
  function text(request, value) {
    if (provider === 'anthropic') {
      event(request, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      event(request, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } });
    } else event(request, { type: 'response.output_text.delta', output_index: 0, delta: value });
  }
  function finish(request, tool = false) {
    if (provider === 'anthropic') {
      event(request, { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' } });
      event(request, { type: 'message_stop' });
    } else event(request, { type: 'response.completed' });
  }
  function tool(request) {
    if (provider === 'anthropic') {
      event(request, { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool-1', name: 'timer_set' } });
      event(request, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"seconds":' } });
      event(request, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '60}' } });
    } else if (provider !== 'openai') {
      // xAI and Perplexity send each function call whole, never as argument deltas; Perplexity has no reasoning items.
      if (provider === 'xai') event(request, { type: 'response.output_item.done', output_index: 1, item: { type: 'reasoning', id: 'reason', encrypted_content: 'opaque-reasoning' } });
      else event(request, { type: 'response.output_item.done', output_index: 1, item: { type: 'search_results', results: [{ id: 1, url: 'https://fixture' }] } });
      const call = { type: 'function_call', call_id: 'tool-1', id: 'item-1', name: 'timer_set', arguments: '{"seconds":60}', thought_signature: 'opaque-fixture' };
      event(request, { type: 'response.output_item.added', output_index: 2, item: call });
      event(request, { type: 'response.output_item.done', output_index: 2, item: call });
    } else {
      event(request, { type: 'response.output_item.done', output_index: 1, item: { type: 'reasoning', id: 'reason', encrypted_content: 'opaque-reasoning' } });
      event(request, { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', call_id: 'tool-1', id: 'item-1', name: 'timer_set', arguments: '' } });
      event(request, { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"seconds":' });
      event(request, { type: 'response.function_call_arguments.delta', output_index: 2, delta: '60}' });
    }
  }
  return { load, session, send, event, text, finish, tool, requests, calls, deltas, errors, done };
}

for (const provider of ['openai', 'anthropic', 'xai', 'perplexity']) {
  test(`iOS ${provider} streams, calls shared tools, continues with results, and preserves follow-up history`, async () => {
    const h = assistant(provider); h.send('Set a one-minute timer');
    const first = h.requests[0]; assert.equal(first.body.stream, true);
    assert.equal(first.url, { openai: 'https://api.openai.com/v1/responses', anthropic: 'https://api.anthropic.com/v1/messages',
      xai: 'https://api.x.ai/v1/responses', perplexity: 'https://api.perplexity.ai/v1/agent' }[provider]);
    assert.deepEqual([first.body.model, first.body.preset], provider === 'perplexity' ? [undefined, 'low'] : ['fixture-model', undefined]);
    if (provider !== 'anthropic') { assert.equal(first.headers.Authorization, 'Bearer fixture-key'); assert.equal(first.body.store, false); }
    else assert.equal(first.headers['x-api-key'], 'fixture-key');
    h.text(first, 'Setting π 👓'); h.tool(first); h.finish(first, true); await flush();
    assert.equal(first.cancelled, true); assert.equal(h.calls[0].name, 'timer.set'); assert.equal(h.calls[0].args.seconds, 60);
    assert.equal(h.requests.length, 2);
    const second = h.requests[1];
    assert.match(JSON.stringify(second.body), /Timer set/);
    if (provider === 'openai' || provider === 'xai') assert.match(JSON.stringify(second.body), /opaque-reasoning/);
    if (provider === 'xai' || provider === 'perplexity') assert.match(JSON.stringify(second.body), /opaque-fixture/);
    if (provider === 'perplexity') assert.doesNotMatch(JSON.stringify(second.body), /search_results/);
    h.text(second, 'Your timer is running.'); h.finish(second);
    assert.equal(h.session.isTurnActive(), false); assert.equal(h.done.length, 1); assert.equal(h.errors.length, 0);
    h.send('What did you set?');
    assert.match(JSON.stringify(h.requests[2].body), /Your timer is running/);
    h.session.cancel(); assert.equal(h.requests[2].cancelled, true);
  });
  test(`iOS ${provider} cancellation, HTTP errors and premature EOF never execute incomplete tools`, async () => {
    const h = assistant(provider); h.send('test'); const first = h.requests[0]; h.session.cancel();
    h.text(first, 'late'); h.tool(first); h.finish(first, true); await flush();
    assert.equal(h.calls.length, 0); assert.equal(h.deltas.length, 0);
    h.send('retry'); h.requests[1].listener.onHttpError(401, '{"error":{"message":"Invalid API key"}}');
    assert.equal(h.session.isTurnActive(), false); assert.match(h.errors[0], /key/i);
    h.send('retry'); const third = h.requests[2]; h.text(third, 'Partial'); h.tool(third); third.listener.onComplete(); await flush();
    assert.match(h.errors.at(-1), /before.*completed/); assert.equal(h.calls.length, 0); assert.equal(third.cancelled, true);
  });
}

test('iOS SSE adapter forwards the Kotlin stream events once and stops after cancellation/EOF', () => {
  const instances = [], seen = [];
  const nsObject = { extend: methods => ({ new: () => ({ ...methods }) }) };
  const listenerModule = loader({ NSObject: nsObject }, { './error-reports': { reportError() {} } })('app/native/kotlin-listener.ios.ts');
  const api = loader({
    FaceclawKitIosSseRequest: { alloc: () => ({ initWithUrlBodyHeadersJsonListener(url, body, headers, listener) {
      const instance = { listener, cancelled: false, cancel() { this.cancelled = true; } };
      instances.push(instance); assert.equal(JSON.parse(headers)['User-Agent'], 'fixture'); assert.equal(url, 'https://fixture'); return instance;
    } }) }, FaceclawKitFaceclawSseListener: {},
  }, { '../util/http': { withUserAgent: headers => ({ ...headers, 'User-Agent': 'fixture' }) }, './kotlin-listener.ios': listenerModule })('app/native/sse.ios.ts');
  const listener = { onLine: line => seen.push(line), onComplete: () => seen.push('complete'), onHttpError: (code, body) => seen.push(`http:${code}:${body}`), onFailure: error => seen.push(`fail:${error}`) };
  const handle = api.openSseRequest('https://fixture', '{}', {}, listener);
  instances[0].listener.onLineLine('first'); assert.deepEqual(seen, ['first']);
  handle.cancel(); handle.cancel(); assert.equal(instances[0].cancelled, true);
  instances[0].listener.onLineLine('after cancel'); instances[0].listener.onComplete(); assert.deepEqual(seen, ['first']);
  api.openSseRequest('https://fixture', '{}', {}, listener);
  instances[1].listener.onLineLine('last'); instances[1].listener.onComplete(); instances[1].listener.onFailureMessage_('late');
  assert.deepEqual(seen, ['first', 'last', 'complete']);
  api.openSseRequest('https://fixture', '{}', {}, listener);
  instances[2].listener.onHttpErrorCodeBody(429, 'slow down'); instances[2].listener.onComplete();
  assert.deepEqual(seen.at(-1), 'http:429:slow down');
});

test('iOS only offers cloud assistant models and preserves old local-model conversations as Auto', () => {
  const api = loader({ global: { isIOS: true } }, { '../native/llama': { LOCAL_MODEL: { label: 'Qwen', id: 'qwen' }, isLocalModelReady: () => false } })('app/assistant/models.ts');
  assert.equal(api.ASSISTANT_MODEL_CHOICES.includes('qwen'), false);
  assert.equal(api.supportedAssistantModel('qwen'), 'auto');
  const keys = set => ({ openai: '', anthropic: '', xai: '', perplexity: '', ...set });
  const auto = set => api.resolveAssistantModel('auto', keys(set));
  assert.equal(auto({ openai: 'key', anthropic: 'key', xai: 'key', perplexity: 'key' }).provider, 'openai');
  assert.equal(auto({ anthropic: 'key', xai: 'key', perplexity: 'key' }).provider, 'anthropic');
  assert.deepEqual([auto({ xai: ' key ', perplexity: 'key' })].map(r => [r.provider, r.model, r.apiKey]), [['xai', 'grok-4.3', 'key']]);
  assert.equal(auto({ perplexity: 'key' }).provider, 'perplexity');
  assert.equal(auto({}), null);
  assert.equal(api.resolveAssistantModel('grok-best', keys({ xai: 'key' })).model, 'grok-4.7');
  assert.equal(api.resolveAssistantModel('perplexity', keys({ xai: 'key' })), null);
  assert.equal(api.resolveAssistantModel('perplexity', keys({ perplexity: 'key' })).effort, undefined);
  const { AssistantConversations } = loader({}, { './models': api, './session': {} })('app/assistant/conversations.ts');
  const history = { messages: [], transcript: [{ role: 'user', text: 'Keep this conversation' }] };
  const saved = JSON.stringify({ selectedId: 'old', conversations: [{ id: 'old', model: 'qwen', reasoning: 'default', history }] });
  const conversations = new AssistantConversations(() => null, () => 'auto', () => {}, saved);
  assert.equal(conversations.current().model, 'auto'); assert.equal(conversations.title(), 'Keep this conversation');
});

test('cancelling during a tool prevents subsequent tool side effects and a stalled turn times out', async () => {
  let stream, completeTool, deadline;
  const calls = [], failures = [];
  const { DirectAssistantBackend } = loader({ setTimeout: fn => { deadline = fn; return 1; }, clearTimeout() {} }, {
    '../native/openai': { streamOpenAiResponse: options => { stream = options; return { cancel() {} }; } },
    '../native/anthropic': {}, '../native/llama': {},
  })('app/assistant/direct-backend.ts');
  const backend = new DirectAssistantBackend();
  const options = { provider: 'openai', messages: [], buildTools: () => [], resolveToolName: name => name,
    registry: { callTool: name => { calls.push(name); return new Promise(resolve => { completeTool = resolve; }); } },
    callbacks: { onTextDelta() {}, onToolActivity() {}, onTurnDone() {}, onError: message => failures.push(message) } };
  const handle = backend.runTurn(options);
  stream.onDone({ text: '', stopReason: 'tool_use', content: [1, 2].map(id => ({ type: 'tool_use', id: String(id), name: 'tool' + id, input: {} })) });
  handle.cancel(); completeTool({ ok: true, content: 'done' }); await flush();
  assert.deepEqual(calls, ['tool1']);
  backend.runTurn({ ...options, messages: [] }); deadline(); assert.match(failures[0], /too long/);
});

test('Responses providers get their endpoint, request fields and error wording', () => {
  const requests = [], errors = [];
  const { streamOpenAiResponse } = loader({ setTimeout: fn => fn() }, { './sse': { openSseRequest: (url, body, headers, listener) => {
    requests.push({ url, body: JSON.parse(body), listener }); return { cancel() {} };
  } } })('app/native/openai.ts');
  const stream = (provider, apiKey = 'k') => streamOpenAiResponse({ apiKey, model: 'm', system: 'sys', effort: 'low',
    messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
    onDone() {}, onError: message => errors.push(message) }, provider);
  stream('openai'); stream('xai'); stream('perplexity');
  assert.deepEqual(requests.map(r => r.url), ['https://api.openai.com/v1/responses', 'https://api.x.ai/v1/responses', 'https://api.perplexity.ai/v1/agent']);
  const [openai, xai, perplexity] = requests.map(r => r.body);
  assert.deepEqual(xai, openai);
  assert.deepEqual([xai.model, xai.include, xai.reasoning, xai.instructions], ['m', ['reasoning.encrypted_content'], { effort: 'low' }, 'sys']);
  assert.deepEqual(xai.input, [{ type: 'message', role: 'user', content: 'hi' }]);
  assert.equal(perplexity.preset, 'low');
  for (const field of ['model', 'include', 'reasoning']) assert.equal(field in perplexity, false, field);
  assert.match(perplexity.instructions, /^sys\n\nToday is .*web_search/);
  assert.deepEqual([perplexity.stream, perplexity.store, perplexity.tools[0].type, perplexity.input[0].type], [true, false, 'function', 'message']);
  requests[1].listener.onHttpError(400, '{"code":"invalid-argument","error":"Model not found"}');
  requests[2].listener.onLine('data: ' + JSON.stringify({ type: 'response.failed', sequence_number: 3, error: { message: 'Quota exceeded' } }));
  stream('xai', ' ');
  assert.deepEqual(errors, ['xAI: HTTP 400 (Model not found)', 'Perplexity: Quota exceeded', 'No xAI API key set']);
  assert.equal(requests.length, 3);
  // A tool-less call (the calculator rewrite) is not nudged to search; truncation arrives as a completed event.
  const results = [];
  streamOpenAiResponse({ apiKey: 'k', model: 'm', system: 'calc', messages: [{ role: 'user', content: 'two plus two' }],
    onDone: result => results.push(result), onError: message => errors.push(message) }, 'perplexity');
  assert.doesNotMatch(requests[3].body.instructions, /web_search/);
  requests[3].listener.onLine('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }));
  assert.equal(results[0].stopReason, 'max_output_tokens');
});

test('the calculator rewrite sends each provider its own key and endpoint', () => {
  const sent = [];
  const keys = { openai: 'ko', anthropic: 'ka', xai: 'kx', perplexity: 'kp' };
  for (const [model, provider] of [['luna', 'openai'], ['sonnet', 'anthropic'], ['grok', 'xai'], ['perplexity', 'perplexity']]) {
    const { rewriteSpokenProblem } = loader({ global: { isIOS: true } }, {
      '../../native/openai': { streamOpenAiResponse: (options, via) => sent.push([via, options.apiKey]) },
      '../../native/anthropic': { streamAnthropicMessage: options => sent.push(['anthropic', options.apiKey]) },
      '../../native/llama': { streamLocalQwen: () => assert.fail('no local model on iOS') },
      '../native/llama': { LOCAL_MODEL: { label: 'Qwen', id: 'qwen' }, isLocalModelReady: () => false },
      '../../ui/dashboard-settings': { assistantApiKeys: () => keys, assistantModelSetting: { get: () => model } },
      '../../prompts': { CALCULATOR_REWRITE_SYSTEM_PROMPT: 'calc', buildCalculatorRewriteUserMessage: text => text },
    })('app/apps/calculator/calculator-llm.ts');
    rewriteSpokenProblem('two plus two');
    assert.deepEqual(sent.at(-1), [provider, keys[provider]]);
  }
});
