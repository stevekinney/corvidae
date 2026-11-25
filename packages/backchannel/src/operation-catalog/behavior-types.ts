/** Serializable, producer-declared semantics for generated consumers. */
export type OperationBehavior =
  | {
      readonly kind: 'read';
      readonly key?: readonly string[];
      readonly pagination?: {
        readonly items: string;
        readonly cursorInput: string;
        readonly nextCursor: string;
        readonly total: string;
        readonly cursorFilters: readonly string[];
        readonly itemKey: readonly string[];
      };
      readonly cursor?: string;
    }
  | {
      readonly kind: 'command';
      readonly invalidates?: readonly string[];
      readonly observedInput?: {
        readonly read: string;
        readonly when: Readonly<Record<string, string>>;
        readonly key: string;
        readonly revision: string;
      };
      readonly conflictReasons?: readonly string[];
      readonly replay?: { readonly key: string; readonly resource: string; readonly read: string };
      readonly responseDisposition?: 'one-time';
      readonly effects?: { readonly idempotent?: boolean; readonly externalWorld?: boolean };
    };
