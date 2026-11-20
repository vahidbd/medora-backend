/**
 * Dependency rules (ADRs 0006, 0007, 0027). `npm run boundaries` fails on any
 * of them. There is no baseline: the count is zero and stays zero.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-cycles',
      comment: 'Files may not depend on each other in a loop.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'module-front-door',
      comment: "Another module is reached only through its index.ts (ADR 0027).",
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: { path: '^src/modules/[^/]+/.+', pathNot: ['^src/modules/$1/', '^src/modules/[^/]+/index\\.ts$'] },
    },
    {
      name: 'only-db-and-lib-use-the-pool',
      comment: 'Feature code reaches the database through withTenant in src/db/tenant.ts (ADR 0006).',
      severity: 'error',
      from: { path: '^src/', pathNot: ['^src/db/', '^src/lib/'] },
      to: { path: '^src/db/client\\.ts$' },
    },
    {
      name: 'foundations-import-no-features',
      comment: 'src/lib, src/config and src/db import no module or plugin (ADR 0027).',
      severity: 'error',
      from: { path: '^src/(lib|config|db)/' },
      to: { path: '^src/(modules|plugins)/' },
    },
    {
      name: 'marketing-never-reads-clinical',
      comment: 'Marketing modules may not reach clinical modules or the clinical schema (ADR 0007).',
      severity: 'error',
      from: { path: '^src/modules/marketing-' },
      to: { path: ['^src/modules/clinical-', '^src/db/schema/clinical'] },
    },
    {
      name: 'no-tests-in-src',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^test/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default', 'types'], extensions: ['.ts', '.js', '.mjs', '.cjs'] },
  },
};
