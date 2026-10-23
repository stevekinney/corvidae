# Linear policy

The Linear rules a chef run relies on, so the skill works without any personal skills installed. It covers routing, the issue lifecycle, the Definition of Ready, the shapes of the work-session comments, and the read-back rule. Verify routing and workflow states against live Linear before writing, because a table in a document goes stale.

When the `linear-track-work`, `linear-update-project`, `linear-create-issue`, `linear-create-project`, or `scope-work` skills are installed, use them for the writes they cover. Otherwise do the same step with `scripts/chef/linear.ts`, run from the repository root. It reads `LINEAR_API_KEY` through `scripts/chef/credentials.ts`, so no wrapper is needed, and it reads every write back. Each section below says which command performs the step.

## Team routing

- `COR` (Corvidae) is the only execution team. It routes to this repository, GitHub `stevekinney/corvidae`, which allows squash merges only. File all work there, including anything that used to be scoped to Weft, Agent Bureau, Cinder, or the chat room.
- `ENG` (Engineering) is the parent of `COR`. It holds shared configuration only: issue statuses, labels, estimate settings, and membership. It is not an execution team. Never file an issue in `ENG`, and never name it as an issue's one target team.
- `CIN`, `TRI`, `OPS`, `WFT`, `AB`, `WFC`, `CHR`, and `LOS` are archived or retired. Never route work to them, and treat an old reference to one as a pointer to find the issue's current `COR` identifier, not as a routing target. Identifiers from `WFT` and `AB` have no numeric mapping into `COR`.
- Agent tooling (a skill, subagent, hook, or instruction file) is not tracked in Linear. Make the change, verify it, and report it, with no issue.

## Lifecycle

- Issues use Backlog, Ready, In Progress, In Review, and Done. `Todo` is not Ready.
- Projects use `Backlog`, `Ready`, `In Progress`, `Completed`, and `Canceled`, and the API accepts only those names. Intents such as Candidate, Shaping, Paused, and Verified are predicates that gate a transition, not statuses: write `Backlog` for a candidate, a shaping project, or a paused one (record the reason and any native blocker in a comment), and `Completed` only once every required published, deployed, and downstream artifact is independently verified.
- Never create a `type:decision` issue, and never put a "Decide …" or "Define the … contract" issue in a project draft. A decision is resolved in conversation, as [decisions](decisions.md) describes, and recorded in the issue or scope it settles. An existing `type:decision` issue is answered, recorded, and closed as Done.
- Each cohesive batch has its own acceptance criteria, verification, integration boundary, and tracking closeout. Move an independently completed issue to Done as its own gates pass; an unfinished neighbor does not hold it open. Preserve native dependencies, publication, deployment, and explicit whole-program gates.
- Done means the execution boundary's required external truth exists. A merged pull request does not prove an npm publication, a deployment, or downstream adoption, so those gates stay open until the matching published version or live deployment is independently verified.
- Picking up an issue is an end-to-end commitment: the session that claims it drives the work through its delivery artifact (a merged pull request, for repository work) and moves the issue itself to Done with completion evidence. Do not stop at In Review, and do not leave a merged pull request with the issue open. When something outside the session's control blocks Done, record a `Blocked` or `Handoff` comment, with a native blocker where one applies.
- Move an issue with `bun scripts/chef/linear.ts state <ID> "<State Name>"`, which resolves the state by name from the issue's own team and reads it back.

## Definition of Ready

An issue is Ready only when it has all of these:

- exactly one target team, which is `COR`;
- exactly one Work Type label;
- one owner and working location;
- binary acceptance criteria, each independently checkable;
- exact verification commands;
- a delivery boundary, stating what artifact ends the work;
- no unresolved native blocker.

A project is Ready only when its document, teams, milestones, execution-boundary issues, native dependency graph, operational risks, and success evidence are complete, and it has at least one unblocked Ready child issue. Project readiness and issue readiness are separate predicates.

Check the predicates against the issue text and `bun scripts/chef/linear.ts blockers <ID>` before promoting an issue. When a predicate fails, the issue is not Ready; say which one in a comment and leave it in Backlog. Create a new issue with `bun scripts/chef/linear.ts create --team COR --title "<title>" --file <body.md> --label "<Work Type>"`, which refuses a duplicate title and prints the identifier after reading it back. Express a dependency as a native relation, never as prose: `bun scripts/chef/linear.ts block <ID> --by <BLOCKER>` makes the blocker block the issue.

## Work-session comments

Write each as a Markdown file and post it with `bun scripts/chef/linear.ts comment <ID> --file <md>`, which reads the comment back by id.

- A claim records the provider, the session or agent, the branch, the worktree, the base SHA, the scope, the first verification gate, and the current blocker state. Post the claim, then move the issue to In Progress. In a delegated run the coordinator posts the claim at dispatch, and the worker moves its own issue to In Progress when it starts.
- A checkpoint records the current evidence and the next executable command.
- A blocker records the failed command or unavailable operation, the last verified state, the exact condition, and one executable action that would unblock it. Add the native `blocked by` relation.
- A handoff holds enough evidence and next steps to resume without the original transcript.
- A completion names every verification source and the final external artifact, version, deployment SHA, or an explicit no-op result.

To change an issue description, append a dated revision with `bun scripts/chef/linear.ts append <ID> --file <md>` rather than rewriting history. A material revision (one that changes the outcome, an acceptance criterion, the scope, the delivery boundary, or the team) needs the intake check before the issue is claimed.

## Writing rules

- Only the primary coordinator writes Linear, with one exception: a worker moves its own issue to In Progress (`linear.ts state <ID> "In Progress"`) when it starts. Every other write, closeout included (Done, completion comments, blockers, handoffs, project updates), is the coordinator's. Planners, verifiers, and workers otherwise are read-only and return proposed changes.
- Read immediately before every write, and read every mutation back. `linear.ts` does the read-back and exits 1 on a mismatch; a mismatch is a failure, not a retry prompt.
- Preview the complete mutation and approve it as coordinator before writing. Routine decisions within the authorized scope do not need renewed user permission.
- Fail closed on unknown routing, a duplicate, an unreadable relation, a missing approval, or a read-back mismatch.
- A pull request references its issues with a non-closing word such as `Refs`, so a merge cannot close an issue before its own evidence is checked.
- Never put a secret in an issue, a comment, or a project update.

## Recording findings

Record actionable repository or environment findings in Linear as they arise. Search for duplicates first, read likely matches fully, then add evidence to an existing issue or create one through the intake and issue-creation workflows. Route them to the live owning team. Agent tooling and process findings are not tracked in Linear: record them in the work-history note and the final report. Include the observation, reproduction or source evidence, impact, a concrete proposed improvement, binary acceptance criteria, and exact verification. Preserve native blockers when a finding blocks this run.

Compare root cause and execution boundary when deciding whether a finding duplicates an issue; similar wording alone is insufficient. Split a cross-team improvement into separately owned issues and connect any actual dependencies. An actionable finding has evidence, an affected boundary, and a verifiable proposed change; a vague preference is not a reason to create a ticket.

Recording an improvement does not defer required work. Fix findings necessary for the assigned outcome within scope. Record independently useful improvements outside that scope without silently adding them to the delivery plan. If Linear is unavailable, retain the complete payload in the note, report the recording failure, and do not claim tracking is complete. If no actionable findings exist, record that result without inventing tickets. Never copy secrets into notes or tracking records.
