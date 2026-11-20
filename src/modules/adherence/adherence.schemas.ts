import { z } from 'zod';

/** Request and reply shapes for adherence (ADR 0014). Field names follow GLOSSARY.md. */

export const appOpenedReply = z.object({
  /** The patient's calendar day it counted for (ADH2). */
  openedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
