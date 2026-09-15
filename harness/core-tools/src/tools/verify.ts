import * as z from 'zod/v4';
import { defineTool, ToolError, type AnyToolDef } from '../registry.js';
import { requireProvider } from './providers.js';

export interface VerifyConfig {
  nppesEnabled: boolean;
  /** Registry endpoint, ending in a slash. Overridden in tests by a local stub. */
  nppesBaseUrl: string;
  stateLicenseEnabled: boolean;
  timeoutMs: number;
}

export const NPPES_DEFAULT_BASE_URL = 'https://npiregistry.cms.hhs.gov/api/';

export interface NppesRecord {
  number: string;
  enumerationType: 'NPI-1' | 'NPI-2';
  /** Full name for an individual, organisation name for an organisation. */
  name: string;
  /** 'A' for active. Null when the registry omits it. */
  status: string | null;
  state: string | null;
}

interface NppesBasic {
  first_name?: string;
  middle_name?: string;
  last_name?: string;
  organization_name?: string;
  status?: string;
}

interface NppesResult {
  number?: string;
  enumeration_type?: string;
  basic?: NppesBasic;
  addresses?: { address_purpose?: string; state?: string }[];
}

interface NppesBody {
  result_count?: number;
  results?: NppesResult[];
  Errors?: { description?: string }[];
}

const TITLES = new Set(['dr', 'mr', 'mrs', 'ms', 'prof']);
const SUFFIXES = new Set(['md', 'do', 'dds', 'dmd', 'np', 'pa', 'rn', 'lcsw', 'phd', 'jr', 'sr', 'ii', 'iii', 'iv']);

/**
 * Whether two renderings of a person's name are the same person. NPPES prints
 * uppercase with the middle name always present; intake forms print titles,
 * degree suffixes, commas and sometimes "Last, First". Comparing the remaining
 * name tokens as a set handles all three without a name-parsing library.
 *
 * It is deliberately permissive: this feeds a flag a human reads, and a false
 * mismatch that sends someone to re-key a correct record costs more than a
 * false match that a reviewer catches next to the registry name we also return.
 */
export function namesMatch(a: string, b: string): boolean {
  const tokens = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[.,]/g, ' ')
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => t !== '' && !TITLES.has(t) && !SUFFIXES.has(t)),
    );
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return false;
  // A middle name present on one side only must not break the match, so the
  // smaller set has to be wholly contained in the larger.
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const token of small) {
    if (!large.has(token)) return false;
  }
  return true;
}

function recordFrom(result: NppesResult): NppesRecord | null {
  const enumerationType = result.enumeration_type === 'NPI-2' ? 'NPI-2' : result.enumeration_type === 'NPI-1' ? 'NPI-1' : null;
  if (!enumerationType || !result.number) return null;
  const basic = result.basic ?? {};
  const name =
    enumerationType === 'NPI-2'
      ? (basic.organization_name ?? '')
      : [basic.first_name, basic.middle_name, basic.last_name].filter((p) => p && p !== '').join(' ');
  const location = (result.addresses ?? []).find((a) => a.address_purpose === 'LOCATION') ?? result.addresses?.[0];
  return { number: result.number, enumerationType, name, status: basic.status ?? null, state: location?.state ?? null };
}

/**
 * One GET against the public NPPES registry. Returns null when the registry
 * simply has no such NPI, which is the expected answer for every synthetic NPI
 * in the demo corpus and is not an error.
 */
export async function fetchNppes(npi: string, cfg: VerifyConfig): Promise<NppesRecord | null> {
  const url = new URL(cfg.nppesBaseUrl);
  url.searchParams.set('version', '2.1');
  url.searchParams.set('number', npi);

  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(cfg.timeoutMs) });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') throw new ToolError('NPPES did not answer in time');
    throw new ToolError('NPPES is unreachable');
  }
  if (!response.ok) throw new ToolError(`NPPES returned HTTP ${response.status}`);

  let body: NppesBody;
  try {
    body = (await response.json()) as NppesBody;
  } catch {
    throw new ToolError('NPPES returned a body that is not JSON');
  }
  // The registry answers a bad request with HTTP 200 and an Errors array.
  if (Array.isArray(body.Errors) && body.Errors.length > 0) {
    throw new ToolError(`NPPES rejected the lookup: ${body.Errors[0]?.description ?? 'unknown error'}`);
  }
  const first = body.results?.[0];
  if (!body.result_count || !first) return null;
  return recordFrom(first);
}

