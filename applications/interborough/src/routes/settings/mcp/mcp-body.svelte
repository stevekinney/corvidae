<script lang="ts">
  /**
   * The body of Settings › MCP (COR-2539): the address of Interborough's MCP endpoint, then the
   * configuration that registers it with Claude Code and the one any other MCP client reads. The
   * address is the origin this page was served from, since that is the one the person reached the
   * host at, plus `/bureau/mcp`. Every shape comes from `src/lib/mcp-connection.ts`, the functions
   * `interborough mcp`, the start lines and the Claude Code smoke test also use. Nothing here is a
   * setting. The endpoint's authentication depends on the host-resolved principal. The restart
   * notice every section shares sits above it.
   */
  import { CodeBlock, CopyableValue, FormSection, Link } from '@lostgradient/cinder';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { MCP_COPY } from '../../../app/copy/mcp.ts';
  import { SETTINGS_SECTION_COPY } from '../../../app/copy/settings.ts';
  import type { SettingsSchema, SettingsSnapshot } from '../../../lib/bureau-settings.ts';
  import { getClient } from '../../../lib/client.ts';
  import { codeHighlighter } from '../../../lib/code-highlighter.ts';
  import { mcpConnection } from '../../../lib/mcp-connection.ts';
  import { getPrincipalStore } from '../../../lib/scopes.svelte.ts';
  import { discoveryOrigin } from '../../system/discovery-client.ts';
  import SettingsRestartNotice from '../settings-restart-notice.svelte';
  import { SettingsSession } from '../settings-session.svelte.ts';

  interface Props {
    schema: SettingsSchema;
    snapshot: SettingsSnapshot;
  }

  let { schema, snapshot }: Props = $props();

  const copy = MCP_COPY;
  const connection = mcpConnection(discoveryOrigin(getClient()));
  const loginCommand = ['claude', 'mcp', 'login', connection.name].join(' ');
  const principal = getPrincipalStore();
  const shared = $derived(principal.principal?.method === 'browser-session');

  // The page edits no setting, but, like every section, its restart notice counts, reverts and
  // restarts the ones saved elsewhere.
  const session = new SettingsSession({
    schema: untrack(() => schema),
    snapshot: () => snapshot,
    queryClient: useQueryClient(),
  });
</script>

<SettingsRestartNotice
  keys={session.restartKeys}
  {snapshot}
  flow={session.restartFlow}
  revert={session.revert}
  saving={session.autosave.busy}
/>

<div class="ib-mcp" role="group" aria-label={copy.groupLabel}>
  <!-- Three sections of one kind: one heading size, one description style, one column. -->
  <FormSection
    columns={1}
    heading={copy.endpoint.heading}
    description={shared ? copy.endpoint.sharedDescription : copy.endpoint.description}
  >
    <div class="ib-mcp__address">
      <CopyableValue
        value={connection.endpoint}
        label={copy.endpoint.copy}
        copiedLabel={copy.endpoint.copied}
        data-testid="mcp-endpoint"
      />
    </div>
    <div>
      <Link href="/settings/connected-apps" variant="more" data-velveteen-reload
        >{SETTINGS_SECTION_COPY.connectedApps}</Link
      >
    </div>
  </FormSection>

  <FormSection
    columns={1}
    heading={copy.claudeCode.heading}
    description={shared ? copy.claudeCode.sharedDescription : copy.claudeCode.description}
  >
    <div class="ib-mcp__code" data-testid="mcp-claude-code">
      <CodeBlock
        code={shared
          ? `${connection.claudeCode.command}\n${loginCommand}`
          : connection.claudeCode.command}
        copyLabel={copy.claudeCode.copy}
        copyable
        wrap
      />
    </div>
  </FormSection>

  <FormSection columns={1} heading={copy.generic.heading}>
    {#snippet descriptionContent()}{copy.generic.description.before}<code
        >{copy.generic.description.file}</code
      >{shared ? copy.generic.description.sharedAfter : copy.generic.description.after}{/snippet}
    <div class="ib-mcp__code" data-testid="mcp-generic">
      <CodeBlock
        code={connection.generic.text}
        language="json"
        highlighter={codeHighlighter}
        languageLabelVisible={false}
        copyLabel={copy.generic.copy}
        copyable
        wrap
      />
    </div>
  </FormSection>
</div>

<style>
  .ib-mcp {
    grid-area: content;
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-8);
    max-inline-size: var(--ib-settings-content-width);
    min-inline-size: 0;
  }

  .ib-mcp__code {
    min-inline-size: 0;
  }

  .ib-mcp__address {
    inline-size: 100%;
    min-inline-size: 0;
    font-size: var(--cinder-text-sm);
  }
</style>
