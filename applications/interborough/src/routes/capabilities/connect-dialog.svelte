<script lang="ts">
  /**
   * Connect a tool source: an MCP server (a URL or a command on this machine, with a bearer token or
   * an OAuth sign-in) or an OpenAPI service (a URL or a file, a base URL, a bearer token or an API
   * key). Test connection contacts the source before anything is saved
   * (`POST /host/tool-sources/<id>/probe`) and says what it lists or why it did not answer;
   * Connect saves it (`PUT /host/tool-sources/<id>`), and the host lists its tools when it starts
   * again.
   *
   * The form belongs to this dialog and to nothing the page reads, so a refetch of the sources never
   * touches it. What the page knows that the form depends on is whether the name is taken, and
   * Connect reads the list again before it saves, so a source another tab saved under the same name
   * in the meantime is reported with the form intact instead of being replaced.
   *
   * A token or key lives in its field until the request is built and is cleared when the dialog
   * closes. It is never put in a message: the host words a refusal in terms of the field, and a probe
   * answers in words that hold no address, command or value.
   */
  import { Alert, Badge, Button, Input, Modal, RadioGroup, Textarea } from '@lostgradient/cinder';
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';

  import { CAPABILITIES_COPY } from '../../app/copy.ts';
  import { showToast } from '../../app/toast-host.svelte';
  import {
    connectToolSource,
    getToolSources,
    HostToolSourceError,
    probeToolSource,
    toolSourceFaultTreatment,
    type ToolSourceProbe,
  } from '../../lib/host-tool-sources.ts';
  import { queryKeys } from '../../lib/query.ts';
  import {
    authenticationChoices,
    buildToolSourceRequest,
    effectiveAuthentication,
    EMPTY_TOOL_SOURCE_FORM,
    fieldOfHostField,
    MAXIMUM_SPECIFICATION_BYTES,
    type ToolSourceForm,
    type ToolSourceFormField,
  } from '../../lib/tool-source-form.ts';
  import { sourceToolTier, tierLabel, tierVariant } from './capability-presentation.ts';

  interface Props {
    /** The names of the sources already saved, which a new one may not repeat. */
    existing: readonly string[];
    onClose: () => void;
    /** Called with the name of the source once the host has saved it. */
    onConnected: (id: string) => void;
  }

  let { existing, onClose, onConnected }: Props = $props();

  const copy = CAPABILITIES_COPY.source.connect;
  const queryClient = useQueryClient();

  // The radio groups hold plain strings; `form` narrows them.
  let kind = $state('mcp');
  let id = $state('');
  let transport = $state('http');
  let url = $state('');
  let command = $state('');
  let args = $state('');
  let specification = $state('url');
  let specificationUrl = $state('');
  let documentText = $state('');
  let fileName = $state('');
  let fileError = $state('');
  let baseUrl = $state('');
  let authentication = $state('none');
  let secret = $state('');
  let header = $state('');

  /** Whether Connect or Test connection was pressed, which is when empty fields are named. */
  let submitted = $state(false);
  /** A field the host refused, with its words. Cleared by the next change to the form. */
  let hostError = $state<{ readonly field: ToolSourceFormField; readonly message: string }>();
  /** What the host said when it refused the request as a whole. */
  let failure = $state('');
  /** What the last test found, and the request it was made for. */
  let tested = $state<{ readonly signature: string; readonly probe: ToolSourceProbe }>();

  const form: ToolSourceForm = $derived({
    ...EMPTY_TOOL_SOURCE_FORM,
    kind: kind === 'openapi' ? 'openapi' : 'mcp',
    id,
    transport: transport === 'stdio' ? 'stdio' : 'http',
    url,
    command,
    args,
    specification: specification === 'file' ? 'file' : 'url',
    specificationUrl,
    document: documentText,
    baseUrl,
    authentication:
      authentication === 'bearer' || authentication === 'oauth' || authentication === 'api-key'
        ? authentication
        : 'none',
    secret,
    header,
  });
  const choices = $derived(authenticationChoices(form));
  const activeAuthentication = $derived(effectiveAuthentication(form));
  const built = $derived(buildToolSourceRequest(form));
  const signature = $derived('request' in built ? JSON.stringify(built.request) : '');
  const taken = $derived(id.trim() !== '' && existing.includes(id.trim()));
  const fileTooLarge = $derived(fileError !== '');

  /** The words under a field: the host's refusal, then what is missing once the person has tried. */
  function errorOf(field: ToolSourceFormField): string {
    if (hostError?.field === field) return hostError.message;
    if (field === 'id' && taken) return copy.exists(id.trim());
    if (field === 'document' && fileError !== '') return fileError;
    return submitted && 'errors' in built ? (built.errors[field] ?? '') : '';
  }

  // Any change to the form makes the host's refusal and the last test stale.
  $effect(() => {
    void JSON.stringify(form);
    hostError = undefined;
    failure = '';
  });

  const currentProbe = $derived(tested?.signature === signature ? tested.probe : undefined);

  class SourceExistsError extends Error {}

  const test = createMutation(() => ({
    mutationFn: ({ name, request }: Ready) => probeToolSource(name, request),
    onSuccess: (probe, ready) => {
      tested = { signature: JSON.stringify(ready.request), probe };
    },
    onError: (error: unknown, ready) => refuse(error, ready.name, copy.probe.failed),
  }));

  const connect = createMutation(() => ({
    mutationFn: async ({ name, request }: Ready) => {
      // Read again, so a source saved elsewhere since this page listed them is not replaced.
      const latest = await getToolSources();
      if (latest.sources.some((source) => source.id === name)) throw new SourceExistsError();
      return connectToolSource(name, request);
    },
    onSuccess: async (_change, ready) => {
      showToast(copy.connected(ready.name));
      await queryClient.invalidateQueries({ queryKey: queryKeys.toolSources.list() });
      onConnected(ready.name);
    },
    onError: async (error: unknown, ready) => {
      if (error instanceof SourceExistsError) {
        hostError = { field: 'id', message: copy.exists(ready.name) };
        await queryClient.invalidateQueries({ queryKey: queryKeys.toolSources.list() });
        return;
      }
      refuse(error, ready.name, copy.failed);
    },
  }));

  type Ready = {
    readonly name: string;
    readonly request: Extract<typeof built, { request: unknown }>['request'];
  };

  /** Puts a refusal where it belongs: under the field the host named, or in words for the whole request. */
  function refuse(error: unknown, name: string, lead: string): void {
    const treatment = toolSourceFaultTreatment(error);
    const field =
      error instanceof HostToolSourceError && error.kind === 'invalid' && error.field !== undefined
        ? fieldOfHostField(error.field, form)
        : undefined;
    if (field !== undefined && treatment.message !== '') {
      hostError = { field, message: treatment.message };
      return;
    }
    failure = `${lead}. ${treatment.message}`;
    void name;
  }

  /** The request, when the form can make one and the name is free; otherwise the fields are named. */
  function ready(): Ready | undefined {
    submitted = true;
    if (!('request' in built) || taken) return undefined;
    return { name: built.id, request: built.request };
  }

  function runTest(): void {
    const target = ready();
    if (target !== undefined) test.mutate(target);
  }

  function runConnect(): void {
    const target = ready();
    if (target !== undefined) connect.mutate(target);
  }

  /** Reads the OpenAPI file the person chose; a file too large for the host is refused here. */
  async function chooseFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    fileError = '';
    if (file === undefined) {
      documentText = '';
      fileName = '';
      return;
    }
    fileName = file.name;
    if (file.size > MAXIMUM_SPECIFICATION_BYTES) {
      documentText = '';
      fileError = copy.file.tooLarge;
      return;
    }
    try {
      documentText = await file.text();
    } catch {
      documentText = '';
      fileError = copy.file.unreadable;
    }
  }

  const busy = $derived(test.isPending || connect.isPending);

  function close(): void {
    if (busy) return;
    onClose();
  }
