import type { BureauEventMap } from './events.ts';
import type { DeclaredKeys } from './bureau-event-feed.ts';

type Assert<T extends true> = T;
type DeclaredKeysAreNotString = Assert<string extends DeclaredKeys<BureauEventMap> ? false : true>;

void (undefined as unknown as DeclaredKeysAreNotString);
