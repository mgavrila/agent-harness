import { describe, it, expect } from 'vitest';
import { approvalRow as row } from '../../testing.js';
import { editModalView, parseEditModalMetadata } from './modal.js';
import { EDIT_MODAL_CALLBACK_ID } from './types.js';

describe('editModalView', () => {
  it('carries the approval id and channel in private_metadata', () => {
    const view = editModalView(row().id, 'C0DEMO') as { callback_id: string; private_metadata: string };
    expect(view.callback_id).toBe(EDIT_MODAL_CALLBACK_ID);
    expect(JSON.parse(view.private_metadata)).toEqual({ approval_id: row().id, channel: 'C0DEMO' });
  });
});

describe('parseEditModalMetadata', () => {
  it('round-trips what editModalView encoded', () => {
    const view = editModalView(row().id, 'C0DEMO') as { private_metadata: string };
    expect(parseEditModalMetadata(view.private_metadata)).toEqual({ approvalId: row().id, channel: 'C0DEMO' });
  });

  it('returns null for anything that is not the expected shape', () => {
    expect(parseEditModalMetadata('not-json')).toBeNull();
    expect(parseEditModalMetadata(row().id)).toBeNull();
    expect(parseEditModalMetadata('{}')).toBeNull();
    expect(parseEditModalMetadata(JSON.stringify({ approval_id: row().id }))).toBeNull();
    expect(parseEditModalMetadata(JSON.stringify({ approval_id: '', channel: 'C0DEMO' }))).toBeNull();
    expect(parseEditModalMetadata(JSON.stringify({ approval_id: row().id, channel: '' }))).toBeNull();
  });
});
