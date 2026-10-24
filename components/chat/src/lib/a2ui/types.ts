/**
 * Types for rendering an A2UI v0.9.1 surface with the basic catalog.
 *
 * A surface is a flat list of components that reference each other by id
 * (A2UI's adjacency-list model), plus a JSON data model the components bind
 * to. These types describe what the renderer reads; they do not validate it.
 * Anything the renderer cannot honor is reported as an {@link A2uiDiagnostic}
 * and rendered as nothing.
 */

/** A JSON value, as A2UI's data model and action contexts carry it. */
export type A2uiJsonValue =
  string | number | boolean | null | A2uiJsonValue[] | { [key: string]: A2uiJsonValue };

/** One component of a surface, as A2UI's `updateComponents` carries it. */
export type A2uiComponent = {
  /** Unique within the surface; the component with id `root` is the tree's root. */
  readonly id: string;
  /** The catalog component type, such as `Text` or `Button`. */
  readonly component: string;
  /** The component's properties. */
  readonly [property: string]: unknown;
};

/** A server event an A2UI action dispatches, as the component declares it. */
export type A2uiActionEvent = {
  readonly name: string;
  readonly context?: Readonly<Record<string, unknown>> | undefined;
};

/**
 * An action the host receives: the event's name, the surface and component it
 * came from, and when it happened, with its context resolved against the data
 * model at that moment (A2UI's client-to-server `action`).
 */
export type A2uiAction = {
  readonly name: string;
  readonly surfaceId: string;
  readonly sourceComponentId: string;
  /** ISO 8601. */
  readonly timestamp: string;
  readonly context: Readonly<Record<string, A2uiJsonValue>>;
  /**
   * The revision of the surface the user acted on, when the host told the renderer
   * (`A2uiSurfaceProps.surfaceRevision`). A server that checks it refuses an action taken on a
   * surface that has since changed, so the host sends it back with the action (Bureau reads it as
   * `metadata.a2uiSurfaceRevision`).
   */
  readonly surfaceRevision?: number | undefined;
};

/** What a diagnostic reports. */
export type A2uiDiagnosticCode =
  /** A component type outside the basic catalog. */
  | 'unsupported-component'
  /** An enumerated property value the catalog mapping does not list. */
  | 'unsupported-value'
  /** An icon name with no Cinder icon. */
  | 'unknown-icon'
  /** A reference to a component id the surface does not define. */
  | 'missing-component'
  /** A component that contains itself. */
  | 'component-cycle'
  /** A function the basic catalog does not define, or one that failed. */
  | 'function-error'
  /** An asset URL the host could not resolve. */
  | 'asset-error';

/**
 * Something the renderer could not honor. The renderer reports each distinct
 * problem once per surface and keeps rendering what it can.
 */
export type A2uiDiagnostic = {
  readonly code: A2uiDiagnosticCode;
  /** The component the problem is on, when there is one. */
  readonly componentId?: string | undefined;
  readonly message: string;
};

/**
 * Resolves an asset URL from a surface (an Image, Video, or AudioPlayer
 * source) to a URL the browser can load, such as a `blob:` URL the host
 * fetched with its own credentials.
 */
export type A2uiAssetUrlResolver = (url: string) => Promise<string>;

/** Props for the `A2uiSurface` component. */
export type A2uiSurfaceProps = {
  /** The surface's id, reported on every action. */
  surfaceId: string;
  /**
   * The revision of the surface the components and data model show. The renderer reports it as
   * `surfaceRevision` on every action, read when the action fires, so an action taken after an
   * update carries the updated revision and one taken on stale content is refused by the server.
   */
  surfaceRevision?: number | undefined;
  /** Every component the surface has received; later entries replace earlier ones with the same id. */
  components: readonly A2uiComponent[];
  /**
   * The surface's data model. The surface keeps its own copy, which input
   * components write to; a new value from the host replaces it.
   */
  dataModel?: A2uiJsonValue | undefined;
  /** Called when a Button dispatches a server event. */
  onAction?: ((action: A2uiAction, resolvedContext: A2uiAction['context']) => void) | undefined;
  /** Called each time an input component writes to the data model. */
  onDataModelChange?: ((dataModel: A2uiJsonValue) => void) | undefined;
  /** Resolves every asset URL before a media component receives it. Without one, assets render nothing. */
  resolveAssetUrl?: A2uiAssetUrlResolver | undefined;
  /** Called with a resolved asset URL once the surface no longer shows it, so the host can revoke it. */
  releaseAssetUrl?: ((resolvedUrl: string) => void) | undefined;
  /** Hears each problem the renderer could not honor. */
  onDiagnostic?: ((diagnostic: A2uiDiagnostic) => void) | undefined;
  /** The locale the formatting functions use; the runtime's default when omitted. */
  locale?: string | undefined;
  /**
   * The IANA time zone (`America/New_York`) a DateTimeInput shows a zoned
   * value (`2025-12-15T17:00:00Z`) in. A server-rendering host passes the
   * user's zone so the server's output and the hydrated page agree. When it is
   * omitted, a zoned value shows in UTC until the surface mounts and in the
   * runtime's zone after that, so hydration still matches the server.
   */
  timeZone?: string | undefined;
};
