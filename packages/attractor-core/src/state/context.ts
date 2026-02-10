/**
 * Pipeline execution context - a key-value store shared across all stages.
 */
export class Context {
  private values: Map<string, unknown> = new Map();
  private logs: string[] = [];

  set(key: string, value: unknown): void {
    this.values.set(key, value);
  }

  get(key: string, defaultValue?: unknown): unknown {
    const val = this.values.get(key);
    return val !== undefined ? val : defaultValue;
  }

  getString(key: string, defaultValue = ""): string {
    const val = this.get(key);
    if (val === undefined || val === null) return defaultValue;
    return String(val);
  }

  getNumber(key: string, defaultValue = 0): number {
    const val = this.get(key);
    if (val === undefined || val === null) return defaultValue;
    return Number(val);
  }

  has(key: string): boolean {
    return this.values.has(key);
  }

  delete(key: string): void {
    this.values.delete(key);
  }

  appendLog(entry: string): void {
    this.logs.push(entry);
  }

  getLogs(): readonly string[] {
    return this.logs;
  }

  /** Returns a serializable snapshot of all values */
  snapshot(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of this.values) {
      result[key] = value;
    }
    return result;
  }

  /** Deep copy for parallel branch isolation */
  clone(): Context {
    const ctx = new Context();
    for (const [key, value] of this.values) {
      ctx.values.set(key, value);
    }
    ctx.logs = [...this.logs];
    return ctx;
  }

  /** Merge a dictionary of updates into the context */
  applyUpdates(updates: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(updates)) {
      this.values.set(key, value);
    }
  }

  /** Restore context from a snapshot */
  static fromSnapshot(data: Record<string, unknown>): Context {
    const ctx = new Context();
    for (const [key, value] of Object.entries(data)) {
      ctx.values.set(key, value);
    }
    return ctx;
  }
}
