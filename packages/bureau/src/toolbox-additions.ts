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
 * so a gate over the base narrows the added tools too. A tool `base` already has is the host's
 * and wins: an addition of the same name is not added.
 */
export function withAddedTools(base: AnyToolbox, additions: AnyToolbox): AnyToolbox {
  const layer = layers.get(base);
  if (layer !== undefined) {
    return withToolboxLayer(withAddedTools(layer.inner, additions), layer.apply);
  }
  const added = additions.toJSON().filter((configuration) => {
    const existing = base.resolveTool(configuration.name);
    return !existing.ok && existing.reason === 'missing';
  });
  if (added.length === 0) return base;
  return base.extend(createToolbox(added));
}
