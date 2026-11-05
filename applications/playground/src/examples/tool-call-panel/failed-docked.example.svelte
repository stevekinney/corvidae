<script lang="ts" module>
  export const title = 'A failed call, docked';
  export const description =
    'Selecting a rail row docks its panel beside the conversation, about 340px wide, with an X to close it. The header reads "Send email" with "send-email" small and monospaced, then a red dot and "Failed 10.0s · call 28 of 30". The Input section lists its fields (To, Template, Order ID) and the Error section is a tinted danger block with the message first, then the code in monospace and Retryable Yes. Under it the panel says what retrying sends, then a full-width secondary "Ask the agent to retry" with a refresh icon and secondary "Copy input" and "Copy error" buttons. Approve elsewhere on the page stays the only primary action.';
</script>

<script lang="ts">
  import { ToolCallPanel } from '@lostgradient/cinder';

  let open = $state(true);
</script>

<div style="display: flex; justify-content: flex-end; min-block-size: 30rem;">
  <ToolCallPanel
    bind:open
    placement="docked"
    name="Send email"
    identifier="send-email"
    status="failed"
    duration="10.0s"
    position="call 28 of 30"
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
