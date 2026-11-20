/**
 * The commit this build was made from, baked in by scripts/build.mjs so
 * /health can say which commit is live (ADR 0024). Undefined when running
 * from source (development and tests).
 */
declare const __MEDORA_RELEASE_SHA__: string | undefined;

export const builtReleaseSha: string | undefined =
  typeof __MEDORA_RELEASE_SHA__ === 'string' && __MEDORA_RELEASE_SHA__ !== '' ? __MEDORA_RELEASE_SHA__ : undefined;
