/**
 * The words and shapes of the showcase content (`showcase-seed.ts`): what a design review sees on
 * every page when the host holds a normal day's data. Typical lengths, with a few long but
 * plausible values (a 100-character agent description, a six-paragraph set of instructions, a
 * twelve-message chat). No literal holds an unbroken run of more than 40 non-space characters,
 * which `tests/showcase-routes.test.ts` checks over everything exported here; the stress seed
 * (`tests/e2e/responsive.spec.ts`) is where overflow and truncation are exercised.
 *
 * Every identifier carries the prefix `showcase-` or is a plain agent or workflow name that no
 * other fixture uses, so the seed finds its own records and nothing else's.
 *
 * @module showcase-content
 */

/** One agent file: the identifier is the file name, and `memories` are what it remembers. */
export interface ShowcaseAgent {
  readonly id: string;
  readonly definition: Readonly<Record<string, unknown>>;
  readonly memories?: readonly string[];
}

/** The agents, each with a description and instructions of its own. */
export const SHOWCASE_AGENTS: readonly ShowcaseAgent[] = [
  {
    id: 'release-notes-writer',
    definition: {
      name: 'Release notes writer',
      description:
        'Drafts release notes from merged pull requests, grouped by area and written for customers.',
      model: 'anthropic/sonnet',
      defaultEffort: 'medium',
      tools: ['bureau:discover-agents'],
      skillDescriptors: [
        {
          id: 'draft-notes',
          name: 'Draft release notes',
          description: 'Turns a list of merged pull requests into customer-facing release notes.',
          tags: ['writing', 'releases'],
          examples: ['Draft the notes for version 2.4'],
        },
      ],
      instructions: [
        'You write release notes for a developer tool. Readers are customers, not the team that built it, so lead with what changed for them and leave the internal history out.',
        'Group the changes under Features, Fixes, and Breaking changes, in that order. Skip a group that has nothing in it. Each entry is one sentence in the past tense, and links to the pull request.',
        '- Name the user-visible behavior, not the file that changed.\n- Put a breaking change first in its group and say what to do about it.\n- Never invent a change that is not in the list you were given.',
        'When a pull request has no description, say what you could not tell from it instead of guessing. Finish with a short thank-you line for outside contributors.',
      ].join('\n\n'),
    },
  },
  {
    id: 'support-triage',
    definition: {
      name: 'Support triage',
      description:
        'Reads incoming support requests, looks up the order, and routes each one to the right queue with a short summary.',
      model: 'anthropic/sonnet',
      a2a: true,
      tools: ['demo:lookup-order', 'demo:issue-refund'],
      toolApproval: { 'demo:issue-refund': 'always' },
      toolBudget: { maxCalls: 12, maxDurationSeconds: 300 },
      skillDescriptors: [
        {
          id: 'route-request',
          name: 'Route a request',
          description: 'Decides which queue a support request belongs in and why.',
          tags: ['support'],
        },
      ],
      instructions: [
        'You triage support requests for an online store. For each request, look the order up first, then decide which queue it belongs in: billing, shipping, returns, or account access.',
        'Write the summary for the person who picks the request up, in two sentences at most. State what the customer wants, what you found on the order, and anything that is urgent.',
        'You may propose a refund, but you never issue one on your own: the refund tool always waits for a person to approve it. Say so to the customer, plainly, and do not promise a date.',
        'Be kind and be brief. If the customer is angry, acknowledge it once and move on to what happens next.',
      ].join('\n\n'),
    },
    memories: [
      'Refunds over $500 need a second approver, so route them to the finance queue.',
      'Customers on the Business plan expect a reply within four hours, including weekends.',
      'Order lookups are read-only. Never promise a refund before it has been approved.',
    ],
  },
  {
    id: 'incident-summarizer',
    definition: {
      name: 'Incident summarizer',
      description:
        'Turns a noisy incident channel into a timeline, the customer impact, and the open follow-ups.',
      model: 'anthropic/claude-haiku-4-5',
      stepLimit: 12,
      costBudget: { perRunUsd: 0.5, perChatUsd: 2 },
      skillDescriptors: [],
      instructions: [
        'You summarize incidents after the fact. You are given the messages of an incident channel, oldest first, and you write the summary a manager reads on Monday morning.',
        'Open with one sentence on customer impact: who was affected, for how long, and whether it is resolved. Then give a timeline of at most ten lines, each starting with the time.',
        'End with the follow-ups that are still open, each with an owner if the channel named one. If nobody was named, write "no owner yet" rather than guessing.',
      ].join('\n\n'),
    },
  },
  {
    id: 'code-review-assistant',
    definition: {
      name: 'Code review assistant',
      description:
        'Reviews a pull request for correctness, missing tests, and risky changes, and explains each finding.',
      model: 'anthropic/sonnet',
      defaultEffort: 'high',
      skillDescriptors: [
        {
          id: 'review-diff',
          name: 'Review a diff',
          description: 'Reads a diff and reports concrete defects with the lines that cause them.',
          tags: ['code', 'review'],
        },
      ],
      instructions: [
        'You review pull requests. Report only defects you can point at: a wrong result for a named input, a missing check at a boundary, a test that cannot fail, or a change that is hard to undo.',
        'For each finding, give the file and line, say what goes wrong and for which input, and suggest the smallest fix. Leave style, naming, and taste alone unless they hide a bug.',
        'Begin by saying what the change does well. If you find nothing worth blocking on, say so in a sentence instead of inventing a finding.',
      ].join('\n\n'),
    },
  },
  {
    id: 'data-quality-auditor',
    definition: {
      name: 'Data quality auditor',
      description:
        'Checks nightly exports for missing rows, duplicate keys, and schema drift before they reach the warehouse.',
      model: 'anthropic/claude-haiku-4-5',
      tools: ['bureau:workflows-list', 'settings-get'],
      skillDescriptors: [],
      instructions: [
        'You audit the nightly exports. For each export you are given, compare it with the previous night: row counts, the share of empty values per column, and any column that appeared or disappeared.',
        'Report a problem only when it crosses a threshold: row count off by more than five percent, or a key column with any duplicates. Everything else goes in a short "noted" list.',
        'Write for an engineer who is about to decide whether to hold the warehouse load. Lead with that decision: load, hold, or investigate.',
      ].join('\n\n'),
    },
  },
  {
    id: 'onboarding-guide',
    definition: {
      name: 'Onboarding guide',
      description:
        'Walks a new teammate through their first week: accounts to request, people to meet, and docs to read.',
      model: 'anthropic/claude-haiku-4-5',
      skillDescriptors: [],
      instructions: [
        'You help new teammates through their first week. Ask which team they are joining and what their role is, then give them a plan for each day.',
        'Keep each day to three things at most. Name the person to meet, the account to request, or the document to read, and say why it matters on that day.',
        'If they ask something you do not know, say so and point them to the person who would. Never invent a policy.',
      ].join('\n\n'),
    },
  },
];

