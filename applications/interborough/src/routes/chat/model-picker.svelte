<script lang="ts">
  /**
   * The model picker in a session's composer: the models the session's agent allows
   * (`bureau.agents.models`), with the one the session runs on selected. The session's own model
   * (`bureau.contexts.get`'s `model`) wins; a session never switched runs on the agent's default.
   * The model is always shown: an agent that allows one model, or none, gets the picker disabled on
   * that model (or on "Agent default"), because a single model is no choice but is still the answer
   * to which model this chat runs on.
   *
   * Choosing a model asks the Bureau to switch the session (`bureau.contexts.steer`) with the
   * `configVersion` the page last read as `expectedRevision`, and the new model is used from the
   * live run's next step, or by the next run of an idle chat. The choice is shown at once and stays
   * until the Bureau has answered; how each answer ends is `steer-change.ts`'s, with the words of
   * `CHAT_COPY.modelPicker`.
   */
  import { Select } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { CHAT_COPY } from '../../app/copy.ts';
  import { getAgentModels, steerContext, type AgentModelChoice } from '../../lib/bureau-client.ts';
  import { createPendingCommandKey } from '../../lib/pending-command-key.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { agentModel } from './agent-model.ts';
  import { changeSetting, type SteerNotices } from './steer-change.ts';

  type ModelName = { readonly provider: string | null; readonly model: string };

  interface ModelPickerProps {
    sessionId: string;
    agentName: string;
    /** The model the session was switched to, `null` before any switch, `undefined` until it is read. */
    current: ModelName | null | undefined;
    /** The session's `configVersion`, `undefined` until it is read. */
    revision: number | undefined;
    /** Reads the session again, and says whether it could. */
    reload: () => Promise<boolean>;
    /** Whether another setting of the session is being changed, which takes no second change. */
    locked?: boolean;
    /** Called as a change starts and as it ends, so the other settings wait for the new revision. */
    onBusyChange?: (busy: boolean) => void;
    /** Called when the Bureau took a switch. */
    onApplied?: () => void;
  }

  let {
    sessionId,
    agentName,
    current,
    revision,
    reload,
    locked = false,
    onBusyChange,
    onApplied,
  }: ModelPickerProps = $props();

  const COPY = CHAT_COPY.modelPicker;

  const models = createQuery(
    () => ({
      queryKey: queryKeys.agents.models(agentName),
      queryFn: ({ signal }) => getAgentModels(agentName, { signal }),
      retry: false,
    }),
    undefined,
  );
  const choices = $derived(models.data?.models ?? []);

  /** A model as an option's value. Neither a provider nor a model name holds a newline. */
  const keyOf = (name: { readonly provider: string | null; readonly model: string }): string =>
    `${name.provider ?? ''}\n${name.model}`;

  /** The listed choice `name` stands for. A name that carries no provider matches any provider's. */
  function listed(name: ModelName): AgentModelChoice | undefined {
    return choices.find(
      (choice) =>
        choice.model === name.model &&
        (name.provider === null || choice.provider === name.provider),
    );
  }

  const known = $derived(current ?? agentModel(models.data));
  const knownKey = $derived.by(() => {
    if (known === null) return '';
    const choice = listed(known);
    return choice === undefined ? keyOf(known) : keyOf(choice);
  });

  /**
   * The choice on screen until the page has what the Bureau settled on: from the choice until the
   * answer, and for an admitted choice until the session has been read again. `undefined` when the
   * session's own model is what shows.
   */
  let pending = $state<string | undefined>(undefined);
  /** Whether a switch is waiting on the Bureau, which takes no second choice. */
  let busy = $state(false);
  let notice = $state<string | undefined>(undefined);
  const commands = createPendingCommandKey();

  const shown = $derived(pending ?? knownKey);

  const options = $derived([
    // A session with no model of its own, on an agent that names no default, has nothing to show.
    ...(knownKey === '' && pending === undefined
      ? [{ value: '', label: COPY.agentDefault, disabled: true }]
      : []),
    // The model the session runs on may no longer be one the agent lists.
    ...(known !== null && listed(known) === undefined
      ? [{ value: keyOf(known), label: known.model, disabled: true }]
      : []),
    // A model the agent's cost budget cannot count is shown, so the person sees why it is missing.
    ...choices.map((choice) => ({
      value: keyOf(choice),
      label:
        choice.unpriced === true ? `${choice.displayName} (${COPY.unpriced})` : choice.displayName,
      ...(choice.unpriced === true ? { disabled: true } : {}),
    })),
  ]);

  /** The picker's refusals, in the words of a model. */
  const NOTICES: SteerNotices = {
    staleRevision: COPY.staleRevision,
    denied: COPY.modelNotAllowed,
    sessionTerminal: COPY.sessionTerminal,
    unsupportedCapability: COPY.unsupportedCapability,
    notChanged: COPY.notSwitched,
    fault: COPY.fault,
  };

  async function choose(next: string): Promise<void> {
    const choice = choices.find((entry) => keyOf(entry) === next);
    if (choice === undefined || next === shown || revision === undefined) return;
    pending = next;
    busy = true;
    onBusyChange?.(true);
    notice = undefined;
    try {
      const result = await changeSetting({
        commands,
        scope: sessionId,
        content: next,
        send: (commandId) =>
          steerContext({
            contextId: sessionId,
            commandId,
            override: { provider: choice.provider, model: choice.model },
            expectedRevision: revision,
          }),
        reload,
        notices: NOTICES,
      });
      notice = result.notice;
      // Until the session is read again the admitted choice stays on screen.
      if (!result.applied || result.reloaded) pending = undefined;
      if (result.applied) onApplied?.();
    } finally {
      busy = false;
      onBusyChange?.(false);
    }
  }
</script>

<Select
  data-changes
  id="weft-chat-model"
  class="weft-chat-model"
  label={COPY.label}
  labelVisible={false}
  {options}
  value={shown}
  onchange={(event) => void choose(event.currentTarget.value)}
  disabled={busy || locked || revision === undefined || choices.length < 2}
  {...notice === undefined ? {} : { error: notice }}
/>
