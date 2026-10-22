# Chat

Opinionated conversation surface bundling message list, composer, attachments, and scroll affordances for AI or support transcripts.

## Usage

```svelte
<script lang="ts">
  import {
    Chat,
    appendAssistantMessage,
    appendUserMessage,
    createConversation,
  } from '@lostgradient/chat';

  const conversation = appendAssistantMessage(
    appendUserMessage(createConversation({ id: 'demo' }), 'Can you summarize this plan?'),
    'The plan is ready to implement.',
  );
</script>

<!-- Chat fills its parent; give the ancestor a definite height. -->
<div style="height: 34rem;">
  <Chat id="demo-chat" {conversation} />
</div>
```

> [!IMPORTANT] Chat needs a definite-height ancestor Chat's root element fills its parent (`height: 100%`). Place it inside an ancestor with a resolved height—a fixed height, a flex or grid cell, or `height: 100dvh`—or the message viewport collapses and Chat renders as a small card instead of filling its space. See [Layout and sizing](#layout-and-sizing).

## Adapter-driven streaming

`ChatAdapter.sendMessage` deliberately stays a `Promise<void>` command. The adapter owns the conversation snapshot, while `Chat` owns the transient visual stream buffer. Pair the public streaming builders with the imperative instance methods so both surfaces advance together:

```svelte
<script lang="ts">
  import {
    Chat,
    appendStreamingMessage,
    appendUserMessage,
    cancelStreamingMessage,
    createConversation,
    finalizeStreamingMessage,
    updateStreamingMessage,
    type ChatAdapter,
    type ConversationHistory,
  } from '@lostgradient/chat';

  let chat: ReturnType<typeof Chat> | undefined;
  let conversation = $state<ConversationHistory>(createConversation({ id: 'streaming' }));
  let streaming = $state(false);

  const adapter: ChatAdapter = {
    async sendMessage(message, _attachments) {
      conversation = appendUserMessage(conversation, message.content);
      const { conversation: started, messageId } = appendStreamingMessage(
        conversation,
        'assistant',
      );
      conversation = started;
      streaming = true;
      chat?.beginStreaming(messageId);

      let content = '';
      try {
        for await (const chunk of streamFromYourBackend(message)) {
          content += chunk;
          conversation = updateStreamingMessage(conversation, messageId, content);
          chat?.pushToken(chunk);
        }
        conversation = finalizeStreamingMessage(conversation, messageId);
      } catch (error) {
        conversation = cancelStreamingMessage(conversation, messageId);
        throw error;
      } finally {
        chat?.endStreaming();
        streaming = false;
      }
    },
  };
</script>

<Chat
  bind:this={chat}
  id="adapter-streaming-chat"
  {conversation}
  {adapter}
  {streaming}
  capabilities={{ attachments: false }}
/>
```

The assistant placeholder must exist before `beginStreaming`; update the same snapshot for each token, finalize it before `endStreaming`, and cancel it when the backend fails. The package's Adapter-driven streaming example uses a complete finite stream without assuming a particular model provider.

### Failed delivery and retry

`ChatAdapter.sendMessage` receives a `MessageInput`, not a persisted `Message`, so it has no message ID. Append the optimistic user message to the authoritative snapshot first and retain the generated ID. Chat awaits adapter commands and reports rejected commands through `onAdapterError`; adapter implementations should mark delivery status and then rethrow so Chat can handle the error consistently:

```ts
import {
  appendUserMessage,
  clearMessageDeliveryStatus,
  markMessageDeliveryFailed,
  type ChatAdapter,
  type ChatAttachment,
  type ConversationHistory,
  type MessageInput,
} from '@lostgradient/chat';

declare let conversation: ConversationHistory;
declare const yourBackend: {
  send(message: MessageInput, attachments: ChatAttachment[]): Promise<void>;
};

const adapter: ChatAdapter = {
  async sendMessage(message, attachments) {
    conversation = appendUserMessage(conversation, message.content);
    const messageId = conversation.ids.at(-1)!;
    try {
      await yourBackend.send(message, attachments);
      conversation = clearMessageDeliveryStatus(conversation, messageId);
    } catch (error) {
      conversation = markMessageDeliveryFailed(conversation, messageId);
      throw error; // rethrow so Chat routes it to onAdapterError
    }
  },
};
```

The helpers immutably set or clear the transient `_deliveryStatus` metadata used by Chat's failed-message label and Retry button. Apply the same pair around `retryMessage` and `editMessage` resends; the successful attempt clears the marker.

### Follow-ups during a run

By default the composer is disabled while `streaming` is `true`, and the session controller refuses a second turn while a run is working or a tool approval is pending. A host that owns the run on the server, and can deliver input to it in flight, opts in with `sendRunInput`. Follow-ups are supported only for server-owned runs (`executionOwner: 'server'`): with a browser-owned run the controller does not expose the hook, the composer does not offer follow-ups, and submitting during the run behaves as it did before. There are two hooks, and they are different types:

