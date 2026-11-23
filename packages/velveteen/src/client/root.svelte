<script lang="ts">
  import { setContext } from "svelte";
  import {
    navigationContextKey,
    navigationStateContextKey,
    afterNavigate,
  } from "./navigation-context.ts";
  import type { ApplicationState, RenderNode } from "../data/contract.ts";
  let { state: applicationState }: { state: ApplicationState } = $props();
  setContext(navigationContextKey, () => applicationState.navigation);
  setContext(navigationStateContextKey, () => applicationState);

  let mounted = $state(false);
  let navigated = $state(false);
  let title = $state("");

  afterNavigate(() => {
    if (mounted) {
      navigated = true;
      title = document.title || "untitled page";
    } else {
      mounted = true;
    }
  });
</script>

{#snippet branch(nodes: RenderNode[], index: number)}
  {@const node = nodes[index]}
  {#if node}
    {#if node.component}
      {@const Component = node.component}
      {#key index === nodes.length - 1 ? (applicationState.pageKey ?? Component) : Component}
        <svelte:boundary
          onerror={(error) => applicationState.onError?.(error, index)}
        >
          <Component
            data={node.data}
            form={applicationState.page.payload.form ?? null}
            params={applicationState.page.payload.params}
            error={applicationState.page.payload.error}
            status={applicationState.page.payload.status}
          >
            {@render branch(nodes, index + 1)}
          </Component>
          {#snippet failed()}<p data-velveteen-error>
              Internal Error
            </p>{/snippet}
        </svelte:boundary>
      {/key}
    {:else}
      <h1 data-velveteen-error>
        {applicationState.page.payload.status}: {applicationState.page.payload
          .error?.message ?? "Not Found"}
      </h1>
    {/if}
  {/if}
{/snippet}
{@render branch(applicationState.page.branch, 0)}

{#if mounted}
  <div
    id="svelte-announcer"
    aria-live="assertive"
    aria-atomic="true"
    style="position: absolute; left: 0; top: 0; clip: rect(0 0 0 0); clip-path: inset(50%); overflow: hidden; white-space: nowrap; width: 1px; height: 1px"
  >
    {#if navigated}{title}{/if}
  </div>
{/if}
