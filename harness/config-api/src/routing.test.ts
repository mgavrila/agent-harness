import { describe, expect, it } from 'vitest';
import { ROUTES, RoutingFile } from './routing.js';

const route = { model: 'gemini/gemini-3-flash-preview' };
const routes = Object.fromEntries(ROUTES.map((name) => [name, route]));

describe('RoutingFile', () => {
  it('names exactly the five spec routes, in order', () => {
    expect([...ROUTES]).toEqual(['chat', 'extract', 'reason', 'judge', 'embed']);
  });

  it('names the five routes and supplies every default when `defaults` is absent', () => {
    const parsed = RoutingFile.parse({ routes });
    expect(Object.keys(parsed.routes).sort()).toEqual([...ROUTES].sort());
    expect(parsed.defaults).toEqual({ daily_budget_usd: 1, num_retries: 2, request_timeout_s: 120 });
    expect(parsed.routes.chat.fallbacks).toEqual([]);
  });

  it('refuses a route that is not one of the five, and a missing one', () => {
    expect(RoutingFile.safeParse({ routes: { ...routes, gossip: route } }).success).toBe(false);
    const { embed: _embed, ...four } = routes;
    expect(RoutingFile.safeParse({ routes: four }).success).toBe(false);
  });

  it('refuses an inline key on a route, so a literal credential cannot be smuggled in', () => {
    expect(RoutingFile.safeParse({ routes: { ...routes, chat: { ...route, api_key: 'sk-live' } } }).success).toBe(
      false,
    );
  });

  it('bounds the fallbacks and the budget', () => {
    expect(
      RoutingFile.safeParse({ routes: { ...routes, chat: { ...route, fallbacks: ['a', 'b', 'c', 'd'] } } }).success,
    ).toBe(false);
    expect(RoutingFile.safeParse({ routes: { ...routes, chat: { ...route, daily_budget_usd: 0 } } }).success).toBe(
      false,
    );
  });
});