- `ChatAdapter.sendRunInput(conversationId, message, attachments)` is the component-facing hook. It takes the same message and attachments as `sendMessage`, preceded by the conversation id. A raw adapter used without the controller gets no row id, and correlating its follow-ups is the host's problem.
- `ChatSessionControllerOptions.sendRunInput(conversationId, message, attachments, { messageId })` is the host-facing hook. The controller appends a transcript row for the follow-up and fills `messageId` with that row's id, so a host can pass it on as the session input's own id (`submitSessionInput` accepts a caller-supplied `id`). A retry of the same row passes the same id. Providing it makes `controller.adapter` expose the adapter hook.

```ts
import {
  assertRunInputAccepted,
  createChatSessionController,
  type ChatAttachment,
  type ChatSessionRunInputReceipt,
  type ChatSessionTransport,
  type ConversationHistory,
  type MessageInput,
} from '@lostgradient/chat';

declare let conversation: ConversationHistory;
declare const transport: ChatSessionTransport;
declare const yourBackend: {
  submitSessionInput(input: {
    id: string;
    conversationId: string;
    message: MessageInput;
    attachments: ChatAttachment[];
  }): Promise<{ outcome: string; receipt?: ChatSessionRunInputReceipt }>;
};

const session = createChatSessionController({
  getConversation: () => conversation,
  setConversation: (next) => (conversation = next),
  transport,
  executionOwner: 'server',
  async sendRunInput(conversationId, message, attachments, { messageId }) {
    const result = await yourBackend.submitSessionInput({
      id: messageId,
      conversationId,
      message,
      attachments,
    });
    if (!result.receipt) throw new Error(`Input was not admitted: ${result.outcome}`);
    assertRunInputAccepted(result.receipt);
  },
});
```

The promise resolving is the acknowledgement, and it resolves only when the input's receipt is `accepted`, `queued`, or `promoted`. Every other receipt rejects with an error that names its state, so the row is marked failed with a Retry button. `assertRunInputAccepted(receipt)` does this for you. Read the receipt, not just the submission outcome: a `canceled` receipt from an immediate self-cancel (no run is live) and a `replayed` outcome whose receipt is already `canceled` both reject. Admission is not delivery, because the server cancels input a run ends without delivering it, and never answers it in a continuation run.

With the hook present:

- The textarea stays enabled during a run, Send and Stop sit side by side, and Enter submits a follow-up.
- The follow-up appears in the transcript at once as a row stamped `metadata._followUp`, with a pending "Sending…" state that the acknowledgement clears.
- Follow-ups are handed over one at a time, in the order they were sent, so a slow acknowledgement cannot be overtaken. `Chat` also serializes calls to a raw adapter the same way.
- A follow-up is accepted while an approval is pending and does not resolve it.
- A follow-up row never owns the run. Retrying after a failed run, finding the owner of a tool call that arrives after a follow-up, an approval continuation's turn and attachments, and the AG-UI transport's choice of turn all stay with the turn that opened the run. Rows without the marker are not follow-ups, including rows installed with `adoptHistory`.
- When the run's terminal history names the follow-up's row, the transcript keeps one row, moved to the position the terminal gives it, and the client's row wins, so its marker and delivery status survive.
- A rejection marks that row failed with the usual Retry and leaves the run alone. Retrying resends it through the hook with the same `messageId` while a run is in progress, and otherwise promotes it to an ordinary turn.
- A follow-up still waiting for the hook when the run ends (queued behind a slow acknowledgement) goes out as an ordinary turn on its existing row when the run completes or fails, one after another in the order sent. If the user stopped the run, it is marked failed with a Retry instead. A run parked on a pending approval has not ended.
- Once a run ends, each follow-up the host accepted is classified. The run delivered it when its terminal history (the history a `run.completed` frame carries) names the row's id. Otherwise the server cancelled it, and that includes a run that ended with no terminal history at all, such as a stop mid-stream or a failure. If this client pressed stop, the row is marked failed with a Retry. If the run completed or failed, the row is promoted to an ordinary turn after the run ends, reusing its row and attachments. The decision waits for both the acknowledgement and the run's end, in either order, so an acknowledgement that arrives late is still classified. A follow-up the hook rejects is failed as above.
- `controller.invalidate()` retires every acknowledgement still owed: a late acknowledgement or rejection writes nothing, and the sender's promise rejects with an invalidation error. A follow-up still queued when it happens is marked failed and reported through `onError`. A stop does not retire anything.
- The controller's adapter orders its own input (`ChatAdapter.ordersRunInput`), so `Chat` hands it each follow-up at once and the row shows immediately; for a raw adapter, `Chat` queues the calls itself, one at a time, and drops that queue when the conversation changes.
- A follow-up queued when the conversation changes is rejected through `onAdapterError` rather than dropped silently.

A controller without `sendRunInput`, or with a browser-owned run, behaves exactly as before. The "Follow-ups during a run" example shows the flow.

### Edit and resend

`ChatAdapter.editMessage` hands you the edited message's ID and new content; the superseded branch (the old reply, any tool calls after it) should be discarded before the edited content is re-sent. `rewindBeforeMessage` performs exactly that cut — it drops the named message and everything after it in the transcript, keeps tool-call/tool-result pairs atomic, and renumbers positions — so an edit flow never assembles `ids`/`messages`/`updatedAt` by hand:

