# Storage Reference

Every storage adapter reports its guarantees through `capabilities()`. This page covers scan consistency and how `IndexedDBStorage` meets it. Read `capabilities().scanConsistency` for any other adapter.

## Scan consistency

`capabilities().scanConsistency` describes a single `scan()` iteration relative to concurrent writes:

- `snapshot`: the scan observes one point-in-time view; concurrent writes never appear partially within the iteration.
- `best-effort`: the scan may interleave with concurrent writes.

### IndexedDBStorage

IndexedDBStorage reports `scanConsistency: 'best-effort'` because its isolation is per-page, not whole-scan.

`scan()` and `keys()` read one page of rows inside a single readonly transaction, buffer it, and only then yield to the consumer. No cursor or transaction stays open while your loop body runs, so the loop body can await any work without a `TransactionInactiveError`. The next page is read in a new transaction that resumes after the last row the previous page scanned.

IndexedDBStorage guarantees no torn records within a page; it does not provide a whole-scan snapshot.

Because pages are read at different times, concurrent writes behave as follows:

- A buffered page is yielded exactly as it was read when its transaction ran, so a record deleted or overwritten after that page committed is still yielded with its buffered value.
- A record written while a page is being yielded appears if and only if it sorts strictly after that page's continuation key in the iteration direction and a later page is read after the write.
- A later page is read only after a page that scanned exactly the page size, so a record inserted while a short final page is being yielded does not appear, and a record inserted while a full final page is being yielded appears because the trailing empty page reads it.
- No key is ever yielded twice.

The page size is an internal constant, not a public option.
