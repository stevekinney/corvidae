<script lang="ts" module>
  /** One tool Choose tools lists: an MCP server's tool from its test, or an OpenAPI spec's operation. */
  export type ChooseToolRow = {
    /** Its own name at the source, which the choice is kept under. */
    readonly tool: string;
    /** Its name for a person, or `null` when the source gives none. */
    readonly title: string | null;
    /** The risk it declares (`read-only`, `mutating`, `dangerous`), or `null`. */
    readonly tier: string | null;
    /** For an OpenAPI operation: its method and path (`GET /refunds`). */
    readonly operation?: { readonly method: string; readonly path: string };
  };

  /** What Choose tools shows: the dashed box before a test, the note for none, or the list. */
  export type ChooseToolsMode = 'locked' | 'none' | 'listed';

  /** How many rows of an OpenAPI spec's operations the list shows before it scrolls (row 33y). */
  export const VISIBLE_OPERATION_ROWS = 4;
</script>

<script lang="ts">
  /**
   * The Choose tools section of the Connect tools page (COR-2022 rows 33i, 33m, 33w, 33y, 34w):
   * what agents may use of a source, and when each tool asks, chosen before anything is saved.
   *
   * Before a test passes it is a dashed box that says to test the connection (row 33m); a server
   * that answered with no tools says so in the same box (row 34w). Once tools are listed it shows the
   * intro, the legend of the four levels with each word in bold (row 33i), and a table with an On
   * checkbox, the tool, its risk and its Asks level. An OpenAPI spec's operations add a filter, a
   * segmented risk filter, the count selected and Select all, and the list scrolls inside itself
   * with a line that says how much it shows (rows 33w, 33y).
   *
   * Nothing here is saved: the choices are the page's own state until Connect sends them, so the
   * controls carry no `data-changes` and stay live while the server does not answer.
   */
  import {
    Checkbox,
    SearchField,
    Segment,
    SegmentedControl,
    Select,
    Table,
  } from '@lostgradient/cinder';

  import { AGENT_PAGE_COPY } from '../../app/copy/agents.ts';
  import { CAPABILITIES_COPY } from '../../app/copy/capabilities.ts';
  import { SOURCE_TOOL_APPROVALS, type SourceToolApproval } from '../../lib/host-tool-sources.ts';
  import {
    chosenToolCount,
    type ToolChoice,
    type ToolSourceFormKind,
  } from '../../lib/tool-source-form.ts';
  import {
    riskLabel,
    sourceToolHeading,
    sourceToolTier,
    type ToolTier,
  } from './capability-presentation.ts';

  interface Props {
    /** Whether the source is an MCP server or an OpenAPI spec. */
    kind: ToolSourceFormKind;
    /** What the section shows. */
    mode: ChooseToolsMode;
    /** The tools listed, in the order the source lists them. */
    tools: readonly ChooseToolRow[];
    /** The person's choice for each tool, by its own name. */
    choices: Readonly<Record<string, ToolChoice>>;
    /** The source's identifier, which prefixes the name an agent file uses (`github__list_issues`). */
    sourceId: string;
    /** What a person calls the source, for the table's caption. */
    sourceName: string;
    /** Whether the choices are held, as while Connect runs. */
    disabled?: boolean;
    /** One tool's choice changed. */
    onChoose: (tool: string, change: Partial<ToolChoice>) => void;
    /** Select all: every tool in `tools` turned on or off. */
    onChooseAll: (tools: readonly string[], on: boolean) => void;
  }

  let {
    kind,
    mode,
    tools,
    choices,
    sourceId,
    sourceName,
    disabled = false,
    onChoose,
    onChooseAll,
  }: Props = $props();

  const copy = CAPABILITIES_COPY.source.connect.chooseTools;

  const approvalOptions = SOURCE_TOOL_APPROVALS.map((value) => ({
    value,
    label: AGENT_PAGE_COPY.access.approvals[value],
  }));

  /** The risk filter's choices (row 33w): all, then each tier by the word its row reads. */
  const RISKS = ['read-only', 'mutating', 'dangerous'] as const satisfies readonly ToolTier[];
  type RiskFilter = 'all' | (typeof RISKS)[number];

  let filter = $state('');
  let risk = $state<RiskFilter>('all');

  // hidden-label-allowed: the risk filter has its visible Show label beside it, and each Asks select its column head
  const hiddenLabel = { labelVisible: false } as const;

  const shown = $derived(
    kind === 'openapi' ? tools.filter((row) => matches(row, filter, risk)) : tools,
  );
  const selected = $derived(chosenToolCount(choices));
  const allOn = $derived(tools.length > 0 && selected === tools.length);

  function matches(row: ChooseToolRow, typed: string, level: RiskFilter): boolean {
    if (level !== 'all' && sourceToolTier(row) !== level) return false;
    const needle = typed.trim().toLowerCase();
    if (needle === '') return true;
    return [row.tool, row.title ?? '', row.operation?.path ?? ''].some((text) =>
      text.toLowerCase().includes(needle),
    );
  }

  function choiceOf(tool: string): ToolChoice | undefined {
    return Object.hasOwn(choices, tool) ? choices[tool] : undefined;
  }

  function headingOf(row: ChooseToolRow): string {
    return row.title ?? sourceToolHeading(row);
  }
