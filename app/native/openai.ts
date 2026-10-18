import type {
  LlmContentBlock,
  LlmMessage,
  LlmStreamHandle,
  LlmStreamOptions,
} from "../assistant/llm-protocol";

import { openSseRequest, type SseListener } from "./sse";

/**
 * Minimal streaming client for the Responses API (OpenAI, and the xAI and
 * Perplexity Agent endpoints that speak it). NativeScript cannot use the Node
 * SDK, so this shares the native streaming transport used by Anthropic.
 */

export type ResponsesProvider = "openai" | "xai" | "perplexity";

const ENDPOINTS: Record<ResponsesProvider, { url: string; label: string }> = {
  openai: { url: "https://api.openai.com/v1/responses", label: "OpenAI" },
  xai: { url: "https://api.x.ai/v1/responses", label: "xAI" },
  perplexity: { url: "https://api.perplexity.ai/v1/agent", label: "Perplexity" },
};

type StreamingOutput =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; inputJson: string; itemId: string; item: any }
  | { type: "provider_item"; item: any };

export function streamOpenAiResponse(options: LlmStreamOptions, provider: ResponsesProvider = "openai"): LlmStreamHandle {
  const apiKey = options.apiKey.trim();
  const { url, label } = ENDPOINTS[provider];
  let request: any = null;
  let settled = false;
  let text = "";
  let stopReason: string | null = null;
  let refusal = false;
  const outputs = new Map<number, StreamingOutput>();

  const fail = (message: string) => {
    if (settled) return;
    settled = true;
    request?.cancel();
    options.onError(message);
  };
  const done = () => {
    if (settled) return;
    settled = true;
    request?.cancel();
    const content = finalizeOutputs(outputs);
    const hasToolUse = content.some((block) => block.type === "tool_use");
    options.onDone({
      text,
      content,
      stopReason: refusal ? "refusal" : hasToolUse ? "tool_use" : stopReason ?? "end_turn",
    });
  };

  if (!apiKey) {
    setTimeout(() => fail(`No ${label} API key set`), 0);
    return { cancel: () => { settled = true; } };
  }

  const body = buildResponsesBody(options, provider);

  const listener: SseListener = {
    onLine: (line: string) => {
      if (settled) return;
      const event = parseSseDataLine(String(line));
      if (!event) return;
      const outputIndex = Number(event.output_index);
      switch (event.type) {
        case "response.output_item.added": {
          const item = event.item;
          if (item?.type === "function_call") {
            outputs.set(outputIndex, {
              type: "tool_use",
              id: String(item.call_id ?? item.id ?? ""),
              name: String(item.name ?? ""),
              inputJson: String(item.arguments ?? ""),
              itemId: String(item.id ?? ""),
              item,
            });
          } else if (item?.type === "message") {
            outputs.set(outputIndex, { type: "text", text: "" });
          } else if (item?.type === "reasoning") {
            outputs.set(outputIndex, { type: "provider_item", item });
          }
          return;
        }
        case "response.output_text.delta": {
          const delta = String(event.delta ?? "");
          text += delta;
          const output = outputs.get(outputIndex);
          if (output?.type === "text") {
            output.text += delta;
          } else {
            outputs.set(outputIndex, { type: "text", text: delta });
          }
          options.onTextDelta?.(delta, text);
          return;
        }
        case "response.function_call_arguments.delta": {
          const output = findToolOutput(outputs, outputIndex, String(event.item_id ?? ""));
          if (output) output.inputJson += String(event.delta ?? "");
          return;
        }
        case "response.output_item.done": {
          const item = event.item;
          if (item?.type === "function_call") {
            outputs.set(outputIndex, {
              type: "tool_use",
              id: String(item.call_id ?? item.id ?? ""),
              name: String(item.name ?? ""),
              inputJson: String(item.arguments ?? ""),
              itemId: String(item.id ?? ""),
              item,
            });
          } else if (item?.type === "message") {
            const output = outputs.get(outputIndex);
            const completedText = extractMessageText(item);
            outputs.set(outputIndex, {
              type: "text",
              text: completedText || (output?.type === "text" ? output.text : ""),
            });
            if (completedText && !text) text = completedText;
          } else if (item?.type === "reasoning") {
            outputs.set(outputIndex, { type: "provider_item", item });
          }
          return;
        }
        case "response.refusal.delta":
        case "response.refusal.done":
          refusal = true;
          return;
        case "response.completed":
          done();
          return;
        case "response.incomplete":
          stopReason = String(event.response?.incomplete_details?.reason ?? "incomplete");
          done();
          return;
        case "response.failed":
          fail(`${label}: ${String(event.response?.error?.message ?? event.error?.message ?? "response failed")}`);
          return;
        case "error":
          fail(`${label}: ${String(event.message ?? event.error?.message ?? "stream error")}`);
          return;
        default:
          return;
      }
    },
    onHttpError: (code: number, errorBody: string) => {
      fail(describeHttpError(label, Number(code), String(errorBody)));
    },
    onComplete: () => {
      // A transport EOF alone must not execute an unfinished tool call.
      fail(`${label} stream ended before the response completed`);
    },
    onFailure: (message: string) => {
      fail(`${label} connection failed: ${String(message)}`);
    },
  };

  try {
    request = openSseRequest(url, JSON.stringify(body), { Authorization: `Bearer ${apiKey}` }, listener);
  } catch (error) {
    setTimeout(() => fail(`${label} request failed: ${String((error as Error)?.message ?? error)}`), 0);
    return { cancel: () => { settled = true; } };
  }

  return {
    cancel: () => {
      settled = true;
      try {
        request?.cancel();
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Perplexity runs its "fast" preset (server-side web_search, which merges with
 * our function tools); our instructions replace the preset prompt, so restate
 * what it would have said. It has no `include` and the preset's effort is none.
 */
function buildResponsesBody(options: LlmStreamOptions, provider: ResponsesProvider): any {
  const perplexity = provider === "perplexity";
  const body: any = {
    ...(perplexity ? { preset: "fast" } : { model: options.model, include: ["reasoning.encrypted_content"] }),
    input: buildOpenAiInput(options.messages),
    stream: true,
    store: false,
    max_output_tokens: options.maxTokens ?? 8192,
  };
  const system = perplexity
    ? `${options.system ? `${options.system}\n\n` : ""}Today is ${new Date().toDateString()}. Use web_search for current facts. Never add [n] citation markers.`
    : options.system;
  if (system) body.instructions = system;
  if (options.tools?.length) {
    body.tools = options.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    }));
  }
  if (options.effort && !perplexity) body.reasoning = { effort: options.effort };
  return body;
}

/** Convert neutral conversation history to Responses API input items. */
function buildOpenAiInput(messages: LlmMessage[]): any[] {
  const input: any[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      input.push({ type: "message", role: message.role, content: message.content });
      continue;
    }

    let pendingText = "";
    const flushText = () => {
      if (!pendingText) return;
      input.push({ type: "message", role: message.role, content: pendingText });
      pendingText = "";
    };
    for (const block of message.content) {
      if (block.type === "text") {
        pendingText += block.text;
      } else if (block.type === "tool_use") {
        flushText();
        if (block.provider_item?.provider === "openai") {
          input.push(block.provider_item.item);
        } else {
          input.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          });
        }
      } else if (block.type === "tool_result") {
        flushText();
        input.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: block.is_error ? `Error: ${block.content}` : block.content,
        });
      } else if (block.provider === "openai") {
        flushText();
        input.push(block.item);
      }
    }
    flushText();
  }
  return input;
}

