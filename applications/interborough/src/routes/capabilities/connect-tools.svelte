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
   * (`toolSourceIdentifier`). An OpenAPI spec is read by the host as soon as it is chosen
   * (`inspectOpenApi`): its title fills in Name, its first server the Base URL, and its operations
   * are listed under Choose tools; a file that is not a spec, or a spec with no `operationId`, says
   * so under the Spec field (rows 33t, 33u, 34s, 34u, 34v).
   *
   * The flow is one state machine (`connect-tools-state.svelte.ts`): Test connection contacts the
   * source before anything is saved (`POST /host/tool-sources/<id>/probe`) and lists what it offers
   * under Choose tools, where each tool is turned on or off and given its Asks level (rows 33i, 33m,
   * 34w); Connect tests first when no test has passed for what the form holds (rows 33n, 34j), then
   * saves the source with that choice (`PUT /host/tool-sources/<id>`), and the page says what is now
   * available, with Give to an agent and View in Capabilities (rows 34f to 34h). Cancel stays live
   * while Connect runs and stops it, saving nothing (rows 34a, 34z); after 15 seconds the footer adds
   * "Taking longer than usual". A connect that fails keeps every choice (rows 34b, 34c).
   *
   * Leaving a filled form asks first (`LeaveGuard`), and an untouched one leaves without asking
   * (row 35b). While the server does not answer, the fields stay editable and Test connection and
   * Connect are held by the shell (they carry `data-changes`), each with the words that say why
   * (row 35f).
   *
   * Connect asks the host to add the source only if the name is free (`create`), so a source another
   * tab saved under the same name in the meantime is reported with the form intact instead of being
   * replaced. A source already saved at the address typed is named under Server URL (row 34e).
   *
   * A token or key lives in its field and in the request being sent. TanStack keeps the variables
   * of a mutation until the mutation is collected, so both mutations here are collected as soon as
   * the page stops observing them (`gcTime: 0`) and the secret does not outlive the page. It is
   * never put in a message: the host words a refusal in terms of the field, and a probe answers in
   * words that hold no address, command or value.
   *
   * Signing in with OAuth before the source is saved needs a host operation that does not exist yet
   * (the host signs in to a saved source only), so an OAuth source is connected first and opened on
   * its page in Capabilities › Sources to sign in, as the line under the choice says.
   */
  import {
    Alert,
    Button,
    Callout,
    ConfirmDialog,
    EmptyState,
    FormActions,
    FormSection,
    InlineLoading,
    Input,
    PageHeader,
    RadioGroup,
    Segment,
    SegmentedControl,
    StatusDot,
  } from '@lostgradient/cinder';
  import { CircleAlert, TriangleAlert } from '@lucide/svelte';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { getConnection } from '../../app/connection.svelte.ts';
  import { AGENT_PAGE_COPY, CAPABILITIES_COPY } from '../../app/copy.ts';
  import { agentTabPath } from '../../lib/agent-paths.ts';
  import {
    connectToolSource,
    getToolSources,
    HostToolSourceError,
    inspectOpenApi,
    probeToolSource,
    toolSourceFaultTreatment,
    type OpenApiInspection,
    type OpenApiSpecInput,
    type ToolSourceRequest,
  } from '../../lib/host-tool-sources.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { LeaveGuard, router } from '../../lib/router.svelte.ts';
  import {
    authenticationChoices,
    buildToolSourceRequest,
    chosenToolCount,
    connectedTools,
    effectiveAuthentication,
    EMPTY_TOOL_SOURCE_FORM,
    fieldOfHostField,
    MAXIMUM_SPECIFICATION_BYTES,
    openApiToolName,
    toolSettingsOf,
    toolSourceIdentifier,
    type ToolSourceForm,
    type ToolSourceFormField,
  } from '../../lib/tool-source-form.ts';
  import { sourceHeading, sourceToolHeading } from './capability-presentation.ts';
  import ConnectChooseTools, {
    type ChooseToolRow,
    type ChooseToolsMode,
  } from './connect-choose-tools.svelte';
  import ConnectGiveToAgent from './connect-give-to-agent.svelte';
  import {
    ConnectFlow,
    connectFooterLine,
    contactedHost,
    passedProbeOf,
    sourceAddressOf,
    type ConnectRequest,
  } from './connect-tools-state.svelte.ts';

  const copy = CAPABILITIES_COPY.source.connect;
  const SOURCES_PATH = '/capabilities?tab=sources';
  const queryClient = useQueryClient();
  const connection = getConnection();

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
  /** Sign in for an MCP server, and for an OpenAPI spec, which starts on an API key (row 33u). */
  let authentication = $state('none');
  let openApiAuthentication = $state('api-key');
  let secret = $state('');
  let header = $state('');

  /** Whether Connect or Test connection was pressed, which is when empty fields are named. */
  let submitted = $state(false);
  /** A field the host refused, with its words. Cleared by the next change to the form. */
  let hostError = $state<{ readonly field: ToolSourceFormField; readonly message: string }>();
  /** Whether the "Give to an agent" picker is open (row 35c). */
  let giving = $state(false);

  /** Reading an OpenAPI spec before it is connected: where it was read from, and what the host made of it. */
  type SpecReading =
    | { readonly kind: 'none' }
    | { readonly kind: 'reading'; readonly from: 'url' | 'file' }
    | {
        readonly kind: 'read';
        readonly from: 'url' | 'file';
        readonly inspection: OpenApiInspection;
      }
    | { readonly kind: 'failed'; readonly from: 'url' | 'file'; readonly message: string };
  let spec = $state.raw<SpecReading>({ kind: 'none' });
  let specController: AbortController | undefined;
  /** What a spec filled Name and Base URL with, so a later spec replaces only its own value. */
  let prefilledName = '';
  let prefilledBaseUrl = '';

  function authenticationOf(value: string): ToolSourceForm['authentication'] {
    return value === 'bearer' || value === 'oauth' || value === 'api-key' ? value : 'none';
  }

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
    authentication: authenticationOf(kind === 'openapi' ? openApiAuthentication : authentication),
    secret,
    header,
  });
  /** The form before anything is filled in: a form that still reads so leaves without asking (row 35b). */
  const pristine = untrack(() => JSON.stringify(form));
  const choices = $derived(authenticationChoices(form));
  const activeAuthentication = $derived(effectiveAuthentication(form));
  const built = $derived(buildToolSourceRequest(form));
  const signature = $derived('request' in built ? JSON.stringify(built.request) : '');
  const taken = $derived(form.id !== '' && existing.includes(form.id));
  const fileTooLarge = $derived(fileError !== '');
  const shownName = $derived(form.name.trim() === '' ? form.id : form.name.trim());

  /** A source already saved at the Server URL typed (row 34e). */
  const duplicate = $derived.by(() => {
    if (form.kind !== 'mcp' || form.transport !== 'http') return undefined;
    const address = sourceAddressOf(url);
    if (address === undefined) return undefined;
    return (sources.data?.sources ?? []).find((source) => source.address === address);
  });

  const flow = new ConnectFlow(describe);
  const phase = $derived(flow.state.phase);
  const offline = $derived(flow.state.offline);
  const testing = $derived(phase.kind === 'testing');
  const connecting = $derived(phase.kind === 'connecting' || phase.kind === 'slow');
  const passed = $derived(passedProbeOf(phase));
  const listedProbe = $derived(passed?.outcome === 'listed' ? passed : undefined);
  /** The spec the host read, when it is one whose operations name tools. */
  const validSpec = $derived.by(() => {
    if (form.kind !== 'openapi' || spec.kind !== 'read') return undefined;
    const inspection = spec.inspection;
    return inspection.outcome === 'valid' ? inspection : undefined;
  });

  /** What Choose tools lists: an OpenAPI spec's operations once it is read, an MCP server's tools once tested. */
  const chooseRows: readonly ChooseToolRow[] = $derived(
    form.kind === 'openapi'
      ? (validSpec?.operations ?? []).flatMap((operation) =>
          operation.operationId === null
            ? []
            : [
                {
                  // The tool's own name at the source, which a choice is saved under.
                  tool: openApiToolName(operation.operationId),
                  title: operation.title,
                  tier: operation.tier,
                  operation: { method: operation.method, path: operation.path },
                },
              ],
        )
      : (listedProbe?.tools ?? []).map((tool) => ({
          tool: tool.tool,
          title: tool.title ?? null,
          tier: tool.tier,
        })),
  );
  const listed = $derived(
    form.kind === 'openapi' ? validSpec !== undefined : listedProbe !== undefined,
  );
  const chooseMode: ChooseToolsMode = $derived(
    !listed ? 'locked' : chooseRows.length === 0 ? 'none' : 'listed',
  );
  const chosen = $derived(chosenToolCount(flow.choices));
  const footer = $derived(
    connectFooterLine(flow.state, {
      listed,
      chosen,
      transport: form.transport,
      kind: form.kind,
      duplicate: duplicate !== undefined,
    }),
  );

  // A spec's operations are its tools: seed their starting choices once it is read (row 33w).
  $effect(() => {
    const rows = form.kind === 'openapi' && validSpec !== undefined ? chooseRows : undefined;
    if (rows !== undefined) untrack(() => flow.seed('openapi', rows));
  });

  // Any change to the form makes the host's refusal stale, and a test of a request the form no
  // longer makes. Untracked, so the flow's own state is not read here.
  $effect(() => {
    const now = JSON.stringify(form);
    const current = signature;
    untrack(() => {
      hostError = undefined;
      flow.edit(current, now !== pristine);
    });
  });

  $effect(() => {
    const unreachable = connection.unreachable;
    untrack(() => flow.setOffline(unreachable));
  });

  $effect(() => () => {
    flow.dispose();
    specController?.abort();
  });

  // Leaving a filled form asks first, and a connected source has nothing left to lose (rows 35b, 35f).
  const leaveGuard = new LeaveGuard(
    () => flow.state.dirty && flow.state.phase.kind !== 'connected',
  );
  $effect(() => leaveGuard.attach());

  // A source that asks for a sign-in is signed in to from its own page, so it opens there.
  $effect(() => {
    if (phase.kind !== 'connected' || phase.probe.outcome !== 'needs-authorization') return;
    const id = phase.change.id;
    untrack(() => {
      leaveGuard.release();
      router.navigate(`${SOURCES_PATH}&source=${encodeURIComponent(id)}`);
    });
  });

  /**
   * The words under a field: the host's refusal, then what is wrong that the page knows, then what
   * is missing once the person has tried. The identifier is made from the name, so what is wrong
   * with it is said under Name.
   */
  function errorOf(field: ToolSourceFormField): string {
    if (hostError?.field === field) return hostError.message;
    if (field === 'id' && taken) return copy.exists(form.id);
    if (field === 'url' && duplicate !== undefined) return copy.duplicate(sourceHeading(duplicate));
    if (field === 'document' && fileError !== '') return fileError;
    const fromSpec = specProblem(field);
    if (fromSpec !== '') return fromSpec;
    return submitted && 'errors' in built ? (built.errors[field] ?? '') : '';
  }

  /** What reading the spec found wrong, under the field it was read from (rows 34u, 34v). */
  function specProblem(field: ToolSourceFormField): string {
    const from = field === 'document' ? 'file' : field === 'specificationUrl' ? 'url' : undefined;
    if (from === undefined || spec.kind === 'none' || spec.kind === 'reading') return '';
    if (spec.from !== from) return '';
    if (spec.kind === 'failed') return spec.message;
    return spec.inspection.outcome === 'valid' ? '' : spec.inspection.message;
  }

  /**
   * Puts a refusal where it belongs (`describe` of the flow): under the field the host named, which
   * answers the empty string, or in words for the whole request. A connect that failed for no
   * reason the host gave is the server that stopped answering after the test passed (row 34b).
   */
  function describe(error: unknown, stage: 'test' | 'connect'): string {
    if (error instanceof HostToolSourceError && error.kind === 'exists') {
      hostError = { field: 'id', message: copy.exists(form.id) };
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolSources.list() });
      return '';
    }
    const treatment = toolSourceFaultTreatment(error);
    const field =
      error instanceof HostToolSourceError && error.kind === 'invalid' && error.field !== undefined
        ? fieldOfHostField(error.field, form)
        : undefined;
    if (field !== undefined && treatment.message !== '') {
      hostError = { field, message: treatment.message };
      return '';
    }
    if (stage === 'connect') {
      return error instanceof HostToolSourceError && error.message !== ''
        ? error.message
        : copy.connectFailed.stopped;
    }
    return `${copy.probe.failed}. ${treatment.message}`;
  }

  type Ready = {
    readonly name: string;
    readonly request: ToolSourceRequest;
    readonly signal: AbortSignal;
  };

  const test = createMutation(() => ({
    gcTime: 0,
    mutationFn: ({ name: id, request, signal }: Ready) => probeToolSource(id, request, { signal }),
  }));

  const connect = createMutation(() => ({
    gcTime: 0,
    // `create`: the host refuses a name another tab saved since this page listed the sources.
    mutationFn: ({ name: id, request, signal }: Ready) =>
      connectToolSource(id, { ...request, create: true }, { signal }),
    onSuccess: async () => {
      // Its tools join the catalog an agent's Access tab lists (row 35d).
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.toolSources.list() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.catalog() }),
      ]);
    },
  }));

  /** The request the form makes, when it can make one and the name is free; otherwise the fields are named. */
  function requestToSend(): ConnectRequest | undefined {
    submitted = true;
    if (!('request' in built) || taken || locked) return undefined;
    const id = built.id;
    const request = built.request;
    return {
      signature,
      kind: form.kind,
      probe: (signal) => test.mutateAsync({ name: id, request, signal }),
      connect: (picked, signal) => {
        // Read when the connect is sent: a test pressed with Connect has just listed the tools.
        const tiers = Object.fromEntries(chooseRows.map((row) => [row.tool, row.tier]));
        const tools = toolSettingsOf(picked, tiers);
        return connect.mutateAsync({
          name: id,
          request: Object.keys(tools).length === 0 ? request : { ...request, tools },
          signal,
        });
      },
    };
  }

  /** Moves focus to the Server URL, whose message says the address is taken (row 34e). */
  function showDuplicate(): void {
    submitted = true;
    document.getElementById('connect-url')?.focus();
  }

  function runTest(): void {
    if (connection.unreachable) return;
    if (duplicate !== undefined) {
      showDuplicate();
      return;
    }
    const request = requestToSend();
    if (request !== undefined) flow.test(request);
  }

  /** Connects what the form holds, testing it first when no test has passed for it (row 33n). */
  function runConnect(): void {
    if (connection.unreachable) return;
    if (duplicate !== undefined) {
      showDuplicate();
      return;
    }
    const request = requestToSend();
    if (request !== undefined) flow.connect(request);
  }

  /**
   * Cancel: stops a test or a connect in flight and saves nothing, keeping the form (rows 34a,
   * 34z); with nothing in flight, it leaves for Capabilities › Sources, asking first when the form
   * is filled. A connect the host finished before the abort reached it is shown by reading the list
   * again, where its name then reads as taken.
   */
  function cancel(): void {
    const wasConnecting = connecting;
    if (flow.cancel()) {
      if (wasConnecting) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.toolSources.list() });
      }
      return;
    }
    router.navigate(SOURCES_PATH);
  }

  /** Asks the host to read a spec; a newer read, or Cancel, stops an older one (row 34s). */
  async function readSpec(input: OpenApiSpecInput): Promise<void> {
    specController?.abort();
    const controller = new AbortController();
    specController = controller;
    const from = 'url' in input ? 'url' : 'file';
    spec = { kind: 'reading', from };
    try {
      const inspection = await inspectOpenApi(input, { signal: controller.signal });
      if (controller.signal.aborted) return;
      spec = { kind: 'read', from, inspection };
      if (inspection.outcome !== 'valid') return;
      if (from === 'file') documentText = JSON.stringify(inspection.document);
      // A spec fills in only what a person has not typed (rows 33t, 33u).
      if (inspection.title !== null && (name.trim() === '' || name === prefilledName)) {
        name = inspection.title;
        prefilledName = inspection.title;
      }
      if (inspection.baseUrl !== null && (baseUrl.trim() === '' || baseUrl === prefilledBaseUrl)) {
        baseUrl = inspection.baseUrl;
        prefilledBaseUrl = inspection.baseUrl;
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      spec = { kind: 'failed', from, message: toolSourceFaultTreatment(error).message };
    }
  }

  function cancelSpec(): void {
    specController?.abort();
    specController = undefined;
    spec = { kind: 'none' };
  }

  function readSpecAddress(): void {
    const address = specificationUrl.trim();
    if (address === '') {
      cancelSpec();
      return;
    }
    void readSpec({ url: address });
  }

  /** Reads the OpenAPI file the person chose; a file too large for the host is refused here. */
  async function chooseFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    fileError = '';
    documentText = '';
    cancelSpec();
    if (file === undefined) {
      fileName = '';
      return;
    }
    fileName = file.name;
    if (file.size > MAXIMUM_SPECIFICATION_BYTES) {
      fileError = copy.file.tooLarge;
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      fileError = copy.file.unreadable;
      return;
    }
    await readSpec({ text, fileName: file.name });
  }

  /** The spec's summary, each part its own element (rows 34v): file name, version, operation count. */
  const specSummary = $derived.by((): readonly string[] => {
    if (form.kind !== 'openapi' || spec.kind !== 'read') return [];
    const inspection = spec.inspection;
    if (inspection.outcome !== 'valid' && inspection.outcome !== 'no-operation-ids') return [];
    return [
      ...(inspection.fileName === null ? [] : [inspection.fileName]),
      copy.spec.version(inspection.version),
      copy.spec.operations(inspection.operationCount),
    ];
  });

  /** The note beside Test connection while it runs: the host it contacts (row 34i). */
  const contacting = $derived.by(() => {
    if (form.kind === 'mcp' && form.transport === 'stdio') return copy.probe.starting;
    const where = contactedHost(
      form.kind === 'mcp' ? url : form.specification === 'url' ? specificationUrl : baseUrl,
    );
    return where === undefined ? copy.probe.starting : copy.probe.contacting(where);
  });

  /** For an OpenAPI spec: the read the test makes with the key (rows 33v, 34r). */
  const calls = $derived.by(() => {
    const operation = validSpec?.testOperation;
    if (validSpec === undefined) return '';
    if (operation === null || operation === undefined) return copy.probe.callsNothing;
    return copy.probe.calls(
      operation.title ?? operation.operationId,
      operation.method,
      operation.path,
    );
  });

  /** What the success state lists (row 34g), and the line above it (row 34f). */
  const connectedRows = $derived(connectedTools(chooseRows, flow.choices));
  const successLine = $derived.by(() => {
    const on = connectedRows.filter((row) => row.approval !== 'off').length;
    if (phase.kind === 'connected' && phase.change.restartRequired) return copy.success.restart(on);
    const off = connectedRows
      .filter((row) => row.approval === 'off')
      .map((row) => row.title ?? sourceToolHeading(row));
    return copy.success.line(on, off);
  });
  const connectedId = $derived(phase.kind === 'connected' ? phase.change.id : form.id);

  function viewInCapabilities(): void {
    router.navigate(`${SOURCES_PATH}&source=${encodeURIComponent(connectedId)}`);
  }

  /** Opens the chosen agent's Access tab, where the new tools are listed unchecked (row 35d). */
  function giveTo(agent: string): void {
    giving = false;
    router.navigate(agentTabPath(agent, 'access'));
  }
