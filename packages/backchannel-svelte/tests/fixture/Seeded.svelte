<script lang="ts">
  import { getProbeHost, useProbeJobsList } from './generated/operation-client.svelte.ts';
  import { activateResource } from '@lostgradient/backchannel-svelte';
  import { validateSeed } from './validate-seed.ts';
  const host = getProbeHost();
  host.seed(
    'probe.jobs.list',
    { filter: 'active' },
    { jobs: [{ id: 'one', tenant: 'a' }], next: null, total: 1 },
    validateSeed,
  );
  const read = useProbeJobsList(host, () => ({ filter: 'active' }));
</script>

<span {@attach activateResource(read)}>{read.data?.jobs[0]?.id}</span>
