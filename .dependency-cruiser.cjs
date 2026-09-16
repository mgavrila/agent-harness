/**
 * Architecture rules for the whole workspace.
 *
 * ESLint owns "which construct may appear in which folder"; this file owns "which folder may
 * import which folder". The layers, in the only direction imports may travel:
 *
 *     shared  ->  domain  ->  tools  ->  app
 *
 *   shared/   pure helpers, no domain knowledge. Imports node built-ins and third-party only.
 *   domain/   one folder per domain: types.ts first, then repository.ts, prompts.ts, render.ts.
 *   tools/    defineTool calls only: validate input, call the domain, shape output.
 *   app/      the composition root and the process entrypoints. May import everything.
 *   index.ts  the only module other packages may import, plus the declared subpath exports.
 *
 * HOW A PACKAGE FLIPS TO ERROR
 * ----------------------------
 * Every rule below starts at the severity its PACKAGES row names. A package task that has
 * finished moving its files changes exactly one word on its own row:
 *
 *     { name: 'db', src: 'harness/db/src', severity: 'warn' },
 *                                                    ^^^^^^ becomes 'error'
 *
 * Nothing else in this file changes. `pnpm arch` then exits 1 on any violation in that
 * package while the others keep reporting warnings and exiting 0. Task 11 flips the last rows.
 *
 * HOW A NEW PACKAGE IS ADDED
 * --------------------------
 * `@harness/shared` and `@harness/pack-api` (spec section 9, landing in Tasks 4 to 8) each
 * need exactly two lines: one PACKAGES row for its layer rules, and one WORKSPACE_DIRS entry
 * so other packages may reach it only through its declared exports. Nothing else here changes.
 *
 * Run it with `pnpm arch`. depcruise needs a GLOB, not a directory: `depcruise harness/db/src`
 * cruises zero modules and reports a cheerful success.
 */

const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

/** @type {{ name: string, src: string, severity: 'warn' | 'error' }[]} */
const PACKAGES = [
  { name: 'shared', src: 'harness/shared/src', severity: 'error' },
  { name: 'pack-api', src: 'harness/pack-api/src', severity: 'error' },
  { name: 'db', src: 'harness/db/src', severity: 'error' },
  { name: 'gateway', src: 'harness/gateway/src', severity: 'error' },
  { name: 'core-tools', src: 'harness/core-tools/src', severity: 'error' },
  { name: 'approvals', src: 'harness/approvals/src', severity: 'warn' },
  { name: 'evals', src: 'evals/src', severity: 'warn' },
];

/** Escape a path so it can sit inside a regular expression. */
const re = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The four upward-import bans, plus "nothing outside app/ imports app/", for one package. */
function layerRules({ name, src, severity }) {
  const at = (folder) => `^${re(src)}/${folder}/`;
  return [
    {
      name: `${name}-shared-imports-only-libraries`,
      comment: `${src}/shared holds pure helpers. It may import node built-ins and third-party packages, and nothing else from this package.`,
      severity,
      from: { path: at('shared') },
      to: { path: `^${re(src)}/(domain|tools|app)/` },
    },
    {
      name: `${name}-domain-does-not-import-tools-or-app`,
      comment: `A domain is called by tools/ and app/; it never calls back into them.`,
      severity,
      from: { path: at('domain') },
      to: { path: `^${re(src)}/(tools|app)/` },
    },
    {
      name: `${name}-tools-do-not-import-app`,
      comment: `tools/ is registered by app/, not the other way round.`,
      severity,
      from: { path: at('tools') },
      to: { path: at('app') },
    },
    {
      name: `${name}-public-api-does-not-import-app`,
      comment: `index.ts is what other packages import. Pulling app/ in would drag the composition root, dotenv and the process entrypoints into every consumer.`,
      severity,
      from: { path: `^${re(src)}/index\\.ts$` },
      to: { path: at('app') },
    },
    {
      name: `${name}-nothing-imports-app-but-app`,
      comment: `Only app/ imports app/. Its own tests are the one exception.`,
      severity,
      from: { path: `^${re(src)}/`, pathNot: [at('app'), '\\.test\\.ts$'] },
      to: { path: at('app') },
    },
  ];
}

/** Every workspace package directory, in the order pnpm-workspace.yaml lists them. */
const WORKSPACE_DIRS = [
  'harness/shared',
  'harness/pack-api',
  'harness/db',
  'harness/gateway',
  'harness/core-tools',
  'harness/approvals',
  'evals',
  'packs/healthcare',
  'scripts',
];

/**
 * The files a package's `package.json#exports` map points at, relative to the repository root.
 * Reading the map rather than hard-coding a list is what keeps this rule correct for free: a
 * task that adds or removes a subpath export changes what is reachable, and nothing here has
 * to be edited to match.
 */
