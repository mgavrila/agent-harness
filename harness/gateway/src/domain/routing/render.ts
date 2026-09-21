import { stringify as stringifyYaml } from 'yaml';
import { deploymentName, type DeploymentCatalogue } from './catalogue.js';

/**
 * Which environment variable holds the credential for a provider prefix. The
 * rendered config never contains a key, only an `os.environ/NAME` reference, so
 * the config file is safe to commit and the secret stays in `.env`.
 */
const PROVIDER_KEY_ENV: Record<string, string> = {
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  hosted_vllm: 'VLLM_API_KEY',
  ollama: 'OLLAMA_API_KEY',
};

/**
 * Which environment variable holds a catalogue entry's credential. Catalogue entries only: a
 * document's model string is a deployment name, which the gateway resolves, and never a provider
 * prefix this renderer would read.
 */
export function apiKeyEnvFor(model: string): string {
  const slash = model.indexOf('/');
  if (slash <= 0) {
    throw new Error(`model "${model}" has no provider prefix; use e.g. gemini/gemini-3-flash-preview`);
  }
  const provider = model.slice(0, slash);
  const env = PROVIDER_KEY_ENV[provider];
  if (!env) {
    throw new Error(
      `unknown provider prefix "${provider}"; add it to PROVIDER_KEY_ENV in harness/gateway/src/domain/routing/render.ts`,
    );
  }
  return env;
}

interface Deployment {
  model_name: string;
  litellm_params: Record<string, unknown>;
}

function deployment(name: string, model: string, budget: number, apiBase?: string): Deployment {
  const params: Record<string, unknown> = {
    model,
    api_key: `os.environ/${apiKeyEnvFor(model)}`,
    max_budget: budget,
    budget_duration: '1d',
  };
  if (apiBase) params.api_base = apiBase;
  return { model_name: name, litellm_params: params };
}

const HEADER = `# GENERATED FILE - do not edit by hand.
# Rendered from harness/gateway/catalogue.yaml by harness/gateway/src/app/render-config.ts.
# Regenerate with: pnpm gateway:config
`;

/**
 * The deployment catalogue as LiteLLM's own config: one `model_list` entry per deployment, under
 * the name a client document names it by.
 *
 * No client is read here and none could be: a rendered deployment is the deployment's, and which
 * job a tenant puts it to is that tenant's document. That is what lets one rendered file serve
 * every tenant on the host.
 */
export function renderLiteLlmConfig(catalogue: DeploymentCatalogue): string {
  const defaultBudget = catalogue.defaults.daily_budget_usd;
  const modelList: Deployment[] = catalogue.deployments.map((entry) =>
    deployment(deploymentName(entry), entry.model, entry.daily_budget_usd ?? defaultBudget, entry.api_base),
  );
  const fallbacks: Record<string, string[]>[] = catalogue.deployments
    .filter((entry) => entry.fallbacks.length > 0)
    .map((entry) => ({ [deploymentName(entry)]: entry.fallbacks }));

  const config = {
    model_list: modelList,
    router_settings: {
      fallbacks,
      num_retries: catalogue.defaults.num_retries,
      allowed_fails: 3,
      cooldown_time: 30,
    },
    general_settings: {
      master_key: 'os.environ/LITELLM_MASTER_KEY',
    },
    litellm_settings: {
      // Providers differ in which OpenAI parameters they accept; dropping the
      // unsupported ones keeps one calling convention in core-tools'
      // domain/models/gateway.ts.
      drop_params: true,
      set_verbose: false,
      // Prompts may contain patient-adjacent text. Never echo them into logs.
      turn_off_message_logging: true,
      // `request_timeout` under router_settings is not a valid Router.__init__()
      // argument in the current LiteLLM image (it logs a warning and ignores
      // it); litellm_settings.request_timeout is the key this image honours.
      request_timeout: catalogue.defaults.request_timeout_s,
    },
  };

  return HEADER + stringifyYaml(config, { lineWidth: 0 });
}
