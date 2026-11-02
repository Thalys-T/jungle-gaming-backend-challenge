import { expect, test } from "bun:test";
import {
  canonical,
  command,
  hash,
  money,
} from "../../src/application/contracts";
const input = () => ({
  providerId: "p",
  externalTransactionId: "e",
  playerId: crypto.randomUUID(),
  walletId: crypto.randomUUID(),
  roundId: "r",
  gameId: "g",
  kind: "BET",
  money: { amount: "1.00", currency: "BRL" },
});
test("hash canônico ignora ordem de chaves, mas diferencia campos de negócio", () => {
  expect(hash({ b: 2, a: { z: 3, x: 4 } })).toBe(
    hash({ a: { x: 4, z: 3 }, b: 2 }),
  );
  expect(hash({ amount: "1.00" })).not.toBe(hash({ amount: "2.00" }));
});
test("contrato ignora metadados e normaliza dinheiro", () => {
  const c = input();
  expect(
    command({ ...c, money: { amount: "1", currency: "BRL" }, trace: "x" }),
  ).toEqual(command(c));
});
test("OPENING externo é rejeitado", () => {
  expect(() => command({ ...input(), kind: "OPENING" })).toThrow(
    "INVALID_KIND",
  );
});
test("referência é obrigatória em reversões", () => {
  for (const kind of ["REFUND", "ROLLBACK"])
    expect(() => command({ ...input(), kind })).toThrow("REFERENCE_REQUIRED");
});
test("dinheiro numérico é rejeitado antes da coerção do regex", () => {
  expect(() => money({ amount: 10, currency: "BRL" })).toThrow("INVALID_MONEY");
});