```ts
import {
  appendUserMessage,
  rewindBeforeMessage,
  type ChatAdapter,
  type ConversationHistory,
  type MessageInput,
} from '@lostgradient/chat';

declare let conversation: ConversationHistory;
declare const yourBackend: { send(message: MessageInput): Promise<void> };

const adapter: Pick<ChatAdapter, 'editMessage'> = {
  async editMessage({ messageId, content }) {
    conversation = appendUserMessage(rewindBeforeMessage(conversation, messageId), content);
    await yourBackend.send({ role: 'user', content });
  },
};
```

`rewindBeforePosition` is the position-keyed form, and both accept a `RewindOptions` bag (`preserveToolPairs: false` cuts strictly at the boundary, leaving a straddled tool call pending).

### Transcript mutation and query helpers

`@lostgradient/chat` re-exports Conversationalist's canonical transcript mutation and query helpers so consumers never hand-walk `conversation.ids` / `conversation.messages` or import `conversationalist` directly:

```ts
import {
  findToolResultMessage,
  getMessages,
  getUnresolvedToolApprovals,
  removeMessage,
  replaceToolResult,
  setMessageHidden,
  updateMessage,
  type ConversationHistory,
} from '@lostgradient/chat';

declare let conversation: ConversationHistory;
declare const messageId: string;
declare const toolCallId: string;

// Edit a message's content in place, keeping identity, role, order, and
// creation time intact.
conversation = updateMessage(conversation, messageId, { content: 'Edited' });

// Hide or reveal a message without removing it.
conversation = setMessageHidden(conversation, messageId, true);

// Remove a message and renumber the surviving positions.
conversation = removeMessage(conversation, messageId);

// Swap in the final outcome for a tool call that was parked on
// `action_required` once the consumer approves or denies it.
conversation = replaceToolResult(conversation, toolCallId, {
  callId: toolCallId,
  outcome: 'success',
  content: { approved: true },
});
```

`updateMessage`, `removeMessage`, `setMessageHidden`, and `replaceToolResult` are no-ops—they return the original history unchanged—when given an unknown message or tool-call identifier, so callers do not need to guard against a stale ID.

`getMessages(conversation, { includeHidden? })` returns the ordered, non-hidden messages Chat renders (pass `includeHidden: true` to include hidden ones too). `getUnresolvedToolApprovals(conversation)` finds every `tool-result` message still parked on `outcome: 'action_required'` with a pending `action`—the transcript-level source of truth for "does this conversation have an approval waiting," independent of any UI-only approved/denied state. `findToolResultMessage(conversation, toolCallId)` locates the `tool-result` message for a given tool-call ID, which `replaceToolResult` needs. Both query helpers accept the same `{ includeHidden? }` option as `getMessages`.

> [!WARNING] `ChatAdapter.subscribe` runs inside Chat's own effect Chat opens `subscribe` from inside its internal mount `$effect`, so a synchronous `$state` write inside `subscribe` can throw `effect_update_depth_exceeded`. Defer it with `queueMicrotask` or `tick()`. The same applies if `subscribe` replays a buffered event by calling a handler (`onMessage`, `onTypingChange`, etc.) synchronously before returning — defer the CALL to the handler itself, not just any write of your own, since `onTypingChange`/`onReadReceipt` write Chat's own internal state before your code runs at all. See the `ChatAdapter.subscribe` and `ChatPushHandlers` JSDoc for the full explanation and working examples.

## Conversation data contract

Chat declares `@lostgradient/cinder` and `svelte` as peer dependencies — host applications install those alongside `@lostgradient/chat`. `conversationalist` (and its own `zod` dependency) is an implementation detail Chat owns: it ships as a regular dependency of `@lostgradient/chat` and installs automatically, so using Chat never requires a host application to add or version-pick it. Import the conversation types, builders, `CURRENT_SCHEMA_VERSION`, and `isJSONValue` from `@lostgradient/chat` rather than importing `conversationalist` yourself. An application that uses `conversationalist` APIs beyond what Chat re-exports may still depend on it directly — that is supported, it just is not something Chat requires.

The exported schema version comes from the `conversationalist` version Chat depends on. Histories produced by an older compatible schema can render as-is; a newer schema causes Chat to emit a console warning and requires upgrading `@lostgradient/chat` before relying on that history.

## Layout and sizing

Chat's outer layout element is `height: 100%`. When no ancestor on the chain resolves to a definite height, that `100%` resolves against `auto` and Chat collapses to the intrinsic height of its empty state plus composer. There is no browser error: it just silently shrinks to a small card. Give Chat a sized ancestor with one of the three patterns below.

**Fixed-height container.** The simplest option—wrap Chat in an element with an explicit height. This is what every example in this component uses.

```svelte
<div style="height: 34rem;">
  <Chat id="support-chat" {conversation} />
</div>
```

