import { type AnyToolbox, createToolbox } from 'armorer';

type ToolboxLayer = {
  readonly inner: AnyToolbox;
  readonly apply: (rebuilt: AnyToolbox) => AnyToolbox;
};

const layers = new WeakMap<AnyToolbox, ToolboxLayer>();

/**
 * COR-1700 — wraps `inner` in a layer that adds behavior from outside the toolbox, such as the
 * active-skill gate or a default request context, and remembers how, so {@link withAddedTools} can
 * put the same layer back around a toolbox it extended. `apply` receives the toolbox to wrap and
 * must wrap it the same way every time. Returns the wrapped toolbox.
 */
export function withToolboxLayer(
  inner: AnyToolbox,
  apply: (rebuilt: AnyToolbox) => AnyToolbox,
): AnyToolbox {
  const wrapped = apply(inner);
  layers.set(wrapped, { inner, apply });
  return wrapped;
}

/**
 * COR-1700 — adds `additions`' tools to `base` without losing anything `base` carries. The same
 * class as COR-321: armorer's `combineToolboxes` rebuilds a toolbox from tool configurations and
 * so drops the idempotency cache, the active-skill gate, the default request context, and (one
 * property at a time, COR-321) the approval settings.
 *
 * This uses `extend()`, which armorer built to keep a toolbox's own options (approval policy,
 * secret, grant and approval stores, revisions) and which `withToolboxIdempotency` re-wraps. The
 * added tools therefore live in the one toolbox, under its approval policy, its execution mode and
 * limits, its durable operation keys, and its provider conversions. A layer put on by
 * {@link withToolboxLayer} is peeled, the extension made underneath, and the layer applied again,
 * so a gate over the base narrows the added tools too.
 *
 * COR-1875 — a tool `base` already answers to is a clash, and it throws {@link ToolClashError}
 * naming both ids, before anything is added. The base used to win silently, so a second plugin or
 * a host tool that shadowed an added one vanished without a trace. Every caller adds the tools of
 * one fixed feature (human input, decisions, wakeup, skills) to a toolbox composed once per run,
 * so none re-adds a tool on purpose; a clash is a wiring error to surface.
 */
export function withAddedTools(base: AnyToolbox, additions: AnyToolbox): AnyToolbox {
  const layer = layers.get(base);
  if (layer !== undefined) {
    return withToolboxLayer(withAddedTools(layer.inner, additions), layer.apply);
  }
  const added = additions.toJSON().filter((configuration) => {
    const existing = base.resolveTool(configuration.name);
    if (!existing.ok && existing.reason === 'missing') return true;
    const addedTool = additions.resolveTool(configuration.name);
    throw new ToolClashError(
      addedTool.ok ? addedTool.tool.id : configuration.name,
      existing.ok ? [existing.tool.id] : existing.candidates,
    );
  });
  if (added.length === 0) return base;
  return base.extend(createToolbox(added));
}

/**
 * COR-1875 — a tool being added to a toolbox that already has a tool of the same name. Nothing was
 * added: the toolbox is as it was.
 */
export class ToolClashError extends Error {
  /** The id of the tool that was being added. */
  readonly addedId: string;
  /** The ids of the tool or tools the toolbox already had under that name. */
  readonly existingIds: readonly string[];

  constructor(addedId: string, existingIds: readonly string[]) {
    super(
      `Cannot add tool "${addedId}": the toolbox already has ${existingIds
        .map((id) => `"${id}"`)
        .join(', ')}.`,
    );
    this.name = 'ToolClashError';
    this.addedId = addedId;
    this.existingIds = existingIds;
  }
}
