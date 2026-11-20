import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTenant } from '../../db/tenant.js';
import type { FastifyRequest } from 'fastify';
import { requireTenant, tenantContextOf } from '../../plugins/auth.js';
import {
  approveDraft,
  changeArticle,
  createArticle,
  discardDraft,
  getArticle,
  listArticles,
  republishArticle,
  saveDraft,
  unpublishArticle,
  type Viewing,
} from './articles.service.js';
import {
  approveBody,
  articleBody,
  articleChangeBody,
  articleListReply,
  articleParams,
  articleReply,
  brandQuery,
  deletedReply,
  discardedReply,
  searchQuery,
  searchReply,
  sectionBody,
  sectionChangeBody,
  sectionListReply,
  sectionParams,
  sectionView,
  wordingBody,
} from './help-centre.schemas.js';
import { searchPublished } from './published.service.js';
import { changeSection, createSection, deleteSection, listSections } from './sections.service.js';

/** The help centre's staff routes (PRD SUP-04, SUP-06, docs/decisions/support.md SUP14 to SUP19). */

const tags = ['help centre'];
const byPeople = { none: 'Help centre wording is written and approved by people; agents never hold support:manage (SUP12, SUP16)' };
const noArticleEvents = { none: 'Nothing reacts to a draft or to where an article sits; only publishing emits' };
const noSectionEvents = { none: "Nothing reacts to a section's name or order; the pages read it when served" };
const publishes = ['help_centre_article.published'];

/** Drafts and taken-down articles only for support:manage holders, which agents never are (SUP19). */
const viewingOf = (request: FastifyRequest): Viewing => ({ includeDrafts: requireTenant(request).tenant.permissions.has('support:manage') });

export const helpCentreRoutes: FastifyPluginAsyncZod = async (app) => {
  const read = { access: { permission: 'help_centre:read' } } as const;
  const manage = { permission: 'support:manage' } as const;
  const changes = (audit: string[], events: string[] | { none: string } = noArticleEvents) => ({ access: manage, audit, events, agentTool: byPeople });

  app.get(
    '/help-centre/sections',
    { config: read, schema: { tags, summary: "A brand's help centre sections, in order", querystring: brandQuery, response: { 200: sectionListReply } } },
    async (request) => ({ sections: await withTenant(tenantContextOf(request), (tx) => listSections(tx, request.query.brandId)) }),
  );

  app.post(
    '/help-centre/sections',
    {
      config: changes(['help_centre_section.created'], noSectionEvents),
      schema: { tags, summary: "Add a section to a brand's help centre", body: sectionBody, response: { 201: sectionView } },
    },
    async (request, reply) => reply.code(201).send(await withTenant(tenantContextOf(request), (tx) => createSection(tx, request.body))),
  );

  app.patch(
    '/help-centre/sections/:sectionId',
    {
      config: changes(['help_centre_section.updated'], noSectionEvents),
      schema: { tags, summary: 'Rename or move a section', params: sectionParams, body: sectionChangeBody, response: { 200: sectionView } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => changeSection(tx, request.params.sectionId, request.body)),
  );

  app.delete(
    '/help-centre/sections/:sectionId',
    {
      config: changes(['help_centre_section.deleted'], noSectionEvents),
      schema: { tags, summary: 'Remove an empty section', params: sectionParams, response: { 200: deletedReply } },
    },
    async (request) => {
      await withTenant(tenantContextOf(request), (tx) => deleteSection(tx, request.params.sectionId));
      return { deleted: true as const };
    },
  );

  app.get(
    '/help-centre/articles',
    { config: read, schema: { tags, summary: 'Published help centre articles; drafts too for support:manage', querystring: brandQuery, response: { 200: articleListReply } } },
    async (request) => ({ articles: await withTenant(tenantContextOf(request), (tx) => listArticles(tx, viewingOf(request), request.query.brandId)) }),
  );

  app.get(
    '/help-centre/articles/:articleId',
    {
      config: read,
      schema: { tags, summary: 'An article: its live wording, its draft and every approved version', params: articleParams, response: { 200: articleReply } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => getArticle(tx, request.params.articleId, viewingOf(request))),
  );

  app.post(
    '/help-centre/articles',
    {
      config: changes(['help_centre_article.created']),
      schema: { tags, summary: 'Write a new article (a draft)', body: articleBody, response: { 201: articleReply } },
    },
    async (request, reply) => reply.code(201).send(await withTenant(tenantContextOf(request), (tx) => createArticle(tx, request.body))),
  );

  app.patch(
    '/help-centre/articles/:articleId',
    {
      config: changes(['help_centre_article.updated']),
      schema: {
        tags,
        summary: "Move an article, or change its slug before it's first published",
        params: articleParams,
        body: articleChangeBody,
        response: { 200: articleReply },
      },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => changeArticle(tx, request.params.articleId, request.body)),
  );

  app.put(
    '/help-centre/articles/:articleId/draft',
    {
      config: changes(['help_centre_article.draft_saved']),
      schema: { tags, summary: "Write the article's draft; the live wording stays up", params: articleParams, body: wordingBody, response: { 200: articleReply } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => saveDraft(tx, request.params.articleId, request.body)),
  );

  app.delete(
    '/help-centre/articles/:articleId/draft',
    {
      config: changes(['help_centre_article.draft_discarded']),
      schema: { tags, summary: 'Discard the draft (and the article, if it was never published)', params: articleParams, response: { 200: discardedReply } },
    },
    async (request) => ({ discarded: true as const, ...(await withTenant(tenantContextOf(request), (tx) => discardDraft(tx, request.params.articleId))) }),
  );

  app.post(
    '/help-centre/articles/:articleId/draft/approve',
    {
      config: changes(['help_centre_article.approved', ...publishes], publishes),
      schema: {
        tags,
        summary: 'Approve the draft and publish it in place of the live wording',
        params: articleParams,
        body: approveBody,
        response: { 200: articleReply },
      },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => approveDraft(tx, request.params.articleId, request.body.versionId)),
  );

  app.post(
    '/help-centre/articles/:articleId/unpublish',
    {
      config: changes(['help_centre_article.unpublished'], ['help_centre_article.unpublished']),
      schema: { tags, summary: 'Take an article off the help centre', params: articleParams, response: { 200: articleReply } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => unpublishArticle(tx, request.params.articleId)),
  );

  app.post(
    '/help-centre/articles/:articleId/publish',
    {
      config: changes(publishes, publishes),
      schema: { tags, summary: 'Put the last approved wording back up, after the checks', params: articleParams, response: { 200: articleReply } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => republishArticle(tx, request.params.articleId)),
  );

  app.get(
    '/help-centre/search',
    {
      config: { ...read, agentTool: 'search_help_centre' },
      schema: {
        tags,
        summary: 'Search the published help centre articles. Answer only from what this returns, and name the article you used.',
        querystring: searchQuery,
        response: { 200: searchReply },
      },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => searchPublished(tx, request.query)),
  );
};
