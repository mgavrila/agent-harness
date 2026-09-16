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
 * Only a ToolError's message reaches the agent; anything else is masked by the kernel and
 * lands in the audit log. A tool that throws one is therefore telling the caller nothing on
 * purpose, which is almost never what the author meant.
 *
 * The selector matches `new <anything ending in Error>`, not just `new Error`: `TypeError`,
 * `RangeError` and a hand-rolled `ValidationError` are all masked exactly the same way.
 * `ToolError` and `ModelOutputError` are the two exemptions, because `ModelOutputError`
 * extends `ToolError` and its message reaches the agent too. `new Error(...)` as a *value* is
 * untouched; only the `throw` form is restricted.
 *
 * KNOWN GAP: `const e = new Error(...); throw e;` is not caught. Matching `throw <identifier>`
 * would also flag every legitimate re-throw of a caught `ToolError`, which is a false positive
 * on correct code, so the indirect spelling is left to review. There are none in `tools/`
 * today.
 */
const NO_BARE_THROW = {
  selector:
    'ThrowStatement > NewExpression[callee.name=/Error$/][callee.name!="ToolError"][callee.name!="ModelOutputError"]',
  message: 'tools/ throws ToolError for an expected failure. Any other Error is masked and the caller learns nothing.',
};

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
 * `synthetic/cli.ts` is the pack's corpus-generator entrypoint, so it prints. The pack has no
 * `src/app/` for the glob above to match, so it is named outright, as is the form-template
 * builder next to it.
 */
const CONSOLE_IS_FINE = [
  'harness/shared/src/log.ts',
  '**/src/shared/log.ts',
  '**/src/app/**/*.ts',
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
  // A pack reads its own configuration; it has no app/ layer for the glob above to match.
  'packs/*/src/config.ts',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      // Nested checkouts and scratch: a linked worktree under .claude/ or a scratch dir has its
      // own tsconfig and would trip the type-aware rules from the outer root.
      '.claude/**',
      '.worktrees/**',
      '.superpowers/**',
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

  // Type-aware rules stay warnings — the one family that does. Every other rule in this file
  // is an error. The existing code trips require-await and the no-unsafe-* family in places,
  // and clearing that is a separate piece of work from moving files. `pnpm lint` does not fail
  // on them; `pnpm lint:strict` (eslint . --max-warnings=0) is how you see the backlog.
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
      'import-x/no-cycle': ['error', { maxDepth: Infinity }],

      'no-console': 'error',
      'no-restricted-syntax': ['error', NO_PROCESS_ENV],
    },
  },

  { files: CONSOLE_IS_FINE, rules: { 'no-console': 'off' } },
  { files: PROCESS_ENV_IS_FINE, rules: { 'no-restricted-syntax': 'off' } },
  // A test prints: a suite that skips says why on stderr, and nothing parses that output.
  // PROCESS_ENV_IS_FINE already exempts test files from the environment rule; this is the same
  // exemption for console, so a printing test is not an error to be suppressed one by one.
  { files: ['**/*.test.ts'], rules: { 'no-console': 'off' } },

  // The tools layer carries both selectors. Listing only NO_BARE_THROW here would switch the
  // environment rule back off for every file under tools/ — see the comment at the top.
  {
    files: ['**/src/tools/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: { 'no-restricted-syntax': ['error', NO_PROCESS_ENV, NO_BARE_THROW] },
  },

  // require-await is a false positive by construction in a fake and in a test. A fake
  // implements an interface whose methods return a Promise, so `async` is what makes the
  // signature match — `FakeSlack.postMessage` has nothing to await and must still be awaitable
  // by the code under test. A test declares the same kind of stub inline. Satisfying the rule
  // there means writing `Promise.resolve(...)` by hand, which is noise in place of a warning.
  // Everywhere else it stays a warning and means what it says: an `async` that awaits nothing
  // in shipping code is usually a signature nobody checked.
  {
    files: ['**/*.test.ts', '**/fake.ts', '**/fakes/**/*.ts', '**/testing.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },

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