</script>

<div class="ib-connect-choose" data-testid="connect-choose-tools" data-mode={mode}>
  {#if mode === 'listed'}
    <p class="ib-connect-choose__intro" data-testid="connect-choose-intro">
      {copy.intro}
      {copy.hints}
    </p>
  {:else}
    <p class="ib-connect-choose__intro" data-testid="connect-choose-intro">{copy.intro}</p>
  {/if}

  {#if mode === 'locked'}
    <p class="ib-connect-choose__box" data-testid="connect-choose-locked">{copy.locked}</p>
  {:else if mode === 'none'}
    <p class="ib-connect-choose__box" data-testid="connect-choose-none">{copy.none}</p>
  {:else}
    {#if kind === 'openapi'}
      <p class="ib-connect-choose__intro" data-testid="connect-operations-found">
        {copy.operations.found(tools.length)}
      </p>
      <div class="ib-connect-choose__filters">
        <SearchField
          aria-label={copy.operations.filterLabel}
          placeholder={copy.operations.filterLabel}
          bind:value={filter}
          onClear={() => (filter = '')}
        />
        <span class="ib-connect-choose__label" aria-hidden="true">{copy.operations.riskLabel}</span>
        <SegmentedControl
          id="connect-operations-risk"
          label={copy.operations.riskLabel}
          {...hiddenLabel}
          size="sm"
          value={risk}
          onValueChange={(next: RiskFilter) => (risk = next)}
        >
          <Segment value="all">{copy.operations.all}</Segment>
          {#each RISKS as level (level)}
            <Segment value={level}>{riskLabel(level)}</Segment>
          {/each}
        </SegmentedControl>
      </div>
      <div class="ib-connect-choose__selection">
        <span data-testid="connect-operations-selected"
          >{copy.operations.selected(selected, tools.length)}</span
        >
        <Checkbox
          id="connect-operations-all"
          label={copy.operations.selectAll(tools.length)}
          checked={allOn}
          indeterminate={selected > 0 && !allOn}
          {disabled}
          onValueChangeRequest={(next) => {
            onChooseAll(
              tools.map((row) => row.tool),
              next,
            );
            return next;
          }}
        />
      </div>
    {/if}

    <ul
      class="ib-connect-choose__legend"
      aria-label={copy.legendLabel}
      data-testid="connect-legend"
    >
      {#each copy.legend as entry (entry.word)}
        <li><strong>{entry.word}</strong> {entry.means}</li>
      {/each}
    </ul>

    {#if shown.length === 0}
      <p class="ib-connect-choose__intro" data-testid="connect-operations-none">
        {copy.operations.noMatch}
      </p>
    {:else}
      <div
        class="ib-connect-choose__table"
        data-scrolls={kind === 'openapi' ? '' : undefined}
        data-testid="connect-choose-table"
      >
        <Table caption={copy.caption(sourceName)} density="comfortable">
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{copy.columns.on}</Table.HeaderCell>
              <Table.HeaderCell>{copy.columns.tool}</Table.HeaderCell>
              <Table.HeaderCell>{copy.columns.risk}</Table.HeaderCell>
              <Table.HeaderCell>{copy.columns.asks}</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each shown as row (row.tool)}
              {@const choice = choiceOf(row.tool)}
              <Table.Row data-probe-tool={`${sourceId}__${row.tool}`}>
                <Table.Cell>
                  <Checkbox
                    id={`connect-tool-${row.tool}-on`}
                    aria-label={copy.onLabel(headingOf(row))}
                    checked={choice?.on ?? false}
                    {disabled}
                    onValueChangeRequest={(next) => {
                      onChoose(row.tool, { on: next });
                      return next;
                    }}
                  />
                </Table.Cell>
                <Table.Cell>
                  <span class="ib-capability__name-line">
                    <span class="ib-connect-choose__name">{headingOf(row)}</span>
                    <code class="ib-capability__code ib-capability__identifier"
                      >{row.operation === undefined
                        ? row.tool
                        : `${row.operation.method} ${row.operation.path}`}</code
                    >
                  </span>
                </Table.Cell>
                <Table.Cell data-testid="connect-tool-risk"
                  >{riskLabel(sourceToolTier(row))}</Table.Cell
                >
                <Table.Cell>
                  <Select
                    id={`connect-tool-${row.tool}-asks`}
                    label={copy.asksLabel(headingOf(row))}
                    {...hiddenLabel}
                    size="sm"
                    options={approvalOptions}
                    value={choice?.approval ?? 'on-changes'}
                    disabled={disabled || choice?.on !== true}
                    onValueChange={(next: SourceToolApproval) =>
                      onChoose(row.tool, { approval: next })}
                  />
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table>
      </div>
      {#if kind === 'openapi' && shown.length > VISIBLE_OPERATION_ROWS}
        <p class="ib-connect-choose__intro" data-testid="connect-operations-showing">
          {copy.operations.showing(VISIBLE_OPERATION_ROWS, shown.length)}
        </p>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .ib-connect-choose {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-connect-choose__intro {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }

  /* Before a test passes, and for a server with no tools: a dashed box, not an empty table (rows 33m, 34w). */
  .ib-connect-choose__box {
    margin: 0;
    padding: var(--cinder-space-4);
    border: 1px dashed var(--cinder-border-control);
    border-radius: var(--cinder-radius-md);
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
    text-align: center;
    overflow-wrap: anywhere;
  }

  .ib-connect-choose__filters,
  .ib-connect-choose__selection {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-2) var(--cinder-space-3);
    min-width: 0;
  }

  .ib-connect-choose__selection {
    justify-content: space-between;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-connect-choose__label {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  /* The legend's four levels side by side, each its own item: no separator character between them. */
  .ib-connect-choose__legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-1) var(--cinder-space-4);
    margin: 0;
    padding: 0;
    list-style: none;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-connect-choose__legend strong {
    color: var(--cinder-text-default);
  }

  .ib-connect-choose__table {
    min-width: 0;
    overflow-x: auto;
  }

  /* An OpenAPI spec's operations scroll inside the list, about four rows at a time (row 33y). */
  .ib-connect-choose__table[data-scrolls] {
    max-block-size: calc(var(--cinder-space-6) * 2 * (1 + 4));
    overflow-y: auto;
  }

  .ib-connect-choose__name {
    font-weight: var(--cinder-font-medium);
  }
</style>
