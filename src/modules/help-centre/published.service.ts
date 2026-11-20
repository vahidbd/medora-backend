import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { helpCentreArticles, helpCentreArticleVersions, helpCentreSections } from '../../db/schema/index.js';
import type { TenantTx } from '../../db/tenant.js';
import { NotFoundError } from '../../lib/errors.js';
import { getBrand, listBrands } from '../brands/index.js';

/**
 * What is public (docs/decisions/support.md SUP17, SUP19): the live version
 * of each published article, and nothing else. The brand's public pages and
 * the support agent read only through here. Service wording, no patient's
 * details, so these reads write no audit entry; the search words are never
 * stored or logged.
 */

const AGENT_BODY_LIMIT = 4_000;

/** The same expression as the search index on approved versions. */
const document = sql`to_tsvector('english', ${helpCentreArticleVersions.title} || ' ' || ${helpCentreArticleVersions.summary} || ' ' || ${helpCentreArticleVersions.body})`;
const query = (words: string) => sql`websearch_to_tsquery('english', ${words})`;

function published(tx: TenantTx) {
  return tx.db
    .select({
      articleId: helpCentreArticles.id,
      brandId: helpCentreArticles.brandId,
      slug: helpCentreArticles.slug,
      versionId: helpCentreArticleVersions.id,
      title: helpCentreArticleVersions.title,
      summary: helpCentreArticleVersions.summary,
      body: helpCentreArticleVersions.body,
      approvedAt: helpCentreArticleVersions.approvedAt,
      section: helpCentreSections.name,
    })
    .from(helpCentreArticles)
    .innerJoin(
      helpCentreArticleVersions,
      and(eq(helpCentreArticleVersions.tenantId, helpCentreArticles.tenantId), eq(helpCentreArticleVersions.id, helpCentreArticles.liveVersionId)),
    )
    .innerJoin(helpCentreSections, and(eq(helpCentreSections.tenantId, helpCentreArticles.tenantId), eq(helpCentreSections.id, helpCentreArticles.sectionId)))
    .$dynamic();
}

const isPublished = (tx: TenantTx) =>
  and(eq(helpCentreArticles.tenantId, tx.context.tenantId), isNotNull(helpCentreArticles.publishedAt), isNotNull(helpCentreArticleVersions.approvedAt));

/** A brand's help centre front page: its sections in order, each with its published articles. Empty is a real answer. */
export async function publicHelpCentre(tx: TenantTx, brandId: string) {
  const brand = await getBrand(tx, brandId);
  const rows = await published(tx)
    .where(and(isPublished(tx), eq(helpCentreArticles.brandId, brandId)))
    .orderBy(asc(helpCentreSections.position), asc(sql`lower(${helpCentreSections.name})`), asc(helpCentreArticles.position), asc(helpCentreArticles.slug));
  const sections: { name: string; articles: { slug: string; title: string; summary: string }[] }[] = [];
  for (const row of rows) {
    const last = sections.at(-1);
    const article = { slug: row.slug, title: row.title, summary: row.summary };
    if (last?.name === row.section) last.articles.push(article);
    else sections.push({ name: row.section, articles: [article] });
  }
  return { brandName: brand.name, sections };
}

export async function publicSearch(tx: TenantTx, brandId: string, words: string) {
  const rows = await published(tx)
    .where(and(isPublished(tx), eq(helpCentreArticles.brandId, brandId), sql`${document} @@ ${query(words)}`))
    .orderBy(desc(sql`ts_rank(${document}, ${query(words)})`), asc(helpCentreArticles.position))
    .limit(10);
  return { articles: rows.map((row) => ({ slug: row.slug, title: row.title, summary: row.summary, section: row.section })) };
}

export async function publicArticle(tx: TenantTx, brandId: string, slug: string) {
  const [row] = await published(tx).where(and(isPublished(tx), eq(helpCentreArticles.brandId, brandId), eq(helpCentreArticles.slug, slug)));
  if (!row?.approvedAt) throw new NotFoundError('Article');
  return { slug: row.slug, title: row.title, summary: row.summary, body: row.body, section: row.section, updatedAt: row.approvedAt.toISOString() };
}

/**
 * The support agent's search (SUP19): the five best published articles, with
 * the version id so an answer names the exact wording it used. Each result
 * names its brand, since conversations don't carry one yet.
 */
export async function searchPublished(tx: TenantTx, input: { q: string; brandId?: string | undefined }) {
  const rows = await published(tx)
    .where(and(isPublished(tx), input.brandId ? eq(helpCentreArticles.brandId, input.brandId) : undefined, sql`${document} @@ ${query(input.q)}`))
    .orderBy(desc(sql`ts_rank(${document}, ${query(input.q)})`), asc(helpCentreArticles.position))
    .limit(5);
  const names = new Map((await listBrands(tx)).map((brand) => [brand.brandId, brand.name]));
  return {
    articles: rows.map((row) => ({
      articleId: row.articleId,
      versionId: row.versionId,
      brandId: row.brandId,
      brandName: names.get(row.brandId) ?? '',
      slug: row.slug,
      title: row.title,
      summary: row.summary,
      body: row.body.slice(0, AGENT_BODY_LIMIT),
    })),
  };
}
