import { env } from '../../../config/env.js';
import { bedrockClient } from './bedrock.js';
import type { ModelClient } from './client.js';
import { standInClient } from './scripted.js';

/** The configured model client (AGT17): Bedrock in Australia, or the stand-in for development and preview. */
export function configuredModelClient(): ModelClient {
  return env.AGENT_MODEL_CLIENT === 'bedrock' ? bedrockClient(env.AGENT_BEDROCK_REGION) : standInClient();
}

export { type ModelClient, type ModelReply, type ModelRequest, ModelUnavailableError } from './client.js';
export { scripted, scriptedClient } from './scripted.js';
