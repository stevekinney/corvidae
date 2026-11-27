<script lang="ts">
  /**
   * One problem a plugin or a folder has, as a card (board PageSettingsSections, "Plugin problems"):
   * the plugin or folder it belongs to when the card is not already inside that plugin's page,
   * then where it leaves the plugin (a dot and a word), what is wrong, and the one button that goes
   * to what to fix (`plugin-problems.ts`). A button that
   * changes something is held back by the page while the host is `locked`; the page carries out the
   * buttons that act on it (`onSecret`, `onFixSetting`, `onShowBoth`), and the card carries out the
   * ones that go elsewhere.
   */
  import { Button, Card, copyToClipboard, StatusDot } from '@lostgradient/cinder';

  import { PLUGINS_COPY } from '../../../app/copy/plugins.ts';
  import { showToast } from '../../../app/toast-host.svelte';
  import type { PluginProblem, PluginStanding } from '../../../lib/host-plugins.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import { problemView } from './plugin-problems.ts';

  interface Props {
    problem: PluginProblem;
    /** The plugin the problem belongs to, which lets its words name what the plugin adds. */
    plugin?: PluginStanding | undefined;
    /** The plugin or folder the problem belongs to, shown on the card when it is not on that plugin's page. */
    owner?: string | undefined;
    /** Whether the host keeps its plugin choices and secrets in its deployment, so a secret cannot be saved here. */
    locked?: boolean;
    /** Asked when a person chooses to add the missing secret `key`. */
    onSecret?: (key: string) => void;
    /** Asked when a person chooses to fix the plugin's configuration. */
    onFixSetting?: () => void;
    /** Asked when a person chooses to see the other plugin that holds the name. */
    onShowBoth?: (() => void) | undefined;
  }

  let {
    problem,
    plugin,
    owner,
    locked = false,
    onSecret,
    onFixSetting,
    onShowBoth,
  }: Props = $props();

  const view = $derived(problemView(problem, plugin));
  // A thing with no title is named by its identifier, which is set in monospace where the body says it.
  const identifierParts = $derived.by(() => {
    const identifier = view.identifier;
    if (identifier === undefined) return undefined;
    const at = view.body.indexOf(identifier);
    return at < 0
      ? undefined
      : {
          before: view.body.slice(0, at),
          identifier,
          after: view.body.slice(at + identifier.length),
        };
  });
  const action = $derived(view.action);
  const available = $derived(
    action === undefined
      ? false
      : action.kind === 'secret'
        ? onSecret !== undefined
        : action.kind === 'setting'
          ? onFixSetting !== undefined
          : action.kind === 'both'
            ? onShowBoth !== undefined
            : true,
  );

  function follow(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }

  async function copy(value: string): Promise<void> {
    if (await copyToClipboard(value)) {
      showToast(PLUGINS_COPY.problems.developmentSource.copied, { variant: 'success' });
    } else {
      showToast(PLUGINS_COPY.problems.developmentSource.copyFailed, { variant: 'danger' });
    }
  }
</script>

{#snippet statusRow()}
  <div class="ib-problem__status">
    {#if owner !== undefined && owner !== ''}
      <span class="ib-problem__owner">{owner}</span>
    {/if}
    <StatusDot status={view.status.dot} label={view.status.label} labelVisible size="sm" />
  </div>
{/snippet}

{#snippet button()}
  {#if action?.kind === 'secret'}
    {@const key = action.key}
    <Button variant="secondary" size="sm" disabled={locked} onclick={() => onSecret?.(key)}
      >{action.label}</Button
    >
  {:else if action?.kind === 'setting'}
    <Button variant="secondary" size="sm" onclick={() => onFixSetting?.()}>{action.label}</Button>
  {:else if action?.kind === 'both'}
    <Button variant="secondary" size="sm" onclick={() => onShowBoth?.()}>{action.label}</Button>
  {:else if action?.kind === 'link'}
    {@const href = action.href}
    <Button
      variant="secondary"
      size="sm"
      href={router.href(href)}
      onclick={(event) => follow(event, href)}>{action.label}</Button
    >
  {:else if action?.kind === 'copy'}
    {@const value = action.text}
    <Button variant="secondary" size="sm" onclick={() => void copy(value)}>{action.label}</Button>
  {/if}
{/snippet}

{#snippet body()}
  <div class="ib-problem__content">
    {@render statusRow()}
    <div class="ib-problem__main">
      <div class="ib-problem__text">
        <p class="ib-problem__title">{view.title}</p>
        <p class="ib-problem__body">
          {#if identifierParts !== undefined}{identifierParts.before}<code
              class="ib-problem__identifier">{identifierParts.identifier}</code
            >{identifierParts.after}{:else}{view.body}{/if}
        </p>
      </div>
      {#if available}
        <div class="ib-problem__action">{@render button()}</div>
      {/if}
    </div>
  </div>
{/snippet}

<div class="ib-problem" data-plugin-problem={problem.code}>
  <Card variant="card" children={body} />
</div>

<style>
  .ib-problem {
    container-type: inline-size;
    min-width: 0;
  }

  /* The text keeps a readable line length, with its one action at the inline end; in a narrow card
     the action drops under the text. */
  .ib-problem__main {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  @container (inline-size >= 36rem) {
    .ib-problem__main {
      flex-direction: row;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--cinder-space-4);
    }

    .ib-problem__text {
      max-inline-size: 70ch;
    }

    .ib-problem__action {
      flex: none;
    }
  }

  .ib-problem__status {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--cinder-space-2);
  }

  .ib-problem__owner {
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .ib-problem__content {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .ib-problem__action {
    display: flex;
  }

  .ib-problem__text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
  }

  .ib-problem__title {
    margin: 0;
    font-weight: 600;
  }

  .ib-problem__identifier {
    font-family: var(--cinder-font-mono);
    font-size: 0.95em;
  }

  .ib-problem__body {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
