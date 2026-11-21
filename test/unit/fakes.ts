export class FakeMemento {
  data = new Map<string, unknown>();
  keys(): readonly string[] { return [...this.data.keys()]; }
  get<T>(key: string, def?: T): T | undefined { return (this.data.has(key) ? this.data.get(key) : def) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.data.delete(key); else this.data.set(key, JSON.parse(JSON.stringify(value)));
  }
}
export class FakeSecrets {
  data = new Map<string, string>();
  async get(k: string) { return this.data.get(k); }
  async store(k: string, v: string) { this.data.set(k, v); }
  async delete(k: string) { this.data.delete(k); }
  onDidChange = () => ({ dispose() {} });
}
