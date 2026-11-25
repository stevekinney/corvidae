/**
 * The words that say a run needs a look (COR-2528), wherever one is said: a badge on a Runs list
 * row, the Needs attention filter above the list, and the note on the Run page. A run asks for
 * attention when it is stalled, looping, or has cost more than the workspace's spend threshold
 * (Settings › General); none of them stops the run, so no line here says that it was stopped.
 * Parts of a line are joined by a comma, never a middle dot.
 */
export const RUN_ATTENTION_COPY = {
  /** The Runs list's filter chip, and the name of the filter in the address `?attention=1`. */
  filter: 'Needs attention',
  /** After "No runs": which runs the filter leaves out, in the sentence of the filtered empty state. */
  noMatchClause: 'that need attention',
  /** The badge each state draws on a row, one per state the run is in. */
  badges: {
    stalled: 'Stalled',
    looping: 'Looping',
    overspending: 'Overspending',
  },
  /** The sentence a badge carries as its tooltip. */
  badgeTitles: {
    stalled: 'This run stopped making progress.',
    looping: 'This run’s tools reported a loop.',
    overspending: 'This run cost more than the spend threshold.',
  },
  /** The Run page's note for each state: a title and the sentence under it. */
  note: {
    stalled: {
      title: 'This run has stopped making progress',
      /**
       * `when` is when the Bureau saw the run stall, with its preposition ("at 9:05 AM",
       * "yesterday at 4:12 PM"); progress was last made before then.
       */
      line: (when: string | undefined): string =>
        when === undefined
          ? 'It was seen stalled.'
          : `It was seen stalled ${when}, so it last made progress before then.`,
    },
    looping: {
      title: 'This run is repeating itself',
      line: 'Its tools reported a loop.',
    },
    overspending: {
      title: 'This run is over the spend threshold',
      /** `cost` is what the run has cost so far, or in total once it ended. */
      line: (cost: string | undefined, over: boolean): string => {
        const spent = over ? 'It cost' : 'It has cost';
        const amount = cost === undefined ? 'more' : `${cost}, more`;
        return `${spent} ${amount} than the spend threshold.`;
      },
    },
    /**
     * Said once, at the end of the last note, however many states the run is in: none of them
     * stops a run that is still going.
     */
    keepsRunning: 'It keeps running until you stop it.',
  },
} as const;