/** A chat: the thread it lives in, the agent that answers, and what the person says, in order. */
export interface ShowcaseChat {
  readonly key: string;
  readonly agent: string;
  readonly messages: readonly string[];
}

/** The chats that need only the messages sent to them. The others (approvals and so on) are named below. */
export const SHOWCASE_CHATS = {
  /** A twelve-message conversation (six turns) with a stub model, for the density of a long thread. */
  release: {
    key: 'release',
    agent: 'release-notes-writer',
    messages: [
      'Can you walk me through what we need to do before Thursday’s release? I have the changelog open but I am not sure what is still missing.',
      'Which of those can be done the day before, and which have to wait until the release branch is cut?',
      'The changelog has twenty-three entries. Group them under features, fixes, and breaking changes, and tell me which entries look like they belong in more than one group.',
      'Two of the fixes touch the export format. Should those be called out as breaking, even though the old files still open?',
      'Good. Please keep the final list short enough to paste into the release thread without scrolling.',
      'Thank you. One more thing: draft a two-line thank-you for the outside contributors on this release.',
    ],
  },
  /** Asks the scripted tool runner for a refund, and is denied. The lookup before it is a plain tool call. */
  refundDenied: {
    key: 'refund-denied',
    agent: 'demo:tool-runner',
    messages: ['Refund order order-1001. The customer was charged twice for the same shipment.'],
  },
  /** Asks for a refund and waits on the approval. */
  refundWaiting: {
    key: 'refund-waiting',
    agent: 'demo:tool-runner',
    messages: ['Refund order order-1001. It arrived damaged and the customer sent photos.'],
  },
  /** Asks for a refund and is approved. */
  refundApproved: {
    key: 'refund-approved',
    agent: 'demo:tool-runner',
    messages: ['Refund order order-1001. The warehouse confirmed the return was received.'],
  },
  /** Parks on a question for a person. */
  question: {
    key: 'question',
    agent: 'demo:request-human-input',
    messages: ['Ship the release as soon as the checks are green.'],
  },
  /** Names the model it answers as, and can be switched between two. */
  modelPicker: {
    key: 'model-picker',
    agent: 'demo:model-switcher',
    messages: ['Which model are you, and what would change if I switched to the smaller one?'],
  },
  /** Sent with a picture. */
  attachment: {
    key: 'attachment',
    agent: 'code-review-assistant',
    messages: [
      'Here is a screenshot of the settings page after my change. Does anything look off, or is the spacing fine?',
    ],
  },
  /** The model provider fails during the run. */
  failed: {
    key: 'failed',
    agent: 'incident-summarizer',
    messages: [
      'Summarize last night’s database incident for the Monday review. Please simulate a provider failure so we can see how the page reports it.',
    ],
  },
} as const satisfies Record<string, ShowcaseChat>;

