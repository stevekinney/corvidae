<script lang="ts" module>
  export const title = 'Blocked composer, no agent can do it';
  export const description =
    'When no agent has the tool a chat needs, the reason appears once, as the composer’s blocked row, with a link to Agents; the agent select above it still reads Choose an agent. What was typed is kept and shows once an agent that can do it exists.';
</script>

<script lang="ts">
  import { Chat, createConversation } from '@lostgradient/chat';
  import { Select } from '@lostgradient/cinder';

  const AGENTS = [
    {
      value: 'assistant',
      label: 'Assistant',
      description: 'Answers every message with the same scripted reply.',
    },
  ];
  let agent = $state<string | undefined>();
  const conversation = createConversation({ id: 'composer-blocked-no-agent' });
</script>

<div class="column">
  <Select
    id="composer-blocked-no-agent-agent"
    variant="ghost"
    presentation="listbox"
    size="sm"
    label="Agent"
    labelVisible={false}
    placeholder="Choose an agent"
    options={AGENTS}
    {...agent === undefined ? {} : { value: agent }}
    onValueChange={(next) => (agent = next)}
  />
  <div class="column__chat">
    <Chat
      id="composer-blocked-no-agent"
      {conversation}
      surfaceMode="transparent"
      composerStatus={{
        kind: 'blocked',
        reason:
          'No agent can create workflows. Add the Create workflow tool to an agent’s Access tab.',
        action: { label: 'Open Agents', href: '#agents' },
      }}
    />
  </div>
</div>

<style>
  .column {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    block-size: 18rem;
  }

  .column__chat {
    flex: 1;
    min-block-size: 0;
  }
</style>
