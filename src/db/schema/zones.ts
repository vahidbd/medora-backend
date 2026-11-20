import { pgSchema } from 'drizzle-orm/pg-core';

/** The four data zones are Postgres schemas (ADR 0007). Clinical data never sits outside `clinical`. */
export const clinical = pgSchema('clinical');
export const operational = pgSchema('operational');
export const marketing = pgSchema('marketing');
export const platform = pgSchema('platform');
