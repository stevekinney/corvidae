<script lang="ts">
  /**
   * `/capabilities/connect`: connect a tool source, as a page under Capabilities and not a dialog
   * (design rows 33a to 33d). The breadcrumb reads "Capabilities › Connect tools" and is the way
   * back; there is no back link. The page is the reading column (`kind: 'form'`, 720px) with the
   * title inside it, and its sections run Source, Address, Sign in, Test connection, Choose tools,
   * with the footer docked below them.
   *
   * A source is an MCP server, reached by URL or by a command on this machine, or an OpenAPI
   * service. A person names it ("GitHub"); the identifier it is saved under is made from the name
   * (`toolSourceIdentifier`). Test connection contacts the source before anything is saved
   * (`POST /host/tool-sources/<id>/probe`) and says what it lists or why it did not answer; Connect
   * tests it first when no test has passed for what the form holds, then saves it
   * (`PUT /host/tool-sources/<id>`), and opens it in Capabilities › Sources.
   *
   * Connect asks the host to add the source only if the name is free (`create`), so a source another
   * tab saved under the same name in the meantime is reported with the form intact instead of being
   * replaced.
   *
   * A token or key lives in its field and in the request being sent. TanStack keeps the variables
   * of a mutation until the mutation is collected, so both mutations here are collected as soon as
   * the page stops observing them (`gcTime: 0`) and the secret does not outlive the page. It is
   * never put in a message: the host words a refusal in terms of the field, and a probe answers in
   * words that hold no address, command or value.
   *
   * Signing in with OAuth before the source is saved needs a host operation that does not exist yet
   * (the host signs in to a saved source only), so an OAuth source is connected first and signed in
   * to from its page, as the line under the choice says.
   */
  import {
    Alert,
    Badge,
    Button,
    Callout,
    FormActions,
    FormSection,
    Input,
    PageHeader,
    RadioGroup,
    Segment,
    SegmentedControl,
  } from '@lostgradient/cinder';
  import { TriangleAlert } from '@lucide/svelte';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';

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
  import { router } from '../../lib/router.svelte.ts';
  import {
    authenticationChoices,
    buildToolSourceRequest,
    effectiveAuthentication,
    EMPTY_TOOL_SOURCE_FORM,
    fieldOfHostField,
    MAXIMUM_SPECIFICATION_BYTES,
    toolSourceIdentifier,
    type ToolSourceForm,
    type ToolSourceFormField,
  } from '../../lib/tool-source-form.ts';
  import { sourceToolTier, tierLabel, tierVariant } from './capability-presentation.ts';

  const copy = CAPABILITIES_COPY.source.connect;
  const SOURCES_PATH = '/capabilities?tab=sources';
  const queryClient = useQueryClient();

  // The same key and options as the Sources tab's query, so a list already read is not read again.
  const sources = createQuery(
    () => ({
      queryKey: queryKeys.toolSources.list(),
      queryFn: ({ signal }) => getToolSources({ signal }),
      retry: false,
    }),
    undefined,
  );
  const existing = $derived((sources.data?.sources ?? []).map((source) => source.id));
  const locked = $derived(sources.data?.lockReason !== undefined);

  // The radio groups and the segmented control hold plain strings; `form` narrows them.
  let kind = $state('mcp');
  let name = $state('');
  let transport = $state('http');
  let url = $state('');
  let command = $state('');
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
    id: toolSourceIdentifier(name),
    name,
    transport: transport === 'stdio' ? 'stdio' : 'http',
    url,
    command,
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
  const taken = $derived(form.id !== '' && existing.includes(form.id));
  const fileTooLarge = $derived(fileError !== '');

  /**
   * The words under a field: the host's refusal, then what is missing once the person has tried.
   * The identifier is made from the name, so what is wrong with it is said under Name.
   */
  function errorOf(field: ToolSourceFormField): string {
    if (hostError?.field === field) return hostError.message;
    if (field === 'id' && taken) return copy.exists(form.id);
    if (field === 'document' && fileError !== '') return fileError;
    return submitted && 'errors' in built ? (built.errors[field] ?? '') : '';
  }

  // Any change to the form makes the host's refusal stale; the last test is kept with the request
  // it was made for, and is read only while the form still makes that request.
  $effect(() => {
    void JSON.stringify(form);
    hostError = undefined;
    failure = '';
  });

  const currentProbe = $derived(tested?.signature === signature ? tested.probe : undefined);
  /** A test that found the source there: it listed its tools, or asked for the sign-in that follows connecting. */
  const passed = $derived(
    currentProbe?.outcome === 'listed' || currentProbe?.outcome === 'needs-authorization',
  );

  type Ready = {
    readonly name: string;
    readonly request: Extract<typeof built, { request: unknown }>['request'];
  };

  const test = createMutation(() => ({
    gcTime: 0,
    mutationFn: ({ name: id, request }: Ready) => probeToolSource(id, request),
    onSuccess: (probe, ready) => {
      tested = { signature: JSON.stringify(ready.request), probe };
    },
    onError: (error: unknown) => refuse(error, copy.probe.failed),
  }));

  const connect = createMutation(() => ({
    gcTime: 0,
    // `create`: the host refuses a name another tab saved since this page listed the sources.
    mutationFn: ({ name: id, request }: Ready) =>
      connectToolSource(id, { ...request, create: true }),
    onSuccess: async (change, ready) => {
      const shown = ready.request.name ?? ready.name;
      showToast(change.restartRequired ? copy.connected(shown) : copy.connectedNow(shown));
      await queryClient.invalidateQueries({ queryKey: queryKeys.toolSources.list() });
      router.navigate(`${SOURCES_PATH}&source=${encodeURIComponent(ready.name)}`);
    },
    onError: async (error: unknown, ready) => {
      if (error instanceof HostToolSourceError && error.kind === 'exists') {
        hostError = { field: 'id', message: copy.exists(ready.name) };
        await queryClient.invalidateQueries({ queryKey: queryKeys.toolSources.list() });
        return;
      }
      refuse(error, copy.failed);
    },
  }));

  /** Puts a refusal where it belongs: under the field the host named, or in words for the whole request. */
  function refuse(error: unknown, lead: string): void {
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
  }

  /** The request, when the form can make one and the name is free; otherwise the fields are named. */
  function requestToSend(): Ready | undefined {
    submitted = true;
    if (!('request' in built) || taken || locked) return undefined;
    return { name: built.id, request: built.request };
  }

  function runTest(): void {
    const target = requestToSend();
    if (target !== undefined) test.mutate(target);
  }

  /** Connects what the form holds, testing it first when no test has passed for it (row 33r). */
  function runConnect(): void {
    const target = requestToSend();
    if (target === undefined) return;
    if (passed) {
      connect.mutate(target);
      return;
    }
    test.mutate(target, {
      onSuccess: (probe: ToolSourceProbe) => {
        if (probe.outcome !== 'failed') connect.mutate(target);
      },
    });
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

  function cancel(): void {
    router.navigate(SOURCES_PATH);
  }
</script>

<section class="ib-connect" data-page="connect-tools">
  <PageHeader title={copy.title} description={copy.intro} headingLevel={1} />

  {#if locked}
    <Alert variant="info" data-testid="connect-locked">
      <p class="ib-connect__reason">{copy.locked}</p>
    </Alert>
  {/if}

  <form
    class="ib-connect__form"
    data-testid="connect-form"
    novalidate
    onsubmit={(event) => {
      event.preventDefault();
      runConnect();
    }}
  >
    <FormSection heading={copy.sections.source} columns={1}>
      <RadioGroup name="connect-kind" label={copy.kind.label} bind:value={kind} disabled={busy}>
        <RadioGroup.Option id="connect-kind-mcp" value="mcp" label={copy.kind.mcp} />
        <RadioGroup.Option id="connect-kind-openapi" value="openapi" label={copy.kind.openapi} />
      </RadioGroup>
    </FormSection>

    <FormSection heading={copy.sections.address} columns={1}>
      {#if form.kind === 'mcp'}
        <SegmentedControl
          id="connect-transport"
          label={copy.transport.label}
          value={transport}
          disabled={busy}
          onValueChange={(next: string) => (transport = next)}
        >
          <Segment value="http">{copy.transport.http}</Segment>
          <Segment value="stdio">{copy.transport.stdio}</Segment>
        </SegmentedControl>
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
            required
            bind:value={url}
            error={errorOf('url')}
            disabled={busy}
          />
        {:else}
          <Input
            id="connect-command"
            label={copy.command.label}
            placeholder={copy.command.placeholder}
            autocomplete="off"
            spellcheck={false}
            variant="code"
            required
            bind:value={command}
            error={errorOf('command')}
            disabled={busy}
          />
          <Callout
            variant="warning"
            semantic="note"
            aria-label={copy.command.warningLabel}
            data-testid="connect-command-warning"
          >
            {#snippet icon()}<TriangleAlert size={16} aria-hidden="true" />{/snippet}
            <p class="ib-connect__reason">
              {copy.command.warningBefore}<code class="ib-connect__code"
                >{copy.command.warningCode}</code
              >{copy.command.warningAfter}
            </p>
          </Callout>
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
            required
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
      <Input
        id="connect-name"
        label={copy.name.label}
        description={copy.name.description}
        placeholder={copy.name.placeholder}
        autocomplete="off"
        required
        bind:value={name}
        error={errorOf('id')}
        disabled={busy}
      />
    </FormSection>

    {#if choices.length > 1}
      <FormSection heading={copy.sections.signIn} columns={1}>
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
              {...choice === 'oauth' ? { description: copy.authentication.oauthNote } : {}}
            />
          {/each}
        </RadioGroup>
        {#if activeAuthentication === 'oauth'}
          <p class="ib-connect__help" data-testid="connect-oauth-help">
            {copy.authentication.oauthHelp}
          </p>
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
              required
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
            required
            bind:value={secret}
            error={errorOf('secret')}
            disabled={busy}
          />
        {/if}
      </FormSection>
    {/if}

    <FormSection heading={copy.sections.test} columns={1}>
      <div class="ib-connect__test">
        <Button
          data-changes
          variant="secondary"
          loading={test.isPending}
          disabled={connect.isPending || locked}
          onclick={runTest}>{copy.probe.action}</Button
        >
      </div>
      <div class="ib-connect__result" aria-live="polite" data-testid="connect-result">
        {#if currentProbe?.outcome === 'listed'}
          <p class="ib-connect__help" data-testid="connect-listed">
            {copy.probe.listed(currentProbe.tools.length)}
          </p>
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
    </FormSection>

    <FormSection heading={copy.sections.chooseTools} columns={1}>
      {#if currentProbe?.outcome === 'listed' && currentProbe.tools.length > 0}
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
      {:else}
        <p class="ib-connect__help" data-testid="connect-choose-empty">{copy.chooseToolsEmpty}</p>
      {/if}
    </FormSection>

    <FormActions sticky>
      {#snippet summary()}
        {#if !passed}<span data-testid="connect-summary">{copy.testsFirst}</span>{/if}
      {/snippet}
      {#snippet end()}
        <Button variant="secondary" onclick={cancel}>{copy.actions.cancel}</Button>
        <Button
          data-changes
          variant="primary"
          loading={connect.isPending}
          disabled={test.isPending || locked}
          onclick={runConnect}>{copy.actions.connect}</Button
        >
      {/snippet}
    </FormActions>
  </form>
</section>

<style>
  .ib-connect,
  .ib-connect__form {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    min-width: 0;
  }

  .ib-connect__reason,
  .ib-connect__help {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .ib-connect__help {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-connect__code {
    font-family: var(--cinder-font-mono);
  }

  .ib-connect__error {
    color: var(--cinder-status-danger-text);
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

  .ib-connect__test {
    display: flex;
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
