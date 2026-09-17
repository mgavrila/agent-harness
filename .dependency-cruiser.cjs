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
 * EVERY RULE IS AN ERROR. `pnpm arch` exits 1 on any violation, and `pnpm test` runs it.
 * A new package adds a row to PACKAGES at severity 'error' from the start — the warn-then-
 * promote path existed only for the migration that introduced these layers.
 *
 * HOW A NEW PACKAGE IS ADDED
 * --------------------------
 * Two lines: one PACKAGES row for its layer rules, and one WORKSPACE_DIRS entry so other
 * packages may reach it only through its declared exports. Nothing else here changes. That is
 * how `@harness/shared` and `@harness/pack-api` were added.
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
  { name: 'surface-api', src: 'harness/surface-api/src', severity: 'error' },
  { name: 'identity-api', src: 'harness/identity-api/src', severity: 'error' },
  { name: 'db', src: 'harness/db/src', severity: 'error' },
  { name: 'gateway', src: 'harness/gateway/src', severity: 'error' },
  { name: 'core-tools', src: 'harness/core-tools/src', severity: 'error' },
  { name: 'approvals', src: 'harness/approvals/src', severity: 'error' },
  { name: 'files', src: 'harness/files/src', severity: 'error' },
  { name: 'evals', src: 'evals/src', severity: 'error' },
  { name: 'pack-healthcare', src: 'packs/healthcare/src', severity: 'error' },
  { name: 'pack-stories', src: 'packs/stories/src', severity: 'error' },
  { name: 'surface-slack', src: 'surfaces/slack/src', severity: 'error' },
  { name: 'surface-memory', src: 'surfaces/memory/src', severity: 'error' },
  { name: 'identity-static', src: 'identities/static/src', severity: 'error' },
  { name: 'scripts', src: 'scripts/src', severity: 'error' },
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
  'harness/surface-api',
  'harness/identity-api',
  'harness/db',
  'harness/gateway',
  'harness/core-tools',
  'harness/approvals',
  'harness/files',
  'evals',
  'packs/healthcare',
  'packs/stories',
  'surfaces/slack',
  'surfaces/memory',
  'identities/static',
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
    severity: 'error',
    from: { pathNot: `^${re(dir)}/` },
    to: { path: `^${re(dir)}/`, pathNot: entries.map((entry) => `^${re(entry)}$`) },
  };
}

