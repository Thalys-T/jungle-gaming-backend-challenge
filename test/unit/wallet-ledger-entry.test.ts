import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../../src/domain/wallet-ledger-entry";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("WalletLedgerEntry", () => {
  test("registra um débito com os saldos corretos", () => {
    const entry = WalletLedgerEntry.create({
      id: "entry-1",
      walletId: "wallet-1",
      transactionId: "transaction-1",
      direction: LedgerDirection.Debit,
      money: brl("80.00"),
      balanceBefore: brl("100.00"),
      balanceAfter: brl("20.00"),
    });

    expect(entry.isBalanced()).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
  });

  test("registra um crédito com os saldos corretos", () => {
    const entry = WalletLedgerEntry.create({
      id: "entry-2",
      walletId: "wallet-1",
      transactionId: "transaction-2",
      direction: LedgerDirection.Credit,
      money: brl("50.00"),
      balanceBefore: brl("20.00"),
      balanceAfter: brl("70.00"),
    });

    expect(entry.isBalanced()).toBe(true);
  });

  test("rejeita um lançamento cuja conta não fecha", () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: "entry-3",
        walletId: "wallet-1",
        transactionId: "transaction-3",
        direction: LedgerDirection.Debit,
        money: brl("80.00"),
        balanceBefore: brl("100.00"),
        balanceAfter: brl("50.00"),
      }),
    ).toThrow("Os saldos do lançamento não conferem.");
  });

  test("reconstrói um lançamento preservando e protegendo a data", () => {
    const date = new Date("2026-01-01T10:00:00.000Z");

    const entry = WalletLedgerEntry.rehydrate({
      id: "entry-1",
      walletId: "wallet-1",
      transactionId: "transaction-1",
      direction: LedgerDirection.Debit,
      money: brl("80.00"),
      balanceBefore: brl("100.00"),
      balanceAfter: brl("20.00"),
      createdAt: date,
    });

    date.setUTCFullYear(2000);

    const consultedDate = entry.createdAt;
    consultedDate.setUTCFullYear(2000);

    expect(entry.createdAt.toISOString()).toBe("2026-01-01T10:00:00.000Z");

    expect(entry.isBalanced()).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
  });
});
