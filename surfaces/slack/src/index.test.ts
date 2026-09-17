import { describe, expect, it } from 'vitest';
import { surface } from './index.js';

describe('the Slack surface declaration', () => {
  it('declares its name and the credentials the host must never forward or log', () => {
    expect(surface.name).toBe('slack');
    expect([...surface.secrets].sort()).toEqual(['SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN']);
  });
});