**Full-viewport flex column.** For an app shell where Chat should fill the remaining space, give the column a definite height and let the Chat cell `flex: 1` with `min-height: 0` (so it can shrink below its content and scroll internally rather than overflowing the page).

```svelte
<div class="chat-page">
  <header>…</header>
  <Chat id="app-chat" class="chat-page-surface" {conversation} />
</div>

<style>
  .chat-page {
    display: flex;
    flex-direction: column;
    height: 100dvh;
  }

  /* `:global` because the class lands on Chat's own outer layout element. */
  .chat-page :global(.chat-page-surface) {
    flex: 1;
    min-height: 0;
  }
</style>
```

**Grid cell.** The same shape works in a grid: give the container a resolved track (`grid-template-rows: auto 1fr`), place Chat in the `1fr` row, and keep `min-height: 0` on the Chat cell so it can shrink and scroll internally instead of overflowing the page.

```svelte
<div class="chat-grid">
  <header>…</header>
  <Chat id="grid-chat" class="chat-grid-surface" {conversation} />
</div>

<style>
  .chat-grid {
    display: grid;
    grid-template-rows: auto 1fr;
    height: 100dvh;
  }

  .chat-grid :global(.chat-grid-surface) {
    min-height: 0;
  }
</style>
```

## Quoting agent messages

A reader can reply to part of an agent message, or to several parts at once. Quoting needs no props and no adapter support: the quotes travel as Markdown in the message itself, so the model sees them, and a reloaded transcript shows them.

- Selecting text inside one assistant message's content opens a Quote popover (Cinder's `SelectionPopover`). A selection that spans messages, or reaches outside assistant content, opens nothing.
- Every assistant message also has a Quote message action in its action row. It quotes the current selection when that selection lies inside the message, and otherwise the message's whole rendered text, so quoting works from the keyboard.
- Each quote appears as a chip above the composer showing its first 80 characters, with a Remove button. Chips keep the order they were added in, and quoting the same text twice adds it once.
- A reply carries at most 10 quotes. At 10, both Quote actions are disabled and the chip row says why. A quote longer than 4,000 characters is cut to 3,999 characters plus an ellipsis. Surrounding whitespace is trimmed from every quote.

A quote is the selected text exactly as the browser reports it (`Selection.toString()`), not a link back to the message it came from, and Chat sends no quote metadata. Sending puts the quotes at the top of the message as Markdown block quotes: every line is prefixed with `> `, quotes are separated by one blank line, and one more blank line precedes the typed text.

```md
> alpha is the first item we track.

> It was added before every other item. That is why it leads.

Why does order matter here?
```

The composed text goes through `ChatAdapter.sendMessage` (or `onSubmit`), or through `sendRunInput` when a run is active, exactly as a plain reply would. `ChatSubmitEvent.message.content` and the adapter's `message.content` already hold the composed text. The composer still needs typed text or an attachment to send, so quotes alone cannot be sent. With an attachment and no typed text, the content ends at the last quote.

The quotes leave the chip row the moment the message is handed off, not when the send finishes. The session controller settles `sendMessage` only when the whole run ends, so a follow-up sent during that run would otherwise repeat them. If the send fails, the quotes come back ahead of any chips added since, in their original order and without repeating any text. When they would not all fit within the limit of 10, the first 10 stay and Chat announces how many were dropped. A send that fails after the conversation has changed restores nothing. `onSubmit` is not awaited, so only a synchronous throw from it counts as a failure. Changing the conversation clears the chips.

Quoting is on by default. `capabilities.quote` set to `false` removes the Quote message action and the selection popover, and clears any chips.

Quoting covers assistant messages only. User messages and tool output offer no Quote action, and a selection inside them opens no popover. The "Quoting agent messages" example shows the flow.

## Composer actions

`composerActions` is an optional snippet rendered in the composer footer, beside Send, so a host can put its own controls next to the composer; the usual case is a model picker built from Cinder's `Select` (or `Combobox`). Chat does not ship a picker: the host owns the value and what it means.

```svelte
<script lang="ts">
  import { Chat } from '@lostgradient/chat';
  import { Select } from '@lostgradient/cinder';

  let model = $state('balanced');
</script>

<Chat id="assistant-chat" {conversation} {adapter}>
  {#snippet composerActions()}
    <Select
      id="assistant-chat-model"
      bind:value={model}
      options={models}
      label="Model"
      labelVisible={false}
    />
  {/snippet}
</Chat>
```

The snippet takes no arguments. It stays interactive while a run streams and while a tool approval is pending, because Chat only disables the composer textarea, never the footer; the host decides whether a control should lock during a run. Without the snippet the composer renders as it always has. The "Composer actions" example shows the whole flow.

## Building composer overlays

Slash-command, mention, and autocomplete overlays should use Chat's composer API instead of querying `.chat-input-editor` directly.

Use `bind:this` to read or control the composer:

```svelte
<script lang="ts">
  import { Chat } from '@lostgradient/chat';

  let chat: ReturnType<typeof Chat> | undefined;
</script>

<Chat
  bind:this={chat}
  id="assistant-chat"
  {conversation}
  onComposerInput={(value) => updateOverlayQuery(value)}
  oncomposerkeydown={(event) => {
    if (!overlayOpen) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter') {
      event.preventDefault();
      handleOverlayKey(event);
    }
  }}
/>
```

