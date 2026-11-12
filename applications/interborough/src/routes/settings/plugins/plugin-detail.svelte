<script lang="ts">
  /**
   * One plugin (board PageSettingsSections, "Plugins, /settings/plugins", "Demo detail" and
   * "Anthropic detail"): its name and version, what it is, whether it is enabled, where it came from,
   * what it adds under the names a person reads with the identifier beside each, its configuration
   * as a form with an explicit Save, its secrets, and what uses it. A plugin that is switched off
   * says what it holds back; one that needs a key says where the key goes and offers the one action.
   *
   * The switch writes nothing itself: turning a plugin on or off asks first, in a confirmation that
   * says what the restart does, and putting a switch back to what the host stores only drops the
   * page's draft (`plugin-drafts.svelte.ts`). A secret is saved at once, because it needs no restart. A plugin
   * the host requires has no switch.
   */
  import { Button, SectionHeading, StatusDot, Toggle } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { PLUGINS_COPY } from '../../../app/copy/plugins.ts';
  import { listAgentDefinitions } from '../../../lib/agent-definitions.ts';
  import { listSkills } from '../../../lib/bureau-skills.ts';
  import type { PluginProblem, PluginStanding } from '../../../lib/host-plugins.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import PluginConfiguration from './plugin-configuration.svelte';
  import type { PluginDrafts } from './plugin-drafts.svelte.ts';
  import PluginProblemCard from './plugin-problem-card.svelte';
  import { focusConfiguration } from './focus-configuration.ts';
  import {
    contributionGroups,
    heldBackAgents,
    inUseSentence,
    providerOf,
    secretsDirectory,
    sourceKind,
    statusOf,
  } from './plugin-presentation.ts';

  interface Props {
    plugin: PluginStanding;
    drafts: PluginDrafts;
    /** Whether the host keeps its plugin choices and secrets in its deployment. */
    locked: boolean;
    /** Asked when a person turns the plugin off, which needs their say-so first. */
    onDisable: (plugin: PluginStanding) => void;
    /** Asked when a person turns the plugin on, which restarts Interborough and so needs their say-so first. */
    onEnable: (plugin: PluginStanding) => void;
    /**
     * Whether the page lists every plugin's problems above the list, so this plugin does not draw
     * them again.
     */
    problemsListed?: boolean;
    /** Asked when a person adds or replaces one of the plugin's secrets. */
    onSecret: (plugin: PluginStanding, key: string) => void;
    /** Asked when a person adds the key of a model provider's plugin, which is tested before it is saved. */
    onConnect: (provider: string) => void;
    /**
     * What opens the other plugin a name clash is with, or nothing when that plugin is not listed
     * (the host's own options can hold a name too).
     */
    showBoth: (plugin: PluginStanding, problem: PluginProblem) => (() => void) | undefined;
  }

  let {
    plugin,
    drafts,
    locked,
    onDisable,
    onEnable,
    problemsListed = false,
    onSecret,
    onConnect,
    showBoth,
  }: Props = $props();

  const copy = PLUGINS_COPY;
  const name = $derived(plugin.descriptor.name);
  const title = $derived(plugin.descriptor.title);
  const enabled = $derived(drafts.enabledOf(plugin));
  const status = $derived(statusOf(plugin, enabled));
  const running = $derived(plugin.status === 'running');
  const disabled = $derived(plugin.status === 'disabled');
  const provider = $derived(providerOf(plugin));

  // The skills a plugin ships are listed apart from its contributions, and a disabled plugin's
  // agents are the ones the catalog marks unavailable for it; each is read only where it is shown.
  const skills = createQuery(
    () => ({
      queryKey: queryKeys.skills.list(),
      queryFn: ({ signal }) => listSkills({ signal }),
      enabled: running,
      retry: false,
    }),
    undefined,
  );
  const agents = createQuery(
    () => ({
      queryKey: queryKeys.agents.definitions(),
      queryFn: ({ signal }) => listAgentDefinitions({ signal }),
      enabled: disabled,
      retry: false,
    }),
    undefined,
  );

  const groups = $derived(
    contributionGroups(
      plugin,
      (skills.data ?? []).filter((skill) => skill.source.plugin === name),
    ),
  );

  /** The agents the plugin holds back while it is off: its own, with no available agent of the same name. */
  const heldBack = $derived(heldBackAgents(name, agents.data ?? []));

  const inUse = $derived(inUseSentence(plugin));
  /** The problems the page draws as cards here; a missing secret is the Secrets section's to say. */
  const problems = $derived(
    problemsListed ? [] : plugin.problems.filter((problem) => problem.code !== 'secret-missing'),
  );
  /**
   * The secrets a person is shown: all but one the host creates itself (`generated`) that it has not
   * created yet, which it does when the plugin is first enabled and nobody types.
   */
  const secrets = $derived(plugin.secrets.filter((secret) => secret.set || !secret.generated));
  const missingSecret = $derived(secrets.some((secret) => !secret.set));
  const secretDirectory = $derived(secretsDirectory(secrets[0]?.location ?? ''));
  // The status line shows beside the title when it says more than the switch does.
  const showStatus = $derived(
    status.label !== copy.status.running && status.label !== copy.status.disabled,
  );

  /**
   * Turning a plugin on or off is a restart, so it asks first and the switch is held where it is
   * until the question is answered. Putting a switch back to what the host stores, which only a
   * draft left by a restart that did not finish can ask for, just drops the draft.
   */
  function request(next: boolean): boolean {
    if (next === plugin.enabled) {
      drafts.setEnabled(plugin, next);
      return next;
    }
    if (next) onEnable(plugin);
    else onDisable(plugin);
    return enabled;
  }

  function addKey(key: string): void {
    if (provider !== undefined) onConnect(provider);
    else onSecret(plugin, key);
  }
