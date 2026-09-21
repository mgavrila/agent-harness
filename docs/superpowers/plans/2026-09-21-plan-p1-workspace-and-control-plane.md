# P1 — the workspace, the control plane and the catalogue: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the hf1 platform's first vertical slice: a catalogue of two blueprints, a control plane with Google sign-in, organisations, agents, drafts, releases into the kernel's document store, secrets, knowledge and connections, a Next.js workspace on top, and the Compose stack that runs it all beside one pooled kernel host — so any person can create an agent from a blueprint, release it and talk to it with no engineer and no deploy step.

**Architecture:** Three packages with one-way imports (`@hf1/catalog` ← `@hf1/control-plane` ← `@hf1/workspace`), all consuming the kernel's published contracts and never its internals. The control plane is a Hono API over two Postgres databases: its own (`hf1_platform`, drizzle) and the kernel's, where it writes only the three tables the kernel documents as a stable write contract. The workspace is a client of the control plane over HTTP. The kernel host is pooled and learns about tenants from rows, never from its environment.

**Tech Stack:** Node ≥ 22, pnpm 11.4.0, TypeScript 7 per package (root `typescript@6.0.3` for typescript-eslint), ESM, zod v4 (`import * as z from 'zod/v4'`), vitest 5, drizzle-orm 0.45 + `drizzle-kit generate`, `pg`, Hono + `@hono/node-server` + `@hono/zod-validator`, `openid-client` v6, `jose` (tests only), `rfc6902`, `yaml`, Next.js App Router + Tailwind, Playwright, ESLint 9 + Prettier + dependency-cruiser, Docker Compose + Caddy.

**Spec:** `docs/superpowers/specs/2026-09-21-p1-workspace-and-control-plane-design.md` — every task cites the section it implements. Read §2 (decisions), §3 (architecture), §4 (contracts) before Task 1.

## Global Constraints

- **Zero changes in `agent-harness`.** Anything the kernel must change goes as one line into `~/Downloads/hf1/kernel-followups-from-platform.md`; never a workaround here.
- **One-way dependencies** `gateway ◄ os ◄ agents ◄ platform`: `catalog/` imports `@harness/config-api`, `@harness/identity-api`, `@harness/pack-api`, `@harness/surface-api`, `@harness/shared` only; `control-plane/` imports `@hf1/catalog` and the same contracts; `apps/workspace/` imports `@hf1/control-plane/client` only. Enforced by dependency-cruiser at error severity from Task 1.
- **No backwards compatibility, no dual paths.** Only the v0.3.0 document shape is coded: `surfaces.web: { token: { ref } }`, secrets as `{ ref }`, never `{ env }`, never a memory surface in a production document.
- **The kernel is consumed by version.** `kernel.lock` names the tag and commit; `pnpm kernel:check` asserts it. Links to `../agent-harness/harness/<pkg>` (or the 11c worktree the kernel session names) until the tag exists; release tarballs `https://github.com/mgavrila/agent-harness/releases/download/v<tag>/harness-<pkg>-<tag>.tgz` and image `ghcr.io/mgavrila/agent-harness-host:<tag>` after. Never copy kernel code.
- **Tenant names live in data only.** No file under `catalog/` or `control-plane/src/domain` names a tenant, an organisation or a person (a test asserts it in Task 5).
- **Product names** in every document and page: hf1 OS (workspace, control plane, catalogue), hf1 Agents (blueprints, runs), hf1 AI Gateway (routing, budgets).
- **Conventions:** exact versions in every `package.json` (no `^` on kernel packages, `^` allowed on third-party as the kernel does), every package has `test` and `typecheck` scripts, `vitest run`, four gates green (`pnpm typecheck`, `pnpm lint` 0 errors, `pnpm arch` 0 violations, `pnpm format:check`) and `pnpm test` green at the end of **every** task. Layers inside a package: `src/shared → src/domain → src/app`; `src/index.ts` and declared subpath exports are the only cross-package entries; `src/testing/` may import anything and is never imported by shipping code.
- **Git:** repo-local `user.email andrei.gavrila94@gmail.com`, SSH-signed, conventional commits, imperative mood, **no AI trailer of any kind**. One implementer at a time in one worktree.
- **Secrets never in code, logs, API responses or audit rows** (spec invariant P-3). Every environment variable the stack reads appears in `deploy/compose/.env.example`.
- **Every environment read** happens in `src/shared/env.ts` (control plane) or `next.config.ts`/server-only modules (workspace); ESLint bans `process.env` elsewhere.

---

## File map (what exists at the end)

```
hf1-platform/
  package.json  pnpm-workspace.yaml  tsconfig.base.json  eslint.config.js  .prettierrc  .prettierignore
  .dependency-cruiser.cjs  .gitignore  kernel.lock  scripts/kernel-check.mjs  README.md  ARCHITECTURE.md
  .github/workflows/ci.yml
  docs/superpowers/specs/…  docs/superpowers/plans/…  docs/runbook.md

  catalog/                                   @hf1/catalog
    package.json  tsconfig.json  vitest.config.ts
    blueprints/internal-team-assistant/      blueprint.yaml catalog.yaml persona.md CHANGELOG.md knowledge/
    blueprints/credentialing-assistant/      blueprint.yaml catalog.yaml persona.md CHANGELOG.md knowledge/
    src/index.ts                             public API
    src/shared/include.ts                    !include reader, confined to the blueprint directory
    src/shared/pointer.ts                    JSON pointer get/set/exists, lock-set overlap
    src/domain/catalog/types.ts              CatalogMeta, LoadedBlueprint, Catalog, BlueprintInput
    src/domain/catalog/meta.ts               catalog.yaml schema
    src/domain/catalog/load.ts               loadCatalog(dir)
    src/domain/catalog/validate.ts           validateBlueprint(loaded)
    src/domain/catalog/schema.ts             documentSchema(), sectionSchema(name)
    src/domain/catalog/additions.ts          platformAdditions(document, ctx), applyInputs(document, values)
    src/domain/catalog/overlay.ts            overlayFor(blueprintDocument, draft), refuseLocked(lockset, patch)
    src/testing.ts                           fixture blueprint directory builder
    src/**/*.test.ts

  control-plane/                             @hf1/control-plane
    package.json  tsconfig.json  vitest.config.ts  drizzle.config.ts  drizzle/  (generated migrations)
    src/index.ts                             createApp(deps) + types
    src/client.ts                            hc factory + AppType (the workspace's only import)
    src/shared/env.ts                        Env schema, loadEnv()
    src/shared/errors.ts                     ApiError(code, status, message, pointer?)
    src/shared/crypto.ts                     kernel envelope: seal/open (AES-256-GCM), randomToken()
    src/shared/canonical.ts                  canonicalJson(), contentVersion()
    src/shared/ids.ts                        slug + client id rules
    src/domain/db/schema.ts                  hf1_platform tables (spec §6)
    src/domain/db/connect.ts                 connect(url) → Db; withTransaction
    src/domain/db/migrate.ts                 runMigrations(url)
    src/domain/users/{types,repository,service}.ts
    src/domain/organisations/{types,repository,service}.ts
    src/domain/audit/{types,repository}.ts
    src/domain/catalog/service.ts            the loaded catalogue, read-only
    src/domain/agents/{types,repository,service}.ts
    src/domain/releases/{types,repository,service}.ts
    src/domain/secrets/{types,repository,service}.ts
    src/domain/knowledge/{types,store,service}.ts
    src/domain/connections/{types,slack-manifest,service}.ts
    src/domain/chat/service.ts
    src/domain/kernel/tables.ts              the three contract tables (spec §4.3), drizzle definitions
    src/domain/kernel/documents.ts           writeDocumentRelease(kernelDb, …)
    src/domain/kernel/run-api.ts             RunApiClient (status, usage, runs)
    src/domain/kernel/web-surface.ts         WebSurfaceClient (message, stream, action, form)
    src/app/server.ts                        createApp(deps): Hono
    src/app/main.ts                          process entry: env → deps → serve
    src/app/auth/oidc.ts                     Google OIDC (openid-client)
    src/app/middleware/{session,org}.ts      requireUser, requireOrg(role)
    src/app/routes/{auth,orgs,blueprints,agents,knowledge,connections,chat,admin}.ts
    src/testing/db.ts                        TEST_DATABASE_URL, scratch schema per suite, kernel DDL
    src/testing/kernel-ddl.sql               test-only DDL of the three contract tables
    src/testing/fake-issuer.ts               an in-process OIDC provider (jose)
    src/testing/fake-host.ts                 an in-process kernel host: run API + web surface
    src/testing/app.ts                       testApp(): app + db + fakes + signIn(user)
    src/**/*.test.ts

  apps/workspace/                            @hf1/workspace (Next.js)
    package.json  next.config.ts  tsconfig.json  postcss.config.mjs  app/globals.css
    lib/api.ts                               server-side client (cookie forwarded), browser client
    lib/session.ts                           me() for layouts
    app/layout.tsx  app/page.tsx  app/login/page.tsx  app/orgs/new/page.tsx
    app/o/[org]/layout.tsx  page.tsx  settings/page.tsx
    app/o/[org]/agents/new/page.tsx
    app/o/[org]/agents/[agent]/layout.tsx  page.tsx  (persona|people|policy|models|playbooks|skills|
                                             knowledge|connections|releases|chat|inbox|usage)/page.tsx
    app/admin/page.tsx
    components/…                             owned components: Field, LockedNotice, Tabs, Card, …
    e2e/onboarding.spec.ts                   Playwright

  deploy/compose/
    docker-compose.yml  Caddyfile  postgres/init.sql  litellm.config.yaml  .env.example
    control-plane.Dockerfile  workspace.Dockerfile
```

## Task order and the checkpoint

Tasks 1–4 catalogue, 5–15 control plane, 16–22 workspace, 23–26 deployment, CI, end-to-end and docs. The kernel's Plan 11c schema (web surface + `{ ref }`) is required from Task 2; the kernel session was asked to land it as 11c's first commit, and Task 2 links to that worktree. The **v0.3.0 image** is required only by Task 24's Compose smoke job and Task 25's chat step; both are written now and gated on the tag in CI.

**Amendment 2026-09-21 (Task T, transplant):** Tasks 1, 2 and 5's manifests (the `kernel.lock` /
`pnpm kernel:check` pin, and every `link:` dependency) were re-cut into `workspace:*` when `catalog/`
and `control-plane/` moved into the `agent-harness` monorepo. Tasks 23 and 24 build from the
monorepo root, not from a `hf1-platform` checkout beside a linked or tarball kernel. Task T left
`pnpm-workspace.yaml`'s `apps/*` entry and the `arch`/`arch:graph` scripts' three
`apps/workspace/{app,lib,components}` globs out, deferred to **Task 16**: dependency-cruiser and
the kernel's own workspace-manifest test both `readdir` a glob's static prefix before matching, so
a glob naming a directory that does not exist yet crashes rather than matching zero files. Task 16
adds all four lines back when it creates `apps/workspace`. The dependency-cruiser rule
`workspace-imports-only-the-control-plane-client` is already in place from Task T (it does not
`readdir` anything — it only matches gathered files — so it is harmless ahead of Task 16).

---

### Task 1: Repository scaffold, gates and the kernel pin

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc`, `.prettierignore`, `.dependency-cruiser.cjs`, `.gitignore`, `kernel.lock`, `scripts/kernel-check.mjs`, `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- Produces: the root scripts every later task runs (`pnpm typecheck | lint | arch | format:check | test | kernel:check`), the dependency-cruiser `PACKAGES`/`WORKSPACE_DIRS` tables later tasks add rows to, and `kernel.lock`.

- [ ] **Step 1: Root manifests**

`package.json`:

```json
{
  "name": "hf1-platform",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.4.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "arch": "depcruise 'catalog/src/**/*.ts' 'control-plane/src/**/*.ts' 'apps/workspace/app/**/*.{ts,tsx}' 'apps/workspace/lib/**/*.ts' 'apps/workspace/components/**/*.tsx'",
    "typecheck": "pnpm -r --if-present typecheck",
    "test": "pnpm lint && pnpm arch && pnpm -r --if-present test",
    "kernel:check": "node scripts/kernel-check.mjs",
    "platform:up": "docker compose --env-file deploy/compose/.env -f deploy/compose/docker-compose.yml up -d",
    "platform:down": "docker compose --env-file deploy/compose/.env -f deploy/compose/docker-compose.yml down",
    "platform:logs": "docker compose --env-file deploy/compose/.env -f deploy/compose/docker-compose.yml logs -f",
    "db:up": "docker compose --env-file deploy/compose/.env -f deploy/compose/docker-compose.yml up -d postgres"
  },
  "devDependencies": {
    "@eslint/js": "9.39.5",
    "dependency-cruiser": "16.10.4",
    "eslint": "9.39.5",
    "eslint-config-prettier": "10.1.8",
    "eslint-import-resolver-typescript": "4.4.5",
    "eslint-plugin-import-x": "4.17.1",
    "eslint-plugin-unused-imports": "4.4.1",
    "globals": "17.12.0",
    "prettier": "3.9.7",
    "typescript": "6.0.3",
    "typescript-eslint": "8.70.0"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - 'catalog'
  - 'control-plane'
  - 'apps/*'
allowBuilds:
  esbuild: true
  unrs-resolver: true
  sharp: true
minimumReleaseAgeExclude:
  - prettier@3.9.7
```

`tsconfig.base.json` — the kernel's, verbatim in content:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "types": ["node"],
    "noEmit": true
  }
}
```

`.prettierrc`: `{ "singleQuote": true, "printWidth": 110, "trailingComma": "all" }`. `.prettierignore`: `pnpm-lock.yaml`, `**/drizzle/**`, `**/.next/**`, `**/dist/**`, `docs/superpowers/**`.

`.gitignore`:

```
node_modules/
dist/
.next/
coverage/
*.tsbuildinfo
deploy/compose/.env
.env
.env.*
!deploy/compose/.env.example
apps/workspace/test-results/
apps/workspace/playwright-report/
```

- [ ] **Step 2: ESLint**

`eslint.config.js` (flat config; the rules the kernel uses, with the `process.env` ban):

```js
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/drizzle/**', 'docs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
    plugins: { 'import-x': importX, 'unused-imports': unusedImports },
    settings: { 'import-x/resolver': { typescript: true } },
    rules: {
      'unused-imports/no-unused-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      'import-x/no-cycle': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.object.name='process'][object.property.name='env']",
          message: 'Read the environment in src/shared/env.ts (control plane) or a server-only config module (workspace), nowhere else.',
        },
      ],
    },
  },
  {
    files: ['**/src/shared/env.ts', '**/*.test.ts', '**/src/testing/**', 'apps/workspace/next.config.ts', 'scripts/**', '**/vitest.config.ts', '**/drizzle.config.ts', '**/playwright.config.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  { files: ['**/*.js', '**/*.mjs', '**/*.cjs'], ...tseslint.configs.disableTypeChecked },
  prettier,
);
```

- [ ] **Step 3: dependency-cruiser with the platform's rules**

`.dependency-cruiser.cjs`:

```js
/**
 * Architecture rules. ESLint owns "which construct in which folder"; this file owns "which folder
 * may import which folder". Layers inside a package, imports travel one way only:
 *
 *     shared  ->  domain  ->  app        (testing/ may import anything; nothing imports testing/)
 *
 * Across packages, the platform's one-way rule (spec §3.1):
 *
 *     @harness/* contracts  <-  catalog  <-  control-plane  <-  workspace
 *
 * EVERY RULE IS AN ERROR. `pnpm arch` exits 1 on any violation, and `pnpm test` runs it.
 */
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const PACKAGES = [
  { name: 'catalog', src: 'catalog/src' },
  { name: 'control-plane', src: 'control-plane/src' },
];

const WORKSPACE_DIRS = ['catalog', 'control-plane'];

const KERNEL_CONTRACTS = ['config-api', 'identity-api', 'pack-api', 'surface-api', 'shared'];

const re = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function layerRules({ name, src }) {
  const at = (folder) => `^${re(src)}/${folder}/`;
  return [
    {
      name: `${name}-shared-imports-only-libraries`,
      severity: 'error',
      from: { path: at('shared') },
      to: { path: `^${re(src)}/(domain|app|testing)/` },
    },
    {
      name: `${name}-domain-does-not-import-app-or-testing`,
      severity: 'error',
      from: { path: at('domain') },
      to: { path: `^${re(src)}/(app|testing)/` },
    },
    {
      name: `${name}-nothing-imports-testing-but-tests`,
      severity: 'error',
      from: { path: `^${re(src)}/`, pathNot: [at('testing'), '\\.test\\.ts$'] },
      to: { path: at('testing') },
    },
    {
      name: `${name}-public-api-does-not-import-app`,
      comment: 'index.ts and client.ts are what other packages import. A runtime edge into app/ would drag the composition root into every consumer; client.ts may import the app TYPE (hono/client needs it) and nothing else.',
      severity: 'error',
      from: { path: `^${re(src)}/(index|client)\\.ts$` },
      to: { path: at('app'), dependencyTypesNot: ['type-only'] },
    },
  ];
}

function publicEntries(dir) {
  const manifest = path.join(dir, 'package.json');
  if (!existsSync(manifest)) return [];
  const map = JSON.parse(readFileSync(manifest, 'utf8')).exports ?? {};
  return Object.values(map)
    .filter((t) => typeof t === 'string')
    .map((t) => path.posix.join(dir, t.replace(/^\.\//, '')));
}

function crossPackageRule(dir) {
  const entries = publicEntries(dir);
  return {
    name: `only-public-entry-of-${dir.replace(/\//g, '-')}`,
    severity: 'error',
    from: { pathNot: `^${re(dir)}/` },
    to: { path: `^${re(dir)}/`, pathNot: entries.map((e) => `^${re(e)}$`) },
  };
}

const kernelNonContract = `^node_modules/@harness/(?!(${KERNEL_CONTRACTS.join('|')})(/|$))`;

const GLOBAL_RULES = [
  { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
  {
    name: 'no-test-imported-by-production',
    severity: 'error',
    from: { pathNot: '\\.test\\.ts$' },
    to: { path: '\\.test\\.ts$' },
  },
  {
    name: 'catalog-imports-kernel-contracts-only',
    comment: 'catalog/ is the hf1 Agents band: it implements kernel contracts and knows no tenant, no database, no HTTP.',
    severity: 'error',
    from: { path: '^catalog/src/' },
    to: { path: '^(control-plane|apps)/' },
  },
  {
    name: 'no-kernel-internals-anywhere',
    comment: 'Only the five published contract packages may be imported; the kernel is consumed by version, never by reaching into an unpublished package.',
    severity: 'error',
    from: { path: '^(catalog|control-plane|apps)/' },
    to: { path: kernelNonContract },
  },
  {
    name: 'control-plane-does-not-import-the-workspace',
    severity: 'error',
    from: { path: '^control-plane/src/' },
    to: { path: '^apps/' },
  },
  {
    name: 'workspace-imports-only-the-control-plane-client',
    comment: 'The workspace is a client of the control plane over HTTP. Its one compile-time edge into this repository is the typed client entry.',
    severity: 'error',
    from: { path: '^apps/workspace/' },
    to: { path: '^(catalog|control-plane)/', pathNot: ['^control-plane/src/client\\.ts$'] },
  },
  {
    name: 'workspace-never-imports-a-kernel-package',
    severity: 'error',
    from: { path: '^apps/workspace/' },
    to: { path: '^node_modules/@harness/' },
  },
  {
    name: 'no-unresolvable-workspace-import',
    severity: 'error',
    from: {},
    to: { couldNotResolve: true, path: '^(@hf1/|@harness/|[.][.]?/)' },
  },
  {
    name: 'no-orphans',
    severity: 'error',
    from: {
      orphan: true,
      pathNot: [
        '\\.d\\.ts$',
        '(^|/)[.][^/]+\\.(js|cjs|mjs|ts)$',
        '(^|/)(vitest|drizzle|eslint|next|playwright|postcss)\\.config\\.(js|cjs|mjs|ts)$',
        '(^|/)(main|migrate)\\.ts$',
        '^apps/workspace/app/',
      ],
    },
    to: {},
  },
];

module.exports = {
  forbidden: [...GLOBAL_RULES, ...PACKAGES.flatMap(layerRules), ...WORKSPACE_DIRS.map(crossPackageRule)],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'default', 'types'] },
  },
};
```

- [ ] **Step 4: `kernel.lock` and `scripts/kernel-check.mjs`**

`kernel.lock` (YAML, the only file that names a kernel version):

```yaml
# The kernel this repository is written against. `pnpm kernel:check` asserts the installed
# @harness/* packages match it. `source: link` means package.json links to a checkout on this
# machine and `commit` is what that checkout must be at; `source: release` means release tarballs
# and `version` is the tag. Change this file in one commit with the package.json edits it implies.
version: 0.3.0-dev
commit: REPLACED-IN-TASK-2
source: link
packages: [config-api, identity-api, pack-api, surface-api, shared]
```

`scripts/kernel-check.mjs`:

```js
#!/usr/bin/env node
// Assert the installed kernel packages are the ones kernel.lock names. See kernel.lock.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const lock = parse(readFileSync(path.join(root, 'kernel.lock'), 'utf8'));
const failures = [];
for (const pkg of lock.packages) {
  const dir = realpathSync(path.join(root, 'catalog/node_modules/@harness', pkg));
  if (lock.source === 'link') {
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (head !== lock.commit) failures.push(`@harness/${pkg}: linked checkout is at ${head}, kernel.lock says ${lock.commit}`);
  } else {
    const { version } = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (version !== lock.version) failures.push(`@harness/${pkg}: installed ${version}, kernel.lock says ${lock.version}`);
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`kernel ${lock.version} (${lock.source}) — ${lock.packages.length} packages match kernel.lock`);
```

Add `"yaml": "2.8.2"` to root devDependencies for the script.

- [ ] **Step 5: CI workflow**

`.github/workflows/ci.yml`:

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  gates:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:0.8.1-pg16
        env: { POSTGRES_USER: hf1, POSTGRES_PASSWORD: hf1, POSTGRES_DB: hf1_platform_test }
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U hf1" --health-interval 5s --health-timeout 3s --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 11.4.0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm kernel:check
      - run: pnpm typecheck
      - run: pnpm lint --max-warnings=0
      - run: pnpm arch
      - run: pnpm format:check
      - run: pnpm -r --if-present test
        env:
          TEST_DATABASE_URL: postgres://hf1:hf1@localhost:5432/hf1_platform_test
```

(While `kernel.lock` says `source: link`, CI cannot resolve a link to a sibling checkout; the `gates` job checks out `mgavrila/agent-harness` at `kernel.lock`'s commit into `../agent-harness` with a second `actions/checkout` step — `with: { repository: mgavrila/agent-harness, ref: <commit>, path: ../agent-harness }` — and runs `pnpm install` there first. Task 24 replaces this with tarballs when the tag exists.)

- [ ] **Step 6: README**

`README.md`, twenty lines: what the platform is (the deck's three products, the boundary with the kernel), the three packages, how to run the gates, where the spec is.

- [ ] **Step 7: Install and run the gates on the empty workspace**

Run: `pnpm install && pnpm typecheck && pnpm lint && pnpm arch && pnpm format:check`
Expected: all green; `pnpm arch` cruises zero modules and exits 0 (there is nothing yet).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold the workspace with the gates, the architecture rules and the kernel pin"
```

---

### Task 2: `@hf1/catalog` — loading a blueprint directory

**Files:**
- Create: `catalog/package.json`, `catalog/tsconfig.json`, `catalog/vitest.config.ts`, `catalog/src/index.ts`, `catalog/src/shared/include.ts`, `catalog/src/shared/pointer.ts`, `catalog/src/domain/catalog/types.ts`, `catalog/src/domain/catalog/meta.ts`, `catalog/src/domain/catalog/load.ts`, `catalog/src/testing.ts`
- Test: `catalog/src/shared/include.test.ts`, `catalog/src/shared/pointer.test.ts`, `catalog/src/domain/catalog/load.test.ts`
- Modify: `kernel.lock` (the commit), `.dependency-cruiser.cjs` (no change needed: `catalog` row exists)

**Interfaces:**
- Consumes: `@harness/config-api` (`Blueprint`, `BlueprintShape`), `@harness/shared` (`ConfigError`).
- Produces: `loadCatalog(dir): Promise<Catalog>`, `Catalog { list(): LoadedBlueprint[]; get(name): LoadedBlueprint }`, `LoadedBlueprint { name; version; dir; blueprint: Blueprint; meta: CatalogMeta; changelog: string; knowledgeSeeds: string[] }`, `CatalogMeta { displayName; description; kernel; surfaces: ('web'|'slack')[]; inputs: BlueprintInput[]; pack: string | null }`, `BlueprintInput { pointer; label; hint?; example: unknown }`, pointer helpers `getPointer(doc, ptr)`, `setPointer(doc, ptr, value)`, `hasPointer(doc, ptr)`, `pointerSegments(ptr)`, `pointersOverlap(a, b)`.

- [ ] **Step 1: Package manifest, linking the kernel contracts**

`catalog/package.json`:

```json
{
  "name": "@hf1/catalog",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts", "./testing": "./src/testing.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@harness/config-api": "link:../../agent-harness/harness/config-api",
    "@harness/identity-api": "link:../../agent-harness/harness/identity-api",
    "@harness/pack-api": "link:../../agent-harness/harness/pack-api",
    "@harness/shared": "link:../../agent-harness/harness/shared",
    "@harness/surface-api": "link:../../agent-harness/harness/surface-api",
    "yaml": "2.8.2",
    "zod": "4.6.5"
  },
  "devDependencies": { "@types/node": "26.5.1", "typescript": "7.0.2", "vitest": "5.0.0" }
}
```

The kernel session lands the `web` surface and `{ ref }` schema as **Plan 11c's first commit** on branch `worktree-plan-11c-platform-seams`, worktree `../agent-harness/.claude/worktrees/plan-11c-platform-seams` (created off `main` once 11b merges). Point the five links at `../../agent-harness/.claude/worktrees/plan-11c-platform-seams/harness/<pkg>` and put that worktree's `HEAD` into `kernel.lock`'s `commit`. If the worktree does not exist yet when this task runs, use the main checkout (`link:../../agent-harness/harness/<pkg>`) and expect the `web`/`{ ref }` assertions in Task 3 to fail until it does — do not code around it; re-link and re-run when the kernel session says the commit is there.

`catalog/tsconfig.json`: `{ "extends": "../tsconfig.base.json", "include": ["src", "vitest.config.ts"] }`. `catalog/vitest.config.ts`: `import { defineConfig } from 'vitest/config'; export default defineConfig({});`

- [ ] **Step 2: Failing tests for the pointer helpers**

`catalog/src/shared/pointer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getPointer, hasPointer, pointerSegments, pointersOverlap, setPointer } from './pointer.js';

describe('JSON pointers', () => {
  it('splits and unescapes segments', () => {
    expect(pointerSegments('/a/b~1c/0/~0x')).toEqual(['a', 'b/c', '0', '~x']);
    expect(pointerSegments('')).toEqual([]);
  });
  it('refuses a pointer that does not start with a slash or names a prototype segment', () => {
    expect(() => pointerSegments('a/b')).toThrow(/must start with "\/"/);
    expect(() => pointerSegments('/__proto__/x')).toThrow(/prototype/);
  });
  it('reads, writes and tests existence', () => {
    const doc: Record<string, unknown> = { a: { b: [1, 2] } };
    expect(getPointer(doc, '/a/b/1')).toBe(2);
    expect(hasPointer(doc, '/a/c')).toBe(false);
    setPointer(doc, '/a/c', 'x');
    expect(getPointer(doc, '/a/c')).toBe('x');
  });
  it('overlap is segment-wise, both directions', () => {
    expect(pointersOverlap('/policy', '/policy/classes')).toBe(true);
    expect(pointersOverlap('/policy/classes', '/policy')).toBe(true);
    expect(pointersOverlap('/policy', '/policyOverride')).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @hf1/catalog test`
Expected: FAIL — `./pointer.js` not found.

- [ ] **Step 4: Implement `pointer.ts`**

```ts
import { ConfigError } from '@harness/shared';

const PROTOTYPE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** RFC 6901 segments. A pointer is the same shape the kernel's lock set uses. */
export function pointerSegments(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new ConfigError(`pointer "${pointer}" must start with "/"`);
  const segments = pointer
    .slice(1)
    .split('/')
    .map((s) => s.replaceAll('~1', '/').replaceAll('~0', '~'));
  for (const s of segments) {
    if (PROTOTYPE_SEGMENTS.has(s)) throw new ConfigError(`pointer "${pointer}" names a prototype segment`);
  }
  return segments;
}

export function pointersOverlap(a: string, b: string): boolean {
  const x = pointerSegments(a);
  const y = pointerSegments(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) if (x[i] !== y[i]) return false;
  return true;
}

function walk(doc: unknown, segments: string[]): { parent: unknown; key: string } | null {
  let node: unknown = doc;
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (typeof node !== 'object' || node === null) return null;
    node = (node as Record<string, unknown>)[segments[i]!];
  }
  if (typeof node !== 'object' || node === null) return null;
  return { parent: node, key: segments[segments.length - 1]! };
}

export function hasPointer(doc: unknown, pointer: string): boolean {
  const segments = pointerSegments(pointer);
  if (segments.length === 0) return true;
  const at = walk(doc, segments);
  return at !== null && Object.prototype.hasOwnProperty.call(at.parent, at.key);
}

export function getPointer(doc: unknown, pointer: string): unknown {
  const segments = pointerSegments(pointer);
  if (segments.length === 0) return doc;
  const at = walk(doc, segments);
  return at === null ? undefined : (at.parent as Record<string, unknown>)[at.key];
}

/** Set a value, creating intermediate objects. Arrays are addressed by index or "-" for append. */
export function setPointer(doc: Record<string, unknown>, pointer: string, value: unknown): void {
  const segments = pointerSegments(pointer);
  if (segments.length === 0) throw new ConfigError('cannot set the whole document through a pointer');
  let node: Record<string, unknown> = doc;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const key = segments[i]!;
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  const last = segments[segments.length - 1]!;
  if (Array.isArray(node) && last === '-') (node as unknown[]).push(value);
  else node[last] = value;
}
```

- [ ] **Step 5: Failing tests for `!include`**

`catalog/src/shared/include.test.ts`:

```ts
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWithIncludes } from './include.js';

async function dir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'hf1-catalog-'));
}

describe('parseWithIncludes', () => {
  it('replaces !include with the file body, relative to the YAML file', async () => {
    const d = await dir();
    await writeFile(path.join(d, 'persona.md'), '# Hello\n');
    await writeFile(path.join(d, 'b.yaml'), 'persona: !include persona.md\nn: 1\n');
    await expect(parseWithIncludes(path.join(d, 'b.yaml'))).resolves.toEqual({ persona: '# Hello\n', n: 1 });
  });
  it('refuses an include outside the directory, by path and by symlink', async () => {
    const d = await dir();
    const outside = await dir();
    await writeFile(path.join(outside, 'x.md'), 'x');
    await writeFile(path.join(d, 'a.yaml'), 'p: !include ../x.md\n');
    await expect(parseWithIncludes(path.join(d, 'a.yaml'))).rejects.toThrow(/outside the blueprint directory/);
    await mkdir(path.join(d, 'skills'));
    await symlink(path.join(outside, 'x.md'), path.join(d, 'skills', 'link.md'));
    await writeFile(path.join(d, 'b.yaml'), 'p: !include skills/link.md\n');
    await expect(parseWithIncludes(path.join(d, 'b.yaml'))).rejects.toThrow(/outside the blueprint directory/);
  });
  it('refuses a non-scalar !include and a missing file', async () => {
    const d = await dir();
    await writeFile(path.join(d, 'a.yaml'), 'p: !include [a, b]\n');
    await expect(parseWithIncludes(path.join(d, 'a.yaml'))).rejects.toThrow(/one path/);
    await writeFile(path.join(d, 'b.yaml'), 'p: !include nope.md\n');
    await expect(parseWithIncludes(path.join(d, 'b.yaml'))).rejects.toThrow(/cannot be read/);
  });
});
```

- [ ] **Step 6: Implement `include.ts`**

The same semantics as the kernel's files source (a tag, a string path, confined twice — by string and by realpath — to the YAML file's directory), written here for the catalogue's directory rather than a tenant's:

```ts
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ConfigError } from '@harness/shared';

