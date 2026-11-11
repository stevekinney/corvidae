<script lang="ts">
  /**
   * One tool source (board PageCapabilities, frames "Sources tab, detail", "A source that needs
   * sign-in", "Source, the ⋯ menu", "Test connection, in flight and failed", "Sources, changing a
   * tool" and "Sources, an OpenAPI source"): its name with its address small and monospaced beside
   * it, the sentence about it, where it stands, and the tools it offers in a table that is always
   * editable.
   *
   * The header holds the actions: Sign in first and primary when the source needs one, then Test
   * connection, then the ⋯ menu (Edit connection, Test connection, Remove source…). A source that
   * fails to read shows its reason with Test connection beside it. Test connection contacts the
   * saved source with what the host holds for it, says what it found or that it did not answer, and
   * leaves the source's standing to the host: the status stays what the host last reported.
   *
   * The tool table has no Edit, Done or Cancel. The On checkbox and the Default asks select save
   * at once, one tool and one setting at a time, and an inline "Saved" appears under the table. The
   * Accepts secrets switch stays in the tool's own cell. A source that needs a sign-in keeps its
   * rows, muted, and says the tools are paused. Each control follows the host's answer once it has
   * been read again, not the click, so a refused change keeps the value the host holds.
   *
   * The panel keys this component by the source, so state held here (a write in flight, a sign-in
   * just done, a test's outcome) never carries over to another source. The page keeps no form over
   * this data, so a refetch never discards anything the person typed.
   */
  import {
    Alert,
    Button,
    Checkbox,
    Dropdown,
    EmptyState,
    SectionHeading,
    Select,
    StatusDot,
    Table,
    Toggle,
    VisuallyHidden,
  } from '@lostgradient/cinder';
  import { Ellipsis } from '@lucide/svelte';
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';

  import { AGENT_PAGE_COPY, CAPABILITIES_COPY } from '../../app/copy.ts';
  import { showFault } from '../../app/toast-host.svelte';
  import {
    authorizeToolSource,
    isToolOn,
    setToolSettings,
    SOURCE_TOOL_APPROVALS,
    testToolSource,
    toolSourceFaultTreatment,
    toolsOnCount,
    type ToolSourceStanding,
    type ToolSourceToolSettings,
  } from '../../lib/host-tool-sources.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import {
    riskLabel,
    sourceHeading,
    sourceStateDescription,
    sourceStateLabel,
    sourceStatusFacts,
    sourceStatusTone,
    sourceToolApproval,
    sourceToolHeading,
    sourceToolTier,
    sourceToolWaitsForRestart,
  } from './capability-presentation.ts';
  import RemoveSourceDialog from './remove-source-dialog.svelte';

  interface Props {
    source: ToolSourceStanding;
    /** Whether the host refuses changes because it keeps its configuration in its deployment. */
    locked: boolean;
  }

  let { source, locked }: Props = $props();

  const copy = CAPABILITIES_COPY.source;
  const queryClient = useQueryClient();

  /** How long a test runs before the page says it is taking longer than usual, as Connect tools does. */
  const SLOW_TEST_MILLISECONDS = 15_000;

  const approvalOptions = SOURCE_TOOL_APPROVALS.map((value) => ({
    value,
    label: AGENT_PAGE_COPY.access.approvals[value],
  }));

  /** The tool names whose setting is being written. */
  let saving = $state<ReadonlySet<string>>(new Set());
  /** Whether the last change to a tool was kept: the inline "Saved" under the table. */
  let saved = $state(false);
  /** The tool table, whose controls Cinder's Toggle cannot mark itself (see below). */
  let toolTable = $state<HTMLElement>();

  // Cinder's Toggle passes no `data-*` attribute on to its button, so the page marks each control
  // itself: the shell holds a marked control while the server does not answer. The spread on each
  // component is what the guard reads (`changing-controls.guard.test.ts`).
  $effect(() => {
    void source.tools.length;
    for (const control of toolTable?.querySelectorAll(
      '[role="switch"], input[type="checkbox"], select, [role="combobox"]',
    ) ?? []) {
      control.setAttribute('data-changes', '');
    }
  });

  const saveTool = createMutation(() => ({
    mutationFn: (change: { readonly tool: string; readonly settings: ToolSourceToolSettings }) =>
      setToolSettings(source.id, { [change.tool]: change.settings }),
    onMutate: (change) => {
      saved = false;
      saving = new Set([...saving, change.tool]);
    },
    onSuccess: () => {
      saved = true;
    },
    onError: (error: unknown) => {
      const treatment = toolSourceFaultTreatment(error);
      showFault({ ...treatment, message: `${copy.tools.saveFailed}. ${treatment.message}` });
    },
    onSettled: async (_data, _error, change) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.toolSources.list() });
      saving = new Set([...saving].filter((tool) => tool !== change.tool));
    },
  }));

  /** What a test found: the tools it listed, a request to sign in, or that the source did not answer. */
  type TestOutcome =
    | { readonly kind: 'passed'; readonly count: number }
    | { readonly kind: 'sign-in' }
    | { readonly kind: 'failed'; readonly message: string; readonly slow: boolean };
  let outcome = $state<TestOutcome>();
  /** Whether the test in flight, or the last one, ran past {@link SLOW_TEST_MILLISECONDS}. */
  let slow = $state(false);

  const testConnection = createMutation(() => ({
    mutationFn: () => testToolSource(source.id),
    onMutate: () => {
      outcome = undefined;
    },
    onSuccess: async (probe) => {
      if (probe.outcome === 'failed') {
        outcome = { kind: 'failed', message: probe.message, slow };
        return;
      }
      outcome =
        probe.outcome === 'listed'
          ? { kind: 'passed', count: probe.tools.length }
          : { kind: 'sign-in' };
      // A test that reached the source moves its last tested time.
      if (probe.outcome === 'listed') {
        await queryClient.invalidateQueries({ queryKey: queryKeys.toolSources.list() });
      }
    },
    onError: (error: unknown) => {
      const treatment = toolSourceFaultTreatment(error);
      showFault({ ...treatment, message: `${copy.test.refused}. ${treatment.message}` });
    },
  }));

  $effect(() => {
    if (!testConnection.isPending) return;
    slow = false;
    // poll-reason: timer
    const handle = setTimeout(() => {
      slow = true;
    }, SLOW_TEST_MILLISECONDS);
    return () => clearTimeout(handle);
  });

  /** The address of the sign-in the host handed out, when the browser did not open it. */
  let signInAddress = $state<string>();
  let signedInNow = $state(false);
  const signIn = createMutation(() => ({
    mutationFn: () => authorizeToolSource(source.id),
    onSuccess: async (authorization) => {
      signInAddress = undefined;
      if (authorization.authorized) {
        signedInNow = true;
        await queryClient.invalidateQueries({ queryKey: queryKeys.toolSources.list() });
        return;
      }
      const opened = window.open(authorization.authorizationUrl, '_blank');
      if (opened === null) signInAddress = authorization.authorizationUrl;
      else opened.opener = null;
    },
    onError: (error: unknown) => {
      const treatment = toolSourceFaultTreatment(error);
      showFault({ ...treatment, message: `${copy.signIn.failed}. ${treatment.message}` });
    },
  }));

  let removing = $state(false);
  const heading = $derived(sourceHeading(source));
  // Stored tokens are not tokens that work: when the server refused them at load, a restart lists
  // nothing until the person signs in again.
  const signedIn = $derived(
    signedInNow || (source.authorized === true && source.tokensRejected !== true),
  );
  // An OAuth source saved since the host started is signed in to before the restart that lists its
  // tools; `authorized` is only present for an OAuth source.
  const signInFirst = $derived(source.state === 'pending-restart' && source.authorized === false);
  const canSignIn = $derived(source.state === 'needs-authorization' || signInFirst);
  /** A source that needs a sign-in keeps its rows, muted and inert, until it has one. */
  const paused = $derived(source.state === 'needs-authorization');
  const stateWords = $derived(
    signInFirst
      ? copy.signIn.savedFirst
      : source.state === 'pending-restart' && source.authorized === true
        ? copy.signIn.signedIn
        : source.state !== 'needs-authorization'
          ? sourceStateDescription(source.state)
          : signedIn
            ? copy.signIn.signedIn
            : source.tokensRejected === true
              ? copy.signIn.rejected
              : sourceStateDescription(source.state),
  );
  // Read again each time the source is, so "last tested 1 h ago" follows a test that just ran.
  const statusFacts = $derived(sourceStatusFacts(source, Date.now()));
  const count = $derived(toolsOnCount(source));
