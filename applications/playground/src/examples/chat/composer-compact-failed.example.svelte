<script lang="ts" module>
  export const title = 'Compact composer: a failed answer';
  export const description =
    'Try it when the provider answers with an error: under the person’s message a titled danger block says “Couldn’t get an answer”, what failed and that nothing was saved, with Try again.';
</script>

<script lang="ts">
  import { Alert, Button, RotateCcw } from '@lostgradient/cinder';
  import {
    appendUserMessage,
    Chat,
    createConversation,
    type ChatAdapter,
  } from '@lostgradient/chat';

  const adapter: ChatAdapter = { sendMessage: async () => undefined };
  const conversation = appendUserMessage(
    createConversation({ id: 'composer-compact-failed' }),
    'My order 4471 arrived broken.',
  );
</script>

<div style="block-size: 22rem; max-inline-size: 26rem;">
  <Chat
    id="composer-compact-failed"
    {conversation}
    {adapter}
    surfaceMode="transparent"
    variant="transcript"
    composerCompact
    composerPlaceholder="Send a test message"
    composerHint="Tools run for real, under this agent’s approval rules. Test chats aren’t saved and leave no memories."
    capabilities={{ attachments: false, editing: false, quote: false }}
  >
    {#snippet trailing()}
      <Alert variant="danger" heading="Couldn’t get an answer">
        The provider answered with an error (429, too many requests). Nothing was saved.
        {#snippet actions()}
          <Button type="button" size="sm" variant="secondary" label="Try again">
            {#snippet leadingIcon()}<RotateCcw
                class="cinder-icon-sm"
                aria-hidden="true"
              />{/snippet}
          </Button>
        {/snippet}
      </Alert>
    {/snippet}
  </Chat>
</div>