interface Marker {
  $include: string;
}

const isMarker = (v: unknown): v is Marker =>
  typeof v === 'object' && v !== null && typeof (v as Marker).$include === 'string';

function isInside(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function readIncluded(relative: string, realRoot: string): Promise<string> {
  const outside = new ConfigError(`!include "${relative}" is outside the blueprint directory`);
  const target = path.resolve(realRoot, relative);
  if (!isInside(target, realRoot)) throw outside;
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new ConfigError(`!include "${relative}" cannot be read`);
  }
  if (!isInside(real, realRoot)) throw outside;
  try {
    return await readFile(real, 'utf8');
  } catch {
    throw new ConfigError(`!include "${relative}" cannot be read`);
  }
}

async function expand(node: unknown, realRoot: string): Promise<unknown> {
  if (isMarker(node)) return readIncluded(node.$include, realRoot);
  if (Array.isArray(node)) return Promise.all(node.map((n) => expand(n, realRoot)));
  if (typeof node === 'object' && node !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = await expand(v, realRoot);
    return out;
  }
  return node;
}

const TAGS = [
  {
    tag: '!include',
    identify: () => false,
    resolve: (value: unknown) => {
      if (typeof value !== 'string' || value.trim() === '') throw new ConfigError('!include takes one path, as a plain string');
      return { $include: value.trim() } satisfies Marker;
    },
  },
  ...(['seq', 'map'] as const).map((collection) => ({
    tag: '!include',
    collection,
    resolve: () => {
      throw new ConfigError('!include takes one path, as a plain string');
    },
  })),
];

/** Parse a YAML file, expanding every `!include <path>` from the file's own directory. */
export async function parseWithIncludes(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new ConfigError(`cannot read ${path.basename(file)}`);
  }
  const realRoot = await realpath(path.dirname(file));
  const parsed: unknown = parseYaml(text, { customTags: TAGS });
  return expand(parsed, realRoot);
}
```

- [ ] **Step 7: Types, the `catalog.yaml` schema, and the loader — failing test first**

`catalog/src/domain/catalog/types.ts`:

```ts
import type { Blueprint } from '@harness/config-api';

export interface BlueprintInput {
  /** A JSON pointer into the blueprint document that the onboarding form asks for. */
  pointer: string;
  label: string;
  hint?: string;
  /** A value that makes the blueprint resolve; the form's placeholder and the tests' input. */
  example: unknown;
}

export type SurfaceKind = 'web' | 'slack';

export interface CatalogMeta {
  displayName: string;
  description: string;
  /** The kernel version this blueprint was validated on, e.g. "0.3.0". */
  kernel: string;
  surfaces: SurfaceKind[];
  inputs: BlueprintInput[];
  /** A pack the kernel image ships, or null for an agent with no pack. */
  pack: string | null;
}

export interface LoadedBlueprint {
  name: string;
  version: string;
  dir: string;
  blueprint: Blueprint;
  meta: CatalogMeta;
  changelog: string;
  /** File names under `knowledge/`, copied into a tenant's knowledge directory at its first release. */
  knowledgeSeeds: string[];
}

export interface Catalog {
  list(): LoadedBlueprint[];
  get(name: string): LoadedBlueprint;
}
```

`catalog/src/domain/catalog/meta.ts`:

```ts
import * as z from 'zod/v4';

const POINTER = /^\/[^\s]*$/;

export const BlueprintInputShape = z
  .object({
    pointer: z.string().regex(POINTER, 'an input pointer is a JSON pointer'),
    label: z.string().min(1).max(80),
    hint: z.string().max(200).optional(),
    example: z.unknown(),
  })
  .strict();

export const CatalogMetaShape = z
  .object({
    displayName: z.string().min(1).max(80),
    description: z.string().min(1).max(400),
    kernel: z.string().regex(/^\d+\.\d+\.\d+$/, 'the kernel version is semver'),
    surfaces: z.array(z.enum(['web', 'slack'])).min(1).refine((s) => s[0] === 'web', 'web is always first'),
    inputs: z.array(BlueprintInputShape).default([]),
    pack: z.string().min(1).nullable().default(null),
  })
  .strict();
```

`catalog/src/domain/catalog/load.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fixtureBlueprintDir } from '../../testing.js';
import { loadCatalog } from './load.js';

describe('loadCatalog', () => {
  it('loads a directory of blueprints with includes, metadata, changelog and seeds', async () => {
    const root = await fixtureBlueprintDir('one');
    const catalog = await loadCatalog(root);
    expect(catalog.list().map((b) => b.name)).toEqual(['one']);
    const one = catalog.get('one');
    expect(one.version).toBe('1.0.0');
    expect(one.blueprint.document.persona).toContain('You are');
    expect(one.meta.inputs[0]?.pointer).toBe('/playbooks/playbooks/0/timezone');
    expect(one.knowledgeSeeds).toEqual(['welcome.md']);
    expect(one.changelog).toContain('## 1.0.0');
  });
  it('refuses a blueprint whose directory name is not a blueprint name', async () => {
    const root = await fixtureBlueprintDir('Bad Name');
    await expect(loadCatalog(root)).rejects.toThrow(/blueprint name/);
  });
  it('refuses a blueprint.yaml that is not the kernel shape', async () => {
    const root = await fixtureBlueprintDir('one', { blueprintYaml: 'document: {}\n' });
    await expect(loadCatalog(root)).rejects.toThrow(/blueprint one/);
  });
  it('get() on an unknown name is an error, not undefined', async () => {
    const catalog = await loadCatalog(await fixtureBlueprintDir('one'));
    expect(() => catalog.get('two')).toThrow(/no blueprint named "two"/);
  });
});
```

`catalog/src/testing.ts` (the fixture builder every test uses; it writes a **minimal valid v0.3.0 document**):

```ts
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';

/** A minimal blueprint document that resolves under the v0.3.0 schema once a tenant supplies id and displayName. */
export function fixtureDocument(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    persona: 'You are the fixture assistant.\n',
    identity: {
      defaults: { web: 'member' },
      principals: [
        { id: 'svc-host', kind: 'service', level: 'service', displayName: 'Harness host' },
        { id: 'svc-playbooks', kind: 'service', level: 'service', displayName: 'Scheduled playbooks' },
        { id: 'svc-platform', kind: 'service', level: 'service', displayName: 'hf1 platform', surfaces: { http: 'platform' } },
      ],
    },
    policy: {
      classes: { read: 'auto', 'write.internal': 'auto', external: 'approval', financial: 'blocked', destructive: 'approval' },
      tools: { hide: [] },
    },
    routing: {
      routes: {
        chat: { model: 'gemini/gemini-3-flash-preview', fallbacks: ['groq/openai/gpt-oss-120b'], daily_budget_usd: 2 },
        extract: { model: 'gemini/gemini-3-flash-preview', daily_budget_usd: 5 },
        reason: { model: 'gemini/gemini-3-flash-preview', fallbacks: ['groq/openai/gpt-oss-120b'], daily_budget_usd: 2 },
        judge: { model: 'groq/openai/gpt-oss-120b', daily_budget_usd: 1 },
        embed: { model: 'gemini/gemini-embedding-001', daily_budget_usd: 1 },
      },
      defaults: { daily_budget_usd: 1, num_retries: 2, request_timeout_s: 120 },
    },
    playbooks: {
      playbooks: [
        {
          name: 'knowledge-sync',
          schedule: '0 7 * * *',
          timezone: 'UTC',
          skill: 'knowledge-sync',
          prompt: 'Refresh the knowledge base for today. Follow the skill exactly, including its silence rule.',
          principal: 'svc-playbooks',
          deliver: 'none',
          cost_cap_usd: 0.5,
          timeout_s: 300,
        },
      ],
    },
    skills: {},
    knowledge: { source: 'store' },
    surfaces: { web: { token: { ref: 'web-token' } }, http: {} },
    identityPlugin: { kind: 'static', settings: {} },
    runtime: 'deepagents',
    packs: [],
  };
}

export interface FixtureOptions {
  blueprintYaml?: string;
  lockset?: string[];
  version?: string;
}

/** Write `<tmp>/<name>/` as a blueprint directory and return `<tmp>`. */
export async function fixtureBlueprintDir(name: string, opts: FixtureOptions = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'hf1-blueprints-'));
  const dir = path.join(root, name);
  await mkdir(path.join(dir, 'knowledge'), { recursive: true });
  const { persona, ...rest } = fixtureDocument();
  await writeFile(path.join(dir, 'persona.md'), persona as string);
  await writeFile(
    path.join(dir, 'blueprint.yaml'),
    opts.blueprintYaml ??
      [
        stringify({ version: opts.version ?? '1.0.0', lockset: opts.lockset ?? ['/routing'], document: rest }, { lineWidth: 0 }).trimEnd(),
        '  persona: !include persona.md',
        '',
      ].join('\n'),
  );
  await writeFile(
    path.join(dir, 'catalog.yaml'),
    stringify({
      displayName: 'Fixture',
      description: 'A fixture blueprint.',
      kernel: '0.3.0',
      surfaces: ['web'],
      inputs: [{ pointer: '/playbooks/playbooks/0/timezone', label: 'Timezone', example: 'Europe/Bucharest' }],
      pack: null,
    }),
  );
  await writeFile(path.join(dir, 'CHANGELOG.md'), `# ${name}\n\n## ${opts.version ?? '1.0.0'}\n\n- First version.\n`);
  await writeFile(path.join(dir, 'knowledge', 'welcome.md'), '# Welcome\n');
  return root;
}
```

(The `stringify(...)` + appended `persona: !include persona.md` line relies on `document` being the last top-level key with two-space indentation: `stringify` emits keys in insertion order — `version`, `lockset`, `document` — so the appended line lands inside `document`. Keep that order.)

- [ ] **Step 8: Implement `load.ts`**

```ts
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { BlueprintShape, type Blueprint } from '@harness/config-api';
import { ConfigError } from '@harness/shared';
import * as z from 'zod/v4';
import { parseWithIncludes } from '../../shared/include.js';
import { CatalogMetaShape } from './meta.js';
import type { Catalog, LoadedBlueprint } from './types.js';

const BLUEPRINT_NAME = /^[a-z][a-z0-9-]{1,39}$/;

function invalid(what: string, error: z.ZodError): ConfigError {
  return new ConfigError(`${what} is invalid: ${z.prettifyError(error)}`);
}

async function loadOne(root: string, name: string): Promise<LoadedBlueprint> {
  if (!BLUEPRINT_NAME.test(name)) throw new ConfigError(`"${name}" is not a blueprint name (lowercase, digits, hyphens)`);
  const dir = path.join(root, name);
  const rawBlueprint = await parseWithIncludes(path.join(dir, 'blueprint.yaml'));
  const parsedBlueprint = BlueprintShape.safeParse(rawBlueprint);
  if (!parsedBlueprint.success) throw invalid(`blueprint ${name}`, parsedBlueprint.error);
  const rawMeta = await parseWithIncludes(path.join(dir, 'catalog.yaml'));
  const parsedMeta = CatalogMetaShape.safeParse(rawMeta);
  if (!parsedMeta.success) throw invalid(`blueprint ${name}: catalog.yaml`, parsedMeta.error);
  const changelog = await readFile(path.join(dir, 'CHANGELOG.md'), 'utf8');
  let knowledgeSeeds: string[] = [];
  try {
    knowledgeSeeds = (await readdir(path.join(dir, 'knowledge'))).filter((f) => !f.startsWith('.')).sort();
  } catch {
    knowledgeSeeds = [];
  }
  return {
    name,
    version: parsedBlueprint.data.version,
    dir,
    blueprint: parsedBlueprint.data as Blueprint,
    meta: parsedMeta.data,
    changelog,
    knowledgeSeeds,
  };
}

/** Every `<dir>/<name>/` is a blueprint. Names are the directory names; order is alphabetical. */
export async function loadCatalog(dir: string): Promise<Catalog> {
  const entries = (await readdir(dir)).sort();
  const loaded = new Map<string, LoadedBlueprint>();
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    if (!(await stat(path.join(dir, entry))).isDirectory()) continue;
    loaded.set(entry, await loadOne(dir, entry));
  }
  return {
    list: () => [...loaded.values()],
    get: (name) => {
      const found = loaded.get(name);
      if (!found) throw new ConfigError(`no blueprint named "${name}"`);
      return found;
    },
  };
}
```

`catalog/src/index.ts` exports: `loadCatalog`, the types, `CatalogMetaShape`, `BlueprintInputShape`, and the pointer helpers.

- [ ] **Step 9: Run the suite, then the four gates**

Run: `pnpm --filter @hf1/catalog test && pnpm typecheck && pnpm lint && pnpm arch && pnpm format:check`
Expected: all green. If `BlueprintShape` is not exported by the linked `@harness/config-api` (it is `export const BlueprintShape` in `resolve.ts`; check `index.ts` re-exports it), add a line to the follow-ups file and validate with a local `z.object({ document: z.record(z.string(), z.unknown()), lockset: z.array(z.string()), version: z.string().min(1) })` in `load.ts` in the meantime — that local shape is a *platform* shape, not copied kernel code.

- [ ] **Step 10: Set `kernel.lock`'s commit and commit**

Put the linked checkout's `git rev-parse HEAD` into `kernel.lock`; run `pnpm kernel:check` (expected: match).

```bash
git add -A
git commit -m "feat(catalog): load a blueprint directory with includes, metadata, changelog and seeds"
```

---

### Task 3: `@hf1/catalog` — validation, the document schema, platform additions and overlays

**Files:**
- Create: `catalog/src/domain/catalog/validate.ts`, `catalog/src/domain/catalog/schema.ts`, `catalog/src/domain/catalog/additions.ts`, `catalog/src/domain/catalog/overlay.ts`
- Test: `catalog/src/domain/catalog/validate.test.ts`, `schema.test.ts`, `additions.test.ts`, `overlay.test.ts`
- Modify: `catalog/src/index.ts`, `catalog/package.json` (add `"rfc6902": "5.1.2"`)

**Interfaces:**
- Consumes: Task 2's types and pointer helpers; `resolve`, `parseClientDocument`, `ClientDocumentShape`, `CLIENT_ID_PATTERN` from `@harness/config-api`.
- Produces:
  - `validateBlueprint(b: LoadedBlueprint): void` (throws `ConfigError`).
  - `documentSchema(): Record<string, unknown>` (JSON Schema of `ClientDocumentShape`), `sectionNames(): string[]`, `sectionShape(name): z.ZodType`.
  - `AdditionsContext { clientId: string; displayName: string; creator: { principalId: string; displayName: string; webUserId: string }; knowledgePath: string }`; `platformAdditions(document: Record<string, unknown>, ctx: AdditionsContext): Record<string, unknown>` (pure; returns a new draft).
  - `applyInputs(document, values: Record<string, unknown>, inputs: BlueprintInput[]): Record<string, unknown>` (every input pointer must be present in `values`).
  - `overlayFor(blueprintDocument, draft): PatchOp[]` (add/replace/remove only), `lockedHit(lockset: readonly string[], patch: readonly PatchOp[]): { op: PatchOp; locked: string } | null`, `resolveDraft(b: LoadedBlueprint, draft): { overlay: Overlay; document: ClientDocument }` (throws `ConfigError` naming the pointer on a lock hit; version = `'draft'`).

- [ ] **Step 1: Failing tests — validation**

`validate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fixtureBlueprintDir } from '../../testing.js';
import { loadCatalog } from './load.js';
import { validateBlueprint } from './validate.js';

async function load(name = 'one', opts = {}) {
  return (await loadCatalog(await fixtureBlueprintDir(name, opts))).get(name);
}

describe('validateBlueprint', () => {
  it('accepts the fixture', async () => {
    expect(() => validateBlueprint(await load())).not.toThrow();
  });
  it('refuses a lock-set pointer that does not exist in the document', async () => {
    await expect(load('one', { lockset: ['/nope'] }).then(validateBlueprint)).rejects.toThrow(/lockset "\/nope" names nothing/);
  });
  it('refuses an input pointer that a lock covers', async () => {
    await expect(load('one', { lockset: ['/playbooks'] }).then(validateBlueprint)).rejects.toThrow(/input "\/playbooks\/playbooks\/0\/timezone" is locked/);
  });
  it('refuses a version that is not the changelog top entry', async () => {
    await expect(load('one', { version: '1.1.0' }).then(validateBlueprint)).rejects.toThrow(/CHANGELOG/);
  });
  it('refuses a lock on /id or /displayName, and a document that does not resolve', async () => {
    await expect(load('one', { lockset: ['/id'] }).then(validateBlueprint)).rejects.toThrow(/cannot be locked/);
  });
});
```

Note the fixture's changelog is written from `opts.version`, so the version test needs a fixture whose changelog says `1.0.0` while `blueprint.yaml` says `1.1.0`: extend `fixtureBlueprintDir` with `changelogVersion?: string` and write `## ${opts.changelogVersion ?? opts.version ?? '1.0.0'}`; the test passes `{ version: '1.1.0', changelogVersion: '1.0.0' }`.

- [ ] **Step 2: Implement `validate.ts`**

