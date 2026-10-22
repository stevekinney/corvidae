<script lang="ts">
  /**
   * The model picker in a session's composer: the models the session's agent allows
   * (`bureau.agents.models`), with the one the session runs on selected. The session's own model
   * (`bureau.contexts.get`'s `model`) wins; a session never switched runs on the agent's default.
   * It is hidden unless the agent allows more than one model, because a single model is no choice.
   *
   * Choosing a model asks the Bureau to switch the session (`bureau.contexts.steer`) with the
   * `configVersion` the page last read as `expectedRevision`, and the new model is used from the
   * session's next step. The choice is shown at once and stays until the Bureau has answered:
   *
   * - Admitted, including an exact replay of the same command: the choice stands, and the session is
   *   read again so the page agrees with the Bureau.
   * - Refused because the session changed since it was read: the session is read again and the
   *   picker shows the model it has now.
   * - Any other refusal: the previous selection comes back. Each says why in its own words
   *   (`CHAT_COPY.modelPicker`).
   * - A fault: nobody knows whether the Bureau took the switch, so the session is read again and
   *   the picker shows the model it has now.
   *
   * A command keeps its identifier until the Bureau answers it, so a retry after a fault is the same
   * command and the Bureau does not apply it twice (`pending-command-key.ts`).
   */
  import { Select } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { CHAT_COPY } from '../../app/copy.ts';
  import {
    getAgentModels,
    steerContext,
    type AgentModelChoice,
    type SteerOutcome,
  } from '../../lib/bureau-client.ts';
  import { createPendingCommandKey } from '../../lib/pending-command-key.ts';
  import { queryKeys } from '../../lib/query.ts';

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
  }

  let { sessionId, agentName, current, revision, reload }: ModelPickerProps = $props();

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

  const known = $derived(current ?? models.data?.default ?? null);
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
    ...choices.map((choice) => ({ value: keyOf(choice), label: choice.displayName })),
  ]);

  /** What a refusal says, in its own words. */
  function refusalNotice(outcome: SteerOutcome): string {
    switch (outcome.outcome) {
      case 'rejected':
        switch (outcome.failure.reason) {
          case 'stale-revision':
            return COPY.staleRevision;
          case 'model-not-allowed':
          case 'policy-denied':
            return COPY.modelNotAllowed;
          case 'session-terminal':
            return COPY.sessionTerminal;
          default:
            return COPY.notSwitched;
        }
      case 'session-terminal':
        return COPY.sessionTerminal;
      case 'unsupported-capability':
        return COPY.unsupportedCapability;
      default:
        return COPY.notSwitched;
    }
  }

  async function choose(next: string): Promise<void> {
    const choice = choices.find((entry) => keyOf(entry) === next);
    if (choice === undefined || next === shown || revision === undefined) return;
    pending = next;
    busy = true;
    notice = undefined;
    try {
      const outcome = await steerContext({
        contextId: sessionId,
        commandId: commands.keyFor(sessionId, next),
        override: { provider: choice.provider, model: choice.model },
        expectedRevision: revision,
      });
      // The Bureau answered, so the command is settled whatever it said.
      commands.confirmed();
      if (outcome.outcome === 'accepted' || outcome.outcome === 'replayed') {
        // Until the session is read again the admitted choice stays on screen.
        if (await reload()) pending = undefined;
        return;
      }
      notice = refusalNotice(outcome);
      if (outcome.outcome === 'rejected' && outcome.failure.reason === 'stale-revision') {
        await reload();
      }
      pending = undefined;
    } catch {
      // Nobody knows whether the Bureau took it, so the command keeps its identifier for a retry,
      // and the session is read again to show the model it has now.
      notice = COPY.fault;
      await reload();
      pending = undefined;
    } finally {
      busy = false;
    }
  }
</script>

{#if choices.length > 1}
  <Select
    id="weft-chat-model"
    class="weft-chat-model"
    label={COPY.label}
    labelVisible={false}
    {options}
    value={shown}
    onchange={(event) => void choose(event.currentTarget.value)}
    disabled={busy || revision === undefined}
    {...notice === undefined ? {} : { error: notice }}
  />
{/if}
