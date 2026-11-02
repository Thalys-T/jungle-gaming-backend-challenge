import { expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../../mikro-orm.config";
import { WalletEntity } from "../../src/infrastructure/database/entities/wallet.entity";

test("salva e recupera uma carteira no PostgreSQL", async () => {
  const orm = await MikroORM.init(config);
  const em = orm.em.fork();

  try {
    await em.begin();

    const id = crypto.randomUUID();
    const now = new Date();

    const wallet = em.create(WalletEntity, {
      id,
      playerId: crypto.randomUUID(),
      currency: "BRL",
      balance: "100.00",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    await em.persistAndFlush(wallet);

    // Limpa os objetos guardados em memória pelo MikroORM.
    em.clear();

    // Agora precisa buscar a carteira no banco.
    const saved = await em.findOneOrFail(WalletEntity, { id });

    expect(saved.id).toBe(id);
    expect(saved.currency).toBe("BRL");
    expect(saved.balance).toBe("100.00");
    expect(typeof saved.balance).toBe("string");
    expect(saved.version).toBe(1);
  } finally {
    try {
      // Desfaz a inserção para não deixar dados de teste.
      if (em.isInTransaction()) {
        await em.rollback();
      }
    } finally {
      await orm.close();
    }
  }
});
