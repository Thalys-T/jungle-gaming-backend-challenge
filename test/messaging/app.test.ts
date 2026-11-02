import { connect } from "../../src/infrastructure/database/connection";
import { test, expect } from "bun:test";
import { Queue } from "../../src/infrastructure/queue";
test("aplicação real: readiness, HTTP, SQS, worker, reconciliação e shutdown", async () => {
  const orm = await connect();
  try {
    await orm.getMigrator().up();
  } finally {
    await orm.close();
  }
  const port = "31419",
    base = "http://127.0.0.1:" + port;
  const child = Bun.spawn([process.execPath, "src/main.ts"], {
    env: { ...process.env, PORT: port, WORKERS: "true" },
    stdout: "ignore",
    stderr: "pipe",
  });
  const q = new Queue();
  const until = async (fn: () => Promise<boolean>) => {
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      try {
        if (await fn()) return;
      } catch {}
      await Bun.sleep(100);
    }
    throw Error("App timeout");
  };
  try {
    await until(
      async () => (await fetch(base + "/health/ready")).status === 200,
    );
    const r = await fetch(base + "/wallets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
    });
    expect(r.status).toBe(201);
    const w = (await r.json()) as any;
    await q.init();
    const id = crypto.randomUUID();
    await q.send(
      q.input,
      {
        messageId: id,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: {
          providerId: "app-test",
          externalTransactionId: id,
          idempotencyKey: "app-test:" + id,
          walletId: w.id,
          playerId: w.playerId,
          roundId: "r",
          gameId: "g",
          kind: "BET",
          money: { amount: "10.00", currency: "BRL" },
        },
      },
      w.id,
    );
    await until(
      async () =>
        ((await (await fetch(base + "/wallets/" + w.id)).json()) as any).balance
          .amount === "90.00",
    );
    const rec = await fetch(base + "/wallets/" + w.id + "/reconciliation", {
      method: "POST",
    });
    expect(((await rec.json()) as any).consistent).toBe(true);
    expect((await fetch(base + "/metrics")).status).toBe(200);
  } finally {
    q.client.destroy();
    child.kill("SIGTERM");
    await child.exited;
  }
}, 60000);
