import { afterAll, beforeAll, expect, test } from "bun:test";
import { connect } from "../../src/infrastructure/database/connection";
import { Processor, rows } from "../../src/application/processor";
import { Queue } from "../../src/infrastructure/queue";
import {
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
let orm: MikroORM, p: Processor, q: Queue;
beforeAll(async () => {
  orm = await connect();
  await orm.getMigrator().up();
  p = new Processor(orm);
  q = new Queue();
  await q.init();
});
afterAll(async () => {
  q?.client.destroy();
  await orm?.close();
});
async function until(fn: () => Promise<boolean>, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await Bun.sleep(100);
  }
  throw Error("Condition timeout");
}
async function setup() {
  const w = await p.createWallet({
    playerId: crypto.randomUUID(),
    initialBalance: { amount: "100.00", currency: "BRL" },
  });
  const external = crypto.randomUUID();
  const data = {
    providerId: "sqs-test",
    externalTransactionId: external,
    idempotencyKey: "sqs-test:" + external,
    walletId: w.id,
    playerId: w.playerId,
    roundId: "r",
    gameId: "g",
    kind: "BET",
    money: { amount: "10.00", currency: "BRL" },
  };
  return {
    w,
    envelope: {
      messageId: crypto.randomUUID(),
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data,
    },
  };
}
test("SQS real: redelivery com outro transport ID mantém um débito e inbox", async () => {
  const { w, envelope } = await setup();
  await q.send(q.input, envelope, w.id);
  await q.send(q.input, envelope, w.id);
  await until(async () => {
    await q.consume(p, () => false);
    const [r] = await rows(
      orm.em.fork(),
      "select * from inbox_messages where message_id=?",
      [envelope.messageId],
    );
    return !!r?.processed_at;
  });
  // The duplicate may still be queued; consume again before assertions.
  await q.consume(p, () => false);
  const [r] = await rows(
    orm.em.fork(),
    `select count(*)::int as n from wallet_ledger_entries where wallet_id=? and direction='DEBIT'`,
    [w.id],
  );
  expect(r.n).toBe(1);
  expect((await p.reconcile(w.id)).consistent).toBe(true);
});
test("publishers concorrentes publicam outbox e preservam eventId", async () => {
  const { w, envelope } = await setup();
  await p.submit(envelope.data, envelope.data.idempotencyKey);
  await until(async () => {
    await Promise.all([q.publishOne(p), q.publishOne(p)]);
    const pending = await rows(
      orm.em.fork(),
      "select id from outbox_messages where aggregate_id=? and published_at is null",
      [w.id],
    );
    return pending.length === 0;
  }, 60000);
  const events = await rows(
    orm.em.fork(),
    "select * from outbox_messages where aggregate_id=?",
    [w.id],
  );
  expect(events.length).toBe(4);
  expect(
    events.every((e) => e.published_at && e.payload.eventId === e.id),
  ).toBe(true);
  expect((await p.reconcile(w.id)).consistent).toBe(true);
});
test("payload inválido vai para DLQ antes do ack", async () => {
  const marker = crypto.randomUUID();
  await q.send(q.input, { messageId: marker, type: "INVALID" }, marker);
  await q.consume(p, () => false);
  let found = false;
  await until(async () => {
    const r = await q.client.send(
      new ReceiveMessageCommand({
        QueueUrl: q.dlq,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      }),
    );
    for (const m of r.Messages ?? []) {
      if (m.Body?.includes(marker)) found = true;
      await q.client.send(
        new DeleteMessageCommand({
          QueueUrl: q.dlq,
          ReceiptHandle: m.ReceiptHandle!,
        }),
      );
    }
    return found;
  });
  expect(found).toBe(true);
});
test("morte após commit e antes do ack permite recuperação por outra conexão", async () => {
  const { w, envelope } = await setup();
  await q.send(q.input, envelope, w.id);
  const child = Bun.spawn([process.execPath, "src/worker.ts"], {
    env: { ...process.env, CRASH_AFTER_COMMIT: "1" },
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    await until(async () => {
      const [r] = await rows(
        orm.em.fork(),
        "select * from inbox_messages where message_id=?",
        [envelope.messageId],
      );
      return !!r?.processed_at;
    }, 30000);
    expect(await child.exited).toBe(99);
    // Visibility timeout returns the unacknowledged message automatically after 60s.
    await until(async () => {
      await q.consume(p, () => false);
      const a = await q.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: q.input,
          AttributeNames: ["ApproximateNumberOfMessagesNotVisible"],
        }),
      );
      return a.Attributes?.ApproximateNumberOfMessagesNotVisible === "0";
    }, 90000);
    expect((await p.wallet(w.id)).balance.amount).toBe("90.00");
    expect((await p.reconcile(w.id)).consistent).toBe(true);
  } finally {
    child.kill();
  }
}, 120000);
test("erro transitório de publicação agenda retry sem perder evento", async () => {
  const { w } = await setup();
  const original = q.events;
  q.events = original + "-missing";
  try {
    await until(async () => {
      await q.publishOne(p);
      const r = await rows(
        orm.em.fork(),
        "select * from outbox_messages where aggregate_id=? and attempts>0 and published_at is null",
        [w.id],
      );
      return r.length > 0;
    });
  } finally {
    q.events = original;
  }
  await rows(
    orm.em.fork(),
    "update outbox_messages set next_attempt_at=now() where aggregate_id=?",
    [w.id],
  );
  await until(async () => {
    await q.publishOne(p);
    return (
      (
        await rows(
          orm.em.fork(),
          "select id from outbox_messages where aggregate_id=? and published_at is null",
          [w.id],
        )
      ).length === 0
    );
  });
  expect((await p.reconcile(w.id)).consistent).toBe(true);
});
test("publisher crash: envio antes de marcar é recuperado com mesmo eventId", async () => {
  while (await q.publishOne(p)) {
    // Publica os eventos anteriores que já estão disponíveis.
  }

  const { w } = await setup();

  const [first] = await rows(
    orm.em.fork(),
    `select * from outbox_messages
     where published_at is null and next_attempt_at<=now()
     order by occurred_at,id limit 1`,
  );

  expect(first).toBeTruthy();

  const child = Bun.spawn(
    [process.execPath, "scripts/publish-once.ts"],
    {
      env: { ...process.env, CRASH_AFTER_PUBLISH: "1" },
      stdout: "ignore",
      stderr: "pipe",
    },
  );

  expect(await child.exited).toBe(98);

  const [afterCrash] = await rows(
    orm.em.fork(),
    "select * from outbox_messages where id=?",
    [first.id],
  );

  expect(afterCrash.published_at).toBeNull();

  await until(async () => {
    await q.publishOne(p);

    const [event] = await rows(
      orm.em.fork(),
      "select published_at from outbox_messages where id=?",
      [first.id],
    );

    return Boolean(event?.published_at);
  }, 30000);

  const [recovered] = await rows(
    orm.em.fork(),
    "select * from outbox_messages where id=?",
    [first.id],
  );

  expect(recovered.published_at).toBeTruthy();
  expect(recovered.payload.eventId).toBe(first.id);
  expect((await p.reconcile(w.id)).consistent).toBe(true);
});
