import { expect, test } from "bun:test";
import { InboxMessage } from "../../src/domain/inbox-message";
import { OutboxMessage } from "../../src/domain/outbox-message";
import { WagerTransactionProcessed } from "../../src/domain/events";
test("inbox protege datas e marca processamento sem perder estado", () => {
  const inbox = InboxMessage.receive({
    messageId: "m",
    consumerName: "c",
    payloadHash: "h",
  });
  expect(inbox.isProcessed()).toBe(false);
  const at = new Date();
  inbox.markProcessed(at);
  at.setFullYear(2000);
  expect(inbox.isProcessed()).toBe(true);
  expect(inbox.processedAt?.getFullYear()).not.toBe(2000);
});
test("outbox retry persiste backoff e publicação encerra tentativas", () => {
  const at = new Date();
  const event = WagerTransactionProcessed.create({
    eventId: "e",
    aggregateId: "a",
    correlationId: "c",
    occurredAt: at,
    data: { transactionId: "t" },
  });
  const box = OutboxMessage.enqueue(event);
  expect(box.isDue(at)).toBe(true);
  box.scheduleRetry(at);
  expect(box.attempts).toBe(1);
  expect(box.isDue(at)).toBe(false);
  expect(box.isDue(new Date(at.getTime() + 2000))).toBe(true);
  box.markPublished(at);
  expect(box.isPending()).toBe(false);
  expect(() => box.scheduleRetry(at)).toThrow();
});
test("evento não mantém referência mutável ao payload original", () => {
  const data = { balance: { amount: "1.00", currency: "BRL" } };
  const e = WagerTransactionProcessed.create({
    eventId: "e",
    aggregateId: "a",
    correlationId: "c",
    occurredAt: new Date(),
    data,
  });
  data.balance.amount = "100.00";
  expect((e.toJSON().data as any).balance.amount).toBe("1.00");
});
