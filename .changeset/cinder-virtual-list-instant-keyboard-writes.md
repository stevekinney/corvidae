---
'@lostgradient/cinder': patch
---

`VirtualList` no longer fights a scroll it did not make after an arrow key. Without `smoothScroll`, an arrow or Home/End press in a list with sticky rows kept its destination pending for a few frames after the instant write had already landed. If anything else scrolled the list back to where the press began in that window—a consumer setting `scrollTop`, a fragment link—the list took it for a lost write and scrolled back to the old destination, and a press made in that window stepped from the stale row instead of the live one. An instant write now retires its destination immediately; the settle watch and its retry apply only when the write animates, through `smoothScroll` or a CSS `scroll-behavior: smooth` on the scrolling box.
