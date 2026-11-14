<script lang="ts">
  /**
   * What the agent editor shows instead of its form when the model catalog is empty. An agent runs
   * on a model and the catalog is what the host's configured providers offer, so with no provider
   * nothing the form could ask for would save. The application cannot add a provider (that is the
   * host's configuration file and a secret, both read once at start), so the state says exactly
   * where each lives, on this installation, from `/host/paths`, and what to do after.
   *
   * Where a key can be saved from Settings › Models, the state is the card the New agent board
   * draws (rows 42a, 42b): a plug in an accent disc, "No model provider yet", what to do, a primary
   * Connect a provider that returns to this form once a provider is connected (row 42c), and the
   * line saying nothing else on the form works until then. The steps to set one up by hand follow,
   * for a person who would rather edit the files; a host that keeps its keys in its deployment has
   * no Connect a provider, so the steps are all it shows.
   *
   * Only the Connect button is the state's action, which Cinder lays out as a row of buttons
   * (COR-2415). The two lines and the numbered steps are the state's children, which Cinder draws
   * under the action in reading order: the description, Connect a provider, the line under it, "Or
   * set it up by hand:", then the steps.
   */
  import { Button, CodeBlock, CodeLocation, EmptyState } from '@lostgradient/cinder';
  import { Plug } from '@lucide/svelte';

  import { AGENT_EDITOR_COPY } from '../../app/copy/agents.ts';
  import type { HostPaths } from '../../lib/host-paths.ts';
  import { connectProviderPath } from '../../lib/provider-return.ts';
  import { router } from '../../lib/router.svelte.ts';

  interface Props {
    /** Where the host keeps its configuration and secrets, or `undefined` when it did not say. */
    paths: HostPaths | undefined;
    /** Asks the Bureau again, so a provider added since shows its models. */
    onReload: () => void;
    /** The catalog is being read again. */
    reloading: boolean;
  }

  let { paths, onReload, reloading }: Props = $props();

  /** The steps name where each thing lives, so a host that keeps its state in a bucket says so. */
  const copy = $derived(
    paths?.mode === 'remote'
      ? { ...AGENT_EDITOR_COPY.noProvider, ...AGENT_EDITOR_COPY.remote.noProvider }
      : AGENT_EDITOR_COPY.noProvider,
  );

  /**
   * Whether a key can be saved from Settings › Models: a host that keeps its keys in its
   * deployment refuses it, and then the steps below are the only way.
   */
  const canConnect = $derived(paths?.locked.providerKeys === undefined);
  const connectPath = $derived(connectProviderPath(router.pathname));

  function connect(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(connectPath);
  }

  /** The first provider the host offers, as the example plugin the snippet enables. */
  const snippet = $derived.by(() => {
    const example = paths?.providers[0]?.name;
    return example === undefined
      ? undefined
      : JSON.stringify({ plugins: { [example]: { enabled: true } } }, null, 2);
  });
</script>

<EmptyState
  kind="first-use"
  title={copy.title}
  headingLevel={2}
  align="start"
  description={copy.description}
  {...canConnect ? { action: connectAction } : {}}
  class="weft-no-provider"
  data-testid="agent-no-provider"
>
  {#snippet icon()}
    <Plug size={20} aria-hidden="true" />
  {/snippet}
  {#if canConnect}
    <p class="weft-no-provider__text" data-testid="agent-no-provider-blocked">{copy.blocked}</p>
    <p class="weft-no-provider__text">{copy.byHand}</p>
  {/if}
  {@render steps()}
</EmptyState>

<!-- The action is the one button; the lines and the steps are the state's details under it. A host
     that keeps its keys in its deployment has no Connect a provider, so it has no action either. -->
{#snippet connectAction()}
  <Button
    variant="primary"
    href={router.href(connectPath)}
    onclick={connect}
    data-testid="agent-connect-provider">{copy.connectAction}</Button
  >
{/snippet}

{#snippet steps()}
  <ol class="weft-no-provider__steps">
    <li>
      <p class="weft-no-provider__text">{copy.configurationStep}</p>
      {#if paths !== undefined}
        <p class="weft-no-provider__path">
          <CodeLocation
            class="weft-code-location"
            file={paths.configurationFile}
            data-testid="provider-configuration-file"
          />
        </p>
      {/if}
      {#if snippet !== undefined}
        <CodeBlock code={snippet} language="json" copyable highlight={false} />
      {/if}
    </li>
    <li>
      <p class="weft-no-provider__text">{copy.secretStep}</p>
      {#if paths !== undefined}
        <ul class="weft-no-provider__secrets">
          {#each paths.providers as provider (provider.name)}
            <li data-provider={provider.name}>
              <code class="weft-no-provider__provider">{provider.name}</code>
              <CodeLocation class="weft-code-location" file={provider.secretFile} />
            </li>
          {/each}
        </ul>
      {/if}
    </li>
    <li>
      <p class="weft-no-provider__text">{copy.restartStep}</p>
      <Button variant="secondary" disabled={reloading} onclick={onReload}>{copy.reload}</Button>
    </li>
  </ol>
{/snippet}

<style>
  /* The outlet already pads the page; the state adds only a little air above its steps, and its steps fill the width. */
  :global(.weft-no-provider) {
    padding-inline: 0;
    padding-block: var(--cinder-space-4);
    align-items: stretch;
  }

  .weft-no-provider__steps {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    margin: 0;
    padding-inline-start: var(--cinder-space-6);
    text-align: start;
  }

  .weft-no-provider__text {
    margin: 0 0 var(--cinder-space-2);
  }

  .weft-no-provider__path {
    margin: 0 0 var(--cinder-space-2);
    overflow-wrap: anywhere;
  }

  .weft-no-provider__secrets {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .weft-no-provider__secrets li {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
    align-items: baseline;
    overflow-wrap: anywhere;
  }

  .weft-no-provider__provider {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }
</style>
