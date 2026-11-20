import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTenant } from '../../db/tenant.js';
import { tenantContextOf } from '../../plugins/auth.js';
import { changeProgram, createProgram, getProgram, listPrograms } from './programs.service.js';
import {
  draftBody,
  newProgramBody,
  newProtocolBody,
  program,
  programChangeBody,
  programParams,
  programsReply,
  protocolDetail,
  protocolParams,
  protocolsReply,
  signOffBody,
  templatesReply,
  versionDetail,
  versionParams,
  withdrawBody,
} from './protocols.schemas.js';
import { createProtocol, getProtocol, getProtocolVersion, listProtocols, signOff, startDraft, updateDraft, withdrawLive } from './protocols.service.js';
import { listTemplates } from './templates.js';

/** Protocols, their versions and sign-off, and programs (docs/decisions/intake.md INT3, INT4, INT9, INT10). */

const NOT_YET = { none: 'No agent drafts protocols or programs yet; the tenant setup agent comes later through these routes (ADR 0012)' };
const NEVER = { none: 'Signing off or withdrawing a protocol is a medical director’s own act; an agent never does it (ADR 0012)' };

export const protocolsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/protocol-templates',
    {
      config: { access: { permission: 'protocols:read' } },
      schema: { tags: ['protocols'], summary: 'The platform’s protocol templates a tenant can copy', response: { 200: templatesReply } },
    },
    async () => ({ templates: listTemplates() }),
  );

  app.get(
    '/protocols',
    { config: { access: { permission: 'protocols:read' } }, schema: { tags: ['protocols'], summary: 'The tenant’s protocols', response: { 200: protocolsReply } } },
    async (request) => ({ protocols: await withTenant(tenantContextOf(request), listProtocols) }),
  );

  app.post(
    '/protocols',
    {
      config: { access: { permission: 'protocols:manage' }, audit: ['protocol.created', 'protocol_version.drafted'], events: { none: 'A draft changes nothing until it is signed off' }, agentTool: NOT_YET },
      schema: { tags: ['protocols'], summary: 'Start a protocol from a template or a definition, as a draft', body: newProtocolBody, response: { 201: protocolDetail } },
    },
    async (request, reply) => reply.code(201).send(await withTenant(tenantContextOf(request), (tx) => createProtocol(tx, request.body))),
  );

  app.get(
    '/protocols/:protocolId',
    { config: { access: { permission: 'protocols:read' } }, schema: { tags: ['protocols'], summary: 'A protocol and its versions', params: protocolParams, response: { 200: protocolDetail } } },
    async (request) => withTenant(tenantContextOf(request), (tx) => getProtocol(tx, request.params.protocolId)),
  );

  app.get(
    '/protocols/:protocolId/versions/:version',
    {
      config: { access: { permission: 'protocols:read' } },
      schema: { tags: ['protocols'], summary: 'One version of a protocol, with its questions and rules', params: versionParams, response: { 200: versionDetail } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => getProtocolVersion(tx, request.params.protocolId, request.params.version)),
  );

  app.post(
    '/protocols/:protocolId/draft',
    {
      config: { access: { permission: 'protocols:manage' }, audit: ['protocol_version.drafted'], events: { none: 'A draft changes nothing until it is signed off' }, agentTool: NOT_YET },
      schema: { tags: ['protocols'], summary: 'Start the next version as a draft', params: protocolParams, response: { 201: versionDetail } },
    },
    async (request, reply) => reply.code(201).send(await withTenant(tenantContextOf(request), (tx) => startDraft(tx, request.params.protocolId))),
  );

  app.put(
    '/protocols/:protocolId/draft',
    {
      config: { access: { permission: 'protocols:manage' }, audit: ['protocol_version.edited'], events: { none: 'A draft changes nothing until it is signed off' }, agentTool: NOT_YET },
      schema: { tags: ['protocols'], summary: 'Replace the draft’s questions and rules', params: protocolParams, body: draftBody, response: { 200: versionDetail } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => updateDraft(tx, request.params.protocolId, request.body.definition)),
  );

  app.post(
    '/protocols/:protocolId/sign-off',
    {
      config: { access: { permission: 'protocols:sign_off' }, audit: ['protocol_version.signed_off'], events: ['protocol_version.live'], agentTool: NEVER },
      schema: { tags: ['protocols'], summary: 'Sign off the draft, which makes it live', params: protocolParams, body: signOffBody, response: { 200: versionDetail } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => signOff(tx, request.params.protocolId, request.body)),
  );

  app.post(
    '/protocols/:protocolId/withdraw',
    {
      config: { access: { permission: 'protocols:sign_off' }, audit: ['protocol_version.withdrawn'], events: ['protocol_version.withdrawn'], agentTool: NEVER },
      schema: { tags: ['protocols'], summary: 'Withdraw the live version for safety', params: protocolParams, body: withdrawBody, response: { 200: versionDetail } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => withdrawLive(tx, request.params.protocolId, request.body.reason)),
  );

  app.get(
    '/programs',
    { config: { access: 'member' }, schema: { tags: ['programs'], summary: 'The tenant’s programs', response: { 200: programsReply } } },
    async (request) => ({ programs: await withTenant(tenantContextOf(request), listPrograms) }),
  );

  app.get(
    '/programs/:programId',
    { config: { access: 'member' }, schema: { tags: ['programs'], summary: 'One program', params: programParams, response: { 200: program } } },
    async (request) => withTenant(tenantContextOf(request), (tx) => getProgram(tx, request.params.programId)),
  );

  app.post(
    '/programs',
    {
      config: { access: { permission: 'programs:manage' }, audit: ['program.created'], events: { none: 'A new program is a draft; nothing reacts until it goes live' }, agentTool: NOT_YET },
      schema: { tags: ['programs'], summary: 'Add a program on a protocol, as a draft', body: newProgramBody, response: { 201: program } },
    },
    async (request, reply) => reply.code(201).send(await withTenant(tenantContextOf(request), (tx) => createProgram(tx, request.body))),
  );

  app.patch(
    '/programs/:programId',
    {
      config: { access: { permission: 'programs:manage' }, audit: ['program.updated'], events: ['program.status_changed'], agentTool: NOT_YET },
      schema: { tags: ['programs'], summary: 'Change a program, or take it live, pause or retire it', params: programParams, body: programChangeBody, response: { 200: program } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => changeProgram(tx, request.params.programId, request.body)),
  );
};
