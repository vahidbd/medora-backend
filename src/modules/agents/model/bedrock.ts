import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import { ModelUnavailableError, type ModelClient, type ModelReply, type ModelRequest } from './client.js';

/**
 * Claude through Amazon Bedrock's Messages endpoint in an Australian region
 * (ADR 0005). Credentials come from the host's AWS credential chain; none are
 * read here. The region is checked at boot (src/config/env.ts).
 */
export function bedrockClient(region: string): ModelClient {
  const client = new AnthropicBedrockMantle({ awsRegion: region, maxRetries: 2, timeout: 120_000 });
  return {
    kind: 'bedrock',
    async create(request: ModelRequest, signal?: AbortSignal): Promise<ModelReply> {
      try {
        return await client.messages.create(request, { signal });
      } catch (error) {
        if (error instanceof Anthropic.APIUserAbortError || error instanceof Anthropic.APIConnectionTimeoutError) {
          throw new ModelUnavailableError('timeout', 'The model did not answer in time');
        }
        if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
          throw new ModelUnavailableError('not_configured', 'The model refused the credentials of this service');
        }
        if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.NotFoundError) {
          throw new ModelUnavailableError('rejected', `The model rejected the request (${error.status})`);
        }
        if (error instanceof Anthropic.APIError) {
          throw new ModelUnavailableError('unreachable', `The model answered ${error.status ?? 'an error'}`);
        }
        throw error;
      }
    },
  };
}
