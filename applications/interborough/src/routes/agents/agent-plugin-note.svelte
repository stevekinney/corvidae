<script lang="ts">
  /**
   * The one muted line at the top of a tab's body that says what is true of an agent defined in
   * code or shipped by a plugin: that its changes are saved as versions over its own settings (a
   * running plugin's agent, or a built-in one), that the plugin ships a file the page cannot change,
   * or that the plugin is disabled, so the tab is read-only. It names the plugin by its title, as
   * Settings › Plugins shows it, and is a plain line, never a callout or a banner: the banner over
   * the tabs of an unavailable agent already says why it cannot run.
   */
  import { AGENT_PAGE_COPY } from '../../app/copy/agents.ts';

  interface Props {
    /** The plugin that ships the agent, or `null` for a built-in agent. */
    plugin: string | null;
    /** The plugin's title, which falls back to its identifier before the host has said. */
    title: string;
    /** `editable` saves changes as versions, `read-only` is a plugin's file, `unavailable` a disabled plugin's agent. */
    mode: 'editable' | 'read-only' | 'unavailable';
    /**
     * What the agent states itself that the tab holds as it is, because a change would replace the
     * agent's whole set (`approvals`, `guardrails`); the line says so after its first sentence.
     */
    kept?: readonly string[];
  }

  let { plugin, title, mode, kept = [] }: Props = $props();

  const copy = AGENT_PAGE_COPY;
  const words = $derived(
    mode === 'editable'
      ? [
          copy.plugin.overridable(plugin === null ? null : title),
          ...(kept.length === 0 ? [] : [copy.plugin.overridableKept(kept)]),
        ].join(' ')
      : mode === 'unavailable'
        ? copy.unavailable.readOnly(title)
        : copy.plugin.note(title),
  );
</script>

<p
  class="ib-agent-note"
  data-testid={plugin === null ? 'agent-built-in' : 'agent-plugin-note'}
  data-mode={mode}
>
  {words}
</p>
