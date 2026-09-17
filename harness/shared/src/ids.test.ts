import { describe, expect, it } from 'vitest';
import { CONVERSATION_ID_PATTERN, SURFACE_NAME_PATTERN } from './ids.js';

describe('CONVERSATION_ID_PATTERN', () => {
  it('accepts a conversation id from each surface the harness expects to meet', () => {
    for (const id of [
      'C0DEMO', // Slack channel
      'D01AB2CD3EF', // Slack direct message
      '19:meeting_NzJhMjkx@thread.v2', // Microsoft Teams
      '1001234567890', // Telegram, presented without its sign
      'memory', // the in-process surface
      'team.support-1',
    ]) {
      expect(CONVERSATION_ID_PATTERN.test(id), id).toBe(true);
    }
  });

  it('refuses anything that is not a bare identifier', () => {
    for (const id of ['', ' ', '-1001234567890', '#general', 'a b', 'a/b', `x${'y'.repeat(128)}`]) {
      expect(CONVERSATION_ID_PATTERN.test(id), id).toBe(false);
    }
  });
});

describe('SURFACE_NAME_PATTERN', () => {
  it('accepts a lowercase adapter name and refuses anything else', () => {
    expect(SURFACE_NAME_PATTERN.test('slack')).toBe(true);
    expect(SURFACE_NAME_PATTERN.test('ms-teams')).toBe(true);
    expect(SURFACE_NAME_PATTERN.test('Slack')).toBe(false);
    expect(SURFACE_NAME_PATTERN.test('1slack')).toBe(false);
    expect(SURFACE_NAME_PATTERN.test('slack_app')).toBe(false);
  });
});
