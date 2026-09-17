import { describe, expect, it } from 'vitest';
import { SurfaceFilePayloadShape, SurfaceMessagePayloadShape } from './models.js';

describe('SurfaceMessagePayloadShape', () => {
  it('accepts what the kernel stages today', () => {
    const parsed = SurfaceMessagePayloadShape.parse({
      text: 'two expire soon',
      conversation: 'C0DEMO',
      surface: 'slack',
    });
    expect(parsed).toMatchObject({ text: 'two expire soon', conversation: 'C0DEMO', surface: 'slack' });
  });

  it('accepts an explicit null for both addressing fields, which means "the default"', () => {
    expect(
      SurfaceMessagePayloadShape.parse({ text: 'hello', conversation: null, surface: null }).conversation,
    ).toBeNull();
  });

  it('accepts a row staged before migration 0009, which carries the conversation as `channel`', () => {
    expect(SurfaceMessagePayloadShape.parse({ text: 'hello', channel: 'C0OLD' }).channel).toBe('C0OLD');
  });

  it('refuses a conversation id that is not a bare identifier, and text over the cap', () => {
    expect(SurfaceMessagePayloadShape.safeParse({ text: 'hi', conversation: 'no spaces here' }).success).toBe(false);
    expect(SurfaceMessagePayloadShape.safeParse({ text: 'x'.repeat(3001) }).success).toBe(false);
  });

  it('refuses a surface name that is not a lowercase identifier', () => {
    expect(SurfaceMessagePayloadShape.safeParse({ text: 'hi', surface: 'Slack' }).success).toBe(false);
  });
});

describe('SurfaceFilePayloadShape', () => {
  it('accepts a staged release', () => {
    const parsed = SurfaceFilePayloadShape.parse({
      path: '/srv/harness-storage/out/roster/a.csv',
      filename: 'a.csv',
      file_id: 'roster/a.csv',
      surface: 'slack',
    });
    expect(parsed.filename).toBe('a.csv');
  });

  it('refuses a payload with no path', () => {
    expect(SurfaceFilePayloadShape.safeParse({ filename: 'a.csv' }).success).toBe(false);
  });
});
