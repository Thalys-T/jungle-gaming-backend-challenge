import { test, expect } from "bun:test";
import { connect } from "../../src/infrastructure/database/connection";
import { Processor } from "../../src/application/processor";
async function client(commands: unknown[]) {
  const child = Bun.spawn(
    [process.execPath, "scripts/race-client.ts", JSON.stringify({ commands })],
    { stdout: "pipe", stderr: "pipe", env: process.env },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw Error(err);
  return JSON.parse(out.split("RESULT:")[1]!);
}
test("três processos: 50 duplicatas, disputa de saldo, wallets distintas e reinício", async () => {
  const orm = await connect();
  await orm.getMigrator().up();
  const p = new Processor(orm);
  try {
    const make = () =>
      p.createWallet({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: "100.00", currency: "BRL" },
      });
    const op = (w: any) => ({
      providerId: "distributed",
      externalTransactionId: crypto.randomUUID(),
      walletId: w.id,
      playerId: w.playerId,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "80.00", currency: "BRL" },
    });
    const w = await make(),
      bet = op(w);
    const result = (
      await Promise.all([
        client(Array(17).fill(bet)),
        client(Array(17).fill(bet)),
        client(Array(16).fill(bet)),
      ])
    ).flat();
    expect(result.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect((await p.wallet(w.id)).balance.amount).toBe("20.00");
    expect((await p.reconcile(w.id)).consistent).toBe(true);
    const hot = await make();
    const race = (
      await Promise.all([
        client([op(hot)]),
        client([op(hot)]),
        client([op(hot)]),
      ])
    ).flat();
    expect(race.filter((r) => r.status === "PROCESSED")).toHaveLength(1);
    expect((await p.reconcile(hot.id)).consistent).toBe(true);
    const wallets = await Promise.all([make(), make(), make()]);
    await Promise.all(wallets.map((x) => client([op(x)])));
    for (const x of wallets)
      expect((await p.reconcile(x.id)).consistent).toBe(true);
    // Every child exits and opens a fresh ORM connection; replay after process restart remains historical.
    expect((await client([bet]))[0].balance.amount).toBe("20.00");
    expect((await p.reconcile(w.id)).consistent).toBe(true);
  } finally {
    await orm.close();
  }
}, 120000);
