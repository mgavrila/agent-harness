export { loadCatalog } from './domain/catalog/load.js';
export { BlueprintInputShape, CatalogMetaShape } from './domain/catalog/meta.js';
export type { BlueprintInput, Catalog, CatalogMeta, LoadedBlueprint, SurfaceKind } from './domain/catalog/types.js';
export { getPointer, hasPointer, pointerSegments, pointersOverlap, setPointer } from './shared/pointer.js';
