import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";
import { LedgerDirection } from "../../src/domain/wallet-ledger-entry";

describe("Wallet", () => {
  test("abre uma carteira com saldo e versão inicial", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({
        amount: "100.00",
        currency: "BRL",
      }),
    });

    expect(wallet.id).toBe("wallet-1");
    expect(wallet.playerId).toBe("player-1");
    expect(wallet.currency).toBe("BRL");
    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("rejeita abertura com saldo negativo", () => {
    const negative = Money.from({
      amount: "10.00",
      currency: "BRL",
    }).negate();

    expect(() =>
      Wallet.open({
        id: "wallet-1",
        playerId: "player-1",
        initialBalance: negative,
      }),
    ).toThrow();
  });

  test("permite abrir uma carteira zerada", () => {
    const wallet = Wallet.open({
      id: "wallet-2",
      playerId: "player-2",
      initialBalance: Money.zero("BRL"),
    });

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test("debita e produz o lançamento correspondente", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({
        amount: "100.00",
        currency: "BRL",
      }),
    });

    const entry = wallet.debit(
      Money.from({ amount: "80.00", currency: "BRL" }),
      "entry-1",
      "transaction-1",
    );

    expect(wallet.balance.toString()).toBe("20.00");
    expect(wallet.version).toBe(2);
    expect(entry?.direction).toBe(LedgerDirection.Debit);
    expect(entry?.balanceBefore.toString()).toBe("100.00");
    expect(entry?.balanceAfter.toString()).toBe("20.00");
  });

  test("rejeita débito sem saldo e preserva a carteira", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({
        amount: "20.00",
        currency: "BRL",
      }),
    });

    expect(() =>
      wallet.debit(
        Money.from({ amount: "80.00", currency: "BRL" }),
        "entry-2",
        "transaction-2",
      ),
    ).toThrow("Saldo insuficiente.");

    expect(wallet.balance.toString()).toBe("20.00");
    expect(wallet.version).toBe(1);
  });

  test("credita e produz o lançamento correspondente", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({
        amount: "20.00",
        currency: "BRL",
      }),
    });

    const entry = wallet.credit(
      Money.from({ amount: "50.00", currency: "BRL" }),
      "entry-3",
      "transaction-3",
    );

    expect(wallet.balance.toString()).toBe("70.00");
    expect(wallet.version).toBe(2);
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(entry?.isBalanced()).toBe(true);
  });

  test("rejeita moeda diferente sem alterar saldo ou versão", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({
        amount: "100.00",
        currency: "BRL",
      }),
    });

    expect(() =>
      wallet.debit(
        Money.from({ amount: "10.00", currency: "USD" }),
        "entry-1",
        "transaction-1",
      ),
    ).toThrow("A moeda da operação difere da carteira.");

    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("valor zero não muda saldo, versão nem gera lançamento", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({
        amount: "100.00",
        currency: "BRL",
      }),
    });

    const entry = wallet.credit(Money.zero("BRL"), "entry-1", "transaction-1");

    expect(entry).toBeNull();
    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("falha no lançamento não altera a carteira", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({
        amount: "100.00",
        currency: "BRL",
      }),
    });

    expect(() =>
      wallet.debit(
        Money.from({ amount: "10.00", currency: "BRL" }),
        "", // Identificador inválido para o lançamento.
        "transaction-1",
      ),
    ).toThrow("Identificadores do lançamento são obrigatórios.");

    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("reconstrói a carteira preservando saldo e versão", () => {
    const wallet = Wallet.rehydrate({
      id: "wallet-1",
      playerId: "player-1",
      currency: "BRL",
      balance: Money.from({
        amount: "250.00",
        currency: "BRL",
      }),
      version: 8,
      createdAt: new Date("2026-01-01T10:00:00.000Z"),
      updatedAt: new Date("2026-01-02T10:00:00.000Z"),
    });

    expect(wallet.balance.toString()).toBe("250.00");
    expect(wallet.version).toBe(8);

    const entry = wallet.debit(
      Money.from({ amount: "50.00", currency: "BRL" }),
      "entry-9",
      "transaction-9",
    );

    expect(wallet.balance.toString()).toBe("200.00");
    expect(wallet.version).toBe(9);
    expect(entry?.balanceBefore.toString()).toBe("250.00");
  });

  test("preserva as datas salvas e protege a data interna", () => {
    const createdAt = new Date("2026-01-01T10:00:00.000Z");
    const updatedAt = new Date("2026-01-02T10:00:00.000Z");

    const wallet = Wallet.rehydrate({
      id: "wallet-1",
      playerId: "player-1",
      currency: "BRL",
      balance: Money.zero("BRL"),
      version: 1,
      createdAt,
      updatedAt,
    });

    // Alterar a entrada não deve alterar a carteira.
    createdAt.setUTCFullYear(2000);

    // Alterar a data consultada também não deve afetá-la.
    const consultedDate = wallet.updatedAt;
    consultedDate.setUTCFullYear(2000);

    expect(wallet.createdAt.toISOString()).toBe("2026-01-01T10:00:00.000Z");

    expect(wallet.updatedAt.toISOString()).toBe("2026-01-02T10:00:00.000Z");
  });
});
