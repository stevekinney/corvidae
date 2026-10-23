<script lang="ts" module>
  import type { Snippet } from 'svelte';

  export type A2uiAssetProps = {
    /** The asset URL as the surface gives it. */
    url: string;
    /** The component the asset belongs to, for diagnostics. */
    componentId: string;
    /** Renders the media component with the resolved URL. */
    children: Snippet<[string]>;
  };
</script>

<script lang="ts">
  import { getA2uiRenderContext } from './render-context.ts';

  let { url, componentId, children }: A2uiAssetProps = $props();

  const context = getA2uiRenderContext();
  let resolved = $state<string | undefined>(undefined);

  // Every asset URL goes through the host's resolver before a media element
  // sees it, because a media element cannot send the host's credentials. The
  // resolved URL is released when the asset changes or the view unmounts.
  $effect(() => {
    const source = url;
    const resolver = context.resolveAssetUrl;
    let current: string | undefined;
    let active = true;
    if (resolver === undefined) {
      context.report(
        'asset-error',
        componentId,
        'no resolveAssetUrl was given, so the asset is not shown',
      );
    } else if (source !== '') {
      void (async () => {
        try {
          const value = await resolver(source);
          if (!active) {
            context.releaseAssetUrl(value);
            return;
          }
          current = value;
          resolved = value;
        } catch (error: unknown) {
          context.report(
            'asset-error',
            componentId,
            `the asset could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })();
    }
    return () => {
      active = false;
      resolved = undefined;
      if (current !== undefined) context.releaseAssetUrl(current);
    };
  });
</script>

{#if resolved !== undefined}
  {@render children(resolved)}
{/if}
