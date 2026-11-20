import { readdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { type Definition, definitionProblems, definitionSchema } from './definition.js';

/**
 * Platform protocol templates (ADR 0023, docs/decisions/intake.md INT10):
 * data files in ./templates, reviewed in pull requests, that a tenant copies
 * into a draft of its own and its medical director signs off. Code never
 * branches on a template. A file that doesn't pass the protocol checks stops
 * the API at start-up.
 */

const templateFile = z
  .object({
    key: z.string().regex(/^[a-z0-9-]+$/),
    version: z.number().int().positive(),
    name: z.string().min(1),
    condition: z.string().min(1),
    summary: z.string().min(1),
    /** The medical practitioner who reviewed it for Medora, or null while it is a draft for review. */
    clinicalReview: z.object({ by: z.string().min(1), on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).nullable(),
    definition: definitionSchema,
  })
  .strict();

export interface ProtocolTemplate {
  key: string;
  version: number;
  name: string;
  condition: string;
  summary: string;
  clinicalReview: { by: string; on: string } | null;
  definition: Definition;
}

const folder = new URL('./templates/', import.meta.url);

function load(): Map<string, ProtocolTemplate> {
  const templates = new Map<string, ProtocolTemplate>();
  for (const name of readdirSync(folder).filter((file) => file.endsWith('.json')).sort()) {
    const parsed = templateFile.safeParse(JSON.parse(readFileSync(new URL(name, folder), 'utf8')));
    if (!parsed.success) throw new Error(`Protocol template ${name} is not valid: ${parsed.error.message}`);
    const problems = definitionProblems(parsed.data.definition);
    if (problems.length > 0) throw new Error(`Protocol template ${name} has problems: ${problems.map((p) => `${p.path} ${p.message}`).join('; ')}`);
    templates.set(parsed.data.key, parsed.data);
  }
  return templates;
}

const templates = load();

export function listTemplates(): ProtocolTemplate[] {
  return [...templates.values()];
}

export function findTemplate(key: string): ProtocolTemplate | null {
  return templates.get(key) ?? null;
}
