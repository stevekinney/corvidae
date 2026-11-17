/**
 * The `data` of an `Unprocessable` fault. `reason` says why the request was refused. For a write
 * the server's file system refused (`reason: 'write-failed'`, COR-2432), `file` is the file's name
 * as the caller knows it, never an absolute path, and `cause` is a closed-set cause such as
 * `permission-denied`; both are carried on JSON-RPC only, as `reason` is.
 */
export type UnprocessableFaultData = {
  reason: string;
  file?: string | undefined;
  cause?: string | undefined;
};
