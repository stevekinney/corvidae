/**
 * The A2UI client capabilities a host using `A2uiSurface` declares. `A2uiSurface` renders the
 * A2UI v0.9.1 basic catalog only, so that is the only catalog id it may list: a server that
 * offers a catalog to every client that lists it (Bureau offers Cinder's) would otherwise send
 * components the surface reports as `unsupported-component` and renders as nothing.
 */

/** The id of the only catalog `A2uiSurface` renders, the A2UI v0.9.1 basic catalog. */
export const A2UI_SURFACE_CATALOG_ID =
  'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json' as const;

/**
 * The `a2uiClientCapabilities` a host forwards, or sends as A2A message metadata, when it
 * renders surfaces with `A2uiSurface`. Its type admits the basic catalog's id and no other.
 */
export const A2UI_SURFACE_CLIENT_CAPABILITIES = {
  'v0.9': { supportedCatalogIds: [A2UI_SURFACE_CATALOG_ID] },
} as const;
