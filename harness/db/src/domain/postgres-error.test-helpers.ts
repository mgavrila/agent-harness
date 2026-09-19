/**
 * The message a query's rejection really carries, or a sentence saying it did not reject at all.
 *
 * drizzle-orm wraps the driver error as "Failed query: ..." and puts the underlying Postgres
 * error — the constraint's own message, the trigger's RAISE EXCEPTION, the missing type — on
 * `.cause`, so the cause is what every assertion about a database message has to read. One copy,
 * shared by the schema suite and the migration suites, because the unwrapping is a property of
 * drizzle rather than of any one of them.
 *
 * A `*.test-helpers.ts` file, not a `*.test.ts` one: it declares no test, and the "no test
 * imported by production" architecture rule matches on the name.
 */
export async function rejectionMessage(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
    return 'the query succeeded';
  } catch (err) {
    const cause = err instanceof Error ? err.cause : undefined;
    if (cause instanceof Error) return cause.message;
    return err instanceof Error ? err.message : String(err);
  }
}
