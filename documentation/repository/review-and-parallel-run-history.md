# Review and parallel-run audit history

The measurements behind AGENTS.md "Review guidelines" and "Parallel runs".

They are tuned from an audit of 518 bot review threads across 60 pull requests on 2026-10-21 and 2026-10-22. About 60% named real defects, so findings are worth answering. The waste was elsewhere: comments on code the pull request did not change, re-reviews of the whole diff after every push (20 pull requests ran past two rounds, the worst to 16), contrived interleavings under unsupported configurations, findings that contradicted a recorded COR decision, and re-raised threads.

A run that delivers several issues at once is limited by this host's lock and processors, and its cost follows each agent's context more than its model. On 2026-10-22, five long-lived sessions spent about 15% of a week's usage over about seven hours and merged ten issues. Most of that time went to queued full validates and repeated review rounds. The rules this history informed are in AGENTS.md.
