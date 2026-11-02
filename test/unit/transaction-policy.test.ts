import { LedgerDirection } from "../../src/domain/wallet-ledger-entry";
import { expect, test } from "bun:test";
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
} from "../../src/domain/wager-transaction";
import { Money } from "../../src/domain/money";
const make = (kind: Kind) =>
  WagerTransaction.create({
    id: "t",
    providerId: "p",
    externalTransactionId: "e",
    idempotencyKey: "k",
    payloadHash: "h",
    walletId: "w",
    playerId: "p",
    roundId: "r",
    gameId: "g",
    kind,
    money: Money.from({ amount: "10.00", currency: "BRL" }),
    referenceExternalTransactionId: "original",
  });
test("BET debita; WIN e REFUND creditam; LOSS não tem direção", () => {
  expect(make(Kind.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
  for (const kind of [Kind.Win, Kind.Refund])
    expect(make(kind).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  expect(() => make(Kind.Loss).ledgerDirectionFor()).toThrow();
});
test("ROLLBACK inverte BET, WIN e REFUND e rejeita referência inadequada", () => {
  const rollback = make(Kind.Rollback);
  expect(rollback.ledgerDirectionFor(make(Kind.Bet))).toBe(
    LedgerDirection.Credit,
  );
  expect(rollback.ledgerDirectionFor(make(Kind.Win))).toBe(
    LedgerDirection.Debit,
  );
  expect(rollback.ledgerDirectionFor(make(Kind.Refund))).toBe(
    LedgerDirection.Debit,
  );
  expect(() => rollback.ledgerDirectionFor()).toThrow();
  expect(() => rollback.ledgerDirectionFor(make(Kind.Loss))).toThrow();
});
