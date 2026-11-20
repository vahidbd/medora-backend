import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { helpCentreArticles, helpCentreArticleVersions } from '../../db/schema/index.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { postgresError } from '../../lib/database-errors.js';
import { BadRequestError, BusinessRuleError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { getBrand } from '../brands/index.js';
import { type ArticleStatus, assertPublishable, PUBLISH_CHECKS, SERVICE_ONLY_CONFIRMATION, type Wording } from './rules.js';

/**
 * Help centre articles (docs/decisions/support.md SUP14 to SUP18). An
 * article belongs to one brand; its wording is in versions. A draft is
 * written, then approved by a support:manage holder (their own too), which
 * publishes it in the same transaction. Approved versions are never changed,
 * and the live one stays up while the next draft waits. Drafts and taken-down
 * articles are seen only by support:manage holders, so help_centre:read
 * (which agents may hold) reaches published wording only (SUP19).
 */

const RECORD = 'operational.help_centre_articles' as const;
type ArticleRow = typeof helpCentreArticles.$inferSelect;
type VersionRow = typeof helpCentreArticleVersions.$inferSelect;
/** Whether the viewer may see drafts and taken-down articles: support:manage holders only. */
export interface Viewing {
  includeDrafts: boolean;
}
const MANAGER: Viewing = { includeDrafts: true };

function personOf(tx: TenantTx): string {
  const { actor } = tx.context;
  if (actor.type !== 'person') throw new ForbiddenError('Only a staff member writes or approves help centre articles', 'person_only');
  return actor.userId;
}

const statusOf = (row: ArticleRow): ArticleStatus => (row.publishedAt ? 'published' : row.liveVersionId ? 'unpublished' : 'draft');

function summaryOf(version: VersionRow) {
  return { versionId: version.id, title: version.title, writtenByUserId: version.writtenByUserId, updatedAt: version.updatedAt.toISOString() };
}

function approvedOf(version: VersionRow) {
  if (!version.approvedByUserId || !version.approvedAt) throw new Error('approved version without its approval');
  return { ...summaryOf(version), approvedByUserId: version.approvedByUserId, approvedAt: version.approvedAt.toISOString() };
}

function fullOf(version: VersionRow) {
  return {
    ...summaryOf(version),
    summary: version.summary,
    body: version.body,
    approvedByUserId: version.approvedByUserId,
    approvedAt: version.approvedAt?.toISOString() ?? null,
    checkedWith: version.checkedWith,
    confirmation: version.confirmation,
  };
}

function itemOf(row: ArticleRow) {
  return {
    articleId: row.id,
    brandId: row.brandId,
    sectionId: row.sectionId,
    slug: row.slug,
    position: row.position,
    status: statusOf(row),
    publishedAt: row.publishedAt?.toISOString() ?? null,
  };
}

export async function listArticles(tx: TenantTx, viewing: Viewing, brandId?: string) {
  const { tenantId } = tx.context;
  const rows = await tx.db
    .select()
    .from(helpCentreArticles)
    .where(
      and(
        eq(helpCentreArticles.tenantId, tenantId),
        brandId ? eq(helpCentreArticles.brandId, brandId) : undefined,
        viewing.includeDrafts ? undefined : isNotNull(helpCentreArticles.publishedAt),
      ),
    )
    .orderBy(asc(helpCentreArticles.brandId), asc(helpCentreArticles.position), asc(helpCentreArticles.slug));
  if (rows.length === 0) return [];
  const live = rows.flatMap((row) => (row.liveVersionId ? [row.liveVersionId] : []));
  const versions = await tx.db
    .select()
    .from(helpCentreArticleVersions)
    .where(
      and(
        eq(helpCentreArticleVersions.tenantId, tenantId),
        inArray(
          helpCentreArticleVersions.articleId,
          rows.map((row) => row.id),
        ),
        live.length > 0 ? or(isNull(helpCentreArticleVersions.approvedAt), inArray(helpCentreArticleVersions.id, live)) : isNull(helpCentreArticleVersions.approvedAt),
      ),
    );
  return rows.map((row) => {
    const liveVersion = versions.find((version) => version.id === row.liveVersionId);
    const draft = viewing.includeDrafts ? versions.find((version) => version.articleId === row.id && !version.approvedAt) : undefined;
    return { ...itemOf(row), live: liveVersion ? approvedOf(liveVersion) : null, draft: draft ? summaryOf(draft) : null };
  });
}

async function findArticle(tx: TenantTx, articleId: string, lock: boolean): Promise<ArticleRow> {
  const query = tx.db
    .select()
    .from(helpCentreArticles)
    .where(and(eq(helpCentreArticles.tenantId, tx.context.tenantId), eq(helpCentreArticles.id, articleId)));
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw new NotFoundError('Article');
  return row;
}

async function versionsOf(tx: TenantTx, articleId: string): Promise<VersionRow[]> {
  return tx.db
    .select()
    .from(helpCentreArticleVersions)
    .where(and(eq(helpCentreArticleVersions.tenantId, tx.context.tenantId), eq(helpCentreArticleVersions.articleId, articleId)))
    .orderBy(desc(helpCentreArticleVersions.approvedAt));
}

export async function getArticle(tx: TenantTx, articleId: string, viewing: Viewing) {
  const row = await findArticle(tx, articleId, false);
  if (!viewing.includeDrafts && !row.publishedAt) throw new NotFoundError('Article');
  const versions = await versionsOf(tx, articleId);
  const live = versions.find((version) => version.id === row.liveVersionId);
  const draft = viewing.includeDrafts ? versions.find((version) => !version.approvedAt) : undefined;
  return {
    ...itemOf(row),
    live: live ? fullOf(live) : null,
    draft: draft ? fullOf(draft) : null,
    history: versions.filter((version) => version.approvedAt).map(approvedOf),
  };
}

/** The database's refusals of a slug or a section, in the writer's words. */
async function explainRefusal<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const pg = postgresError(error);
    if (pg?.code === '23505' && pg.message.includes('help_centre_articles_slug_key')) throw new BusinessRuleError('Another article of this brand has that slug', 'slug_taken');
    if (pg?.code === '23503' && pg.message.includes('help_centre_articles_section_fk')) throw new BadRequestError("Choose one of this brand's sections", 'section_not_found');
    throw error;
  }
}

