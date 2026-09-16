// ESLint 9 flat config for the whole workspace.
//
// Layering is enforced in two places and they do different jobs: dependency-cruiser
// (.dependency-cruiser.cjs) owns "which folder may import which folder", and this file
// owns "which construct may appear in which folder". Read ARCHITECTURE.md for the layers.
//
// Type-aware linting runs against TypeScript 6, installed at the workspace root only.
// typescript-eslint refuses to load against TypeScript 7 (`Error: typescript-eslint does
// not support TS 7.0.`), while every package still compiles with TypeScript 7 via its own
// `tsc --noEmit`. Do not "tidy up" the duplicate typescript dependency.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';
import unusedImports from 'eslint-plugin-unused-imports';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

/**
 * The environment is read in exactly two places: the shared `env.ts` helpers, which own the
 * parsing and the error wording, and `app/`, which is the composition root. A domain that
 * needs a value takes it as a parameter or reads it through an `env.ts` helper — calling the
 * helper is fine anywhere, because the ban is on the `process.env` syntax, not on the value.
 */
const NO_PROCESS_ENV = {
  selector: 'MemberExpression[object.name="process"][property.name="env"]',
  message:
    'Read the environment through shared/env.ts (requiredEnv / optionalEnv / numberFromEnv / booleanFromEnv), or in app/.',
};

/**
 * Only a ToolError's message reaches the agent; a plain Error is masked by the kernel and
 * lands in the audit log. A tool that throws a bare Error is therefore telling the caller
 * nothing on purpose, which is almost never what the author meant.
 * `new Error(...)` as a value is untouched; only the `throw` form is restricted.
 */
const NO_BARE_THROW = {
  selector: 'ThrowStatement > NewExpression[callee.name="Error"]',
  message: 'tools/ throws ToolError for an expected failure. A bare Error is masked and the caller learns nothing.',
};

/**
 * Source roots whose layer rules are promoted from warn to error. Each package task appends its
 * own root here as it lands (e.g. 'harness/db/src'); Task 11 appends whatever is left. Adding a
 * root is the *only* edit a package task makes to this file.
 */
const STRICT_LAYER_ROOTS = ['harness/db/src', 'harness/gateway/src', 'harness/shared/src'];

/** True for the two spellings of a disabled rule, bare or at the head of an options array. */
const isOff = (severity) => severity === 'off' || severity === 0;

/**
 * Downgrade one rule entry to a warning, keeping its options. A rule that is already off is
 * returned untouched: a preset switches a rule off on purpose, and "make everything a warning"
 * must not be read as "turn everything on".
 */
function asWarning(value) {
  if (Array.isArray(value)) return isOff(value[0]) ? value : ['warn', ...value.slice(1)];
  return isOff(value) ? value : 'warn';
}

/**
 * console.* belongs in the logger and in process entrypoints, nowhere else.
 *
 * `harness/shared/src/log.ts` is named outright: the whole package is the shared layer, so it
 * has no `src/shared/` directory for the glob below to match. That glob stays for `@harness/db`
 * and for any package that grows a local `shared/log.ts` later.
 *
 * `synthetic/generate.ts` is the pack's corpus generator and its own CLI, so it prints. Task 11
 * splits the CLI out of it and renames that half to `synthetic/cli.ts`; both names are listed
 * so the exemption survives the tasks in between rather than lapsing at the rename. Task 11
 * drops the stale entry once it lands.
 */
const CONSOLE_IS_FINE = [
  'harness/shared/src/log.ts',
  '**/src/shared/log.ts',
  '**/src/app/**/*.ts',
  'packs/healthcare/synthetic/generate.ts',
  'packs/healthcare/synthetic/cli.ts',
  'packs/healthcare/forms/generate-templates.ts',
];

/**
 * @harness/db sits below the shared layer: importing core-tools from it would be a cycle, so
 * it reads its two variables (DATABASE_URL, HARNESS_ENCRYPTION_KEY) as default parameters
 * that every caller can override. Revisit if it ever grows a third.
 *
 * The drizzle.config.ts glob below covers `harness/db/drizzle.config.ts`, which reads
 * `process.env.DATABASE_URL` at the package root, outside `src/` and outside any package's
 * lint-scoped source tree — a drizzle-kit config file, not a domain module, so it is exempted
 * by name rather than folded into the `harness/db/src` entry.
 */