function publicEntries(dir) {
  const manifest = path.join(dir, 'package.json');
  if (!existsSync(manifest)) return [];
  const map = JSON.parse(readFileSync(manifest, 'utf8')).exports ?? {};
  return Object.values(map)
    .filter((target) => typeof target === 'string')
    .map((target) => path.posix.join(dir, target.replace(/^\.\//, '')));
}

/** One package may reach another only at a path that package's exports map names. */
function crossPackageRule(dir) {
  const entries = publicEntries(dir);
  return {
    name: `only-public-entry-of-${dir.replace(/\//g, '-')}`,
    comment: `Reach ${dir} through its package name or one of its declared subpath exports (${entries.join(', ') || 'none'}), never by a path into its source tree.`,
    severity: 'warn',
    from: { pathNot: `^${re(dir)}/` },
    to: { path: `^${re(dir)}/`, pathNot: entries.map((entry) => `^${re(entry)}$`) },
  };
}

/** Rules that are not scoped to one package. */
const GLOBAL_RULES = [
  {
    name: 'no-circular',
    comment:
      'A cycle means two modules are really one. Warn until Task 11 of the maintainability plan promotes the packages that have not been restructured yet.',
    severity: 'warn',
    from: {},
    to: { circular: true },
  },
  {
    name: 'no-test-imported-by-production',
    comment:
      'A *.test.ts file is never imported by shipping code. Fixtures belong under the package testing.ts subpath.',
    severity: 'warn',
    from: { pathNot: '\\.test\\.ts$' },
    to: { path: '\\.test\\.ts$' },
  },
  {
    name: 'core-tools-never-statically-imports-a-pack',
    comment:
      'Packs are loaded at runtime from HARNESS_PACKS through a dynamic import in domain/packs/registry.ts. A static import would wire core to one pack by name, which is the coupling the contract exists to remove. src/testing.ts and *.test.ts build a registry from the healthcare pack directly and are exempt: they are not shipped and they need a registry synchronously.',
    severity: 'warn',
    from: {
      path: '^harness/core-tools/src/',
      pathNot: ['\\.test\\.ts$', '^harness/core-tools/src/testing\\.ts$'],
    },
    to: { path: '^packs/[^/]+/', dependencyTypesNot: ['dynamic-import'] },
  },
  {
    name: 'no-orphans',
    comment:
      'A module nothing imports and that is not an entrypoint is dead. Entrypoints, configs and declaration files are exempt.',
    severity: 'warn',
    from: {
      orphan: true,
      pathNot: [
        '\\.d\\.ts$',
        '(^|/)[.][^/]+\\.(js|cjs|mjs|ts)$',
        '(^|/)(vitest|drizzle|eslint)\\.config\\.(js|cjs|mjs|ts)$',
        '(^|/)test-global-setup\\.ts$',
        '(^|/)(main|cli|migrate|record-surface|generate-templates|render-config)\\.ts$',
      ],
    },
    to: {},
  },
  {
    name: 'pack-api-imports-only-shared',
    comment:
      '@harness/pack-api is the contract a pack implements. It may import @harness/shared and zod, and no other workspace package: a contract that pulled in core-tools would defeat the point of having one.',
    severity: 'error',
    from: { path: '^harness/pack-api/src/' },
    to: { path: '^(harness|packs|evals|scripts)/', pathNot: ['^harness/pack-api/src/', '^harness/shared/src/'] },
  },
  {
    name: 'a-pack-never-imports-core-tools',
    comment:
      'A pack depends on @harness/pack-api and @harness/shared only. An edge back into core-tools would be a cycle and would make the pack unloadable by anything else.',
    severity: 'error',
    from: { path: '^packs/' },
    to: { path: '^(harness|evals|scripts)/', pathNot: ['^harness/pack-api/src/', '^harness/shared/src/'] },
  },
  {
    name: 'shared-has-no-workspace-dependencies',
    comment:
      '@harness/shared is the bottom of the graph. @harness/db and every pack import it, so a dependency on any other workspace package would be a cycle. Node built-ins only.',
    severity: 'error',
    from: { path: '^harness/shared/src/' },
    to: { path: '^(harness|packs|evals|scripts)/', pathNot: '^harness/shared/src/' },
  },
  ...WORKSPACE_DIRS.map(crossPackageRule),
];

module.exports = {
  forbidden: [...PACKAGES.flatMap(layerRules), ...GLOBAL_RULES],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)node_modules/|(^|/)drizzle/|(^|/)out/|(^|/)results/' },
    tsPreCompilationDeps: true,
    // Without this, depcruise resolves .js/.json only and every .ts import is "unresolvable".
    // `exportsFields` is off by default in dependency-cruiser's resolver; every
    // workspace manifest here declares `exports` and no `main`, so without it a
    // bare specifier such as `@harness/shared` is "unresolvable" and the
    // cross-package rules never fire. With it, they resolve to the source entry.
    enhancedResolveOptions: { extensions: ['.ts', '.js', '.json'], exportsFields: ['exports'] },
    reporterOptions: {
      dot: { collapsePattern: '^(harness|packs|evals|scripts)/[^/]+/(src/)?(shared|domain|tools|app)(/[^/]+)?' },
    },
  },
};
