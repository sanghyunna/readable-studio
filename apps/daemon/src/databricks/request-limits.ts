/** Recognize validation grammar, not arbitrary numbers in upstream prose. */
export function outputCeiling(message: string): number | undefined {
  const field = '(?:max_new_tokens|max_output_tokens|max_completion_tokens|max_tokens)';
  const patterns = [
    new RegExp(`\\b${field}\\s+\\d+\\s+cannot be greater than\\s+${field}\\s+(\\d+)`, 'i'),
    new RegExp(`\\b${field}\\s*:?\\s*(?:\\d+\\s*)?(?:must be|must be less than|cannot be|should be)?\\s*(?:less than or equal to|at most|<=)\\s*(\\d+)`, 'i'),
    new RegExp(`\\b${field}\\s*:\\s*\\d+\\s*>\\s*(\\d+)(?:\\s*[,.;]|\\s*$)`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    const limit = match ? Number(match[1]) : NaN;
    if (Number.isSafeInteger(limit) && limit > 0) return limit;
  }
  return undefined;
}