export async function createArticle(tx: TenantTx, input: Wording & { brandId: string; sectionId: string; slug: string; position?: number | undefined }) {
  const userId = personOf(tx);
  await getBrand(tx, input.brandId);
  const { tenantId } = tx.context;
  const [row] = await explainRefusal(() =>
    tx.db
      .insert(helpCentreArticles)
      .values({ tenantId, brandId: input.brandId, sectionId: input.sectionId, slug: input.slug, position: input.position ?? 0, createdByUserId: userId })
      .returning(),
  );
  if (!row) throw new Error('article insert returned nothing');
  await tx.db.insert(helpCentreArticleVersions).values({ tenantId, articleId: row.id, title: input.title, summary: input.summary, body: input.body, writtenByUserId: userId });
  await audit(tx, { action: 'help_centre_article.created', zone: 'operational', recordTable: RECORD, recordId: row.id, details: { brandId: row.brandId } });
  return getArticle(tx, row.id, MANAGER);
}

/** Where the article sits. Its slug is fixed once first approved, so links and citations keep working (SUP17). */
export async function changeArticle(tx: TenantTx, articleId: string, input: { sectionId?: string | undefined; slug?: string | undefined; position?: number | undefined }) {
  personOf(tx);
  const current = await findArticle(tx, articleId, true);
  if (input.slug !== undefined && input.slug !== current.slug && current.liveVersionId)
    throw new BusinessRuleError("An article's slug can't change once it has been published", 'slug_fixed');
  await explainRefusal(() =>
    tx.db
      .update(helpCentreArticles)
      .set({
        ...(input.sectionId !== undefined ? { sectionId: input.sectionId } : {}),
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
        updatedAt: sql`now()`,
      })
      .where(and(eq(helpCentreArticles.tenantId, tx.context.tenantId), eq(helpCentreArticles.id, articleId))),
  );
  const changed = Object.keys(input).filter((key) => input[key as keyof typeof input] !== undefined);
  await audit(tx, { action: 'help_centre_article.updated', zone: 'operational', recordTable: RECORD, recordId: articleId, details: { changed: changed.join(',') } });
  return getArticle(tx, articleId, MANAGER);
}

async function openDraft(tx: TenantTx, articleId: string): Promise<VersionRow | undefined> {
  const [draft] = await tx.db
    .select()
    .from(helpCentreArticleVersions)
    .where(and(eq(helpCentreArticleVersions.tenantId, tx.context.tenantId), eq(helpCentreArticleVersions.articleId, articleId), isNull(helpCentreArticleVersions.approvedAt)));
  return draft;
}

/**
 * Write the article's one open draft. Each save replaces the draft with a new
 * version, so an approval names exactly the wording its approver read (SUP16).
 * The live version stays up meanwhile.
 */
export async function saveDraft(tx: TenantTx, articleId: string, wording: Wording) {
  const userId = personOf(tx);
  await findArticle(tx, articleId, true);
  const draft = await openDraft(tx, articleId);
  const { tenantId } = tx.context;
  if (draft) await tx.db.delete(helpCentreArticleVersions).where(and(eq(helpCentreArticleVersions.tenantId, tenantId), eq(helpCentreArticleVersions.id, draft.id)));
  await tx.db.insert(helpCentreArticleVersions).values({ tenantId, articleId, title: wording.title, summary: wording.summary, body: wording.body, writtenByUserId: userId });
  await audit(tx, { action: 'help_centre_article.draft_saved', zone: 'operational', recordTable: RECORD, recordId: articleId, details: { newDraft: !draft } });
  return getArticle(tx, articleId, MANAGER);
}