/** Rules that are not scoped to one package. */
const GLOBAL_RULES = [
  {
    name: 'no-circular',
    comment: 'A cycle means two modules are really one. Split the shared part into a types.ts.',
    severity: 'error',
    from: {},
    to: { circular: true },
  },
  {
    name: 'no-test-imported-by-production',
    comment:
      'A *.test.ts file is never imported by shipping code. Fixtures belong under the package testing.ts subpath.',
    severity: 'error',
    from: { pathNot: '\\.test\\.ts$' },
    to: { path: '\\.test\\.ts$' },
  },
  {
    name: 'core-tools-never-statically-imports-a-pack',
    comment:
      'Packs are loaded at runtime from HARNESS_PACKS through a dynamic import in domain/packs/registry.ts. A static import would wire core to one pack by name, which is the coupling the contract exists to remove. src/testing.ts and *.test.ts build a registry from the healthcare pack directly and are exempt: they are not shipped and they need a registry synchronously.',
    severity: 'error',
    from: {
      path: '^harness/core-tools/src/',
      pathNot: ['\\.test\\.ts$', '^harness/core-tools/src/testing\\.ts$'],
    },
    to: { path: '^packs/[^/]+/', dependencyTypesNot: ['dynamic-import'] },
  },
  {
    name: 'core-tools-never-statically-imports-an-identity-plugin',
    comment:
      'Identity plug-ins are loaded at runtime from HARNESS_IDENTITY through a dynamic import in domain/identity/registry.ts. A static import would wire the kernel to one way of knowing who is asking, which is the coupling the identity contract exists to remove. src/testing.ts and *.test.ts are exempt for the same reason they are for packs.',
    severity: 'error',
    from: {
      path: '^harness/core-tools/src/',
      pathNot: ['\\.test\\.ts$', '^harness/core-tools/src/testing\\.ts$'],
    },
    to: { path: '^identities/[^/]+/', dependencyTypesNot: ['dynamic-import'] },
  },
  {
    name: 'evals-never-statically-imports-a-pack',
    comment:
      'The eval runner measures whichever pack HARNESS_PACKS names, loaded at runtime through loadPacks. A static import would wire it to one pack by name and put an opinion about what it measures back into the runner, which is the coupling this task removed. *.test.ts and *.test-helpers.ts are exempt: a test names a pack as a fixture because there is no other way to run against a real corpus, and neither is shipped.',
    severity: 'error',
    from: {
      path: '^evals/src/',
      pathNot: ['\\.test\\.ts$', '\\.test-helpers\\.ts$'],
    },
    to: { path: '^packs/[^/]+/', dependencyTypesNot: ['dynamic-import'] },
  },
  {
    name: 'the-host-never-statically-imports-a-surface',
    comment:
      'Adapters are loaded at runtime from HARNESS_SURFACES through a dynamic import in domain/surfaces/registry.ts. A static import would wire the approvals host to one messaging transport by name, which is the coupling the surface contract exists to remove. *.test.ts is exempt: a test drives a real adapter on a fake transport because that is the only way to prove the host against the thing that ships, and it is not shipped itself.',
    severity: 'error',
    from: {
      path: '^harness/approvals/src/',
      pathNot: ['\\.test\\.ts$'],
    },
    to: { path: '^surfaces/[^/]+/', dependencyTypesNot: ['dynamic-import'] },
  },
  {
    name: 'no-unresolvable-workspace-import',
    comment:
      'An import the resolver cannot follow matches no other rule in this file, so a deep cross-package import written as a bare specifier (@harness/core-tools/src/domain/x.js) would pass every layer rule in silence. This catches it. Scoped to specifiers starting with `@harness/` or a relative `./` or `../`, deliberately: six third-party specifiers are unresolvable here for reasons that have nothing to do with the architecture (zod/v4, vitest and the @modelcontextprotocol subpaths resolve through export maps depcruise does not follow), and a rule that failed on those would have to be switched off rather than fixed. tsc --noEmit catches these too; this is the gate that says so at the architecture layer.',
    severity: 'error',
    from: {},
    to: { couldNotResolve: true, path: '^(@harness/|[.][.]?/)' },
  },
  {
    name: 'no-orphans',
    comment:
      'A module nothing imports and that is not an entrypoint is dead. Entrypoints, configs and declaration files are exempt.',
    severity: 'error',
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
    to: {
      path: '^(harness|packs|surfaces|identities|evals|scripts)/',
      pathNot: ['^harness/pack-api/src/', '^harness/shared/src/'],
    },
  },
  {
    name: 'surface-api-imports-only-shared',
    comment:
      '@harness/surface-api is the contract an adapter implements. It may import @harness/shared and zod, and no other workspace package: a contract that pulled in @harness/approvals would defeat the point of having one, and one that pulled in @harness/pack-api would tie a messaging adapter to the pack contract. The two id patterns both contracts need live in @harness/shared for exactly that reason.',
    severity: 'error',
    from: { path: '^harness/surface-api/src/' },
    to: {
      path: '^(harness|packs|surfaces|identities|evals|scripts)/',
      pathNot: ['^harness/surface-api/src/', '^harness/shared/src/'],
    },
  },
  {
    name: 'identity-api-imports-only-shared',
    comment:
      '@harness/identity-api is the contract an identity plug-in implements. It may import @harness/shared and zod, and no other workspace package: a contract that pulled in core-tools would defeat the point of having one, and one that pulled in @harness/pack-api would tie identity to the pack contract. The five levels both contracts need live in @harness/shared for exactly that reason.',
    severity: 'error',
    from: { path: '^harness/identity-api/src/' },
    to: {
      path: '^(harness|packs|surfaces|identities|evals|scripts)/',
      pathNot: ['^harness/identity-api/src/', '^harness/shared/src/'],
    },
  },
  {
    name: 'files-imports-only-shared',
    comment:
      '@harness/files parses untrusted documents in a process that holds no key and no database URL. It may import @harness/shared and node built-ins, and no other workspace package: an edge into @harness/db or core-tools would put the key back next to the parser, which is the boundary this package exists to draw.',
    severity: 'error',
    from: { path: '^harness/files/src/' },
    to: {
      path: '^(harness|packs|surfaces|identities|evals|scripts)/',
      pathNot: ['^harness/files/src/', '^harness/shared/src/'],
    },
  },
  {
    name: 'a-pack-never-imports-core-tools',
    comment:
      'A pack depends on @harness/pack-api and @harness/shared only. An edge back into core-tools or @harness/db would be a cycle and would make the pack unloadable by anything else. Its *tests* may reach @harness/core-tools/testing: a test that boots the real kernel against Postgres is not shipped and is not part of the cycle. No pack declares such a dependency today — the five kernel-side healthcare tests live in harness/core-tools/src/app/pack-healthcare — and this exemption is here so the next pack author is not blocked by a false error.',
    severity: 'error',
    from: { path: '^packs/', pathNot: ['\\.test\\.ts$', '\\.test-helpers\\.ts$'] },
    to: {
      path: '^(harness|surfaces|identities|evals|scripts)/',
      pathNot: ['^harness/pack-api/src/', '^harness/shared/src/'],
    },
  },
  {
    name: 'a-surface-imports-only-api-and-shared',
    comment:
      'A messaging adapter depends on @harness/surface-api and @harness/shared only. An edge into @harness/approvals would be a cycle — the host loads the adapter — and an edge into @harness/core-tools, @harness/db or a pack would tie one transport to one area of the product. Its own tests are not exempt: an adapter that needed the kernel to test itself would be an adapter that knows too much.',
    severity: 'error',
    from: { path: '^surfaces/([^/]+)/' },
    to: {
      // `surfaces` is in the alternation so one adapter cannot import another: two transports
      // sharing code is a third package, not an edge. `^surfaces/$1/` is the group captured
      // above, so an adapter still reaches its own modules and only its own.
      path: '^(harness|packs|surfaces|identities|evals|scripts)/',
      pathNot: ['^harness/surface-api/src/', '^harness/shared/src/', '^surfaces/$1/'],
    },
  },
  {
    name: 'an-identity-plugin-imports-only-api-and-shared',
    comment:
      'An identity plug-in depends on @harness/identity-api and @harness/shared only. An edge into core-tools or @harness/db would be a cycle — the kernel loads the plug-in — and an edge into a pack, a surface or another plug-in would tie who-is-asking to one area of the product or one transport. Its own tests are not exempt.',
    severity: 'error',
    from: { path: '^identities/([^/]+)/' },
    to: {
      path: '^(harness|packs|surfaces|identities|evals|scripts)/',
      pathNot: ['^harness/identity-api/src/', '^harness/shared/src/', '^identities/$1/'],
    },
  },
  {
    name: 'shared-has-no-workspace-dependencies',
    comment:
      '@harness/shared is the bottom of the graph. @harness/db and every pack import it, so a dependency on any other workspace package would be a cycle. Node built-ins only.',
    severity: 'error',
    from: { path: '^harness/shared/src/' },
    to: { path: '^(harness|packs|surfaces|identities|evals|scripts)/', pathNot: '^harness/shared/src/' },
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
      dot: {
        // One node per package layer, not per file: the graph answers "may this package import
        // that one", which is the same question the rules above answer. `index.ts` is left
        // uncollapsed everywhere, because it is the node every cross-package arrow should land
        // on. `@harness/shared`, `@harness/pack-api`, `@harness/surface-api` and
        // `@harness/identity-api` are flat — they are one layer each — so they get a pattern of
        // their own, as do the pack's two generator directories.
        collapsePattern: [
          '^(harness|packs|evals|scripts)/[^/]+/(src/)?(shared|domain|tools|app)',
          '^harness/(shared|pack-api|surface-api|identity-api)/src/(?!index[.]ts)',
          '^packs/[^/]+/(synthetic|forms)/',
          '^surfaces/[^/]+/src/(?!index[.]ts)',
          '^identities/[^/]+/src/(?!index[.]ts)',
        ],
      },
    },
  },
};
