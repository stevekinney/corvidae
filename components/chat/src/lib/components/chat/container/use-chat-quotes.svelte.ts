import { MAX_QUOTES, normalizeQuoteText } from '../utilities/quote-composition.ts';

/** One quoted excerpt waiting above the composer. */
export type ChatQuote = {
  readonly id: string;
  readonly text: string;
};

/** What happened to a quote offered to {@link UseChatQuotesReturn.add}. */
export type ChatQuoteAddResult = 'added' | 'duplicate' | 'full' | 'empty';

export interface UseChatQuotesReturn {
  /** The quotes in the order they were added. */
  readonly quotes: readonly ChatQuote[];
  /** Whether no more quotes can be added. */
  readonly isFull: boolean;
  /** Adds a selection as a quote, unless it is blank, already quoted, or the list is full. */
  add(selected: string): ChatQuoteAddResult;
  /** Removes one quote and returns it, or `undefined` when it is already gone. */
  remove(id: string): ChatQuote | undefined;
  /** Removes every quote whose id is listed; quotes added since stay. */
  removeAll(ids: readonly string[]): void;
  /**
   * Puts quotes taken out for a send that failed back ahead of the current ones,
   * in their original order and without repeating any text, keeping the first
   * {@link MAX_QUOTES}. Returns how many quotes did not fit.
   */
  restore(carried: readonly ChatQuote[]): number;
  /** Removes every quote. */
  clear(): void;
}

/** Owns the quoted excerpts that gather above the composer. */
export function useChatQuotes(): UseChatQuotesReturn {
  let quotes = $state<ChatQuote[]>([]);
  let nextIdentifier = 0;

  function add(selected: string): ChatQuoteAddResult {
    const text = normalizeQuoteText(selected);
    if (text === '') return 'empty';
    if (quotes.some((quote) => quote.text === text)) return 'duplicate';
    if (quotes.length >= MAX_QUOTES) return 'full';
    nextIdentifier += 1;
    quotes = [...quotes, { id: `quote-${nextIdentifier}`, text }];
    return 'added';
  }

  function remove(id: string): ChatQuote | undefined {
    const removed = quotes.find((quote) => quote.id === id);
    if (removed) quotes = quotes.filter((quote) => quote.id !== id);
    return removed;
  }

  function removeAll(ids: readonly string[]): void {
    const removing = new Set(ids);
    quotes = quotes.filter((quote) => !removing.has(quote.id));
  }

  function restore(carried: readonly ChatQuote[]): number {
    const seen = new Set<string>();
    const merged: ChatQuote[] = [];
    for (const quote of [...carried, ...quotes]) {
      if (seen.has(quote.text)) continue;
      seen.add(quote.text);
      merged.push(quote);
    }
    quotes = merged.slice(0, MAX_QUOTES);
    return merged.length - quotes.length;
  }

  function clear(): void {
    quotes = [];
  }

  return {
    get quotes() {
      return quotes;
    },
    get isFull() {
      return quotes.length >= MAX_QUOTES;
    },
    add,
    remove,
    removeAll,
    restore,
    clear,
  };
}
