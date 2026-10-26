<script lang="ts">
  /**
   * What the agent editor shows instead of its form when the model catalog is empty. An agent runs
   * on a model and the catalog is what the host's configured providers offer, so with no provider
   * nothing the form could ask for would save. The application cannot add a provider (that is the
   * host's configuration file and a secret, both read once at start), so the state says exactly
   * where each lives, on this installation, from `/host/paths`, and what to do after.
   */
  import { Button, CodeBlock, CodeLocation, EmptyState } from '@lostgradient/cinder';

  import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
  import type { HostPaths } from '../../lib/host-paths.ts';

  interface Props {
    /** Where the host keeps its configuration and secrets, or `undefined` when it did not say. */
    paths: HostPaths | undefined;
    /** Asks the Bureau again, so a provider added since shows its models. */
    onReload: () => void;
    /** The catalog is being read again. */
    reloading: boolean;
  }

  let { paths, onReload, reloading }: Props = $props();

  const copy = AGENT_EDITOR_COPY.noProvider;

  /** The first provider the host accepts, as the example the snippet configures. */
  const snippet = $derived.by(() => {
    const example = paths?.providers[0]?.name;
    return example === undefined
      ? undefined
      : JSON.stringify({ providers: { [example]: {} } }, null, 2);
  });
</script>

<EmptyState
  title={copy.title}
  headingLevel={2}
  align="start"
  description={copy.description}
  class="weft-no-provider"
  data-testid="agent-no-provider"
>
  {#snippet action()}
    <ol class="weft-no-provider__steps">
      <li>
        <p class="weft-no-provider__text">{copy.configurationStep}</p>
        {#if paths !== undefined}
          <p class="weft-no-provider__path">
            <CodeLocation
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
                <CodeLocation file={provider.secretFile} />
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
</EmptyState>

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
