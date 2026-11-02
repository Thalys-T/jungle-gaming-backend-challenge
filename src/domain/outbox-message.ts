import type { IntegrationEvent } from "./events";
export interface OutboxState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}
export class OutboxMessage {
  private constructor(private readonly state: OutboxState) {}
  static enqueue(event: IntegrationEvent<Record<string, unknown>>) {
    const p = event.toJSON();
    return new this({
      id: p.eventId,
      aggregateId: p.aggregateId,
      eventType: p.eventType,
      payload: structuredClone(p),
      occurredAt: new Date(p.occurredAt),
      attempts: 0,
    });
  }
  static rehydrate(p: OutboxState) {
    return new this({
      ...p,
      payload: structuredClone(p.payload),
      occurredAt: new Date(p.occurredAt),
      ...(p.nextAttemptAt ? { nextAttemptAt: new Date(p.nextAttemptAt) } : {}),
      ...(p.publishedAt ? { publishedAt: new Date(p.publishedAt) } : {}),
    });
  }
  get attempts() {
    return this.state.attempts;
  }
  get nextAttemptAt() {
    return this.state.nextAttemptAt
      ? new Date(this.state.nextAttemptAt)
      : undefined;
  }
  get publishedAt() {
    return this.state.publishedAt
      ? new Date(this.state.publishedAt)
      : undefined;
  }
  isPending() {
    return !this.state.publishedAt;
  }
  isDue(now: Date) {
    return (
      this.isPending() &&
      (!this.state.nextAttemptAt || this.state.nextAttemptAt <= now)
    );
  }
  markPublished(at: Date) {
    if (!this.isPending()) throw Error("OUTBOX_ALREADY_PUBLISHED");
    this.state.publishedAt = new Date(at);
  }
  scheduleRetry(now: Date) {
    if (!this.isPending()) throw Error("OUTBOX_ALREADY_PUBLISHED");
    this.state.attempts++;
    this.state.nextAttemptAt = new Date(
      now.getTime() +
        Math.min(60000, 1000 * 2 ** Math.min(this.state.attempts, 6)),
    );
  }
}
