import "reflect-metadata";
import { test, expect } from "bun:test";
import { NestFactory } from "@nestjs/core";
import { connect } from "../../src/infrastructure/database/connection";
import { Processor } from "../../src/application/processor";
import { Queue } from "../../src/infrastructure/queue";
import { createModule, Errors } from "../../src/http/api";
test("HTTP real: criação, consulta, replay, conflito, validação e reconciliação", async () => {
  const orm = await connect();
  await orm.getMigrator().up();
  const q = new Queue();
  const app = await NestFactory.create(createModule(new Processor(orm), q), {
    logger: false,
  });
  app.useGlobalFilters(new Errors());
  await app.listen(0, "127.0.0.1");
  const base = await app.getUrl();
  const post = (route: string, body: unknown, key?: string) =>
    fetch(base + route, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    expect((await fetch(base + "/health/live")).status).toBe(200);
    const r = await post("/wallets", {
      playerId: crypto.randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    expect(r.status).toBe(201);
    const w = (await r.json()) as any;
    const c = {
      providerId: "http",
      externalTransactionId: crypto.randomUUID(),
      playerId: w.playerId,
      walletId: w.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "80.00", currency: "BRL" },
    };
    expect((await post("/wagering/transactions", c)).status).toBe(400);
    const first = await post("/wagering/transactions", c, "http:" + w.id);
    expect(first.status).toBe(200);
    expect(((await first.json()) as any).balance.amount).toBe("20.00");
    const replay = await post("/wagering/transactions", c, "http:" + w.id);
    expect(((await replay.json()) as any).idempotentReplay).toBe(true);
    expect(
      (
        await post(
          "/wagering/transactions",
          { ...c, money: { amount: "1.00", currency: "BRL" } },
          "http:" + w.id,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await post(
          "/wagering/transactions",
          { ...c, externalTransactionId: crypto.randomUUID() },
          "other:" + w.id,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        (await (
          await post("/wallets/" + w.id + "/reconciliation", {})
        ).json()) as any
      ).consistent,
    ).toBe(true);
  } finally {
    await app.close();
    q.client.destroy();
    await orm.close();
  }
}, 30000);
