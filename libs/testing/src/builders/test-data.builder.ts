export abstract class TestDataBuilder<T extends object> {
  protected constructor(private readonly initialData: T) {}

  protected set<K extends keyof T>(key: K, value: T[K]): this {
    this.initialData[key] = value;

    return this;
  }

  build(): T {
    return cloneValue(this.initialData);
  }
}

function cloneValue<T>(value: T): T {
  if (value instanceof Date) {
    return new Date(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as T;
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        cloneValue(entryValue),
      ]),
    ) as T;
  }

  return value;
}
