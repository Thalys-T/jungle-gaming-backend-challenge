import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wager-transaction";

function betProps() {
  return {
    id: "transaction-1",
    providerId: "provider-a",
    externalTransactionId: "external-1",
    idempotencyKey: "provider-a:external-1",
    payloadHash: "hash-exemplo",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Bet,
    money: Money.from({
      amount: "25.00",
      currency: "BRL",
    }),
  };
}

describe("WagerTransaction", () => {
  test("uma aposta nasce pendente", () => {
    const transaction = WagerTransaction.create(betProps());

    expect(transaction.id).toBe("transaction-1");
    expect(transaction.kind).toBe(WagerTransactionKind.Bet);
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
  });

  test("reembolso exige referência à operação anterior", () => {
    expect(() =>
      WagerTransaction.create({
        ...betProps(),
        kind: WagerTransactionKind.Refund,
      }),
    ).toThrow("Esta operação exige uma transação de referência.");
  });

  test("processa uma transação que aguardava referência", () => {
    const transaction = WagerTransaction.create(betProps());

    transaction.markPendingReference();

    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);

    transaction.markProcessed(
      "referenced-transaction",
      new Date("2026-01-01T10:00:00.000Z"),
    );

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);

    expect(transaction.referenceTransactionId).toBe("referenced-transaction");

    expect(transaction.processedAt?.toISOString()).toBe(
      "2026-01-01T10:00:00.000Z",
    );

    expect(transaction.isTerminal()).toBe(true);
  });

  test("rejeição preserva o motivo e impede novas transições", () => {
    const transaction = WagerTransaction.create(betProps());

    transaction.reject("INSUFFICIENT_FUNDS");

    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);

    expect(transaction.failureCode).toBe("INSUFFICIENT_FUNDS");

    expect(() => transaction.markPendingReference()).toThrow();

    expect(() => transaction.markProcessed(undefined, new Date())).toThrow();

    expect(() => transaction.fail("INFRASTRUCTURE_ERROR")).toThrow();

    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
  });

  test("LOSS não movimenta saldo", () => {
    const transaction = WagerTransaction.create({
      ...betProps(),
      kind: WagerTransactionKind.Loss,
    });

    expect(transaction.affectsBalance()).toBe(false);
    expect(transaction.requiresReference()).toBe(false);
  });

  test("REFUND exige referência e deixa de afetar saldo se rejeitado", () => {
    const transaction = WagerTransaction.create({
      ...betProps(),
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: "original-bet",
    });

    expect(transaction.requiresReference()).toBe(true);
    expect(transaction.affectsBalance()).toBe(true);

    transaction.reject("REFERENCE_INVALID");

    expect(transaction.affectsBalance()).toBe(false);
  });

  test("identifica payload igual ou diferente pelo hash", () => {
    const transaction = WagerTransaction.create(betProps());

    expect(transaction.matchesPayload("hash-exemplo")).toBe(true);
    expect(transaction.matchesPayload("outro-hash")).toBe(false);
  });

  test("reconstrói uma transação processada sem reabri-la", () => {
    const transaction = WagerTransaction.rehydrate({
      ...betProps(),
      status: WagerTransactionStatus.Processed,
      createdAt: new Date("2026-01-01T10:00:00.000Z"),
      processedAt: new Date("2026-01-01T10:01:00.000Z"),
    });

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);

    expect(transaction.createdAt.toISOString()).toBe(
      "2026-01-01T10:00:00.000Z",
    );

    expect(transaction.processedAt?.toISOString()).toBe(
      "2026-01-01T10:01:00.000Z",
    );

    expect(() => transaction.markProcessed(undefined, new Date())).toThrow();
  });

  test("reconstrói uma transação rejeitada preservando o motivo", () => {
    const transaction = WagerTransaction.rehydrate({
      ...betProps(),
      status: WagerTransactionStatus.Rejected,
      failureCode: "INSUFFICIENT_FUNDS",
      createdAt: new Date("2026-01-01T10:00:00.000Z"),
    });

    expect(transaction.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(transaction.isTerminal()).toBe(true);
    expect(transaction.affectsBalance()).toBe(false);
  });
});
