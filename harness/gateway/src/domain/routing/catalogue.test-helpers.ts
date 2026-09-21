/**
 * One well-formed catalogue, for the schema test and the renderer test.
 *
 * The renderer test renders exactly what the schema test parses, so the pair only proves the
 * round trip while both read the same bytes. Both also patch this text with `String.replace` to
 * build their negative and variant cases, which means the layout is load-bearing: the first entry
 * is the one with a fallback, and every entry sits at two spaces of indentation.
 *
 * A `*.test-helpers.ts` file, not a `*.test.ts` one: it declares no test, and the "no test
 * imported by production" architecture rule matches on the name.
 */

/** What `harness/gateway/catalogue.yaml` ships: three deployments, one of them with a fallback. */
export const CATALOGUE = `
deployments:
  - model: gemini/gemini-3-flash-preview
    daily_budget_usd: 2
    fallbacks: [groq/openai/gpt-oss-120b]
  - model: groq/openai/gpt-oss-120b
    daily_budget_usd: 1
  - model: gemini/gemini-embedding-001
    daily_budget_usd: 1
defaults:
  daily_budget_usd: 1
  num_retries: 2
  request_timeout_s: 120
`;