</script>

<article
  class="ib-capability"
  data-testid="source-detail"
  data-source={source.id}
  data-state={source.state}
>
  <div class="ib-source__top">
    <div class="ib-capability__header">
      <h3 class="ib-capability__name" data-testid="source-name">{heading}</h3>
      {#if source.address !== undefined && source.address !== null}
        <code class="ib-capability__code ib-capability__identifier" data-testid="source-address"
          >{source.address}</code
        >
      {/if}
    </div>
    <div class="ib-source__actions">
      {#if canSignIn}
        <Button
          data-changes
          variant="primary"
          size="sm"
          disabled={locked}
          loading={signIn.isPending}
          onclick={() => signIn.mutate()}>{copy.signIn.action}</Button
        >
      {/if}
      {#if source.state !== 'failed'}
        <Button
          data-changes
          variant="secondary"
          size="sm"
          loading={testConnection.isPending}
          onclick={() => testConnection.mutate()}>{copy.test.action}</Button
        >
      {/if}
      <Dropdown id="ib-source-actions" placement="bottom-end">
        <Dropdown.Trigger caretVisible={false}>
          <Ellipsis aria-hidden="true" size={16} />
          <VisuallyHidden>{copy.menu.label}</VisuallyHidden>
        </Dropdown.Trigger>
        <Dropdown.Menu>
          <Dropdown.Item disabled title={copy.menu.editUnavailable}>{copy.menu.edit}</Dropdown.Item>
          <Dropdown.Item data-changes onclick={() => testConnection.mutate()}
            >{copy.menu.test}</Dropdown.Item
          >
          <Dropdown.Item
            data-changes
            variant="danger"
            disabled={locked}
            onclick={() => (removing = true)}>{copy.menu.remove}</Dropdown.Item
          >
        </Dropdown.Menu>
      </Dropdown>
    </div>
  </div>

  {#if source.description !== undefined && source.description !== null && source.description !== ''}
    <p class="ib-capability__prose" data-testid="source-description">{source.description}</p>
  {/if}

  <div class="ib-source__status" data-testid="source-status">
    <StatusDot
      status={sourceStatusTone(source.state)}
      label={sourceStateLabel(source.state)}
      data-testid="source-state"
    />
    <ul class="ib-capability__meta" aria-label={copy.status.label}>
      {#each statusFacts as fact (fact)}
        <li>{fact}</li>
      {/each}
    </ul>
  </div>

  {#if source.state === 'failed'}
    <Alert variant="danger" data-testid="source-failure">
      <p class="ib-capabilities__alert-title">{stateWords}</p>
      {#if source.message !== undefined && source.message !== ''}
        <p class="ib-capability__prose">{source.message}</p>
      {/if}
      <div class="ib-source__sign-in">
        <Button
          data-changes
          variant="secondary"
          size="sm"
          loading={testConnection.isPending}
          onclick={() => testConnection.mutate()}>{copy.test.action}</Button
        >
      </div>
    </Alert>
  {:else}
    <p class="ib-capability__prose" data-testid="source-state-description">{stateWords}</p>
  {/if}

  {#if testConnection.isPending}
    <p class="ib-source__help" role="status" data-testid="test-running">
      {copy.test.testing(heading)}{slow ? ` ${copy.test.slow}` : ''}
    </p>
  {:else if outcome?.kind === 'passed'}
    <p class="ib-source__help" role="status" data-testid="test-passed">
      {copy.test.passed(heading, outcome.count)}
    </p>
  {:else if outcome?.kind === 'sign-in'}
    <p class="ib-source__help" role="status" data-testid="test-sign-in">
      {copy.test.needsAuthorization}
    </p>
  {:else if outcome?.kind === 'failed'}
    <Alert variant="warning" data-testid="test-failed">
      <p class="ib-capabilities__alert-title">{copy.test.failedTitle(heading)}</p>
      <p class="ib-capability__prose">
        {copy.test.failedBody(source.address ?? heading)}
        {outcome.slow ? copy.test.failedSlow : ''}
        {copy.test.toolsKept}
      </p>
      {#if outcome.message !== ''}
        <p class="ib-capability__prose" data-testid="test-failed-reason">{outcome.message}</p>
      {/if}
      <div class="ib-source__sign-in">
        <Button
          data-changes
          variant="ghost"
          size="sm"
          loading={testConnection.isPending}
          onclick={() => testConnection.mutate()}>{copy.test.again}</Button
        >
      </div>
    </Alert>
  {/if}

  {#if locked}
    <p class="ib-source__help" data-testid="source-locked">{copy.tools.locked}</p>
  {/if}

  {#if signInAddress !== undefined}
    <div class="ib-source__sign-in">
      <a href={signInAddress} target="_blank" rel="noopener noreferrer" data-testid="sign-in-link"
        >{copy.signIn.blocked}</a
      >
    </div>
  {/if}

  <section class="ib-capability__section" data-testid="source-tools">
    <SectionHeading level={4} title={copy.tools.heading} />
    {#if source.tools.length === 0}
      <EmptyState
        kind="first-use"
        size="compact"
        headingLevel={5}
        title={copy.tools.empty.title}
        description={copy.tools.empty.description}
      />
    {:else}
      <div
        class="ib-source__table"
        data-paused={paused ? '' : undefined}
        data-testid="source-tool-table"
        bind:this={toolTable}
      >
        <Table caption={copy.tools.caption(heading)} density="comfortable">
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{copy.tools.columns.on}</Table.HeaderCell>
              <Table.HeaderCell>{copy.tools.columns.tool}</Table.HeaderCell>
              <Table.HeaderCell>{copy.tools.columns.risk}</Table.HeaderCell>
              <Table.HeaderCell>{copy.tools.columns.asks}</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each source.tools as tool (tool.name)}
              {@const tier = sourceToolTier(tool)}
              {@const asks = sourceToolApproval(tool)}
              {@const busy = locked || paused || saving.has(tool.tool)}
              <Table.Row data-source-tool={tool.name}>
                <Table.Cell>
                  <Checkbox
                    {...{ 'data-changes': true }}
                    id={`source-${source.id}-${tool.name}-on`}
                    aria-label={copy.tools.onLabel(tool.tool)}
                    checked={isToolOn(tool)}
                    disabled={busy}
                    onValueChangeRequest={(next) => {
                      saveTool.mutate({ tool: tool.tool, settings: { enabled: next } });
                      // The checkbox follows the host once it has been read again, not the click.
                      return isToolOn(tool);
                    }}
                  />
                </Table.Cell>
                <Table.Cell>
                  <div class="ib-source__tool">
                    <span class="ib-capability__header">
                      <a
                        href={router.href(`/capabilities?tool=${encodeURIComponent(tool.name)}`)}
                        aria-label={copy.tools.open(tool.name)}
                        onclick={(event) => {
                          if (
                            event.metaKey ||
                            event.ctrlKey ||
                            event.shiftKey ||
                            event.button !== 0
                          )
                            return;
                          event.preventDefault();
                          router.navigate(`/capabilities?tool=${encodeURIComponent(tool.name)}`);
                        }}>{sourceToolHeading(tool)}</a
                      >
                      <code class="ib-capability__code ib-capability__identifier">{tool.tool}</code>
                    </span>
                    <div class="ib-source__switch">
                      <Toggle
                        {...{ 'data-changes': true }}
                        id={`source-${source.id}-${tool.name}-secrets`}
                        label={copy.tools.acceptsSecretsLabel(tool.tool)}
                        labelVisible={false}
                        checked={tool.savedAcceptsSecrets}
                        disabled={busy}
                        onValueChangeRequest={(next) => {
                          saveTool.mutate({
                            tool: tool.tool,
                            settings: { acceptsSecrets: next },
                          });
                          // The switch follows the host once it has been read again, not the click.
                          // Cinder takes the returned boolean as the value to show, so hand back the
                          // saved one: a refused turn-off must keep reading on.
                          return tool.savedAcceptsSecrets;
                        }}
                      />
                      <span aria-hidden="true">{copy.tools.acceptsSecrets}</span>
                    </div>
                    {#if sourceToolWaitsForRestart(tool)}
                      <p class="ib-source__standing" data-testid="takes-effect">
                        {copy.tools.takesEffect}
                      </p>
                    {/if}
                  </div>
                </Table.Cell>
                <Table.Cell data-testid="tool-risk">{riskLabel(tier)}</Table.Cell>
                <Table.Cell>
                  <Select
                    {...{ 'data-changes': true }}
                    id={`source-${source.id}-${tool.name}-asks`}
                    label={copy.tools.asksLabel(tool.tool)}
                    labelVisible={false}
                    size="sm"
                    options={approvalOptions}
                    value={asks}
                    disabled={busy}
                    onValueChangeRequest={(next) => {
                      saveTool.mutate({ tool: tool.tool, settings: { approval: next } });
                      // As with the switch: the select follows the host's answer.
                      return asks;
                    }}
                  />
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table>
      </div>
      <div class="ib-source__after">
        <p class="ib-source__saved" role="status" data-testid="tools-saved">
          {#if saved}{copy.tools.saved}{/if}
        </p>
        {#if paused}
          <p class="ib-source__help" data-testid="tools-paused">{copy.tools.paused}</p>
        {/if}
        <p class="ib-source__help" data-testid="tools-note">
          {copy.tools.note(count.on, count.total)}
        </p>
        <p class="ib-source__help">{copy.tools.acceptsSecretsHelp}</p>
      </div>
    {/if}
  </section>

  <dl class="ib-capability__facts">
    <div>
      <dt>{copy.facts.credentials}</dt>
      <dd data-testid="source-credentials">
        {#if source.credentials.length === 0}
          {copy.facts.noCredentials}
        {:else}
          <ul class="ib-capability__chips">
            {#each source.credentials as credential (credential)}
              <li class="ib-capability__identifier">{credential}</li>
            {/each}
          </ul>
        {/if}
      </dd>
    </div>
    {#if source.localCommand}
      <div>
        <dt>{copy.facts.localCommand}</dt>
        <dd>{copy.facts.localCommandYes}</dd>
      </div>
    {/if}
  </dl>

  {#if source.skipped.length > 0}
    <section class="ib-capability__section" data-testid="source-skipped">
      <SectionHeading level={4} title={copy.skipped.heading} />
      <ul class="ib-source__notes">
        {#each source.skipped as skipped (skipped.tool)}
          <li class="ib-capability__prose">{copy.skipped.reason(skipped.tool, skipped.reason)}</li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if source.unmatchedSettings.length > 0}
    <Alert variant="warning" data-testid="source-unmatched">
      <p class="ib-capabilities__alert-title">{copy.unmatched.heading}</p>
      <p>{copy.unmatched.description}</p>
      <ul class="ib-source__notes">
        {#each source.unmatchedSettings as unmatched (unmatched.tool)}
          <li class="ib-capability__prose">{unmatched.tool}: {unmatched.message}</li>
        {/each}
      </ul>
    </Alert>
  {/if}
</article>

<RemoveSourceDialog
  id={source.id}
  name={heading}
  open={removing}
  onClose={() => (removing = false)}
  onRemoved={() => {
    removing = false;
    router.navigate('/capabilities?tab=sources');
  }}
/>
