import { describe, expect, it } from 'vitest';
import { surface } from './index.js';

describe('the Slack surface declaration', () => {
  it('declares its name and the credentials that must never reach a child process', () => {
    expect(surface.name).toBe('slack');
    expect([...surface.secrets].sort()).toEqual([
      'APPROVALS_SLACK_APP_TOKEN',
      'APPROVALS_SLACK_BOT_TOKEN',
      'SLACK_APP_TOKEN',
      'SLACK_BOT_TOKEN',
    ]);
  });
});
