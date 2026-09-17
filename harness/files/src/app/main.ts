import path from 'node:path';
import { ConfigError, createLogger, numberFromEnv, optionalEnv, requiredEnv } from '@harness/shared';
import { missingBinaries } from '../domain/extract.js';
import { createFilesServer } from '../domain/server.js';

const log = createLogger('files');

// No dotenv here, on purpose: the worker's whole environment is the three variables Compose
// gives it, and a repository .env carries the key and the database URL it must never see.
const storageDir = requiredEnv('HARNESS_STORAGE_DIR', '; the worker parses documents under it and nothing else');
if (!path.isAbsolute(storageDir)) throw new ConfigError('HARNESS_STORAGE_DIR must be an absolute path');
const port = numberFromEnv('HARNESS_FILES_PORT', 8790, { min: 1, max: 65_535, integer: true });
// Loopback by default, for a bare-metal run; Compose sets 0.0.0.0, where the internal network
// is the boundary and a container-loopback listener would answer nobody.
const bind = optionalEnv('HARNESS_FILES_BIND') ?? '127.0.0.1';

const missing = await missingBinaries();
if (missing.length > 0) {
  throw new ConfigError(
    `the files worker needs ${missing.join(', ')} on PATH; install poppler-utils and tesseract-ocr`,
  );
}

const server = createFilesServer({ storageDir, log });
server.listen(port, bind, () => log.info(`listening on http://${bind}:${port}, storage root ${storageDir}`));

function shutdown(signal: string): void {
  log.info(`${signal} received, stopping`);
  server.close(() => process.exit(0));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
