const counters = new Map<string, number>();

export function nextTestSequence(key: string): number {
  const currentValue = counters.get(key) ?? 0;
  const nextValue = currentValue + 1;

  counters.set(key, nextValue);

  return nextValue;
}

export function nextTestId(prefix: string): string {
  return `${prefix}_${nextTestSequence(prefix)}`;
}

export function resetTestSequences(): void {
  counters.clear();
}

