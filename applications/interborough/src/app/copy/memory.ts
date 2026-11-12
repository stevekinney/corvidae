/** The deletion states `bureau.memory.forget` answers with, in the receipt's own vocabulary. */
export type MemoryDeletionState = 'completed' | 'pending' | 'exempt' | 'failed' | 'unknown';

/**
 * The words of an agent's Memory tab (`/agents/:agent/memory`): the list, the search, one memory's
 * lineage, and what forgetting and correcting answer. The tab's first load and a first read that
 * fails are worded as every tab's are (`AGENT_PAGE_COPY.tabState`), and not found is the Agents
 * view's (`VIEW_COPY.agents`).
 */
export const MEMORY_COPY = {
  /** The link on an agent's page that opens its memory. */
  link: 'Memory',
  heading: 'Memories',
  listLabel: 'What this agent remembers',
  searchLabel: 'Search memories',
  searchPlaceholder: 'Search memories',
  clearSearch: 'Clear search',
  loadMore: 'Load more',
  loading: 'Loading memories',
  listFailed: 'The memories could not be loaded.',
  /** Under an open memory the list or search does not hold, which the list leads with. */
  pinnedNote: 'Open now, not in this list',
  noContent: 'This memory has no text.',
  relevance: 'Relevance',
  /**
   * What a search found. The server ranks every memory the agent has and has no score floor, so a
   * memory matches when it holds a word of the query, and its relevance only orders the matches.
   * `total` is the agent's memory count when every page of it has been read, and `more` says the
   * search filled its page, so more may match than are shown, unless every memory already does.
   */
  matchCount: (matched: number, total: number | undefined, more: boolean): string => {
    const plus = more && matched !== total ? '+' : '';
    return total !== undefined
      ? `${matched}${plus} of ${total} ${total === 1 ? 'memory matches' : 'memories match'}`
      : `${matched}${plus} ${matched === 1 && plus === '' ? 'memory matches' : 'memories match'}`;
  },
  /**
   * The list is empty because the agent has no memory (board PageMemory, "First use"). Its Add a
   * memory is the page's one primary button, so the header's Add and Export are hidden meanwhile.
   */
  nothing: {
    title: 'This agent remembers nothing',
    description:
      'A memory is saved when the agent answers in a chat, and you can add one in your own words.',
  },
  /** The list is empty because a search matched nothing. */
  noMatch: {
    title: (query: string): string => `No memory matches “${query}”`,
    description: 'Try other words, or show every memory.',
  },
  /** The list is empty because no loaded memory is of the kind, or by the writer, chosen. */
  noFiltered: {
    title: 'No loaded memory matches these filters',
    description: 'Show every memory to see them again.',
  },
  /** The action under an empty search that lists everything again. */
  clearMatch: 'Show all memories',
  /** The Back button above the open memory where it replaces the list. */
  backToList: 'Back to memories',
  /** What the empty detail says while no memory is open. */
  nothingOpen: {
    title: 'No memory open',
    description: 'Choose a memory to read it, correct it, forget it or see where it came from.',
  },
  /**
   * The two filters over the list, each a single-choice select that reads "Kind: All" and
   * "Written by: Anyone" (board PageMemory). They filter the memories loaded so far, not every
   * memory the agent has, and say so.
   */
  filter: {
    kindLabel: 'Kind',
    writerLabel: 'Written by',
    kind: { all: 'Kind: All', fact: 'Kind: Fact', howTo: 'Kind: How-to' },
    writer: {
      all: 'Written by: Anyone',
      you: 'Written by: You',
      agent: (agent: string): string => `Written by: ${agent}`,
    },
    /** The line under the filters while one is on: it works over the loaded pages only. */
    note: (shown: number, loaded: number, more: boolean): string =>
      `${shown} of the ${loaded}${more ? ' loaded so far' : ''} ${loaded === 1 ? 'memory matches' : 'memories match'} these filters.${
        more ? ' Load more to look further.' : ''
      }`,
  },
  /** What a memory is: a person tells a fact from a how-to, and nothing finer. */
  kind: { fact: 'Fact', 'how-to': 'How-to' },
  /**
   * Who wrote a memory, as line two of a row says it ("From you") and as the detail says it
   * ("Written by You"). An agent's memory is written by the agent, named where it is shown.
   */
  writer: {
    person: { row: 'you', detail: 'You' },
    system: { row: 'the system', detail: 'The system' },
  },
  /** `From <writer>` on line two of a row. */
  from: (writer: string): string => `From ${writer}`,
  /**
   * When a memory was written, from the clock's day: a row says "Just now", the time for today
   * ("10:42 AM"), "Yesterday" or the day ("Oct 21"); the detail's line says the same after
   * "remembered".
   */
  when: {
    justNow: 'Just now',
    yesterday: 'Yesterday',
    /** The detail's line, after "remembered": `today at 10:42 AM`. */
    today: (clock: string): string => `today at ${clock}`,
  },
  /** The detail's context line: `Fact, remembered yesterday`. Parts are joined by commas, never a middle dot. */
  remembered: (kind: string, when: string): string => `${kind}, remembered ${when}`,
  detail: {
    heading: 'Memory details',
    loading: 'Loading this memory',
    failed: 'This memory could not be loaded.',
    notFound: {
      title: 'This memory was not found',
      description: 'It may have been forgotten, or it may not be yours.',
    },
    content: 'Memory',
    /** The label/value rows below the text. Trust is not drawn: it follows from who wrote the memory. */
    fields: {
      cameFrom: 'Came from',
      writtenBy: 'Written by',
      history: 'History',
      legalHold: 'Legal hold',
    },
    /** The value of Came from, shown only for a memory someone other than you wrote. */
    cameFrom: {
      chat: (title: string): string => `Chat “${title}”`,
      untitled: 'Untitled chat',
      deleted: 'A chat that was deleted',
      notRecorded: 'Not recorded',
      /** When the chat could not be read for a reason other than being deleted. */
      openChat: 'Open chat',
    },
    /** The value of History: what a correction replaced, and what replaced this memory. */
    history: {
      none: 'Not corrected.',
      corrects: (content: string): string => `Corrects an earlier memory: “${content}”`,
      correctsUnread: 'Corrects an earlier memory.',
      original: 'View the original',
      correctedBy: 'A later memory corrects this one.',
      correction: 'View the correction',
    },
    /** The legal hold is shown only once it is known: from a hold, a release, or a refused forget. */
    legalHold: {
      held: 'Held: this memory stays stored',
      free: 'Not held',
    },
    /** The disclosure under the facts that holds sharing, the legal hold and quarantine. */
    more: 'More options',
  },
  forget: {
    action: 'Forget',
    /** The name of the icon button that forgets the open memory. */
    iconLabel: 'Forget this memory',
    dialog: {
      title: 'Forget this memory?',
      description: (excerpt: string): string =>
        `The agent stops recalling “${excerpt}”, and it leaves this list and search. A copy of it that a chat already saved is not scrubbed.`,
      confirm: 'Forget memory',
    },
    /** The words for each state the deletion can answer with. */
    outcome: {
      completed: {
        title: 'Memory forgotten',
        description:
          'It no longer appears in this list, in search, or in what the agent recalls. A copy of it that a chat already saved is not scrubbed.',
      },
      exempt: {
        title: 'This memory is under a legal hold',
        description: 'It stays stored and listed. Forgetting it resumes when the hold is released.',
      },
      pending: {
        title: 'Forgetting has not finished',
        description:
          'The server started removing this memory and has not confirmed it. Check again shortly.',
      },
      failed: {
        title: 'The memory was not removed',
        description:
          'The step that removes it failed, so it is still stored. Forget it again to retry.',
      },
      unknown: {
        title: 'The result could not be confirmed',
        description:
          'The server could not say whether this memory was removed. Check the list, and forget it again if it is still there.',
      },
    } satisfies Record<MemoryDeletionState, { title: string; description: string }>,
    receiptLabel: 'What the deletion reached',
    targets: {
      'source-evidence': 'The memory itself',
      'canonical-projections': 'Projections of it',
      'identity-views': 'Identity views',
      'managed-asset-record': 'Managed asset record',
      indexes: 'The search index',
      caches: 'Caches',
      summaries: 'Summaries made from it',
      'managed-asset-bytes': 'Managed asset files',
      'durable-snapshots': 'Chats that saved a copy',
      exports: 'Exports',
      'external-processors': 'Outside processors',
    },
    targetStatus: {
      completed: 'Done',
      pending: 'Waiting',
      exempt: 'Held',
      failed: 'Failed',
      unknown: 'Unknown',
    } satisfies Record<MemoryDeletionState, string>,
    failed: 'The memory was not forgotten',
  },
  add: {
    action: 'Add a memory',
    /** The dialog over a scrim (board PageMemory, "Add a memory"): the agent is named by its own name. */
    dialog: {
      title: 'Add a memory',
      description: (agent: string): string =>
        `${agent} reads this in every chat. You can correct or forget it later.`,
      label: (agent: string): string => `What should ${agent} remember?`,
      hint: 'Saved as From you.',
      kind: { label: 'Kind', fact: 'Fact', howTo: 'How-to' },
      /** At the field when Add memory is pressed with nothing written: nothing is saved. */
      empty: (agent: string): string => `Write what ${agent} should remember.`,
      submit: 'Add memory',
      /** The primary button once a save failed. */
      retry: 'Try again',
      cancel: 'Cancel',
    },
    /** The toast after a save, with Undo, which forgets the memory just added. */
    saved: (agent: string): string => `Memory added. ${agent} uses it from its next chat.`,
    /** What the page says when the Undo does not go through. */
    undoFailed: 'Couldn’t undo. The memory stays.',
    /** The title of a refusal the Bureau gave its own words for. */
    notSaved: 'Couldn’t save the memory',
    /**
     * The reason under a failed save, in the dialog or in the correction's form: the status the
     * server answered with, and that what was typed is kept.
     */
    stillHere: {
      server: (status: number): string =>
        `The server answered with an error (${String(status)}). What you typed is still here.`,
      unreached: 'The server did not answer. What you typed is still here.',
    },
    /** Text the content rules flagged: stored for inspection, in no list, and the agent never recalls it. */
    held: {
      title: 'The text was held back',
      description:
        'Interborough’s content rules flagged it, so the agent will not recall it. A copy is still stored for inspection until you remove it. Remove it, or reword the text and save again: saving again removes the held copy first.',
      remove: 'Remove the held copy',
      removing: 'Removing…',
      notRemoved: {
        title: 'The held copy was not removed',
        description:
          'The server did not confirm the removal, so the copy is still stored. Try removing it again.',
      },
    },
    refusal: {
      'not-admitted': {
        title: 'The memory was not accepted',
        description:
          'Interborough’s content rules or this agent’s memory limit refused it, so nothing was saved. Reword it and try again.',
      },
      'not-found': {
        title: 'This agent was not found',
        description: 'It may have been deleted, or it may not be yours to change.',
      },
    },
  },
  correct: {
    action: 'Correct',
    /** The name of the icon button that edits the open memory in place. */
    iconLabel: 'Correct this memory',
    edit: {
      description: 'The original stays in History.',
      label: 'Memory',
      submit: 'Save correction',
      /** The primary button once a save failed. */
      retry: 'Try again',
      cancel: 'Cancel',
    },
    /** The page-level report of a correction that was refused: its title leads, then the words the person wrote. */
    notSaved: {
      title: 'Couldn’t save the correction',
      draftLabel: 'What you wrote',
      editAgain: 'Edit it again',
    },
    saved: {
      title: 'Memory corrected',
      description:
        'The agent now recalls your correction in place of the old memory. The old one is kept in its history.',
    },
    refusal: {
      superseded: {
        title: 'This memory was already corrected',
        description: 'Open its correction from the list to change it again.',
      },
      'successor-not-admitted': {
        title: 'The correction was not accepted',
        description:
          'Interborough’s content rules or this agent’s memory limit refused it, so nothing changed. Reword it and try again.',
      },
      forbidden: {
        title: 'Changing memory is locked',
        description:
          'Adding, correcting or forgetting a memory needs the bureau.memory:write scope.',
      },
      'not-found': {
        title: 'This memory was not found',
        description: 'It may have been forgotten, or it may not be yours.',
      },
      other: { title: 'Couldn’t save the correction', description: '' },
    },
  },
  /** Sharing, holding, quarantining and exporting: each is recorded in the memory ledger. */
  govern: {
    heading: 'Sharing and governance',
    recorded: 'The memory ledger records this.',
    share: {
      action: 'Share',
      dialog: {
        title: 'Share this memory',
        description: (excerpt: string): string =>
          `Another owner you name can read “${excerpt}”, and nothing else of it: they cannot list, search, correct, forget or share it again.`,
        label: 'Owner to share with',
        submit: 'Share memory',
        revoke: 'Stop sharing',
        cancel: 'Cancel',
      },
      outcome: {
        granted: {
          title: 'Memory shared',
          description: (owner: string): string => `${owner} can now read it.`,
        },
        alreadyGranted: {
          title: 'Already shared',
          description: (owner: string): string => `${owner} could already read it.`,
        },
        revoked: {
          title: 'Sharing stopped',
          description: (owner: string): string => `${owner} can no longer read it.`,
        },
        notShared: {
          title: 'It was not shared',
          description: (owner: string): string => `${owner} could not read it, so nothing changed.`,
        },
      },
    },
    hold: {
      place: 'Place legal hold',
      release: 'Release legal hold',
      outcome: {
        placed: {
          title: 'Legal hold placed',
          description:
            'Forgetting this memory, and the retention sweep, leave it stored until the hold is released.',
        },
        alreadyPlaced: {
          title: 'Already on legal hold',
          description: 'It stays stored until the hold is released.',
        },
        released: {
          title: 'Legal hold released',
          description: 'A forget that was waiting on the hold now goes ahead.',
        },
        notHeld: {
          title: 'It was not on legal hold',
          description: 'Nothing changed.',
        },
      },
    },
    quarantine: {
      action: 'Quarantine',
      dialog: {
        title: 'Quarantine this memory?',
        description: (excerpt: string): string =>
          `“${excerpt}” and anything derived from it is taken out of use: it is no longer listed, searched, read or recalled. This cannot be undone. It stays stored for inspection, and forgetting it still removes it.`,
        reasonLabel: 'Why is it quarantined?',
        confirm: 'Quarantine memory',
        cancel: 'Cancel',
      },
      outcome: {
        done: {
          title: 'Memory quarantined',
          description: (affected: number): string =>
            `${affected} ${affected === 1 ? 'record was' : 'records were'} taken out of use.`,
        },
        already: {
          title: 'Already quarantined',
          description: 'Nothing changed.',
        },
      },
    },
    export: {
      action: 'Export',
      /** The button while the export runs. */
      exporting: 'Exporting…',
      /**
       * The self-dismissing toast once the file is saved, under the name the server gave it
       * (`<agent>-memories.json`). Parts are joined by a comma, never a middle dot.
       */
      done: (count: number, fileName: string): string =>
        `Exported ${String(count)} ${count === 1 ? 'memory' : 'memories'}, ${fileName}`,
    },
    failed: 'That change was not made',
    refusal: {
      forbidden: {
        title: 'This is locked',
        description:
          'Sharing and quarantine need the bureau.memory:write scope, and a legal hold needs bureau.memory:govern.',
      },
      'invalid-grantee': {
        title: 'That owner cannot be shared with',
        description: 'Name another owner: not this memory’s own owner, and not nobody.',
      },
      'not-found': {
        title: 'This memory was not found',
        description: 'It may have been forgotten, or it may not be yours.',
      },
    },
  },
} as const;
