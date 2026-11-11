<script lang="ts">
  /**
   * A saved agent's model on the Edit form (row 41u): read-only text, the model's name and its
   * provider's, with "Change it on the Settings tab; a saved agent's model is saved there" under
   * it and the Settings tab a link. The Edit form owns identity and instructions, so there is no
   * select. A model that is not offered now (turned off, forbidden by the model policy, retired, or
   * gone from the catalog) says so in a warning under the line, in the words of what a save does
   * with it: the Bureau keeps one that is only turned off, and refuses the rest.
   */
  import { Alert } from '@lostgradient/cinder';

  import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
  import { agentTabPath } from '../../lib/agent-paths.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { modelDisplayName, providerDisplayName } from '../settings/models/format-model.ts';
  import { followInApp } from './agent-editor-links.ts';
  import type { ModelUnavailableReason } from './agent-editor-models.ts';
  import type { AgentEditorState } from './agent-editor-state.svelte.ts';

  interface Props {
    editor: AgentEditorState;
    /** The saved agent's identifier, for the link to its Settings tab. */
    agentId: string;
  }

  let { editor, agentId }: Props = $props();

  const copy = AGENT_EDITOR_COPY.edit.model;
  const settingsPath = $derived(agentTabPath(agentId, 'settings'));
  const chosen = $derived(editor.chosenModel);

  /** What a save does with the agent's own model decides which notice is shown. */
  function noticeFor(reason: ModelUnavailableReason): (model: string, reason: string) => string {
    switch (reason) {
      case 'provider-denied':
      case 'model-denied':
        return copy.refusedNotice;
      case 'retired':
      case 'not-in-catalog':
        return copy.replacementNotice;
      case 'turned-off':
        return copy.keptNotice;
    }
  }

  /** Why the agent's own model is not offered now, in words, or `undefined` when it is. */
  const notice = $derived(
    chosen?.unavailable === undefined
      ? undefined
      : noticeFor(chosen.unavailable)(
          chosen.value,
          AGENT_EDITOR_COPY.model.reasons[chosen.unavailable],
        ),
  );
</script>

<div class="weft-agent-saved-model" data-testid="agent-saved-model">
  {#if chosen !== undefined}
    <p class="weft-agent-saved-model__value" data-testid="agent-saved-model-value">
      {copy.value(modelDisplayName(chosen.model), providerDisplayName(chosen.provider))}
    </p>
  {/if}
  <p class="weft-agent-saved-model__note">
    {copy.changeLead}<a
      href={router.href(settingsPath)}
      onclick={(event) => followInApp(event, settingsPath)}>{copy.settingsTab}</a
    >{copy.changeTail}
  </p>
  {#if notice !== undefined}
    <Alert variant="warning" data-testid="agent-model-notice">{notice}</Alert>
  {/if}
</div>

<style>
  .weft-agent-saved-model {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-inline-size: 0;
  }

  .weft-agent-saved-model__value {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .weft-agent-saved-model__note {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }
</style>
