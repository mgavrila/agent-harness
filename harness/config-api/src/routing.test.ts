import { describe, expect, it } from 'vitest';
import { ROUTES, RoutingFile } from './routing.js';

const route = { model: 'gemini/gemini-3-flash-preview' };
const routes = Object.fromEntries(ROUTES.map((name) => [name, route]));

describe('RoutingFile', () => {
  it('names exactly the five spec routes, in order', () => {
    expect([...ROUTES]).toEqual(['chat', 'extract', 'reason', 'judge', 'embed']);
  });

  it('names the five routes, each of them one deployment name and nothing else', () => {
    const parsed = RoutingFile.parse({ routes });
    expect(Object.keys(parsed.routes).sort()).toEqual([...ROUTES].sort());
    expect(parsed.routes.chat).toEqual({ model: 'gemini/gemini-3-flash-preview' });
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

  it('refuses the LiteLLM fields a route used to carry, rather than ignoring them', () => {
    // A route names a deployment; what that deployment is — its fallbacks, its endpoint, its
    // daily budget — is the deployment's own configuration, in the catalogue on a dedicated host
    // and in the platform's registration on a pooled one. A document that still sets one of them
    // is refused at load, because a field that changes nothing is the silent fallback class.
    for (const dead of [
      { fallbacks: ['groq/openai/gpt-oss-120b'] },
      { daily_budget_usd: 2 },
      { api_base: 'http://vllm:8000/v1' },
    ]) {
      expect(RoutingFile.safeParse({ routes: { ...routes, chat: { ...route, ...dead } } }).success).toBe(false);
    }
    expect(RoutingFile.safeParse({ routes, defaults: { daily_budget_usd: 1 } }).success).toBe(false);
  });

  it('refuses a model that is empty or carries a space', () => {
    expect(RoutingFile.safeParse({ routes: { ...routes, chat: { model: '' } } }).success).toBe(false);
    expect(RoutingFile.safeParse({ routes: { ...routes, chat: { model: 'gemini/one two' } } }).success).toBe(false);
  });
});

describe('the routing section', () => {
  const routes = {
    chat: { model: 'gemini/gemini-3-flash-preview' },
    extract: { model: 'gemini/gemini-3-flash-preview' },
    reason: { model: 'gemini/gemini-3-flash-preview' },
    judge: { model: 'groq/openai/gpt-oss-120b' },
    embed: { model: 'gemini/gemini-embedding-001' },
  };

  it('takes an optional gateway key, as a reference and never as a value', () => {
    const parsed = RoutingFile.parse({ routes, gateway: { key: { ref: 'gateway-key' } } });
    expect(parsed.gateway).toEqual({ key: { ref: 'gateway-key' } });
    expect(RoutingFile.parse({ routes }).gateway).toBeUndefined();
    // A literal key is the one thing this section may never carry, which is what `SecretRefShape`
    // is for — the same rule a route's own strict shape has had since the gateway renderer existed.
    expect(() => RoutingFile.parse({ routes, gateway: { key: 'sk-live-whatever' } })).toThrow();
  });

  it('refuses a key under a name nobody reads, rather than stripping it', () => {
    // `gatway:` used to be silently dropped, and a tenant would then believe it had its own key
    // while every call went out on the process key — a credential falling back in silence. The
    // section is strict now, so a typo is a refusal at load (spec section 12, constraint 21).
    expect(() => RoutingFile.parse({ routes, gatway: { key: { ref: 'gateway-key' } } })).toThrow();
    expect(() => RoutingFile.parse({ routes, gateway: { keys: { ref: 'gateway-key' } } })).toThrow();
    expect(() => RoutingFile.parse({ routes, extra: true })).toThrow();
  });
});