/** The titles the chats are given when the first message would make a poor one. */
export const SHOWCASE_CHAT_TITLES: Readonly<Record<string, string>> = {
  question: 'Ship the release',
  'refund-waiting': 'Refund for a damaged order',
  'refund-approved': 'Refund after a confirmed return',
  'refund-denied': 'Refund for a duplicate charge',
};

/** A workflow file, and the runs started from it. */
export interface ShowcaseWorkflow {
  readonly id: string;
  readonly definition: Readonly<Record<string, unknown>>;
}

/** The three agent-authored workflows. */
export const SHOWCASE_WORKFLOWS: Readonly<Record<'digest' | 'review' | 'sync', ShowcaseWorkflow>> =
  {
    digest: {
      id: 'nightly-digest',
      definition: {
        description: 'Writes the nightly digest of merged work and hands it to the team.',
        agent: 'release-notes-writer',
        trigger: { kind: 'schedule', spec: '0 6 * * *' },
        steps: [
          {
            kind: 'activity',
            handler: 'agent',
            input: {
              agent: 'demo:assistant',
              message: 'Collect the pull requests that merged yesterday.',
            },
          },
          {
            kind: 'activity',
            handler: 'agent',
            input: {
              agent: 'release-notes-writer',
              message: 'Write the nightly digest from the pull requests that were collected.',
            },
          },
        ],
      },
    },
    review: {
      id: 'refund-review',
      definition: {
        description:
          'Looks up a refund request and waits for a finance reviewer to sign off before it goes out.',
        agent: 'support-triage',
        trigger: { kind: 'signal', name: 'refund-requested' },
        inputSchema: {
          type: 'object',
          properties: {
            orderId: { type: 'string', title: 'Order', description: 'The order to refund.' },
            reason: {
              type: 'string',
              title: 'Reason',
              description: 'Why the customer is owed a refund.',
            },
          },
          required: ['orderId'],
        },
        steps: [
          {
            kind: 'activity',
            handler: 'agent',
            input: {
              agent: 'demo:assistant',
              message: 'Look up the order and summarize the refund request.',
            },
          },
          { kind: 'await-signal', signal: 'refund-approved' },
        ],
      },
    },
    sync: {
      id: 'vendor-sync',
      definition: {
        description:
          'Pulls the vendor price list each weekday morning and reconciles it against the catalog.',
        agent: 'data-quality-auditor',
        trigger: { kind: 'schedule', spec: '0 7 * * 1-5' },
        steps: [
          {
            kind: 'activity',
            handler: 'agent',
            input: {
              agent: 'vendor-reconciler',
              message: 'Reconcile the vendor price list with the catalog.',
            },
          },
        ],
      },
    },
  };

/** What the refund-review workflow is started with. */
export const SHOWCASE_REVIEW_INPUT = {
  orderId: 'order-1001',
  reason: 'The customer was charged twice for one shipment.',
} as const;

/** A schedule, found again by its description. */
export interface ShowcaseSchedule {
  readonly key: string;
  readonly description: string;
  readonly agentName: string;
  readonly input: string;
  readonly spec: string;
  readonly timeZone: string;
  readonly paused: boolean;
}

/** Three schedules in three time zones, one of them paused. */
export const SHOWCASE_SCHEDULES: readonly ShowcaseSchedule[] = [
  {
    key: 'standup',
    description: 'Weekday standup summary',
    agentName: 'release-notes-writer',
    input: 'Summarize the pull requests that merged yesterday, for the morning standup.',
    spec: '0 9 * * 1-5',
    timeZone: 'America/New_York',
    paused: false,
  },
  {
    key: 'quality',
    description: 'Weekly data quality report',
    agentName: 'data-quality-auditor',
    input: 'Audit last week’s exports and report anything that crossed a threshold.',
    spec: '0 7 * * 1',
    timeZone: 'Europe/Berlin',
    paused: false,
  },
  {
    key: 'check-in',
    description: 'Evening onboarding check-in',
    agentName: 'onboarding-guide',
    input: 'Ask this week’s new teammates how their first days are going.',
    spec: '30 18 * * *',
    timeZone: 'Asia/Tokyo',
    paused: true,
  },
];

