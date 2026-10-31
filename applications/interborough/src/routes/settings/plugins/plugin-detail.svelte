<script lang="ts">
  /**
   * One plugin: its status and problems, whether it is enabled, where it came from, what it adds and
   * what names it, its configuration, and its secrets. The switch and the configuration edit the
   * page's drafts (`plugin-drafts.svelte.ts`) and write nothing; a secret is saved at once, because
   * it needs no restart. A plugin the host requires has no switch.
   */
  import {
    Alert,
    Badge,
    Button,
    DescriptionList,
    JsonEditor,
    SectionHeading,
    StatusDot,
    Toggle,
  } from '@lostgradient/cinder';

  import { PLUGINS_COPY } from '../../../app/copy.ts';
  import type { PluginStanding } from '../../../lib/host-plugins.ts';
  import {
    contributionGroups,
    inUseSentence,
    sourceKind,
    statusOf,
  } from './plugin-presentation.ts';
  import type { PluginDrafts } from './plugin-drafts.svelte.ts';
  import { problemView } from './plugin-problems.ts';

  interface Props {
    plugin: PluginStanding;
    drafts: PluginDrafts;
    /** Whether the host keeps its plugin choices and secrets in its deployment. */
    locked: boolean;
    /** Asked when a person turns the plugin off, which needs their say-so first. */
    onDisable: (plugin: PluginStanding) => void;
    /** Asked when a person adds or replaces one of the plugin's secrets. */
    onSecret: (plugin: PluginStanding, key: string) => void;
  }

  let { plugin, drafts, locked, onDisable, onSecret }: Props = $props();

  const copy = PLUGINS_COPY;
  const name = $derived(plugin.descriptor.name);
  const enabled = $derived(drafts.enabledOf(plugin));
  const status = $derived(statusOf(plugin, enabled));
  const groups = $derived(contributionGroups(plugin));
  const invalid = $derived(drafts.invalid(plugin));

  /** Turning on stages the change; turning off asks first, so the switch is held where it is. */
  function request(next: boolean): boolean {
    if (next) {
      drafts.setEnabled(plugin, true);
      return true;
    }
    onDisable(plugin);
    return enabled;
  }
</script>

<article class="ib-plugin" data-plugin-detail={name}>
  <div class="ib-plugin__top">
    <div class="ib-plugin__identity">
      <div class="ib-plugin__name-row">
        <h3 class="ib-plugin__name">{name}</h3>
        <span class="ib-plugin__version">{plugin.descriptor.version}</span>
      </div>
      <p class="ib-plugin__description">{plugin.descriptor.description}</p>
    </div>
    {#if plugin.descriptor.required}
      <span class="ib-plugin__always-on">{copy.alwaysOn}</span>
    {:else}
      <Toggle
        id={`plugin-enabled-${name}`}
        label={copy.enabled}
        checked={enabled}
        disabled={locked}
        onValueChangeRequest={request}
      />
    {/if}
  </div>

  <div class="ib-plugin__status">
    <StatusDot status={status.dot} label={status.label} labelVisible />
  </div>

  {#each plugin.problems as problem, index (index)}
    {@const view = problemView(problem)}
    <Alert variant="warning" data-plugin-problem={problem.code}>
      <p class="ib-plugin__problem-title">{view.title}</p>
      <p class="ib-plugin__problem-body">{view.body}</p>
      {#if view.secretKey !== undefined && view.secretKey !== ''}
        {@const key = view.secretKey}
        <Button
          data-changes
          variant="secondary"
          size="sm"
          disabled={locked}
          onclick={() => onSecret(plugin, key)}>{copy.problems.secretMissing.action}</Button
        >
      {/if}
    </Alert>
  {/each}

  <DescriptionList
    items={[
      { term: copy.sections.source, definition: plugin.location },
      { term: copy.sections.kind, definition: sourceKind(plugin.source) },
    ]}
  />

  <section class="ib-plugin__section">
    <SectionHeading level={4} title={copy.sections.adds} />
    {#if groups.length === 0}
      <p class="ib-plugin__prose">{copy.sections.nothingAdded}</p>
    {:else}
      <dl class="ib-plugin__adds">
        {#each groups as group (group.kind)}
          <div class="ib-plugin__add-row">
            <dt>{group.label}</dt>
            <dd>
              {#each group.ids as id (id)}
                <Badge variant="neutral" size="sm">{id}</Badge>
              {/each}
            </dd>
          </div>
        {/each}
      </dl>
    {/if}
  </section>

  <section class="ib-plugin__section">
    <SectionHeading level={4} title={copy.sections.configuration} />
    <JsonEditor
      id={`plugin-configuration-${name}`}
      label={copy.configuration.label(name)}
      description={copy.configuration.description}
      value={drafts.configurationOf(plugin)}
      error={invalid === 'syntax'
        ? copy.configuration.invalid
        : invalid === 'shape'
          ? copy.configuration.notAnObject
          : ''}
      readonly={locked}
      rows={6}
      onValueChange={(text) => drafts.setConfiguration(plugin, text)}
    />
  </section>

  {#if plugin.secrets.length > 0}
    <section class="ib-plugin__section">
      <SectionHeading level={4} title={copy.sections.secrets} />
      <ul class="ib-plugin__secrets">
        {#each plugin.secrets as secret (secret.key)}
          <li class="ib-plugin__secret" data-secret={secret.key}>
            <code class="ib-plugin__secret-key">{secret.key}</code>
            <StatusDot
              status={secret.set ? 'success' : 'danger'}
              label={secret.set ? copy.secrets.set : copy.secrets.missing}
              labelVisible
            />
            <Button
              data-changes
              variant="secondary"
              size="sm"
              disabled={locked}
              aria-label={secret.set
                ? copy.secrets.replaceLabel(secret.key)
                : copy.secrets.addLabel(secret.key)}
              onclick={() => onSecret(plugin, secret.key)}
              >{secret.set ? copy.secrets.replace : copy.secrets.add}</Button
            >
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <section class="ib-plugin__section">
    <SectionHeading level={4} title={copy.sections.inUse} />
    <p class="ib-plugin__prose">{inUseSentence(plugin)}</p>
  </section>
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

  .ib-plugin__name-row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--cinder-space-2);
  }

  .ib-plugin__name {
    margin: 0;
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-lg);
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .ib-plugin__version,
  .ib-plugin__always-on {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-plugin__description,
  .ib-plugin__prose,
  .ib-plugin__problem-title,
  .ib-plugin__problem-body {
    margin: 0;
  }

  .ib-plugin__description {
    margin-top: var(--cinder-space-1);
  }

  .ib-plugin__problem-title {
    font-weight: 600;
  }

  .ib-plugin__problem-body {
    margin: var(--cinder-space-1) 0 var(--cinder-space-2);
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
    grid-template-columns: minmax(6rem, 9rem) minmax(0, 1fr);
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
    gap: var(--cinder-space-1);
    margin: 0;
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
    border-top: 1px solid var(--cinder-border-muted);
  }

  .ib-plugin__secret-key {
    flex: 1 1 10rem;
    min-width: 0;
    overflow-wrap: anywhere;
  }
</style>