function finalizeOutputs(outputs: Map<number, StreamingOutput>): LlmContentBlock[] {
  const content: LlmContentBlock[] = [];
  for (const index of Array.from(outputs.keys()).sort((a, b) => a - b)) {
    const output = outputs.get(index)!;
    if (output.type === "text") {
      if (output.text) content.push({ type: "text", text: output.text });
      continue;
    }
    if (output.type === "provider_item") {
      content.push({ type: "provider_item", provider: "openai", item: output.item });
      continue;
    }
    let input: any = {};
    if (output.inputJson.trim()) {
      try {
        input = JSON.parse(output.inputJson);
      } catch {
        // Let the tool handler report any required arguments that are missing.
      }
    }
    content.push({
      type: "tool_use",
      id: output.id,
      name: output.name,
      input,
      provider_item: { provider: "openai", item: output.item },
    });
  }
  return content;
}

function findToolOutput(
  outputs: Map<number, StreamingOutput>,
  outputIndex: number,
  itemId: string,
): Extract<StreamingOutput, { type: "tool_use" }> | null {
  const indexed = outputs.get(outputIndex);
  if (indexed?.type === "tool_use") return indexed;
  for (const output of outputs.values()) {
    if (output.type === "tool_use" && output.itemId === itemId) return output;
  }
  return null;
}

function extractMessageText(item: any): string {
  if (!Array.isArray(item?.content)) return "";
  return item.content
    .filter((part: any) => part?.type === "output_text")
    .map((part: any) => String(part.text ?? ""))
    .join("");
}

function parseSseDataLine(line: string): any {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function describeHttpError(label: string, code: number, body: string): string {
  let detail = "";
  try {
    const error = JSON.parse(body)?.error;
    detail = String((typeof error === "string" ? error : error?.message) ?? "");
  } catch {
    // non-JSON error body
  }
  switch (code) {
    case 401:
      return `${label}: invalid API key`;
    case 403:
      return `${label}: API key lacks permission`;
    case 429:
      return `${label}: rate limited, try again shortly`;
    case 500:
    case 502:
    case 503:
    case 504:
      return `${label}: service unavailable, try again shortly`;
    default:
      return `${label}: HTTP ${code}${detail ? ` (${detail})` : ""}`;
  }
}
