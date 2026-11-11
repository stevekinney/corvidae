/**
 * The sample world's workflow files (`tmp/design-review/decisions.md`), byte for byte as their
 * Code tabs show them: Release notes, Triage inbox, and Order refund, whose last good version
 * carries the Weekly refund audit schedule and whose file lost a comma. The seed
 * (`sample-world-seed.ts`) saves their versions over the story and writes these texts last. No
 * literal holds an unbroken run of more than 40 non-space characters, which
 * `tests/showcase-routes.test.ts` checks over everything exported here; the stress seed
 * (`tests/e2e/responsive.spec.ts`) is where overflow and truncation are exercised.
 *
 * The sample world has no agent files: its agents are the showcase host's built-ins
 * (`src/host/showcase-agents.ts`), and its chats, schedules, hooks and goals are made by the
 * seed's story (`sample-world-seed.ts`, `sample-world-history.ts`).
 *
 * @module showcase-content
 */

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
 * at the end of line 11 missing, so the parser stops at line 12 (PageWorkflow, "File problem, Code
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
