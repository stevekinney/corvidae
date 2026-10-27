# Defect classes

Check your diff against this list before opening a pull request, and say in your return which classes apply. These are the eleven classes: nine the review bots caught reliably in an audit of 518 threads on 2026-10-21 and 2026-10-22 (AGENTS.md "Review guidelines"), plus the state-machine class and the fixtures `tsc` cannot see class below. About 60% of those threads named real defects, and most of the pull requests that ran past two review rounds were one defect class patched over and over. Catching a class before the first push costs one read of the diff; catching it in review costs a round.

For each class, read the diff with the prompt in mind. When a class applies, fix every instance in the diff, then grep for its siblings in the code you changed, and prefer a guard (a test, a type constraint, a lint rule) to a one-off patch. Report each class as `applies: fixed`, `applies: guarded by <test or type>`, or `does not apply`.

| # | Class | Check your diff for |
| --- | --- | --- |
| 1 | Fields dropped across a mapping | Every adapter, projection, serializer, or wire mapping you touched: does each field or part on the input side reach the output, or is its omission deliberate and tested? |
| 2 | State exposed before its durable commit | Is any state written, returned, emitted, or cached before the write that makes it durable succeeds, and does a failure after the commit get repaired or surfaced rather than swallowed? |
| 3 | Check-then-act without a fence | Where you read state and then act on it, what stops it changing in between: a lock, a compare-and-set, a version, a transaction? |
| 4 | Cleanup bound to a stale generation | Does every cleanup, settlement, timer, or callback check that it still belongs to the current generation, incarnation, or round before it acts? |
| 5 | A retry replaying a different operation | Does every retry or replay perform exactly the operation its receipt or record describes, with the same inputs, rather than recomputing them? |
| 6 | Missing authorization on a new route | Does every new route, handler, or lookup check who may call it, the same way its neighbors do? |
| 7 | Unvalidated input at an exported boundary | Does every exported function, endpoint, or parser validate its input before use, rather than trusting the type annotation? |
| 8 | Caller-owned input read after an await | After the first `await` in a function, does it still read an object or array the caller owns, without having snapshotted it first? |
| 9 | A published spec contradicting itself | In every published spec, schema, or document you changed, do the prose, the examples, and the schema still agree with each other? |
| 10 | A state-machine outcome left undefined | For finish reasons, run, task or settlement lifecycle, parks or suspends, recovery or reattach, shutdown or dispose, and retries: does the charter's outcome matrix cross every input or failure with every exit, and does a test cover each cell? A second correction round on this class goes to a design pass, not another patch. |
| 11 | Fixtures `tsc` cannot see | Other sessions keep landing code against the surface you remove or rename, so grep every removed or renamed member name across the repository, tests and fixtures included, for the shapes the compiler skips: `Object.create`, object spreads, `Proxy`, `as never` or `as unknown as` casts, and hand-built internals or mocks. Fix each hit, or guard it with a type that fails on the old shape. The coordinator also passes the names to `deliver.ts --removed-names`, which fails at step `integration` on files that landed against the old surface. |

A class that appears in two review rounds of the same pull request means the causal model was wrong. `bun scripts/chef/review-threads.ts classes --pr <n>` detects that, and the charter says what to do on its exit 1.
