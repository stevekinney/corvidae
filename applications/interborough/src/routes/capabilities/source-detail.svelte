<script lang="ts">
  /**
   * One tool source: where it stands, the tools it offers, and for each tool whether it asks first
   * by default (from its tier) and whether it accepts secrets. The Accepts secrets switch is off
   * until the owner turns it on, writes at once, and reads back from the host's saved settings, so
   * a change shows on reload even though the running host loads it at its next start. A source that
   * needs a sign-in has a Sign in button, and any source can be removed after the agents that name
   * its tools are listed.
   *
   * The panel keys this component by the source, so state held here (a write in flight, a sign-in
   * just done) never carries over to another source. The page keeps no form over this data, so a refetch never discards anything the person typed:
   * a switch follows the host's answer once it has been read again, not the click.
   */
  import { Alert, Badge, Button, EmptyState, SectionHeading, Toggle } from '@lostgradient/cinder';
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';

  import { CAPABILITIES_COPY } from '../../app/copy.ts';
  import { showFault } from '../../app/toast-host.svelte';
  import { faultTreatment } from '../../lib/faults.ts';
  import {
    authorizeToolSource,
    setAcceptsSecrets,
    type ToolSourceStanding,
  } from '../../lib/host-tool-sources.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import {
    sourceKindLabel,
    sourceStateDescription,
    sourceStateLabel,
    sourceStateVariant,
    sourceToolStanding,
    sourceToolTier,
    tierLabel,
    tierVariant,
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

  /** The tool names whose setting is being written. */
  let saving = $state<ReadonlySet<string>>(new Set());
  /** The switch row of each tool, which Cinder's Toggle cannot mark itself (see below). */
  let toolList = $state<HTMLElement>();

  // Cinder's Toggle passes no `data-*` attribute on to its button, so the page marks each switch
  // itself: the shell holds a marked control while the server does not answer. The spread on the
  // component is what the guard reads (`changing-controls.guard.test.ts`).
  $effect(() => {
    void source.tools.length;
    for (const control of toolList?.querySelectorAll('[role="switch"]') ?? []) {
      control.setAttribute('data-changes', '');
    }
  });

  const acceptsSecrets = createMutation(() => ({
    mutationFn: (change: { readonly tool: string; readonly next: boolean }) =>
      setAcceptsSecrets(source.id, { [change.tool]: change.next }),
    onMutate: (change) => {
      saving = new Set([...saving, change.tool]);
    },
    onError: (error: unknown) => {
      const treatment = faultTreatment(error);
      showFault({ ...treatment, message: `${copy.tools.saveFailed}. ${treatment.message}` });
    },
    onSettled: async (_data, _error, change) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.toolSources.list() });
      saving = new Set([...saving].filter((tool) => tool !== change.tool));
    },
  }));

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
      const treatment = faultTreatment(error);
      showFault({ ...treatment, message: `${copy.signIn.failed}. ${treatment.message}` });
    },
  }));

  let removing = $state(false);
  const signedIn = $derived(source.authorized === true || signedInNow);
  const stateWords = $derived(
    source.state === 'needs-authorization' && signedIn
      ? copy.signIn.signedIn
      : sourceStateDescription(source.state),
  );
</script>

<article
  class="ib-capability"
  data-testid="source-detail"
  data-source={source.id}
  data-state={source.state}
>
  <h3 class="ib-capability__name ib-capability__identifier">{source.id}</h3>

  <div class="ib-capability__chips">
    <Badge variant="neutral" size="sm">{sourceKindLabel(source)}</Badge>
    <Badge variant={sourceStateVariant(source.state)} size="sm" data-testid="source-state"
      >{sourceStateLabel(source.state)}</Badge
    >
  </div>

  {#if source.state === 'failed'}
    <Alert variant="danger" data-testid="source-failure">
      <p class="ib-capabilities__alert-title">{stateWords}</p>
      {#if source.message !== undefined && source.message !== ''}
        <p class="ib-capability__prose">{source.message}</p>
      {/if}
    </Alert>
  {:else}
    <p class="ib-capability__prose" data-testid="source-state-description">{stateWords}</p>
  {/if}

  {#if source.state === 'needs-authorization'}
    <div class="ib-source__sign-in">
      <Button
        data-changes
        variant="primary"
        size="sm"
        loading={signIn.isPending}
        onclick={() => signIn.mutate()}>{copy.signIn.action}</Button
      >
      {#if signInAddress !== undefined}
        <a href={signInAddress} target="_blank" rel="noopener noreferrer" data-testid="sign-in-link"
          >{copy.signIn.blocked}</a
        >
      {/if}
    </div>
  {/if}

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
      <p class="ib-source__help">{copy.tools.acceptsSecretsHelp}</p>
      {#if locked}
        <p class="ib-source__help">{copy.tools.locked}</p>
      {/if}
      <ul class="ib-source__tools" bind:this={toolList}>
        {#each source.tools as tool (tool.name)}
          {@const tier = sourceToolTier(tool)}
          <li class="ib-source__tool" data-source-tool={tool.name}>
            <div class="ib-source__tool-heading">
              <a
                class="ib-capability__identifier"
                href={router.href(`/capabilities?tool=${encodeURIComponent(tool.name)}`)}
                aria-label={copy.tools.open(tool.name)}
                onclick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
                    return;
                  event.preventDefault();
                  router.navigate(`/capabilities?tool=${encodeURIComponent(tool.name)}`);
                }}>{tool.name}</a
              >
              <Badge variant={tierVariant(tier)} size="sm">{tierLabel(tier)}</Badge>
            </div>
            <p class="ib-source__standing" data-testid="tool-standing">
              {copy.tools.standingLabel}: {copy.tools.standing[sourceToolStanding(tool)]}
            </p>
            <div class="ib-source__switch">
              <Toggle
                {...{ 'data-changes': true }}
                id={`source-${source.id}-${tool.name}-secrets`}
                label={copy.tools.acceptsSecretsLabel(tool.tool)}
                labelVisible={false}
                checked={tool.savedAcceptsSecrets}
                disabled={locked || saving.has(tool.tool)}
                onValueChangeRequest={(next) => {
                  acceptsSecrets.mutate({ tool: tool.tool, next });
                  // The switch follows the host once it has been read again, not the click.
                  return false;
                }}
              />
              <span aria-hidden="true">{copy.tools.acceptsSecrets}</span>
              {#if tool.savedAcceptsSecrets !== tool.acceptsSecrets}
                <Badge variant="info" size="sm" data-testid="takes-effect"
                  >{copy.tools.takesEffect}</Badge
                >
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

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

  <div class="ib-source__remove">
    <Button
      data-changes
      variant="danger"
      size="sm"
      disabled={locked}
      onclick={() => (removing = true)}>{copy.remove.action}</Button
    >
  </div>
</article>

<RemoveSourceDialog
  id={source.id}
  open={removing}
  onClose={() => (removing = false)}
  onRemoved={() => {
    removing = false;
    router.navigate('/capabilities?tab=sources');
  }}
/>
