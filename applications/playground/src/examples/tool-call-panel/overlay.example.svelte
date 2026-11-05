<script lang="ts" module>
  export const title = 'Below 1280px, an overlay';
  export const description =
    'Under 1280px the panel opens over the conversation on a dimming scrim, closed by its X or Esc, with the same Send email content as the docked panel. It docks only at 1280px and wider (190 sidebar + 250 list + about 480 conversation + 340 panel = 1,260 plus gutters), a threshold separate from the shared 1024px desktop breakpoint. This example forces the overlay so it shows at any width.';
</script>

<script lang="ts">
  import { Button, ToolCallPanel } from '@lostgradient/cinder';

  let open = $state(false);
  let trigger = $state<HTMLElement | null>(null);
</script>

<div bind:this={trigger} style="display: inline-block;">
  <Button variant="secondary" onclick={() => (open = true)}>Open the Send email panel</Button>
</div>
<ToolCallPanel
  bind:open
  placement="overlay"
  triggerRef={trigger}
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
  onRetry={() => (open = false)}
/>
