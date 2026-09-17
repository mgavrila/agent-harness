import { readFile } from 'node:fs/promises';
import * as z from 'zod/v4';
import { ConfigError, hashArgs } from '@harness/shared';
import { defineRuntime } from './runtime.js';
import type { RunEvent, RunHandle, RunRequest, Runtime, RuntimeSession } from './types.js';

const StepShape = z.union([
  z.object({ tool: z.string().min(1), args: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ say: z.string() }).strict(),
  z.object({ skill: z.string().min(1), version: z.string().min(1) }).strict(),
  z.object({ sleep: z.number().int().min(0) }).strict(),
]);
export const TrajectoryShape = z.array(StepShape);
export type TrajectoryStep = z.infer<typeof StepShape>;
export type Trajectory = readonly TrajectoryStep[] | ((request: RunRequest) => readonly TrajectoryStep[]);

export function parseTrajectory(raw: unknown): TrajectoryStep[] {
  const parsed = TrajectoryShape.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`trajectory is invalid: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export async function readTrajectory(file: string): Promise<TrajectoryStep[]> {
  return parseTrajectory(JSON.parse(await readFile(file, 'utf8')));
}

/** The status the kernel's envelope carries, read off a tool result the way the host reads it. */
function statusOf(res: { isError?: boolean; structuredContent?: unknown }): 'ok' | 'pending' | 'error' {
  if (res.isError) return 'error';
  const status = (res.structuredContent as { status?: unknown } | undefined)?.status;
  return status === 'pending' ? 'pending' : 'ok';
}

function sleepUntil(ms: number, signal: AbortSignal): Promise<'slept' | 'aborted'> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve('aborted');
    const onAbort = () => {
      clearTimeout(timer);
      resolve('aborted');
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve('slept');
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A runtime that replays a trajectory instead of asking a model.
 *
 * Every `tool` step goes through `request.tools`, exactly as a real runtime's calls do, so the
 * host, the approvals bridge and the scheduler are tested against a loaded runtime whose tool
 * calls pass policy, audit and the outbox. `say` steps become text deltas and the joined `done`
 * text; a `skill` step is the activation event a real runtime emits when it reads a skill body; a
 * `sleep` step holds the run open so a cancel can be tested.
 */
export class ScriptedRuntime implements RuntimeSession {
  readonly name: string;
  readonly requests: RunRequest[] = [];
  stopped = false;

  private readonly trajectory: Trajectory;

  constructor(trajectory: Trajectory, name = 'scripted') {
    this.trajectory = trajectory;
    this.name = name;
  }

  run(request: RunRequest): RunHandle {
    this.requests.push(request);
    const steps = typeof this.trajectory === 'function' ? this.trajectory(request) : this.trajectory;
    const events = async function* (): AsyncGenerator<RunEvent> {
      const said: string[] = [];
      for (const step of steps) {
        if (request.signal.aborted) {
          yield { type: 'error', message: 'cancelled' };
          return;
        }
        if ('tool' in step) {
          yield { type: 'tool_call', name: step.tool, argsHash: hashArgs(step.args) };
          let status: 'ok' | 'pending' | 'error';
          try {
            status = statusOf(
              await request.tools.callTool({ name: step.tool, arguments: step.args }, { signal: request.signal }),
            );
          } catch {
            // A rejection while the signal is aborted is the abort itself, not the tool's own
            // failure: the run ends with `cancelled` and reports no result for this call, the
            // same as an abort caught mid-sleep. Any other rejection is a genuine tool failure.
            if (request.signal.aborted) {
              yield { type: 'error', message: 'cancelled' };
              return;
            }
            status = 'error';
          }
          yield { type: 'tool_result', name: step.tool, status };
        } else if ('say' in step) {
          said.push(step.say);
          yield { type: 'text', delta: step.say };
        } else if ('skill' in step) {
          yield { type: 'skill_activated', name: step.skill, version: step.version };
        } else if ((await sleepUntil(step.sleep, request.signal)) === 'aborted') {
          yield { type: 'error', message: 'cancelled' };
          return;
        }
      }
      yield { type: 'done', text: said.join('\n\n') };
    };
    return { events: events() };
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

/** A `Runtime` whose sessions replay `trajectory`: what a host test loads in place of a model-backed runtime. */
export function scriptedRuntime(trajectory: Trajectory): Runtime {
  return defineRuntime({
    name: 'scripted',
    version: '0.1.0',
    secrets: [],
    connect: async () => new ScriptedRuntime(trajectory),
  });
}
