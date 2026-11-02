export interface InboxState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}
export class InboxMessage {
  private constructor(private readonly state: InboxState) {}
  static receive(p: Omit<InboxState, "receivedAt" | "processedAt">) {
    if (!p.messageId.trim() || !p.consumerName.trim() || !p.payloadHash.trim())
      throw Error("INVALID_INBOX");
    return new this({ ...p, receivedAt: new Date() });
  }
  static rehydrate(p: InboxState) {
    return new this({
      ...p,
      receivedAt: new Date(p.receivedAt),
      ...(p.processedAt ? { processedAt: new Date(p.processedAt) } : {}),
    });
  }
  isProcessed() {
    return !!this.state.processedAt;
  }
  get processedAt() {
    return this.state.processedAt
      ? new Date(this.state.processedAt)
      : undefined;
  }
  markProcessed(at: Date) {
    if (!Number.isFinite(at.getTime())) throw Error("INVALID_DATE");
    if (!this.isProcessed()) this.state.processedAt = new Date(at);
  }
}