`getComposerValue()` returns the current plain-text value, `clearInput()` clears it, and `getEditorElement()` returns the textarea element (or `null` before mount and after teardown) for overlay anchoring and focus management. `insertAtRange({ start, end }, text)` replaces that composer range without a synthetic DOM event, focuses the textarea, and places the caret after the inserted text. It uses native `HTMLTextAreaElement.setRangeText()` boundaries: out-of-bounds indexes are clamped and a reversed range throws a `DOMException`. Calls before mount or after teardown are safe no-ops.

`oncomposerkeydown` runs before Chat's internal Enter-to-send handling for normal composer keydowns. If the callback calls `event.preventDefault()`, Chat skips its internal key handling for that event. Chat does not call the hook during IME composition, so Enter can still confirm the active candidate instead of sending or being consumed by an overlay.

For ARIA combobox patterns, pass textarea-specific attributes through the composer-prefixed props:

```svelte
<Chat
  id="assistant-chat"
  {conversation}
  composerRole="combobox"
  composerAriaExpanded={overlayOpen ? 'true' : 'false'}
  composerAriaControls="slash-command-listbox"
  composerAriaActiveDescendant={activeOptionId}
  composerAriaAutocomplete="list"
/>
```

## Announcing custom action-required rows

Chat owns always-rendered polite and assertive live regions outside the `role="log"` timeline. If you render action-required UI through a custom `row` or `messagePart` snippet, announce it through Chat instead of mounting another `aria-live` region inside the log:

```svelte
<script lang="ts">
  import { Chat } from '@lostgradient/chat';

  let chat: ReturnType<typeof Chat> | undefined;

  function showCustomApproval() {
    chat?.announce('Action required: Review the deployment approval.', 'assertive');
  }
</script>

<Chat bind:this={chat} id="assistant-chat" {conversation} row={customRow} />
```

Use the default polite channel for non-urgent status updates:

```ts
import type { ChatAnnounceLevel } from '@lostgradient/chat';

// The bound `<Chat bind:this={chat}>` instance.
declare const chat: { announce(message: string, level?: ChatAnnounceLevel): void } | undefined;

chat?.announce('Attachment scan finished.');
```

Consumer announcements clear after a short interval so Chat's own history, unread, typing, and tool-approval announcements can continue to flow. Built-in tool-approval rows keep precedence on the assertive channel. If a consumer assertive announcement races with Chat's derived `Action required: ...` tool-approval announcement, Chat announces the built-in tool approval and drops the consumer assertive text to avoid double output.

## Per-row snippet context

`row`, `messageActions`, and `messageStatus` receive the same `ChatRowContext`. The context contains the message that owns the visible row and optional resolved `toolCallPair` and `artifact` values. When a row has `cinder:artifact` metadata, Chat renders an always-visible `Open artifact: <title>` row action and opens the built-in artifact panel by default:

```svelte
<script lang="ts">
  import { Chat, type ChatRowContext, type ResolvedChatArtifact } from '@lostgradient/chat';
  import { Button } from '@lostgradient/cinder';

  let selectedArtifact = $state<ResolvedChatArtifact | undefined>();
</script>

<Chat
  id="assistant-chat"
  {conversation}
  onArtifactOpen={(artifact) => (selectedArtifact = artifact)}
>
  {#snippet messageActions({ artifact }: ChatRowContext)}
    {#if artifact}
      <Button size="xs" variant="ghost" onclick={() => (selectedArtifact = artifact)}>
        Track externally
      </Button>
    {/if}
  {/snippet}
</Chat>
```

`onArtifactOpen` is an ownership override: when supplied, Chat calls it with the resolved artifact and does not open the internal panel. Omit it to use Chat's built-in `ChatArtifactLayout`, `ArtifactPanel`, and `ArtifactViewer` composition. The resolved artifact keeps the raw descriptor fields and adds `id` from the source message plus a normalized non-empty `title` (`Artifact` when metadata is blank).

`messageActions` is rendered in the same hover/focus action row as Chat's built-in copy and edit controls. Artifact actions are separate persistent row actions. For native buttons in `messageActions`, add the shared `chat-message-action-button` class to opt into the action-row sizing, focus, hover, and touch styles:

```svelte
<script lang="ts">
  let panelOpen = $state(false);
</script>

{#snippet messageActions()}
  <button type="button" class="chat-message-action-button" onclick={() => (panelOpen = true)}>
    Open panel
  </button>
{/snippet}
```

The class is intentionally opt-in so consumers can use their own button component or visual treatment without Chat overriding it. Cinder `Button` instances already provide their own complete styling and do not need this class.

A paired `tool-result` message does not render a second visible row and does not invoke the snippets separately. Chat folds that result into the corresponding tool-call row's `toolCallPair` and resolves `cinder:artifact` metadata from the folded result into `artifact`. Metadata on the visible message takes precedence. Ordinary rows and unpaired tool-result rows resolve their own artifact metadata, so consumers do not need an external message lookup or a hand-rolled type guard. Artifact identity always comes from the source message id, so duplicate titles and duplicate content remain independent.

