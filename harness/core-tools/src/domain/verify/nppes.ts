import { ToolError, createLogger } from '@harness/shared';
import type { NppesRecord, VerifyConfig, VerifyRegistry } from './types.js';

const log = createLogger('verify');

export const NPPES_DEFAULT_BASE_URL = 'https://npiregistry.cms.hhs.gov/api/';

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

/**
 * Read whatever a returned record does say. Never returns null: the caller
 * already knows a record was returned, and reporting an unreadable one as
 * `found: false` would tell a credentialing reviewer this NPI is not
 * registered, which is the opposite of what the registry said. Fields that
 * cannot be read come back null so the reviewer sees a record with gaps.
 */
function recordFrom(result: NppesResult): NppesRecord {
  const enumerationType =
    result.enumeration_type === 'NPI-2' ? 'NPI-2' : result.enumeration_type === 'NPI-1' ? 'NPI-1' : null;
  const basic = result.basic ?? {};
  const name =
    enumerationType === 'NPI-2'
      ? (basic.organization_name ?? '')
      : [basic.first_name, basic.middle_name, basic.last_name].filter((p) => p && p !== '').join(' ');
  const location = (result.addresses ?? []).find((a) => a.address_purpose === 'LOCATION') ?? result.addresses?.[0];
  return {
    number: result.number ?? null,
    enumerationType,
    name: name === '' ? null : name,
    status: basic.status ?? null,
    state: location?.state ?? null,
  };
}

/**
 * One GET against the public NPPES registry. Returns null when the registry
 * simply has no such NPI, which is the expected answer for every synthetic NPI
 * in the demo corpus and is not an error.
 */
async function fetchNppes(npi: string, cfg: VerifyConfig): Promise<NppesRecord | null> {
  const url = new URL(cfg.nppesBaseUrl);
  url.searchParams.set('version', '2.1');
  url.searchParams.set('number', npi);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(cfg.timeoutMs),
      // Never follow a redirect: only cfg.nppesBaseUrl may ever receive the
      // NPI, and 'error' makes fetch reject rather than silently retarget the
      // request at whatever host the response names.
      redirect: 'error',
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') throw new ToolError('NPPES did not answer in time');
    // Covers both a transport failure and a rejected redirect; neither the
    // triggering URL nor any response body belongs in the message.
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
    // The description is a third-party response body, so it is logged for an
    // operator and kept out of the agent-visible message, which stays fixed
    // text like every other one in this file.
    const description = body.Errors[0]?.description;
    if (description) log.warn(`NPPES rejected a lookup: ${description}`);
    throw new ToolError('NPPES rejected the lookup');
  }
  const first = body.results?.[0];
  if (!body.result_count || !first) return null;
  return recordFrom(first);
}

/** The production `VerifyRegistry`, bound to one configuration. */
export function nppesRegistry(config: VerifyConfig): VerifyRegistry {
  return { lookupNpi: (npi) => fetchNppes(npi, config) };
}
