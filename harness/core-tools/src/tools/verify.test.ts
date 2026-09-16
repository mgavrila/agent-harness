import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ToolDeps } from '../domain/tooling/types.js';
import { connectTools, makeTestDeps, resultOf, useTestDb } from '../testing.js';
import { compatTools } from './compat.js';
import { verifyTools } from './verify.js';

const db = useTestDb();

/**
 * A stand-in for the NPPES registry. The response bodies below are copies of
 * what https://npiregistry.cms.hhs.gov/api/?version=2.1&number=... actually
 * returned on 2026-09-15, trimmed to the keys the tool reads.
 */
let registry: Server;
let registryUrl: string;
let reply: { status: number; body: unknown; location?: string } = {
  status: 200,
  body: { result_count: 0, results: [] },
};

const INDIVIDUAL = {
  result_count: 1,
  results: [
    {
      enumeration_type: 'NPI-1',
      number: '1063837144',
      basic: { first_name: 'JACKELYN', last_name: 'KELLEY', middle_name: 'RAE', credential: 'LCSW', status: 'A' },
      addresses: [{ address_purpose: 'LOCATION', state: 'CA' }],
    },
  ],
};

const ORGANISATION = {
  result_count: 1,
  results: [
    {
      enumeration_type: 'NPI-2',
      number: '1497758544',
      basic: { organization_name: 'CUMBERLAND COUNTY HOSPITAL SYSTEM, INC', status: 'A' },
      addresses: [{ address_purpose: 'LOCATION', state: 'NC' }],
    },
  ],
};

/** The registry answers a bad request with HTTP 200 and an Errors array. */
const REGISTRY_ERROR = { Errors: [{ description: 'NPI must be 10 digits', field: 'number', number: '06' }] };

/** A record the registry did return, but with the keys the tool reads missing. */
const UNREADABLE_RECORD = { result_count: 1, results: [{ basic: {}, addresses: [] }] };

