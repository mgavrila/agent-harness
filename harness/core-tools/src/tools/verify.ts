import * as z from 'zod/v4';
import { ToolError } from '@harness/shared';
import { defineTool } from '../domain/tooling/registry.js';
import type { AnyToolDef } from '../domain/tooling/types.js';
import { requireProvider } from '../domain/providers/repository.js';
import { namesMatch } from '../domain/verify/names.js';
import { nppesRegistry } from '../domain/verify/nppes.js';

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
    match: z
      .boolean()
      .nullable()
      .describe('Null when there is nothing to compare against: no provider given, or an organisation record'),
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
    const record = await nppesRegistry(deps.verify).lookupNpi(npi);
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

    // An organisation record has no personal name to compare, and a record
    // whose name could not be read has nothing to compare either, so the tool
    // reports what the registry said and leaves the judgement to a human.
    const comparable = provider !== undefined && record.enumerationType === 'NPI-1' && record.name !== null;
    return {
      npi,
      found: true,
      match: comparable ? namesMatch(provider.name, record.name!) : null,
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
