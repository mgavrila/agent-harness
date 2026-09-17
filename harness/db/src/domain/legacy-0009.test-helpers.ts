/**
 * The one table migration 0010 touches, as it stood after 0009.
 *
 * Copied out of `schema.ts` as it was before this task rather than derived from anything, on
 * purpose: this is the *old* shape, and a fixture generated from the current schema would agree
 * with a migration that dropped a column. No other table is here: 0010 adds columns to `runs` and
 * backfills one of them, and the foreign keys that point at `runs` play no part in that.
 *
 * A `*.test-helpers.ts` file, not a `*.test.ts` one: it declares no test, and the "no test
 * imported by production" architecture rule matches on the name.
 */
export const LEGACY_0009_DDL = `
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client" text NOT NULL,
	"caller" text NOT NULL,
	"channel" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
`;
