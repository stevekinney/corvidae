<script lang="ts" module>
  import type { A2uiSurfaceProps } from './types.ts';

  export type { A2uiSurfaceProps };
</script>

<script lang="ts">
  import { untrack } from 'svelte';

  import A2uiNode from './a2ui-node.svelte';
  import { A2uiDataModel } from './data-model.svelte.ts';
  import { displayTimeZone } from './node-helpers.ts';
  import { setA2uiRenderContext } from './render-context.ts';
  import type { A2uiComponent, A2uiDiagnostic } from './types.ts';

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
    timeZone,
  }: A2uiSurfaceProps = $props();

  // Effects run only in the browser, after hydration: until then, a zoned
  // value without an explicit zone shows in UTC, as the server rendered it.
  let mounted = $state(false);
  $effect(() => {
    mounted = true;
  });

  const idPrefix = $props.id();
  const reported = new Set<string>();
  function report(code: A2uiDiagnostic['code'], componentId: string | undefined, message: string) {
    const key = `${code}\u0000${componentId ?? ''}\u0000${message}`;
    if (reported.has(key)) return;
    reported.add(key);
    onDiagnostic?.({ code, ...(componentId === undefined ? {} : { componentId }), message });
  }
  const model = new A2uiDataModel(
    untrack(() => dataModel),
    (value) => onDataModelChange?.(value),
  );

  // A new data model from the host (a server update) replaces the surface's
  // copy, and so does a new surface: nothing one surface's user typed reaches
  // another rendered in the same place.
  let seenDataModel = untrack(() => dataModel);
  let seenSurfaceId = untrack(() => surfaceId);
  $effect.pre(() => {
    const next = dataModel;
    const nextSurfaceId = surfaceId;
    if (next === seenDataModel && nextSurfaceId === seenSurfaceId) return;
    if (nextSurfaceId !== seenSurfaceId) reported.clear();
    seenDataModel = next;
    seenSurfaceId = nextSurfaceId;
    model.replace(next);
  });

  // The wire boundary: every record is checked here once, so nothing below
  // meets a component that is not an object with a string `id` and `component`.
  const byId = $derived.by(() => {
    const map = new Map<string, A2uiComponent>();
    const records: unknown = components;
    for (const [index, record] of (Array.isArray(records) ? records : []).entries()) {
      if (
        typeof record !== 'object' ||
        record === null ||
        typeof Reflect.get(record, 'id') !== 'string' ||
        typeof Reflect.get(record, 'component') !== 'string'
      ) {
        untrack(() =>
          report(
            'unsupported-value',
            undefined,
            `components[${index}] is not a component with a string id and component`,
          ),
        );
        continue;
      }
      const component = record as A2uiComponent;
      map.set(component.id, component);
    }
    return map;
  });

  setA2uiRenderContext({
    get surfaceId() {
      return surfaceId;
    },
    component: (id) => byId.get(id),
    model,
    get locale() {
      return locale;
    },
    get timeZone() {
      return displayTimeZone(timeZone, mounted);
    },
    idPrefix: `a2ui${idPrefix}`,
    dispatch: (action) => onAction?.(action, action.context),
    get resolveAssetUrl() {
      return resolveAssetUrl;
    },
    releaseAssetUrl: (resolvedUrl) => releaseAssetUrl?.(resolvedUrl),
    report,
  });
</script>

<div class="a2ui-surface" data-a2ui-surface={surfaceId}>
  {#if byId.has('root')}
    <!-- Keyed by surface, so a new surface's nodes start without the last one's edits. -->
    {#key surfaceId}
      <A2uiNode id="root" scope="" ancestry={[]} />
    {/key}
  {/if}
</div>

<style>
  .a2ui-surface {
    display: flex;
    flex-direction: column;
    min-inline-size: 0;
  }
</style>
