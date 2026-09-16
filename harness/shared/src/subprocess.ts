import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface RunBoundedOptions {
  /** Hard ceiling. The child is SIGKILLed, not SIGTERMed, so a wedged binary cannot ignore it. */
  timeoutMs: number;
  cwd?: string;
  maxBuffer?: number;
}

/**
 * Deliberately no stdout on the failure branch. `tesseract` and `pdftoppm` print fragments of
 * the page they were reading, and a caller that pasted that into an error message would put
 * document text into `audit_log.error`. Callers map `reason` onto their own fixed wording.
 */
export type RunBoundedOutcome =
  { ok: true; stdout: string; stderr: string } | { ok: false; reason: 'timeout' | 'failed' };

/**
 * True when `execFile` rejected because the process was killed for running past its `timeout`,
 * rather than failing on its own. Node sets `killed` only when something sent the process a
 * signal, and `killSignal: 'SIGKILL'` below is the only thing that does, so this is unambiguous.
 */
function isTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { killed?: boolean }).killed === true;
}

/**
 * Run a child process with a hard time limit. The three `execFile` wrappers this replaces
 * (OCR, the synthetic corpus rasteriser, the form-template builder) each reimplemented the
 * timeout plumbing, and only one of them set `killSignal`.
 */
export async function runBounded(
  command: string,
  args: string[],
  options: RunBoundedOptions,
): Promise<RunBoundedOutcome> {
  try {
    const { stdout, stderr } = await run(command, args, {
      timeout: options.timeoutMs,
      killSignal: 'SIGKILL',
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    return { ok: false, reason: isTimeout(err) ? 'timeout' : 'failed' };
  }
}
