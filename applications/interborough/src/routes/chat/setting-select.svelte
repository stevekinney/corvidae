<script lang="ts">
  /**
   * A select for one setting of a session that `bureau.contexts.steer` changes: the reasoning
   * effort and the permission mode (the model has its own picker, which lists what the agent
   * allows). The setting the session has is selected, `null` meaning none was ever set (the agent's
   * own), and a choice is shown at once and stays until the Bureau has answered; how each answer
   * ends is `steer-change.ts`'s. The request carries the `configVersion` the page last read, so a
   * session changed somewhere else is refused and read again.
   *
   * It is a ghost listbox select inside the composer: no border or fill at rest, the setting's name
   * in muted words before its value ("Effort Medium"), and a help line under an option that has one.
   *
   * A new chat has no session to change yet, so with `draft` a choice only goes to `onDraft`: the
   * page keeps it, passes it back as `current`, and applies it once the session exists.
   *
   * Every setting of a session shares one revision, so while one of them is being changed the
   * others wait (`locked`): a second change sent before the first is read back would be refused as
   * stale and silently undone.
   */
  import { Select } from '@lostgradient/cinder';

  import type { SteerOutcome } from '../../lib/bureau-client.ts';
  import { createPendingCommandKey } from '../../lib/pending-command-key.ts';
  import { changeSetting, type SteerNotices } from './steer-change.ts';

  interface SettingSelectProps {
    sessionId: string;
    id: string;
    /** The control's accessible name. */
    label: string;
    options: readonly {
      readonly value: string;
      readonly label: string;
      /** The help line drawn under the option in the list. */
      readonly description?: string;
    }[];
    /** What the session has: `null` before any was set, `undefined` until the session is read. */
    current: string | null | undefined;
    /** What the select says while `current` is `null`; a setting that always has a value names none. */
    unsetLabel?: string;
    /** The session's `configVersion`, `undefined` until it is read. */
    revision: number | undefined;
    /** Sends the change of this setting to `value`, under the command and the revision it is given. */
    send: (value: string, commandId: string, revision: number) => Promise<SteerOutcome>;
    notices: SteerNotices;
    /** Reads the session again, and says whether it could. */
    reload: () => Promise<boolean>;
    /** Whether another setting of the session is being changed. */
    locked: boolean;
    /** Why this principal cannot change the chat's settings, when the page knows; it disables the select. */
    unavailable?: string | undefined;
    /** Called as a change starts and as it ends. */
    onBusyChange: (busy: boolean) => void;
    /** Called when the Bureau took a change, with the words of the option it took. */
    onApplied: (label: string) => void;
    /** The chat has no session yet: a choice is handed to `onDraft` instead of being sent. */
    draft?: boolean;
    /** Called with the option's value when a choice is made on a chat that has no session yet. */
    onDraft?: ((value: string) => void) | undefined;
  }

  let {
    sessionId,
    id,
    label,
    options,
    current,
    unsetLabel,
    revision,
    send,
    notices,
    reload,
    locked,
    unavailable,
    onBusyChange,
    onApplied,
    draft = false,
    onDraft,
  }: SettingSelectProps = $props();

  /** The choice on screen until the page has what the Bureau settled on; see `model-picker.svelte`. */
  let pending = $state<string | undefined>(undefined);
  let busy = $state(false);
  let notice = $state<string | undefined>(undefined);
  const commands = createPendingCommandKey();

  // Until the session is read there is nothing to select, which is no value, not an empty one.
  // A listbox takes an empty value for no selection, so the agent's own setting has a value of its own.
  const UNSET = 'agent-default';
  const shown = $derived(pending ?? (current === undefined ? undefined : (current ?? UNSET)));
  const shownOptions = $derived([
    ...(current === null && pending === undefined && unsetLabel !== undefined
      ? [{ value: UNSET, label: unsetLabel, disabled: true }]
      : []),
    ...options,
  ]);

  async function choose(next: string): Promise<void> {
    if (next === shown || !options.some((entry) => entry.value === next)) return;
    if (draft) {
      onDraft?.(next);
      return;
    }
    if (revision === undefined) return;
    pending = next;
    busy = true;
    onBusyChange(true);
    notice = undefined;
    try {
      const result = await changeSetting({
        commands,
        scope: sessionId,
        content: next,
        send: (commandId) => send(next, commandId, revision),
        reload,
        notices,
      });
      notice = result.notice;
      if (!result.applied || result.reloaded) pending = undefined;
      if (result.applied) onApplied(options.find((entry) => entry.value === next)?.label ?? next);
    } finally {
      busy = false;
      onBusyChange(false);
    }
  }
</script>

<Select
  data-changes
  {id}
  class="weft-chat-setting"
  {label}
  labelVisible={false}
  valuePrefix={label}
  variant="ghost"
  presentation="listbox"
  size="sm"
  options={shownOptions}
  {...shown === undefined ? {} : { value: shown }}
  onValueChange={(next) => void choose(next)}
  disabled={busy || locked || unavailable !== undefined || (revision === undefined && !draft)}
  title={unavailable}
  {...notice === undefined ? {} : { error: notice }}
/>