/** A webhook, and where on the local listener it posts. */
export interface ShowcaseHook {
  readonly key: string;
  readonly name: string;
  readonly events: readonly string[];
  /** The path on the listener the seed starts: `/outage` answers 503, any other path answers 200. */
  readonly path: string;
}

/** Two hooks, one whose test delivery succeeds and one whose delivery fails. */
export const SHOWCASE_HOOKS: readonly ShowcaseHook[] = [
  {
    key: 'deploys',
    name: 'Deploy notifications',
    events: ['review.requested', 'review.approved', 'review.denied'],
    path: '/deploys',
  },
  {
    key: 'pager',
    name: 'Pager bridge',
    events: ['goal.failed', 'schedule.failed', 'review.expired'],
    path: '/outage',
  },
];

/** The signing secret every showcase hook is created with. It signs nothing that matters. */
export const SHOWCASE_HOOK_SECRET = 'showcase-signing-secret-0123456789';

/** A goal, found again by its idempotency key. */
export interface ShowcaseGoal {
  readonly key: string;
  readonly agentName: string;
  readonly prompt: string;
  readonly identity: { readonly name: string; readonly version: string };
  /** The demo plugin's validator that decides the goal. */
  readonly validator: 'accepts-any-answer' | 'never-passes';
  readonly bounds: Readonly<Record<string, number>>;
}

/** Two goals: one that succeeds, and one that keeps evaluating until it is cancelled. */
export const SHOWCASE_GOALS: readonly ShowcaseGoal[] = [
  {
    key: 'showcase-release-announcement',
    agentName: 'release-notes-writer',
    prompt: 'Draft a short announcement for the release that covers the three biggest changes.',
    identity: { name: 'release-announcement', version: '1' },
    validator: 'accepts-any-answer',
    bounds: { maximumAttempts: 3, maximumTotalSteps: 30 },
  },
  {
    key: 'showcase-empty-the-backlog',
    agentName: 'support-triage',
    prompt: 'Work through the support backlog until every request has a queue and a summary.',
    identity: { name: 'empty-the-backlog', version: '1' },
    validator: 'never-passes',
    bounds: { maximumAttempts: 5, maximumTotalDurationMs: 3_600_000 },
  },
];

/** A workflow file the sample world keeps in the home's `workflows/` directory, as its exact text. */
export interface ShowcaseWorkflowFile {
  /** The workflow's identifier, which is the file name without `.json`. */
  readonly id: string;
  /** The file's text, byte for byte as the workflow page's Code tab shows it. */
  readonly text: string;
}

/**
 * Release notes, the sample world's healthy workflow, in the extended workflow file format
 * (`tmp/design-review/decisions.md`, "Owner answers during B01"): a workflow `title`, a schedule
 * trigger with `timezone` and `catchUp`, its `name` (the Release notes digest schedule) and its fixed
 * `input` (branch `main`, which its `inputSchema` requires), and a `title` on each step. It needs no model: every step is
 * Assistant, which is scripted. The text is the workflow page's Code tab (PageWorkflow, "Code tab"),
 * which the builder's Edit and JSON frames show too. The board's `input` and `output` are written as
 * Weft's `inputSchema` and `outputSchema`, which the file format keeps (decisions.md, "Coordinator
 * calls during B01").
 */
export const SHOWCASE_RELEASE_NOTES_FILE: ShowcaseWorkflowFile = {
  id: 'release-notes',
  text: `{
  "name": "release-notes",
  "title": "Release notes",
  "description": "Collects merged changes into a draft.",
  "trigger": {
    "kind": "schedule",
    "name": "Release notes digest",
    "spec": "0 11 * * 5",
    "timezone": "America/Chicago",
    "overlap": "skip",
    "catchUp": false,
    "input": { "branch": "main" }
  },
  "inputSchema": {
    "type": "object",
    "required": ["branch"],
    "properties": {
      "branch": { "type": "string",
        "description": "The branch to release from." },
      "since": { "type": "string", "format": "date",
        "description": "Only include changes merged after this date. Defaults to the last release." }
    }
  },
  "outputSchema": {
    "type": "object",
    "required": ["notes"],
    "properties": {
      "notes": { "type": "string",
        "description": "The approved release notes." }
    }
  },
  "steps": [
    { "title": "Find the last release",
      "kind": "activity", "handler": "agent",
      "input": { "agent": "assistant",
        "message": "Find the most recent release and when it was made." } },
    { "title": "Collect merged changes",
      "kind": "activity", "handler": "agent",
      "input": { "agent": "assistant",
        "message": "Collect the changes merged since the last release." } },
    { "title": "Draft the notes",
      "kind": "activity", "handler": "agent",
      "input": { "agent": "assistant",
        "message": "Draft release notes from the collected changes." } },
    { "title": "Wait for approval",
      "kind": "await-signal", "signal": "notes-approved" }
  ]
}
`,
};