```ts
import { parseClientDocument, resolve } from '@harness/config-api';
import { ConfigError } from '@harness/shared';
import { hasPointer, pointersOverlap } from '../../shared/pointer.js';
import { applyInputs, platformAdditions } from './additions.js';
import { overlayFor } from './overlay.js';
import type { LoadedBlueprint } from './types.js';

/** The values the catalogue itself uses to prove a blueprint resolves; no tenant is named. */
export const VALIDATION_CONTEXT = {
  clientId: 'validation-tenant',
  displayName: 'Validation',
  creator: { principalId: 'u-validator', displayName: 'Validator', webUserId: 'validator' },
  knowledgePath: '/srv/knowledge/validation-tenant',
};

function topChangelogVersion(changelog: string): string | null {
  const m = /^## (\d+\.\d+\.\d+)/m.exec(changelog);
  return m ? m[1]! : null;
}

export function validateBlueprint(b: LoadedBlueprint): void {
  const doc = b.blueprint.document as Record<string, unknown>;
  for (const locked of b.blueprint.lockset) {
    if (locked === '/id' || locked === '/displayName') throw new ConfigError(`blueprint ${b.name}: "${locked}" cannot be locked`);
    if (!hasPointer(doc, locked)) throw new ConfigError(`blueprint ${b.name}: lockset "${locked}" names nothing in the document`);
  }
  for (const input of b.meta.inputs) {
    if (!hasPointer(doc, input.pointer)) throw new ConfigError(`blueprint ${b.name}: input "${input.pointer}" names nothing in the document`);
    const hit = b.blueprint.lockset.find((l) => pointersOverlap(l, input.pointer));
    if (hit) throw new ConfigError(`blueprint ${b.name}: input "${input.pointer}" is locked by "${hit}"`);
  }
  if (topChangelogVersion(b.changelog) !== b.version) {
    throw new ConfigError(`blueprint ${b.name}: version ${b.version} is not the top entry of CHANGELOG.md`);
  }
  if (b.meta.pack !== null && !(doc.packs as string[]).includes(b.meta.pack)) {
    throw new ConfigError(`blueprint ${b.name}: catalog.yaml names pack ${b.meta.pack} but the document's packs do not`);
  }
  // The proof: with the inputs' examples and the platform's additions, the blueprint resolves.
  const values = Object.fromEntries(b.meta.inputs.map((i) => [i.pointer, i.example]));
  const draft = platformAdditions(applyInputs(doc, values, b.meta.inputs), VALIDATION_CONTEXT);
  const overlay = { patch: overlayFor(doc, draft), version: 'validation' };
  parseClientDocument(resolve(b.blueprint, overlay));
}
```

- [ ] **Step 3: Failing tests — additions and inputs**

`additions.test.ts`:

```ts
import { parseClientDocument } from '@harness/config-api';
import { describe, expect, it } from 'vitest';
import { fixtureDocument } from '../../testing.js';
import { applyInputs, platformAdditions } from './additions.js';

const ctx = {
  clientId: 'acme-helper',
  displayName: 'Helper',
  creator: { principalId: 'u-jane', displayName: 'Jane', webUserId: 'user-uuid-1' },
  knowledgePath: '/srv/knowledge/acme-helper',
};

describe('platformAdditions', () => {
  it('adds id, displayName, the creator as admin on web, and the knowledge path; keeps the rest', () => {
    const draft = platformAdditions(fixtureDocument(), ctx);
    expect(draft.id).toBe('acme-helper');
    expect(draft.displayName).toBe('Helper');
    const principals = (draft.identity as { principals: { id: string; level: string; surfaces?: Record<string, string> }[] }).principals;
    expect(principals.find((p) => p.id === 'u-jane')).toMatchObject({ level: 'admin', surfaces: { web: 'user-uuid-1' } });
    expect(principals.find((p) => p.id === 'svc-platform')).toBeDefined();
    expect(draft.knowledge).toEqual({ source: 'dir', path: '/srv/knowledge/acme-helper' });
    expect(() => parseClientDocument(draft)).not.toThrow();
  });
  it('does not mutate its input', () => {
    const doc = fixtureDocument();
    platformAdditions(doc, ctx);
    expect(doc.id).toBeUndefined();
  });
});

describe('applyInputs', () => {
  const inputs = [{ pointer: '/playbooks/playbooks/0/timezone', label: 'Timezone', example: 'UTC' }];
  it('writes each input value at its pointer', () => {
    const out = applyInputs(fixtureDocument(), { '/playbooks/playbooks/0/timezone': 'Europe/Bucharest' }, inputs);
    expect((out.playbooks as { playbooks: { timezone: string }[] }).playbooks[0]?.timezone).toBe('Europe/Bucharest');
  });
  it('refuses a missing input and an unknown pointer', () => {
    expect(() => applyInputs(fixtureDocument(), {}, inputs)).toThrow(/input "\/playbooks\/playbooks\/0\/timezone" is required/);
    expect(() => applyInputs(fixtureDocument(), { '/x': 1, '/playbooks/playbooks/0/timezone': 'UTC' }, inputs)).toThrow(/"\/x" is not an input/);
  });
});
```

- [ ] **Step 4: Implement `additions.ts`**

```ts
import { ConfigError } from '@harness/shared';
import { setPointer } from '../../shared/pointer.js';
import type { BlueprintInput } from './types.js';

export interface AdditionsContext {
  clientId: string;
  displayName: string;
  creator: { principalId: string; displayName: string; webUserId: string };
  knowledgePath: string;
}

interface Principal {
  id: string;
  kind: 'user' | 'service';
  level: string;
  displayName: string;
  surfaces?: Record<string, string>;
}

const clone = <T>(v: T): T => structuredClone(v);

/**
 * What the platform owns in every document (spec decision 12): the tenant's id and display name,
 * the creating person as the first admin on the web surface, the platform's service principal for
 * the run API, and the knowledge directory. Everything else is the blueprint's.
 */
export function platformAdditions(document: Record<string, unknown>, ctx: AdditionsContext): Record<string, unknown> {
  const draft = clone(document);
  draft.id = ctx.clientId;
  draft.displayName = ctx.displayName;
  const identity = (draft.identity ?? { principals: [] }) as { principals: Principal[]; defaults?: Record<string, string> };
  identity.defaults = { ...(identity.defaults ?? {}), web: identity.defaults?.web ?? 'member' };
  const principals = identity.principals.filter((p) => p.id !== ctx.creator.principalId);
  principals.unshift({
    id: ctx.creator.principalId,
    kind: 'user',
    level: 'admin',
    displayName: ctx.creator.displayName,
    surfaces: { web: ctx.creator.webUserId },
  });
  if (!principals.some((p) => p.id === 'svc-platform')) {
    principals.push({ id: 'svc-platform', kind: 'service', level: 'service', displayName: 'hf1 platform', surfaces: { http: 'platform' } });
  }
  identity.principals = principals;
  draft.identity = identity;
  draft.knowledge = { source: 'dir', path: ctx.knowledgePath };
  return draft;
}

export function applyInputs(
  document: Record<string, unknown>,
  values: Record<string, unknown>,
  inputs: BlueprintInput[],
): Record<string, unknown> {
  const known = new Set(inputs.map((i) => i.pointer));
  for (const pointer of Object.keys(values)) {
    if (!known.has(pointer)) throw new ConfigError(`"${pointer}" is not an input of this blueprint`);
  }
  const out = clone(document);
  for (const input of inputs) {
    if (!(input.pointer in values)) throw new ConfigError(`input "${input.pointer}" is required`);
    setPointer(out, input.pointer, values[input.pointer]);
  }
  return out;
}
```

- [ ] **Step 5: Failing tests — overlays**

`overlay.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fixtureBlueprintDir, fixtureDocument } from '../../testing.js';
import { platformAdditions } from './additions.js';
import { loadCatalog } from './load.js';
import { lockedHit, overlayFor, resolveDraft } from './overlay.js';
import { VALIDATION_CONTEXT } from './validate.js';

describe('overlayFor', () => {
  it('emits add/replace/remove only and includes the two tenant fields', () => {
    const base = fixtureDocument();
    const draft = platformAdditions(base, VALIDATION_CONTEXT);
    (draft.policy as { tools: { hide: string[] } }).tools.hide = ['memory_forget'];
    const patch = overlayFor(base, draft);
    expect(patch.every((op) => ['add', 'replace', 'remove'].includes(op.op))).toBe(true);
    expect(patch).toContainEqual({ op: 'add', path: '/id', value: 'validation-tenant' });
    expect(patch).toContainEqual({ op: 'add', path: '/policy/tools/hide/0', value: 'memory_forget' });
  });
  it('is empty when nothing changed', () => {
    const base = fixtureDocument();
    expect(overlayFor(base, structuredClone(base))).toEqual([]);
  });
});

describe('lockedHit / resolveDraft', () => {
  it('names the first locked pointer an operation touches, above or below', () => {
    const hit = lockedHit(['/policy/classes'], [{ op: 'replace', path: '/policy', value: {} }]);
    expect(hit?.locked).toBe('/policy/classes');
  });
  it('resolves a draft through the kernel and refuses a locked edit with the pointer', async () => {
    const b = (await loadCatalog(await fixtureBlueprintDir('one', { lockset: ['/routing'] }))).get('one');
    const draft = platformAdditions(b.blueprint.document as Record<string, unknown>, VALIDATION_CONTEXT);
    const ok = resolveDraft(b, draft);
    expect(ok.document.id).toBe('validation-tenant');
    (draft.routing as { defaults: { num_retries: number } }).defaults.num_retries = 9;
    expect(() => resolveDraft(b, draft)).toThrow(/"\/routing\/defaults\/num_retries" touches "\/routing"/);
  });
});
```

- [ ] **Step 6: Implement `overlay.ts`**

```ts
import { createPatch } from 'rfc6902';
import { resolve, type ClientDocument, type Overlay, type PatchOp } from '@harness/config-api';
import { ConfigError } from '@harness/shared';
import { pointersOverlap } from '../../shared/pointer.js';
import type { LoadedBlueprint } from './types.js';

/** The tenant's edits as the kernel's patch subset. `rfc6902.createPatch` emits add, remove and replace only. */
export function overlayFor(blueprintDocument: Record<string, unknown>, draft: Record<string, unknown>): PatchOp[] {
  return createPatch(blueprintDocument, draft).map((op) => {
    if (op.op === 'add' || op.op === 'replace') return { op: op.op, path: op.path, value: op.value as unknown };
    if (op.op === 'remove') return { op: 'remove', path: op.path };
    throw new ConfigError(`overlay: unexpected operation ${op.op}`);
  });
}

export function lockedHit(lockset: readonly string[], patch: readonly PatchOp[]): { op: PatchOp; locked: string } | null {
  for (const op of patch) {
    const locked = lockset.find((l) => pointersOverlap(l, op.path));
    if (locked) return { op, locked };
  }
  return null;
}

/** Diff, refuse a lock hit with a sentence naming both pointers, then let the kernel resolve. */
export function resolveDraft(b: LoadedBlueprint, draft: Record<string, unknown>): { overlay: Overlay; document: ClientDocument } {
  const patch = overlayFor(b.blueprint.document as Record<string, unknown>, draft);
  const hit = lockedHit(b.blueprint.lockset, patch);
  if (hit) throw new ConfigError(`${hit.op.op} "${hit.op.path}" touches "${hit.locked}", which blueprint ${b.name}@${b.version} locks`);
  const overlay: Overlay = { patch, version: 'draft' };
  return { overlay, document: resolve(b.blueprint, overlay) };
}
```

- [ ] **Step 7: Failing test — the document schema**

`schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { documentSchema, sectionNames, sectionShape } from './schema.js';

describe('documentSchema', () => {
  it('is generated from the kernel shape and names every section', () => {
    const schema = documentSchema() as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['persona', 'identity', 'policy', 'routing', 'playbooks', 'skills', 'knowledge', 'surfaces', 'identityPlugin', 'runtime', 'packs']));
    expect(sectionNames()).toContain('policy');
    expect(sectionShape('policy').safeParse({ classes: {}, tools: { hide: [] } }).success).toBe(true);
    expect(() => sectionShape('nope')).toThrow(/no section/);
  });
});
```

- [ ] **Step 8: Implement `schema.ts`**

```ts
import { ClientDocumentShape } from '@harness/config-api';
import { ConfigError } from '@harness/shared';
import * as z from 'zod/v4';

/** JSON Schema of the whole document, from the kernel's zod shape; never hand-written. */
export function documentSchema(): Record<string, unknown> {
  return z.toJSONSchema(ClientDocumentShape, { unrepresentable: 'any' }) as Record<string, unknown>;
}

export function sectionNames(): string[] {
  return Object.keys(ClientDocumentShape.shape).filter((k) => k !== 'schemaVersion' && k !== 'id' && k !== 'displayName');
}

export function sectionShape(name: string): z.ZodType {
  const shape = (ClientDocumentShape.shape as Record<string, z.ZodType | undefined>)[name];
  if (!shape || !sectionNames().includes(name)) throw new ConfigError(`no section named "${name}"`);
  return shape;
}
```

- [ ] **Step 9: Export, run the suite and gates, commit**

Add the new functions and `AdditionsContext`, `VALIDATION_CONTEXT` to `catalog/src/index.ts`.

Run: `pnpm --filter @hf1/catalog test && pnpm typecheck && pnpm lint && pnpm arch && pnpm format:check`
Expected: green. (If `surfaces.web` is refused by the linked kernel, the 11c worktree is not linked yet — see Task 2 Step 1; the failing tests are the signal, not a bug to code around.)

```bash
git add -A
git commit -m "feat(catalog): validate blueprints, derive overlays, and expose the document schema and platform additions"
```

---

### Task 4: The two blueprints

**Files:**
- Create: `catalog/blueprints/internal-team-assistant/{blueprint.yaml,catalog.yaml,persona.md,CHANGELOG.md,knowledge/getting-started.md}`, `catalog/blueprints/credentialing-assistant/{blueprint.yaml,catalog.yaml,persona.md,CHANGELOG.md,knowledge/front-desk.md,knowledge/escalation-and-billing.md}`
- Test: `catalog/src/domain/catalog/blueprints.test.ts`
- Modify: `catalog/src/index.ts` (export `BLUEPRINTS_DIR`)

**Interfaces:**
- Produces: `BLUEPRINTS_DIR` (absolute path of `catalog/blueprints`, resolved from `import.meta.url`), the two blueprint names `internal-team-assistant` and `credentialing-assistant`, both at version `1.0.0`, `kernel: 0.3.0`.

- [ ] **Step 1: Failing test that both blueprints load and validate**

`blueprints.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BLUEPRINTS_DIR } from '../../index.js';
import { loadCatalog } from './load.js';
import { validateBlueprint } from './validate.js';

describe('the shipped blueprints', () => {
  it('load, validate and are the two P1 blueprints', async () => {
    const catalog = await loadCatalog(BLUEPRINTS_DIR);
    expect(catalog.list().map((b) => b.name)).toEqual(['credentialing-assistant', 'internal-team-assistant']);
    for (const b of catalog.list()) validateBlueprint(b);
  });
  it('lock sets are what the spec says', async () => {
    const catalog = await loadCatalog(BLUEPRINTS_DIR);
    expect(catalog.get('internal-team-assistant').blueprint.lockset).toEqual(['/routing']);
    expect(catalog.get('credentialing-assistant').blueprint.lockset).toEqual(['/persona', '/policy', '/routing']);
    expect(catalog.get('credentialing-assistant').meta.pack).toBe('@harness/pack-healthcare');
  });
  it('names no tenant, organisation or person', async () => {
    const catalog = await loadCatalog(BLUEPRINTS_DIR);
    for (const b of catalog.list()) {
      const text = JSON.stringify(b.blueprint.document) + b.changelog;
      expect(text).not.toMatch(/hf1-labs|demo-practice|river-clinic|U0[0-9A-Z]{6,}/);
    }
  });
});
```

- [ ] **Step 2: `internal-team-assistant`**

`blueprint.yaml`:

```yaml
# hf1 Agents · blueprint "internal-team-assistant"
# A finished-but-open assistant for a team: everything but the model routing is the tenant's to edit.
version: 1.0.0
lockset:
  - /routing
document:
  schemaVersion: 1
  persona: !include persona.md
  identity:
    defaults:
      web: member
    principals:
      - { id: svc-host, kind: service, level: service, displayName: Harness host }
      - { id: svc-playbooks, kind: service, level: service, displayName: Scheduled playbooks }
      - { id: svc-platform, kind: service, level: service, displayName: hf1 platform, surfaces: { http: platform } }
  policy:
    classes:
      read: auto
      write.internal: auto
      external: approval
      financial: blocked
      destructive: approval
    tools:
      hide: []
  routing:
    routes:
      chat: { model: gemini/gemini-3-flash-preview, fallbacks: [groq/openai/gpt-oss-120b], daily_budget_usd: 2 }
      extract: { model: gemini/gemini-3-flash-preview, daily_budget_usd: 5 }
      reason: { model: gemini/gemini-3-flash-preview, fallbacks: [groq/openai/gpt-oss-120b], daily_budget_usd: 2 }
      judge: { model: groq/openai/gpt-oss-120b, daily_budget_usd: 1 }
      embed: { model: gemini/gemini-embedding-001, daily_budget_usd: 1 }
    defaults: { daily_budget_usd: 1, num_retries: 2, request_timeout_s: 120 }
  playbooks:
    playbooks:
      - name: knowledge-sync
        schedule: '0 7 * * *'
        timezone: UTC
        skill: knowledge-sync
        prompt: Refresh the knowledge base for today. Follow the skill exactly, including its silence rule.
        principal: svc-playbooks
        deliver: none
        cost_cap_usd: 0.5
        timeout_s: 300
  skills: {}
  knowledge: { source: store }
  surfaces:
    web: { token: { ref: web-token } }
    http: {}
  identityPlugin: { kind: static, settings: {} }
  runtime: deepagents
  packs: []
```

`catalog.yaml`:

```yaml
displayName: Internal team assistant
description: A sharp, practical assistant for a team's own channel — memory, knowledge and playbooks, no domain pack. Rename it, reshape its voice, and connect Slack if the team lives there.
kernel: 0.3.0
surfaces: [web, slack]
inputs:
  - pointer: /playbooks/playbooks/0/timezone
    label: Timezone
    hint: Where the team works; the daily knowledge refresh runs at 07:00 there.
    example: Europe/Bucharest
pack: null
```

`persona.md`: the AMA persona from the kernel's PR #5 `clients/hf1-labs/SOUL.md` (branch `worktree-client-hf1-labs`), **verbatim from "# AMA — Personality & Voice" through the end of the house rules and the silence doctrine**, read with `git -C ../agent-harness show worktree-client-hf1-labs:clients/hf1-labs/SOUL.md`. Replace the one sentence naming the team ("the internal AI agent for the **HF1 Labs** team") with "the internal AI agent for this team". Keep the name AMA: it is the default persona a tenant renames.

`CHANGELOG.md`:

```markdown
# internal-team-assistant

## 1.0.0

- First version. Persona and house rules from the AMA client; validated on kernel 0.3.0.
```

`knowledge/getting-started.md`: ten lines telling the team what to upload (team norms, projects, glossary) — no names.

- [ ] **Step 3: `credentialing-assistant`**

`blueprint.yaml`: as above with `persona: !include persona.md`, `lockset: [/persona, /policy, /routing]`, `packs: ['@harness/pack-healthcare']`, and two playbooks:

```yaml
  playbooks:
    playbooks:
      - name: credentialing-expirations
        schedule: '0 7 * * *'
        timezone: America/New_York
        skill: credentialing-expirations
        prompt: Run the credentialing-expirations playbook for today. Follow the skill exactly, including its silence rule.
        principal: svc-playbooks
        deliver: none
        cost_cap_usd: 0.5
        timeout_s: 300
      - name: knowledge-sync
        schedule: '30 6 * * *'
        timezone: America/New_York
        skill: knowledge-sync
        prompt: Refresh the knowledge base for today. Follow the skill exactly, including its silence rule.
        principal: svc-playbooks
        deliver: none
        cost_cap_usd: 0.5
        timeout_s: 300
```

`catalog.yaml`: `displayName: Credentialing assistant`, description ("Keeps a medical practice's provider files complete and current: licences, DEA, malpractice, board certifications, payer rosters. Persona and policy are fixed; people, schedules and knowledge are yours."), `kernel: 0.3.0`, `surfaces: [web, slack]`, inputs: both playbooks' timezones (`/playbooks/playbooks/0/timezone`, `/playbooks/playbooks/1/timezone`, example `America/New_York`), `pack: '@harness/pack-healthcare'`.

`persona.md`: the deleted `clients/demo-practice/SOUL.md` (`git -C ../agent-harness show c6e7bd0:clients/demo-practice/SOUL.md`) with the first heading and paragraph rewritten tenant-neutral:

```markdown
# Credentialing assistant

You are the credentialing assistant for this medical practice. You work in chat with the practice
manager and the credentialing coordinator. You keep provider files complete and current so that
payer enrollments and licence renewals are never the reason a provider cannot see patients.
```

and everything from "You are precise, brief, and unhurried." to the end **verbatim** (the ten hard rules, the silence doctrine, working style).

`knowledge/front-desk.md` and `knowledge/escalation-and-billing.md`: the two `demo-practice` knowledge documents rewritten as templates ("Practice hours: <fill in>") with no practice name.

`CHANGELOG.md` as for the first, "Persona and hard rules from the reference credentialing client; the healthcare pack".

- [ ] **Step 4: `BLUEPRINTS_DIR`**

In `catalog/src/index.ts`:

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/** The catalogue shipped with this package. */
export const BLUEPRINTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../blueprints');
```

- [ ] **Step 5: Run, gates, commit**

Run: `pnpm --filter @hf1/catalog test && pnpm typecheck && pnpm lint && pnpm arch && pnpm format:check`
Expected: green; both blueprints resolve through the kernel.

```bash
git add -A
git commit -m "feat(catalog): ship the internal-team-assistant and credentialing-assistant blueprints"
```

---

### Task 5: `@hf1/control-plane` — package, environment, database, migrations, test harness

**Files:**
- Create: `control-plane/package.json`, `control-plane/tsconfig.json`, `control-plane/vitest.config.ts`, `control-plane/drizzle.config.ts`, `control-plane/src/index.ts`, `control-plane/src/shared/env.ts`, `control-plane/src/shared/errors.ts`, `control-plane/src/shared/canonical.ts`, `control-plane/src/shared/ids.ts`, `control-plane/src/domain/db/schema.ts`, `control-plane/src/domain/db/connect.ts`, `control-plane/src/domain/db/migrate.ts`, `control-plane/drizzle/0000_*.sql` (generated), `control-plane/src/testing/db.ts`, `control-plane/src/testing/kernel-ddl.sql`, `control-plane/src/app/server.ts` (health only), `control-plane/src/app/main.ts`
- Test: `control-plane/src/shared/env.test.ts`, `canonical.test.ts`, `ids.test.ts`, `control-plane/src/domain/db/migrate.test.ts`, `control-plane/src/domain/vocabulary.test.ts`
- Modify: `.dependency-cruiser.cjs` — nothing (row exists); `README.md` — a line on `TEST_DATABASE_URL`

**Interfaces:**
- Produces: `loadEnv(source): Env` and the `Env` type (all variables below); `ApiError`; `canonicalJson(v)`, `contentVersion(doc)`; `SLUG_PATTERN`, `clientIdFor(orgSlug, agentSlug)`; the drizzle schema tables (`users`, `sessions`, `organisations`, `memberships`, `invitations`, `agents`, `agentReleases`, `secrets`, `knowledgeFiles`, `audit`); `connect(url): Promise<{ db: Db; close(): Promise<void> }>`, `withTransaction(db, fn)`, `runMigrations(url)`; test harness `scratchDatabase(): Promise<{ db; url; close(): Promise<void> }>` which runs the migrations **and** `kernel-ddl.sql` in one scratch database (the kernel's three contract tables, test-only).

- [ ] **Step 1: Package**

`control-plane/package.json`:

```json
{
  "name": "@hf1/control-plane",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts", "./client": "./src/client.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "start": "tsx src/app/main.ts",
    "migrate": "tsx src/domain/db/migrate.ts",
    "db:generate": "drizzle-kit generate"
  },
  "dependencies": {
    "@harness/config-api": "link:../../agent-harness/.claude/worktrees/plan-11c-platform-seams/harness/config-api",
    "@harness/identity-api": "link:../../agent-harness/.claude/worktrees/plan-11c-platform-seams/harness/identity-api",
    "@harness/pack-api": "link:../../agent-harness/.claude/worktrees/plan-11c-platform-seams/harness/pack-api",
    "@harness/shared": "link:../../agent-harness/.claude/worktrees/plan-11c-platform-seams/harness/shared",
    "@harness/surface-api": "link:../../agent-harness/.claude/worktrees/plan-11c-platform-seams/harness/surface-api",
    "@hf1/catalog": "workspace:*",
    "@hono/node-server": "1.19.6",
    "@hono/zod-validator": "0.7.4",
    "drizzle-orm": "0.45.2",
    "hono": "4.10.6",
    "openid-client": "6.8.1",
    "pg": "8.23.0",
    "rfc6902": "5.1.2",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@types/node": "26.5.1",
    "@types/pg": "8.23.1",
    "drizzle-kit": "0.31.10",
    "jose": "6.1.3",
    "tsx": "4.23.13",
    "typescript": "7.0.2",
    "vitest": "5.0.0"
  }
}
```

(Third-party versions: use the latest published at execution and pin them exactly; the numbers above are what was current when this plan was written. The kernel links must match Task 2's.)

`drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';
export default defineConfig({ dialect: 'postgresql', schema: './src/domain/db/schema.ts', out: './drizzle' });
```

- [ ] **Step 2: Failing tests — env, canonical JSON, ids**

`env.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const good = {
  DATABASE_URL: 'postgres://x', KERNEL_DATABASE_URL: 'postgres://y', HOST_URL: 'http://host:8788',
  HARNESS_HOST_TOKEN: 'tok', HARNESS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', SESSION_SECRET: 'x'.repeat(32),
  PLATFORM_URL: 'https://platform.example', KNOWLEDGE_DIR: '/tmp/k',
};

describe('loadEnv', () => {
  it('parses the required variables and applies the defaults', () => {
    const env = loadEnv(good);
    expect(env.OIDC_ISSUER).toBe('https://accounts.google.com');
    expect(env.KNOWLEDGE_MOUNT).toBe('/srv/knowledge');
    expect(env.PORT).toBe(8790);
    expect(env.PLATFORM_SUPERADMINS).toEqual([]);
  });
  it('refuses a key that is not 32 bytes and a short session secret', () => {
    expect(() => loadEnv({ ...good, HARNESS_ENCRYPTION_KEY: 'AAAA' })).toThrow(/HARNESS_ENCRYPTION_KEY/);
    expect(() => loadEnv({ ...good, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });
  it('splits superadmins on commas and lowercases them', () => {
    expect(loadEnv({ ...good, PLATFORM_SUPERADMINS: 'A@x.com, b@y.com' }).PLATFORM_SUPERADMINS).toEqual(['a@x.com', 'b@y.com']);
  });
});
```

`canonical.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { canonicalJson, contentVersion } from './canonical.js';

describe('canonical', () => {
  it('sorts keys at every depth so key order does not change the version', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 2 } })).toBe('{"a":{"c":2,"d":[1,{"y":2,"z":1}]},"b":1}');
    expect(contentVersion({ b: 1, a: 2 })).toBe(contentVersion({ a: 2, b: 1 }));
    expect(contentVersion({ a: 1 })).toMatch(/^[0-9a-f]{16}$/);
  });
});
```

`ids.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { clientIdFor, SLUG_PATTERN } from './ids.js';

describe('ids', () => {
  it('a client id is org slug + agent slug and matches the kernel pattern', () => {
    expect(clientIdFor('acme', 'helper')).toBe('acme-helper');
    expect(SLUG_PATTERN.test('a-b')).toBe(true);
    expect(SLUG_PATTERN.test('-a')).toBe(false);
    expect(() => clientIdFor('a'.repeat(32), 'b'.repeat(32))).toThrow(/64/);
  });
});
```

- [ ] **Step 3: Implement the three shared modules**

`env.ts`:

```ts
import * as z from 'zod/v4';

const emails = z
  .string()
  .default('')
  .transform((s) => s.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));

export const EnvShape = z.object({
  DATABASE_URL: z.string().min(1),
  KERNEL_DATABASE_URL: z.string().min(1),
  HOST_URL: z.string().url(),
  HARNESS_HOST_TOKEN: z.string().min(1),
  HARNESS_ENCRYPTION_KEY: z.string().refine((s) => Buffer.from(s, 'base64').length === 32, 'HARNESS_ENCRYPTION_KEY must be 32 bytes, base64'),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  OIDC_ISSUER: z.string().url().default('https://accounts.google.com'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  PLATFORM_URL: z.string().url(),
  PLATFORM_SUPERADMINS: emails,
  KNOWLEDGE_DIR: z.string().min(1),
  /** The knowledge root as the kernel host sees it (its bind mount), written into documents. */
  KNOWLEDGE_MOUNT: z.string().default('/srv/knowledge'),
  BLUEPRINTS_DIR: z.string().optional(),
  PORT: z.coerce.number().int().default(8790),
});

export type Env = z.infer<typeof EnvShape>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = EnvShape.safeParse(source);
  if (!parsed.success) throw new Error(`environment is invalid: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
```

`errors.ts`:

```ts
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly pointer?: string,
  ) {
    super(message);
  }
}
export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string, pointer?: string) => new ApiError(400, 'bad_request', message, pointer);
export const conflict = (message: string) => new ApiError(409, 'conflict', message);
export const unauthorized = () => new ApiError(401, 'unauthorized', 'sign in first');
```

`canonical.ts`:

```ts
import { createHash } from 'node:crypto';

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]));
  }
  return value;
}

