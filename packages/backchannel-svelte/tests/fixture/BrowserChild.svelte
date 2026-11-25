<script lang="ts">
  import { activateResource, loadMoreWhenVisible } from '@lostgradient/backchannel-svelte';
  import {
    getProbeHost,
    useProbeJobsCancel,
    useProbeJobsList,
    useProbeJobsWatch,
  } from './generated/operation-client.svelte.ts';
  import { onDestroy } from 'svelte';
  let { filter }: { filter: string } = $props();
  const host = getProbeHost();
  const read = useProbeJobsList(host, () => ({ filter }));
  const command = useProbeJobsCancel(host);
  const fault = command.fault;
  let secret = $state('');
  let events = $state<string[]>([]);
  const watch = useProbeJobsWatch(host, {}, (event) => {
    events = [...events, event.kind];
  });
  onDestroy(() => watch.dispose());
  async function submit() {
    const result = await command.mutateAsync({ id: 'one' });
    secret = result.secret;
  }
  async function submitDelayed() {
    try {
      const result = await command.mutateAsync({ id: 'delayed' });
      secret = result.secret;
    } catch {
      /* interrupted on scope disposal */
    }
  }
  async function submitAmbiguous() {
    try {
      await command.mutateAsync({ id: 'ambiguous' });
    } catch {
      /* outcome is reported by the binding */
    }
  }
</script>

<div {@attach activateResource(read)}>
  <output data-testid="read">{read.data?.jobs.map((item) => item.id).join(',') ?? 'loading'}</output
  >
  <output data-testid="initial-error">{read.initialError?.message ?? ''}</output>
  <output data-testid="refresh-error">{read.refreshError?.message ?? ''}</output>
  <button onclick={() => void read.refresh().catch(() => {})}>Refresh</button>
  <button onclick={submit}>Submit</button>
  <button onclick={submitDelayed}>Submit delayed</button>
  <button onclick={submitAmbiguous}>Submit ambiguous</button>
  <button onclick={() => void command.reconcile('probe.jobs.list', { filter })}>Reconcile</button>
  <output data-testid="command-fault">{$fault ?? ''}</output>
  <button onclick={() => void watch.connect()}>Connect events</button>
  <output data-testid="events">{events.join(',')}</output>
  <output data-testid="secret">{secret}</output>
  <div data-testid="sentinel" {@attach loadMoreWhenVisible(read)}></div>
</div>
