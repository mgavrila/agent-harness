import { defineRuntime, type RunEvent, type Runtime } from '@harness/runtime-api';
import { openCheckpointer } from './domain/checkpointer.js';
import { EventQueue } from './domain/events.js';
import { runDeepAgent } from './domain/run.js';

/**
 * Deep Agents JS as a runtime plug-in. The host loads this by name from `HARNESS_RUNTIME` and
 * holds nothing but the contract; every framework word lives under this directory. It reads no
 * environment of its own: the model gateway arrives on every request, the database URL on the
 * deps, and `storageDir` is not needed — the model reaches no filesystem.
 */
export const runtime: Runtime = defineRuntime({
  name: 'deepagents',
  version: '0.1.0',
  secrets: [],
  connect: async (deps) => {
    const checkpointer = await openCheckpointer(deps.databaseUrl);
    deps.log.info('deepagents: checkpointer ready in schema langgraph');
    return {
      name: 'deepagents',
      run(request) {
        const queue = new EventQueue<RunEvent>();
        void runDeepAgent(request, { checkpointer, log: deps.log }, queue);
        return { events: queue };
      },
      stop: () => checkpointer.end(),
    };
  },
});
