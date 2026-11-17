<script lang="ts">
  /**
   * Test fixture: renders one of a message's content parts under the words a message hands down,
   * as ChatMessage does, so a test can pass `labels` without building a whole message.
   */
  import type { Component } from 'svelte';

  import { setChatLabelsContext } from './chat-labels-context.ts';
  import { resolveChatLabels, type ChatLabels } from './chat-labels.ts';

  let {
    labels,
    component: Child,
    childProps,
  }: {
    labels: Partial<ChatLabels>;
    // oxlint-disable-next-line typescript/no-explicit-any -- the fixture forwards any part's props.
    component: Component<any>;
    childProps: Record<string, unknown>;
  } = $props();

  setChatLabelsContext(() => resolveChatLabels(labels));
</script>

<Child {...childProps} />
