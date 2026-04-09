export abstract class TestDataBuilder<T extends object> {
  protected constructor(private readonly initialData: T) {}

  protected set<K extends keyof T>(key: K, value: T[K]): this {
    this.initialData[key] = value;

    return this;
  }

  build(): T {
    return structuredClone(this.initialData);
  }
}

