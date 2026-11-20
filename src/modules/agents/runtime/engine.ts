import type Anthropic from '@anthropic-ai/sdk';
import type { AgentChannel, AgentMessageRole } from '../../../db/schema/values.js';
import type { AgentToolRoute } from '../../../plugins/agent-tools.js';
import { type AgentDefinition, SHARED_RULES } from '../definitions.js';
import { type ModelClient, type ModelReply, type ModelRequest, ModelUnavailableError } from '../model/client.js';
import { modelInputSchema } from '../policy.js';
import { type Usage, NO_USAGE, addUsage } from './cost.js';
import { HAND_OFF_TOOL, type HandoffReason, modelHandoffReason } from './hand-off.js';

/**
 * One run of an agent, without the database (docs/decisions/agents.md AGT8):
 * build the request from the transcript, call the model, run or propose the
 * tools it asks for, and stop on a reply, a handoff or a limit. The runner
 * (runner.ts) gives it the database through ports, and the evals give it
 * fakes, so both run exactly this code.
 */
export interface StoredMessage {
  role: AgentMessageRole;
  content: unknown[];
  untrusted: boolean;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

export interface EnginePorts {
  model: ModelClient;
  /** The three kill switches, read again (AGT5). */
  stillOn(): Promise<boolean>;
  /** This month's spend is under the cap (AGT6). */
  withinBudget(): Promise<boolean>;
  /** Run a read, run a change the tenant raised to auto, or put a change on an approval card. */
  runTool(name: string, toolUseId: string, input: Record<string, unknown>): Promise<ToolOutcome>;
  /** Store one transcript line; a model reply comes with what it cost. */
  append(message: StoredMessage, usage?: { model: string; usage: Usage }): Promise<number>;
  now(): number;
}

export interface EngineInput {
  definition: AgentDefinition;
  displayName: string;
  channel: AgentChannel;
  verified: boolean;
  /** The tools this conversation may use, already narrowed (AGT9). */
  tools: readonly AgentToolRoute[];
  history: readonly StoredMessage[];
  /** Epoch milliseconds: the run's time limit (AGT6). */
  deadline: number;
}

export type EngineOutcome =
  | { kind: 'replied'; messageId: number; text: string }
  | { kind: 'handed_off'; reason: HandoffReason; endReason: string };

export interface EngineResult {
  outcome: EngineOutcome;
  steps: number;
  usage: Usage;
  /** The model version that answered, as the reply named it. */
  modelVersion: string | null;
}

function escapeUntrusted(text: string): string {
  return text.replace(/<\/?patient_message/gi, (tag) => tag.replace('<', '&lt;'));
}

function audienceLine(channel: AgentChannel, verified: boolean): string {
  if (channel === 'job') return 'This is a job a staff member or the system started. There is no patient in this conversation: your reply goes to the staff member.';
  const how = channel === 'voice' ? 'on a phone call: keep every reply to one or two short spoken sentences' : `by ${channel}`;
  return verified
    ? `You are talking with a signed-in patient, ${how}. Your tools act only for this patient.`
    : `You are talking ${how} with someone who is not signed in. You can't look up or change anyone's records: answer general questions, and take a message for anything else.`;
}

export function systemPrompt(input: Pick<EngineInput, 'definition' | 'displayName' | 'channel' | 'verified'>): string {
  return `${SHARED_RULES}\n\nYour name is ${input.displayName}.\n\n${input.definition.purpose}\n\n${audienceLine(input.channel, input.verified)}`;
}

/** The transcript as the model's messages: patient text marked as data, consecutive user turns joined. */
export function toModelMessages(history: readonly StoredMessage[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  for (const line of history) {
    const role = line.role === 'agent' ? 'assistant' : 'user';
    const blocks = (line.content as Anthropic.ContentBlockParam[]).map((block): Anthropic.ContentBlockParam => {
      if (block.type !== 'text') return block;
      if (line.role === 'patient') return { type: 'text', text: `<patient_message>\n${escapeUntrusted(block.text)}\n</patient_message>` };
      if (line.role === 'notice') return { type: 'text', text: `<notice>${block.text}</notice>` };
      return block;
    });
    const last = messages.at(-1);
    if (last && last.role === role && role === 'user') last.content = [...(last.content as Anthropic.ContentBlockParam[]), ...blocks];
    else messages.push({ role, content: blocks });
  }
  return messages;
}

export function buildRequest(input: EngineInput, history: readonly StoredMessage[]): ModelRequest {
  const tools: Anthropic.Tool[] = [
    ...input.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: modelInputSchema(tool) as Anthropic.Tool.InputSchema })),
    HAND_OFF_TOOL as Anthropic.Tool,
  ];
  return {
    model: input.definition.model,
    max_tokens: input.definition.maxTokens,
    system: [{ type: 'text', text: systemPrompt(input), cache_control: { type: 'ephemeral' } }],
    tools,
    messages: toModelMessages(history),
    output_config: { effort: input.definition.effort },
  };
}

