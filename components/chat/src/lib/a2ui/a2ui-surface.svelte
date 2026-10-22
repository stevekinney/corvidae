<script lang="ts" module>
  import type { A2uiSurfaceProps } from './types.ts';

  export type { A2uiSurfaceProps };
</script>

<script lang="ts">
  import { untrack } from 'svelte';

  import A2uiNode from './a2ui-node.svelte';
  import { A2uiDataModel } from './data-model.svelte.ts';
  import { setA2uiRenderContext } from './render-context.ts';
  import type { A2uiComponent } from './types.ts';

  // Renders an A2UI v0.9.1 surface built from the basic catalog with Cinder
  // components, two-way data binding, the catalog's client functions, and
  // actions delivered to the host.
  let {
    surfaceId,
    components,
    dataModel,
    onAction,
    onDataModelChange,
    resolveAssetUrl,
    releaseAssetUrl,
    onDiagnostic,
    locale,
  }: A2uiSurfaceProps = $props();

  const idPrefix = $props.id();
  const model = new A2uiDataModel(
    untrack(() => dataModel),
    (value) => onDataModelChange?.(value),
  );

  // A new data model from the host (a server update) replaces the surface's copy.
  let seenDataModel = untrack(() => dataModel);
  $effect.pre(() => {
    const next = dataModel;
    if (next === seenDataModel) return;
    seenDataModel = next;
    model.replace(next);
  });

  const byId = $derived.by(() => {
    const map = new Map<string, A2uiComponent>();
    for (const component of components) map.set(component.id, component);
    return map;
  });

  const reported = new Set<string>();

  setA2uiRenderContext({
    get surfaceId() {
      return surfaceId;
    },
    component: (id) => byId.get(id),
    model,
    get locale() {
      return locale;
    },
    idPrefix: `a2ui${idPrefix}`,
    dispatch: (action) => onAction?.(action, action.context),
    get resolveAssetUrl() {
      return resolveAssetUrl;
    },
    releaseAssetUrl: (resolvedUrl) => releaseAssetUrl?.(resolvedUrl),
    report: (code, componentId, message) => {
      const key = `${code}\u0000${componentId ?? ''}\u0000${message}`;
      if (reported.has(key)) return;
      reported.add(key);
      onDiagnostic?.({ code, ...(componentId === undefined ? {} : { componentId }), message });
    },
  });
</script>

<div class="a2ui-surface" data-a2ui-surface={surfaceId}>
  {#if byId.has('root')}
    <A2uiNode id="root" scope="" ancestry={[]} />
  {/if}
</div>

<style>
  .a2ui-surface {
    display: flex;
    flex-direction: column;
    min-inline-size: 0;
  }
</style>
