import { beforeAll, afterAll, expect, test } from "bun:test";
import { connect } from "../../src/infrastructure/database/connection";
import { Processor, rows } from "../../src/application/processor";
import type { MikroORM } from "@mikro-orm/postgresql";
let orm: MikroORM, p: Processor;
beforeAll(async () => {
  orm = await connect();
  await orm.getMigrator().up();
  p = new Processor(orm);
});
afterAll(async () => {
  await orm?.close();
});
async function wallet(amount = "100.00") {
  return p.createWallet({
    playerId: crypto.randomUUID(),
    initialBalance: { amount, currency: "BRL" },
  });
}
function operation(
  w: any,
  kind = "BET",
  amount = "80.00",
  extra: Record<string, unknown> = {},
) {
  return {
    providerId: "test-provider",
    externalTransactionId: crypto.randomUUID(),
    playerId: w.playerId,
    walletId: w.id,
    roundId: "round",
    gameId: "game",
    kind,
    money: { amount, currency: "BRL" },
    ...extra,
  };
}
async function submit(c: any) {
  return p.submit(c, c.providerId + ":" + c.externalTransactionId);
}
test("50 chamadas paralelas debitam uma vez e preservam replay histórico", async () => {
  const w = await wallet(),
    c = operation(w);
  const results = await Promise.all(
    Array.from({ length: 50 }, () => submit(c)),
  );
  expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
  expect((await p.wallet(w.id)).balance.amount).toBe("20.00");
  await submit(operation(w, "WIN", "5.00"));
  expect((await submit(c)).balance.amount).toBe("20.00");
  expect((await p.reconcile(w.id)).consistent).toBe(true);
  const [r] = await rows(
    orm.em.fork(),
    `select count(*)::int as n from wallet_ledger_entries where wallet_id=? and direction='DEBIT'`,
    [w.id],
  );
  expect(r.n).toBe(1);
});
test("duas apostas de 80 disputam 100 sem saldo negativo", async () => {
  const w = await wallet();
  const r = await Promise.all([submit(operation(w)), submit(operation(w))]);
  expect(r.map((t) => t.status).sort()).toEqual(["PROCESSED", "REJECTED"]);
  expect((await p.wallet(w.id)).balance.amount).toBe("20.00");
  expect((await p.reconcile(w.id)).consistent).toBe(true);
});
test("mesma chave com payload divergente ou outra wallet é conflito", async () => {
  const w = await wallet(),
    c = operation(w);
  await p.submit(c, "conflict-" + w.id);
  await expect(
    p.submit(
      { ...c, money: { amount: "1.00", currency: "BRL" } },
      "conflict-" + w.id,
    ),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
});
test("WIN, LOSS, REFUND e ROLLBACK preservam ledger e versões", async () => {
  const w = await wallet(),
    bet = operation(w, "BET", "20.00");
  await submit(bet);
  const refund = operation(w, "REFUND", "20.00", {
    referenceExternalTransactionId: bet.externalTransactionId,
  });
  expect((await submit(refund)).status).toBe("PROCESSED");
  expect(
    (
      await submit(
        operation(w, "REFUND", "20.00", {
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      )
    ).failureCode,
  ).toBe("ALREADY_REVERSED");
  expect(
    (
      await submit(
        operation(w, "ROLLBACK", "20.00", {
          referenceExternalTransactionId: refund.externalTransactionId,
        }),
      )
    ).status,
  ).toBe("PROCESSED");
  await submit(operation(w, "LOSS", "0.00"));
  expect((await p.wallet(w.id)).balance.amount).toBe("80.00");
  expect((await p.wallet(w.id)).version).toBe(4);
  expect((await p.reconcile(w.id)).consistent).toBe(true);
});
test("reversão insuficiente tem código distinto", async () => {
  const w = await wallet("0.00"),
    win = operation(w, "WIN", "10.00");
  await submit(win);
  await submit(operation(w, "BET", "10.00"));
  const r = await submit(
    operation(w, "ROLLBACK", "10.00", {
      referenceExternalTransactionId: win.externalTransactionId,
    }),
  );
  expect(r.failureCode).toBe("REVERSAL_INSUFFICIENT_FUNDS");
  expect((await p.reconcile(w.id)).consistent).toBe(true);
});
test("referência entregue depois é recuperada pelo worker e expira com limite", async () => {
  const w = await wallet(),
    bet = operation(w, "BET", "10.00");
  const refund = operation(w, "REFUND", "10.00", {
    referenceExternalTransactionId: bet.externalTransactionId,
  });
  const r = await submit(refund);
  expect(r.status).toBe("PENDING_REFERENCE");
  await submit(bet);
  await rows(
    orm.em.fork(),
    "update wager_transactions set next_attempt_at=now() where id=?",
    [r.transactionId],
  );
  await p.retryReferences();
  expect((await p.transaction(r.transactionId)).status).toBe("PROCESSED");
  expect((await p.reconcile(w.id)).consistent).toBe(true);
  const missing = await submit(
    operation(w, "ROLLBACK", "10.00", {
      referenceExternalTransactionId: "absent",
    }),
  );
  await rows(
    orm.em.fork(),
    "update wager_transactions set attempts=9,next_attempt_at=now() where id=?",
    [missing.transactionId],
  );
  await p.retryReferences();
  expect((await p.transaction(missing.transactionId)).failureCode).toBe(
    "REFERENCE_EXPIRED",
  );
});
test("inbox é atômica com ledger e outbox; redelivery não duplica", async () => {
  const w = await wallet(),
    c = operation(w, "BET", "1.00"),
    ctx = {
      messageId: crypto.randomUUID(),
      consumerName: "test",
      payloadHash: "same",
    };
  const first = await p.submit(c, "inbox-" + w.id, ctx);
  const again = await p.submit(c, "inbox-" + w.id, ctx);
  expect(again.idempotentReplay).toBe(true);
  const [inbox] = await rows(
    orm.em.fork(),
    "select * from inbox_messages where message_id=?",
    [ctx.messageId],
  );
  expect(inbox.processed_at).toBeTruthy();
  const events = await rows(
    orm.em.fork(),
    `select * from outbox_messages where payload->>'causationId'=?`,
    [first.transactionId],
  );
  expect(events).toHaveLength(2);
  await expect(
    p.submit(c, "inbox-" + w.id, { ...ctx, payloadHash: "changed" }),
  ).rejects.toThrow("INBOX_PAYLOAD_CONFLICT");
  expect((await p.reconcile(w.id)).consistent).toBe(true);
});
test("schema impede mutação do ledger e carteira duplicada", async () => {
  const w = await wallet();
  await expect(
    p.createWallet({
      playerId: w.playerId,
      initialBalance: { amount: "0.00", currency: "BRL" },
    }),
  ).rejects.toThrow("UNIQUE_CONFLICT");
  await expect(
    rows(
      orm.em.fork(),
      "update wallet_ledger_entries set amount=1 where wallet_id=?",
      [w.id],
    ),
  ).rejects.toThrow();
  await expect(
    rows(orm.em.fork(), "delete from wallet_ledger_entries where wallet_id=?", [
      w.id,
    ]),
  ).rejects.toThrow();
  await expect(
    rows(orm.em.fork(), "update wallets set balance=-1 where id=?", [w.id]),
  ).rejects.toThrow();
  await expect(
    rows(orm.em.fork(), "update wallets set balance=1 where id=?", [w.id]),
  ).rejects.toThrow();
  expect((await p.reconcile(w.id)).consistent).toBe(true);
});
test("referência incorreta, moeda divergente, reversão parcial e paginação", async () => {
  const w = await wallet(),
    b = operation(w, "BET", "10.00");
  await submit(b);
  expect(
    (
      await submit(
        operation(w, "REFUND", "5.00", {
          referenceExternalTransactionId: b.externalTransactionId,
        }),
      )
    ).failureCode,
  ).toBe("REVERSAL_AMOUNT_MISMATCH");
  expect(
    (
      await submit({
        ...operation(w),
        money: { amount: "1.00", currency: "USD" },
      })
    ).failureCode,
  ).toBe("CURRENCY_MISMATCH");
  const first = await p.ledger(w.id, undefined, "1");
  expect(first.entries).toHaveLength(1);
  expect(first.nextCursor).toBeTruthy();
  const next = await p.ledger(w.id, first.nextCursor!, "1");
  expect(next.entries[0].id).not.toBe(first.entries[0].id);
  expect(next.nextCursor).toBeNull();
});
test("falha ao gravar outbox desfaz saldo, ledger, transação e inbox", async () => {
  const w = await wallet(),
    c = operation(w, "BET", "1.00"),
    ctx = {
      messageId: crypto.randomUUID(),
      consumerName: "atomic",
      payloadHash: "payload",
    };
  const suffix = w.id.replaceAll("-", "");
  await rows(
    orm.em.fork(),
    `create function fail_${suffix}() returns trigger language plpgsql as $$ begin if NEW.aggregate_id='${w.id}'::uuid then raise exception 'TEST_OUTBOX_FAILURE'; end if; return NEW; end $$`,
  );
  await rows(
    orm.em.fork(),
    `create trigger fail_${suffix} before insert on outbox_messages for each row execute function fail_${suffix}()`,
  );
  try {
    await expect(p.submit(c, "atomic-" + w.id, ctx)).rejects.toThrow();
    expect((await p.wallet(w.id)).balance.amount).toBe("100.00");
    expect(
      await rows(
        orm.em.fork(),
        "select * from inbox_messages where message_id=?",
        [ctx.messageId],
      ),
    ).toHaveLength(0);
    expect(
      await rows(
        orm.em.fork(),
        "select * from wager_transactions where external_transaction_id=?",
        [c.externalTransactionId],
      ),
    ).toHaveLength(0);
    expect((await p.reconcile(w.id)).consistent).toBe(true);
  } finally {
    await rows(orm.em.fork(), `drop trigger fail_${suffix} on outbox_messages`);
    await rows(orm.em.fork(), `drop function fail_${suffix}()`);
  }
});