/** Drop the open draft. An article that was never published goes with it, since nothing of it was ever public. */
export async function discardDraft(tx: TenantTx, articleId: string): Promise<{ articleRemoved: boolean }> {
  personOf(tx);
  const article = await findArticle(tx, articleId, true);
  const draft = await openDraft(tx, articleId);
  if (!draft) throw new NotFoundError('Draft');
  const { tenantId } = tx.context;
  await tx.db.delete(helpCentreArticleVersions).where(and(eq(helpCentreArticleVersions.tenantId, tenantId), eq(helpCentreArticleVersions.id, draft.id)));
  const articleRemoved = article.liveVersionId === null;
  if (articleRemoved) await tx.db.delete(helpCentreArticles).where(and(eq(helpCentreArticles.tenantId, tenantId), eq(helpCentreArticles.id, articleId)));
  await audit(tx, { action: 'help_centre_article.draft_discarded', zone: 'operational', recordTable: RECORD, recordId: articleId, details: { articleRemoved } });
  return { articleRemoved };
}

/** What the check reads: the wording and the slug, which is part of the public address. */
const publicTexts = (version: Wording, article: ArticleRow) => [version.title, version.summary, version.body, article.slug.replace(/-/g, ' ')];

async function setPublished(tx: TenantTx, article: ArticleRow, versionId: string, details: Record<string, string | boolean | null>) {
  await tx.db
    .update(helpCentreArticles)
    .set({ liveVersionId: versionId, publishedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(helpCentreArticles.tenantId, tx.context.tenantId), eq(helpCentreArticles.id, article.id)));
  await audit(tx, { action: 'help_centre_article.published', zone: 'operational', recordTable: RECORD, recordId: article.id, details: { versionId, ...details } });
  await emitEvent(tx, { type: 'help_centre_article.published', recordTable: RECORD, recordId: article.id, payload: { brandId: article.brandId, versionId } });
}

/**
 * Approve the draft the approver read and put it up in place of the live
 * version (SUP15, SUP16, SUP18). Whoever wrote it may approve it; the checks
 * run first, and the approver's confirmation is stored on the version with
 * the checks it passed. A draft saved since they read it is refused.
 */
export async function approveDraft(tx: TenantTx, articleId: string, versionId: string) {
  const userId = personOf(tx);
  const article = await findArticle(tx, articleId, true);
  const draft = await openDraft(tx, articleId);
  if (!draft) throw new BusinessRuleError('There is no draft to approve', 'no_draft');
  if (draft.id !== versionId) throw new BusinessRuleError('The draft has changed since you read it: read it again before approving', 'draft_changed');
  assertPublishable(publicTexts(draft, article));
  await tx.db
    .update(helpCentreArticleVersions)
    .set({ approvedByUserId: userId, approvedAt: sql`now()`, checkedWith: PUBLISH_CHECKS, confirmation: SERVICE_ONLY_CONFIRMATION, updatedAt: sql`now()` })
    .where(and(eq(helpCentreArticleVersions.tenantId, tx.context.tenantId), eq(helpCentreArticleVersions.id, draft.id)));
  await audit(tx, {
    action: 'help_centre_article.approved',
    zone: 'operational',
    recordTable: RECORD,
    recordId: articleId,
    details: { versionId: draft.id, writtenByUserId: draft.writtenByUserId, checkedWith: PUBLISH_CHECKS },
  });
  await setPublished(tx, article, draft.id, { replaced: article.liveVersionId });
  return getArticle(tx, articleId, MANAGER);
}

/** Take the article off the public pages and away from agents. Its approved wording stays, ready to go back up. */
export async function unpublishArticle(tx: TenantTx, articleId: string) {
  personOf(tx);
  const article = await findArticle(tx, articleId, true);
  if (article.publishedAt) {
    await tx.db
      .update(helpCentreArticles)
      .set({ publishedAt: null, updatedAt: sql`now()` })
      .where(and(eq(helpCentreArticles.tenantId, tx.context.tenantId), eq(helpCentreArticles.id, articleId)));
    await audit(tx, { action: 'help_centre_article.unpublished', zone: 'operational', recordTable: RECORD, recordId: articleId, details: { versionId: article.liveVersionId } });
    await emitEvent(tx, { type: 'help_centre_article.unpublished', recordTable: RECORD, recordId: articleId, payload: { brandId: article.brandId } });
  }
  return getArticle(tx, articleId, MANAGER);
}

/**
 * Put the last approved wording back up. It must pass today's checks, not
 * only the ones it passed when approved; the version can't change, so the
 * checks it passed now go in the audit entry (SUP16).
 */
export async function republishArticle(tx: TenantTx, articleId: string) {
  personOf(tx);
  const article = await findArticle(tx, articleId, true);
  if (!article.liveVersionId) throw new BusinessRuleError('Approve a draft first: this article has never been published', 'never_published');
  if (!article.publishedAt) {
    const [live] = await tx.db
      .select()
      .from(helpCentreArticleVersions)
      .where(
        and(eq(helpCentreArticleVersions.tenantId, tx.context.tenantId), eq(helpCentreArticleVersions.id, article.liveVersionId), isNotNull(helpCentreArticleVersions.approvedAt)),
      );
    if (!live) throw new Error('live version missing');
    assertPublishable(publicTexts(live, article));
    await setPublished(tx, article, live.id, { republished: true, checkedWith: PUBLISH_CHECKS });
  }
  return getArticle(tx, articleId, MANAGER);
}