</script>

<section class="ib-connect" data-page="connect-tools" data-phase={phase.kind}>
  <PageHeader title={copy.title} description={copy.intro} headingLevel={1} />

  {#if phase.kind === 'connected' && phase.probe.outcome !== 'needs-authorization'}
    <div class="ib-connect__success" data-testid="connect-success">
      <EmptyState
        kind="done"
        headingLevel={2}
        title={copy.success.title(shownName)}
        description={successLine}
      >
        {#snippet action()}
          <div class="ib-connect__success-body">
            {#if connectedRows.length > 0}
              <ul class="ib-connect__chosen" aria-label={copy.success.listLabel}>
                {#each connectedRows as row (row.tool)}
                  <li class="ib-connect__chosen-row" data-connected-tool={row.tool}>
                    <span>{row.title ?? sourceToolHeading(row)}</span>
                    <span class="ib-connect__help"
                      >{row.approval === 'off'
                        ? copy.success.off
                        : AGENT_PAGE_COPY.access.approvals[row.approval]}</span
                    >
                  </li>
                {/each}
              </ul>
            {/if}
            <div class="ib-connect__success-actions">
              <Button variant="secondary" onclick={() => (giving = true)}
                >{copy.success.give}</Button
              >
              <Button variant="primary" onclick={viewInCapabilities}>{copy.success.view}</Button>
            </div>
          </div>
        {/snippet}
      </EmptyState>
    </div>
    <ConnectGiveToAgent
      sourceName={shownName}
      open={giving}
      onClose={() => (giving = false)}
      onChoose={giveTo}
    />
  {:else}
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
        <RadioGroup
          name="connect-kind"
          label={copy.kind.label}
          bind:value={kind}
          disabled={connecting}
        >
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
            disabled={connecting}
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
              disabled={connecting}
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
              disabled={connecting}
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
            disabled={connecting}
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
              disabled={connecting}
              onchange={readSpecAddress}
            />
            {#if spec.kind === 'reading' && spec.from === 'url'}
              <div class="ib-connect__fetching" data-testid="connect-spec-fetching">
                <InlineLoading status="active" description={copy.spec.fetching} />
                <Button variant="ghost" size="sm" onclick={cancelSpec}>{copy.spec.cancel}</Button>
              </div>
            {/if}
          {:else}
            <div
              class="ib-connect__file"
              data-invalid={errorOf('document') !== '' || fileTooLarge ? '' : undefined}
            >
              <label for="connect-file">{copy.file.label}</label>
              <input
                id="connect-file"
                type="file"
                accept=".json,.yaml,.yml,application/json,application/yaml"
                disabled={connecting}
                aria-invalid={errorOf('document') !== '' || fileTooLarge}
                aria-describedby="connect-file-help"
                onchange={(event) => void chooseFile(event)}
              />
              <p id="connect-file-help" class="ib-connect__help">
                {#if errorOf('document') !== ''}
                  <span class="ib-connect__error" data-testid="connect-file-error"
                    >{errorOf('document')}</span
                  >
                {:else if spec.kind === 'reading'}
                  {copy.spec.fetching}
                {:else if fileName !== ''}
                  {copy.file.chosen(fileName)}
                {:else}
                  {copy.file.description}
                {/if}
              </p>
            </div>
          {/if}
          {#if specSummary.length > 0}
            <ul
              class="ib-connect__summary"
              aria-label={copy.spec.summaryLabel}
              data-testid="connect-spec-summary"
            >
              {#each specSummary as part (part)}
                <li>{part}</li>
              {/each}
            </ul>
          {/if}
        {/if}
        <Input
          id="connect-name"
          label={copy.name.label}
          description={form.kind === 'openapi' ? copy.name.fromSpec : copy.name.description}
          placeholder={copy.name.placeholder}
          autocomplete="off"
          required
          bind:value={name}
          error={errorOf('id')}
          disabled={connecting}
        />
      </FormSection>

      {#if choices.length > 1}
        <FormSection
          heading={form.kind === 'openapi' ? copy.sections.baseUrlAndSignIn : copy.sections.signIn}
          columns={1}
        >
          {#if form.kind === 'openapi'}
            <Input
              id="connect-base-url"
              type="url"
              label={copy.baseUrl.label}
              description={copy.baseUrl.description}
              placeholder={copy.baseUrl.placeholder}
              autocomplete="off"
              spellcheck={false}
              variant="code"
              required
              bind:value={baseUrl}
              error={errorOf('baseUrl')}
              disabled={connecting}
            />
            <RadioGroup
              name="connect-authentication"
              label={copy.authentication.label}
              bind:value={openApiAuthentication}
              disabled={connecting}
            >
              {#each choices as choice (choice)}
                <RadioGroup.Option
                  id={`connect-authentication-${choice}`}
                  value={choice}
                  label={copy.authentication[choice]}
                />
              {/each}
            </RadioGroup>
          {:else}
            <RadioGroup
              name="connect-authentication"
              label={copy.authentication.label}
              bind:value={authentication}
              disabled={connecting}
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
          {/if}
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
                disabled={connecting}
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
              disabled={connecting}
            />
          {/if}
        </FormSection>
      {/if}

      <FormSection heading={copy.sections.test} columns={1}>
        <div class="ib-connect__test">
          <Button
            data-changes
            variant="secondary"
            loading={testing}
            disabled={connecting || locked}
            onclick={runTest}>{testing ? copy.probe.testing : copy.probe.action}</Button
          >
          {#if offline}
            <span class="ib-connect__help" data-testid="connect-test-offline"
              >{copy.probe.offline}</span
            >
          {:else if testing}
            <span class="ib-connect__help" data-testid="connect-contacting">{contacting}</span>
          {:else if calls !== ''}
            <span class="ib-connect__help" data-testid="connect-test-calls">{calls}</span>
          {/if}
        </div>
        <div class="ib-connect__result" aria-live="polite" data-testid="connect-result">
          {#if listedProbe !== undefined}
            <p class="ib-connect__found" data-testid="connect-found">
              <StatusDot status="success" label={copy.probe.connected} wordTone="status" />
              <span data-testid="connect-listed">{copy.probe.found(listedProbe.tools.length)}</span>
            </p>
            {#if listedProbe.skipped.length > 0}
              <p class="ib-connect__help">{copy.probe.skipped(listedProbe.skipped.length)}</p>
            {/if}
            {#if listedProbe.test !== undefined && !listedProbe.test.passed}
              <Alert variant="danger" data-testid="connect-key-failed">
                <p class="ib-connect__reason">{listedProbe.test.message ?? copy.probe.failed}</p>
              </Alert>
            {/if}
          {:else if passed?.outcome === 'needs-authorization'}
            <Alert variant="info" data-testid="connect-needs-authorization">
              <p>{copy.probe.needsAuthorization}</p>
            </Alert>
          {:else if phase.kind === 'failed'}
            {#if phase.failure.kind === 'no-answer'}
              <Alert variant="danger" data-testid="connect-probe-failed">
                <p class="ib-capabilities__alert-title">{copy.probe.failedTitle}</p>
                <p class="ib-connect__reason" data-testid="connect-probe-reason">
                  {phase.failure.message}
                </p>
              </Alert>
            {:else if phase.failure.message !== ''}
              <Alert variant="danger" data-testid="connect-failure">
                <p class="ib-connect__reason">{phase.failure.message}</p>
              </Alert>
            {/if}
            <p class="ib-connect__help" data-testid="connect-test-kept">{copy.probe.kept}</p>
          {/if}
        </div>
      </FormSection>

      <FormSection heading={copy.sections.chooseTools} columns={1}>
        <ConnectChooseTools
          kind={form.kind}
          mode={chooseMode}
          tools={chooseRows}
          choices={flow.choices}
          sourceId={form.id}
          sourceName={shownName}
          disabled={connecting}
          onChoose={(tool, change) => flow.choose(tool, change)}
          onChooseAll={(tools, on) => flow.chooseAll(tools, on)}
        />
      </FormSection>

      {#if phase.kind === 'failed-connect'}
        <div class="ib-connect__connect-failed" role="alert" data-testid="connect-failed">
          <CircleAlert size={16} aria-hidden="true" class="ib-connect__glyph" />
          <p class="ib-connect__reason">
            {copy.connectFailed.lead}
            {phase.message}
            {copy.connectFailed.kept}
          </p>
          <Button data-changes variant="secondary" size="sm" onclick={runConnect}
            >{copy.connectFailed.retry}</Button
          >
        </div>
      {/if}

      <FormActions sticky>
        {#snippet summary()}
          {#if footer.kind === 'connecting'}
            <span class="ib-connect__connecting" data-testid="connect-summary">
              <InlineLoading
                status="active"
                description={footer.slow
                  ? `${copy.connecting(shownName)} ${copy.slow}`
                  : copy.connecting(shownName)}
              />
            </span>
          {:else if footer.kind !== 'none'}
            <span data-testid="connect-summary"
              >{footer.kind === 'offline'
                ? copy.offline
                : footer.kind === 'joins'
                  ? copy.joins(footer.count, shownName)
                  : footer.kind === 'tests-first'
                    ? copy.testsFirst
                    : copy.chooseFirst}</span
            >
          {/if}
        {/snippet}
        {#snippet end()}
          <Button variant="secondary" onclick={cancel}>{copy.actions.cancel}</Button>
          <Button
            data-changes
            variant="primary"
            loading={connecting}
            disabled={locked}
            onclick={runConnect}
            >{connecting
              ? copy.actions.connecting
              : listed && chosen > 0
                ? copy.actions.connectCount(chosen)
                : copy.actions.connect}</Button
          >
        {/snippet}
      </FormActions>
    </form>
  {/if}
</section>

<!-- Asked before a filled form is left (rows 35b, 35f). -->
<ConfirmDialog
  bind:open={leaveGuard.asking}
  title={copy.leave.title}
  description={copy.leave.description}
  confirmLabel={copy.leave.discard}
  cancelLabel={copy.leave.keep}
  destructive
  onConfirm={() => leaveGuard.leave()}
/>

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

  /* A spec that is not one, or names no operationId, keeps its file under a danger ring (rows 34u, 34v). */
  .ib-connect__file[data-invalid] input {
    border-radius: var(--cinder-radius-md);
    outline: 2px solid var(--cinder-status-danger-border);
    outline-offset: 2px;
  }

  .ib-connect__fetching,
  .ib-connect__test,
  .ib-connect__found {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-2) var(--cinder-space-3);
    min-width: 0;
  }

  .ib-connect__found {
    margin: 0;
  }

  /* The spec's file name, version and operation count side by side, each its own element. */
  .ib-connect__summary {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-1) var(--cinder-space-3);
    margin: 0;
    padding: 0;
    list-style: none;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }

  .ib-connect__result {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  /* A connect that failed after a passing test: a danger message above the footer, Try again at its right (row 34b). */
  .ib-connect__connect-failed {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-2);
    padding: var(--cinder-space-2) var(--cinder-space-3);
    border: 1px solid var(--cinder-status-danger-border);
    border-radius: var(--cinder-radius-md);
    color: var(--cinder-status-danger-text);
    min-width: 0;
  }

  .ib-connect__connect-failed .ib-connect__reason {
    flex: 1;
  }

  .ib-connect__success {
    display: flex;
    justify-content: center;
  }

  .ib-connect__success-body {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  /* What the person chose, in a bordered list: each tool and its Asks level, or Off (row 34g). */
  .ib-connect__chosen {
    margin: 0;
    padding: 0;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
    list-style: none;
    text-align: start;
  }

  .ib-connect__chosen-row {
    display: flex;
    justify-content: space-between;
    gap: var(--cinder-space-3);
    padding: var(--cinder-space-2) var(--cinder-space-3);
    overflow-wrap: anywhere;
  }

  .ib-connect__chosen-row + .ib-connect__chosen-row {
    border-top: 1px solid var(--cinder-border-muted);
  }

  .ib-connect__success-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--cinder-space-2);
  }
</style>
