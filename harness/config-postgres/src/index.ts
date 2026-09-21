/**
 * A client document from versioned Postgres rows: one live row per client, and every version it
 * has had beside it. See ARCHITECTURE.md, "The client document".
 */
export {
  CONFIG_POLL_MS,
  postgresConfigSource,
  writeClientDocument,
  type PostgresConfigSourceOptions,
} from './source.js';
export { postgresSecretSource, writeClientSecret, type PostgresSecretSourceOptions } from './secrets.js';
