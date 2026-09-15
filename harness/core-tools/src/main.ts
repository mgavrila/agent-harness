import 'dotenv/config';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildDepsFromEnv, createCoreToolsServer } from './server.js';

const { deps, close } = await buildDepsFromEnv();

serveStdio(() => createCoreToolsServer(deps));
console.error(`core-tools listening on stdio (client=${deps.client}, caller=${deps.caller})`);

async function shutdown(signal: string): Promise<void> {
  try {
    await close();
    process.exit(0);
  } catch (err) {
    console.error(`core-tools: shutdown after ${signal} failed:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
