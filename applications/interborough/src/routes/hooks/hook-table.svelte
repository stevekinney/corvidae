<script lang="ts">
  /**
   * The table of hooks the Hooks page and an agent's Hooks tab share: one row for each hook, read as
   * a sentence, with what it is limited to, its last delivery and an On switch. A hook whose last
   * delivery failed comes first, so what needs looking at is at the top.
   *
   * The switch names the revision of the hook the list read. A hook that changed since is refused
   * and the list is read again, and nothing was changed.
   */
  import { Alert, Button, RelativeTime, Table } from '@lostgradient/cinder';
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';

  import { STALE_COPY } from '../../app/copy.ts';
  import { showFault } from '../../app/toast-host.svelte';
  import { agentFaultOf } from '../../lib/agent-definitions.ts';
  import { updateHook, type ListedHook } from '../../lib/bureau-hooks.ts';
  import { faultTreatment } from '../../lib/faults.ts';
  import { hookPath } from '../../lib/identifier-paths.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { router } from '../../lib/router.svelte.ts';
  import StatusLabel from '../../lib/status-label.svelte';
  import { HOOKS_COPY } from './hook-copy.ts';
  import {
    deliveryFailed,
    deliveryLine,
    deliveryWord,
    failingFirst,
    hookSentence,
    onlyForWords,
    scopePath,
  } from './hook-presentation.ts';

  interface Props {
    /** The hooks to show, each with its newest delivery. */
    hooks: readonly ListedHook[];
  }

  let { hooks }: Props = $props();

  const queryClient = useQueryClient();

  const ordered = $derived(failingFirst(hooks, (hook) => deliveryFailed(hook.lastDelivery)));

  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }

  /** A hook the Bureau refused to change for being stale: nothing was changed, and the list was read again. */
  let staleHook = $state<string | null>(null);

  const switching = createMutation(() => ({
    mutationFn: (input: { hook: ListedHook; enabled: boolean }) =>
      updateHook(input.hook.id, input.hook.revision, { enabled: input.enabled }),
    onMutate: () => {
      staleHook = null;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['hooks'] }),
    onError: (error: unknown, input) => {
      void queryClient.invalidateQueries({ queryKey: ['hooks'] });
      if (agentFaultOf(error).kind === 'stale') {
        staleHook = input.hook.id;
        return;
      }
      const treatment = faultTreatment(error);
      showFault({ ...treatment, message: `${HOOKS_COPY.toggleFailed}. ${treatment.message}` });
    },
  }));
</script>

{#if staleHook !== null}
  <Alert variant="warning" dismissible onDismiss={() => (staleHook = null)}>
    <p class="ib-hooks__alert-title">{STALE_COPY.title(staleHook)}</p>
    <p class="ib-hooks__alert-body">{STALE_COPY.description}</p>
  </Alert>
{/if}

<Table caption={HOOKS_COPY.caption} density="condensed">
  <Table.Header>
    <Table.Row>
      <Table.HeaderCell>{HOOKS_COPY.hookColumn}</Table.HeaderCell>
      <Table.HeaderCell>{HOOKS_COPY.onlyForColumn}</Table.HeaderCell>
      <Table.HeaderCell>{HOOKS_COPY.lastDeliveryColumn}</Table.HeaderCell>
      <Table.HeaderCell>{HOOKS_COPY.onColumn}</Table.HeaderCell>
    </Table.Row>
  </Table.Header>
  <Table.Body>
    {#each keyedByOccurrence(ordered, (hook) => hook.id) as { key, item: hook } (key)}
      {@const last = hook.lastDelivery}
      {@const sentence = hookSentence(hook)}
      {@const subjectPath = hook.scope === null ? undefined : scopePath(hook.scope)}
      <Table.Row data-hook={hook.id} data-enabled={hook.enabled ? 'true' : 'false'}>
        <Table.Cell class="ib-records__wrap">
          <a
            class="ib-hooks__sentence"
            href={router.href(hookPath(hook.id))}
            onclick={(event) => go(event, hookPath(hook.id))}>{sentence}</a
          >
          {#if hook.name !== null}
            <span class="ib-records__muted ib-hooks__name">{hook.name}</span>
          {/if}
        </Table.Cell>
        <Table.Cell class="ib-records__wrap" data-only-for>
          {#if subjectPath !== undefined}
            <a
              class="ib-hooks__sentence"
              href={router.href(subjectPath)}
              onclick={(event) => go(event, subjectPath)}>{onlyForWords(hook.scope)}</a
            >
          {:else}
            <span class="ib-records__muted">{onlyForWords(hook.scope)}</span>
          {/if}
        </Table.Cell>
        <Table.Cell class="ib-records__wrap" data-last-delivery>
          {#if last === null}
            <span class="ib-records__muted">{HOOKS_COPY.noDelivery}</span>
          {:else}
            <StatusLabel word={deliveryWord(last.status)} />
            <span class="ib-records__muted ib-hooks__line">{deliveryLine(last)}</span>
            <RelativeTime date={last.updatedAt} class="ib-records__muted" />
          {/if}
        </Table.Cell>
        <Table.Cell>
          <Button
            data-changes
            role="switch"
            aria-checked={hook.enabled}
            aria-label={HOOKS_COPY.toggleLabel(sentence)}
            variant={hook.enabled ? 'secondary' : 'ghost'}
            size="sm"
            disabled={switching.isPending}
            onclick={() => switching.mutate({ hook, enabled: !hook.enabled })}
            >{hook.enabled ? HOOKS_COPY.onState : HOOKS_COPY.offState}</Button
          >
        </Table.Cell>
      </Table.Row>
    {/each}
  </Table.Body>
</Table>

<style>
  .ib-hooks__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .ib-hooks__alert-body {
    margin: 4px 0 8px;
  }

  .ib-hooks__sentence {
    overflow-wrap: anywhere;
  }

  .ib-hooks__name,
  .ib-hooks__line {
    display: block;
    overflow-wrap: anywhere;
  }
</style>
