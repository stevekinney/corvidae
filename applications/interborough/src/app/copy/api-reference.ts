/**
 * The words of Settings › API reference: the tabs that name the four groups, what each tab says,
 * and the states a tab with nothing to show is in (`routes/settings/api-reference`).
 */
export const API_REFERENCE_COPY = {
  title: 'API reference',
  intro: 'What other programs can do with Interborough, and what this session may do.',
  /** The tab row's accessible name. */
  tabsLabel: 'API reference',
  groups: {
    operations: 'Operations',
    discovery: 'Discovery documents',
    scopes: 'Your scopes',
    sources: 'Workflow sources',
  },
  /** The loading rule every page shares (board PageSettingsSections, "API reference loading"). */
  loading: {
    label: 'Loading the API reference',
    stillLoading: 'Still loading. This is taking longer than usual.',
    canceled: 'Loading was canceled.',
    tryAgain: 'Try again',
  },
  /** A read that failed with nothing to show; `status` is the HTTP status the server answered, if it answered. */
  loadFailed: {
    title: 'Couldn’t load the API reference.',
    description: (status: number | undefined): string =>
      status === undefined
        ? 'Interborough didn’t answer.'
        : `The server answered with an error (${String(status)}).`,
  },
  operations: {
    groupLabel: 'Group',
    allGroups: 'All groups',
    count: (count: number): string =>
      `${String(count)} ${count === 1 ? 'operation' : 'operations'}`,
    caption: 'Operations',
    columns: {
      method: 'Method',
      path: 'Path',
      summary: 'What it does',
      scope: 'Scope',
      /** The column of the button that opens a row, named for a screen reader only. */
      details: 'Details',
    },
    /** The accessible name of the button that opens a row's request and response. */
    toggleLabel: (method: string, path: string): string =>
      `Request and response for ${method} ${path}`,
    requestBody: 'Request body',
    noRequestBody: 'No request body.',
    response: (status: string): string => `Response, ${status}`,
    noResponseBody: 'No response body.',
    noScope: 'Any caller',
    empty: 'The server lists no operations.',
  },
  discovery: {
    documents: {
      openapi: {
        title: 'OpenAPI description',
        description: 'Every operation, for generating a client.',
      },
      agentCard: {
        title: 'Agent card',
        description: 'How other agents discover yours (A2A).',
      },
      tools: { title: 'Tool server', description: 'The same tools, over MCP.' },
    },
    copy: (title: string): string => `Copy ${title}`,
    copied: (title: string): string => `Copied ${title}`,
  },
  scopes: {
    intro:
      'This session can do the following. Interborough is single-user for now, so these are the scopes of the person at the keyboard, including everything this page’s own boards do: create schedules, edit agents and hooks, and change settings.',
    listLabel: 'Scopes this session holds',
    none: 'This session holds no scopes.',
  },
  sources: {
    intro:
      'Where Interborough reads workflow files from. Edit a workflow in its file; changes load on the next start or reload.',
    listLabel: 'Workflow files',
    workflows: (count: number): string =>
      `${String(count)} ${count === 1 ? 'workflow' : 'workflows'}`,
    schedules: (count: number): string =>
      `${String(count)} ${count === 1 ? 'schedule' : 'schedules'}`,
    empty: 'No workflow files yet. Add one to the workflows folder and it loads on the next start.',
  },
} as const;
