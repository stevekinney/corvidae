---
'@lostgradient/operative': patch
---

A durable run no longer persists the whole conversation snapshot twice on every step. A step whose input is the previous step's output now records its conversation in the step memo and in its `saveConversation` input as a delta of the messages, history nodes, and path entries it appended, so what each step persists is the size of one step rather than the size of the whole conversation. The first step, and the first step after a wakeup or signal continuation, still record the snapshot whole. Applying a delta checks the base it was taken from, so a diverged replay fails loudly instead of corrupting the saved transcript.
