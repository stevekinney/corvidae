import { serveMaster, type MasterScope } from './pty-master-thread.ts';

declare const self: MasterScope;

/** The worker thread that owns the read side of one PTY master; see `pty-master.ts`. */
serveMaster(self);
