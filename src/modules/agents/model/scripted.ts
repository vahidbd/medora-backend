import type Anthropic from '@anthropic-ai/sdk';
import type { ModelClient, ModelReply, ModelRequest } from './client.js';

/**
 * A model that answers from a script: tests give it one step at a time, and
 * development and preview get a stand-in that replies in plain words and
 * never calls a tool unless the message asks in the form `[tool name {json}]`.
 * It never sees real patient data and never leaves the process.
 */
/** A reply to give, or a function that makes one from the request. */
export type ScriptStep = ModelReply | ((request: ModelRequest) => ModelReply | Promise<ModelReply>);

let counter = 0;
const nextId = (prefix: string) => `${prefix}_scripted_${(counter += 1)}`;

function message(content: Anthropic.ContentBlock[], stopReason: Anthropic.StopReason, model: string): ModelReply {
  return {
    id: nextId('msg'),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as ModelReply;
}

/** Building blocks for scripted replies. */
export const scripted = {
  text(text: string, model = 'scripted'): ModelReply {
    return message([{ type: 'text', text, citations: null } as Anthropic.TextBlock], 'end_turn', model);
  },
  tool(name: string, input: Record<string, unknown>, text?: string, model = 'scripted'): ModelReply {
    const blocks: Anthropic.ContentBlock[] = [];
    if (text) blocks.push({ type: 'text', text, citations: null } as Anthropic.TextBlock);
    blocks.push({ type: 'tool_use', id: nextId('toolu'), name, input, caller: { type: 'direct' } } as unknown as Anthropic.ToolUseBlock);
    return message(blocks, 'tool_use', model);
  },
  refusal(model = 'scripted'): ModelReply {
    return message([], 'refusal', model);
  },
};

/** A client that plays the given steps in order and fails loudly when it runs out. */
export function scriptedClient(steps: ScriptStep[]): ModelClient & { requests: ModelRequest[] } {
  const queue = [...steps];
  const requests: ModelRequest[] = [];
  return {
    kind: 'scripted',
    requests,
    async create(request) {
      requests.push(structuredClone(request));
      const step = queue.shift();
      if (!step) throw new Error('The scripted model has no more steps');
      return typeof step === 'function' ? step(request) : step;
    },
  };
}

const TOOL_REQUEST = /\[tool ([a-z_]+) (\{.*\})\]/s;

function lastUserText(request: ModelRequest): string {
  const last = [...request.messages].reverse().find((m) => m.role === 'user');
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  return last.content.map((block) => (block.type === 'text' ? block.text : '')).join(' ');
}

/** The stand-in for development and preview. */
export function standInClient(): ModelClient {
  return {
    kind: 'scripted',
    async create(request) {
      const last = request.messages.at(-1);
      const answeringTools = last?.role === 'user' && Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result');
      if (answeringTools) return scripted.text('Done. (A stand-in reply: no model is connected in development.)');
      const asked = TOOL_REQUEST.exec(lastUserText(request));
      if (asked?.[1] && asked[2]) {
        try {
          return scripted.tool(asked[1], JSON.parse(asked[2]) as Record<string, unknown>);
        } catch {
          return scripted.text('That tool request is not valid JSON.');
        }
      }
      return scripted.text('This is a stand-in reply: no model is connected in development.');
    },
  };
}
