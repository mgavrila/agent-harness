import { readFileSync } from 'node:fs';

/**
 * How every migration test replays a shipped migration.
 *
 * One copy, shared by the 0008 and 0009 tests, because the splitting rule is a property of the
 * files drizzle writes rather than of either test: statements are separated by drizzle's own
 * `--> statement-breakpoint`, and the hand-written data sections are full of `--` comment lines
 * that `pg` would happily send but that make a failure unreadable. A second copy would be a
 * second thing to fix the day drizzle changes its separator.
 *
 * Reading the shipped file rather than a copy of its text is the point: a test fails if someone
 * edits the migration and not the expectations.
 *
 * A `*.test-helpers.ts` file, not a `*.test.ts` one: it declares no test, and the "no test
 * imported by production" architecture rule matches on the name.
 */
export function migrationStatements(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('--> statement-breakpoint')
    .map((chunk) =>
      chunk
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((statement) => statement !== '');
}
