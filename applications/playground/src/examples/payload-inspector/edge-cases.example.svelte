<script lang="ts" module>
  export const title = 'Edge cases';
  export const description =
    'Demonstrates the empty, null, invalid JSON, truncated, scalar, streaming, secret, oversize and failed states of the inspector.';
</script>

<script lang="ts">
  import { Button, PayloadInspector } from '@lostgradient/cinder';

  type Scenario =
    | 'empty'
    | 'null'
    | 'invalid-json'
    | 'truncated'
    | 'primitive'
    | 'streaming'
    | 'secrets'
    | 'oversize'
    | 'failed';

  let scenario = $state<Scenario>('empty');

  type ScenarioProps = {
    value?: unknown;
    truncated?: boolean;
    streaming?: boolean;
    failed?: boolean;
    maxBytes?: number;
    redact?: string[];
    emptyLabel?: string;
    label: string;
  };

  const scenarios: Record<Scenario, ScenarioProps> = {
    empty: { value: undefined, emptyLabel: 'This tool call takes no input.', label: 'No payload' },
    null: { value: null, label: 'Null value' },
    'invalid-json': { value: '{ not valid json at all', label: 'Invalid JSON string' },
    truncated: { value: { partial: 'data', more: '...' }, truncated: true, label: 'Truncated' },
    primitive: { value: 42, label: 'Number primitive' },
    streaming: {
      value: '{"orderId": 4471, "amount": "$42.00", "reason": "Arriv',
      streaming: true,
      label: 'Streaming',
    },
    secrets: {
      value: { orderId: 4471, authorization: 'Bearer abc123', apiKey: 'sk_live_9f2' },
      redact: ['authorization', 'apiKey'],
      label: 'Secrets masked',
    },
    oversize: { value: { blob: 'x'.repeat(4096) }, maxBytes: 1024, label: 'Over the size limit' },
    failed: { failed: true, label: 'Failed to load' },
  };

  const current = $derived(scenarios[scenario]);
</script>

<div style="display: flex; flex-direction: column; gap: 1rem;">
  <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
    {#each Object.keys(scenarios) as key (key)}
      <Button
        variant={scenario === key ? 'primary' : 'secondary'}
        size="sm"
        onclick={() => (scenario = key as Scenario)}
      >
        {scenarios[key as Scenario].label}
      </Button>
    {/each}
  </div>

  <PayloadInspector
    value={current.value}
    truncated={current.truncated ?? false}
    streaming={current.streaming ?? false}
    failed={current.failed ?? false}
    onRetry={() => (scenario = 'empty')}
    {...current.maxBytes === undefined ? {} : { maxBytes: current.maxBytes }}
    {...current.redact === undefined ? {} : { redact: current.redact }}
    {...current.emptyLabel === undefined ? {} : { emptyLabel: current.emptyLabel }}
  />
</div>
