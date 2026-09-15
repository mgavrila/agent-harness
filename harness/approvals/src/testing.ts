import { afterAll, beforeEach } from 'vitest';
import { createDb, type Db } from '@harness/db';
import { TEST_DATABASE_URL, resetDatabase } from '@harness/db/testing';
import type {
  SlackApi,
  SlackEphemeralArgs,
  SlackPostMessageArgs,
  SlackPostResult,
  SlackUpdateArgs,
  SlackUploadArgs,
  SlackViewOpenArgs,
} from './slack.js';
import type { CoreToolsClient, ExecuteOutcome } from './execute.js';

/**
 * The database for one test file: emptied before each test and closed when the
 * file finishes. Mirrors the helper in @harness/core-tools/testing.
 */
export function useTestDb(): Db {
  const { db, close } = createDb(TEST_DATABASE_URL);
  beforeEach(() => resetDatabase(db));
  afterAll(() => close());
  return db;
}

/**
 * A Slack that records instead of sending. Timestamps count up from a fixed
 * base so assertions can rely on ordering without matching a real clock.
 */
export class FakeSlack implements SlackApi {
  posts: SlackPostMessageArgs[] = [];
  updates: SlackUpdateArgs[] = [];
  uploads: SlackUploadArgs[] = [];
  opened: SlackViewOpenArgs[] = [];
  ephemeral: SlackEphemeralArgs[] = [];
  /** When set, every call rejects with this message. */
  failWith?: string;

  private seq = 0;

  private nextTs(): string {
    this.seq += 1;
    return `1789000000.${String(this.seq).padStart(6, '0')}`;
  }

  private guard(): void {
    if (this.failWith) throw new Error(this.failWith);
  }

  chat = {
    postMessage: async (args: SlackPostMessageArgs): Promise<SlackPostResult> => {
      this.guard();
      this.posts.push(args);
      return { ok: true, ts: this.nextTs(), channel: args.channel };
    },
    update: async (args: SlackUpdateArgs): Promise<SlackPostResult> => {
      this.guard();
      this.updates.push(args);
      return { ok: true, ts: args.ts, channel: args.channel };
    },
    postEphemeral: async (args: SlackEphemeralArgs): Promise<SlackPostResult> => {
      this.guard();
      this.ephemeral.push(args);
      return { ok: true, channel: args.channel };
    },
  };

  files = {
    uploadV2: async (args: SlackUploadArgs): Promise<{ ok?: boolean }> => {
      this.guard();
      this.uploads.push(args);
      return { ok: true };
    },
  };

  views = {
    open: async (args: SlackViewOpenArgs): Promise<{ ok?: boolean }> => {
      this.guard();
      this.opened.push(args);
      return { ok: true };
    },
  };
}

/** A core-tools client that records calls instead of spawning an MCP server. */
export class FakeCoreToolsClient implements CoreToolsClient {
  executed: string[] = [];
  reconciled: number[] = [];
  /** When set, `execute` reports this failure instead of succeeding. */
  failExecuteWith?: string;
  /** The tool name a successful execution reports. */
  executedTool = 'forms_release';
  closed = false;

  async execute(approvalId: string): Promise<ExecuteOutcome> {
    if (this.failExecuteWith) return { status: 'failed', error: this.failExecuteWith };
    this.executed.push(approvalId);
    return { status: 'executed', tool: this.executedTool };
  }

  async reconcile(staleAfterMinutes: number): Promise<{ approvals_expired: number; dispatches_parked: number }> {
    this.reconciled.push(staleAfterMinutes);
    return { approvals_expired: 0, dispatches_parked: 0 };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