</script>

<article class="ib-plugin" data-plugin-detail={name}>
  <div class="ib-plugin__top">
    <div class="ib-plugin__identity">
      <div class="ib-plugin__name-row">
        <h3 class="ib-plugin__name">{title}</h3>
        <span class="ib-plugin__version">{plugin.descriptor.version}</span>
      </div>
      <p class="ib-plugin__description">{plugin.descriptor.description}</p>
    </div>
    <div class="ib-plugin__controls">
      {#if showStatus}
        <StatusDot status={status.dot} label={status.label} labelVisible />
      {/if}
      {#if plugin.descriptor.required}
        <span class="ib-plugin__always-on">{copy.alwaysOn}</span>
      {:else}
        <Toggle
          id={`plugin-enabled-${name}`}
          label={enabled ? copy.enabled : copy.disabled}
          checked={enabled}
          disabled={locked}
          onValueChangeRequest={request}
        />
      {/if}
    </div>
  </div>

  {#if disabled && heldBack.length > 0}
    <p class="ib-plugin__holding" data-testid="plugin-holding-back">
      <strong>{copy.holdingBack.lead}</strong>
      {copy.holdingBack.body(heldBack, title)}
    </p>
  {/if}
  {#if !plugin.descriptor.required && !enabled}
    <p class="ib-plugin__note">{copy.enableNote}</p>
  {/if}

  {#each problems as problem, index (index)}
    <PluginProblemCard
      {problem}
      {plugin}
      {locked}
      onSecret={(key) => onSecret(plugin, key)}
      onFixSetting={() => focusConfiguration(name)}
      onShowBoth={showBoth(plugin, problem)}
    />
  {/each}

  <p class="ib-plugin__source">
    <span class="ib-plugin__source-term">{copy.sections.source}</span>
    <code class="ib-plugin__source-location">{plugin.location}</code>,
    {sourceKind(plugin.source)}
  </p>

  {#if groups.length > 0}
    <section class="ib-plugin__section" data-testid="plugin-adds">
      <SectionHeading level={4} title={copy.sections.adds} />
      <dl class="ib-plugin__adds">
        {#each groups as group (group.kind)}
          {#each group.items as item, index (item.id)}
            <div class="ib-plugin__add-row" data-contribution={item.id}>
              <dt>{index === 0 ? group.label : ''}</dt>
              <dd>
                <strong class="ib-plugin__add-title">{item.title}</strong>
                <code class="ib-plugin__add-id">{item.id}</code>
              </dd>
            </div>
          {/each}
        {/each}
      </dl>
    </section>
  {/if}

  {#key `${name}:${JSON.stringify(plugin.configuration)}`}
    <PluginConfiguration {plugin} {locked} />
  {/key}

  {#if secrets.length > 0}
    <section class="ib-plugin__section" data-testid="plugin-secrets">
      <SectionHeading level={4} title={copy.sections.secrets} />
      <ul class="ib-plugin__secrets">
        {#each secrets as secret (secret.key)}
          <li class="ib-plugin__secret" data-secret={secret.key}>
            <code class="ib-plugin__secret-key">{secret.key}</code>
            <StatusDot
              status={secret.set ? 'success' : 'neutral'}
              label={secret.set ? copy.secrets.set : copy.secrets.missing}
              labelVisible
              size="sm"
            />
            <Button
              variant={secret.set ? 'secondary' : 'primary'}
              size="sm"
              disabled={locked}
              aria-label={secret.set
                ? copy.secrets.replaceLabel(secret.key)
                : copy.secrets.addLabel(secret.key)}
              onclick={() => (secret.set ? onSecret(plugin, secret.key) : addKey(secret.key))}
              >{secret.set ? copy.secrets.replace : copy.secrets.add}</Button
            >
          </li>
        {/each}
      </ul>
      {#if missingSecret}
        <p class="ib-plugin__note" data-testid="plugin-secret-note">
          {copy.secrets.note(secretDirectory, title, provider !== undefined)}
        </p>
      {/if}
    </section>
  {/if}

  {#if inUse !== undefined}
    <p class="ib-plugin__in-use" data-testid="plugin-in-use">
      <strong>{copy.inUse.lead}</strong>
      {inUse}
    </p>
  {/if}
</article>

<style>
  .ib-plugin {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    min-width: 0;
    padding: var(--cinder-space-4);
  }

  .ib-plugin__top {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--cinder-space-3);
  }

  .ib-plugin__identity {
    flex: 1 1 14rem;
    min-width: 0;
  }

  .ib-plugin__controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-3);
  }

  .ib-plugin__name-row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--cinder-space-2);
  }

  .ib-plugin__name {
    margin: 0;
    font-size: var(--cinder-text-lg);
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .ib-plugin__version {
    color: var(--cinder-text-muted);
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-sm);
  }

  .ib-plugin__always-on {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-plugin__description,
  .ib-plugin__note,
  .ib-plugin__source,
  .ib-plugin__holding,
  .ib-plugin__in-use {
    margin: 0;
  }

  .ib-plugin__description {
    margin-top: var(--cinder-space-1);
  }

  .ib-plugin__note {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-plugin__holding,
  .ib-plugin__in-use {
    padding: var(--cinder-space-2) var(--cinder-space-3);
    border-radius: var(--cinder-radius-md);
    background: var(--cinder-surface-inset);
  }

  .ib-plugin__source-term {
    color: var(--cinder-text-muted);
  }

  .ib-plugin__source-location,
  .ib-plugin__add-id,
  .ib-plugin__secret-key {
    font-family: var(--cinder-font-mono);
    overflow-wrap: anywhere;
  }

  .ib-plugin__section {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .ib-plugin__adds {
    display: flex;
    flex-direction: column;
    margin: 0;
  }

  .ib-plugin__add-row {
    display: grid;
    grid-template-columns: minmax(5rem, 9rem) minmax(0, 1fr);
    gap: var(--cinder-space-2);
    padding: var(--cinder-space-2) 0;
    border-top: 1px solid var(--cinder-border-muted);
  }

  .ib-plugin__add-row dt {
    color: var(--cinder-text-muted);
  }

  .ib-plugin__add-row dd {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
    align-items: baseline;
    margin: 0;
  }

  .ib-plugin__add-id {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-xs);
  }

  .ib-plugin__secrets {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ib-plugin__secret {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-3);
    padding: var(--cinder-space-2) 0;
  }

  .ib-plugin__secret-key {
    flex: 0 1 auto;
    min-width: 0;
  }
</style>
