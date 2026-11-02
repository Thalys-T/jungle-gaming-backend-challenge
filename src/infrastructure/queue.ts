import { OutboxMessage } from "../domain/outbox-message";
import {
  SQSClient,
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from "@aws-sdk/client-sqs";
import type { Processor } from "../application/processor";
import { rows } from "../application/processor";
import { AppError, hash } from "../application/contracts";
import { log, metrics } from "./observability";
export class Queue {
  constructor(private readonly namespace = "") {}
  readonly client = new SQSClient({
    endpoint: process.env.SQS_ENDPOINT ?? "http://127.0.0.1:4566",
    region: process.env.AWS_REGION ?? "us-east-1",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
    maxAttempts: 2,
  });
  input = "";
  dlq = "";
  events = "";
  async init() {
    const create = async (name: string, extra: Record<string, string> = {}) =>
      (
        await this.client.send(
          new CreateQueueCommand({
            QueueName: this.namespace + name,
            Attributes: {
              FifoQueue: "true",
              ContentBasedDeduplication: "false",
              ...extra,
            },
          }),
        )
      ).QueueUrl!;
    this.dlq = await create("wager-transactions-dlq.fifo");
    const a = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.dlq,
        AttributeNames: ["QueueArn"],
      }),
    );
    this.input = await create("wager-transactions.fifo", {
      VisibilityTimeout: "60",
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: a.Attributes!.QueueArn,
        maxReceiveCount: "5",
      }),
    });
    this.events = await create("wager-events.fifo");
  }
  async ready() {
    await Promise.all(
      [this.input, this.events, this.dlq].map((QueueUrl) =>
        this.client.send(
          new GetQueueAttributesCommand({
            QueueUrl,
            AttributeNames: ["QueueArn"],
          }),
        ),
      ),
    );
  }
  async send(
    url: string,
    payload: unknown,
    group: string,
    dedup: string = crypto.randomUUID(),
  ) {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: url,
        MessageBody: JSON.stringify(payload),
        MessageGroupId: group,
        MessageDeduplicationId: dedup,
      }),
    );
  }
  async publishOne(p: Processor) {
    return p.orm.em.fork().transactional(async (em) => {
      const [o] = await rows(
        em,
        `select * from outbox_messages where published_at is null and next_attempt_at<=now() order by occurred_at,id for update skip locked limit 1`,
      );
      if (!o) return false;
      const state = OutboxMessage.rehydrate({
        id: o.id,
        aggregateId: o.aggregate_id,
        eventType: o.event_type,
        payload: o.payload,
        occurredAt: new Date(o.occurred_at),
        attempts: o.attempts,
        nextAttemptAt: new Date(o.next_attempt_at),
      });
      try {
        await this.send(this.events, o.payload, o.aggregate_id, o.id);
        if (process.env.CRASH_AFTER_PUBLISH === "1") process.exit(98);
        // Stable event id is the downstream dedup identity even after SQS's five minute window.
        state.markPublished(new Date());
        await rows(
          em,
          "update outbox_messages set published_at=?,attempts=attempts+1 where id=?",
          [state.publishedAt, o.id],
        );
      } catch (e) {
        metrics.inc("retries");
        state.scheduleRetry(new Date());
        await rows(
          em,
          "update outbox_messages set attempts=?,next_attempt_at=? where id=?",
          [state.attempts, state.nextAttemptAt, o.id],
        );
      }
      return true;
    });
  }
  async consume(p: Processor, stopping: () => boolean) {
    const messages = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.input,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    );
    for (const msg of messages.Messages ?? []) {
      const receipt = msg.ReceiptHandle!;
      if (stopping()) {
        await this.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.input,
            ReceiptHandle: receipt,
            VisibilityTimeout: 0,
          }),
        );
        continue;
      }
      // Heartbeat keeps ownership while the SQL transaction is active.
      const heartbeat = setInterval(() => {
        void this.client
          .send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: this.input,
              ReceiptHandle: receipt,
              VisibilityTimeout: 60,
            }),
          )
          .catch(() => {});
      }, 20000);
      try {
        let envelope: any;
        try {
          envelope = JSON.parse(msg.Body ?? "");
        } catch {
          throw new AppError("INVALID_JSON", 400);
        }
        if (
          envelope?.type !== "WagerTransactionRequested" ||
          typeof envelope.messageId !== "string" ||
          !envelope.messageId.trim()
        )
          throw new AppError("INVALID_ENVELOPE", 400);
        await p.submit(envelope.data, envelope.data?.idempotencyKey, {
          messageId: envelope.messageId,
          consumerName: "wagering-v1",
          payloadHash: hash({ data: envelope.data, type: envelope.type }),
        });
        if (process.env.CRASH_AFTER_COMMIT === "1") process.exit(99);
        await this.client.send(
          new DeleteMessageCommand({
            QueueUrl: this.input,
            ReceiptHandle: receipt,
          }),
        );
      } catch (e) {
        const attempts = Number(msg.Attributes?.ApproximateReceiveCount ?? "1");
        if (e instanceof AppError && [400, 409, 404].includes(e.httpStatus)) {
          // Permanent contract errors are retained in DLQ before acknowledgement.
          await this.send(
            this.dlq,
            { originalBody: msg.Body, failureCode: e.code },
            msg.MessageId!,
            msg.MessageId!,
          );
          metrics.inc("dlq");
          await this.client.send(
            new DeleteMessageCommand({
              QueueUrl: this.input,
              ReceiptHandle: receipt,
            }),
          );
        } else {
          metrics.inc("retries");
          if (attempts >= 5) metrics.inc("dlq");
          await this.client.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: this.input,
              ReceiptHandle: receipt,
              VisibilityTimeout: Math.min(60, 2 ** attempts),
            }),
          );
          log("consumer_retry", {
            messageId: msg.MessageId,
            code: e instanceof AppError ? e.code : "INFRASTRUCTURE_UNAVAILABLE",
          });
        }
      } finally {
        clearInterval(heartbeat);
      }
    }
  }
}
export class Workers {
  private stopped = false;
  private task: Promise<void> | undefined;
  constructor(
    private p: Processor,
    private q: Queue,
  ) {}
  start() {
    this.task = this.loop();
  }
  private async loop() {
    while (!this.stopped) {
      await Promise.allSettled([
        this.q.consume(this.p, () => this.stopped),
        this.publishBatch(),
        this.p.retryReferences(),
      ]).then((results) => {
        for (const r of results)
          if (r.status === "rejected")
            log("worker_error", { code: "INFRASTRUCTURE_UNAVAILABLE" });
      });
      if (!this.stopped) await Bun.sleep(250);
    }
  }
  private async publishBatch() {
    for (let i = 0; i < 20 && !this.stopped; i++)
      if (!(await this.q.publishOne(this.p))) break;
  }
  async stop() {
    this.stopped = true;
    await this.task;
    this.q.client.destroy();
  }
}