export const canonicalJson = (value: unknown): string => JSON.stringify(sortKeys(value));

/** A release version: the same rule the kernel's files source uses, over canonical JSON. */
export const contentVersion = (document: unknown): string =>
  createHash('sha256').update(canonicalJson(document), 'utf8').digest('hex').slice(0, 16);
```

`ids.ts`:

```ts
import { CLIENT_ID_PATTERN } from '@harness/config-api';
import { badRequest } from './errors.js';

export const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export function clientIdFor(orgSlug: string, agentSlug: string): string {
  const id = `${orgSlug}-${agentSlug}`;
  if (id.length > 64) throw badRequest(`"${id}" is longer than 64 characters; shorten the organisation or agent slug`);
  if (!CLIENT_ID_PATTERN.test(id)) throw badRequest(`"${id}" is not a valid client id`);
  return id;
}
```

- [ ] **Step 4: The schema (spec §6)**

`domain/db/schema.ts`:

```ts
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  googleSub: text('google_sub').notNull().unique(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  superadmin: boolean('superadmin').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const organisations = pgTable('organisations', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable(
  'memberships',
  {
    organisationId: uuid('organisation_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'admin', 'member'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.organisationId, t.userId] })],
);

export const invitations = pgTable('invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  organisationId: uuid('organisation_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role', { enum: ['admin', 'member'] }).notNull(),
  token: text('token').notNull().unique(),
  invitedBy: uuid('invited_by').notNull().references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
});

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: uuid('organisation_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    clientId: text('client_id').notNull().unique(),
    displayName: text('display_name').notNull(),
    blueprintName: text('blueprint_name').notNull(),
    blueprintVersion: text('blueprint_version').notNull(),
    draft: jsonb('draft').$type<Record<string, unknown>>().notNull(),
    createdBy: uuid('created_by').notNull().references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('agents_org_slug').on(t.organisationId, t.slug)],
);

export const agentReleases = pgTable(
  'agent_releases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    version: text('version').notNull(),
    blueprintVersion: text('blueprint_version').notNull(),
    kernelVersion: text('kernel_version').notNull(),
    overlay: jsonb('overlay').$type<unknown[]>().notNull(),
    status: text('status', { enum: ['pending', 'confirmed', 'failed'] }).notNull(),
    error: text('error'),
    releasedBy: uuid('released_by').notNull().references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('agent_releases_agent_version').on(t.agentId, t.version), index('agent_releases_agent').on(t.agentId)],
);

export const secrets = pgTable(
  'secrets',
  {
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    updatedBy: uuid('updated_by').notNull().references(() => users.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.name] })],
);

export const knowledgeFiles = pgTable(
  'knowledge_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    bytes: integer('bytes').notNull(),
    sha256: text('sha256').notNull(),
    uploadedBy: uuid('uploaded_by').notNull().references(() => users.id),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('knowledge_files_agent_filename').on(t.agentId, t.filename)],
);

export const audit = pgTable('audit', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  organisationId: uuid('organisation_id'),
  agentId: uuid('agent_id'),
  action: text('action').notNull(),
  summary: text('summary').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});
```

`connect.ts`:

```ts
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export async function connect(url: string): Promise<{ db: Db; close(): Promise<void> }> {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  await pool.query('SELECT 1');
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}

export function withTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction((tx) => fn(tx as unknown as Db));
}
```

`migrate.ts`:

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { connect } from './connect.js';

export async function runMigrations(url: string): Promise<void> {
  const { db, close } = await connect(url);
  try {
    await migrate(db, { migrationsFolder: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle') });
  } finally {
    await close();
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  await runMigrations(url);
}
```

Run `pnpm --filter @hf1/control-plane db:generate` to produce `drizzle/0000_<name>.sql` and commit it.

- [ ] **Step 5: The test harness and the kernel DDL**

`src/testing/kernel-ddl.sql` — **test-only**, the three tables exactly as the kernel's boundary spec §6 states them (spec §4.3 here):

```sql
CREATE TABLE client_documents (
  client_id text PRIMARY KEY,
  schema_version integer NOT NULL,
  document jsonb NOT NULL,
  version text NOT NULL,
  blueprint_ref text NULL,
  overlay jsonb NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE client_document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL,
  version text NOT NULL,
  document jsonb NOT NULL,
  created_by text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, version)
);
CREATE TABLE client_secrets (
  client_id text NOT NULL,
  name text NOT NULL,
  ciphertext bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, name)
);
```

`src/testing/db.ts`:

```ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { connect, type Db } from '../domain/db/connect.js';
import { runMigrations } from '../domain/db/migrate.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://hf1:hf1@localhost:15432/hf1_platform_test';

/** A fresh database per suite: migrations plus the kernel's three contract tables. Dropped on close. */
export async function scratchDatabase(): Promise<{ db: Db; url: string; close(): Promise<void> }> {
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  const name = `hf1_scratch_${randomBytes(4).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  await runMigrations(url.href);
  const { db, close } = await connect(url.href);
  const ddl = await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'kernel-ddl.sql'), 'utf8');
  await db.execute(ddl);
  return {
    db,
    url: url.href,
    close: async () => {
      await close();
      const drop = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await drop.connect();
      await drop.query(`DROP DATABASE ${name}`);
      await drop.end();
    },
  };
}
```

`migrate.test.ts`:

```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scratchDatabase } from '../../testing/db.js';

let scratch: Awaited<ReturnType<typeof scratchDatabase>>;
beforeAll(async () => { scratch = await scratchDatabase(); });
afterAll(() => scratch.close());

describe('migrations', () => {
  it('create every table of spec §6 and the three kernel contract tables', async () => {
    const rows = await scratch.db.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
    const names = rows.rows.map((r) => r.tablename);
    for (const t of ['users', 'sessions', 'organisations', 'memberships', 'invitations', 'agents', 'agent_releases', 'secrets', 'knowledge_files', 'audit', 'client_documents', 'client_document_versions', 'client_secrets']) {
      expect(names).toContain(t);
    }
  });
});
```

- [ ] **Step 6: The vocabulary test (Global Constraints)**

`src/domain/vocabulary.test.ts`:

```ts
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FORBIDDEN = /hf1-labs|demo-practice|river-clinic|alliance|weave|andrei/i;

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await files(p)));
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('vocabulary', () => {
  it('no domain module names a tenant, an organisation or a person', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const f of [...(await files(here)), ...(await files(path.resolve(here, '../../../catalog/src')))]) {
      expect(await readFile(f, 'utf8'), f).not.toMatch(FORBIDDEN);
    }
  });
});
```

- [ ] **Step 7: A server with a health route and the process entry**

`src/app/server.ts` (grows in later tasks; this is the skeleton every route file hangs off):

```ts
import { Hono } from 'hono';
import { ConfigError } from '@harness/shared';
import * as z from 'zod/v4';
import { ApiError } from '../shared/errors.js';
import type { Deps } from './deps.js';

export function createApp(deps: Deps) {
  const app = new Hono<{ Variables: { deps: Deps } }>();
  app.use('*', async (c, next) => {
    c.set('deps', deps);
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message, pointer: err.pointer } }, err.status as 400);
    if (err instanceof ConfigError) {
      const pointer = /"(\/[^"]*)"/.exec(err.message)?.[1];
      return c.json({ error: { code: 'config_error', message: err.message, pointer } }, 400);
    }
    if (err instanceof z.ZodError) return c.json({ error: { code: 'invalid', message: z.prettifyError(err) } }, 400);
    deps.log.error('unhandled', err);
    return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
  });
  app.get('/api/v1/health', (c) => c.json({ ok: true }));
  return app;
}

export type AppType = ReturnType<typeof createApp>;
```

`src/app/deps.ts`:

```ts
import type { Catalog } from '@hf1/catalog';
import type { Db } from '../domain/db/connect.js';
import type { Env } from '../shared/env.js';

export interface Logger {
  info(msg: string, meta?: unknown): void;
  error(msg: string, err?: unknown): void;
}

/** Everything the app needs, built once in main.ts and once per test in testing/app.ts. Grows per task. */
export interface Deps {
  env: Env;
  db: Db;
  kernelDb: Db;
  catalog: Catalog;
  log: Logger;
  now(): Date;
}
```

`src/app/main.ts`:

```ts
import { serve } from '@hono/node-server';
import { BLUEPRINTS_DIR, loadCatalog } from '@hf1/catalog';
import { connect } from '../domain/db/connect.js';
import { runMigrations } from '../domain/db/migrate.js';
import { loadEnv } from '../shared/env.js';
import { createApp } from './server.js';

const env = loadEnv();
await runMigrations(env.DATABASE_URL);
const { db } = await connect(env.DATABASE_URL);
const { db: kernelDb } = await connect(env.KERNEL_DATABASE_URL);
const catalog = await loadCatalog(env.BLUEPRINTS_DIR ?? BLUEPRINTS_DIR);
const log = { info: (m: string, meta?: unknown) => console.log(m, meta ?? ''), error: (m: string, e?: unknown) => console.error(m, e ?? '') };
const app = createApp({ env, db, kernelDb, catalog, log, now: () => new Date() });
serve({ fetch: app.fetch, port: env.PORT, hostname: '0.0.0.0' }, (info) => log.info(`control plane listening on ${info.port}`));
```

`src/index.ts` exports `createApp`, `Deps`, `loadEnv`, `Env`, `ApiError`.

- [ ] **Step 8: Run the suite (Postgres from Compose or CI), gates, commit**

Run: `pnpm db:up` is not available until Task 23; for now start a Postgres with `docker run -d --name hf1-test-pg -e POSTGRES_USER=hf1 -e POSTGRES_PASSWORD=hf1 -e POSTGRES_DB=hf1_platform_test -p 15432:5432 pgvector/pgvector:0.8.1-pg16`, then `pnpm --filter @hf1/control-plane test && pnpm typecheck && pnpm lint && pnpm arch && pnpm format:check`.
Expected: green.

```bash
git add -A
git commit -m "feat(control-plane): package, environment, platform schema, migrations and the scratch-database test harness"
```

---

### Task 6: Google sign-in, sessions and the current user

**Files:**
- Create: `control-plane/src/domain/users/{types,repository,service}.ts`, `control-plane/src/app/auth/oidc.ts`, `control-plane/src/app/middleware/session.ts`, `control-plane/src/app/routes/auth.ts`, `control-plane/src/testing/fake-issuer.ts`, `control-plane/src/testing/app.ts`
- Test: `control-plane/src/app/routes/auth.test.ts`, `control-plane/src/domain/users/service.test.ts`
- Modify: `control-plane/src/app/deps.ts` (add `oidc: OidcClient`), `control-plane/src/app/server.ts` (mount)

**Interfaces:**
- Produces: `OidcClient { authorizationUrl(state, verifier, redirectUri): Promise<URL>; exchange(currentUrl: URL, verifier, state, redirectUri): Promise<{ sub; email; name }> }`, `createOidcClient(env): Promise<OidcClient>`; `UsersService { upsertFromGoogle({ sub, email, name }): Promise<User>; byId(id): Promise<User | null> }`; `SessionsRepository { create(userId, ttl): Promise<{ id; expiresAt }>; find(id): Promise<{ userId } | null>; delete(id) }`; middleware `requireUser` setting `c.var.user: User`; routes `GET /api/v1/auth/login`, `GET /api/v1/auth/callback`, `POST /api/v1/auth/logout`, `GET /api/v1/me` → `{ id, email, name, superadmin }`; test harness `testApp(): Promise<TestApp>` with `app`, `db`, `issuer`, `sessionFor(user: { sub; email; name; superadmin? }): Promise<{ user: User; cookie: string }>`, `close()`.
- Cookies: `hf1_login` (signed, 10 min, holds `{ state, verifier }`), `hf1_session` (signed, 30 days, holds the session id). Both `HttpOnly; SameSite=Lax; Path=/`, `Secure` when `PLATFORM_URL` is https.

- [ ] **Step 1: The fake issuer (test only)**

`src/testing/fake-issuer.ts` — an in-process OpenID provider, RS256 via `jose`, served with `@hono/node-server` on a random port:

```ts
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export interface FakeUser { sub: string; email: string; name: string }

export interface FakeIssuer {
  url: string;
  clientId: string;
  clientSecret: string;
  /** The user the next authorization will sign in as. */
  nextUser(user: FakeUser): void;
  close(): Promise<void>;
}

export async function startFakeIssuer(): Promise<FakeIssuer> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256', use: 'sig' };
  let current: FakeUser = { sub: 'nobody', email: 'nobody@example.com', name: 'Nobody' };
  const codes = new Map<string, { user: FakeUser; nonce?: string }>();
  const app = new Hono();
  let url = '';
  app.get('/.well-known/openid-configuration', (c) =>
    c.json({
      issuer: url, authorization_endpoint: `${url}/authorize`, token_endpoint: `${url}/token`, jwks_uri: `${url}/jwks`,
      response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    }),
  );
  app.get('/jwks', (c) => c.json({ keys: [jwk] }));
  app.get('/authorize', (c) => {
    const q = c.req.query();
    const code = `code-${codes.size + 1}`;
    codes.set(code, { user: current, nonce: q.nonce });
    const back = new URL(q.redirect_uri!);
    back.searchParams.set('code', code);
    back.searchParams.set('state', q.state!);
    return c.redirect(back.href);
  });
  app.post('/token', async (c) => {
    const form = await c.req.parseBody();
    const grant = codes.get(String(form.code));
    if (!grant) return c.json({ error: 'invalid_grant' }, 400);
    const idToken = await new SignJWT({ email: grant.user.email, name: grant.user.name, ...(grant.nonce ? { nonce: grant.nonce } : {}) })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer(url).setSubject(grant.user.sub).setAudience('test-client').setIssuedAt().setExpirationTime('5m')
      .sign(privateKey);
    return c.json({ access_token: 'at', token_type: 'Bearer', id_token: idToken, expires_in: 300 });
  });
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  const address = server.address();
  url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  return {
    url, clientId: 'test-client', clientSecret: 'test-secret',
    nextUser: (u) => { current = u; },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
```

- [ ] **Step 2: Failing test — the sign-in flow end to end**

`src/app/routes/auth.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../../testing/app.js';

let t: TestApp;
beforeAll(async () => { t = await testApp(); });
afterAll(() => t.close());

/** Follow the login redirect to the fake issuer, then bring its redirect back to the callback. */
async function signInThroughGoogle(user: { sub: string; email: string; name: string }): Promise<string> {
  t.issuer.nextUser(user);
  const login = await t.app.request('/api/v1/auth/login');
  expect(login.status).toBe(302);
  const loginCookie = login.headers.get('set-cookie')!;
  expect(loginCookie).toMatch(/hf1_login=.*HttpOnly/);
  const atIssuer = await fetch(login.headers.get('location')!, { redirect: 'manual' });
  const back = new URL(atIssuer.headers.get('location')!);
  const callback = await t.app.request(back.pathname + back.search, { headers: { cookie: loginCookie.split(';')[0]! } });
  expect(callback.status).toBe(302);
  expect(callback.headers.get('location')).toBe('/');
  const session = callback.headers.get('set-cookie')!;
  expect(session).toMatch(/hf1_session=.*HttpOnly/);
  return session.split(';')[0]!;
}

describe('auth', () => {
  it('signs a new Google account in, creates the user, and /me answers', async () => {
    const cookie = await signInThroughGoogle({ sub: 'g-1', email: 'Jane@Example.com', name: 'Jane' });
    const me = await t.app.request('/api/v1/me', { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: 'jane@example.com', name: 'Jane', superadmin: false });
  });
  it('the same sub signs in as the same user; a superadmin e-mail gets the flag', async () => {
    const a = await signInThroughGoogle({ sub: 'g-2', email: 'root@example.com', name: 'Root' });
    const b = await signInThroughGoogle({ sub: 'g-2', email: 'root@example.com', name: 'Root R.' });
    const [ma, mb] = await Promise.all([t.app.request('/api/v1/me', { headers: { cookie: a } }), t.app.request('/api/v1/me', { headers: { cookie: b } })]);
    const [ja, jb] = (await Promise.all([ma.json(), mb.json()])) as { id: string; superadmin: boolean }[];
    expect(ja.id).toBe(jb.id);
    expect(jb.superadmin).toBe(true);
  });
  it('a callback with the wrong state is refused; no cookie is a 401; logout clears the session', async () => {
    const bad = await t.app.request('/api/v1/auth/callback?code=x&state=y');
    expect(bad.status).toBe(400);
    expect((await t.app.request('/api/v1/me')).status).toBe(401);
    const cookie = await signInThroughGoogle({ sub: 'g-3', email: 'c@example.com', name: 'C' });
    const out = await t.app.request('/api/v1/auth/logout', { method: 'POST', headers: { cookie } });
    expect(out.status).toBe(204);
    expect((await t.app.request('/api/v1/me', { headers: { cookie } })).status).toBe(401);
  });
});
```

(`testApp()` sets `PLATFORM_SUPERADMINS=root@example.com`.)

- [ ] **Step 3: Implement users, OIDC, session middleware and routes**

`domain/users/types.ts`: `export interface User { id: string; email: string; name: string; superadmin: boolean }`.

`domain/users/repository.ts` (drizzle over `users`, `sessions`):

```ts
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/connect.js';
import { sessions, users } from '../db/schema.js';
import type { User } from './types.js';

export async function upsertUser(db: Db, g: { sub: string; email: string; name: string; superadmin: boolean }): Promise<User> {
  const [row] = await db
    .insert(users)
    .values({ googleSub: g.sub, email: g.email, name: g.name, superadmin: g.superadmin })
    .onConflictDoUpdate({ target: users.googleSub, set: { email: g.email, name: g.name, superadmin: g.superadmin } })
    .returning();
  return { id: row!.id, email: row!.email, name: row!.name, superadmin: row!.superadmin };
}

export async function findUser(db: Db, id: string): Promise<User | null> {
  const row = await db.query.users.findFirst({ where: eq(users.id, id) });
  return row ? { id: row.id, email: row.email, name: row.name, superadmin: row.superadmin } : null;
}

export async function createSession(db: Db, userId: string, ttlMs: number, now: Date): Promise<{ id: string; expiresAt: Date }> {
  const id = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + ttlMs);
  await db.insert(sessions).values({ id, userId, expiresAt });
  return { id, expiresAt };
}

export async function findSession(db: Db, id: string, now: Date): Promise<{ userId: string } | null> {
  const row = await db.query.sessions.findFirst({ where: eq(sessions.id, id) });
  return row && row.expiresAt > now ? { userId: row.userId } : null;
}

export const deleteSession = (db: Db, id: string) => db.delete(sessions).where(eq(sessions.id, id));
```

`domain/users/service.ts`:

```ts
import type { Db } from '../db/connect.js';
import { findUser, upsertUser } from './repository.js';
import type { User } from './types.js';

export function usersService(db: Db, superadmins: readonly string[]) {
  return {
    upsertFromGoogle: (g: { sub: string; email: string; name: string }): Promise<User> => {
      const email = g.email.trim().toLowerCase();
      return upsertUser(db, { sub: g.sub, email, name: g.name.trim() || email, superadmin: superadmins.includes(email) });
    },
    byId: (id: string) => findUser(db, id),
  };
}
```

`app/auth/oidc.ts`:

```ts
import * as oidc from 'openid-client';
import type { Env } from '../../shared/env.js';
import { badRequest } from '../../shared/errors.js';

export interface OidcClient {
  authorizationUrl(state: string, verifier: string, redirectUri: string): Promise<URL>;
  exchange(currentUrl: URL, verifier: string, state: string, redirectUri: string): Promise<{ sub: string; email: string; name: string }>;
}

