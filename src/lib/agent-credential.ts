import { randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { AgentKind } from '../db/schema/values.js';
import { PERMISSIONS, type Permission } from './permissions.js';

/**
 * How an agent calls the API as itself (ADR 0012, docs/decisions/agents.md
 * AGT2). The agents module calls a route in-process with a credential signed
 * by a key made at boot. The key never leaves this process, is never stored
 * and is never configured, so nothing outside the process can make one, and
 * a credential dies with the process that made it.
 */
const KEY = randomBytes(32);
const AUDIENCE = 'medora-agent';
const LIFETIME_SECONDS = 120;

export interface AgentClaims {
  tenantId: string;
  /** The agent's settings row in this tenant: the id the audit log records. */
  agentId: string;
  agent: AgentKind;
  runId: string;
  /** What this call may do: the agent's role, narrowed to the person it works for or who approved it. */
  permissions: Permission[];
  /** The staff member who approved this change on a card, when it needed one. */
  approvedBy: string | null;
}

export async function mintAgentCredential(claims: AgentClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${LIFETIME_SECONDS}s`)
    .sign(KEY);
}

const KNOWN = new Set<string>(PERMISSIONS);

export async function verifyAgentCredential(token: string): Promise<AgentClaims> {
  const { payload } = await jwtVerify(token, KEY, { audience: AUDIENCE, algorithms: ['HS256'] });
  const claims = payload as unknown as Partial<AgentClaims>;
  if (
    typeof claims.tenantId !== 'string' ||
    typeof claims.agentId !== 'string' ||
    typeof claims.agent !== 'string' ||
    typeof claims.runId !== 'string' ||
    !Array.isArray(claims.permissions)
  ) {
    throw new Error('Malformed agent credential');
  }
  return {
    tenantId: claims.tenantId,
    agentId: claims.agentId,
    agent: claims.agent,
    runId: claims.runId,
    permissions: claims.permissions.filter((p): p is Permission => KNOWN.has(p)),
    approvedBy: typeof claims.approvedBy === 'string' ? claims.approvedBy : null,
  };
}
