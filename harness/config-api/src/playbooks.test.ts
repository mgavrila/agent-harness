import { describe, expect, it } from 'vitest';
import { parsePlaybooksFile } from './playbooks.js';

const nightly = {
  name: 'nightly-renewals',
  schedule: '0 7 * * *',
  timezone: 'America/New_York',
  skill: 'renewals',
  prompt: 'Run the renewals playbook for today.',
  principal: 'svc-playbooks',
  cost_cap_usd: 0.5,
};

describe('parsePlaybooksFile', () => {
  it('applies the defaults and keeps what was given', () => {
    const [p] = parsePlaybooksFile({ playbooks: [nightly] });
    expect(p).toEqual({
      ...nightly,
      deliver: 'none',
      timeout_s: 600,
      enabled: true,
      surface: undefined,
      conversation: undefined,
    });
  });

  it('defaults the timezone to UTC and accepts an empty file', () => {
    const { timezone: _timezone, ...rest } = nightly;
    expect(parsePlaybooksFile({ playbooks: [rest] })[0].timezone).toBe('UTC');
    expect(parsePlaybooksFile({})).toEqual([]);
    expect(parsePlaybooksFile(null)).toEqual([]);
  });

  it('refuses a bad schedule, a bad timezone, a user principal, a duplicate name and an unknown key', () => {
    expect(() => parsePlaybooksFile({ playbooks: [{ ...nightly, schedule: 'every morning' }] })).toThrow(
      /schedule must be a cron expression/,
    );
    expect(() => parsePlaybooksFile({ playbooks: [{ ...nightly, timezone: 'Nowhere/City' }] })).toThrow(
      /timezone must be an IANA zone name/,
    );
    expect(() => parsePlaybooksFile({ playbooks: [{ ...nightly, principal: 'u-coordinator' }] })).toThrow(
      /must run as a service principal/,
    );
    expect(() => parsePlaybooksFile({ playbooks: [nightly, nightly] })).toThrow(
      /playbooks: "nightly-renewals" is declared twice/,
    );
    expect(() => parsePlaybooksFile({ playbooks: [{ ...nightly, channel: 'C1' }] })).toThrow(/playbooks are invalid/);
    expect(() => parsePlaybooksFile({ playbooks: [{ ...nightly, deliver: 'email' }] })).toThrow(
      /playbooks are invalid/,
    );
    expect(() => parsePlaybooksFile({ playbooks: [{ ...nightly, cost_cap_usd: 0 }] })).toThrow(/playbooks are invalid/);
  });

  it('refuses a schedule that can never fire, and the shapes croner takes but a playbook may not', () => {
    const refused = /schedule must be a cron expression of five or six fields that fires at least once/;
    // Five ordinary fields, an impossible calendar date: croner builds it happily and only reports
    // the impossibility from nextRun, which would be a startup crash instead of a parse error.
    expect(() => parsePlaybooksFile({ playbooks: [{ ...nightly, schedule: '0 0 30 2 *' }] })).toThrow(refused);
    // Seven fields, a nickname and an ISO one-shot date: croner takes all three, decision 12 does not.
    expect(() => parsePlaybooksFile({ playbooks: [{ ...nightly, schedule: '0 0 * * * * *' }] })).toThrow(refused);
    expect(() => parsePlaybooksFile({ playbooks: [{ ...nightly, schedule: '@daily' }] })).toThrow(refused);
    expect(() => parsePlaybooksFile({ playbooks: [{ ...nightly, schedule: '2030-01-01T00:00:00' }] })).toThrow(refused);
    // The error names the field, so an operator knows which line of the file to go and fix.
    expect(() => parsePlaybooksFile({ playbooks: [{ ...nightly, schedule: '@daily' }] })).toThrow(/schedule/);
    // Six fields, seconds first, is still a playbook's to use.
    expect(parsePlaybooksFile({ playbooks: [{ ...nightly, schedule: '0 0 7 * * *' }] })[0].schedule).toBe(
      '0 0 7 * * *',
    );
  });
});
