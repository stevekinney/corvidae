<script lang="ts" module>
  export const title = 'Off together, with the reason';
  export const description =
    'While the stream is reconnecting the bar is off. Buttons that opt in with mutating stay focusable and are described by the reason, which is drawn under the row and announced politely. The field is read-only.';
</script>

<script lang="ts">
  import { Button, DockedActionBar, Input } from '@lostgradient/cinder';

  let off = $state(true);
  let message = $state('');
</script>

<DockedActionBar
  label="Run actions"
  {off}
  reason="Reconnecting… Send a message and Cancel run are off until the connection is back."
>
  <Input
    id="run-context-off"
    bind:value={message}
    label="Add context"
    labelVisible={false}
    placeholder="Add context the agent will see on its next step"
    readonly={off}
  />
  {#snippet actions()}
    <Button mutating variant="secondary">Send a message</Button>
    <Button mutating variant="secondary">Cancel run</Button>
    <Button variant="ghost" onclick={() => (off = !off)}
      >{off ? 'Reconnect' : 'Drop the stream'}</Button
    >
  {/snippet}
</DockedActionBar>
