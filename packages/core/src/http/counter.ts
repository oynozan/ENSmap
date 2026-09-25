export class CallCounter {
  readonly #counts = new Map<string, number>();

  inc(provider: string): void {
    this.#counts.set(provider, (this.#counts.get(provider) ?? 0) + 1);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(
      [...this.#counts].sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  }

  format(): string {
    const entries = Object.entries(this.snapshot());
    if (entries.length === 0) {
      return 'API calls: none';
    }
    return `API calls: ${entries.map(([provider, count]) => `${provider}=${count}`).join(', ')}`;
  }
}
