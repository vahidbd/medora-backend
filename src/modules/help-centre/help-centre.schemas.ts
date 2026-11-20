import { z } from 'zod';
import { ARTICLE_STATUSES, SERVICE_ONLY_CONFIRMATION, wordingProblems } from './rules.js';

const instant = z.string();
const text = (max: number) => z.string().trim().min(1).max(max);
/** Markdown the help centre can show (SUP16): refused here, so a draft never holds it. */
const markdown = (max: number) =>
  text(max).superRefine((value, context) => {
    for (const message of wordingProblems(value)) context.addIssue({ code: 'custom', message });
  });
const slug = z
  .string()
  .trim()
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lower-case letters, numbers and hyphens, like how-delivery-works');
const position = z.number().int().min(0).max(10_000);

export const sectionParams = z.object({ sectionId: z.uuid() });
export const articleParams = z.object({ articleId: z.uuid() });
export const brandQuery = z.object({ brandId: z.uuid().optional() });

export const sectionBody = z.object({ brandId: z.uuid(), name: text(80), position: position.optional() }).strict();
export const sectionChangeBody = z
  .object({ name: text(80).optional(), position: position.optional() })
  .strict()
  .refine((body) => body.name !== undefined || body.position !== undefined, 'Change the name or the position');
export const sectionView = z.object({ sectionId: z.uuid(), brandId: z.uuid(), name: z.string(), position: z.number().int(), articles: z.number().int() });
export const sectionListReply = z.object({ sections: z.array(sectionView) });
export const deletedReply = z.object({ deleted: z.literal(true) });

export const wordingBody = z.object({ title: markdown(160), summary: markdown(300), body: markdown(20_000) }).strict();
export const articleBody = z
  .object({ brandId: z.uuid(), sectionId: z.uuid(), slug, position: position.optional(), title: markdown(160), summary: markdown(300), body: markdown(20_000) })
  .strict();
export const articleChangeBody = z
  .object({ sectionId: z.uuid().optional(), slug: slug.optional(), position: position.optional() })
  .strict()
  .refine((body) => Object.values(body).some((value) => value !== undefined), 'Change the section, the address or the position');
export const approveBody = z
  .object({
    /** The draft the approver read: every save makes a new one, so newer wording is never approved unseen. */
    versionId: z.uuid(),
    /** The approver confirms the article is service only (SUP18). */
    confirm: z.literal(SERVICE_ONLY_CONFIRMATION),
  })
  .strict();

const versionSummary = z.object({ versionId: z.uuid(), title: z.string(), writtenByUserId: z.uuid(), updatedAt: instant });
const approvedSummary = versionSummary.extend({ approvedByUserId: z.uuid(), approvedAt: instant });
export const articleListItem = z.object({
  articleId: z.uuid(),
  brandId: z.uuid(),
  sectionId: z.uuid(),
  slug: z.string(),
  position: z.number().int(),
  status: z.enum(ARTICLE_STATUSES),
  publishedAt: instant.nullable(),
  live: approvedSummary.nullable(),
  draft: versionSummary.nullable(),
});
export const articleListReply = z.object({ articles: z.array(articleListItem) });

const fullVersion = versionSummary.extend({
  summary: z.string(),
  body: z.string(),
  approvedByUserId: z.uuid().nullable(),
  approvedAt: instant.nullable(),
  checkedWith: z.string().nullable(),
  confirmation: z.string().nullable(),
});
export const articleReply = articleListItem.extend({
  live: fullVersion.nullable(),
  draft: fullVersion.nullable(),
  /** Every approved wording, newest first: the archive of what was public (SUP15). */
  history: z.array(approvedSummary),
});
export const discardedReply = z.object({ discarded: z.literal(true), articleRemoved: z.boolean() });

// The support agent's tool (SUP19).
export const searchQuery = z.object({ q: text(200), brandId: z.uuid().optional() });
export const searchReply = z.object({
  articles: z.array(
    z.object({
      articleId: z.uuid(),
      versionId: z.uuid(),
      brandId: z.uuid(),
      brandName: z.string(),
      slug: z.string(),
      title: z.string(),
      summary: z.string(),
      body: z.string(),
    }),
  ),
});

// The public pages (SUP17), by the host the brand's site is served on.
export const hostParams = z.object({ host: z.string().trim().min(1).max(253) });
export const publicArticleParams = hostParams.extend({ slug: z.string().trim().min(1).max(80) });
export const publicSearchQuery = z.object({ q: text(200) });
const publicArticleSummary = z.object({ slug: z.string(), title: z.string(), summary: z.string() });
export const publicHelpCentreReply = z.object({
  brandName: z.string(),
  sections: z.array(z.object({ name: z.string(), articles: z.array(publicArticleSummary) })),
});
export const publicSearchReply = z.object({ articles: z.array(publicArticleSummary.extend({ section: z.string() })) });
/** `approvedAt`: when this wording was approved, the page's last change. */
export const publicArticleReply = publicArticleSummary.extend({ section: z.string(), body: z.string(), approvedAt: instant });
