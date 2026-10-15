---
'@lostgradient/chat': minor
---

The chat session reducer no longer silently drops `tool.started`, `tool.progress`, `tool.error`, `tool.policy-denied`, `elicitation.requested`, `elicitation.resolved` and `run.aborted` frames. Three new optional `ChatSessionHooks` observers report them: `onToolActivity`, `onElicitation` and `onRunAborted`. Observers receive copies of the reduced state, and a hook that throws or returns a rejected promise is reported through `reportError` without failing the run. A `tool.settled` that arrives before its tool call is treated as terminal, so later activity frames for that call cannot reopen it. After `run.aborted`, a browser-owned turn no longer continues to another transport turn. Every `ChatStreamEvent` type is now either reduced or explicitly listed as ignored, and an unhandled type fails typechecking.