/**
 * Triage inbox: paused, and started every day at 8:00 AM Central time by its schedule trigger, the
 * Inbox triage schedule, which pausing the file pauses too (decisions.md: "Inbox triage starts the
 * Triage inbox workflow (Assistant), both paused, last run Oct 24"). A workflow file's schedule
 * exists only as its trigger, so this is where Inbox triage lives. Its three steps are Assistant's.
 */
export const SHOWCASE_TRIAGE_INBOX_FILE: ShowcaseWorkflowFile = {
  id: 'triage-inbox',
  text: `{
  "name": "triage-inbox",
  "title": "Triage inbox",
  "description": "Sorts new messages into the right folder and flags anything urgent.",
  "paused": true,
  "trigger": {
    "kind": "schedule",
    "name": "Inbox triage",
    "spec": "0 8 * * *",
    "timezone": "America/Chicago"
  },
  "steps": [
    { "title": "Read new messages",
      "kind": "activity", "handler": "agent",
      "input": { "agent": "assistant",
        "message": "Read the messages that arrived since the last triage." } },
    { "title": "Sort into folders",
      "kind": "activity", "handler": "agent",
      "input": { "agent": "assistant",
        "message": "Sort each message into the folder it belongs in." } },
    { "title": "Flag anything urgent",
      "kind": "activity", "handler": "agent",
      "input": { "agent": "assistant",
        "message": "Flag anything that needs an answer today." } }
  ]
}
`,
};

/**
 * Order refund as it was last saved whole (decisions.md, "Owner, Nov 3"): the Weekly refund audit
 * schedule (Mondays at 11:00 AM Central time, Tool runner) is its trigger, written on one line so
 * the file keeps its line numbers. The seed writes it while a host runs, so Bureau makes the
 * schedule and records the version, then breaks it ({@link SHOWCASE_ORDER_REFUND_FILE}); Bureau
 * keeps that schedule from this last good version and holds it while the file can't load.
 */
export const SHOWCASE_ORDER_REFUND_VALID_FILE: ShowcaseWorkflowFile = {
  id: 'order-refund',
  text: `{
  "name": "order-refund",
  "description": "Looks up an order, waits for a person to approve, then issues the refund.",
  "trigger": { "kind": "schedule", "name": "Weekly refund audit", "spec": "0 11 * * 1", "timezone": "America/Chicago" },
  "steps": [
    { "kind": "activity", "handler": "agent",
      "input": { "agent": "tool-runner",
        "message": "Look up the order and propose a refund." } },
    { "kind": "await-signal", "signal": "approval", "review": true },
    { "kind": "activity", "handler": "agent",
      "input": { "agent": "tool-runner",
        "message": "Issue the approved refund." } }
  ]
}
`,
};

/**
 * Order refund, the file that can't load: {@link SHOWCASE_ORDER_REFUND_VALID_FILE} with the comma
 * at the end of line 11 missing, so the parser stops at line 12 (PageWorkflow, "File problem · Code
 * tab"). It has no title, so its identifier is its heading, and the Weekly refund audit schedule
 * its last good version made starts it.
 */
export const SHOWCASE_ORDER_REFUND_FILE: ShowcaseWorkflowFile = {
  id: 'order-refund',
  text: SHOWCASE_ORDER_REFUND_VALID_FILE.text.replace(
    '"agent": "tool-runner",\n        "message": "Issue the approved refund."',
    '"agent": "tool-runner"\n        "message": "Issue the approved refund."',
  ),
};

/** The sample world's three workflow files, in the order the Workflows page lists them. */
export const SHOWCASE_WORKFLOW_FILES: readonly ShowcaseWorkflowFile[] = [
  SHOWCASE_RELEASE_NOTES_FILE,
  SHOWCASE_ORDER_REFUND_FILE,
  SHOWCASE_TRIAGE_INBOX_FILE,
];
