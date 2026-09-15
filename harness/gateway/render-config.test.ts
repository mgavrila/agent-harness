import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { ROUTES, parseRouting } from './routing.schema.js';
import { apiKeyEnvFor, renderLiteLlmConfig } from './render-config.js';

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
});

describe('apiKeyEnvFor', () => {
  it('maps known provider prefixes', () => {
    expect(apiKeyEnvFor('gemini/gemini-3-flash-preview')).toBe('GEMINI_API_KEY');
    expect(apiKeyEnvFor('groq/openai/gpt-oss-120b')).toBe('GROQ_API_KEY');
    expect(apiKeyEnvFor('openrouter/z-ai/glm-5.2:free')).toBe('OPENROUTER_API_KEY');
    expect(apiKeyEnvFor('hosted_vllm/Qwen/Qwen3-8B')).toBe('VLLM_API_KEY');
  });

  it('throws on an unprefixed or unknown model', () => {
    expect(() => apiKeyEnvFor('gemini-3-flash-preview')).toThrow(/provider prefix/);
    expect(() => apiKeyEnvFor('wombat/x')).toThrow(/wombat/);
  });
});

describe('renderLiteLlmConfig', () => {
  const rendered = renderLiteLlmConfig(parseRouting(ROUTING));
  const parsed = parseYaml(rendered) as {
    model_list: { model_name: string; litellm_params: Record<string, unknown> }[];
    router_settings: { fallbacks: Record<string, string[]>[]; num_retries: number; request_timeout: number };
    general_settings: { master_key: string };
    litellm_settings: Record<string, unknown>;
  };

  it('emits one deployment per route plus one per fallback', () => {
    expect(parsed.model_list.map((m) => m.model_name)).toEqual([
      'chat',
      'chat-fallback-1',
      'extract',
      'reason',
      'judge',
    ]);
  });

  it('wires the api key env var and the daily budget onto every deployment', () => {
    const chat = parsed.model_list[0].litellm_params;
    expect(chat).toMatchObject({
      model: 'gemini/gemini-3-flash-preview',
      api_key: 'os.environ/GEMINI_API_KEY',
      max_budget: 2,
      budget_duration: '1d',
    });
    const fallback = parsed.model_list[1].litellm_params;
    expect(fallback).toMatchObject({ model: 'groq/openai/gpt-oss-120b', api_key: 'os.environ/GROQ_API_KEY' });
  });

  it('declares the fallback chain in router_settings', () => {
    expect(parsed.router_settings.fallbacks).toEqual([{ chat: ['chat-fallback-1'] }]);
    expect(parsed.router_settings.num_retries).toBe(2);
    expect(parsed.router_settings.request_timeout).toBe(120);
  });

  it('reads the master key from the environment, never inlining it', () => {
    expect(parsed.general_settings.master_key).toBe('os.environ/LITELLM_MASTER_KEY');
    expect(rendered).not.toMatch(/sk-/);
  });

  it('passes api_base through for a local endpoint', () => {
    const local = parseRouting(
      ROUTING.replace(
        '  judge:\n    model: groq/openai/gpt-oss-120b\n    daily_budget_usd: 1\n',
        '  judge:\n    model: hosted_vllm/Qwen/Qwen3-8B\n    api_base: http://vllm:8000/v1\n',
      ),
    );
    const out = parseYaml(renderLiteLlmConfig(local)) as { model_list: { model_name: string; litellm_params: Record<string, unknown> }[] };
    const judge = out.model_list.find((m) => m.model_name === 'judge')!;
    expect(judge.litellm_params).toMatchObject({ model: 'hosted_vllm/Qwen/Qwen3-8B', api_base: 'http://vllm:8000/v1' });
  });

  it('is deterministic', () => {
    expect(renderLiteLlmConfig(parseRouting(ROUTING))).toBe(rendered);
  });
});
