import { afterAll, beforeAll, expect, test } from "bun:test";
import { connect } from "../../src/infrastructure/database/connection";
import { Processor, rows } from "../../src/application/processor";
import type { MikroORM } from "@mikro-orm/postgresql";

let orm: MikroORM, p: Processor;
beforeAll(async () => {
  orm = await connect();
  await orm.getMigrator().up();
  p = new Processor(orm);
});
afterAll(async () => { await orm?.close(); });

for (const scenario of ["missing-ledger", "wrong-direction", "wrong-version", "initial-version", "broken-chain"] as const) {
  test(`schema rejeita ${scenario} mesmo por SQL direto`, async () => {
    const w = await p.createWallet({ playerId: crypto.randomUUID(), initialBalance: { amount: "0.00", currency: "BRL" } });
    await expect(orm.em.fork().transactional(async em => {
      if (scenario === "wrong-version") {
        await rows(em, "update wallets set version=999 where id=?", [w.id]);
      } else if (scenario === "initial-version") {
        await rows(em, "insert into wallets(id,player_id,currency,balance,version,created_at,updated_at) values (?,?,'BRL',0,2,now(),now())", [crypto.randomUUID(), crypto.randomUUID()]);
      } else {
        const id = crypto.randomUUID();
        const kind = scenario === "broken-chain" ? "WIN" : "BET";
        await rows(em, "insert into wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status) values (?,'schema',?,?, 'hash',?,?,'r','g',?,10,'BRL','PROCESSED')", [id,id,id,w.id,w.playerId,kind]);
        if (scenario !== "missing-ledger") {
          await rows(em, "update wallets set balance=10,version=2 where id=?", [w.id]);
          await rows(em, "insert into wallet_ledger_entries(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after,wallet_version) values (?,?,?,'CREDIT',10,'BRL',?,?,2)", [crypto.randomUUID(),w.id,id,scenario === "broken-chain" ? "5.00" : "0.00",scenario === "broken-chain" ? "15.00" : "10.00"]);
        }
      }
      await rows(em, "set constraints all immediate");
    })).rejects.toThrow();
    expect((await p.wallet(w.id)).version).toBe(1);
    expect((await p.reconcile(w.id)).consistent).toBe(true);
  });
}

test("saldo e versão não podem mudar sem lançamento correspondente", async () => {
  const w = await p.createWallet({ playerId: crypto.randomUUID(), initialBalance: { amount: "0.00", currency: "BRL" } });
  await expect(orm.em.fork().transactional(async em => {
    await rows(em, "update wallets set balance=1,version=2 where id=?", [w.id]);
    await rows(em, "set constraints all immediate");
  })).rejects.toThrow();
  expect((await p.reconcile(w.id)).consistent).toBe(true);
});
