import { describe, it, expect } from 'vitest';
import { ROUTES } from '@harness/config-api';
import { parseRouting } from './parse.js';
import { ROUTING } from './routing.test-helpers.js';

describe('routing.schema', () => {
  it('names exactly the five spec routes', () => {
    expect([...ROUTES]).toEqual(['chat', 'extract', 'reason', 'judge', 'embed']);
  });

  it('parses a routing file', () => {
    const r = parseRouting(ROUTING);
    expect(r.routes.chat.model).toBe('gemini/gemini-3-flash-preview');
    expect(r.routes.chat.fallbacks).toEqual(['groq/openai/gpt-oss-120b']);
    expect(r.routes.judge.daily_budget_usd).toBe(1);
  });

  it('requires the embed route, which knowledge_search and knowledge_sync call', () => {
    expect(() => parseRouting(ROUTING.replace(/\n {2}embed:\n[\s\S]*$/, '\n'))).toThrow(/embed/);
    expect(parseRouting(ROUTING).routes.embed.model).toBe('gemini/gemini-embedding-001');
  });

  it('rejects a file missing a route', () => {
    expect(() => parseRouting('routes:\n  chat:\n    model: gemini/gemini-3-flash-preview\n')).toThrow(/extract/);
  });

  it('rejects an unknown route name', () => {
    expect(() => parseRouting(`${ROUTING}\n  summarise:\n    model: groq/openai/gpt-oss-120b\n`)).toThrow();
  });

  it('rejects an unknown key on a route', () => {
    expect(() =>
      parseRouting(
        ROUTING.replace(
          '  chat:\n    model: gemini/gemini-3-flash-preview\n',
          '  chat:\n    model: gemini/gemini-3-flash-preview\n    apikey: sk-inline-not-allowed\n',
        ),
      ),
    ).toThrow(/apikey/);
  });
});