## Guidance

### Use When

- Shipping a full chat surface with composer, scroll-anchor, unread indicator, and attachments bundled as one heavyweight drop-in.
- Building an AI assistant or support thread where conversation state is modeled as a transcript of role-tagged messages.

### Avoid When

- Rendering a one-off message list — compose lighter primitives directly instead of pulling the full suite.
- The transcript is read-only and needs no composer — a simple list of message bubbles is a better fit.

## Attachment serialization

When `capabilities.attachments` is enabled, `onSubmit` receives ready `ChatAttachment[]` values. Use `serializeChatAttachment()` or `serializeChatAttachments()` from `@lostgradient/chat` to convert those files into transportable base64 payloads without spreading the full byte array onto the JavaScript stack.

```ts
import { serializeChatAttachments, type ChatAttachment } from '@lostgradient/chat';

declare const chatAttachments: ChatAttachment[];

const attachments = await serializeChatAttachments(chatAttachments);
```

Each serialized attachment has this shape:

```ts
import type { ChatAttachment } from '@lostgradient/chat';

type SerializedChatAttachment = {
  name: string;
  mimeType: string;
  kind: ChatAttachment['kind'];
  content: string;
};
```

The output is intentionally the base64 source payload for conversationalist's proposed `DocumentContent` bridge in `stevekinney/agent-bureau#153`. A consumer can wrap it as `{ type: 'document', name, mimeType, source: { kind: 'base64', data: content } }` when adding composer attachments to conversation state.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `atBottom` | `boolean` | no | — | Whether the message viewport is scrolled to the bottom. Bindable; updated automatically as the user scrolls. Default `true`. |
| `bottomThreshold` | `number` | no | — | Distance in pixels from the bottom of the scroll viewport within which the chat is considered "at bottom" and will auto-scroll on new messages. Default `150`. |
| `class` | `string` | no | — | Additional class name merged onto the outer Chat layout element. |
| `composerAriaActiveDescendant` | `string` | no | — | `aria-activedescendant` passed to the composer textarea for overlays such as slash-command menus. |
| `composerAriaAutocomplete` | `"none"` \| `"inline"` \| `"list"` \| `"both"` | no | — | `aria-autocomplete` passed to the composer textarea for overlays such as slash-command menus. |
| `composerAriaControls` | `string` | no | — | `aria-controls` passed to the composer textarea for overlays such as slash-command menus. |
| `composerAriaExpanded` | `false` \| `true` \| `"true"` \| `"false"` | no | — | `aria-expanded` passed to the composer textarea for overlays such as slash-command menus. |
| `composerRole` | `string` | no | — | Explicit role for the composer textarea, for overlay patterns such as ARIA comboboxes. |
| `density` | `"comfortable"` \| `"compact"` | no | — | Controls spacing density of the message timeline. - `'comfortable'` (default): standard padding and gap. - `'compact'`: tighter spacing for data-dense contexts (e.g., embedded panels). Action buttons keep `min-height: var(--cinder-touch-target-min)` regardless. |
| `emptyPrompts` | `string`[] | no | — | List of suggested starter prompt strings shown as clickable buttons in the default empty state. Clicking a prompt submits it immediately as a user message. Has no effect when a custom `empty` snippet is provided. |
| `id` | `string` | yes | — | Unique identifier used to scope accessibility attributes across the chat surface. |
| `jumpThreshold` | `number` | no | — | Distance in pixels scrolled up from the bottom required before the jump-to-latest button appears. Must be greater than `bottomThreshold` to prevent button flickering. Default `200`. |
| `loadEarlierLabel` | `string` | no | — | Label for the history pagination trigger. Default `"Load earlier messages"`. |
| `loadingEarlierLabel` | `string` | no | — | Status text while older messages are loading. Default `"Loading earlier messages"`. |
| `moreHistoryAvailable` | `boolean` | no | — | Whether the explicit "Load earlier messages" trigger is shown when a load handler exists. Default `true`. |
| `newMessageIndicatorVisible` | `boolean` | no | — | Whether the "new messages" indicator is currently visible above the composer. Bindable; cleared automatically when the viewport reaches the bottom. Default `false`. |
| `scrollFadeVisible` | `boolean` | no | — | Show a scroll-driven edge fade on the top and bottom of the message timeline as it overflows. Opt-in and presentation-only — never the sole signal that more messages exist; the jump-to-latest button and unread count remain the authoritative affordances. Only visible when `surfaceMode` is `'default'`: with `surfaceMode="transparent"` the timeline paints no background of its own, so there is no color the fade could correctly fade toward, and it stays inert rather than painting an incorrect opaque band. Default `false`. |
| `streaming` | `boolean` | no | — | Whether a streaming response is currently in progress. When `true`, the composer is disabled and a stop-generating button is shown, unless the `adapter` provides `sendRunInput`: then the composer stays enabled, Send and Stop sit side by side, and a submission goes to `adapter.sendRunInput` as a follow-up to the running turn. Default `false`. |
| `streamingStatus` | `string` | no | — | Optional status label displayed in the typing indicator while `streaming` is `true` and no streaming content has arrived yet (e.g. `"Thinking…"` or `"Analyzing file…"`). When omitted, three animated dots are shown. |
| `surfaceMode` | `"default"` \| `"transparent"` | no | — | Controls the background of the chat surface. Use `'transparent'` to inherit the host element's background when embedding chat inside a card or panel. Default `'default'`. |
| `unreadCount` | `number` | no | — | Number of messages received while the viewport was scrolled away from the bottom. Bindable; resets to `0` when the user scrolls to the bottom. Default `0`. |
| `variant` | `"bubble"` \| `"flat"` | no | — | Visual treatment for message bubbles. - `'bubble'` (default): colored backgrounds differentiate user from assistant. - `'flat'`: no bubble backgrounds; role is communicated via alignment and role label. Text-on-surface contrast meets WCAG AA via `--cinder-text-default` on `--cinder-surface-inset`. |
| `virtualizationEstimatedRowHeight` | `number` | no | — | Estimated row height in pixels for virtualized message rows. Default `88`. |
| `virtualizationInitialHeight` | `number` | no | — | Initial virtualized viewport height used before measurement. Default `640`. |
| `virtualizationOverscan` | `number` | no | — | Number of extra virtual rows rendered before and after the viewport. Default `3`. |
| `virtualized` | `boolean` | no | — | Use the virtualized message render path for long transcripts. The complete `ConversationHistory` remains unchanged; only the DOM window is reduced. Default `false`. |
| `adapter` | `(opaque)` | no | — | Optional command/transport boundary around `conversation`. Its methods take precedence over the matching callback props (e.g. `sendMessage` over `onSubmit`); omit it and Chat behaves exactly as with plain callbacks. Not expressible in JSON Schema; see the component types for the signature. |
| `capabilities` | `(opaque)` | no | — | Feature-capability flags. Pass a `ChatCapabilities` object to enable or disable individual Chat features (attachments, search, copy, editing, retry, quote) as a group rather than as six separate boolean props. Not expressible in JSON Schema; see the component types for the signature. |
| `composerActions` | `(opaque)` | no | — | Controls rendered in the composer footer, beside Send. Use it for host-owned controls such as a model `Select`. The snippet takes no arguments, stays interactive while a run streams and while a tool approval is pending, and the caller owns the semantics inside it. When omitted, the composer renders as before. Not expressible in JSON Schema; see the component types for the signature. |
| `conversation` | `(opaque)` | yes | — | The conversation transcript to render. Pass a {@link ConversationHistory} snapshot; consumers holding a stateful conversation object pass its current snapshot (e.g. `conversation.current`). Not expressible in JSON Schema; see the component types for the signature. |
| `empty` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `header` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `markdownNode` | `(opaque)` | no | — | Per-node override for fenced code blocks, tables, and Mermaid blocks inside markdown messages. Not expressible in JSON Schema; see the component types for the signature. |
| `messageActions` | `(opaque)` | no | — | Actions rendered for a visible message row. Receives the same {@link ChatRowContext} as `messageStatus` and `row`, including resolved tool pairs and artifact metadata. Not expressible in JSON Schema; see the component types for the signature. |
| `messagePart` | `(opaque)` | no | — | Per-message-part override. Replaces the rendering of an individual body part (markdown, tool call, tool result) while delegating the rest to the built-ins via the `renderDefault` snippet it receives. Image parts are excluded — they render through the grouped attachment grid, not this override. Not expressible in JSON Schema; see the component types for the signature. |
| `messageReasoning` | `(opaque)` | no | — | Override or supplement the reasoning text for a message. Called per-message; return a non-empty string or `{ content, summary? }` to show one reasoning body, `undefined` to fall back to `message.metadata['cinder:reasoning']`, or an empty string to suppress reasoning. Not expressible in JSON Schema; see the component types for the signature. |
| `messageStatus` | `(opaque)` | no | — | Status rendered for a visible message row. Receives the same {@link ChatRowContext} as `messageActions` and `row`, including resolved tool pairs and artifact metadata. Not expressible in JSON Schema; see the component types for the signature. |
| `messageSteps` | `(opaque)` | no | — | Override or supplement the step list for a message. Called per-message; return an array to show step indicators, `undefined` to fall back to `message.metadata['cinder:steps']`. An empty array suppresses steps. Not expressible in JSON Schema; see the component types for the signature. |
| `messageSuggestions` | `(opaque)` | no | — | Override or supplement the suggestion list for a message. Called per-message; return an array of label strings to show suggestion chips, `undefined` to fall back to `message.metadata['cinder:suggestions']`. An empty array suppresses suggestions. Not expressible in JSON Schema; see the component types for the signature. |
| `onAdapterError` | `(opaque)` | no | — | Called when an adapter command fails — either a rejected promise or a synchronous throw from the method. Not expressible in JSON Schema; see the component types for the signature. |
| `onArtifactOpen` | `(opaque)` | no | — | Overrides Chat's built-in artifact panel. When supplied, Chat calls this once with the resolved artifact and does not open its local panel. Not expressible in JSON Schema; see the component types for the signature. |
| `onApprovalResolve` | `(opaque)` | no | — | Called when the user resolves an action-required approval. The complete resolution payload is forwarded unchanged. When an adapter is also wired, Chat calls `adapter.resolveToolApproval(toolCallId, resolution)` first and uses this callback only when the adapter does not implement that method. Not expressible in JSON Schema; see the component types for the signature. |
| `onAttachmentAdd` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onAttachmentFailure` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onAttachmentRemove` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `oncomposerblur` | `(opaque)` | no | — | Called when focus leaves the composer textarea. Overlay primitives can use this to dismiss without preventing native focus movement. Not expressible in JSON Schema; see the component types for the signature. |
| `onComposerInput` | `(opaque)` | no | — | Called with the composer's current plain-text value after user input or `insertAtRange()`. The optional event exposes the textarea for composer-bound overlays without reaching into `.chat-input-editor` DOM directly; programmatic range insertion omits the event. Not expressible in JSON Schema; see the component types for the signature. |
| `oncomposerkeydown` | `(opaque)` | no | — | Called before Chat's internal composer key handling when a keydown originates from the composer textarea. Call `event.preventDefault()` to let an overlay consume Arrow keys, Enter, or Escape before Enter-to-send. Chat does not call this hook during IME composition, so Enter can still confirm the active candidate instead of sending. Not expressible in JSON Schema; see the component types for the signature. |
| `oncomposerselectionchange` | `(opaque)` | no | — | Called after pointer or selection activity may have moved the composer caret without changing text. Overlay primitives can resync their active token from the textarea selection. Not expressible in JSON Schema; see the component types for the signature. |
| `onEdit` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onExpandedChange` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onJumpToLatest` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onLoadHistory` | `(opaque)` | no | — | Called when the explicit history trigger is activated. The consumer prepends compatible messages into `conversation`. Not expressible in JSON Schema; see the component types for the signature. |
| `onPushMessage` | `(opaque)` | no | — | Forwarded from the adapter's real-time `onMessage` push (consumer owns the transcript). Not expressible in JSON Schema; see the component types for the signature. |
| `onReadReceipt` | `(opaque)` | no | — | Forwarded from the adapter's real-time `onReadReceipt` push. Not expressible in JSON Schema; see the component types for the signature. |
| `onRetry` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onRollback` | `(opaque)` | no | — | Commits a confirmed transcript rollback to immediately before the selected user message. Not expressible in JSON Schema; see the component types for the signature. |
| `onScrollStateChange` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onStopGenerating` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onSubmit` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onSuggestionSelect` | `(opaque)` | no | — | Called when the user selects a suggestion chip. The label string is passed back. The consumer is responsible for submitting it as a new user message. Not expressible in JSON Schema; see the component types for the signature. |
| `onTypingChange` | `(opaque)` | no | — | Forwarded from the adapter's real-time `onTypingChange` participant snapshot push. Not expressible in JSON Schema; see the component types for the signature. |
| `onUnreadIndicatorChange` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `readReceipts` | `(opaque)` | no | — | Per-message read receipt state. Out-of-band UI state — NOT stored on `Message`. Pass a `Map` keyed by message id with a {@link ReadReceipt} value; the component renders a receipt badge on USER messages only. While defined, including as an empty `Map`, this prop determines the visible receipts instead of adapter-derived state. Adapter events still call `onReadReceipt`, and their derived state may continue accumulating and become visible if this prop later becomes `undefined`. Omit the prop or pass `undefined` to show adapter-derived state. Default `undefined` (no receipts shown until adapter state is available). Not expressible in JSON Schema; see the component types for the signature. |
| `row` | `(opaque)` | no | — | Full-row override. Renders an entire message row; receives the shared row context and a `renderDefault` snippet for the built-in row (inversion of control), so a consumer can wrap or fully replace specific rows. Paired tool results are folded into the visible tool-call row's `toolCallPair`, with validated `cinder:artifact` metadata available as `artifact`. Not expressible in JSON Schema; see the component types for the signature. |
| `typingParticipants` | `(opaque)` | no | — | Participants who are currently typing. Out-of-band UI state — NOT stored on `Message`. Pass an array of {@link TypingParticipant} objects; the component renders a per-participant typing indicator above the input. While defined, including as an empty array, this prop determines the visible indicator instead of adapter-derived state. Adapter events still call `onTypingChange`, and their derived state may continue updating and become visible if this prop later becomes `undefined`. Omit the prop or pass `undefined` to show adapter-derived state. Default `undefined` (indicator hidden until adapter state is available). Not expressible in JSON Schema; see the component types for the signature. |
| `viewportAttachment` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

- `--cinder-chat-font-size`
- `--cinder-chat-message-max-width`
- `--cinder-text-base`
- `--cinder-text-lg`
- `--cinder-text-sm`
- `--cinder-text-xs`

<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
