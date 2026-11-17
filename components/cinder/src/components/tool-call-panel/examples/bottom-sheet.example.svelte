<script lang="ts" module>
  export const title = 'At 375px, a bottom sheet';
  export const description =
    'On a phone the panel is a full-height bottom sheet with a grabber and a Close button, like the shared sheets. The title is "Send email" with "send-email", a red "Failed, 10.0s, call 28 of 30", Input fields (To, Template), Error fields (Message, Retryable Yes) and a secondary full-width 44px "Ask the agent to retry" at the foot. It cross-fades under reduced motion.';
</script>

<script lang="ts">
  import { Button, ToolCallPanel } from '@lostgradient/cinder';

  let open = $state(false);
</script>

<Button variant="secondary" onclick={() => (open = true)}>Open the sheet</Button>
<ToolCallPanel
  bind:open
  placement="sheet"
  name="Send email"
  identifier="send-email"
  status="failed"
  duration="10.0s"
  position="call 28 of 30"
  input={{ to: 'maya@example.com', template: 'refund-notice' }}
  error={{ message: 'No reply from mail.example.com after 10s', retryable: true }}
  onRetry={() => (open = false)}
/>