function usageOf(reply: ModelReply): Usage {
  return {
    inputTokens: reply.usage.input_tokens,
    outputTokens: reply.usage.output_tokens,
    cacheReadTokens: reply.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: reply.usage.cache_creation_input_tokens ?? 0,
  };
}

const textOf = (reply: ModelReply) =>
  reply.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n\n');

export async function runEngine(input: EngineInput, ports: EnginePorts): Promise<EngineResult> {
  const history = [...input.history];
  let usage = NO_USAGE;
  let steps = 0;
  let modelVersion: string | null = null;
  const offered = new Set(input.tools.map((tool) => tool.name));
  const done = (outcome: EngineOutcome): EngineResult => ({ outcome, steps, usage, modelVersion });
  const handOff = (reason: HandoffReason, endReason: string) => done({ kind: 'handed_off', reason, endReason });

  const store = async (message: StoredMessage, cost?: { model: string; usage: Usage }) => {
    history.push(message);
    return ports.append(message, cost);
  };

  while (steps < input.definition.maxSteps) {
    if (!(await ports.stillOn())) return handOff('agent_off', 'agent_off');
    if (!(await ports.withinBudget())) return handOff('limit', 'spend_cap');
    const remaining = input.deadline - ports.now();
    if (remaining <= 0) return handOff('limit', 'time_limit');

    let reply: ModelReply;
    try {
      reply = await ports.model.create(buildRequest(input, history), AbortSignal.timeout(remaining));
    } catch (error) {
      if (error instanceof ModelUnavailableError) return error.code === 'timeout' ? handOff('limit', 'time_limit') : handOff('error', `model_${error.code}`);
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return handOff('limit', 'time_limit');
      throw error;
    }
    steps += 1;
    modelVersion = reply.model;
    const cost = usageOf(reply);
    usage = addUsage(usage, cost);
    const messageId = await store({ role: 'agent', content: reply.content, untrusted: false }, { model: input.definition.model, usage: cost });

    if (reply.stop_reason === 'refusal') return handOff('refusal', 'refusal');
    if (reply.stop_reason === 'max_tokens') return handOff('error', 'max_tokens');
    if (reply.stop_reason === 'model_context_window_exceeded') return handOff('limit', 'context_window');

    const toolUses = reply.content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
    if (toolUses.length === 0) {
      const text = textOf(reply);
      return text ? done({ kind: 'replied', messageId, text }) : handOff('error', 'empty_reply');
    }

    // Every tool_use gets its tool_result stored, whatever happens, so the transcript always replays.
    const results: Anthropic.ToolResultBlockParam[] = [];
    let stop: EngineResult | null = null;
    for (const use of toolUses) {
      const answer = (content: string, isError = false) => results.push({ type: 'tool_result', tool_use_id: use.id, content, is_error: isError });
      if (stop) {
        answer('Not run: the conversation went to a person.', true);
      } else if (use.name === HAND_OFF_TOOL.name) {
        answer('Handed to a person.');
        stop = handOff(modelHandoffReason(use.input), 'hand_off');
      } else if (!offered.has(use.name)) {
        answer(`There is no tool called ${use.name} here.`, true);
      } else if (!(await ports.stillOn())) {
        answer('Not run: the agent was switched off.', true);
        stop = handOff('agent_off', 'agent_off');
      } else {
        const outcome = await ports.runTool(use.name, use.id, (use.input ?? {}) as Record<string, unknown>);
        answer(outcome.content, outcome.isError);
      }
    }
    await store({ role: 'tool', content: results, untrusted: false });
    if (stop) return stop;
  }
  return handOff('limit', 'step_limit');
}
