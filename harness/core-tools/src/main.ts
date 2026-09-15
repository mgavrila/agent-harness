import 'dotenv/config';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildDepsFromEnv, createCoreToolsServer } from './server.js';

const { deps, close } = await buildDepsFromEnv();

serveStdio(() => createCoreToolsServer(deps));
console.error(`core-tools listening on stdio (client=${deps.client}, caller=${deps.caller})`);

process.on('SIGINT', () => {
  void close().then(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void close().then(() => process.exit(0));
});
