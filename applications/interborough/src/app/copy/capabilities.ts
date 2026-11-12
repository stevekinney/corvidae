import { nameList } from './shared.ts';

/**
 * The words of the Capabilities page (`/capabilities`): the tools and skills agents can use, with
 * what each does, how it is approved by default, where it came from, and which agents use it.
 */
export const CAPABILITIES_COPY = {
  title: 'Capabilities',
  description: 'The tools and skills your agents can use, and who is allowed to use them.',
  tabsLabel: 'Capability kinds',
  tabs: { tools: 'Tools', skills: 'Skills', sources: 'Sources' },
  filterLabel: { tools: 'Filter tools', skills: 'Filter skills', sources: 'Filter sources' },
  filterPlaceholder: 'Filter by name',
  listLabel: { tools: 'Tools', skills: 'Skills', sources: 'Sources' },
  /**
   * The count at the right of a filter field, drawn only while something is typed ("0 of 9 tools",
   * row 32b): the list itself shows no stray count.
   */
  filteredCount: {
    tools: (shown: number, total: number): string => `${String(shown)} of ${String(total)} tools`,
    skills: (shown: number, total: number): string => `${String(shown)} of ${String(total)} skills`,
    sources: (shown: number, total: number): string =>
      `${String(shown)} of ${String(total)} sources`,
  },
  /** What a tab's count reads while its list has not arrived (rows 32f, 32t): a dash, never a zero. */
  tabCountPending: '–',
  detailLabel: { tools: 'Tool details', skills: 'Skill details', sources: 'Source details' },
  emptyDetailTitle: 'Choose a capability',
  emptyDetailDescription: 'Pick one from the list to see what it does and who uses it.',
  tool: {
    loading: 'Loading tools',
    empty: {
      title: 'No tools yet',
      description: 'Agents have no tools to call until the host provides some.',
    },
    filtered: {
      title: 'No tools match',
      description: 'No tool name contains what you typed.',
      clear: 'Clear filter',
    },
    inputs: 'Inputs',
    inputsLabel: (name: string): string => `Inputs of ${name}`,
    noInputs: 'This tool takes no inputs.',
    noSchema: 'This tool does not describe its inputs.',
    users: 'Used by',
    /** Used by when no agent has the tool: one muted line with a link inline, never a centred empty state (rows 30e, 30h, 32j). */
    noUsers: {
      line: 'No agent has this tool yet.',
      action: { label: 'Add to an agent', href: '/agents' },
    },
    tier: {
      'read-only': 'Reads only',
      mutating: 'Changes things',
      dangerous: 'Dangerous',
      unclassified: 'Not classified',
    },
    /**
     * The muted chip row under the description (rows 30a, 30f): the risk, the default asks level and
     * where the tool comes from. Each chip has a tooltip; none is coloured, because risk is said in
     * words and a glyph, never in red.
     */
    chips: {
      label: 'About this tool',
      risk: {
        'read-only': 'Reads',
        mutating: 'Changes things',
        dangerous: 'Dangerous',
        unclassified: 'Not classified',
      },
      riskTooltip: {
        'read-only': 'Looks at things and changes nothing.',
        mutating: 'Changes things in what it reaches.',
        dangerous: 'Can do damage that is hard to undo.',
        unclassified: 'Does not say what it does, so it is treated as one that changes things.',
      },
      asks: (level: string): string => `Asks: ${level}`,
      /** What each default level does, before the four values that follow it. */
      asksTooltip: {
        never: 'Runs without asking.',
        'on-changes': 'Asks before it changes something, and runs a read without asking.',
        always: 'Asks before every call.',
        blocked: 'Never runs.',
      },
      asksValues:
        'The values are Never, On changes, Always and Blocked. A chat’s permission mode never overrides Always or Blocked.',
      /** The source chip: the MCP server a tool of the host's names, or where else it comes from. */
      source: {
        bureau: 'Built in',
        host: (server: string | undefined): string =>
          server === undefined ? 'From an MCP server' : `From ${server}`,
        plugin: (plugin: string): string => `From the ${plugin} plugin`,
        skill: (skill: string): string => `From the ${skill} skill`,
      },
      sourceTooltip: {
        bureau: 'Ships with Interborough, not from a plugin.',
        host: 'Comes from a tool source connected to this host.',
        plugin: 'Comes from a plugin this host runs.',
        skill: 'Brought by a skill.',
      },
    },
    /** The states of one tool's page that nothing old can fill: loading, failing to load and missing (rows 30k to 30m). */
    page: {
      loading: { label: 'Loading this tool', stillLoading: 'Still loading this tool…' },
      failed: {
        title: 'This tool couldn’t be loaded',
        description: 'Interborough didn’t send it back. Nothing changed.',
      },
      notFound: {
        title: 'This tool doesn’t exist',
        description: 'It may have been removed, or the link is wrong.',
        back: 'Back to capabilities',
      },
    },
    /** Where a tool comes from; the host passes Interborough's MCP servers' tools, so its are an MCP server's. */
    sources: {
      host: 'MCP server',
      bureau: 'Built in',
      plugin: (plugin: string): string => `Plugin ${plugin}`,
      skill: (skill: string): string => `Skill ${skill}`,
    },
    loadFailed: {
      title: 'The tools could not be read',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
  },
  skill: {
    loading: 'Loading skills',
    /** First use (row 31y): no skill source is configured, and a plugin is how a skill arrives. */
    empty: {
      title: 'No skills yet',
      description: 'A skill is instructions an agent loads when they apply. Plugins add them.',
      action: { label: 'Add a plugin', href: '/settings/plugins' },
    },
    emptySources: {
      title: 'No skills found',
      description:
        'The host looked in the skills directories it is configured with and found no folder with a SKILL.md file.',
    },
    unavailableBadge: 'Unavailable',
    filtered: {
      title: 'No skills match',
      description: 'No skill name contains what you typed.',
      clear: 'Clear filter',
    },
    /** The muted line under a skill's description (rows 31m, 32v): what it holds, where it is from, when it loads. */
    meta: {
      label: 'About this skill',
      instructionsOnly: 'Instructions only',
      instructionsAndTools: (count: number): string =>
        `Instructions and ${String(count)} ${count === 1 ? 'tool' : 'tools'}`,
      loadedWhenRelevant: 'Loaded when relevant',
    },
    /** The table of the tools a skill ships (row 32v). */
    brings: {
      heading: 'Tools it brings',
      caption: (skill: string): string => `Tools the ${skill} skill brings`,
      columns: { tool: 'Tool', risk: 'Risk', asks: 'Asks' },
    },
    trust: 'Trust',
    source: 'Where it comes from',
    allowedTools: 'Asks to keep these tools',
    users: 'Used by',
    noUsers: {
      title: 'No agent uses this skill',
      description: 'An agent defined in code can name a skill to use it.',
      action: { label: 'Open agents', href: '/agents' },
    },
    notAvailable: 'An agent cannot use this skill yet.',
    untrustedBadge: 'Not trusted',
    trustLabel: {
      trusted: 'Trusted',
      untrusted: 'Not trusted',
      revoked: 'Trust revoked',
    },
    unavailable: {
      'source-untrusted': 'Its source is not trusted, so agents are refused it.',
      'source-revoked': 'Trust in its source was revoked, so agents are refused it.',
      shadowed: 'Another skill with the same name takes its place.',
      invalid: 'Its SKILL.md file is not valid.',
      unreadable: 'The host could not read its files.',
    },
    sourceKinds: {
      project: 'Project',
      user: 'User',
      'built-in': 'Built in',
      remote: 'Remote',
      storage: 'Storage',
      plugin: 'Plugin',
    },
    loadFailed: {
      title: 'The skills could not be read',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
    usersFailed: 'Which agents use each skill could not be read.',
  },
  source: {
    loading: 'Loading tool sources',
    /** First use (rows 31z, 32a): the one primary button on the page, which opens Connect tools. */
    empty: {
      title: 'No sources connected',
      description:
        'Connect an MCP server or an OpenAPI spec, and its tools join Capabilities straight away.',
    },
    filtered: {
      title: 'No sources match',
      description: 'No source name contains what you typed.',
      clear: 'Clear filter',
    },
    loadFailed: {
      title: 'The tool sources could not be read',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
    kinds: { mcp: 'MCP server', openapi: 'OpenAPI spec' },
    states: {
      loaded: 'Connected',
      failed: 'Failed',
      'needs-authorization': 'Needs sign-in',
      'pending-restart': 'Starts next time',
    },
    stateDescriptions: {
      loaded: 'Its tools are in Capabilities and agents can be given them on Access.',
      failed: 'It did not load, so its tools are not available.',
      'needs-authorization': 'Sign in to the server so it can list its tools.',
      'pending-restart': 'It is saved. Its tools are listed when Interborough starts again.',
    },
    facts: {
      kind: 'Kind',
      credentials: 'Stored credentials',
      noCredentials: 'None',
      localCommand: 'Runs a command on this machine',
      localCommandYes: 'Yes',
    },
    signIn: {
      action: 'Sign in',
      opened:
        'Finish signing in in the tab that opened, then restart Interborough to list the tools.',
      already: 'Already signed in. Restart Interborough to list the tools.',
      signedIn: 'Signed in. Restart Interborough to list the tools.',
      savedFirst:
        'It is saved. Sign in to the server, then restart Interborough to list its tools.',
      rejected:
        'The sign-in this source had stored no longer works, so restarting will not list its tools. Sign in again.',
      failed: 'Signing in could not be started',
      blocked: 'The sign-in tab was blocked. Allow pop-ups for this page and try again.',
    },
    tools: {
      heading: 'Tools',
      empty: {
        title: 'No tools listed yet',
        description: 'A source lists its tools once it has connected.',
      },
      open: (name: string): string => `Open ${name} in Tools`,
      standing: { 'asks-first': 'Asks you first', runs: 'Runs without asking', blocked: 'Blocked' },
      standingLabel: 'By default',
      /** The always-editable tool table (rows 32l, 32r): its caption and column heads. */
      caption: (source: string): string => `Tools of ${source}`,
      columns: { on: 'On', tool: 'Tool', risk: 'Risk', asks: 'Default asks' },
      /** The name of a tool's On checkbox, which has no visible label of its own. */
      onLabel: (tool: string): string => `On: ${tool}`,
      /** The name of a tool's Default asks select, which has no visible label of its own. */
      asksLabel: (tool: string): string => `Default asks: ${tool}`,
      /** The line under the table that says a change was kept (row 32r); empty until one is. */
      saved: 'Saved',
      /** The note under the table (row 31r): how many are on, then what a source offers. */
      note: (on: number, total: number): string =>
        `${String(on)} of ${String(total)} ${total === 1 ? 'tool is' : 'tools are'} on. A source offers On or Off and a default Asks level; Blocked is a per-agent override. Agents get tools on each agent’s Access tab.`,
      /** Under the table of a source that needs a sign-in (row 31u): its rows stay, muted. */
      paused: 'Tools are paused until you sign in again.',
      acceptsSecrets: 'Accepts secrets',
      acceptsSecretsLabel: (tool: string): string => `Accepts secrets: ${tool}`,
      acceptsSecretsHelp:
        'A tool that accepts secrets may receive the plaintext of an answer a person marks secret. Leave it off unless the tool needs the secret.',
      takesEffect: 'Takes effect when Interborough starts again',
      saveFailed: 'The setting could not be saved',
      locked: 'This host keeps its configuration in its deployment, so it cannot be changed here.',
    },
    /** What a refusal says when the host sent no words of its own. */
    refusal: {
      locked: 'This host keeps its configuration in its deployment, so it cannot be changed here.',
      exists: 'A source with that name is already saved.',
      'owner-only': 'Only the owner can do this.',
      'not-found': 'The host has no such source.',
      invalid: 'The host did not accept the value.',
      partial: 'The host made only part of the change.',
      failed: 'The host could not make the change.',
    },
    skipped: {
      heading: 'Tools the host does not list',
      reason: (tool: string, reason: string): string => `${tool}: ${reason}`,
    },
    unmatched: {
      heading: 'Settings that reach no tool',
      description:
        'These saved settings name a tool the server does not list. Nothing is applied to a different tool.',
    },
    /** The Connect tools page at `/capabilities/connect` (`connect-tools.svelte`). */
    connect: {
      action: 'Connect tools',
      /** The page's heading and the last crumb of its breadcrumb (rows 33a, 33c). */
      title: 'Connect tools',
      intro:
        'Add an MCP server or an OpenAPI spec. Its tools are available to agents straight away, with no restart.',
      /** The page's sections, in order (row 33d). */
      sections: {
        source: 'Source',
        address: 'Address',
        signIn: 'Sign in',
        /** Sign in for an OpenAPI spec, which also holds the Base URL (row 33u). */
        baseUrlAndSignIn: 'Base URL and sign in',
        test: 'Test connection',
        chooseTools: 'Choose tools',
      },
      kind: { label: 'What kind of source', mcp: 'MCP server', openapi: 'OpenAPI spec' },
      /** What a person calls the source; the identifier it is saved under is made from it (row 33f). */
      name: {
        label: 'Name',
        description:
          'Filled in after the test; change it if you like. Shown in Capabilities and on each tool.',
        /** The help under Name for an OpenAPI spec, whose title fills it in (rows 33t, 34r). */
        fromSpec: 'Prefilled from the spec’s title. Shown in Capabilities and on each tool.',
        placeholder: 'GitHub',
      },
      transport: { label: 'How Interborough reaches it', http: 'URL', stdio: 'Command' },
      url: {
        label: 'Server URL',
        description: 'Streamable HTTP.',
        placeholder: 'https://mcp.example.com/mcp',
      },
      /** The one-line command of a local server, and the warning under it (rows 33o, 33p). */
      command: {
        label: 'Command',
        placeholder: 'npx -y @example/server',
        warningLabel: 'Runs on this machine',
        warningBefore:
          'This runs on this machine as you, with access to your files. Testing the connection runs the command, and ',
        warningCode: 'npx -y',
        warningAfter:
          ' downloads code before it starts. Interborough starts it with the server and stops it when the server stops.',
      },
      specification: { label: 'Where the document is', url: 'A URL', file: 'A file' },
      specificationUrl: {
        label: 'Spec address',
        description: 'The address of the OpenAPI document.',
        placeholder: 'https://example.com/openapi.json',
      },
      file: {
        label: 'Spec',
        description: 'A JSON or YAML file of up to 3 MB.',
        chosen: (name: string): string => `Using ${name}`,
        tooLarge: 'That file is larger than 3 MB.',
        unreadable: 'That file could not be read.',
      },
      /**
       * Reading the spec before it is connected (rows 34s, 34u, 34v): fetching it from its address,
       * and what a spec that reads says about itself. The summary's parts are drawn side by side,
       * each its own element, and never joined by a separator character.
       */
      spec: {
        fetching: 'Fetching the spec…',
        cancel: 'Cancel',
        summaryLabel: 'What the spec holds',
        version: (version: string): string => `OpenAPI ${version}`,
        operations: (count: number): string =>
          count === 1 ? '1 operation' : `${String(count)} operations`,
        failed: 'The spec could not be read',
      },
      baseUrl: {
        label: 'Base URL',
        description: 'Read from the spec. Change it to point at another environment.',
        placeholder: 'https://api.example.com',
      },
      /** Sign in's choices (rows 33g, 34q): OAuth carries the muted note beside its label. */
      authentication: {
        label: 'How it signs in',
        none: 'None',
        bearer: 'Bearer token',
        oauth: 'OAuth',
        oauthNote: 'opens the provider',
        'api-key': 'API key in a header',
        oauthHelp:
          'You sign in to the provider from the source’s page once it is connected. Interborough keeps the tokens it receives.',
      },
      secret: {
        bearer: { label: 'Token' },
        'api-key': { label: 'API key' },
        description: 'Stored on this machine; never shown again.',
      },
      header: {
        label: 'Header name',
        description: 'The header the key is sent in.',
        placeholder: 'x-api-key',
      },
      probe: {
        action: 'Test connection',
        /** The Test button while the test runs (row 34i). */
        testing: 'Testing…',
        /** The note beside it while the test runs: the host it contacts (row 34i). */
        contacting: (where: string): string => `Contacting ${where}…`,
        /** The note while a local command is started for the test. */
        starting: 'Starting the command…',
        /** A test that passed: a green dot and this word, then how many tools it found (row 34w). */
        connected: 'Connected',
        found: (count: number): string =>
          count === 1 ? 'Found 1 tool' : `Found ${String(count)} tools`,
        skipped: (count: number): string =>
          `${String(count)} of its tools cannot be offered under a name an agent can use.`,
        needsAuthorization:
          'The server is there and asks you to sign in. Connect it, then sign in from its page.',
        failedTitle: 'It did not answer',
        failed: 'The source could not be tested',
        /** Under a test that failed (row 34n). */
        kept: 'Nothing is saved until you connect. Your address and name stay filled in.',
        /** Beside an inert Test connection while the server does not answer (row 35f). */
        offline: 'Off while Interborough can’t be reached.',
        /**
         * Beside Test connection for an OpenAPI spec (rows 33v, 34r): the one read the test makes
         * with the key, so a wrong key shows before Connect.
         */
        calls: (operation: string, method: string, path: string): string =>
          `Calls ${operation} (${method} ${path}) with the key above, so a wrong key shows now.`,
        /** For a spec that has no read the test can make without input. */
        callsNothing: 'The spec has no read that needs no input, so the test reads the spec only.',
      },
      /** Choose tools (rows 33i, 33m, 34w, 33w, 33y). */
      chooseTools: {
        /** The line above the list, and above the dashed box before a test passes (row 33m). */
        intro: 'Pick what agents may use, and when each asks.',
        /** Added to the intro once tools are listed (row 33i). */
        hints: 'The server’s own hints set the starting values; a Dangerous tool starts on Always.',
        /** Before a test has listed any (row 33m). */
        locked: 'Test the connection to list its tools.',
        /** A server that answered and lists none (row 34w). */
        none: 'The server answered but offers no tools. Check that it exposes tools, then test again.',
        /**
         * The legend of the four levels (row 33i), each word in bold before what it does. The items
         * are drawn side by side as a list, never joined by a separator character.
         */
        legendLabel: 'What each level means',
        legend: [
          { word: 'Never', means: 'runs without asking' },
          { word: 'On changes', means: 'asks unless a chat allows all' },
          { word: 'Always', means: 'asks every time' },
          { word: 'Blocked', means: 'never runs' },
        ],
        caption: (source: string): string => `Tools ${source} offers`,
        columns: { on: 'On', tool: 'Tool', risk: 'Risk', asks: 'Asks' },
        /** The name of a tool's On checkbox, whose column head is its visible label. */
        onLabel: (tool: string): string => `On: ${tool}`,
        /** The name of a tool's Asks select, whose column head is its visible label. */
        asksLabel: (tool: string): string => `Asks: ${tool}`,
        /** An OpenAPI spec's operations (rows 33w, 33y). */
        operations: {
          found: (count: number): string =>
            `Found ${String(count)} ${count === 1 ? 'operation' : 'operations'}. Reads start on and changes start off. A Dangerous operation starts on Always.`,
          filterLabel: 'Filter operations',
          riskLabel: 'Show operations that',
          all: 'All',
          selected: (on: number, total: number): string =>
            `${String(on)} of ${String(total)} selected`,
          selectAll: (total: number): string => `Select all ${String(total)}`,
          /** Under a list longer than it shows at once. */
          showing: (shown: number, total: number): string =>
            `Showing ${String(shown)} of ${String(total)}. Scroll the list for the rest.`,
          noMatch: 'No operation matches the filter.',
        },
      },
      /**
       * The footer's summary before a test has passed (row 33n), and for a local command, whose
       * Connect runs the test first (row 33r), as it does while a test runs (row 34j).
       */
      chooseFirst: 'Test the connection to choose tools.',
      testsFirst: 'Connect tests the connection first.',
      /** The footer's summary once tools are chosen (rows 33y, 34c), and for a source with none (row 34x). */
      joins: (count: number, name: string): string =>
        count === 0
          ? `${name} will join Capabilities with no tools.`
          : `${String(count)} ${count === 1 ? 'tool' : 'tools'} from ${name} will join Capabilities.`,
      /** The footer while Connect runs (rows 34a, 34z): the line, what it adds after 15 s, and the button. */
      connecting: (name: string): string => `Connecting ${name}…`,
      slow: 'Taking longer than usual',
      /** The footer while the server does not answer (row 35f). */
      offline: 'Connect is off while Interborough can’t be reached.',
      /** What the page says while the host keeps its configuration in its deployment. */
      locked:
        'This host keeps its configuration in its deployment, so a source cannot be connected here.',
      actions: {
        connect: 'Connect',
        /** Connect once tools are chosen (rows 33y, 34c). */
        connectCount: (count: number): string =>
          count === 1 ? 'Connect 1 tool' : `Connect ${String(count)} tools`,
        connecting: 'Connecting…',
        cancel: 'Cancel',
      },
      /** A connect that failed after a passing test (row 34b), with what was kept. */
      connectFailed: {
        lead: 'Couldn’t connect.',
        stopped: 'The server stopped answering after the test passed.',
        kept: 'Nothing was saved; your choices are kept.',
        retry: 'Try again',
      },
      /** A source already saved at the address typed (row 34e). */
      duplicate: (name: string): string =>
        `${name} is already connected at this address. Use another address, or remove that source first.`,
      /** After connecting (rows 34f, 34g, 34h). */
      success: {
        title: (name: string): string => `${name} is connected`,
        /** `on` tools on; `off` the names of the tools left off. */
        line: (on: number, off: readonly string[]): string => {
          const available =
            on === 1 ? '1 tool is available now' : `${String(on)} tools are available now`;
          const left =
            off.length === 0 ? '' : `; ${nameList(off)} ${off.length === 1 ? 'is' : 'are'} off`;
          return `${available}${left}. No restart needed.`;
        },
        /** For a host that loads the source only when it starts again. */
        restart: (on: number): string =>
          `${on === 1 ? '1 tool is' : `${String(on)} tools are`} saved. Restart Interborough to list them.`,
        listLabel: 'What you chose',
        off: 'Off',
        give: 'Give to an agent',
        view: 'View in Capabilities',
      },
      /** The picker "Give to an agent" opens (rows 35c, 35d). */
      give: {
        title: (name: string): string => `Give ${name}’s tools to which agent?`,
        opens: 'Opens its Access tab',
        loading: 'Reading the agents',
        failed: 'The agents could not be read.',
        none: 'No agent can take new tools. An agent defined in code or shipped by a plugin keeps the tools it states.',
        cancel: 'Cancel',
      },
      /** Asked before a filled form is left (rows 35b, 35f). */
      leave: {
        title: 'Leave without connecting?',
        description: 'Nothing you filled in is saved. Leaving discards it.',
        keep: 'Keep editing',
        discard: 'Discard and leave',
      },
      failed: 'The source could not be connected',
      exists: (id: string): string =>
        `A source named ${id} is already saved. Choose another name, or remove it first.`,
      errors: {
        idRequired: 'Give the source a name.',
        /** A name with no letter, which the identifier it is saved under has to start with. */
        nameInvalid: 'Start the name with a letter.',
        idInvalid: 'Use 1 to 20 lowercase letters, digits or hyphens, starting with a letter.',
        urlRequired: 'Enter the server’s URL.',
        commandRequired: 'Enter the command to run.',
        specificationUrlRequired: 'Enter the document’s URL.',
        /** An OpenAPI spec's Base URL, which the spec's first server fills in (row 33u). */
        baseUrlRequired: 'Enter the base URL.',
        documentRequired: 'Choose an OpenAPI file.',
        documentInvalid: 'That file is not a JSON object.',
        secretRequired: {
          bearer: 'Enter the bearer token.',
          'api-key': 'Enter the API key.',
        },
        headerRequired: 'Enter the header the key is sent in.',
      },
    },
    /** The line under the heading that says where the source stands (rows 31o, 32k): a dot and a word, then muted facts. */
    status: {
      label: 'Source status',
      /** How the source signs in, when the host says: an OAuth source, or one that holds a stored credential. */
      auth: { oauth: 'OAuth sign-in', credentials: 'Credential stored' },
      lastTested: (ago: string): string => `last tested ${ago}`,
    },
    /** The ⋯ menu beside Test connection (row 32m): its button's name, and its entries in order. */
    menu: {
      label: 'More about this source',
      edit: 'Edit connection',
      /** Editing a saved connection happens on the Connect tools page, which does not read a saved source yet. */
      editUnavailable: 'Editing a saved connection is not available yet.',
      test: 'Test connection',
      remove: 'Remove source…',
    },
    /** Test connection on a saved source (rows 32i, 32q): in flight, passed, asked to sign in, and failed. */
    test: {
      action: 'Test connection',
      again: 'Test again',
      testing: (name: string): string => `Testing ${name}…`,
      /** Added after 15 seconds, as Connect tools says it. */
      slow: 'Taking longer than usual',
      passed: (name: string, count: number): string =>
        count === 0
          ? `Reached ${name}. It lists no tools.`
          : count === 1
            ? `Reached ${name}. It lists 1 tool.`
            : `Reached ${name}. It lists ${String(count)} tools.`,
      needsAuthorization: 'It answered and asks you to sign in. Sign in, then test again.',
      failedTitle: (name: string): string => `Couldn’t reach ${name}`,
      /** `where` is the source’s address, or its name when it has none. */
      failedBody: (where: string): string => `${where} didn’t answer.`,
      failedSlow: 'The test showed “Taking longer than usual” after 15 s, then stopped.',
      toolsKept: 'Its tools stay as they were.',
      refused: 'The connection could not be tested',
    },
    /** The restart that lists the tools of the sources saved since the host started (`restart-banner.svelte`). */
    restart: {
      title: (count: number): string =>
        count === 1
          ? '1 source is saved and not running yet'
          : `${String(count)} sources are saved and not running yet`,
      description:
        'Their tools join Capabilities when Interborough starts again. Restarting stops anything in progress for a moment.',
      action: 'Restart Interborough',
      progress: {
        requesting: 'Asking Interborough to restart',
        stopping: 'Interborough is stopping',
        starting: 'Interborough is starting again',
      },
      back: 'Interborough is back. The tools of the sources it loaded are in Capabilities.',
      unconfirmed:
        'Interborough did not restart. Nothing supervises it, or the restart failed. Start it again yourself to list the tools.',
      refusal: {
        locked:
          'This host keeps its configuration in its deployment, so it cannot be restarted here.',
        refused: 'Interborough would not restart.',
        unreachable: 'Interborough could not be reached to ask it to restart.',
      },
    },
    remove: {
      action: 'Remove source…',
      title: (id: string): string => `Remove ${id}?`,
      intro:
        'Its credentials are cleared and it leaves the list at once. Its tools stop running now, and leave Capabilities when Interborough starts again.',
      agentsHeading: 'Agents that name its tools',
      agentsIntro:
        'These agent files are not edited. Each reads invalid until the tool is taken out of it.',
      noAgents: 'No agent names its tools.',
      previewFailed: 'Which agents use its tools could not be read.',
      confirm: 'Remove',
      cancel: 'Keep it',
      removed: (id: string, agents: readonly string[]): string =>
        agents.length === 0
          ? `Removed ${id}. It is gone from the list, and its tools stop running now.`
          : `Removed ${id}. It is gone from the list, and its tools stop running now. Agents that still name them (${agents.join(', ')}) read invalid until you take them out.`,
      partial: 'The source was removed, but its cleanup was not finished',
      failed: 'The source could not be removed',
      agentTools: (tools: readonly string[]): string => tools.join(', '),
    },
  },
} as const;