const verifyNppes = defineTool({
  name: 'verify_nppes',
  description:
    'Look an NPI up in the public CMS NPPES registry and report whether the registered name matches the provider on file. ' +
    'A synthetic or newly issued NPI will not be found; that is reported as found: false, not as a failure. ' +
    'Sends only the NPI, which is a public identifier, and changes nothing.',
  actionClass: 'read',
  input: z.object({
    npi: z.string().regex(/^\d{10}$/, 'NPI must be exactly ten digits'),
    provider_id: z.string().uuid().optional().describe('Compare the registry name against this provider on file'),
  }),
  output: z.object({
    npi: z.string(),
    found: z.boolean(),
    match: z.boolean().nullable().describe('Null when there is nothing to compare against: no provider given, or an organisation record'),
    registry_name: z.string().nullable(),
    registry_status: z.string().nullable(),
    registry_state: z.string().nullable(),
    enumeration_type: z.string().nullable(),
    expected_name: z.string().nullable(),
    checked_at: z.string(),
  }),
  handler: async ({ npi, provider_id }, deps) => {
    if (!deps.verify.nppesEnabled) {
      throw new ToolError('NPPES lookups are disabled for this client; set VERIFY_NPPES_ENABLED=true to allow them');
    }
    const provider = provider_id ? await requireProvider(deps, provider_id) : undefined;
    const record = await fetchNppes(npi, deps.verify);
    const checkedAt = deps.now().toISOString();

    if (!record) {
      return {
        npi,
        found: false,
        match: false,
        registry_name: null,
        registry_status: null,
        registry_state: null,
        enumeration_type: null,
        expected_name: provider?.name ?? null,
        checked_at: checkedAt,
      };
    }

    // An organisation record has no personal name to compare, so the tool
    // reports the registry name and leaves the judgement to a human.
    const comparable = provider !== undefined && record.enumerationType === 'NPI-1';
    return {
      npi,
      found: true,
      match: comparable ? namesMatch(provider.name, record.name) : null,
      registry_name: record.name,
      registry_status: record.status,
      registry_state: record.state,
      enumeration_type: record.enumerationType,
      expected_name: provider?.name ?? null,
      checked_at: checkedAt,
    };
  },
  recordIds: ({ provider_id }) => (provider_id ? [provider_id] : []),
});

const verifyStateLicense = defineTool({
  name: 'verify_state_license',
  description:
    'Check a state medical licence against the issuing board. No board is wired up yet, so this always reports "unsupported" ' +
    'with the state it would have needed. Use it to record that a check was attempted; never report a licence as verified from it.',
  actionClass: 'read',
  input: z.object({
    state: z.string().regex(/^[A-Za-z]{2}$/, 'state must be a two-letter code'),
    number: z.string().min(1),
  }),
  output: z.object({
    state: z.string(),
    status: z.literal('unsupported'),
    detail: z.string(),
  }),
  handler: async ({ state }, deps) => {
    const code = state.toUpperCase();
    return {
      state: code,
      status: 'unsupported' as const,
      detail: deps.verify.stateLicenseEnabled
        ? `No board adapter is implemented for ${code}. Verify this licence by hand at the ${code} medical board.`
        : `State licence verification is switched off for this client, and no board adapter exists for ${code} yet.`,
    };
  },
  // The licence number is restricted, so it must not be echoed into the
  // plaintext approval payload if a client ever reclassifies this tool.
  redact: (args) => ({ ...args, number: '[restricted]' }),
});

export const verifyTools: AnyToolDef[] = [verifyNppes, verifyStateLicense];
