import { test, expect } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../../mikro-orm.config";
test("migrations sobem, descem e sobem novamente em base descartável", async () => {
  const admin = await MikroORM.init({ ...config, dbName: "postgres" });
  const name = "jungle_migration_" + crypto.randomUUID().replaceAll("-", "");
  let orm: MikroORM | undefined;
  try {
    await admin.em.getConnection().execute(`create database "${name}"`);
    orm = await MikroORM.init({ ...config, dbName: name });
    await orm.getMigrator().up();
    const [up] = await orm.em
      .getConnection()
      .execute("select to_regclass('wallet_ledger_entries')::text as ledger");
    expect(up?.ledger).toBe("wallet_ledger_entries");
    await orm.getMigrator().down({ to: 0 });
    const [down] = await orm.em
      .getConnection()
      .execute("select to_regclass('wallets')::text as wallet");
    expect(down?.wallet).toBeNull();
    await orm.getMigrator().up();
    const [again] = await orm.em
      .getConnection()
      .execute("select to_regclass('outbox_messages')::text as outbox");
    expect(again?.outbox).toBe("outbox_messages");
  } finally {
    await orm?.close();
    await admin.em.getConnection().execute(`drop database if exists "${name}"`);
    await admin.close();
  }
}, 30000);
