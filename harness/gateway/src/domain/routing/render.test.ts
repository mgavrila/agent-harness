import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { DeploymentCatalogue } from './catalogue.js';
import { CATALOGUE } from './catalogue.test-helpers.js';
import { apiKeyEnvFor, renderLiteLlmConfig } from './render.js';

/** The shipped catalogue as a parsed one. The schema is the whole of the parse. */
const catalogue = (yamlText: string): DeploymentCatalogue => DeploymentCatalogue.parse(parseYaml(yamlText));

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

describe('DeploymentCatalogue', () => {
  it('names each deployment by its model unless it says otherwise', () => {
    const parsed = catalogue(CATALOGUE);
    expect(parsed.deployments[0].name).toBeUndefined();
    const named = catalogue(
      CATALOGUE.replace(
        '  - model: gemini/gemini-embedding-001\n',
        '  - name: vectors\n    model: gemini/gemini-embedding-001\n',
      ),
    );
    expect(named.deployments[2].name).toBe('vectors');
    const out = parseYaml(renderLiteLlmConfig(named)) as { model_list: { model_name: string }[] };
    expect(out.model_list.map((m) => m.model_name)).toContain('vectors');
  });

  it('refuses two deployments under one name', () => {
    const twice = CATALOGUE.replace(
      '  - model: gemini/gemini-embedding-001\n',
      '  - model: gemini/gemini-3-flash-preview\n',
    );
    expect(DeploymentCatalogue.safeParse(parseYaml(twice)).success).toBe(false);
  });

  it('refuses a fallback no deployment is named, and says which', () => {
    const dangling = CATALOGUE.replace('fallbacks: [groq/openai/gpt-oss-120b]', 'fallbacks: [groq/nothing-here]');
    const result = DeploymentCatalogue.safeParse(parseYaml(dangling));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('groq/nothing-here');
  });

  it('refuses an inline key on a deployment, so a literal credential cannot be smuggled in', () => {
    const smuggled = CATALOGUE.replace(
      '    daily_budget_usd: 1\n  - model: gemini/gemini-embedding-001',
      '    api_key: sk-live\n  - model: gemini/gemini-embedding-001',
    );
    expect(DeploymentCatalogue.safeParse(parseYaml(smuggled)).success).toBe(false);
  });

  it('supplies every default when `defaults` is absent', () => {
    const bare = catalogue(CATALOGUE.slice(0, CATALOGUE.indexOf('defaults:')));
    expect(bare.defaults).toEqual({ daily_budget_usd: 1, num_retries: 2, request_timeout_s: 120 });
  });
});

describe('renderLiteLlmConfig', () => {
  const rendered = renderLiteLlmConfig(catalogue(CATALOGUE));
  const parsed = parseYaml(rendered) as {
    model_list: { model_name: string; litellm_params: Record<string, unknown> }[];
    router_settings: { fallbacks: Record<string, string[]>[]; num_retries: number };
    general_settings: { master_key: string };
    litellm_settings: Record<string, unknown>;
  };

  it('emits one deployment per catalogue entry, under the name a document names it by', () => {
    expect(parsed.model_list.map((m) => m.model_name)).toEqual([
      'gemini/gemini-3-flash-preview',
      'groq/openai/gpt-oss-120b',
      'gemini/gemini-embedding-001',
    ]);
  });

  it('wires the api key env var and the daily budget onto every deployment', () => {
    expect(parsed.model_list[0].litellm_params).toMatchObject({
      model: 'gemini/gemini-3-flash-preview',
      api_key: 'os.environ/GEMINI_API_KEY',
      max_budget: 2,
      budget_duration: '1d',
    });
    expect(parsed.model_list[1].litellm_params).toMatchObject({
      model: 'groq/openai/gpt-oss-120b',
      api_key: 'os.environ/GROQ_API_KEY',
      max_budget: 1,
    });
  });

  it('falls back to the catalogue default budget for an entry that names none', () => {
    const unbudgeted = renderLiteLlmConfig(catalogue(CATALOGUE.replace('    daily_budget_usd: 2\n', '')));
    const out = parseYaml(unbudgeted) as { model_list: { litellm_params: Record<string, unknown> }[] };
    expect(out.model_list[0].litellm_params.max_budget).toBe(1);
  });

  it('declares the fallback chain in router_settings, for the entries that have one', () => {
    expect(parsed.router_settings.fallbacks).toEqual([
      { 'gemini/gemini-3-flash-preview': ['groq/openai/gpt-oss-120b'] },
    ]);
    expect(parsed.router_settings.num_retries).toBe(2);
  });

  it('honours the request timeout via litellm_settings, not router_settings', () => {
    // `router_settings.request_timeout` is not a valid Router.__init__() argument
    // in the current LiteLLM image (it logs a warning and silently ignores it);
    // litellm_settings.request_timeout is the key that image actually honours.
    expect(parsed.litellm_settings.request_timeout).toBe(120);
    expect(parsed.router_settings).not.toHaveProperty('request_timeout');
  });

  it('reads the master key from the environment, never inlining it', () => {
    expect(parsed.general_settings.master_key).toBe('os.environ/LITELLM_MASTER_KEY');
    expect(rendered).not.toMatch(/sk-/);
  });

  it('says in its header where it came from', () => {
    expect(rendered.startsWith('# GENERATED FILE - do not edit by hand.\n')).toBe(true);
    expect(rendered).toContain('harness/gateway/catalogue.yaml');
  });

  it('passes api_base through for a local endpoint', () => {
    const local = catalogue(
      CATALOGUE.replace(
        '  - model: groq/openai/gpt-oss-120b\n    daily_budget_usd: 1\n',
        '  - name: groq/openai/gpt-oss-120b\n    model: hosted_vllm/Qwen/Qwen3-8B\n    api_base: http://vllm:8000/v1\n',
      ),
    );
    const out = parseYaml(renderLiteLlmConfig(local)) as {
      model_list: { model_name: string; litellm_params: Record<string, unknown> }[];
    };
    const spare = out.model_list.find((m) => m.model_name === 'groq/openai/gpt-oss-120b')!;
    expect(spare.litellm_params).toMatchObject({
      model: 'hosted_vllm/Qwen/Qwen3-8B',
      api_base: 'http://vllm:8000/v1',
    });
  });

  it('is deterministic', () => {
    expect(renderLiteLlmConfig(catalogue(CATALOGUE))).toBe(rendered);
  });
});
