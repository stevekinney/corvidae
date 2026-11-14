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

## Approval decisions

A tool approval draws as Cinder's explicit decision surface: the action, the Tool, the Command and a Deny and Approve pair. An adapter that knows more about it adds to that with `describeApproval(toolCall, action)`, which returns a `ChatApprovalDetails` or `undefined` (a throw reads as `undefined`). The approval action carries no word on whether it can be undone, so only the adapter can mark an approval irreversible:

```ts
import type { ChatAdapter } from '@lostgradient/chat';

const adapter: Pick<ChatAdapter, 'sendMessage' | 'describeApproval'> = {
  sendMessage: async () => undefined,
  describeApproval: ({ name }) =>
    name === 'issue-refund'
      ? {
          irreversible: true,
          approveLabel: 'Refund',
          pauseSentence: 'The agent is paused until you decide.',
          facts: [{ label: 'Amount', value: '$42.00' }],
        }
      : undefined,
};
```

- The surface is Cinder's `ApprovalCard` with `layout="decision"`: the action as the title, a danger badge when `irreversible`, the pause sentence, Tool, your `facts`, whether it can be undone, and the command always open and monospaced. Deny sits left and the named primary right. An irreversible primary arms on its first press ("Press again to refund"), reverts after three seconds or on Escape, and commits on the second press. Escape on an armed press never cancels the approval.
- A decision made in this chat stays in the transcript as a receipt: a check badge, "by you" and the time, with a denial's note quoted inline. The receipt outlives the result that asked, so it is still there once the run resumes. A decision made on another surface is not known to Chat; the wire action carries no actor or surface.
- While an approval waits, a drawer above the composer says "Waiting for your approval." It is one row at every width: the glyph, the words and the button at its end, which reads Review in a column under 30rem (`reviewApprovalShort`) and keeps the name Review approval. Its Review approval button scrolls to the approval (through the virtualized rows) and focuses its card without answering it. A draft in the box makes Send read Queue with the queue icon.
- A transcript pinned to its end shows an item's bottom. When the item at the end waits on the person (a pending approval card, or an open question, including the block a host draws around one in `trailing`) and is taller than the room left, the transcript lifts until the item's top, its question, is in view, and the person scrolls on to its buttons. Only the waiting item nearest the end, and only while part of it is in view, lifts the transcript; nothing moves while focus is inside the item; and once the person scrolls, wheels, touches or presses a key in the transcript, or jumps to the latest message, that item stays where they put it.

By default the composer is disabled while `streaming` is `true`, and the session controller refuses a second turn while a run is working or a tool approval is pending. A host that owns the run on the server, and can deliver input to it in flight, opts in with `sendRunInput`. Follow-ups are supported only for server-owned runs (`executionOwner: 'server'`): with a browser-owned run the controller does not expose the hook, the composer does not offer follow-ups, and submitting during the run behaves as it did before. A host attaching to or retrying a parked run can call `controller.sendHiddenMessage()` to start an internal turn without weakening the ordinary pending-approval gate; the hidden row remains in authoritative history and is not user-visible. There are two hooks, and they are different types:

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

A host whose server holds a follow-up until the run takes it, and can take it back until then, also passes `retractRunInput(conversationId, { messageId })`, resolving `'retracted'` when the input will never be delivered and `'delivered'` when the run already had it. Then:

- Acceptance is not delivery. An accepted follow-up stays queued (its row keeps the pending status, so the transcript draws it as a queued message) until the run takes it. The host says when with `controller.markFollowUpsDelivered(messageIds)`, as when its server announces the step that took them, and otherwise the run's terminal history shows it. From then on the row reads as sent and is not resent when the run ends.
- `controller.adapter.removeRunInput(messageId)` takes a queued follow-up back, and `Chat` calls it for Remove. One the host holds goes through `retractRunInput`: `retracted` takes its row out of the transcript, and `delivered` leaves it as a sent message. One the host was never handed, or whose run ended without taking it, is dropped without asking. A rejection leaves the row queued and is reported through `onAdapterError`. A follow-up that is already a sent message cannot be removed.

A controller without `sendRunInput`, or with a browser-owned run, behaves exactly as before. The "Follow-ups during a run" example shows the flow.

A follow-up typed while a run works, or while an approval waits, is not handed to the run by default. It waits on the page in an Up next drawer above the composer ("2 queued, sends after this run" where the drawer is wide enough, "2 queued" below that; Send now instead carries "Otherwise it sends when this run finishes." as its tooltip and description), each one a bordered, numbered row holding the words of the message it will become, with Edit (which puts its words and files back in the composer) and a remove control named "Remove queued follow-up 1". When the run finishes they go one at a time, each as a new turn through `sendMessage`, in the order they were typed. Send now instead hands every waiting follow-up to the running run through `sendRunInput`, which is the only path that uses live run input. Stopping the run, or a waiting follow-up whose send fails, sets the rest aside in a warning drawer whose Restore puts their words and files back in the composer, and Dismiss forgets them. Another conversation starts with an empty queue. While the run works the composer's placeholder reads "Add another follow-up…", and Send reads Queue.

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

## Composer controls, hint and blocked row

