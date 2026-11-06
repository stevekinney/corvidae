<script lang="ts" module>
  export const title = 'Blocked message bar on a waiting run';
  export const description =
    'A run waiting on a person, with no provider connected: the shared blocked row (a warning glyph, “Connect a model provider to send messages”, and a Connect a provider link) sits under the question card, followed by a Cancel run button beside it. There is no message text box.';
</script>

<script lang="ts">
  import { ChatInput } from '@lostgradient/chat';
  import { Button } from '@lostgradient/cinder';
</script>

<div class="bar">
  <div class="bar__row">
    <ChatInput
      id="composer-blocked-run"
      status={{
        kind: 'blocked',
        reason: 'Connect a model provider to send messages',
        link: { label: 'Connect a provider', href: '#connect' },
      }}
    />
  </div>
  <Button type="button" variant="secondary" label="Cancel run" />
</div>

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    max-inline-size: 48rem;
  }

  .bar__row {
    flex: 1;
    min-inline-size: 0;
  }
</style>