const PROCESS_ENV_IS_FINE = [
  'harness/shared/src/env.ts',
  '**/src/shared/env.ts',
  '**/src/app/**/*.ts',
  '**/*.test.ts',
  'harness/db/src/**/*.ts',
  '**/drizzle.config.ts',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'harness/db/drizzle/**',
      'packs/healthcare/synthetic/out/**',
      'evals/results/**',
      'storage/**',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,

  // Syntax-only rules: these are clean today and stay errors.
  ...tseslint.configs.recommended,

  // Type-aware rules. They run (projectService below switches them on) but land as warnings:
  // the existing code trips require-await and the no-unsafe-* family in places, and fixing
  // that is a separate piece of work from moving files. `pnpm lint` does not fail on warnings.
  //
  // A rule the preset deliberately turns OFF stays off. Rewriting every value to 'warn' would
  // resurrect the ones typescript-eslint disables on purpose: the preset switches off each
  // base ESLint rule it replaces with a type-aware version, so `no-redeclare` would start
  // false-positiving on zod's const + type merging, `no-undef` on the `NodeJS` namespace, and
  // the base `require-await` would double-report alongside its typescript-eslint counterpart.
  ...tseslint.configs.recommendedTypeChecked.map((entry) =>
    entry.rules
      ? {
          ...entry,
          rules: Object.fromEntries(Object.entries(entry.rules).map(([rule, value]) => [rule, asWarning(value)])),
        }
      : entry,
  ),

  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,

  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { 'unused-imports': unusedImports },
    rules: {
      // unused-imports owns unused bindings; the two built-ins must be off or they double-report.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'error',
        { vars: 'all', varsIgnorePattern: '^_', args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'never',
        },
      ],
      'import-x/no-default-export': 'error',
      // Warn until Task 11: registry.ts <-> tools/verify.ts and registry.ts <-> effects.ts are
      // type-only cycles today, and Task 7 is what removes them.
      'import-x/no-cycle': ['warn', { maxDepth: Infinity }],

      'no-console': 'warn',
      'no-restricted-syntax': ['warn', NO_PROCESS_ENV],
    },
  },

  { files: CONSOLE_IS_FINE, rules: { 'no-console': 'off' } },
  { files: PROCESS_ENV_IS_FINE, rules: { 'no-restricted-syntax': 'off' } },

  // The tools layer carries both selectors. Listing only NO_BARE_THROW here would switch the
  // environment rule back off for every file under tools/ — see the comment at the top.
  {
    files: ['**/src/tools/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: { 'no-restricted-syntax': ['warn', NO_PROCESS_ENV, NO_BARE_THROW] },
  },

  // Promoted roots. Empty until Task 2 appends the first one. The two exemption blocks are
  // repeated inside, because the promotion blocks above them would otherwise switch console
  // back on for app/ and the environment rule back on for tests.
  ...(STRICT_LAYER_ROOTS.length === 0
    ? []
    : [
        {
          files: STRICT_LAYER_ROOTS.map((root) => `${root}/**/*.ts`),
          rules: {
            'no-console': 'error',
            'import-x/no-cycle': ['error', { maxDepth: Infinity }],
            'no-restricted-syntax': ['error', NO_PROCESS_ENV],
          },
        },
        {
          files: STRICT_LAYER_ROOTS.map((root) => `${root}/tools/**/*.ts`),
          ignores: ['**/*.test.ts'],
          rules: { 'no-restricted-syntax': ['error', NO_PROCESS_ENV, NO_BARE_THROW] },
        },
        { files: CONSOLE_IS_FINE, rules: { 'no-console': 'off' } },
        { files: PROCESS_ENV_IS_FINE, rules: { 'no-restricted-syntax': 'off' } },
      ]),

  // Config files legitimately default-export, and are not in any package's tsconfig `include`
  // in a way the project service can type-check, so the type-aware rules are switched off here.
  {
    files: ['**/vitest.config.ts', '**/drizzle.config.ts', '**/test-global-setup.ts', 'eslint.config.js'],
    rules: { 'import-x/no-default-export': 'off' },
  },
  {
    files: ['eslint.config.js', '**/*.cjs', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.node } },
  },

  // Last, so it wins: turns off every rule Prettier already decides.
  prettierConfig,
);
