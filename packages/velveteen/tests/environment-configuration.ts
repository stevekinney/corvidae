export type VelveteenTestEnvironment = Readonly<{
  actionCorrupt: boolean;
  actionTransportPlainObject: boolean;
  announcerStaleTitle: boolean;
  endpointStatus?: string;
  fixtureCompression: boolean;
  inventoryAlterOwner?: string;
  inventoryAlterScript?: string;
  inventoryControls: boolean;
  inventoryRemoveEntry?: string;
  inventoryRemoveOwner?: string;
  inventoryRemoveScript?: string;
  layoutKCorrupt: boolean;
  optionalRestCorrupt: boolean;
  referenceKit?: string;
  remoteSplitBatches: boolean;
  routeEscapeDoubleEncode: boolean;
  runtimeCorrupt: boolean;
  snapshotCorrupt: boolean;
  transportPlainObject: boolean;
  typedMatcherCorrupt: boolean;
}>;

/** Read the test-only switches once at the process boundary with a typed shape. */
export function readVelveteenTestEnvironment(): VelveteenTestEnvironment {
  const environment = process.env;
  return {
    actionCorrupt: environment.VELVETEEN_ACTION_CORRUPT === "1",
    actionTransportPlainObject:
      environment.VELVETEEN_ACTION_TRANSPORT_PLAIN_OBJECT === "1",
    announcerStaleTitle: environment.VELVETEEN_ANNOUNCER_STALE_TITLE === "1",
    endpointStatus: environment.VELVETEEN_ENDPOINT_STATUS,
    fixtureCompression: environment.VELVETEEN_FIXTURE_COMPRESSION === "true",
    inventoryAlterOwner: environment.VELVETEEN_INVENTORY_ALTER_OWNER,
    inventoryAlterScript: environment.VELVETEEN_INVENTORY_ALTER_SCRIPT,
    inventoryControls: environment.VELVETEEN_INVENTORY_CONTROLS === "1",
    inventoryRemoveEntry: environment.VELVETEEN_INVENTORY_REMOVE_ENTRY,
    inventoryRemoveOwner: environment.VELVETEEN_INVENTORY_REMOVE_OWNER,
    inventoryRemoveScript: environment.VELVETEEN_INVENTORY_REMOVE_SCRIPT,
    layoutKCorrupt: environment.VELVETEEN_LAYOUT_K_CORRUPT === "1",
    optionalRestCorrupt: environment.VELVETEEN_OPTIONAL_REST_CORRUPT === "1",
    referenceKit: environment.VELVETEEN_REFERENCE_KIT,
    remoteSplitBatches: environment.VELVETEEN_REMOTE_SPLIT_BATCHES === "1",
    routeEscapeDoubleEncode:
      environment.VELVETEEN_ROUTE_ESCAPE_DOUBLE_ENCODE === "1",
    runtimeCorrupt: environment.VELVETEEN_RUNTIME_CORRUPT === "1",
    snapshotCorrupt: environment.VELVETEEN_SNAPSHOT_CORRUPT === "1",
    transportPlainObject: environment.VELVETEEN_TRANSPORT_PLAIN_OBJECT === "1",
    typedMatcherCorrupt: environment.VELVETEEN_TYPED_MATCHER_CORRUPT === "1",
  };
}
