/**
 * One well-formed routing file, for the parser test and the renderer test.
 *
 * The renderer test renders exactly what the parser test parses, so the pair
 * only proves the round trip while both read the same bytes. Both also patch
 * this text with `String.replace` to build their negative and variant cases,
 * which means the layout is load-bearing: `chat:` is the first route, `judge:`
 * the last, and every route sits at two spaces of indentation.
 *
 * A `*.test-helpers.ts` file, not a `*.test.ts` one: it declares no test, and
 * the "no test imported by production" architecture rule matches on the name.
 */

/** All four spec routes, one with a fallback, each with a daily budget. */
export const ROUTING = `
routes:
  chat:
    model: gemini/gemini-3-flash-preview
    fallbacks: [groq/openai/gpt-oss-120b]
    daily_budget_usd: 2
  extract:
    model: gemini/gemini-3-flash-preview
    daily_budget_usd: 5
  reason:
    model: gemini/gemini-3-flash-preview
    daily_budget_usd: 2
  judge:
    model: groq/openai/gpt-oss-120b
    daily_budget_usd: 1
`;
