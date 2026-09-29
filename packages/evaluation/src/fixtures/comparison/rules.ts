/**
 * A predeclared admission rule for the comparison fixtures. Every threshold
 * is written out here, in the rule's own versioned document: the schema has
 * no defaults, so nothing is borrowed from a benchmark paper.
 */
export function admissionRuleInput(taskClass: unknown = 'partitioned-search'): Record<string, any> {
  return {
    kind: 'collaboration-admission-rule',
    name: 'fixture-admission',
    version: '1',
    taskClass,
    minimumCases: 1,
    quality: {
      successComparison: 'point-estimate',
      minimumSuccessGain: 0.2,
      minimumVerifierAcceptance: 0.9,
    },
    safety: {
      forbiddenFailureLabels: [
        'premature-completion',
        'conflicting-commits',
        'untrusted-message-elevation',
        'prompt-infection',
        'faulty-agent-contamination',
      ],
      maximumUnresolvedContradictions: 0,
      maximumPropagatedFaults: 0,
      maximumStaleReads: 0,
    },
    tradeoffs: {
      maximumCostRatio: { direct: 5, ensemble: 1.5 },
      maximumLatencyRatio: { direct: 5, ensemble: 1.5 },
    },
  };
}
