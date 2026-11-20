import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, type PgTableExtraConfigValue, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { brands } from './brands.js';
import { oneOf } from './checks.js';
import { tenants, users } from './platform.js';
import { HELP_CENTRE_CHECKS } from './values.js';
import { operational } from './zones.js';

/**
 * A brand's public help centre (PRD SUP-04, SUP-06, docs/decisions/support.md
 * SUP14 to SUP19). Service wording for anyone to read, so it holds no
 * patient's details. Composite keys keep a section, an article and its
 * versions inside one tenant and one brand.
 */

/** A heading articles are grouped under, in the brand's own order (SUP17). */
export const helpCentreSections = operational.table(
  'help_centre_sections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    brandId: uuid('brand_id').notNull(),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({ columns: [table.tenantId, table.brandId], foreignColumns: [brands.tenantId, brands.id], name: 'help_centre_sections_brand_fk' }),
    unique('help_centre_sections_brand_id_key').on(table.tenantId, table.brandId, table.id),
    uniqueIndex('help_centre_sections_name_key').on(table.tenantId, table.brandId, sql`lower(${table.name})`),
  ],
);

/**
 * One article of one brand (SUP14). Its wording is in versions; the article
 * holds where it sits and which approved version is live. `published_at` is
 * set while the live version is on the public pages.
 */
export const helpCentreArticles = operational.table(
  'help_centre_articles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    brandId: uuid('brand_id').notNull(),
    sectionId: uuid('section_id').notNull(),
    /** The last part of the article's public address, fixed once first published (SUP17). */
    slug: text('slug').notNull(),
    position: integer('position').notNull().default(0),
    liveVersionId: uuid('live_version_id'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Typed, because the article and its versions point at each other.
  (table): PgTableExtraConfigValue[] => [
    foreignKey({ columns: [table.tenantId, table.brandId], foreignColumns: [brands.tenantId, brands.id], name: 'help_centre_articles_brand_fk' }),
    foreignKey({
      columns: [table.tenantId, table.brandId, table.sectionId],
      foreignColumns: [helpCentreSections.tenantId, helpCentreSections.brandId, helpCentreSections.id],
      name: 'help_centre_articles_section_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.id, table.liveVersionId],
      foreignColumns: [helpCentreArticleVersions.tenantId, helpCentreArticleVersions.articleId, helpCentreArticleVersions.id],
      name: 'help_centre_articles_live_version_fk',
    }),
    unique('help_centre_articles_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('help_centre_articles_slug_key').on(table.tenantId, table.brandId, table.slug),
    index('help_centre_articles_section_idx').on(table.tenantId, table.brandId, table.sectionId),
    index('help_centre_articles_live_version_idx').on(table.tenantId, table.id, table.liveVersionId),
    index('help_centre_articles_created_by_idx').on(table.createdByUserId),
    check('help_centre_articles_slug_check', sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(${table.slug}) <= 80`),
    check('help_centre_articles_published_check', sql`${table.publishedAt} is null or ${table.liveVersionId} is not null`),
  ],
);

/**
 * An article's wording (SUP15). One open draft at a time; once approved a
 * version is never changed or removed (a trigger refuses it), so every
 * wording that was ever public is kept with who wrote and who approved it.
 */
export const helpCentreArticleVersions = operational.table(
  'help_centre_article_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    articleId: uuid('article_id').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    body: text('body').notNull(),
    /** Whoever last wrote this wording. */
    writtenByUserId: uuid('written_by_user_id')
      .notNull()
      .references(() => users.id),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    /** Which publish checks it passed (SUP16). */
    checkedWith: text('checked_with'),
    /** The approver's words, as confirmed (SUP18). */
    confirmation: text('confirmation'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.tenantId, table.articleId],
      foreignColumns: [helpCentreArticles.tenantId, helpCentreArticles.id],
      name: 'help_centre_article_versions_article_fk',
    }),
    unique('help_centre_article_versions_article_id_key').on(table.tenantId, table.articleId, table.id),
    uniqueIndex('help_centre_article_versions_one_draft_key')
      .on(table.articleId)
      .where(sql`${table.approvedAt} is null`),
    index('help_centre_article_versions_search_idx')
      .using('gin', sql`to_tsvector('english', ${table.title} || ' ' || ${table.summary} || ' ' || ${table.body})`)
      .where(sql`${table.approvedAt} is not null`),
    index('help_centre_article_versions_written_by_idx').on(table.writtenByUserId),
    index('help_centre_article_versions_approved_by_idx').on(table.approvedByUserId),
    check('help_centre_article_versions_checked_with_check', oneOf(table.checkedWith, HELP_CENTRE_CHECKS)),
    check(
      'help_centre_article_versions_approved_check',
      sql`(${table.approvedAt} is null) = (${table.approvedByUserId} is null) and (${table.approvedAt} is null) = (${table.checkedWith} is null) and (${table.approvedAt} is null) = (${table.confirmation} is null)`,
    ),
  ],
);
