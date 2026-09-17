<script lang="ts">
  import { JsonViewer } from '@repo/cinder';

  const payload = {
    id: 'wf_3c4fce',
    status: 'completed',
    exitCode: 0,
    durationMs: 1423,
    startedAt: '2025-05-12T15:30:00Z',
    finishedAt: '2025-05-12T15:30:01.423Z',
    retryCount: 0,
    triggeredBy: 'schedule',
  };
</script>

<JsonViewer value={payload} />
