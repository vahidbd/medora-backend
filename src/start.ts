/**
 * The deployed start command (railway.json): apply pending migrations as the
 * owner, then serve as medora_api. The host sends the new release traffic
 * only once /health/ready answers, which is after both, so a failed
 * migration keeps the previous release serving (ADR 0015).
 */
await import('./db/run-migrations.js');
await import('./index.js');
