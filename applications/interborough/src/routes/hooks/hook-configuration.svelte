<script lang="ts">
  /**
   * The configuration of a hook that runs a plugin's action (COR-2181, rows R10-08 and R10-10 to
   * R10-16): the fields of the action's schema, drawn by Cinder's `SchemaForm`. A field marked
   * `secret: true` is a Select of the secret keys plugins declare (`GET /host/plugins`, the list
   * Settings › Plugins › Secrets shows), grouped by plugin title and noted Set or Missing, and the
   * hook keeps `{ "$secret": key }` and never a value. A key that is Missing offers Add the key,
   * which opens the same dialog Settings does; when the keys cannot be read, the field says so and
   * offers Try again while the other fields stay usable. A default hook's configuration is the same
   * form read only: label and value pairs, a secret as its key beside a Set or Missing dot.
   */
  import type { SchemaFormSecrets } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import ContributedConfigurationForm from '../../lib/contributed-configuration-form.svelte';
  import { getPlugins } from '../../lib/host-plugins.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { routerSelectionLocationFor } from '../../lib/router-selection-location.ts';
  import { router } from '../../lib/router.svelte.ts';
  import SecretDialog, { type SecretTarget } from '../settings/plugins/secret-dialog.svelte';
  import { HOOKS_COPY } from './hook-copy.ts';

  interface Props {
    /** Names the kind, so the form starts over when the kind is another. */
    kindId: string;
    /** The kind's configuration schema, or `null` when it could not be written as one. */
    schema: Readonly<Record<string, unknown>> | null;
    /** The configuration the form starts with. */
    value?: unknown;
    /** Takes the configuration after each edit. */
    onChange?: (value: Record<string, unknown>) => void;
    /** Whether the configuration is shown and not changed. */
    readOnly?: boolean;
    /** Problems the Bureau found at a field of the configuration, shown on that field. */
    issues?: readonly { path: readonly (string | number)[]; message: string }[] | undefined;
    /** Whether every control is held, as while the hook is saved. */
    disabled?: boolean;
    /** The plugin whose action this is: the link to where a key is saved opens it in Settings. */
    plugin?: string | undefined;
    /**
     * Whether the draft the form shows at mount is reported as the configuration. Off for a stored
     * configuration the form cannot draw, so opening the hook does not replace it.
     */
    reportInitialDraft?: boolean;
  }

  let {
    kindId,
    schema,
    value,
    onChange = () => undefined,
    readOnly = false,
    issues,
    disabled = false,
    plugin,
    reportInitialDraft = true,
  }: Props = $props();

  const copy = HOOKS_COPY.secrets;
  /** Settings › Plugins, with this action's plugin selected when it is known. */
  const pluginSettings = routerSelectionLocationFor('/settings/plugins');
  const settingsPath = $derived(
    plugin === undefined ? '/settings/plugins' : pluginSettings.pathTo('plugin', plugin),
  );

  // The plugins the host loaded: where the secret keys, and what groups them, come from.
  const plugins = createQuery(
    () => ({
      queryKey: queryKeys.hostPlugins(),
      queryFn: ({ signal }: { signal: AbortSignal }) => getPlugins({ signal }),
      retry: false,
    }),
    undefined,
  );

  /** The key the Add the key dialog is for, or `null` while it is closed. */
  let adding = $state<SecretTarget | null>(null);

  const secrets = $derived.by((): SchemaFormSecrets => {
    const listed = plugins.data?.plugins ?? [];
    return {
      keys: listed.flatMap((loaded) =>
        loaded.secrets.map((secret) => ({
          key: secret.key,
          group: loaded.descriptor.title,
          set: secret.set,
        })),
      ),
      status: plugins.isError ? 'failed' : 'ready',
      copy: {
        help: copy.help,
        placeholder: copy.placeholder,
        emptyPlaceholder: copy.emptyPlaceholder,
        emptyHelp: copy.emptyHelp,
        emptyHelpEnd: copy.emptyHelpEnd,
        failed: copy.failed,
        retry: copy.retry,
        missing: copy.missing,
        addKey: copy.addKey,
      },
      onRetry: () => void plugins.refetch(),
      onAdd: (key) => {
        const owner = listed.find((loaded) => loaded.secrets.some((secret) => secret.key === key));
        if (owner !== undefined) adding = { plugin: owner.descriptor.name, key };
      },
      manage: {
        label: copy.manage,
        href: router.href(settingsPath),
      },
    };
  });
</script>

<ContributedConfigurationForm
  {kindId}
  {schema}
  {value}
  {onChange}
  {readOnly}
  {issues}
  {disabled}
  {secrets}
  {reportInitialDraft}
/>
<SecretDialog bind:target={adding} />
