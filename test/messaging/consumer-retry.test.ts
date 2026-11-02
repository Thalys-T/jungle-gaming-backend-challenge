import { expect, test } from "bun:test";
import { DeleteQueueCommand, ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import { connect } from "../../src/infrastructure/database/connection";
import { Processor, rows } from "../../src/application/processor";
import { Queue } from "../../src/infrastructure/queue";

for (const recover of [true, false]) {
  test(`consumidor com falha SQL real: ${recover ? "recupera sem duplicar" : "esgota cinco tentativas e redrive para DLQ"}`, async () => {
    const orm = await connect();
    const p = new Processor(orm);
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const q = new Queue("retry-" + suffix + "-");
    let installed = false;
    try {
      await orm.getMigrator().up();
      await q.init();
      const w = await p.createWallet({ playerId: crypto.randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" } });
      const data = { providerId: "retry-test", externalTransactionId: suffix, idempotencyKey: suffix, walletId: w.id, playerId: w.playerId, roundId: "r", gameId: "g", kind: "BET", money: { amount: "10.00", currency: "BRL" } };
      const envelope = { messageId: suffix, type: "WagerTransactionRequested", occurredAt: new Date().toISOString(), data };
      await rows(orm.em.fork(), `create function retry_${suffix}() returns trigger language plpgsql as $$ begin if NEW.wallet_id='${w.id}'::uuid then raise exception 'TEMPORARY_DATABASE_FAILURE' using errcode='40001'; end if; return NEW; end $$`);
      await rows(orm.em.fork(), `create trigger retry_${suffix} before insert on wager_transactions for each row execute function retry_${suffix}()`);
      installed = true;
      await q.send(q.input, envelope, w.id);
      await q.consume(p, () => false);
      expect((await p.wallet(w.id)).balance.amount).toBe("100.00");
      expect(await rows(orm.em.fork(), "select * from inbox_messages where message_id=?", [suffix])).toHaveLength(0);
      if (recover) {
        await rows(orm.em.fork(), `drop trigger retry_${suffix} on wager_transactions`);
        installed = false;
      }
      const end = Date.now() + 100000;
      let complete = false;
      while (Date.now() < end && !complete) {
        await q.consume(p, () => false);
        if (recover) {
          complete = (await p.wallet(w.id)).balance.amount === "90.00";
        } else {
          const result = await q.client.send(new ReceiveMessageCommand({ QueueUrl: q.dlq, WaitTimeSeconds: 1, MessageSystemAttributeNames: ["ApproximateReceiveCount"] }));
          for (const msg of result.Messages ?? []) {
            expect(JSON.parse(msg.Body!).messageId).toBe(suffix);
            expect(Number(msg.Attributes?.ApproximateReceiveCount)).toBeGreaterThanOrEqual(6);
            await q.client.send(new DeleteMessageCommand({ QueueUrl: q.dlq, ReceiptHandle: msg.ReceiptHandle! }));
            complete = true;
          }
        }
      }
      expect(complete).toBe(true);
      if (recover) {
        await q.send(q.input, envelope, w.id);
        await q.consume(p, () => false);
      }
      const debits = await rows(orm.em.fork(), "select id from wallet_ledger_entries where wallet_id=? and direction='DEBIT'", [w.id]);
      expect(debits).toHaveLength(recover ? 1 : 0);
      expect((await p.reconcile(w.id)).consistent).toBe(true);
    } finally {
      if (installed) await rows(orm.em.fork(), `drop trigger retry_${suffix} on wager_transactions`);
      await rows(orm.em.fork(), `drop function if exists retry_${suffix}()`);
      for (const url of [q.input,q.dlq,q.events].filter(Boolean)) await q.client.send(new DeleteQueueCommand({ QueueUrl: url }));
      q.client.destroy();
      await orm.close();
    }
  }, 120000);
}