</script>

<Modal
  open
  title={copy.title}
  onDismiss={close}
  dismissOnEscape={!busy}
  dismissOnBackdropClick={!busy}
>
  {#snippet children()}
    <form
      class="ib-connect"
      data-testid="connect-form"
      novalidate
      onsubmit={(event) => {
        event.preventDefault();
        runConnect();
      }}
    >
      <p class="ib-connect__lead">{copy.intro}</p>

      <RadioGroup name="connect-kind" label={copy.kind.label} bind:value={kind} disabled={busy}>
        <RadioGroup.Option id="connect-kind-mcp" value="mcp" label={copy.kind.mcp} />
        <RadioGroup.Option id="connect-kind-openapi" value="openapi" label={copy.kind.openapi} />
      </RadioGroup>

      <Input
        id="connect-id"
        label={copy.id.label}
        description={copy.id.description}
        placeholder={copy.id.placeholder}
        autocomplete="off"
        spellcheck={false}
        variant="code"
        bind:value={id}
        error={errorOf('id')}
        disabled={busy}
      />

      {#if form.kind === 'mcp'}
        <RadioGroup
          name="connect-transport"
          label={copy.transport.label}
          bind:value={transport}
          disabled={busy}
        >
          <RadioGroup.Option id="connect-transport-http" value="http" label={copy.transport.http} />
          <RadioGroup.Option
            id="connect-transport-stdio"
            value="stdio"
            label={copy.transport.stdio}
          />
        </RadioGroup>
        {#if form.transport === 'http'}
          <Input
            id="connect-url"
            type="url"
            label={copy.url.label}
            description={copy.url.description}
            placeholder={copy.url.placeholder}
            autocomplete="off"
            spellcheck={false}
            variant="code"
            bind:value={url}
            error={errorOf('url')}
            disabled={busy}
          />
        {:else}
          <Input
            id="connect-command"
            label={copy.command.label}
            description={copy.command.description}
            placeholder={copy.command.placeholder}
            autocomplete="off"
            spellcheck={false}
            variant="code"
            bind:value={command}
            error={errorOf('command')}
            disabled={busy}
          />
          <Textarea
            id="connect-args"
            label={copy.args.label}
            description={copy.args.description}
            spellcheck={false}
            rows={3}
            bind:value={args}
            disabled={busy}
          />
        {/if}
      {:else}
        <RadioGroup
          name="connect-specification"
          label={copy.specification.label}
          bind:value={specification}
          disabled={busy}
        >
          <RadioGroup.Option
            id="connect-specification-url"
            value="url"
            label={copy.specification.url}
          />
          <RadioGroup.Option
            id="connect-specification-file"
            value="file"
            label={copy.specification.file}
          />
        </RadioGroup>
        {#if form.specification === 'url'}
          <Input
            id="connect-specification-address"
            type="url"
            label={copy.specificationUrl.label}
            description={copy.specificationUrl.description}
            placeholder={copy.specificationUrl.placeholder}
            autocomplete="off"
            spellcheck={false}
            variant="code"
            bind:value={specificationUrl}
            error={errorOf('specificationUrl')}
            disabled={busy}
          />
        {:else}
          <div class="ib-connect__file">
            <label for="connect-file">{copy.file.label}</label>
            <input
              id="connect-file"
              type="file"
              accept=".json,application/json"
              disabled={busy}
              aria-invalid={errorOf('document') !== '' || fileTooLarge}
              aria-describedby="connect-file-help"
              onchange={(event) => void chooseFile(event)}
            />
            <p id="connect-file-help" class="ib-connect__help">
              {#if errorOf('document') !== ''}
                <span class="ib-connect__error" data-testid="connect-file-error"
                  >{errorOf('document')}</span
                >
              {:else if fileName !== ''}
                {copy.file.chosen(fileName)}
              {:else}
                {copy.file.description}
              {/if}
            </p>
          </div>
        {/if}
        <Input
          id="connect-base-url"
          type="url"
          label={copy.baseUrl.label}
          description={copy.baseUrl.description}
          placeholder={copy.baseUrl.placeholder}
          autocomplete="off"
          spellcheck={false}
          variant="code"
          bind:value={baseUrl}
          error={errorOf('baseUrl')}
          disabled={busy}
        />
      {/if}

      {#if choices.length > 1}
        <RadioGroup
          name="connect-authentication"
          label={copy.authentication.label}
          bind:value={authentication}
          disabled={busy}
        >
          {#each choices as choice (choice)}
            <RadioGroup.Option
              id={`connect-authentication-${choice}`}
              value={choice}
              label={copy.authentication[choice]}
            />
          {/each}
        </RadioGroup>
      {/if}
      {#if activeAuthentication === 'oauth'}
        <p class="ib-connect__help">{copy.authentication.oauthHelp}</p>
      {:else if activeAuthentication === 'bearer' || activeAuthentication === 'api-key'}
        {#if activeAuthentication === 'api-key'}
          <Input
            id="connect-header"
            label={copy.header.label}
            description={copy.header.description}
            placeholder={copy.header.placeholder}
            autocomplete="off"
            spellcheck={false}
            variant="code"
            bind:value={header}
            error={errorOf('header')}
            disabled={busy}
          />
        {/if}
        <Input
          id="connect-secret"
          type="password"
          label={copy.secret[activeAuthentication].label}
          description={copy.secret.description}
          autocomplete="off"
          spellcheck={false}
          variant="code"
          bind:value={secret}
          error={errorOf('secret')}
          disabled={busy}
        />
      {/if}

      <div class="ib-connect__result" aria-live="polite" data-testid="connect-result">
        {#if currentProbe?.outcome === 'listed'}
          <p class="ib-connect__help" data-testid="connect-listed">
            {copy.probe.listed(currentProbe.tools.length)}
          </p>
          {#if currentProbe.tools.length > 0}
            <ul class="ib-connect__tools" aria-label={copy.probe.toolsLabel}>
              {#each currentProbe.tools as tool (tool.name)}
                <li class="ib-connect__tool" data-probe-tool={tool.name}>
                  <span class="ib-capability__identifier">{tool.name}</span>
                  <Badge variant={tierVariant(sourceToolTier(tool))} size="sm"
                    >{tierLabel(sourceToolTier(tool))}</Badge
                  >
                </li>
              {/each}
            </ul>
          {/if}
          {#if currentProbe.skipped.length > 0}
            <p class="ib-connect__help">{copy.probe.skipped(currentProbe.skipped.length)}</p>
          {/if}
        {:else if currentProbe?.outcome === 'needs-authorization'}
          <Alert variant="info" data-testid="connect-needs-authorization">
            <p>{copy.probe.needsAuthorization}</p>
          </Alert>
        {:else if currentProbe?.outcome === 'failed'}
          <Alert variant="danger" data-testid="connect-probe-failed">
            <p class="ib-capabilities__alert-title">{copy.probe.failedTitle}</p>
            <p class="ib-connect__reason" data-testid="connect-probe-reason">
              {currentProbe.message}
            </p>
          </Alert>
        {/if}
        {#if failure !== ''}
          <Alert variant="danger" data-testid="connect-failure">
            <p class="ib-connect__reason">{failure}</p>
          </Alert>
        {/if}
      </div>
    </form>
  {/snippet}
  {#snippet footer()}
    <Button variant="secondary" onclick={close} disabled={busy}>{copy.actions.cancel}</Button>
    <Button
      data-changes
      variant="secondary"
      loading={test.isPending}
      disabled={connect.isPending}
      onclick={runTest}>{copy.probe.action}</Button
    >
    <Button
      data-changes
      variant="primary"
      loading={connect.isPending}
      disabled={test.isPending}
      onclick={runConnect}>{copy.actions.connect}</Button
    >
  {/snippet}
</Modal>

<style>
  .ib-connect {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-connect__lead,
  .ib-connect__help,
  .ib-connect__reason {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .ib-connect__help {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-connect__error {
    color: var(--cinder-text-danger);
  }

  .ib-connect__file {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    min-width: 0;
  }

  .ib-connect__file input {
    max-inline-size: 100%;
  }

  .ib-connect__result {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .ib-connect__tools {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ib-connect__tool {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-2);
    padding: var(--cinder-space-1) 0;
    border-top: 1px solid var(--cinder-border-muted);
    overflow-wrap: anywhere;
  }
</style>
