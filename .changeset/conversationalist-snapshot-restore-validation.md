---
'conversationalist': patch
---

Restoring a version 2 snapshot now validates each message table entry once instead of re-parsing every message in every history node, so restore cost no longer grows with the sum of every node's message count. Each node header is checked with plain type checks, and each node still gets the checks that depend on how its messages sit together: positions match their indexes, no id is missing or unlisted, and each tool result follows its call. Restored nodes keep sharing message instances, so snapshot size across round trips is unchanged.
