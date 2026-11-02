export function log(event: string, context: Record<string, unknown> = {}) {
  console.log(
    JSON.stringify({ timestamp: new Date().toISOString(), event, ...context }),
  );
}
class Metrics {
  private readonly counters = new Map<string, number>(
    [
      "duplicates",
      "retries",
      "dlq",
      "lock_conflicts",
      "reconciliation_divergence",
      "transactions_processed",
      "transactions_rejected",
      "transactions_pending_reference",
    ].map((k) => [k, 0]),
  );
  private duration = 0;
  private count = 0;
  inc(name: string) {
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
  }
  observe(ms: number) {
    this.duration += ms / 1000;
    this.count++;
  }
  render(lag = 0) {
    return (
      [...this.counters].map(([k, v]) => `jungle_${k}_total ${v}`).join("\n") +
      `\njungle_processing_seconds_sum ${this.duration}\njungle_processing_seconds_count ${this.count}\njungle_outbox_lag_seconds ${lag}\n`
    );
  }
}
export const metrics = new Metrics();
