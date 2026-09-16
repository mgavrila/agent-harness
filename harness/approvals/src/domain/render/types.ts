import type { approvals } from '@harness/db';

export type ApprovalRow = typeof approvals.$inferSelect;

export const APPROVE_ACTION_ID = 'harness_approval_approve';
export const EDIT_ACTION_ID = 'harness_approval_edit';
export const DECLINE_ACTION_ID = 'harness_approval_decline';
export const EDIT_MODAL_CALLBACK_ID = 'harness_approval_edit_modal';
export const EDIT_NOTE_BLOCK_ID = 'harness_approval_note';
export const EDIT_NOTE_ACTION_ID = 'harness_approval_note_input';

/** What `editModalView` encodes into `private_metadata` and `parseEditModalMetadata` decodes back. */
export interface EditModalMetadata {
  approvalId: string;
  channel: string;
}
