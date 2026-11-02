export interface EventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}
export abstract class IntegrationEvent<T extends Record<string, unknown>> {
  abstract readonly eventType: string;
  readonly version = 1;
  protected readonly props: EventProps<T>;
  protected constructor(props: EventProps<T>) {
    this.props = {
      ...props,
      occurredAt: new Date(props.occurredAt),
      data: structuredClone(props.data),
    };
  }
  toJSON() {
    return {
      ...this.props,
      occurredAt: this.props.occurredAt.toISOString(),
      eventType: this.eventType,
      version: this.version,
      data: structuredClone(this.props.data),
    };
  }
}
export class WagerTransactionProcessed extends IntegrationEvent<
  Record<string, unknown>
> {
  readonly eventType = "WagerTransactionProcessed";
  static create(p: EventProps<Record<string, unknown>>) {
    return new this(p);
  }
}
export class WagerTransactionRejected extends IntegrationEvent<
  Record<string, unknown>
> {
  readonly eventType = "WagerTransactionRejected";
  static create(p: EventProps<Record<string, unknown>>) {
    return new this(p);
  }
}
export class WagerTransactionPendingReference extends IntegrationEvent<
  Record<string, unknown>
> {
  readonly eventType = "WagerTransactionPendingReference";
  static create(p: EventProps<Record<string, unknown>>) {
    return new this(p);
  }
}
export class WalletBalanceChanged extends IntegrationEvent<
  Record<string, unknown>
> {
  readonly eventType = "WalletBalanceChanged";
  static create(p: EventProps<Record<string, unknown>>) {
    return new this(p);
  }
}