export async function createOidcClient(env: Env): Promise<OidcClient> {
  const insecure = env.OIDC_ISSUER.startsWith('http://');
  const config = await oidc.discovery(new URL(env.OIDC_ISSUER), env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, undefined, insecure ? { execute: [oidc.allowInsecureRequests] } : undefined);
  return {
    async authorizationUrl(state, verifier, redirectUri) {
      const code_challenge = await oidc.calculatePKCECodeChallenge(verifier);
      return oidc.buildAuthorizationUrl(config, { redirect_uri: redirectUri, scope: 'openid email profile', state, code_challenge, code_challenge_method: 'S256' });
    },
    async exchange(currentUrl, verifier, state, redirectUri) {
      let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
      try {
        tokens = await oidc.authorizationCodeGrant(config, currentUrl, { pkceCodeVerifier: verifier, expectedState: state, redirectUri: redirectUri });
      } catch (err) {
        throw badRequest(`sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      const claims = tokens.claims();
      if (!claims?.sub || typeof claims.email !== 'string') throw badRequest('sign-in failed: no e-mail claim');
      return { sub: claims.sub, email: claims.email, name: typeof claims.name === 'string' ? claims.name : claims.email };
    },
  };
}

export const randomState = () => oidc.randomState();
export const randomVerifier = () => oidc.randomPKCECodeVerifier();
```

`app/middleware/session.ts`:

```ts
import { createMiddleware } from 'hono/factory';
import { getSignedCookie } from 'hono/cookie';
import { findSession } from '../../domain/users/repository.js';
import type { User } from '../../domain/users/types.js';
import { unauthorized } from '../../shared/errors.js';
import type { Deps } from '../deps.js';

export const SESSION_COOKIE = 'hf1_session';
export const LOGIN_COOKIE = 'hf1_login';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export type UserVars = { Variables: { deps: Deps; user: User } };

export const requireUser = createMiddleware<UserVars>(async (c, next) => {
  const deps = c.get('deps');
  const id = await getSignedCookie(c, deps.env.SESSION_SECRET, SESSION_COOKIE);
  if (!id) throw unauthorized();
  const session = await findSession(deps.db, id, deps.now());
  if (!session) throw unauthorized();
  const user = await deps.users.byId(session.userId);
  if (!user) throw unauthorized();
  c.set('user', user);
  await next();
});
```

`app/routes/auth.ts`:

```ts
import { Hono } from 'hono';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import { createSession, deleteSession } from '../../domain/users/repository.js';
import { badRequest } from '../../shared/errors.js';
import { randomState, randomVerifier } from '../auth/oidc.js';
import type { Deps } from '../deps.js';
import { LOGIN_COOKIE, requireUser, SESSION_COOKIE, SESSION_TTL_MS, type UserVars } from '../middleware/session.js';

const redirectUriOf = (deps: Deps) => `${deps.env.PLATFORM_URL}/api/v1/auth/callback`;
const cookieOpts = (deps: Deps, maxAge: number) => ({ httpOnly: true, sameSite: 'Lax' as const, path: '/', secure: deps.env.PLATFORM_URL.startsWith('https://'), maxAge });

export const authRoutes = new Hono<UserVars>()
  .get('/auth/login', async (c) => {
    const deps = c.get('deps');
    const state = randomState();
    const verifier = randomVerifier();
    await setSignedCookie(c, LOGIN_COOKIE, JSON.stringify({ state, verifier }), deps.env.SESSION_SECRET, cookieOpts(deps, 600));
    return c.redirect((await deps.oidc.authorizationUrl(state, verifier, redirectUriOf(deps))).href);
  })
  .get('/auth/callback', async (c) => {
    const deps = c.get('deps');
    const raw = await getSignedCookie(c, deps.env.SESSION_SECRET, LOGIN_COOKIE);
    if (!raw) throw badRequest('sign-in failed: no login in progress');
    const { state, verifier } = JSON.parse(raw) as { state: string; verifier: string };
    const current = new URL(c.req.url);
    const google = await deps.oidc.exchange(current, verifier, state, redirectUriOf(deps));
    const user = await deps.users.upsertFromGoogle(google);
    const session = await createSession(deps.db, user.id, SESSION_TTL_MS, deps.now());
    deleteCookie(c, LOGIN_COOKIE, { path: '/' });
    await setSignedCookie(c, SESSION_COOKIE, session.id, deps.env.SESSION_SECRET, cookieOpts(deps, SESSION_TTL_MS / 1000));
    return c.redirect('/');
  })
  .post('/auth/logout', requireUser, async (c) => {
    const deps = c.get('deps');
    const id = await getSignedCookie(c, deps.env.SESSION_SECRET, SESSION_COOKIE);
    if (id) await deleteSession(deps.db, id);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.body(null, 204);
  })
  .get('/me', requireUser, (c) => c.json(c.get('user')));
```

Mount in `server.ts`: `app.route('/api/v1', authRoutes)`. Add to `Deps`: `oidc: OidcClient; users: ReturnType<typeof usersService>`. `main.ts` builds both.

- [ ] **Step 4: `testApp()`**

`src/testing/app.ts`:

```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadCatalog } from '@hf1/catalog';
import { fixtureBlueprintDir } from '@hf1/catalog/testing';
import { createSession } from '../domain/users/repository.js';
import type { User } from '../domain/users/types.js';
import { usersService } from '../domain/users/service.js';
import { createOidcClient } from '../app/auth/oidc.js';
import { SESSION_TTL_MS } from '../app/middleware/session.js';
import { createApp, type AppType } from '../app/server.js';
import { loadEnv } from '../shared/env.js';
import { scratchDatabase } from './db.js';
import { startFakeIssuer, type FakeIssuer } from './fake-issuer.js';

export interface TestApp {
  app: AppType;
  db: Awaited<ReturnType<typeof scratchDatabase>>['db'];
  issuer: FakeIssuer;
  sessionFor(user: { sub: string; email: string; name: string }): Promise<{ user: User; cookie: string }>;
  close(): Promise<void>;
}

export async function testApp(): Promise<TestApp> {
  const scratch = await scratchDatabase();
  const issuer = await startFakeIssuer();
  const knowledgeDir = await mkdtemp(path.join(tmpdir(), 'hf1-knowledge-'));
  const env = loadEnv({
    DATABASE_URL: scratch.url, KERNEL_DATABASE_URL: scratch.url, HOST_URL: 'http://127.0.0.1:1', HARNESS_HOST_TOKEN: 'host-token',
    HARNESS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), GOOGLE_CLIENT_ID: issuer.clientId, GOOGLE_CLIENT_SECRET: issuer.clientSecret,
    OIDC_ISSUER: issuer.url, SESSION_SECRET: 's'.repeat(40), PLATFORM_URL: 'http://platform.test', PLATFORM_SUPERADMINS: 'root@example.com',
    KNOWLEDGE_DIR: knowledgeDir, KNOWLEDGE_MOUNT: '/srv/knowledge',
  });
  const catalog = await loadCatalog(await fixtureBlueprintDir('fixture-agent'));
  const users = usersService(scratch.db, env.PLATFORM_SUPERADMINS);
  const now = () => new Date();
  const app = createApp({ env, db: scratch.db, kernelDb: scratch.db, catalog, log: { info() {}, error() {} }, now, oidc: await createOidcClient(env), users });
  return {
    app, db: scratch.db, issuer,
    async sessionFor(u) {
      const user = await users.upsertFromGoogle(u);
      const session = await createSession(scratch.db, user.id, SESSION_TTL_MS, now());
      // Sign the cookie the way hono's setSignedCookie does, through a throwaway response.
      const { setSignedCookie } = await import('hono/cookie');
      const { Hono } = await import('hono');
      const probe = new Hono().get('/', async (c) => { await setSignedCookie(c, 'hf1_session', session.id, env.SESSION_SECRET, { path: '/' }); return c.text('ok'); });
      const res = await probe.request('/');
      return { user, cookie: res.headers.get('set-cookie')!.split(';')[0]! };
    },
    close: async () => { await issuer.close(); await scratch.close(); },
  };
}
```

(`testApp` grows one line per later task as `Deps` grows; each task says which.)

- [ ] **Step 5: Run, gates, commit**

Run: `pnpm --filter @hf1/control-plane test && pnpm typecheck && pnpm lint && pnpm arch && pnpm format:check`
Expected: green.

```bash
git add -A
git commit -m "feat(control-plane): sign in with any Google account, sessions and /me"
```

---

### Task 7: Organisations, memberships, invitations, the role guard and audit

**Files:**
- Create: `control-plane/src/domain/organisations/{types,repository,service}.ts`, `control-plane/src/domain/audit/{types,repository}.ts`, `control-plane/src/app/middleware/org.ts`, `control-plane/src/app/routes/orgs.ts`
- Test: `control-plane/src/app/routes/orgs.test.ts`
- Modify: `server.ts` (mount), `deps.ts` (`orgs`, `audit`), `testing/app.ts`

**Interfaces:**
- Produces: `Role = 'owner' | 'admin' | 'member'`, `Organisation { id; slug; name }`; `OrganisationsService { create(user, { slug, name }); listFor(user); bySlugFor(user, slug): Promise<{ org; role: Role | 'viewer' } | null>; members(orgId); setRole(orgId, userId, role); removeMember(orgId, userId); invite(org, byUser, { email, role }); accept(user, token) }`; `AuditRepository { record(db, { userId, organisationId?, agentId?, action, summary }) }`; middleware `requireOrg(min: Role)` reading `:org` and setting `c.var.org`, `c.var.role`; routes: `POST /orgs`, `GET /orgs`, `GET /orgs/:org`, `GET /orgs/:org/members`, `PUT /orgs/:org/members/:userId` (role), `DELETE /orgs/:org/members/:userId`, `POST /orgs/:org/invitations`, `GET /orgs/:org/invitations`, `POST /invitations/:token/accept`.
- Rules: the creator is `owner`; roles rank `owner > admin > member`; a superadmin who is not a member gets role `viewer` on **GET** routes only (and every such read is audited); an org the user cannot see is a 404 (P-1); the last owner cannot be demoted or removed; invitations expire after 7 days and are single-use; accepting an invitation whose e-mail is not the signed-in user's e-mail is a 404 (never reveals the invite).

- [ ] **Step 1: Failing tests (the authorization matrix is the heart of this task)**

`orgs.test.ts` — sixteen cases; the shape of each:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../../testing/app.js';

let t: TestApp;
let owner: { cookie: string; user: { id: string } };
let stranger: { cookie: string; user: { id: string } };
let root: { cookie: string };
beforeAll(async () => {
  t = await testApp();
  owner = await t.sessionFor({ sub: 'o', email: 'owner@example.com', name: 'Owner' });
  stranger = await t.sessionFor({ sub: 's', email: 'stranger@example.com', name: 'Stranger' });
  root = await t.sessionFor({ sub: 'r', email: 'root@example.com', name: 'Root' });
});
afterAll(() => t.close());

const json = (cookie: string, method: string, body?: unknown) => ({ method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

describe('organisations', () => {
  it('a signed-in user creates an organisation and is its owner', async () => {
    const res = await t.app.request('/api/v1/orgs', json(owner.cookie, 'POST', { slug: 'acme', name: 'Acme' }));
    expect(res.status).toBe(201);
    const list = await (await t.app.request('/api/v1/orgs', { headers: { cookie: owner.cookie } })).json();
    expect(list).toEqual([{ id: expect.any(String), slug: 'acme', name: 'Acme', role: 'owner' }]);
  });
  it('a slug must be a slug and unique', async () => {
    expect((await t.app.request('/api/v1/orgs', json(owner.cookie, 'POST', { slug: 'Acme!', name: 'x' }))).status).toBe(400);
    expect((await t.app.request('/api/v1/orgs', json(owner.cookie, 'POST', { slug: 'acme', name: 'x' }))).status).toBe(409);
  });
  it('a non-member gets 404 on every org route, a superadmin reads but cannot write', async () => {
    expect((await t.app.request('/api/v1/orgs/acme', { headers: { cookie: stranger.cookie } })).status).toBe(404);
    expect((await t.app.request('/api/v1/orgs/acme/members', { headers: { cookie: stranger.cookie } })).status).toBe(404);
    expect((await t.app.request('/api/v1/orgs/acme', { headers: { cookie: root.cookie } })).status).toBe(200);
    expect((await t.app.request('/api/v1/orgs/acme/invitations', json(root.cookie, 'POST', { email: 'x@y.z', role: 'member' }))).status).toBe(404);
  });
  it('invite → accept as the invited e-mail → member; wrong e-mail is a 404; second accept is a 404', async () => {
    const inv = await (await t.app.request('/api/v1/orgs/acme/invitations', json(owner.cookie, 'POST', { email: 'new@example.com', role: 'admin' }))).json() as { token: string };
    const other = await t.sessionFor({ sub: 'x', email: 'other@example.com', name: 'X' });
    expect((await t.app.request(`/api/v1/invitations/${inv.token}/accept`, json(other.cookie, 'POST'))).status).toBe(404);
    const invited = await t.sessionFor({ sub: 'n', email: 'new@example.com', name: 'New' });
    expect((await t.app.request(`/api/v1/invitations/${inv.token}/accept`, json(invited.cookie, 'POST'))).status).toBe(200);
    expect((await t.app.request(`/api/v1/invitations/${inv.token}/accept`, json(invited.cookie, 'POST'))).status).toBe(404);
    const members = await (await t.app.request('/api/v1/orgs/acme/members', { headers: { cookie: invited.cookie } })).json() as { role: string }[];
    expect(members.map((m) => m.role).sort()).toEqual(['admin', 'owner']);
  });
  it('an admin cannot change roles; an owner can; the last owner cannot be demoted or removed', async () => {
    const invited = await t.sessionFor({ sub: 'n', email: 'new@example.com', name: 'New' });
    expect((await t.app.request(`/api/v1/orgs/acme/members/${owner.user.id}`, json(invited.cookie, 'PUT', { role: 'member' }))).status).toBe(403);
    expect((await t.app.request(`/api/v1/orgs/acme/members/${owner.user.id}`, json(owner.cookie, 'PUT', { role: 'member' }))).status).toBe(409);
    expect((await t.app.request(`/api/v1/orgs/acme/members/${owner.user.id}`, json(owner.cookie, 'DELETE'))).status).toBe(409);
    expect((await t.app.request(`/api/v1/orgs/acme/members/${invited.user.id}`, json(owner.cookie, 'PUT', { role: 'owner' }))).status).toBe(200);
  });
  it('every write is audited with the user and a summary that names no secret', async () => {
    const rows = await t.db.query.audit.findMany();
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['org.create', 'org.invite', 'org.accept', 'org.role']));
  });
});
```

- [ ] **Step 2: Implement the domain and routes**

`domain/organisations/types.ts`:

```ts
export type Role = 'owner' | 'admin' | 'member';
export const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1 };
export interface Organisation { id: string; slug: string; name: string }
export interface Member { userId: string; email: string; name: string; role: Role }
export interface Invitation { id: string; email: string; role: 'admin' | 'member'; token: string; expiresAt: Date; acceptedAt: Date | null }
```

`domain/organisations/repository.ts`: `insertOrganisation`, `findOrganisationBySlug`, `listOrganisationsFor(userId)` (join memberships), `findMembership(orgId, userId)`, `listMembers(orgId)`, `upsertMembership`, `deleteMembership`, `countOwners(orgId)`, `insertInvitation`, `findInvitationByToken`, `markAccepted`, `listInvitations(orgId)` — each a small drizzle query over the schema of Task 5.

`domain/organisations/service.ts` (the rules live here, not in routes):

```ts
import { randomBytes } from 'node:crypto';
import { ApiError, badRequest, conflict, notFound } from '../../shared/errors.js';
import { SLUG_PATTERN } from '../../shared/ids.js';
import { record } from '../audit/repository.js';
import type { Db } from '../db/connect.js';
import type { User } from '../users/types.js';
import * as repo from './repository.js';
import { ROLE_RANK, type Organisation, type Role } from './types.js';

export const INVITATION_TTL_MS = 7 * 24 * 3600 * 1000;

export function organisationsService(db: Db, now: () => Date) {
  return {
    async create(user: User, input: { slug: string; name: string }): Promise<Organisation> {
      if (!SLUG_PATTERN.test(input.slug)) throw badRequest('slug must be lowercase letters, digits and hyphens, 2–32 characters, letter first');
      if (await repo.findOrganisationBySlug(db, input.slug)) throw conflict(`an organisation with slug "${input.slug}" exists`);
      const org = await repo.insertOrganisation(db, { slug: input.slug, name: input.name.trim(), createdBy: user.id });
      await repo.upsertMembership(db, org.id, user.id, 'owner');
      await record(db, { userId: user.id, organisationId: org.id, action: 'org.create', summary: `created organisation ${org.slug}` });
      return org;
    },
    listFor: (user: User) => repo.listOrganisationsFor(db, user.id),
    /** null when the user may not see the organisation at all (P-1). Superadmins see every org as 'viewer'. */
    async bySlugFor(user: User, slug: string): Promise<{ org: Organisation; role: Role | 'viewer' } | null> {
      const org = await repo.findOrganisationBySlug(db, slug);
      if (!org) return null;
      const membership = await repo.findMembership(db, org.id, user.id);
      if (membership) return { org, role: membership.role };
      if (user.superadmin) {
        await record(db, { userId: user.id, organisationId: org.id, action: 'org.superadmin-read', summary: `superadmin read ${org.slug}` });
        return { org, role: 'viewer' };
      }
      return null;
    },
    members: (orgId: string) => repo.listMembers(db, orgId),
    async setRole(by: User, org: Organisation, userId: string, role: Role) {
      const current = await repo.findMembership(db, org.id, userId);
      if (!current) throw notFound('member');
      if (current.role === 'owner' && role !== 'owner' && (await repo.countOwners(db, org.id)) === 1) throw conflict('the last owner cannot be demoted');
      await repo.upsertMembership(db, org.id, userId, role);
      await record(db, { userId: by.id, organisationId: org.id, action: 'org.role', summary: `set role ${role} on a member` });
    },
    async removeMember(by: User, org: Organisation, userId: string) {
      const current = await repo.findMembership(db, org.id, userId);
      if (!current) throw notFound('member');
      if (current.role === 'owner' && (await repo.countOwners(db, org.id)) === 1) throw conflict('the last owner cannot be removed');
      await repo.deleteMembership(db, org.id, userId);
      await record(db, { userId: by.id, organisationId: org.id, action: 'org.remove-member', summary: 'removed a member' });
    },
    async invite(by: User, org: Organisation, input: { email: string; role: 'admin' | 'member' }) {
      const token = randomBytes(24).toString('base64url');
      const inv = await repo.insertInvitation(db, { organisationId: org.id, email: input.email.trim().toLowerCase(), role: input.role, token, invitedBy: by.id, expiresAt: new Date(now().getTime() + INVITATION_TTL_MS) });
      await record(db, { userId: by.id, organisationId: org.id, action: 'org.invite', summary: `invited ${inv.email} as ${inv.role}` });
      return inv;
    },
    listInvitations: (orgId: string) => repo.listInvitations(db, orgId),
    async accept(user: User, token: string): Promise<Organisation> {
      const inv = await repo.findInvitationByToken(db, token);
      if (!inv || inv.acceptedAt || inv.expiresAt < now() || inv.email !== user.email) throw notFound('invitation');
      await repo.upsertMembership(db, inv.organisationId, user.id, inv.role);
      await repo.markAccepted(db, inv.id, now());
      await record(db, { userId: user.id, organisationId: inv.organisationId, action: 'org.accept', summary: `accepted an invitation as ${inv.role}` });
      return (await repo.findOrganisationById(db, inv.organisationId))!;
    },
    atLeast: (role: Role | 'viewer', min: Role) => role !== 'viewer' && ROLE_RANK[role] >= ROLE_RANK[min],
  };
}
export type OrganisationsService = ReturnType<typeof organisationsService>;
export { ApiError };
```

`domain/audit/repository.ts`: `record(db, { userId, organisationId?, agentId?, action, summary })` inserting into `audit`.

`app/middleware/org.ts`:

```ts
import { createMiddleware } from 'hono/factory';
import type { Organisation, Role } from '../../domain/organisations/types.js';
import { ApiError, notFound } from '../../shared/errors.js';
import type { UserVars } from './session.js';

export type OrgVars = { Variables: UserVars['Variables'] & { org: Organisation; role: Role | 'viewer' } };

/** Resolve `:org`; 404 when invisible (P-1); 403 when visible but below `min`. Viewers pass only GET. */
export const requireOrg = (min: Role) =>
  createMiddleware<OrgVars>(async (c, next) => {
    const deps = c.get('deps');
    const found = await deps.orgs.bySlugFor(c.get('user'), c.req.param('org')!);
    if (!found) throw notFound('organisation');
    const isRead = c.req.method === 'GET';
    if (found.role === 'viewer' ? !isRead : !deps.orgs.atLeast(found.role, min)) {
      if (found.role === 'viewer') throw notFound('organisation');
      throw new ApiError(403, 'forbidden', `this action needs the ${min} role`);
    }
    c.set('org', found.org);
    c.set('role', found.role);
    await next();
  });
```

`app/routes/orgs.ts`: the routes listed in Interfaces, each `zValidator('json', shape)` + `requireUser` + `requireOrg(min)` + one service call; `POST /orgs` → 201 with the org; `GET /orgs` → the list with each role; invitations `POST` returns `{ id, email, role, token, expiresAt }` (the token is what the UI turns into a link; e-mail sending is not in P1 — the owner copies the link).

Add `orgs: OrganisationsService` to `Deps`, build it in `main.ts` and `testing/app.ts`.

- [ ] **Step 3: Run, gates, commit**

Run: `pnpm --filter @hf1/control-plane test && pnpm typecheck && pnpm lint && pnpm arch && pnpm format:check`
Expected: green.

```bash
git add -A
git commit -m "feat(control-plane): organisations, roles, invitations, the org guard and the audit trail"
```

---

### Task 8: Blueprints routes

**Files:**
- Create: `control-plane/src/domain/catalog/service.ts`, `control-plane/src/app/routes/blueprints.ts`
- Test: `control-plane/src/app/routes/blueprints.test.ts`
- Modify: `server.ts`, `deps.ts` (nothing new: `catalog` exists)

**Interfaces:**
- Produces: `GET /api/v1/blueprints` → `[{ name, version, displayName, description, surfaces, pack, kernel }]`; `GET /api/v1/blueprints/:name` → the same plus `{ document, lockset, inputs, schema, changelog }` where `schema` is `documentSchema()` and `document` is the blueprint document (no tenant fields). Both require a signed-in user; no organisation needed.

- [ ] **Step 1: Failing test**

```ts
it('lists the catalogue and describes one blueprint with its schema and lock set', async () => {
  const { cookie } = await t.sessionFor({ sub: 'u', email: 'u@example.com', name: 'U' });
  const list = await (await t.app.request('/api/v1/blueprints', { headers: { cookie } })).json() as { name: string }[];
  expect(list.map((b) => b.name)).toEqual(['fixture-agent']);
  const one = await (await t.app.request('/api/v1/blueprints/fixture-agent', { headers: { cookie } })).json() as { lockset: string[]; schema: { properties: object }; inputs: { pointer: string }[] };
  expect(one.lockset).toEqual(['/routing']);
  expect(Object.keys(one.schema.properties)).toContain('policy');
  expect(one.inputs[0]?.pointer).toBe('/playbooks/playbooks/0/timezone');
  expect((await t.app.request('/api/v1/blueprints/nope', { headers: { cookie } })).status).toBe(404);
  expect((await t.app.request('/api/v1/blueprints')).status).toBe(401);
});
```

- [ ] **Step 2: Implement** — `domain/catalog/service.ts` wraps the `Catalog` with `summary(b)` and `detail(b)` (the two shapes above; `detail` calls `documentSchema()` once and caches it); `routes/blueprints.ts` is two routes behind `requireUser`, mapping `ConfigError` "no blueprint named" to `notFound('blueprint')`.

- [ ] **Step 3: Run, gates, commit** — `git commit -m "feat(control-plane): serve the catalogue"`.

---

### Task 9: Agents — create from a blueprint, drafts, validation

**Files:**
- Create: `control-plane/src/domain/agents/{types,repository,service}.ts`, `control-plane/src/app/middleware/agent.ts`, `control-plane/src/app/routes/agents.ts`
- Test: `control-plane/src/domain/agents/service.test.ts`, `control-plane/src/app/routes/agents.test.ts`
- Modify: `server.ts`, `deps.ts` (`agents`), `testing/app.ts`

**Interfaces:**
- Produces: `Agent { id; organisationId; slug; clientId; displayName; blueprintName; blueprintVersion; draft: Record<string, unknown>; createdAt; updatedAt }`; `AgentsService { create(user, org, { blueprint, slug, displayName, inputs }): Promise<Agent>; list(orgId); byClientIdOrSlug(org, slug); saveDraft(user, agent, patch: { section?: string; value: unknown }): Promise<Agent>; validate(agent): { document: ClientDocument; overlay: Overlay }; principalIdFor(user): string }`; middleware `requireAgent` reading `:agent` (slug) under `:org` and setting `c.var.agent`; routes `POST /orgs/:org/agents` (admin), `GET /orgs/:org/agents` (member), `GET /orgs/:org/agents/:agent` (member) → agent + `{ blueprint: { name, version, lockset, inputs, latest: string } }`, `PUT /orgs/:org/agents/:agent/draft` (admin; body `{ section, value }` or `{ document }`), `POST /orgs/:org/agents/:agent/validate` (admin) → `{ document }`.
- The **web token secret** is not minted here: Task 10 (secrets) adds `agents.create` → `secrets.putRandom(agent, 'web-token')` and a test that a created agent has it. This task creates the draft with `surfaces.web.token = { ref: 'web-token' }` as the blueprint declares.
- `principalIdFor(user)`: `u-` + the first 12 hex of SHA-256 of the user id — stable, no name in it.

- [ ] **Step 1: Failing service tests**

```ts
describe('agents.create', () => {
  it('allocates the client id, applies the inputs and the platform additions, and audits', async () => {
    const agent = await t.deps.agents.create(user, org, { blueprint: 'fixture-agent', slug: 'helper', displayName: 'Helper', inputs: { '/playbooks/playbooks/0/timezone': 'Europe/Bucharest' } });
    expect(agent.clientId).toBe('acme-helper');
    expect(agent.draft.id).toBe('acme-helper');
    expect(agent.draft.knowledge).toEqual({ source: 'dir', path: '/srv/knowledge/acme-helper' });
    const principals = (agent.draft.identity as { principals: { id: string; level: string }[] }).principals;
    expect(principals[0]).toMatchObject({ id: t.deps.agents.principalIdFor(user), level: 'admin' });
  });
  it('refuses a duplicate slug, a missing input and an unknown blueprint', async () => {
    await expect(create({ slug: 'helper' })).rejects.toMatchObject({ status: 409 });
    await expect(create({ slug: 'two', inputs: {} })).rejects.toMatchObject({ status: 400, pointer: '/playbooks/playbooks/0/timezone' });
    await expect(create({ slug: 'three', blueprint: 'nope' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('agents.saveDraft / validate', () => {
  it('saves one section after validating it with the kernel shape', async () => {
    const saved = await t.deps.agents.saveDraft(user, agent, { section: 'policy', value: { classes: { read: 'auto', 'write.internal': 'auto', external: 'approval', financial: 'blocked', destructive: 'approval' }, tools: { hide: ['memory_forget'] } } });
    expect((saved.draft.policy as { tools: { hide: string[] } }).tools.hide).toEqual(['memory_forget']);
  });
  it('refuses an invalid section value with the kernel message, and a locked edit with the pointer (P-2)', async () => {
    await expect(t.deps.agents.saveDraft(user, agent, { section: 'policy', value: { classes: { read: 'maybe' } } })).rejects.toMatchObject({ status: 400 });
    const routing = structuredClone(agent.draft.routing) as { defaults: { num_retries: number } };
    routing.defaults.num_retries = 5;
    await expect(t.deps.agents.saveDraft(user, agent, { section: 'routing', value: routing })).rejects.toMatchObject({ status: 400, pointer: '/routing/defaults/num_retries' });
  });
  it('refuses a draft that changes id or displayName through the document form', async () => {
    await expect(t.deps.agents.saveDraft(user, agent, { document: { ...agent.draft, id: 'other' } })).rejects.toMatchObject({ status: 400, pointer: '/id' });
  });
  it('validate returns the resolved document the kernel accepts', () => {
    const { document } = t.deps.agents.validate(agent);
    expect(document.id).toBe('acme-helper');
  });
});
```

(`TestApp` gains `deps: Deps` so service tests reach the services directly.)

- [ ] **Step 2: Implement**

`domain/agents/service.ts` — the essential logic:

```ts
import { createHash } from 'node:crypto';
import { applyInputs, lockedHit, overlayFor, platformAdditions, resolveDraft, sectionShape, type Catalog, type LoadedBlueprint } from '@hf1/catalog';
import { ConfigError } from '@harness/shared';
import * as z from 'zod/v4';
import { badRequest, conflict, notFound } from '../../shared/errors.js';
import { clientIdFor, SLUG_PATTERN } from '../../shared/ids.js';
import { record } from '../audit/repository.js';
import type { Db } from '../db/connect.js';
import type { Organisation } from '../organisations/types.js';
import type { User } from '../users/types.js';
import * as repo from './repository.js';
import type { Agent } from './types.js';

export function agentsService(db: Db, catalog: Catalog, knowledgeMount: string) {
  const blueprintOf = (agent: Agent): LoadedBlueprint => {
    const b = catalog.get(agent.blueprintName);
    if (b.version !== agent.blueprintVersion) {
      // P1's catalogue holds one version per blueprint; an agent pinned to another version must upgrade first (Task 11).
      throw conflict(`agent is pinned to ${agent.blueprintName}@${agent.blueprintVersion}; the catalogue ships ${b.version} — upgrade before editing`);
    }
    return b;
  };
  const principalIdFor = (user: User) => `u-${createHash('sha256').update(user.id).digest('hex').slice(0, 12)}`;

  function refuseLocked(b: LoadedBlueprint, draft: Record<string, unknown>): void {
    const hit = lockedHit(b.blueprint.lockset, overlayFor(b.blueprint.document as Record<string, unknown>, draft));
    if (hit) throw badRequest(`"${hit.op.path}" is locked by the blueprint ("${hit.locked}")`, hit.op.path);
  }

  return {
    principalIdFor,
    async create(user: User, org: Organisation, input: { blueprint: string; slug: string; displayName: string; inputs: Record<string, unknown> }): Promise<Agent> {
      if (!SLUG_PATTERN.test(input.slug)) throw badRequest('slug must be lowercase letters, digits and hyphens, 2–32 characters, letter first');
      let b: LoadedBlueprint;
      try { b = catalog.get(input.blueprint); } catch { throw notFound('blueprint'); }
      if (await repo.findAgent(db, org.id, input.slug)) throw conflict(`an agent with slug "${input.slug}" exists`);
      const clientId = clientIdFor(org.slug, input.slug);
      let withInputs: Record<string, unknown>;
      try { withInputs = applyInputs(b.blueprint.document as Record<string, unknown>, input.inputs, b.meta.inputs); }
      catch (err) { if (err instanceof ConfigError) throw badRequest(err.message, /"(\/[^"]*)"/.exec(err.message)?.[1]); throw err; }
      const draft = platformAdditions(withInputs, { clientId, displayName: input.displayName.trim(), creator: { principalId: principalIdFor(user), displayName: user.name, webUserId: user.id }, knowledgePath: `${knowledgeMount}/${clientId}` });
      resolveDraft(b, draft); // proves it before a row exists
      const agent = await repo.insertAgent(db, { organisationId: org.id, slug: input.slug, clientId, displayName: input.displayName.trim(), blueprintName: b.name, blueprintVersion: b.version, draft, createdBy: user.id });
      await record(db, { userId: user.id, organisationId: org.id, agentId: agent.id, action: 'agent.create', summary: `created ${clientId} from ${b.name}@${b.version}` });
      return agent;
    },
    list: (orgId: string) => repo.listAgents(db, orgId),
    async bySlug(org: Organisation, slug: string): Promise<Agent | null> { return repo.findAgent(db, org.id, slug); },
    async saveDraft(user: User, agent: Agent, patch: { section?: string; value?: unknown; document?: Record<string, unknown> }): Promise<Agent> {
      const b = blueprintOf(agent);
      let next: Record<string, unknown>;
      if (patch.document) {
        next = patch.document;
        if (next.id !== agent.clientId) throw badRequest('the id is the platform\'s to set', '/id');
        if (next.displayName !== agent.displayName) throw badRequest('rename the agent through its settings, not the document', '/displayName');
      } else if (patch.section) {
        const parsed = sectionShape(patch.section).safeParse(patch.value);
        if (!parsed.success) throw badRequest(`${patch.section} is invalid: ${z.prettifyError(parsed.error)}`, `/${patch.section}`);
        next = { ...agent.draft, [patch.section]: parsed.data };
      } else throw badRequest('send { section, value } or { document }');
      refuseLocked(b, next);
      try { resolveDraft(b, next); } catch (err) { if (err instanceof ConfigError) throw badRequest(err.message, /"(\/[^"]*)"/.exec(err.message)?.[1]); throw err; }
      const saved = await repo.updateDraft(db, agent.id, next);
      await record(db, { userId: user.id, organisationId: agent.organisationId, agentId: agent.id, action: 'agent.draft', summary: patch.section ? `edited ${patch.section}` : 'edited the document' });
      return saved;
    },
    validate(agent: Agent) {
      const b = blueprintOf(agent);
      refuseLocked(b, agent.draft);
      try { return resolveDraft(b, agent.draft); } catch (err) { if (err instanceof ConfigError) throw badRequest(err.message, /"(\/[^"]*)"/.exec(err.message)?.[1]); throw err; }
    },
    blueprintOf,
  };
}
export type AgentsService = ReturnType<typeof agentsService>;
```

`app/middleware/agent.ts`: `requireAgent` after `requireOrg`, `notFound('agent')` when the slug is not in this org; sets `c.var.agent`. `routes/agents.ts`: the five routes with `zValidator` shapes (`slug`, `displayName` 1–120, `inputs` record; draft body union). `GET .../agents/:agent` returns `{ agent, blueprint: { name, version, lockset, inputs, latest: catalog.get(name).version } }`.

- [ ] **Step 3: Run, gates, commit** — `git commit -m "feat(control-plane): create agents from blueprints, edit drafts under the lock set, validate through the kernel"`.

---

### Task 10: The kernel envelope, secrets, and the document-store writer

**Files:**
- Create: `control-plane/src/shared/crypto.ts`, `control-plane/src/domain/kernel/tables.ts`, `control-plane/src/domain/kernel/documents.ts`, `control-plane/src/domain/secrets/{types,repository,service}.ts`
- Test: `control-plane/src/shared/crypto.test.ts`, `control-plane/src/domain/kernel/documents.test.ts`, `control-plane/src/domain/secrets/service.test.ts`
- Modify: `deps.ts` (`secrets`), `domain/agents/service.ts` (mint `web-token` at create), `testing/app.ts`

**Interfaces:**
- Produces: `seal(key: Buffer, plaintext: string, iv?: Buffer): Buffer`, `open(key: Buffer, blob: Buffer): string`, `keyFromBase64(s): Buffer`, `randomToken(): string` (32 bytes, base64url).
- Kernel tables (drizzle, **the write contract of spec §4.3, cited line by line in the file header**): `clientDocuments`, `clientDocumentVersions`, `clientSecrets`.
- `writeDocumentRelease(kernelDb, { document: ClientDocument; version: string; blueprintRef: string; overlay: unknown[]; createdBy: string }): Promise<void>` — one transaction: upsert `client_documents`, insert `client_document_versions`; when the version row already exists with different content, throws `conflict`.
- `writeSecret(kernelDb, clientId, name, ciphertext: Buffer)`, `readSecret(kernelDb, clientId, name): Promise<Buffer | null>`, `deleteSecret(kernelDb, clientId, name)`.
- `SecretsService { put(user, agent, name, value): Promise<void>; putRandom(user, agent, name): Promise<void>; names(agent): Promise<string[]>; remove(user, agent, name); reveal(agent, name): Promise<string | null> }` — `reveal` is for the control plane's own calls to the host (Task 14) and is never routed.
- Secret names match `/^[a-z][a-z0-9-]*$/` (the kernel's `{ ref }` rule).

- [ ] **Step 1: Failing tests — the envelope against the kernel's test vector (spec §4.3)**

`crypto.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { keyFromBase64, open, randomToken, seal } from './crypto.js';

const KEY = keyFromBase64('BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=');
const IV = Buffer.from('030303030303030303030303', 'hex');
const BLOB = Buffer.from('03030303030303030303030338da626a160e623fe0c27fbca31a81945d91db61775c3b310e6d303988259a78', 'hex');

describe('the kernel envelope', () => {
  it('encrypts the test vector byte for byte with the fixed IV', () => {
    expect(seal(KEY, 'xoxb-test-secret', IV).equals(BLOB)).toBe(true);
  });
  it('decrypts the test vector', () => {
    expect(open(KEY, BLOB)).toBe('xoxb-test-secret');
  });
  it('a random IV round-trips and a tampered blob is refused', () => {
    const blob = seal(KEY, 'hello');
    expect(open(KEY, blob)).toBe('hello');
    blob[30] ^= 1;
    expect(() => open(KEY, blob)).toThrow();
  });
  it('refuses a key that is not 32 bytes and yields 43-character tokens', () => {
    expect(() => keyFromBase64('AAAA')).toThrow(/32 bytes/);
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
```

- [ ] **Step 2: Implement `crypto.ts`**

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * The kernel's envelope for `client_secrets.ciphertext` (spec §4.3): AES-256-GCM, raw 32-byte key,
 * 12-byte IV, 16-byte tag, blob = iv || tag || ciphertext, no AAD, UTF-8 plaintext.
 */
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function keyFromBase64(s: string): Buffer {
  const key = Buffer.from(s, 'base64');
  if (key.length !== 32) throw new Error('HARNESS_ENCRYPTION_KEY must decode to 32 bytes');
  return key;
}

export function seal(key: Buffer, plaintext: string, iv: Buffer = randomBytes(IV_BYTES)): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function open(key: Buffer, blob: Buffer): string {
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export const randomToken = (): string => randomBytes(32).toString('base64url');
```

- [ ] **Step 3: Failing tests — the document-store writer**

`documents.test.ts` (against the scratch database's kernel tables):

```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureDocument } from '@hf1/catalog/testing';
import { parseClientDocument } from '@harness/config-api';
import { scratchDatabase } from '../../testing/db.js';
import { writeDocumentRelease } from './documents.js';

let s: Awaited<ReturnType<typeof scratchDatabase>>;
beforeAll(async () => { s = await scratchDatabase(); });
afterAll(() => s.close());

const doc = () => parseClientDocument({ ...fixtureDocument(), id: 'acme-helper', displayName: 'Helper' });

describe('writeDocumentRelease', () => {
  it('writes the live row and the history row in one transaction', async () => {
    await writeDocumentRelease(s.db, { document: doc(), version: 'v1', blueprintRef: 'fixture@1.0.0', overlay: [], createdBy: 'user-1' });
    const live = await s.db.execute(sql`SELECT client_id, version, blueprint_ref FROM client_documents`);
    expect(live.rows).toEqual([{ client_id: 'acme-helper', version: 'v1', blueprint_ref: 'fixture@1.0.0' }]);
    const history = await s.db.execute(sql`SELECT version, created_by FROM client_document_versions ORDER BY created_at`);
    expect(history.rows).toEqual([{ version: 'v1', created_by: 'user-1' }]);
  });
  it('a second version moves the live row and appends history; the same version again is a no-op', async () => {
    const d = doc();
    d.persona = 'changed';
    await writeDocumentRelease(s.db, { document: d, version: 'v2', blueprintRef: 'fixture@1.0.0', overlay: [], createdBy: 'user-1' });
    await writeDocumentRelease(s.db, { document: d, version: 'v2', blueprintRef: 'fixture@1.0.0', overlay: [], createdBy: 'user-1' });
    const history = await s.db.execute(sql`SELECT count(*)::int AS n FROM client_document_versions`);
    expect(history.rows[0]).toEqual({ n: 2 });
  });
  it('refuses the same version string with different content', async () => {
    const d = doc();
    d.persona = 'different again';
    await expect(writeDocumentRelease(s.db, { document: d, version: 'v2', blueprintRef: 'fixture@1.0.0', overlay: [], createdBy: 'user-1' })).rejects.toMatchObject({ status: 409 });
  });
});
```

- [ ] **Step 4: Implement `tables.ts` and `documents.ts`**

`tables.ts`:

```ts
/**
 * The kernel's document store and secret store, as the platform WRITES them.
 *
 * This is not a copy of the kernel's schema: it is the write contract the kernel's boundary spec
 * states in its §6 (this repository's spec §4.3), at the columns of agent-harness 1f7ef57, which
 * the kernel session ruled stable on 2026-09-21. The kernel validates every row again on load; a
 * column added here without the kernel's agreement is a row the kernel refuses.
 */
import { customType, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

export const clientDocuments = pgTable('client_documents', {
  clientId: text('client_id').primaryKey(),
  schemaVersion: integer('schema_version').notNull(),
  document: jsonb('document').$type<Record<string, unknown>>().notNull(),
  version: text('version').notNull(),
  blueprintRef: text('blueprint_ref'),
  overlay: jsonb('overlay').$type<unknown>(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const clientDocumentVersions = pgTable('client_document_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: text('client_id').notNull(),
  version: text('version').notNull(),
  document: jsonb('document').$type<Record<string, unknown>>().notNull(),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const clientSecrets = pgTable(
  'client_secrets',
  {
    clientId: text('client_id').notNull(),
    name: text('name').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.clientId, t.name] })],
);
```

`documents.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import type { ClientDocument } from '@harness/config-api';
import { canonicalJson } from '../../shared/canonical.js';
import { conflict } from '../../shared/errors.js';
import { withTransaction, type Db } from '../db/connect.js';
import { clientDocuments, clientDocumentVersions, clientSecrets } from './tables.js';

export interface DocumentRelease {
  document: ClientDocument;
  version: string;
  blueprintRef: string;
  overlay: unknown[];
  createdBy: string;
}

/** Spec §4.3: both rows in one transaction; the host's watch follows `client_documents.version`. */
export async function writeDocumentRelease(kernelDb: Db, r: DocumentRelease): Promise<void> {
  const document = r.document as unknown as Record<string, unknown>;
  await withTransaction(kernelDb, async (tx) => {
    const existing = await tx.query.clientDocumentVersions.findFirst({
      where: and(eq(clientDocumentVersions.clientId, r.document.id), eq(clientDocumentVersions.version, r.version)),
    });
    if (existing && canonicalJson(existing.document) !== canonicalJson(document)) {
      throw conflict(`version ${r.version} of ${r.document.id} already exists with different content`);
    }
    await tx
      .insert(clientDocuments)
      .values({ clientId: r.document.id, schemaVersion: r.document.schemaVersion, document, version: r.version, blueprintRef: r.blueprintRef, overlay: r.overlay })
      .onConflictDoUpdate({
        target: clientDocuments.clientId,
        set: { schemaVersion: r.document.schemaVersion, document, version: r.version, blueprintRef: r.blueprintRef, overlay: r.overlay, updatedAt: new Date() },
      });
    if (!existing) {
      await tx.insert(clientDocumentVersions).values({ clientId: r.document.id, version: r.version, document, createdBy: r.createdBy });
    }
  });
}

export async function writeSecret(kernelDb: Db, clientId: string, name: string, ciphertext: Buffer): Promise<void> {
  await kernelDb
    .insert(clientSecrets)
    .values({ clientId, name, ciphertext })
    .onConflictDoUpdate({ target: [clientSecrets.clientId, clientSecrets.name], set: { ciphertext, updatedAt: new Date() } });
}

export async function readSecret(kernelDb: Db, clientId: string, name: string): Promise<Buffer | null> {
  const row = await kernelDb.query.clientSecrets.findFirst({ where: and(eq(clientSecrets.clientId, clientId), eq(clientSecrets.name, name)) });
  return row?.ciphertext ?? null;
}

export const deleteSecret = (kernelDb: Db, clientId: string, name: string) =>
  kernelDb.delete(clientSecrets).where(and(eq(clientSecrets.clientId, clientId), eq(clientSecrets.name, name)));
```

(`Db` is typed over the platform schema; give `connect()` a second export `connectKernel(url)` typed over `tables.ts`, and type `Deps.kernelDb` as `KernelDb`. In tests the scratch database serves both.)

- [ ] **Step 5: Failing tests — the secrets service (P-3)**

```ts
describe('secrets', () => {
  it('put stores ciphertext in the kernel table and only the name here; reveal decrypts; names lists', async () => {
    await t.deps.secrets.put(user, agent, 'slack-bot-token', 'xoxb-1');
    expect(await t.deps.secrets.names(agent)).toEqual(['slack-bot-token', 'web-token']);
    const raw = await t.db.execute(sql`SELECT ciphertext FROM client_secrets WHERE client_id = ${agent.clientId} AND name = 'slack-bot-token'`);
    expect(Buffer.from(raw.rows[0]!.ciphertext as Buffer).toString('utf8')).not.toContain('xoxb-1');
    expect(await t.deps.secrets.reveal(agent, 'slack-bot-token')).toBe('xoxb-1');
  });
  it('a created agent has a web-token secret (Task 9 + this task)', async () => {
    expect(await t.deps.secrets.reveal(agent, 'web-token')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it('refuses a name that is not a { ref } name; the audit row names the secret, never the value', async () => {
    await expect(t.deps.secrets.put(user, agent, 'Bad Name', 'x')).rejects.toMatchObject({ status: 400 });
    const rows = await t.db.query.audit.findMany();
    expect(rows.some((r) => r.summary.includes('xoxb-1'))).toBe(false);
    expect(rows.some((r) => r.action === 'secret.put' && r.summary.includes('slack-bot-token'))).toBe(true);
  });
});
```

- [ ] **Step 6: Implement the secrets service; mint `web-token` at agent creation**

```ts
const SECRET_NAME = /^[a-z][a-z0-9-]*$/;

export function secretsService(db: Db, kernelDb: KernelDb, key: Buffer) {
  return {
    async put(user: User, agent: Agent, name: string, value: string) {
      if (!SECRET_NAME.test(name)) throw badRequest('a secret name is lowercase letters, digits and hyphens');
      await writeSecret(kernelDb, agent.clientId, name, seal(key, value));
      await db.insert(secrets).values({ agentId: agent.id, name, updatedBy: user.id }).onConflictDoUpdate({ target: [secrets.agentId, secrets.name], set: { updatedBy: user.id, updatedAt: new Date() } });
      await record(db, { userId: user.id, organisationId: agent.organisationId, agentId: agent.id, action: 'secret.put', summary: `set secret ${name}` });
    },
    putRandom(user: User, agent: Agent, name: string) { return this.put(user, agent, name, randomToken()); },
    async names(agent: Agent) { return (await db.query.secrets.findMany({ where: eq(secrets.agentId, agent.id) })).map((r) => r.name).sort(); },
    async remove(user: User, agent: Agent, name: string) {
      await deleteSecret(kernelDb, agent.clientId, name);
      await db.delete(secrets).where(and(eq(secrets.agentId, agent.id), eq(secrets.name, name)));
      await record(db, { userId: user.id, organisationId: agent.organisationId, agentId: agent.id, action: 'secret.remove', summary: `removed secret ${name}` });
    },
    /** For the control plane's own calls to the host. Never returned by a route. */
    async reveal(agent: Agent, name: string) { const blob = await readSecret(kernelDb, agent.clientId, name); return blob ? open(key, blob) : null; },
  };
}
```

In `agentsService.create`, after `insertAgent`: `await secrets.putRandom(user, agent, 'web-token')` (pass `secrets` into `agentsService`). Build `secrets` before `agents` in `main.ts` and `testing/app.ts`; `Deps` gains `secrets`.

- [ ] **Step 7: Run, gates, commit** — `git commit -m "feat(control-plane): the kernel envelope, per-agent secrets, and the document-store writer"`.

---

### Task 11: Releases — release, list, roll back, upgrade; status and usage from the host

**Files:**
- Create: `control-plane/src/domain/releases/{types,repository,service}.ts`, `control-plane/src/domain/kernel/run-api.ts`, `control-plane/src/testing/fake-host.ts`, `control-plane/src/app/routes/releases.ts`
- Test: `control-plane/src/domain/releases/service.test.ts`, `control-plane/src/domain/kernel/run-api.test.ts`, `control-plane/src/app/routes/releases.test.ts`
- Modify: `deps.ts` (`releases`, `host`), `server.ts`, `testing/app.ts`, `kernel.lock` is read for `kernelVersion`

**Interfaces:**
- Produces: `Release { id; agentId; version; blueprintVersion; kernelVersion; status; error; releasedBy; createdAt; confirmedAt }`; `ReleasesService { release(user, agent): Promise<Release>; list(agent); rollback(user, agent, releaseId): Promise<Agent> (sets the draft to that release's document from the kernel's history and returns the agent; the person then releases); upgrade(user, agent): Promise<Agent> (re-pins to the catalogue's current version; draft unchanged); latestConfirmed(agent) }`; `RunApiClient { status(clientId): Promise<{ version: string | null; open: boolean }>; usage(clientId, from: string, to: string): Promise<unknown>; openRun(clientId, { userId, text, surface?: string }): Promise<{ runId: string }> }` with `createRunApiClient(env)`; `startFakeHost(): Promise<FakeHost>` with `versions: Map<clientId, string>`, `runs: { clientId; body }[]`, `url`, `close()`; routes `POST /orgs/:org/agents/:agent/release` (admin) → 201 Release, `GET .../releases` (member), `GET .../releases/:id/document` (member) → the released document read from the kernel's `client_document_versions` by `(clientId, version)` (404 when the release is not this agent's or not confirmed), `POST .../releases/:id/rollback` (admin) → Agent, `POST .../upgrade` (admin) → Agent, `GET .../status` (member) → `{ live: { version, open } | null; latestRelease: Release | null; upToDate: boolean }`, `GET .../usage?from&to` (member).
- The release algorithm (spec §3.3 step 4, invariants P-2 and P-6): `agents.validate` → `contentVersion(document)` → if `latestConfirmed?.version === version` throw `conflict('nothing to release')` → first confirmed release for this agent? then `knowledge.seed(agent)` (Task 12; until then a no-op hook `deps.knowledge?.seed`) → insert `agent_releases` pending → `writeDocumentRelease(kernelDb, …)` → confirmed; on error → failed with `error` and rethrow as `ApiError(502, 'kernel_write_failed', …)`.
- `kernelVersion` comes from `kernel.lock`'s `version`, read once at start (`readKernelLock()` in `shared/kernel-lock.ts`).

- [ ] **Step 1: The fake host (test only)**

`src/testing/fake-host.ts` — Hono on a random port: `GET /v1/status` and `GET /v1/usage` require `authorization: Bearer host-token` and `x-harness-client`, answering from `versions`; `POST /v1/runs` records `{ clientId, body }` and returns `{ runId: 'run-<n>' }`; a wrong bearer is 401; a missing client header is 400. Web surface routes are added in Task 14.

- [ ] **Step 2: Failing tests**

```ts
describe('releases', () => {
  it('release writes the kernel rows, confirms, and status reports the version once the host serves it (P-6)', async () => {
    const r = await t.deps.releases.release(user, agent);
    expect(r.status).toBe('confirmed');
    expect(r.version).toMatch(/^[0-9a-f]{16}$/);
    const live = await t.db.execute(sql`SELECT version, blueprint_ref FROM client_documents WHERE client_id = ${agent.clientId}`);
    expect(live.rows[0]).toEqual({ version: r.version, blueprint_ref: 'fixture-agent@1.0.0' });
    t.host.versions.set(agent.clientId, r.version);
    const status = await (await t.app.request(`/api/v1/orgs/acme/agents/helper/status`, { headers: { cookie } })).json();
    expect(status).toMatchObject({ live: { version: r.version, open: true }, upToDate: true });
  });
  it('an unchanged draft is nothing to release; a changed one is a new version', async () => {
    await expect(t.deps.releases.release(user, agent)).rejects.toMatchObject({ status: 409 });
    const edited = await t.deps.agents.saveDraft(user, agent, { section: 'persona', value: 'You are the changed assistant.\n' });
    const r2 = await t.deps.releases.release(user, edited);
    expect((await t.deps.releases.list(agent)).map((x) => x.status)).toEqual(['confirmed', 'confirmed']);
    expect(r2.version).not.toBe((await t.deps.releases.list(agent))[1]!.version);
  });
  it('a kernel write failure leaves a failed release with the error and the live row untouched; a retry confirms', async () => {
    await t.db.execute(sql`ALTER TABLE client_documents RENAME TO client_documents_x`);
    const edited = await t.deps.agents.saveDraft(user, agent, { section: 'persona', value: 'Third.\n' });
    await expect(t.deps.releases.release(user, edited)).rejects.toMatchObject({ status: 502 });
    expect((await t.deps.releases.list(agent))[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('client_documents') });
    await t.db.execute(sql`ALTER TABLE client_documents_x RENAME TO client_documents`);
    expect((await t.deps.releases.release(user, edited)).status).toBe('confirmed');
  });
  it('rollback puts an earlier release’s document into the draft, from the kernel’s history', async () => {
    const [, first] = (await t.deps.releases.list(agent)).filter((r) => r.status === 'confirmed').reverse();
    const back = await t.deps.releases.rollback(user, agent, first!.id);
    expect(back.draft.persona).toBe('You are the fixture assistant.\n');
  });
  it('a release with the locked pointer edited is refused before any row is written (P-2)', async () => {
    await t.db.update(agents).set({ draft: { ...agent.draft, routing: { ...(agent.draft.routing as object), defaults: { daily_budget_usd: 9, num_retries: 2, request_timeout_s: 120 } } } }).where(eq(agents.id, agent.id));
    const stale = (await t.deps.agents.bySlug(org, 'helper'))!;
    await expect(t.deps.releases.release(user, stale)).rejects.toMatchObject({ status: 400, pointer: '/routing/defaults/daily_budget_usd' });
    expect((await t.deps.releases.list(agent)).every((r) => r.status !== 'pending')).toBe(true);
  });
});
```

`run-api.test.ts`: `status` sends the bearer and the client header (assert on the fake host's last request), a 401 from the host becomes `ApiError(502)`, `openRun` posts `{ surface: 'http', userId, text }`.

- [ ] **Step 3: Implement**

`domain/kernel/run-api.ts`:

```ts
import { ApiError } from '../../shared/errors.js';

export interface RunApiClient {
  status(clientId: string): Promise<{ version: string | null; open: boolean }>;
  usage(clientId: string, from: string, to: string): Promise<unknown>;
  openRun(clientId: string, run: { userId: string; text: string }): Promise<{ runId: string }>;
}

export function createRunApiClient(hostUrl: string, token: string, fetchImpl: typeof fetch = fetch): RunApiClient {
  const call = async (clientId: string, path: string, init: RequestInit = {}) => {
    const res = await fetchImpl(`${hostUrl}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'x-harness-client': clientId, 'content-type': 'application/json', ...(init.headers ?? {}) } });
    if (!res.ok) throw new ApiError(502, 'host_error', `host answered ${res.status} for ${path}`);
    return res.json() as Promise<Record<string, unknown>>;
  };
  return {
    async status(clientId) {
      const body = await call(clientId, '/v1/status');
      return { version: typeof body.version === 'string' ? body.version : null, open: body.open === true };
    },
    usage: (clientId, from, to) => call(clientId, `/v1/usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    async openRun(clientId, run) {
      const body = await call(clientId, '/v1/runs', { method: 'POST', body: JSON.stringify({ surface: 'http', userId: run.userId, text: run.text }) });
      return { runId: String(body.runId ?? body.id) };
    },
  };
}
```

(The exact field names of `GET /v1/status`'s body are the kernel's; read `harness/host/src/domain/api/routes.ts` at the pinned commit when implementing and adjust the two property reads — nothing else depends on them.)

`domain/releases/service.ts` — `release` as specified in Interfaces, with:

```ts
async release(user: User, agent: Agent): Promise<Release> {
  const { document, overlay } = agents.validate(agent);            // P-2: refuses locked edits before any row
  const version = contentVersion(document);
  const latest = await repo.latestConfirmed(db, agent.id);
  if (latest?.version === version) throw conflict('nothing to release: the draft is what is live');
  if (!latest) await knowledge.seed(agent);
  const pending = await repo.insertRelease(db, { agentId: agent.id, version, blueprintVersion: agent.blueprintVersion, kernelVersion, overlay: overlay.patch as unknown[], status: 'pending', releasedBy: user.id });
  try {
    await writeDocumentRelease(kernelDb, { document, version, blueprintRef: `${agent.blueprintName}@${agent.blueprintVersion}`, overlay: overlay.patch as unknown[], createdBy: user.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await repo.setStatus(db, pending.id, 'failed', message);
    await record(db, { userId: user.id, organisationId: agent.organisationId, agentId: agent.id, action: 'release.failed', summary: `release ${version} failed` });
    throw new ApiError(502, 'kernel_write_failed', `the kernel's document store refused the release: ${message}`);
  }
  const confirmed = await repo.setStatus(db, pending.id, 'confirmed', null, now());
  await record(db, { userId: user.id, organisationId: agent.organisationId, agentId: agent.id, action: 'release.confirmed', summary: `released ${version}` });
  return confirmed;
}
```

`rollback`: find the release (404 if not this agent's), read `client_document_versions` for `(clientId, version)`, `agents.saveDraft(user, agent, { document })` — going through `saveDraft` re-applies the lock check. `upgrade`: `catalog.get(name)`; if equal to the pin, `conflict('already on the current blueprint')`; else `repo.rePin(agent.id, version)` and audit; the next release re-validates.

`routes/releases.ts`: the six routes; `status` composes `host.status(agent.clientId)` (a host error becomes `live: null`) with `latestConfirmed` and `upToDate = live?.version === latest?.version`.

- [ ] **Step 4: Run, gates, commit** — `git commit -m "feat(control-plane): release an agent into the kernel's document store, roll back, upgrade, and read status and usage from the host"`.

---

### Task 12: Knowledge — files on the tenant's directory, seeds, sync

**Files:**
- Create: `control-plane/src/domain/knowledge/{types,store,service}.ts`, `control-plane/src/app/routes/knowledge.ts`
- Test: `control-plane/src/domain/knowledge/store.test.ts`, `control-plane/src/app/routes/knowledge.test.ts`
- Modify: `deps.ts` (`knowledge`), `server.ts`, `testing/app.ts`, `domain/releases/service.ts` (the seed hook becomes real)

**Interfaces:**
- Produces: `KnowledgeStore { list(clientId): Promise<{ filename; bytes }[]>; put(clientId, filename, data: Buffer): Promise<void>; remove(clientId, filename); seed(clientId, files: { filename; data }[]) }` over `KNOWLEDGE_DIR/<clientId>/` with realpath confinement (P-4); `FILENAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/`, no `..`, max 10 MiB per file, 200 files per agent; `KnowledgeService { list(agent); upload(user, agent, filename, data); remove(user, agent, filename); seed(agent) (copies the blueprint's `knowledge/` seeds once — skips names that exist); sync(user, agent): Promise<{ runId }> }`; routes `GET .../knowledge/files` (member), `POST .../knowledge/files` (admin; multipart `file`), `DELETE .../knowledge/files/:filename` (admin), `POST .../knowledge/sync` (admin) → `{ runId }`.
- `sync` opens a run over the run API as the platform's service principal: `host.openRun(agent.clientId, { userId: 'platform', text: 'Refresh the knowledge base now. Follow the knowledge-sync skill exactly, including its silence rule.' })`.

- [ ] **Step 1: Failing store tests (P-4)**

```ts
describe('KnowledgeStore', () => {
  it('writes under <root>/<clientId>/ and lists what it wrote', async () => {
    await store.put('acme-helper', 'hours.md', Buffer.from('# Hours'));
    expect(await store.list('acme-helper')).toEqual([{ filename: 'hours.md', bytes: 7 }]);
  });
  it('refuses a filename with a separator, a dot-dot, a leading dot, or an oversize body', async () => {
    for (const bad of ['../x.md', 'a/b.md', '.env', 'x'.repeat(130)]) await expect(store.put('acme-helper', bad, Buffer.from('x'))).rejects.toMatchObject({ status: 400 });
    await expect(store.put('acme-helper', 'big.md', Buffer.alloc(10 * 1024 * 1024 + 1))).rejects.toMatchObject({ status: 400 });
  });
  it('refuses to follow a symlinked tenant directory out of the root', async () => {
    await symlink(await mkdtemp(path.join(tmpdir(), 'outside-')), path.join(root, 'evil-tenant'));
    await expect(store.put('evil-tenant', 'x.md', Buffer.from('x'))).rejects.toMatchObject({ status: 400 });
  });
  it('seed copies files that do not exist and leaves the ones that do', async () => {
    await store.seed('acme-helper', [{ filename: 'hours.md', data: Buffer.from('SEED') }, { filename: 'welcome.md', data: Buffer.from('W') }]);
    expect((await readFile(path.join(root, 'acme-helper', 'hours.md'))).toString()).toBe('# Hours');
    expect(await store.list('acme-helper')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Implement the store**

```ts
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 200;

export function knowledgeStore(root: string): KnowledgeStore {
  const dirFor = async (clientId: string): Promise<string> => {
    if (!CLIENT_ID_PATTERN.test(clientId)) throw badRequest('not a client id');
    const dir = path.join(root, clientId);
    await mkdir(dir, { recursive: true });
    const [realRoot, realDir] = await Promise.all([realpath(root), realpath(dir)]);
    const rel = path.relative(realRoot, realDir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw badRequest('knowledge directory escapes the knowledge root');
    return realDir;
  };
  const check = (filename: string) => { if (!FILENAME.test(filename) || filename.includes('..')) throw badRequest('a knowledge file name is letters, digits, dot, dash, underscore and space, 1–120 characters, not starting with a dot'); };
  return {
    async list(clientId) { const dir = await dirFor(clientId); const names = (await readdir(dir)).filter((n) => !n.startsWith('.')).sort(); return Promise.all(names.map(async (filename) => ({ filename, bytes: (await stat(path.join(dir, filename))).size }))); },
    async put(clientId, filename, data) { check(filename); if (data.length > MAX_BYTES) throw badRequest('a knowledge file is at most 10 MiB'); const dir = await dirFor(clientId); if ((await readdir(dir)).length >= MAX_FILES) throw badRequest('at most 200 knowledge files per agent'); await writeFile(path.join(dir, filename), data); },
    async remove(clientId, filename) { check(filename); await rm(path.join(await dirFor(clientId), filename), { force: true }); },
    async seed(clientId, files) { const dir = await dirFor(clientId); const existing = new Set(await readdir(dir)); for (const f of files) { check(f.filename); if (!existing.has(f.filename)) await writeFile(path.join(dir, f.filename), f.data); } },
  };
}
```

`knowledge/service.ts` wraps the store with `knowledge_files` rows (sha256, bytes, uploader), audit rows, `seed(agent)` reading the blueprint's `knowledge/` directory (`catalog.get(agent.blueprintName)`, `dir/knowledge/<seed>`), and `sync` via `host.openRun`. Routes as in Interfaces; upload reads `await c.req.parseBody()` and expects `file` to be a `File`.

- [ ] **Step 3: Route tests** — upload as admin → 201 and listed; upload as member → 403; a second organisation's admin → 404; sync → the fake host recorded one run for the agent's client id with `userId: 'platform'`; the first release seeds the blueprint's `welcome.md` (extend Task 11's release test: after the first release, `list` contains `welcome.md`).

- [ ] **Step 4: Run, gates, commit** — `git commit -m "feat(control-plane): knowledge files on the tenant's directory, blueprint seeds, and sync through the run API"`.

---

### Task 13: Connections — the web surface token and the Slack app

**Files:**
- Create: `control-plane/src/domain/connections/{types,slack-manifest,service}.ts`, `control-plane/src/app/routes/connections.ts`
- Test: `control-plane/src/domain/connections/slack-manifest.test.ts`, `control-plane/src/app/routes/connections.test.ts`
- Modify: `deps.ts` (`connections`), `server.ts`, `testing/app.ts`

**Interfaces:**
- Produces: `Connections { web: { enabled: true; tokenRotatedAt: Date | null }; slack: { connected: boolean; teamId: string | null } }`; `slackManifest(agent: { displayName; clientId }, platformUrl): SlackManifest` (JSON: `display_information.name`, `features.bot_user`, `oauth_config.scopes.bot` = `chat:write, app_mentions:read, channels:history, groups:history, im:history, im:read, im:write, mpim:history, users:read, usergroups:read, files:read, files:write`, `settings.event_subscriptions.request_url` = `${platformUrl}/tenants/${clientId}/slack/events` with `bot_events` = `message.channels, message.groups, message.im, message.mpim, app_mention`, `settings.interactivity.request_url` = the same URL, `settings.socket_mode_enabled: false`); `ConnectionsService { describe(agent); rotateWebToken(user, agent); connectSlack(user, agent, { teamId, botToken, signingSecret }): Promise<Agent>; disconnectSlack(user, agent): Promise<Agent> }`; routes `GET .../connections` (member), `POST .../connections/web/rotate` (admin), `GET .../connections/slack/manifest` (admin) → the JSON, `PUT .../connections/slack` (admin; body `{ teamId, botToken, signingSecret }`) → Agent, `DELETE .../connections/slack` (admin) → Agent.
- `connectSlack`: `secrets.put(…, 'slack-bot-token', botToken)`, `secrets.put(…, 'slack-signing-secret', signingSecret)`, then `agents.saveDraft(user, agent, { section: 'surfaces', value: { ...draft.surfaces, slack: { teamId, signingSecret: { ref: 'slack-signing-secret' }, botToken: { ref: 'slack-bot-token' } } } })`. `disconnectSlack` removes the section and both secrets. A token that does not start with `xoxb-` or a team id not matching `/^T[A-Z0-9]{8,}$/` is a 400. The response never echoes a token (P-3).

- [ ] **Step 1: Failing tests** — the manifest is a snapshot (`expect(slackManifest(...)).toMatchSnapshot()`) and asserts the two request URLs; `PUT` as admin → the agent's draft has `surfaces.slack` with `{ ref }` values and no literal token anywhere in the response body (`expect(JSON.stringify(body)).not.toContain('xoxb-')`), and `client_secrets` has both names; `PUT` with `xoxa-` → 400; `DELETE` removes the section and the secret names; `GET connections` reports `slack.connected`.

- [ ] **Step 2: Implement** as in Interfaces (`slack-manifest.ts` is one pure function; the service composes `secrets` and `agents`).

- [ ] **Step 3: Run, gates, commit** — `git commit -m "feat(control-plane): the web connection and the Slack connection with a generated app manifest"`.

---

### Task 14: Chat and inbox — proxying the tenant's web surface

**Files:**
- Create: `control-plane/src/domain/kernel/web-surface.ts`, `control-plane/src/domain/chat/service.ts`, `control-plane/src/app/routes/chat.ts`
- Test: `control-plane/src/domain/kernel/web-surface.test.ts`, `control-plane/src/app/routes/chat.test.ts`
- Modify: `testing/fake-host.ts` (web surface routes), `deps.ts` (`web`, `chat`), `server.ts`, `testing/app.ts`

**Interfaces:**
- Consumes the 11c web surface contract (spec §4.3): under `${HOST_URL}/tenants/<clientId>/web`: `POST /messages` `{ userId, conversation, text, attachments?: string[] }` → `{ accepted: true }`; `GET /stream?conversation=` → `text/event-stream` with events `reply` (`{ delta?: string; final?: { id: string; text: string } }`), `card` (`{ card: Card }`), `card-update` (`{ ref, card }`), `notice` (`{ text }`); `POST /actions` `{ userId, conversation, actionId, value, messageRef }` → `{ accepted: true }`; `POST /forms` `{ userId, conversation, formId, metadata, values }` → `{ accepted: true }`. Every request `authorization: Bearer <web-token>`. (If 11c's shipped names differ, this file and the fake host change together; nothing else knows them.)
- Produces: `WebSurfaceClient { message(clientId, token, body); stream(clientId, token, conversation, signal): Promise<Response>; action(clientId, token, body); form(clientId, token, body) }`; `ChatService { conversationFor(user, agent): string ('u-' + user.id); send(user, agent, text); stream(user, agent, signal): Promise<Response>; act(user, agent, { actionId, value, messageRef }); submit(user, agent, { formId, metadata, values }) }`; routes `POST .../chat/messages` (member), `GET .../chat/stream` (member; SSE passthrough), `POST .../chat/actions` (member), `POST .../chat/forms` (member), `GET .../chat/conversation` → `{ conversation }`.
- P-5: the token is read with `secrets.reveal(agent, 'web-token')` inside the service and added server-side; no route returns it. The `userId` sent to the surface is the platform user's id (the same value `platformAdditions` put into the creator's `surfaces.web`, and what `identity.defaults.web: member` covers for everyone else).

- [ ] **Step 1: Fake host web surface** — add to `fake-host.ts`: per-tenant `tokens: Map<clientId, string>` (the test sets it from `secrets.reveal`); the four routes; `POST /messages` records and pushes `reply` events (`delta: 'Hello '`, `delta: 'there'`, then `final`) plus one `card` event onto the conversation's stream; `GET /stream` is a `streamSSE` that replays the pushed events then stays open until the client aborts; a wrong bearer is 401.

- [ ] **Step 2: Failing route tests**

```ts
it('a member sends a message and reads the reply stream; the browser never sees the token (P-5)', async () => {
  t.host.tokens.set(agent.clientId, (await t.deps.secrets.reveal(agent, 'web-token'))!);
  const sent = await t.app.request('/api/v1/orgs/acme/agents/helper/chat/messages', json(member.cookie, 'POST', { text: 'hi' }));
  expect(sent.status).toBe(202);
  expect(t.host.messages.at(-1)).toMatchObject({ clientId: agent.clientId, body: { userId: member.user.id, conversation: `u-${member.user.id}`, text: 'hi' } });
  const ctrl = new AbortController();
  const res = await t.app.request('/api/v1/orgs/acme/agents/helper/chat/stream', { headers: { cookie: member.cookie }, signal: ctrl.signal });
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const text = await readUntil(res.body!, 'event: card');
  expect(text).toContain('data: {"delta":"Hello "}');
  expect(text).not.toContain(t.host.tokens.get(agent.clientId));
  ctrl.abort();
});
it('a stranger is a 404; a wrong web token at the host is a 502 with no token in the message', async () => { /* … */ });
```

- [ ] **Step 3: Implement** — `web-surface.ts` builds the four `fetch` calls; `stream` returns the upstream `Response` (its body is piped through by the route with `c.body(res.body, 200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })`). `chat/service.ts` composes `secrets.reveal` + `web`.

- [ ] **Step 4: Run, gates, commit** — `git commit -m "feat(control-plane): chat and inbox through the tenant's web surface, token added server-side"`.

---

### Task 15: The typed client entry, admin routes, and the OpenAPI-free contract test

**Files:**
- Create: `control-plane/src/client.ts`, `control-plane/src/app/routes/admin.ts`
- Test: `control-plane/src/client.test.ts`, `control-plane/src/app/routes/admin.test.ts`
- Modify: `server.ts` (mount every route file with `.route()` chaining so `AppType` carries all routes), `index.ts`

**Interfaces:**
- Produces: `client.ts`:

```ts
import { hc } from 'hono/client';
import type { AppType } from './app/server.js';

/** The workspace's one import from this repository. `fetch` is injected so a server component can forward the session cookie. */
export const createClient = (baseUrl: string, init?: { fetch?: typeof fetch; headers?: Record<string, string> }) =>
  hc<AppType>(baseUrl, { fetch: init?.fetch, headers: init?.headers });
export type ApiClient = ReturnType<typeof createClient>;
export type { AppType };
```

- Admin: `GET /api/v1/admin/orgs` and `GET /api/v1/admin/agents` (superadmin only; 404 for everyone else, so the route's existence is not confirmed).

- [ ] **Step 1: Failing tests** — `client.test.ts`: `createClient('http://x', { fetch: (input, init) => t.app.request(input, init) })` then `client.api.v1.orgs.$get({}, { headers: { cookie } })` is typed and returns the organisations (compile-time: `// @ts-expect-error` on a route that does not exist). `admin.test.ts`: superadmin lists both; a normal user is 404.

- [ ] **Step 2: Implement** and make `server.ts` return the chained app so `AppType` is the full route tree:

```ts
const routes = app
  .route('/api/v1', authRoutes)
  .route('/api/v1', orgsRoutes)
  .route('/api/v1', blueprintsRoutes)
  .route('/api/v1', agentsRoutes)
  .route('/api/v1', releasesRoutes)
  .route('/api/v1', knowledgeRoutes)
  .route('/api/v1', connectionsRoutes)
  .route('/api/v1', chatRoutes)
  .route('/api/v1', adminRoutes);
return routes;
```

- [ ] **Step 3: Run, gates, commit** — `git commit -m "feat(control-plane): the typed client entry and the superadmin routes"`.

---

### Task 16: The workspace shell — Next.js, the API client, sign-in, organisations

**Files:**
- Create: `apps/workspace/package.json`, `next.config.ts`, `tsconfig.json`, `postcss.config.mjs`, `app/globals.css`, `lib/api.ts`, `lib/session.ts`, `app/layout.tsx`, `app/page.tsx`, `app/login/page.tsx`, `app/orgs/new/page.tsx`, `app/orgs/new/actions.ts`, `app/o/[org]/layout.tsx`, `app/o/[org]/page.tsx`, `components/{Shell,Nav,Card,Field,Button,Notice}.tsx`, `app/invitations/[token]/page.tsx`
- Test: `apps/workspace/lib/api.test.ts` (vitest, node environment)
- Modify: `.dependency-cruiser.cjs` (no change: the workspace rules exist), root `package.json` `arch` glob (exists)

**Interfaces:**
- Consumes: `@hf1/control-plane/client` (`createClient`, `ApiClient`).
- Produces: `serverApi(): Promise<ApiClient>` (server-only: forwards the incoming `cookie` header, base `CONTROL_PLANE_URL`), `browserApi(): ApiClient` (base `''`, same origin, `credentials: 'include'`); `me(): Promise<Me | null>` for layouts (redirects to `/login` when null via `requireMe()`); the page tree of spec §5.3 for this task: `/login` (a button to `/api/v1/auth/login`), `/` (redirect to the first organisation or `/orgs/new`), `/orgs/new` (form → `POST /api/v1/orgs` through a server action → redirect to `/o/<slug>`), `/o/[org]` (agents list placeholder: "No agents yet" + "New agent" link), `/invitations/[token]` (accept → redirect).
- Environment (server-only): `CONTROL_PLANE_URL` (internal, e.g. `http://control-plane:8790`), read in `next.config.ts` and exposed through `serverRuntimeConfig`-free means: a `lib/env.ts` marked `import 'server-only'` reading `process.env.CONTROL_PLANE_URL` (the one allowed place besides `next.config.ts` — add `apps/workspace/lib/env.ts` to the ESLint exemption list).

- [ ] **Step 1: Scaffold** — `pnpm create next-app@latest apps/workspace --ts --tailwind --app --src-dir=false --import-alias "@/*" --eslint=false --turbopack`, then trim: remove the sample page, add `"@hf1/control-plane": "workspace:*"` (for the `client` entry only), `vitest`, `@playwright/test`, and scripts `dev`, `build`, `start`, `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `e2e` (`playwright test`). Pin the versions the scaffold picked. `tsconfig.json` extends nothing from the root (Next.js owns it) but sets `"strict": true`.

- [ ] **Step 2: `lib/api.ts` and its test**

```ts
import { createClient, type ApiClient } from '@hf1/control-plane/client';

export type { ApiClient };

/** In a server component or action: same-process fetch to the control plane with the person's cookie forwarded. */
export async function serverApi(): Promise<ApiClient> {
  const { headers } = await import('next/headers');
  const { controlPlaneUrl } = await import('./env');
  const cookie = (await headers()).get('cookie') ?? '';
  return createClient(controlPlaneUrl(), { headers: { cookie } });
}

/** In a client component: same origin, the browser sends the cookie. */
export function browserApi(): ApiClient {
  return createClient('', { fetch: (input, init) => fetch(input, { ...init, credentials: 'include' }) });
}

/** The control plane's error shape, as thrown by `unwrap`. */
export class ApiFailure extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly pointer?: string) { super(message); }
}

export async function unwrap<T>(res: Response): Promise<T> {
  if (res.ok) return res.json() as Promise<T>;
  const body = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string; pointer?: string } };
  throw new ApiFailure(res.status, body.error?.code ?? 'error', body.error?.message ?? res.statusText, body.error?.pointer);
}
```

`api.test.ts`: `unwrap` on a 400 `{ error: { code: 'bad_request', message: 'x', pointer: '/y' } }` throws `ApiFailure` with the pointer; on 200 returns the body.

- [ ] **Step 3: Session helper and pages** — `lib/session.ts`: `me()` calls `api.api.v1.me.$get()` and returns `null` on 401; `requireMe()` redirects to `/login`. `app/layout.tsx`: the `Shell` (top bar with the product name "hf1 OS", the person's name, organisation switcher from `GET /orgs`, sign-out form posting to `/api/v1/auth/logout` through a server action that forwards the cookie). Pages as in Interfaces; forms are server actions calling `serverApi()` and `redirect()`; errors from `ApiFailure` render in a `Notice`.

- [ ] **Step 4: Run, gates, commit** — `pnpm --filter @hf1/workspace typecheck && pnpm --filter @hf1/workspace build` plus the root gates (`pnpm arch` now cruises the workspace: it must show the one edge to `control-plane/src/client.ts` and none to `@harness/*`). `git commit -m "feat(workspace): the Next.js shell, Google sign-in, organisations and invitations"`.

---

### Task 17: Creating an agent and the agent overview

**Files:**
- Create: `app/o/[org]/agents/new/page.tsx`, `app/o/[org]/agents/new/actions.ts`, `app/o/[org]/agents/new/InputsForm.tsx`, `app/o/[org]/agents/[agent]/layout.tsx`, `app/o/[org]/agents/[agent]/page.tsx`, `app/o/[org]/agents/[agent]/StatusBadge.tsx`, `components/Tabs.tsx`
- Modify: `app/o/[org]/page.tsx` (the agents list)

**Interfaces:**
- `/o/[org]/agents/new`: step 1 lists `GET /blueprints` as cards (display name, description, surfaces, pack, version); step 2 (`?blueprint=<name>`) renders slug, display name and the blueprint's `inputs` as fields with `hint` and `example` placeholder; the server action posts `POST /orgs/:org/agents` and redirects to the agent.
- `/o/[org]/agents/[agent]` layout: header (display name, blueprint@version, `StatusBadge`), `Tabs` linking the twelve tab routes of spec §5.3. Overview page: latest release, live version, up-to-date flag from `GET .../status`, connections summary, "Release" button (server action → `POST .../release`, shows the `ApiFailure` message and pointer on failure). `StatusBadge` is a client island polling `GET .../status` every 10 s.

- [ ] **Step 1: Implement**, then **Step 2:** `pnpm --filter @hf1/workspace typecheck && build` and the gates; commit `feat(workspace): create an agent from a blueprint and show its overview`.

---

### Task 18: Editors, part one — persona, policy, models (read-only)

**Files:**
- Create: `components/editors/{LockedNotice,SectionForm,PersonaEditor,PolicyEditor,RoutingView}.tsx`, `lib/locks.ts`, `app/o/[org]/agents/[agent]/{persona,policy,models}/page.tsx`, `app/o/[org]/agents/[agent]/actions.ts` (the `saveSection` server action)
- Test: `apps/workspace/lib/locks.test.ts`

**Interfaces:**
- `lib/locks.ts`: `isLocked(lockset: string[], pointer: string): boolean` (segment-wise overlap, both directions — the same rule as the catalogue's `pointersOverlap`, written here because the workspace may not import the catalogue), `lockedReason(lockset, pointer): string | null`.
- `SectionForm` (client): takes `section`, `initial`, `lockset`, `onSave(value)`; shows a `LockedNotice` ("Locked by the blueprint: `<pointer>`. This section is fixed in <blueprint>@<version>.") and disables inputs when `isLocked(lockset, '/' + section)`; renders the server-returned `ApiFailure` (message + pointer) next to the field the pointer names.
- `PersonaEditor`: a textarea with a markdown preview toggle; `PolicyEditor`: five class rows (`read`, `write.internal`, `external`, `financial`, `destructive`) × `auto | approval | blocked` radios, an optional `levels` table (member, practitioner, lead, admin × class), and a `tools.hide` chip list; `RoutingView`: the five routes as a read-only table with the lock notice (spec decision 9).
- `saveSection(org, agent, section, value)` server action → `PUT .../draft` `{ section, value }`; on success `revalidatePath`.

- [ ] **Step 1: `locks.test.ts`** — overlap both ways, `/policy` vs `/policyOverride`. **Step 2: Implement.** **Step 3:** gates, commit `feat(workspace): persona and policy editors under the lock set; models read-only`.

---

### Task 19: Editors, part two — people, playbooks, skills

**Files:**
- Create: `components/editors/{PeopleEditor,PlaybooksEditor,SkillsEditor}.tsx`, `app/o/[org]/agents/[agent]/{people,playbooks,skills}/page.tsx`

**Interfaces:**
- `PeopleEditor`: the `identity.principals` table (id, kind, level, display name, per-surface ids for `web`, `slack`, `http`), `identity.defaults` per surface (`web`, `slack`) as level selects, and the identity plug-in choice (`static` | `slack-groups` with its `settings` as a small form: surface, groups list `{ id, level }`, exceptions, `sync.everySeconds`). The platform's own principals (`svc-host`, `svc-playbooks`, `svc-platform`, the creator's `u-…`) are shown but the service ones cannot be removed.
- `PlaybooksEditor`: the list of entries (name, cron `schedule` with a five-field helper, IANA `timezone` select, skill, prompt, principal select from the service principals, deliver `none | conversation`, cost cap, timeout); add/remove.
- `SkillsEditor`: name → markdown, add/remove, with the note that the frontmatter `name` must equal the key (kernel constraint 8 in the boundary spec).
- All three save through `saveSection` with their section name; errors show at the pointer.

- [ ] **Step 1: Implement.** **Step 2:** gates, commit `feat(workspace): people, playbooks and skills editors`.

---

### Task 20: Knowledge, connections, releases and usage tabs

**Files:**
- Create: `app/o/[org]/agents/[agent]/knowledge/{page.tsx,Uploader.tsx,actions.ts}`, `.../connections/{page.tsx,SlackConnect.tsx,actions.ts}`, `.../releases/{page.tsx,Diff.tsx,actions.ts}`, `.../usage/page.tsx`, `lib/diff.ts`
- Test: `apps/workspace/lib/diff.test.ts`

**Interfaces:**
- Knowledge: list with size and uploader; `Uploader` posts multipart to `POST .../knowledge/files` via `browserApi()`; delete; "Sync now" → `POST .../knowledge/sync` and shows the run id.
- Connections: Web — "always on", token rotate button; Slack — when not connected: the manifest as a downloadable JSON and the four steps (create app from manifest at api.slack.com → install to workspace → copy bot token and signing secret → paste here with the workspace's team id), a form posting `PUT .../connections/slack`; when connected: team id and a disconnect button. Tokens are never rendered back.
- Releases: the list (version, blueprint version, kernel version, status, who, when, error); "Compare" between two confirmed releases showing `lib/diff.ts`'s pointer-level diff of the two documents read from `GET .../releases/:id/document` (Task 11); "Roll back" → `POST .../releases/:id/rollback` then a notice "draft updated; release to make it live"; "Upgrade blueprint" when `latest !== version`.
- Usage: `GET .../usage?from&to` with a date range (default last 30 days) as a table per principal per day: runs, tokens, cost, seconds — no charts in P1.
- `lib/diff.ts`: `diffDocuments(a, b): { pointer: string; before: unknown; after: unknown }[]` — a recursive walk emitting leaf changes (arrays compared by index), pure, tested.

- [ ] **Step 1: `diff.test.ts`**, **Step 2: implement**, **Step 3:** gates, commit `feat(workspace): knowledge, connections, releases and usage tabs`.

---

### Task 21: Chat and inbox

**Files:**
- Create: `app/o/[org]/agents/[agent]/chat/{page.tsx,Chat.tsx}`, `app/o/[org]/agents/[agent]/inbox/{page.tsx,Inbox.tsx}`, `lib/sse.ts`, `components/CardView.tsx`
- Test: `apps/workspace/lib/sse.test.ts`

**Interfaces:**
- `lib/sse.ts`: `subscribe(url, onEvent: (name, data) => void, signal): void` over `EventSource` (the browser API; same-origin, cookie sent), reconnecting with backoff; tested with a fake `EventSource` class.
- `Chat` (client): message list, composer → `POST .../chat/messages`; subscribes to `GET .../chat/stream`; `reply` events append deltas into the current assistant bubble and `final` closes it; `notice` renders as a system line; `card` renders a `CardView` inline.
- `Inbox` (client): subscribes to the same stream and keeps only `card` and `card-update` events, newest first; `CardView` renders the kernel's `Card` (title, subtitle, notice, body lines: text, label/value, code, note parts; actions as buttons posting `POST .../chat/actions` with `{ actionId, value, messageRef }`; a `Form` opens as a modal posting `POST .../chat/forms`).

- [ ] **Step 1: `sse.test.ts`**, **Step 2: implement**, **Step 3:** gates, commit `feat(workspace): chat and the approvals inbox over the web surface`.

---

### Task 22: Organisation settings and the admin page

**Files:**
- Create: `app/o/[org]/settings/{page.tsx,actions.ts,Members.tsx}`, `app/admin/page.tsx`

**Interfaces:**
- Settings (owner sees everything; admin and member see the list read-only): members with role selects (`PUT .../members/:userId`), remove, pending invitations with the accept link (`${PLATFORM_URL}/invitations/<token>`) and a copy button, "Invite" form (`POST .../invitations`).
- `/admin` (superadmin; otherwise 404 page): organisations and agents from the two admin routes, read-only, each linking into the org as viewer.

- [ ] **Step 1: Implement**, **Step 2:** gates, commit `feat(workspace): organisation settings and the superadmin page`.

---

### Task 23: The platform stack — Compose, Caddy, Postgres, LiteLLM, images

**Files:**
- Create: `deploy/compose/docker-compose.yml`, `deploy/compose/Caddyfile`, `deploy/compose/postgres/init.sql`, `deploy/compose/litellm.config.yaml`, `deploy/compose/.env.example`, `deploy/compose/control-plane.Dockerfile`, `deploy/compose/workspace.Dockerfile`
- Test: `control-plane/src/app/compose.test.ts` (reads the Compose file: every `HARNESS_*` the host service sets is documented in `.env.example`; the host has no `HARNESS_CLIENT` value, `HARNESS_CONFIG_SOURCE=postgres`, `HARNESS_SECRET_SOURCE=postgres`; no service has a `docker.sock` mount; the control plane and the host share `HARNESS_ENCRYPTION_KEY`)
- Modify: `README.md`

- [ ] **Step 1: `docker-compose.yml`**

```yaml
# The hf1 platform stack: one server, one pooled kernel host, everything else beside it (spec §7).
# Every variable is interpolated from deploy/compose/.env; run through the pnpm scripts.
name: hf1-platform

services:
  postgres:
    image: pgvector/pgvector:0.8.1-pg16
    environment: { POSTGRES_USER: hf1, POSTGRES_PASSWORD: '${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}', POSTGRES_DB: hf1_platform }
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./postgres/init.sql:/docker-entrypoint-initdb.d/01-init.sql:ro
    healthcheck: { test: ['CMD-SHELL', 'pg_isready -U hf1 -d hf1_platform'], interval: 5s, timeout: 3s, retries: 10 }

  litellm:
    image: ghcr.io/berriai/litellm:main-stable
    depends_on: { postgres: { condition: service_healthy } }
    command: ['--config', '/app/config.yaml', '--port', '4000']
    environment:
      LITELLM_MASTER_KEY: '${LITELLM_MASTER_KEY:?set LITELLM_MASTER_KEY}'
      DATABASE_URL: 'postgres://hf1:${POSTGRES_PASSWORD}@postgres:5432/litellm'
      GEMINI_API_KEY: '${GEMINI_API_KEY:-}'
      GROQ_API_KEY: '${GROQ_API_KEY:-}'
    volumes: ['./litellm.config.yaml:/app/config.yaml:ro']
    healthcheck:
      test: ['CMD-SHELL', 'python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen(''http://127.0.0.1:4000/health/liveliness'').status==200 else 1)"']
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 30s

  files:
    image: ghcr.io/mgavrila/agent-harness-files:${HARNESS_IMAGE_TAG:?set HARNESS_IMAGE_TAG}
    restart: unless-stopped
    networks: [files]
    environment: { HARNESS_STORAGE_DIR: /srv/harness-storage, HARNESS_FILES_PORT: '8790', HARNESS_FILES_BIND: 0.0.0.0 }
    volumes: ['storage:/srv/harness-storage']

  host:
    # The kernel, pooled: HARNESS_CLIENT is empty, tenants come from the document store, secrets from
    # the secret store, knowledge from the volume the control plane writes. Nothing per tenant here.
    image: ghcr.io/mgavrila/agent-harness-host:${HARNESS_IMAGE_TAG:?set HARNESS_IMAGE_TAG}
    restart: unless-stopped
    networks: [default, files]
    depends_on: { postgres: { condition: service_healthy }, litellm: { condition: service_healthy } }
    environment:
      DATABASE_URL: 'postgres://hf1:${POSTGRES_PASSWORD}@postgres:5432/harness'
      HARNESS_ENCRYPTION_KEY: '${HARNESS_ENCRYPTION_KEY:?set HARNESS_ENCRYPTION_KEY}'
      HARNESS_CLIENT: ''
      HARNESS_CONFIG_SOURCE: postgres
      HARNESS_SECRET_SOURCE: postgres
      HARNESS_STORAGE_DIR: /srv/harness-storage
      HARNESS_HOST_PRINCIPAL: svc-host
      HARNESS_GATEWAY_URL: http://litellm:4000
      HARNESS_FILES_URL: http://files:8790
      LITELLM_MASTER_KEY: '${LITELLM_MASTER_KEY}'
      HARNESS_RUN_MAX_MODEL_CALLS: '${HARNESS_RUN_MAX_MODEL_CALLS:-30}'
      HARNESS_RUN_MAX_TOOL_CALLS: '${HARNESS_RUN_MAX_TOOL_CALLS:-60}'
      HARNESS_RUN_TIMEOUT_S: '${HARNESS_RUN_TIMEOUT_S:-600}'
      HARNESS_HISTORY_MAX_MESSAGES: '${HARNESS_HISTORY_MAX_MESSAGES:-40}'
      HARNESS_HOST_TOKEN: '${HARNESS_HOST_TOKEN:?set HARNESS_HOST_TOKEN}'
      HARNESS_HOST_BIND: 0.0.0.0
      HARNESS_HOST_PORT: '8788'
      HARNESS_EMBED_DIMS: '${HARNESS_EMBED_DIMS:-1024}'
      APPROVALS_POLL_SECONDS: '5'
      EFFECTS_DISPATCH_SECONDS: '5'
      RECONCILE_SECONDS: '300'
      APPROVALS_HEALTH_PORT: '8787'
      APPROVALS_HEALTH_BIND: 0.0.0.0
    volumes:
      - storage:/srv/harness-storage
      - type: bind
        source: ${KNOWLEDGE_DIR:?set KNOWLEDGE_DIR}
        target: /srv/knowledge
        read_only: true

  control-plane:
    image: ghcr.io/mgavrila/hf1-platform-control-plane:${HF1_IMAGE_TAG:?set HF1_IMAGE_TAG}
    restart: unless-stopped
    depends_on: { postgres: { condition: service_healthy } }
    environment:
      DATABASE_URL: 'postgres://hf1:${POSTGRES_PASSWORD}@postgres:5432/hf1_platform'
      KERNEL_DATABASE_URL: 'postgres://hf1:${POSTGRES_PASSWORD}@postgres:5432/harness'
      HOST_URL: http://host:8788
      HARNESS_HOST_TOKEN: '${HARNESS_HOST_TOKEN}'
      HARNESS_ENCRYPTION_KEY: '${HARNESS_ENCRYPTION_KEY}'
      GOOGLE_CLIENT_ID: '${GOOGLE_CLIENT_ID:?set GOOGLE_CLIENT_ID}'
      GOOGLE_CLIENT_SECRET: '${GOOGLE_CLIENT_SECRET:?set GOOGLE_CLIENT_SECRET}'
      SESSION_SECRET: '${SESSION_SECRET:?set SESSION_SECRET}'
      PLATFORM_URL: 'https://${PLATFORM_DOMAIN:?set PLATFORM_DOMAIN}'
      PLATFORM_SUPERADMINS: '${PLATFORM_SUPERADMINS:-}'
      KNOWLEDGE_DIR: /srv/knowledge
      KNOWLEDGE_MOUNT: /srv/knowledge
      PORT: '8790'
    volumes:
      - type: bind
        source: ${KNOWLEDGE_DIR}
        target: /srv/knowledge

  workspace:
    image: ghcr.io/mgavrila/hf1-platform-workspace:${HF1_IMAGE_TAG:?set HF1_IMAGE_TAG}
    restart: unless-stopped
    environment: { CONTROL_PLANE_URL: http://control-plane:8790, PORT: '3000' }

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ['80:80', '443:443']
    environment: { PLATFORM_DOMAIN: '${PLATFORM_DOMAIN}' }
    volumes: ['./Caddyfile:/etc/caddy/Caddyfile:ro', 'caddy_data:/data', 'caddy_config:/config']

networks:
  files: { internal: true }

volumes:
  pgdata: {}
  storage: {}
  caddy_data: {}
  caddy_config: {}
```

`Caddyfile`:

```
{$PLATFORM_DOMAIN} {
  handle /tenants/* { reverse_proxy host:8788 }
  handle /api/*     { reverse_proxy control-plane:8790 }
  handle            { reverse_proxy workspace:3000 }
}
```

`postgres/init.sql`: `CREATE DATABASE harness; CREATE DATABASE litellm;` plus `\c harness` and `CREATE EXTENSION IF NOT EXISTS vector;` (the kernel's own init installs it too; harmless twice). The kernel's migrations run inside the host image at start (as its Compose does today), the platform's inside the control plane at start.

`litellm.config.yaml`: hf1's platform routing table — the five routes of the blueprints as `model_list` entries (`chat`, `extract`, `reason`, `judge`, `embed`, plus `chat-fallback-1` and `reason-fallback-1`) with `api_key: os.environ/GEMINI_API_KEY` or `GROQ_API_KEY`, `max_budget` per route, `router_settings.fallbacks`, `general_settings.master_key: os.environ/LITELLM_MASTER_KEY`, `litellm_settings: { drop_params: true, turn_off_message_logging: true, request_timeout: 120 }`. Hand-written and committed; a test asserts every route name the blueprints use appears in it.

`.env.example`: every variable above with one sentence each and the generation command for the random ones (`openssl rand -base64 32` for the key, `openssl rand -hex 32` for the tokens, `HARNESS_IMAGE_TAG=0.3.0`, `HF1_IMAGE_TAG=<this repository's tag>`).

Dockerfiles: `control-plane.Dockerfile` — `node:22-alpine`, `corepack enable`, copy the workspace manifests, `pnpm install --frozen-lockfile --filter @hf1/control-plane... --prod=false`, `pnpm --filter @hf1/control-plane exec tsc -p tsconfig.build.json` (a build tsconfig with `noEmit: false`, `outDir: dist`), run `node dist/app/main.js`. This build resolves `@harness/*` from release tarballs, so the Dockerfile is only buildable once `kernel.lock` says `source: release` (Task 24). `workspace.Dockerfile` — the standard Next.js standalone build.

- [ ] **Step 2: The Compose test**, **Step 3:** gates, commit `feat(deploy): the platform stack on Compose with Caddy, a pooled kernel host, the control plane and the workspace`.

---

### Task 24: CI — images, the tarball switch, and the Compose smoke job

**Files:**
- Modify: `.github/workflows/ci.yml`, `kernel.lock`, `catalog/package.json`, `control-plane/package.json`
- Create: `.github/workflows/release.yml`, `deploy/compose/smoke.sh`

- [ ] **Step 1: Switch the kernel dependency to release tarballs when the tag exists.** When the kernel session announces `v0.2.0` (and later `v0.3.0`), replace every `link:` with `https://github.com/mgavrila/agent-harness/releases/download/v<tag>/harness-<pkg>-<tag>.tgz`, set `kernel.lock` to `source: release`, `version: <tag>`, `commit: <tag commit>`, run `pnpm install`, `pnpm kernel:check`, the full suite. Until `v0.3.0`, the `web`/`{ ref }` tests fail on `v0.2.0` tarballs — so the switch to tarballs happens **at v0.3.0**, and CI keeps the sibling-checkout step of Task 1 until then. One commit: `build: pin the kernel to v0.3.0 release tarballs`.

- [ ] **Step 2: `release.yml`** — on `push: tags: ['v*']`: gates + suite, then `docker build` the two Dockerfiles and push `ghcr.io/mgavrila/hf1-platform-{control-plane,workspace}:<version>`, and create a GitHub Release whose body is the matching `CHANGELOG.md` section (create `CHANGELOG.md` with a `0.1.0` section in this task).

- [ ] **Step 3: The smoke job** — `deploy/compose/smoke.sh`: with a CI `.env` (random secrets, `PLATFORM_DOMAIN=localhost`, `GOOGLE_*` dummies, `HARNESS_IMAGE_TAG` from `kernel.lock`, `HF1_IMAGE_TAG` from the just-built images), `docker compose up -d postgres litellm files host control-plane`, wait for the control plane's `/api/v1/health` and the host's health port, then drive the API with a session minted through a test-only route **that does not exist in production**: instead, the smoke script seeds a user and a session by SQL (`INSERT INTO users …; INSERT INTO sessions …`) and signs the cookie with `SESSION_SECRET` using a 20-line Node snippet (HMAC-SHA256 as `hono/cookie` does), creates an organisation and an agent from `internal-team-assistant`, releases, then polls `GET .../status` until `live.version === latestRelease.version` (timeout 90 s: the host's config poll is 30 s). Add a `smoke` job to `ci.yml` that runs on `main` and on tags, `if: ${{ !startsWith(github.head_ref, 'dependabot') }}`, after the images are built in-job with `docker build` (no push). Open question 2 of the spec (anonymous pull of the kernel image) is answered here by trying it; if it fails, add `GHCR_READ_TOKEN` as a repository secret and a `docker login` step.

- [ ] **Step 4:** commit `ci: build the images and prove a released agent goes live on the pooled host`.

---

### Task 25: The Playwright flow

**Files:**
- Create: `apps/workspace/playwright.config.ts`, `apps/workspace/e2e/onboarding.spec.ts`, `apps/workspace/e2e/global-setup.ts`
- Modify: `.github/workflows/ci.yml` (an `e2e` job)

- [ ] **Step 1:** `global-setup.ts` starts the control plane in-process with `testApp()`-like wiring but a real HTTP port (export `startTestControlPlane()` from `control-plane/src/testing/app.ts`: it returns `{ url, issuer, host, close }` — the fake issuer and fake host included) and starts `next dev` against it; `playwright.config.ts` sets `baseURL` to the workspace and `webServer` accordingly.

- [ ] **Step 2: `onboarding.spec.ts`** — the spec §9 flow: open `/login`, click "Sign in with Google" (the fake issuer redirects straight back), create organisation `acme`, "New agent" → pick `fixture-agent` → slug `helper`, timezone → create; edit the persona and save; click Release; expect "live at <version>" after setting the fake host's version (the fake host exposes `POST /__test/version` in e2e mode only — under `src/testing/`, never in the shipped app); open Chat, send "hi", see "Hello there"; open Inbox, see the card. Assert no request from the browser ever carried `authorization` (a `page.on('request')` hook).

- [ ] **Step 3:** CI `e2e` job with `npx playwright install --with-deps chromium`; commit `test(workspace): the onboarding flow end to end against the fake issuer and fake host`.

---

### Task 26: Documentation

**Files:**
- Create: `ARCHITECTURE.md`, `docs/runbook.md`, `CHANGELOG.md` (if Task 24 did not)
- Modify: `README.md`, `catalog/README.md`, `control-plane/README.md`, `apps/workspace/README.md`

- [ ] **Step 1: `ARCHITECTURE.md`** (~150 lines): the three products as the deck names them and where each lives here; the three packages and the import rule; what runs (the diagram of spec §3.2); the agent's life (spec §3.3); what the platform writes into the kernel and why nothing else (spec §4.3); the platform invariants P-1..P-7 and where each is tested.

- [ ] **Step 2: `docs/runbook.md`**: *Setting up the platform server* (a VM with Docker, a DNS name, ports 80/443; a Google OAuth client with the redirect URI `https://<domain>/api/v1/auth/callback`; `.env` from `.env.example`; `pnpm platform:up`; first sign-in; making yourself superadmin), *Onboarding an organisation and an agent* (the exit-criterion walk-through, timed), *Connecting Slack* (the four steps with the manifest), *Releases and rollback*, *Upgrading the kernel* (`kernel.lock`, `HARNESS_IMAGE_TAG`, the two-image rule), *What to do when a release fails* (the `failed` status, the error text, retry), *Backups* (the two databases and the knowledge directory).

- [ ] **Step 3:** package READMEs (twenty lines each: purpose, public API, how to test); commit `docs: architecture, runbook and package READMEs`.

---

## Plan self-review (done while writing; left here for the executor)

- **Spec coverage:** §2 decisions 1–19 → Tasks 1 (17), 2–4 (8, 9), 5–7 (2, 3), 9–11 (10, 11, 12), 12 (13), 13 (14), 14 (5), 16–22 (15), 23 (4, 18), 24 (17); §4.4 routes → Tasks 6–15; §5.1–5.3 → Tasks 2–4, 5–15, 16–22; §6 → Task 5; §7 → Task 23; §8 P-1 (Task 7), P-2 (Tasks 9, 11), P-3 (Tasks 10, 13), P-4 (Task 12), P-5 (Task 14, 25), P-6 (Task 11), P-7 (Task 6); §9 → every task's tests, Task 24 smoke, Task 25 Playwright, Task 5 vocabulary; §10 → the order above; §11 → nothing here builds it.
- **Names used across tasks:** `platformAdditions`, `applyInputs`, `overlayFor`, `lockedHit`, `resolveDraft`, `sectionShape`, `documentSchema` (Task 3 → 9, 18); `contentVersion` (Task 5 → 11); `seal`/`open`/`randomToken` (Task 10 → 13, 14); `writeDocumentRelease`, `writeSecret`, `readSecret` (Task 10 → 11, 13); `secrets.reveal` (Task 10 → 14); `host.openRun` (Task 11 → 12); `requireUser`, `requireOrg`, `requireAgent` (Tasks 6, 7, 9 → all routes); `createClient` (Task 15 → 16).
- **Open items the executor must resolve, not placeholders:** the exact body of `GET /v1/status` (Task 11, read the kernel at the pinned commit); the shipped names of the web surface routes (Task 14, read 11c when it lands); whether `BlueprintShape` is exported (Task 2, Step 9).