`composerControls` is an optional snippet rendered right after the attach button for the host's own selects (Cinder `Select` with `variant="ghost"`, `presentation="listbox"` and a `valuePrefix` draws `Model Claude Sonnet 5.5`), and `composerActions` still sits beside Send for something like a context meter. `composerPlaceholder` sets the placeholder, and `composerHint` replaces or hides the line under the box (default `Enter to send. Shift and Enter for a new line.`). On a touch-only device (no hover and a coarse pointer) the default hint and the formatting shortcuts' words are not drawn, because there are no keys to press; a host's own hint still shows.

`composerHeader` is an optional snippet for the top row inside the composer's border, above the text, where a new chat draws its ghost agent `Select` (a `leading` avatar, the agent's name). The footer is one row that never wraps. When the composer is narrower than `COMPOSER_FOLD_WIDTH` (40rem: a side panel docked beside the conversation, a phone), or at any width when the controls with their values in full would not fit beside the meter and Send (measured from the controls' own width, and marked on the composer as `data-controls-folded`), `composerControls` is called with `{ folded: true }`, and a host draws one ghost `Settings` control holding the model, effort and permissions in place of the three selects; `ChatComposerSettings` is that control, so a host writes `<ChatComposerSettings {folded}>…the three selects…</ChatComposerSettings>` and the selects stand in the row while it is wide and open from `Settings` once it is not. Controls and Send are 44px tall on a composer under 28rem. `composerFormattingToolbar` draws a row of Bold, Italic, Code, Link and List buttons above the text, with the words of their shortcuts (`⌘B bold`, `⌘I italic`, `⌘E code` and `⌘⇧K link`, each its own element) at its right, only while the composer has focus. It opens when the box or the row takes focus and stays while focus is in the composer; a control the host puts in the composer (the agent select above the box, the selects under it) taking focus does not open it, so a click on that control is never moved out from under the pointer by the row appearing. Link is Cmd or Ctrl with Shift and K; plain Cmd or Ctrl with K is left to the host, so its command palette still opens from the composer. A file the person attaches is a tile under a count of the files ("3 files"): a type badge, its name truncated in the middle so the extension always shows, its size, the percentage while it uploads (when the `uploadAttachment` hook reports it through `onProgress`, otherwise a moving bar), and a cross that removes it. A file that failed keeps its tile in the danger colour with the reason beside it; an upload that failed also offers Retry before the cross, while a file the composer refused (too large, or a type it does not take) has only the cross. While any file needs attention Send is off, and the line under the composer says so once, "Retry or remove 2 files to send", which Send names through `aria-describedby`. A type the composer does not take reads "This file type can’t be attached. Attach an image, a PDF or a text file.", naming the kinds `acceptedTypes` allows. More than three files cap the list: exactly three tiles show, each whole, and a count of the rest under it ("11 more") opens the whole list, which scrolls inside the composer. On a composer 30rem wide or less each file is a row the composer's width, and its name wraps instead of being cut. `composerCompact` is a one-line composer for a small surface such as a test chat in a side panel: the field and Send share one row (Send becomes Stop while a reply streams, and the field is disabled), with no controls, attachments or formatting, and the hint under it.

`composerPlacement="centered"` puts the empty state, the composer and `composerFooter` together in the middle of the surface while the conversation has no message, the way a new chat greets a person, and docks the composer at the bottom as soon as there is one. `composerFooter` is an optional snippet drawn under the composer's hint or status line, where a new chat draws its example prompts and the other agents to start with; the block is at most `52rem` wide.

`composerLead` is an optional snippet drawn above the composer, outside its border, for a note on where the conversation comes from, such as the chip a new chat started from another page carries; it is drawn whether the composer is live or blocked. `composerStarting` names the word Send shows while the host is starting what the message belongs to (`Starting chat…`): Send is off with a spinner, Stop is not offered, and the text stays. With `clearComposerOnSubmit={false}` Send leaves the typed text and files in the box, and the host empties it with `clearInput()` once the message has gone through.

```svelte
<Chat id="new-chat" {conversation} composerFormattingToolbar>
  {#snippet composerHeader()}
    <AgentSelect />
  {/snippet}
  {#snippet composerControls({ folded })}
    {#if folded}
      <SettingsSelect />
    {:else}
      <ModelSelect />
      <EffortSelect />
      <PermissionsSelect />
    {/if}
  {/snippet}
</Chat>
```

`composerStatus` is the line that replaces the hint: `{ kind: 'steering' }` ("A message now steers the run."), `{ kind: 'note', text }` for a sentence of the host's own such as "Effort High applies from the next step.", `{ kind: 'reconnecting', attempt }` and `{ kind: 'queued' }`. Two kinds are drawers above the composer instead: `{ kind: 'offline' }` says "You're offline. Your draft is saved here, and Send comes back when you reconnect.", keeps the draft and turns Send off, and Send's `aria-describedby` names the drawer; `{ kind: 'draft-restored', when, ondiscard? }` says "Restored your unsent draft from `<when>`." with Discard draft, which empties the composer and then calls `ondiscard`. Its `{ kind: 'blocked', reason, action?, link? }` kind replaces the whole composer with one compact row: a warning glyph, the reason in muted text, a secondary button for `action` and a quiet link for `link` (each a button with `onclick`, or an anchor with `href`). Use it for a missing provider ("Connect a model provider to chat"; set `primary: true` on the action to draw it as the row's one filled button instead of a secondary one), an unreachable server, an ended chat or a disabled plugin. Two more kinds replace the composer with one neutral bar, with no warning colour: `{ kind: 'archived', when, newChat?, unarchive? }` draws an archive icon and `Archived <when>`, with `newChat` as a secondary button on the left and `unarchive` as the primary button on the right; `{ kind: 'read-only', tooltip?, request? }` draws a lock and the words `Read only`, whose tooltip says who granted the access (`tooltip`), and `request` as the primary button, such as Request access. Each action is a button with `onclick` or a link with `href`. The draft in the box is kept while a bar shows. While a question waits, the composer is in answer mode: the placeholder reads "Choose an answer above, or type your own…" and its button reads Answer. Chat does this itself for the questions it draws; a host that draws its own sets `composerAnswering` (the button reads Answer) and words the placeholder through `composerPlaceholder`.

`variant="transcript"` draws the conversation the way Interborough's chat page does. A reply is plain text with no card and no role label; a person's message keeps its tinted bubble. One muted line under each message holds its time, whatever `messageActions` renders (a model name, a Reply details link, Branch), then Copy and, on a reply, Quote, as words that are always visible. A message that was not sent keeps its bubble and shows a focusable red icon, its time and the red words "Not sent"; the icon opens a popover with `notSent.summary` and a Retry button, which `notSent.retryDisabled` makes inert (`aria-disabled`, so it keeps focus) while `notSent.retryNote` says when it will retry and describes the button. A follow-up the run has not taken yet (delivery status `sending`) is a dashed, pale bubble marked "Queued until the run is ready"; "Remove" shows only when the adapter has `removeRunInput` (the session controller's does when its host passes `retractRunInput`) or the host passes `onRemoveQueued`, because only the host knows whether a message it has sent can be taken back; while a removal settles, Remove is not offered again, and the row then leaves the transcript, or reads as sent when the run had already taken it. A run's notes (memory written, a wakeup, a child run, why it stopped) are full-width rows outside the bubble, and a stop note with `failed: true` is a danger status line with an error glyph and the host's own action beside it (`noteAction`, for a Retry); a stop note with `notice: true` is a muted status line with an info glyph and no "Stopped" label, for a chat the host ended. The agent's instructions (a `system` message) read as muted text folded to one line, "Instructions", a disclosure button with a chevron, and a streaming reply ends in a caret. Edit and rollback are not offered in this presentation.

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

## Message sources

Pass `sourcesByMessageId` to show the sources behind assistant messages. It maps an existing message id to Cinder `CitationSource` entries, in the order to show them:

```ts
import type { CitationSource } from '@lostgradient/cinder';

const sourcesByMessageId = new Map<string, readonly CitationSource[]>([
  [
    'assistant-1',
    [
      { label: 'Annual report', url: 'https://example.com/annual', detail: 'Revenue rose 12%.' },
      { label: 'Board minutes' },
    ],
  ],
]);
```

```svelte
<Chat id="assistant-chat" {conversation} {sourcesByMessageId} />
```

An assistant message with at least one source shows a Sources control with the count; an unknown id, an empty array and a user message show nothing, and a Chat given no map renders exactly as before. The control opens Cinder's `Citation`, which lists up to five sources together, links only a safe web address (any other address reads "Link hidden: the address isn't a safe web link"), and never fetches a source. Sources are presentation only: they are never written to the conversation or an export, and duplicates are kept as given. When the host removes a message's sources while focus is on its control or in its panel, focus moves to the message.

Set `sourcePresentation="list"` to show them under the message instead of in a panel. The control is then a collapsed disclosure; opened, it lists every source with its excerpt and its link, through the same URL policy, and closing it leaves focus on the control. Opening a list in a message above the viewport, including in a virtualized transcript, keeps the message at the top of the viewport where it was.

```svelte
<Chat id="assistant-chat" {conversation} {sourcesByMessageId} sourcePresentation="list" />
```

Set `sourcePresentation="inline"` for one chip per source instead of a single Sources control. A chip reads the source's host (`example.com`) when its address is a safe web link with a host, and the source's label otherwise (an internal document, a relative path, or an address Citation will not link). Chips sit in the line like words and wrap with it; a long host is cut with an ellipsis. Each chip opens that source in Citation's panel, through the same URL policy, and Escape returns focus to the chip.

```svelte
<Chat id="assistant-chat" {conversation} {sourcesByMessageId} sourcePresentation="inline" />
```

## Docked questions

A question that has choices (a choice, a choice with Something else, a yes or no) is drawn in its transcript row by default. Set `questionPlacement="docked"` and Chat draws it in place of the composer instead, while the run waits on it:

- A warning that the step Needs you, and, when several questions were asked together, `Question 2 of 3`.
- A fieldset named Question (its legend is visually hidden), with the question as its text and one radio card per choice, each at least 52 px tall and showing its description and the key that chooses it (1, 2, 3 and so on). Something else, drawn for a choice that allows an answer of the person's own, opens a text field. The keys work only while focus is inside the dock and never inside a field.
- A choice only selects. The primary Answer on the right sends it, and stays off until something is chosen (or typed). The secondary Reply in chat instead on the left gives the composer back and returns the question to its row, where it can still be answered.
- Once answered, the transcript row reads You answered, with Change, as it does for any question. The composer stays mounted while the dock shows, so a draft and its attachments survive.

`questionLabels` (`ChatQuestionDockLabels`) replaces any of the words. Every other kind of question stays in its row. A question also stays in its row while the composer is replaced by a `blocked`, `archived` or `read-only` bar, or by an `error` or `deleted` availability state, because there is no composer to give back.

## Run outcomes on the turn

A turn that has not simply finished says so on itself, under its text, with the controls that recover it, rather than in the composer. Return a `ChatTurnState` from `messageTurnState` for an assistant message:

- `{ kind: 'streaming' }` is a reply that is being written: it ends in a 2 px caret in the accent colour, and no line of time or actions sits under it yet. A turn with no state is drawn this way while text arrives.
- `{ kind: 'reconnecting', attempt, attempts, nextTryIn, wait? }` is a turn whose stream dropped. Its partial text reads muted with no caret, and a warning on the turn reads `Connection lost. Reconnecting, attempt 2 of 5. Next try in 8 s.`, with Retry (`onRetryConnection`) and a bar that drains from `wait` seconds to the next try. The host counts `nextTryIn` down.
- `{ kind: 'stopped' }` is a turn the person stopped: a neutral card reads `Stopped. The answer above is partial.`, with a secondary Discard (`onDiscardTurn`) on the left and a primary Continue (`onContinueTurn`) on the right.
- `{ kind: 'failed', cause, keeps? }` is a turn that failed partway: a danger alert reads `This answer is incomplete.`, then the cause, then what Retry keeps, with Retry (`onRetryTurn`).
- `{ kind: 'empty' }` is a turn that finished without an answer: a neutral row reads `The agent finished without writing an answer.` with the turn's time and Retry (`onRetryTurn`), and no line of time stands under it.
- `{ kind: 'complete' }` is a finished answer, the default once nothing streams.

A stopped or failed turn draws its own stop, so a `stopped` note the run left on it is not drawn as well. `advanceTurnState(state, event)` moves a state on as the run reports what happened (`connection-lost`, `reconnected`, `stop`, `continue`, `retry`, `fail`, `finish`) and leaves it alone for an event that does not apply. Discard is not an event: the host removes the turn.

The steps of a run say where they stand too. The step under way turns, its present-tense title ends in an ellipsis, and the group's header adds `Step 2 of 3` once there is more than one step and how long it has run, counted from its message's time. Once a step fails, the header counts the steps that worked, `2 of 3 steps, 1 failed`, and the failed row opens with Failed in view, what went wrong in danger text, the rest of the error wrapping under it, then Copy error and Retry (`onRetryStep`). `turnLabels` replaces any of these words; `stepsDone` can say what the steps were, such as `Checked 2 of 3 sources`. Tool-specific labels also include `steps`, `calls`, `input`, `output`, `error`, `toolStatus`, `toolProblem`, and `toolAnnouncement`, so the visible count, status, problem phrase, payload headings and live announcement can all be localized together.

## Availability

Set `availability` while the conversation cannot be shown as it is. It replaces the transcript, and for two of its kinds the composer too:

- `{ kind: 'loading', slowAfterSeconds?, onCancel?, labels? }` draws skeleton turns with a status line that reads `Loading conversation…` and the seconds so far. The editor stays, and Send reads `Loading…` and waits for the history; the typed text is kept. Once the read has run for `slowAfterSeconds` (default 10) the line says it is slow, with a spinner, the elapsed time and Cancel, which is drawn only when `onCancel` is set. The ticking number is never in a live region: a screen reader hears the status once, and again when the read turns slow.
- `{ kind: 'canceled', onRetry, allConversations?, labels? }` is what the host sets after Cancel: a neutral state with a primary Retry and, when given, a secondary `allConversations` button. The editor stays open and Send is off, with `sendBlocked` (`Retry to send messages.`) beside it; the composer draws no notice of its own, since the state already says what happened. `ChatInput` takes the same reason on its own as `sendDisabledReason`.
- `{ kind: 'error', cause, detail?, onRetry, allConversations?, labels? }` replaces the transcript and the composer with Cinder's `ErrorState`: the title, the `cause` in plain words, an optional `detail` behind a disclosure, a primary Retry and a secondary `allConversations`.
- `{ kind: 'deleted', allConversations, labels? }` replaces them with a neutral `ErrorState` that says `This conversation was deleted`, with `allConversations` (for example All conversations) as its primary button.
- `{ kind: 'unconfigured', onConnect, labels? }` says a model provider is missing. While the conversation has no message it is an `EmptyState`, `Connect a model provider` with a primary Connect provider, in place of the transcript and the composer. A conversation that has messages keeps them: the transcript stays readable, a waiting approval stays answerable, and only the composer gives way, to one blocked row with the same title and primary action.

`labels` replaces any of the words (`ChatAvailabilityLabels`), and `allConversations` is a `ChatAvailabilityAction`, a label and an `onclick`. The transcript and the composer stay mounted but out of sight while a state shows, so a draft and the scroll position survive, and both come back when `availability` is cleared. For an archived or read-only conversation, whose transcript stays readable, use the neutral `composerStatus` bars above instead.

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
| `availability` | `ChatAvailability` | no | — | Set while the conversation cannot be shown as it is: a `loading` read with skeleton turns, a status line that counts the seconds and Cancel once it is slow; a `canceled` read with Retry; an `error` or a `deleted` conversation drawn with Cinder's `ErrorState` in place of the transcript and the composer. See Availability. |
| `bottomThreshold` | `number` | no | — | Distance in pixels from the bottom of the scroll viewport within which the chat is considered "at bottom" and will auto-scroll on new messages. Default `150`. |
| `class` | `string` | no | — | Additional class name merged onto the outer Chat layout element. |
| `composerAriaActiveDescendant` | `string` | no | — | `aria-activedescendant` passed to the composer textarea for overlays such as slash-command menus. |
| `composerAriaAutocomplete` | `"none"` \| `"inline"` \| `"list"` \| `"both"` | no | — | `aria-autocomplete` passed to the composer textarea for overlays such as slash-command menus. |
| `composerAriaControls` | `string` | no | — | `aria-controls` passed to the composer textarea for overlays such as slash-command menus. |
| `composerAriaExpanded` | `false` \| `true` \| `"true"` \| `"false"` | no | — | `aria-expanded` passed to the composer textarea for overlays such as slash-command menus. |
| `composerRole` | `string` | no | — | Explicit role for the composer textarea, for overlay patterns such as ARIA comboboxes. |
| `composerPlaceholder` | `string` | no | — | The composer's placeholder, such as `Message Tool runner…`. While a question waits on an answer, the answer placeholder replaces it. Default `Type a message…`. |
| `clearComposerOnSubmit` | `boolean` | no | — | Whether Send empties the composer's text and files. Default `true`. Set it to `false` while a host must keep what was typed until the message has gone through, such as the first message of a new conversation that is still being started, and empty the box itself with `clearInput()` once it has. |
| `composerStarting` | `string` | no | — | Set while the host is starting what the message belongs to, such as the conversation its first message opens: Send reads this word with a spinner and is off, there is no Stop because nothing is running yet, and the typed text and files stay in the box. Left out, Send is Send. |
| `composerPlacement` | `"docked"` \| `"centered"` | no | — | Where the composer sits. `'docked'` (default) keeps it at the bottom of the surface under the transcript. `'centered'` puts the empty state, the composer and `composerFooter` together in the middle of the surface while the conversation has no message, and docks the composer as soon as it has one. |
| `composerAnswering` | `boolean` | no | — | Whether the host is showing a question the run waits on, outside Chat's own transcript questions: the composer is then in answer mode and its button reads `Answer`; the placeholder stays the host's `composerPlaceholder`, since only the host knows whether its question draws choices. Chat sets answer mode itself, with its own placeholder, while a question it draws is open in the composer. Default `false`. |
| `disabled` | `boolean` | no | — | Pauses the composer: typing, Send and Enter do nothing, but the editor keeps focus and its text (it is read-only, not disabled), so a draft survives and the composer takes keys again once this clears. A host sets it while the server is unreachable or the chat is disconnected. The composer is also disabled while a reply streams and the adapter has no `sendRunInput`. Default `false`. |
| `questionPlacement` | `"inline"` \| `"docked"` | no | `"inline"` | Where a question that has choices is answered. `'inline'` draws it in the transcript row on fine pointers; coarse-pointer phone layouts dock it automatically so Reply in chat instead and Answer remain explicit. `'docked'` always draws it in place of the composer, with a Needs you warning, a fieldset named Question (its legend is visually hidden), radio cards at least 52 px tall with the keys 1, 2 and 3, Something else, a secondary Reply in chat instead and a primary Answer. See Docked questions. |
| `questionLabels` | `ChatQuestionDockLabels` | no | — | The words of the docked question, any of which the host can replace. |
| `answerInComposer` | `boolean` | no | — | Whether the composer answers an open free-text question. A free-text question then reads "Answer below", the composer's placeholder reads "Answer", and sending from the composer calls `onInputSubmit` with the typed text instead of `onSubmit`. Without it (a reviews inbox, which has no composer) a text field is drawn in the question. Every other kind of question is answered in place either way. Default `false`. |
| `density` | `"comfortable"` \| `"compact"` | no | — | Controls spacing density of the message timeline. - `'comfortable'` (default): standard padding and gap. - `'compact'`: tighter spacing for data-dense contexts (e.g., embedded panels). Action buttons keep `min-height: var(--cinder-touch-target-min)` regardless. |
| `emptyTitle` | `string` | no | — | The title of the default empty state, drawn with the first-use `EmptyState` of Cinder. Has no effect when a custom `empty` snippet is provided. Default `No messages yet`. |
| `emptyDescription` | `string` | no | — | One sentence under the empty state title, such as what the agent does. Has no effect when a custom `empty` snippet is provided. Default none. |
| `emptyPrompts` | `string`[] | no | — | List of suggested starter prompt strings shown as clickable buttons under the default empty state's title. Clicking a prompt submits it immediately as a user message. Has no effect when a custom `empty` snippet is provided. |
| `id` | `string` | yes | — | Unique identifier used to scope accessibility attributes across the chat surface. |
| `jumpThreshold` | `number` | no | — | Distance in pixels scrolled up from the bottom required before the jump-to-latest button appears. Must be greater than `bottomThreshold` to prevent button flickering. Default `200`. |
| `loadEarlierLabel` | `string` | no | — | Label for the history pagination trigger. Default `"Load earlier messages"`. |
| `loadingEarlierLabel` | `string` | no | — | Status text while older messages are loading. Default `"Loading earlier messages"`. |
| `moreHistoryAvailable` | `boolean` | no | — | Whether the explicit "Load earlier messages" trigger is shown when a load handler exists. Default `true`. |
| `newMessageIndicatorVisible` | `boolean` | no | — | Whether the "new messages" indicator is currently visible above the composer. Bindable; cleared automatically when the viewport reaches the bottom. Default `false`. |
| `scrollFadeVisible` | `boolean` | no | — | Show a scroll-driven edge fade on the top and bottom of the message timeline as it overflows. Opt-in and presentation-only — never the sole signal that more messages exist; the jump-to-latest button and unread count remain the authoritative affordances. Only visible when `surfaceMode` is `'default'`: with `surfaceMode="transparent"` the timeline paints no background of its own, so there is no color the fade could correctly fade toward, and it stays inert rather than painting an incorrect opaque band. Default `false`. |
| `sourcePresentation` | `"compact"` \| `"list"` \| `"inline"` | no | — | How a message's Sources control shows its `sourcesByMessageId` entries. `'compact'` (default) opens Cinder's Citation panel; `'list'` is a collapsed disclosure that, opened, lists every source under the message with its excerpt and its link when the address is safe; `'inline'` draws one chip per source that flows like words and reads the source's host, or its label when it has no web address, and opens that source in Citation's panel. Opening a list above the viewport keeps the message the reader is looking at in place. |
| `streaming` | `boolean` | no | — | Whether a streaming response is currently in progress. When `true`, the composer is disabled and a stop-generating button is shown, unless the `adapter` provides `sendRunInput`: then the composer stays enabled, Send and Stop sit side by side, and a submission goes to `adapter.sendRunInput` as a follow-up to the running turn. Default `false`. |
| `streamingStatus` | `string` | no | — | Optional status label displayed in the typing indicator while `streaming` is `true` and no streaming content has arrived yet (e.g. `"Thinking…"` or `"Analyzing file…"`). When omitted, three animated dots are shown. |
| `surfaceMode` | `"default"` \| `"transparent"` | no | — | Controls the background of the chat surface. Use `'transparent'` to inherit the host element's background when embedding chat inside a card or panel. Default `'default'`. |
| `unreadCount` | `number` | no | — | Number of messages received while the viewport was scrolled away from the bottom. Bindable; resets to `0` when the user scrolls to the bottom. Default `0`. |
| `variant` | `"bubble"` \| `"flat"` \| `"transcript"` | no | — | Visual treatment for message bubbles. - `'bubble'` (default): colored backgrounds differentiate user from assistant. - `'flat'`: no bubble backgrounds; role is communicated via alignment and role label. Text-on-surface contrast meets WCAG AA via `--cinder-text-default` on `--cinder-surface-inset`. - `'transcript'`: a reply is plain text with no card or role label, a person's message keeps its tinted bubble, and one muted line under each message carries its time, Copy, Quote and Regenerate (when `onRegenerate` is set) as an icon and a word each, then `messageActions`. A message that was not sent keeps its bubble under a red icon (`notSent`), a follow-up the run has not taken yet is a dashed bubble marked Queued (`onRemoveQueued`), and a run's notes sit outside the bubble (`noteAction`). |
| `virtualizationEstimatedRowHeight` | `number` | no | — | Estimated row height in pixels for virtualized message rows. Default `88`. |
| `virtualizationInitialHeight` | `number` | no | — | Initial virtualized viewport height used before measurement. Default `640`. |
| `virtualizationOverscan` | `number` | no | — | Number of extra virtual rows rendered before and after the viewport. Default `3`. |
| `virtualized` | `boolean` | no | — | Use the virtualized message render path for long transcripts. The complete `ConversationHistory` remains unchanged; only the DOM window is reduced. Default `false`. |
| `adapter` | `(opaque)` | no | — | Optional command/transport boundary around `conversation`. Its methods take precedence over the matching callback props (e.g. `sendMessage` over `onSubmit`); omit it and Chat behaves exactly as with plain callbacks. Not expressible in JSON Schema; see the component types for the signature. |
| `capabilities` | `(opaque)` | no | — | Feature-capability flags. Pass a `ChatCapabilities` object to enable or disable individual Chat features (attachments, search, copy, editing, retry, quote) as a group rather than as six separate boolean props. Not expressible in JSON Schema; see the component types for the signature. |
| `composerActions` | `(opaque)` | no | — | Controls rendered in the composer footer, beside Send. Use it for host-owned controls such as a model `Select`. The snippet takes no arguments, stays interactive while a run streams and while a tool approval is pending, and the caller owns the semantics inside it. When omitted, the composer renders as before. Not expressible in JSON Schema; see the component types for the signature. |
| `composerControls` | `(opaque)` | no | — | Controls at the start of the composer footer, right after the attach button: the host's own selects for the model, effort and permissions. The snippet stays interactive while a run streams; the caller owns the semantics inside it. It is told whether to fold (`folded`): the composer is narrower than `COMPOSER_FOLD_WIDTH`, or the controls with their values in full do not fit beside the meter and Send, so a host can draw one Settings control in place of several selects; the footer never wraps and never cuts a value to a stub. Not expressible in JSON Schema; see the component types for the signature. |
| `composerHeader` | `(opaque)` | no | — | The top row inside the composer's border, above the text: the host's own control for who the message goes to, such as an agent select. The snippet takes no arguments, and the caller owns the semantics inside it. Not expressible in JSON Schema; see the component types for the signature. |
| `composerLead` | `(opaque)` | no | — | Content above the composer, outside its border and at its width, after the transcript: the host's own note on where the conversation comes from, such as a chip that says a new chat was started from another page. It is drawn whether the composer is live or blocked. The snippet takes no arguments, and the caller owns the semantics inside it. Not expressible in JSON Schema; see the component types for the signature. |
| `composerFooter` | `(opaque)` | no | — | Content under the composer, after its hint or status line: the host's own next steps for an empty chat, such as example prompts and other agents to start with. The snippet takes no arguments, and the caller owns the semantics inside it. Not expressible in JSON Schema; see the component types for the signature. |
| `composerHint` | `(opaque)` | no | — | The line of help under the composer while no status shows. Default `Enter to send. Shift and Enter for a new line.`; `false` hides it. Not expressible in JSON Schema; see the component types for the signature. |
| `conversation` | `(opaque)` | yes | — | The conversation transcript to render. Pass a {@link ConversationHistory} snapshot; consumers holding a stateful conversation object pass its current snapshot (e.g. `conversation.current`). Not expressible in JSON Schema; see the component types for the signature. |
| `empty` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `header` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `markdownNode` | `(opaque)` | no | — | Per-node override for fenced code blocks, tables, and Mermaid blocks inside markdown messages. Not expressible in JSON Schema; see the component types for the signature. |
| `messageActions` | `(opaque)` | no | — | Actions rendered for a visible message row. Receives the same {@link ChatRowContext} as `messageStatus` and `row`, including resolved tool pairs and artifact metadata. A tool call drawn in a group of calls is not a message row and gets none; while this is set, a call with an artifact keeps its own row. Not expressible in JSON Schema; see the component types for the signature. |
| `messagePart` | `(opaque)` | no | — | Per-message-part override. Replaces the rendering of an individual body part (markdown, tool call, tool result) while delegating the rest to the built-ins via the `renderDefault` snippet it receives. Image parts are excluded — they render through the grouped attachment grid, not this override. With this set, each tool call keeps its own row so the override sees it; without it, contiguous tool calls draw as one group. Not expressible in JSON Schema; see the component types for the signature. |
| `messageReasoning` | `(opaque)` | no | — | Override or supplement the reasoning text for a message. Called per-message; return a non-empty string or `{ content, summary? }` to show one reasoning body, `undefined` to fall back to `message.metadata['cinder:reasoning']`, or an empty string to suppress reasoning. Not expressible in JSON Schema; see the component types for the signature. |
| `messageStatus` | `(opaque)` | no | — | Status rendered for a visible message row. Receives the same {@link ChatRowContext} as `messageActions` and `row`, including resolved tool pairs and artifact metadata. A tool call drawn in a group of calls is not a message row and gets none. Not expressible in JSON Schema; see the component types for the signature. |
| `messageSteps` | `(opaque)` | no | — | Override or supplement the step list for a message. Called per-message; return an array to show step indicators, `undefined` to fall back to `message.metadata['cinder:steps']`. An empty array suppresses steps. Not expressible in JSON Schema; see the component types for the signature. |
| `messageSuggestions` | `(opaque)` | no | — | Override or supplement the suggestion list for a message. Called per-message; return an array of label strings to show suggestion chips, `undefined` to fall back to `message.metadata['cinder:suggestions']`. An empty array suppresses suggestions. Not expressible in JSON Schema; see the component types for the signature. |
| `messageTurnState` | `(opaque)` | no | — | Where each assistant turn stands, as the host knows it. Return a `ChatTurnState` per assistant message to draw its outcome on the turn: `reconnecting`, `stopped`, `failed` or `empty`; `undefined` leaves the turn streaming while text arrives and complete after. See Run outcomes on the turn. Not expressible in JSON Schema; see the component types for the signature. |
| `onAdapterError` | `(opaque)` | no | — | Called when an adapter command fails — either a rejected promise or a synchronous throw from the method. Not expressible in JSON Schema; see the component types for the signature. |
| `onArtifactOpen` | `(opaque)` | no | — | Overrides Chat's built-in artifact panel. When supplied, Chat calls this once with the resolved artifact and does not open its local panel. Not expressible in JSON Schema; see the component types for the signature. |
| `onContinueTurn` | `(opaque)` | no | — | Called with a stopped turn's id when the person chooses Continue, the primary button beside the Stopped pill. Continue shows only when this is set. Not expressible in JSON Schema; see the component types for the signature. |
| `onDiscardTurn` | `(opaque)` | no | — | Called with a stopped turn's id when the person chooses Discard, the secondary button beside the Stopped pill. The host removes the turn. Discard shows only when this is set. Not expressible in JSON Schema; see the component types for the signature. |
| `onApprovalResolve` | `(opaque)` | no | — | Called when the user resolves an action-required approval. The complete resolution payload is forwarded unchanged. When an adapter is also wired, Chat calls `adapter.resolveToolApproval(toolCallId, resolution)` first and uses this callback only when the adapter does not implement that method. Not expressible in JSON Schema; see the component types for the signature. |
| `onInputSubmit` | `(opaque)` | no | — | Called when the user answers an action-required tool result that requests input. Chat draws the action's JSON Schema as the control that fits it (buttons for a choice, a field for a text, number, date, rating, secret or file, Cinder's `SchemaForm` for an object) and calls this only with an answer that passed validation. A rejected promise keeps the question open so the user can try again; reject with `ChatQuestionAnswerError` to show the host's reasons on the fields they name. Without this callback, Chat shows the request's message but no control. Not expressible in JSON Schema; see the component types for the signature. |
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
| `onRegenerate` | `(opaque)` | no | — | Called with the id of the latest assistant message, once it is finished, when the reader chooses Regenerate. The action is drawn on that message only when this is set; regenerating rewrites the answer and runs no tool again. Not expressible in JSON Schema; see the component types for the signature. |
| `onRetry` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onRetryConnection` | `(opaque)` | no | — | Called with a reconnecting turn's id when the person chooses Retry in its warning. Retry shows only when this is set. Not expressible in JSON Schema; see the component types for the signature. |
| `onRetryStep` | `(opaque)` | no | — | Called with a failed tool call's id when the person chooses Retry under it. The button shows only when this is set; Copy error always shows. Not expressible in JSON Schema; see the component types for the signature. |
| `onRetryTurn` | `(opaque)` | no | — | Called with a failed turn's id when the person chooses Retry in its alert, or an empty turn's when they choose Retry in its row. Each shows only when this is set. Not expressible in JSON Schema; see the component types for the signature. |
| `onRollback` | `(opaque)` | no | — | Commits a confirmed transcript rollback to immediately before the selected user message. Not expressible in JSON Schema; see the component types for the signature. |
| `onScrollStateChange` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onStopGenerating` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onSubmit` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onSuggestionSelect` | `(opaque)` | no | — | Called when the user selects a suggestion chip. The label string is passed back. The consumer is responsible for submitting it as a new user message. Not expressible in JSON Schema; see the component types for the signature. |
| `onTypingChange` | `(opaque)` | no | — | Forwarded from the adapter's real-time `onTypingChange` participant snapshot push. Not expressible in JSON Schema; see the component types for the signature. |
| `onUnreadIndicatorChange` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `pausedReason` | `string` | no | — | Why the composer is paused, as muted text beside Send while `disabled` is set, such as "Off until it’s back" while the server is unreachable. Send's accessible description includes it. Without it the composer pauses with no visible reason. |
| `readReceipts` | `(opaque)` | no | — | Per-message read receipt state. Out-of-band UI state — NOT stored on `Message`. Pass a `Map` keyed by message id with a {@link ReadReceipt} value; the component renders a receipt badge on USER messages only. While defined, including as an empty `Map`, this prop determines the visible receipts instead of adapter-derived state. Adapter events still call `onReadReceipt`, and their derived state may continue accumulating and become visible if this prop later becomes `undefined`. Omit the prop or pass `undefined` to show adapter-derived state. Default `undefined` (no receipts shown until adapter state is available). Not expressible in JSON Schema; see the component types for the signature. |
| `row` | `(opaque)` | no | — | Full-row override. Renders an entire message row; receives the shared row context and a `renderDefault` snippet for the built-in row (inversion of control), so a consumer can wrap or fully replace specific rows. Paired tool results are folded into the visible tool-call row's `toolCallPair`, with validated `cinder:artifact` metadata available as `artifact`. With this set, each tool call keeps its own row so the override sees it, and the host groups them if it wants to; without it, contiguous tool calls draw as one group. Not expressible in JSON Schema; see the component types for the signature. |
| `sourcesByMessageId` | `(opaque)` | no | — | The sources behind assistant messages, keyed by message id, as Cinder `CitationSource` entries in the order to show them. An assistant message with at least one source shows a Sources control; an unknown id, an empty array or a non-assistant message shows none. Sources are presentation only: Chat never writes them to the transcript or an export, never removes duplicates and never fetches them, and only a safe web address becomes a link. Not expressible in JSON Schema; see the component types for the signature. |
| `trailing` | `(opaque)` | no | — | Content drawn as the last item of the transcript, after the final message and the typing indicator, such as the question a run is waiting on. It scrolls with the messages and is not part of the conversation. Not expressible in JSON Schema; see the component types for the signature. |
| `turnLabels` | `(opaque)` | no | — | The words of a turn's outcome and of the steps under it (`ChatTurnLabels`), any of which the host can replace, such as `stepsDone` to read `Checked 2 of 3 sources`. Not expressible in JSON Schema; see the component types for the signature. |
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
