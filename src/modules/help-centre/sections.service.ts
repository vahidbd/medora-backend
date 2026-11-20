import { and, asc, count, eq, sql } from 'drizzle-orm';
import { helpCentreArticles, helpCentreSections } from '../../db/schema/index.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { postgresError } from '../../lib/database-errors.js';
import { BusinessRuleError, NotFoundError } from '../../lib/errors.js';
import { getBrand } from '../brands/index.js';
import { assertPublishable } from './rules.js';

/**
 * A brand's help centre sections (docs/decisions/support.md SUP17): the
 * headings articles sit under, in the brand's own order. Navigation, not
 * wording, so they change without approval, but a name is public, so it
 * passes the publish check whenever it is set (SUP16). Every change is audited.
 */

const RECORD = 'operational.help_centre_sections' as const;

export interface SectionView {
  sectionId: string;
  brandId: string;
  name: string;
  position: number;
  articles: number;
}

async function nameTaken<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const pg = postgresError(error);
    if (pg?.code === '23505' && pg.message.includes('help_centre_sections_name_key'))
      throw new BusinessRuleError('This brand already has a section with that name', 'section_name_taken');
    throw error;
  }
}

export async function listSections(tx: TenantTx, brandId?: string): Promise<SectionView[]> {
  const { tenantId } = tx.context;
  const rows = await tx.db
    .select({ section: helpCentreSections, articles: count(helpCentreArticles.id) })
    .from(helpCentreSections)
    .leftJoin(helpCentreArticles, and(eq(helpCentreArticles.tenantId, tenantId), eq(helpCentreArticles.sectionId, helpCentreSections.id)))
    .where(and(eq(helpCentreSections.tenantId, tenantId), brandId ? eq(helpCentreSections.brandId, brandId) : undefined))
    .groupBy(helpCentreSections.id)
    .orderBy(asc(helpCentreSections.brandId), asc(helpCentreSections.position), asc(sql`lower(${helpCentreSections.name})`));
  return rows.map(({ section, articles }) => ({
    sectionId: section.id,
    brandId: section.brandId,
    name: section.name,
    position: section.position,
    articles,
  }));
}

async function sectionView(tx: TenantTx, sectionId: string): Promise<SectionView> {
  const found = (await listSections(tx)).find((section) => section.sectionId === sectionId);
  if (!found) throw new NotFoundError('Section');
  return found;
}

export async function createSection(tx: TenantTx, input: { brandId: string; name: string; position?: number | undefined }): Promise<SectionView> {
  // The brand must be this tenant's: getBrand reads it under the tenant's policy.
  await getBrand(tx, input.brandId);
  assertPublishable([input.name]);
  const [row] = await nameTaken(() =>
    tx.db
      .insert(helpCentreSections)
      .values({ tenantId: tx.context.tenantId, brandId: input.brandId, name: input.name, position: input.position ?? 0 })
      .returning(),
  );
  if (!row) throw new Error('section insert returned nothing');
  await audit(tx, { action: 'help_centre_section.created', zone: 'operational', recordTable: RECORD, recordId: row.id, details: { brandId: row.brandId } });
  return { sectionId: row.id, brandId: row.brandId, name: row.name, position: row.position, articles: 0 };
}

export async function changeSection(tx: TenantTx, sectionId: string, input: { name?: string | undefined; position?: number | undefined }): Promise<SectionView> {
  if (input.name !== undefined) assertPublishable([input.name]);
  const [row] = await nameTaken(() =>
    tx.db
      .update(helpCentreSections)
      .set({ ...(input.name !== undefined ? { name: input.name } : {}), ...(input.position !== undefined ? { position: input.position } : {}), updatedAt: sql`now()` })
      .where(and(eq(helpCentreSections.tenantId, tx.context.tenantId), eq(helpCentreSections.id, sectionId)))
      .returning(),
  );
  if (!row) throw new NotFoundError('Section');
  await audit(tx, {
    action: 'help_centre_section.updated',
    zone: 'operational',
    recordTable: RECORD,
    recordId: row.id,
    details: {
      changed: Object.keys(input)
        .filter((key) => input[key as keyof typeof input] !== undefined)
        .join(','),
    },
  });
  return sectionView(tx, row.id);
}

/** Only an empty section goes: move or remove its articles first. */
export async function deleteSection(tx: TenantTx, sectionId: string): Promise<void> {
  let removed: { id: string }[];
  try {
    removed = await tx.db
      .delete(helpCentreSections)
      .where(and(eq(helpCentreSections.tenantId, tx.context.tenantId), eq(helpCentreSections.id, sectionId)))
      .returning({ id: helpCentreSections.id });
  } catch (error) {
    if (postgresError(error)?.code === '23503') throw new BusinessRuleError("Move this section's articles to another section first", 'section_not_empty');
    throw error;
  }
  if (removed.length === 0) throw new NotFoundError('Section');
  await audit(tx, { action: 'help_centre_section.deleted', zone: 'operational', recordTable: RECORD, recordId: sectionId });
}