beforeAll(async () => {
  registry = createServer((_req, res) => {
    res.writeHead(reply.status, {
      'content-type': 'application/json',
      ...(reply.location ? { location: reply.location } : {}),
    });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((r) => registry.listen(0, '127.0.0.1', r));
  registryUrl = `http://127.0.0.1:${(registry.address() as AddressInfo).port}/api/`;
});
afterAll(async () => {
  await new Promise<void>((r) => registry.close(() => r()));
});

function deps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  return makeTestDeps(db, {
    verify: { nppesEnabled: true, nppesBaseUrl: registryUrl, stateLicenseEnabled: false, timeoutMs: 5_000 },
    ...overrides,
  });
}

const connect = (d: ToolDeps = deps()) => connectTools('verify-test', [...compatTools(d), ...verifyTools], d);

interface NppesOut {
  npi: string;
  found: boolean;
  match: boolean | null;
  registry_name: string | null;
  registry_status: string | null;
  enumeration_type: string | null;
  expected_name: string | null;
}

describe('verify_nppes', () => {
  it('reports a match against the provider on file', async () => {
    reply = { status: 200, body: INDIVIDUAL };
    const client = await connect();
    const p = resultOf<{ provider_id: string }>(
      await client.callTool({ name: 'providers_upsert', arguments: { name: 'Jackelyn Kelley', npi: '1063837144' } }),
    );
    const out = resultOf<NppesOut>(
      await client.callTool({ name: 'verify_nppes', arguments: { npi: '1063837144', provider_id: p.provider_id } }),
    );
    expect(out).toMatchObject({
      found: true,
      match: true,
      registry_name: 'JACKELYN RAE KELLEY',
      registry_status: 'A',
      enumeration_type: 'NPI-1',
      expected_name: 'Jackelyn Kelley',
    });
  });

  it('flags a mismatch rather than failing', async () => {
    reply = { status: 200, body: INDIVIDUAL };
    const client = await connect();
    const p = resultOf<{ provider_id: string }>(
      await client.callTool({ name: 'providers_upsert', arguments: { name: 'Ada Lovelace', npi: '1063837144' } }),
    );
    const out = resultOf<NppesOut>(
      await client.callTool({ name: 'verify_nppes', arguments: { npi: '1063837144', provider_id: p.provider_id } }),
    );
    expect(out.found).toBe(true);
    expect(out.match).toBe(false);
  });

  it('reads an organisation record', async () => {
    reply = { status: 200, body: ORGANISATION };
    const client = await connect();
    const out = resultOf<NppesOut>(await client.callTool({ name: 'verify_nppes', arguments: { npi: '1497758544' } }));
    expect(out).toMatchObject({
      found: true,
      match: null,
      enumeration_type: 'NPI-2',
      registry_name: 'CUMBERLAND COUNTY HOSPITAL SYSTEM, INC',
      expected_name: null,
    });
  });

  it('reports not found for an NPI the registry does not have, which is what a synthetic NPI does', async () => {
    reply = { status: 200, body: { result_count: 0, results: [] } };
    const client = await connect();
    const out = resultOf<NppesOut>(await client.callTool({ name: 'verify_nppes', arguments: { npi: '1234567893' } }));
    expect(out).toMatchObject({ found: false, match: false, registry_name: null });
  });

  it('rejects a malformed NPI before any request', async () => {
    const client = await connect();
    const res = await client.callTool({ name: 'verify_nppes', arguments: { npi: '123' } });
    expect(res.isError).toBe(true);
  });

  it('reports a registry error as a ToolError without quoting the registry body', async () => {
    reply = { status: 200, body: REGISTRY_ERROR };
    const client = await connect();
    const res = await client.callTool({ name: 'verify_nppes', arguments: { npi: '0000000006' } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/NPPES rejected the lookup/);
    // The description is a third-party response body; it goes to stderr only.
    expect(JSON.stringify(res.content)).not.toMatch(/NPI must be 10 digits/);
  });

  it('reports a present but unreadable record as found, with nulls', async () => {
    // "This NPI is not registered" and "the registry holds a record we could
    // not read" are opposite answers to a credentialing question. A record
    // missing its enumeration type used to come back as found: false, which
    // reads as the first when the registry said the second.
    reply = { status: 200, body: UNREADABLE_RECORD };
    const client = await connect();
    const out = resultOf<NppesOut>(await client.callTool({ name: 'verify_nppes', arguments: { npi: '1063837144' } }));
    expect(out).toMatchObject({
      found: true,
      match: null,
      registry_name: null,
      registry_status: null,
      enumeration_type: null,
    });
  });

  it('surfaces a registry outage as a ToolError', async () => {
    reply = { status: 503, body: {} };
    const client = await connect();
    const res = await client.callTool({ name: 'verify_nppes', arguments: { npi: '1063837144' } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/NPPES/);
  });

  it('refuses a redirect to another host', async () => {
    reply = { status: 302, body: {}, location: 'http://169.254.169.254/latest/meta-data/' };
    const client = await connect();
    const res = await client.callTool({ name: 'verify_nppes', arguments: { npi: '1063837144' } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/NPPES/);
  });

  it('refuses when the lookup is switched off for the client', async () => {
    const client = await connect(
      deps({
        verify: { nppesEnabled: false, nppesBaseUrl: registryUrl, stateLicenseEnabled: false, timeoutMs: 5_000 },
      }),
    );
    const res = await client.callTool({ name: 'verify_nppes', arguments: { npi: '1063837144' } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/VERIFY_NPPES_ENABLED/);
  });

  it('refuses another client’s provider', async () => {
    reply = { status: 200, body: INDIVIDUAL };
    const client = await connect();
    const p = resultOf<{ provider_id: string }>(
      await client.callTool({ name: 'providers_upsert', arguments: { name: 'Jackelyn Kelley', npi: '1063837144' } }),
    );
    const otherDeps = deps({ client: 'other' });
    const other = await connectTools('other', [...compatTools(otherDeps), ...verifyTools], otherDeps);
    const res = await other.callTool({
      name: 'verify_nppes',
      arguments: { npi: '1063837144', provider_id: p.provider_id },
    });
    expect(res.isError).toBe(true);
  });
});

describe('verify_state_license', () => {
  it('reports unsupported, naming the state, when the flag is off', async () => {
    const client = await connect();
    const out = resultOf<{ state: string; status: string; detail: string }>(
      await client.callTool({ name: 'verify_state_license', arguments: { state: 'ca', number: 'A98765' } }),
    );
    expect(out.state).toBe('CA');
    expect(out.status).toBe('unsupported');
    expect(out.detail).toMatch(/CA/);
  });

  it('still reports unsupported when the flag is on, because no board is wired up yet', async () => {
    const client = await connect(
      deps({ verify: { nppesEnabled: true, nppesBaseUrl: registryUrl, stateLicenseEnabled: true, timeoutMs: 5_000 } }),
    );
    const out = resultOf<{ status: string }>(
      await client.callTool({ name: 'verify_state_license', arguments: { state: 'NY', number: 'L1' } }),
    );
    expect(out.status).toBe('unsupported');
  });

  it('rejects a state code that is not two letters', async () => {
    const client = await connect();
    const res = await client.callTool({
      name: 'verify_state_license',
      arguments: { state: 'California', number: 'A1' },
    });
    expect(res.isError).toBe(true);
  });
});
