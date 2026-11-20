import type Anthropic from '@anthropic-ai/sdk';

/**
 * The model behind every agent, behind one small interface (ADR 0012): Claude
 * through Bedrock in Australia once deployed, a scripted stand-in in
 * development, tests and preview, where there are no AWS credentials and no
 * patient data.
 */
export type ModelRequest = Anthropic.MessageCreateParamsNonStreaming;
export type ModelReply = Anthropic.Message;

export interface ModelClient {
  readonly kind: 'bedrock' | 'scripted';
  create(request: ModelRequest, signal?: AbortSignal): Promise<ModelReply>;
}

/** The model could not be reached or refused the request; the run hands off to a person. */
export class ModelUnavailableError extends Error {
  constructor(readonly code: 'not_configured' | 'unreachable' | 'rejected' | 'timeout', message: string) {
    super(message);
    this.name = 'ModelUnavailableError';
  }
}
