/**
 * A client document from a directory: `HARNESS_CLIENTS_DIR/<id>/client.yaml`, or a blueprint and
 * an overlay resolved on load. See ARCHITECTURE.md, "The client document".
 */
export { INCLUDE_TAG, parseWithIncludes } from './include.js';
export { WATCH_DEBOUNCE_MS, filesConfigSource, type FilesConfigSourceOptions } from './source.js';
