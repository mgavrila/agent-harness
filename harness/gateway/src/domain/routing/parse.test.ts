import { describe, it, expect } from 'vitest';
import { parseRouting } from './parse.js';
import { ROUTES } from './types.js';

const ROUTING = `
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

describe('routing.schema', () => {
  it('names exactly the four spec routes', () => {
    expect([...ROUTES]).toEqual(['chat', 'extract', 'reason', 'judge']);
  });

  it('parses a routing file', () => {
    const r = parseRouting(ROUTING);
    expect(r.routes.chat.model).toBe('gemini/gemini-3-flash-preview');
    expect(r.routes.chat.fallbacks).toEqual(['groq/openai/gpt-oss-120b']);
    expect(r.routes.judge.daily_budget_usd).toBe(1);
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
