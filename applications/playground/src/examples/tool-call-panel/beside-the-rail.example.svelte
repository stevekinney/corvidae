<script lang="ts" module>
  export const title = 'Beside the rail';
  export const description =
    'The rail and its panel together: the selected Send email row is tinted and its panel docks to the right. Esc or the X closes the panel and Close hands focus back to the row; choosing the row again closes it too.';
</script>

<script lang="ts">
  import { ToolCallPanel, ToolCallRail } from '@lostgradient/cinder';
  import type { ToolCallRailCall } from '@lostgradient/cinder';

  const calls: ToolCallRailCall[] = [
    {
      id: 'search',
      name: 'Search orders',
      identifier: 'search-orders',
      input: 'carrier Parcelly, damaged',
      result: '14 orders',
      duration: '0.6s',
      status: 'done',
    },
    {
      id: 'lookup',
      name: 'Lookup order',
      identifier: 'lookup-order',
      input: '4471',
      result: '$42.00, delivered Mon',
      duration: '0.2s',
      status: 'done',
    },
    {
      id: 'send-email',
      name: 'Send email',
      identifier: 'send-email',
      input: 'maya@example.com',
      result: 'SMTP timeout after 10s',
      duration: '10.0s',
      status: 'failed',
      failure: "Mail server didn't reply within 10s. The refund notice for 4471 wasn't sent.",
    },
  ];

  let open = $state(true);
  let rail: ReturnType<typeof ToolCallRail> | undefined = $state();
  const selectedId = $derived(open ? 'send-email' : undefined);
</script>

<div style="display: flex; gap: 1rem; align-items: flex-start;">
  <div style="flex: 1; min-inline-size: 0;">
    <ToolCallRail
      bind:this={rail}
      {calls}
      {selectedId}
      onSelect={(id) => (open = id === 'send-email' ? !open : open)}
    />
  </div>
  <ToolCallPanel
    bind:open
    onClose={() => rail?.focusCall('send-email')}
    placement="docked"
    name="Send email"
    identifier="send-email"
    status="failed"
    duration="10.0s"
    position="call 3 of 3"
    input={{ to: 'maya@example.com', template: 'refund-notice', orderId: '4471' }}
    error={{
      message: 'No reply from mail.example.com after 10s',
      code: 'smtp-timeout',
      retryable: true,
    }}
    retryMessage="Please retry Send email to maya@example.com"
    onRetry={() => undefined}
  />
</div>
