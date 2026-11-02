import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money";

describe("Money", () => {
  test.each(["", " ", "NaN", "Infinity", "1e3", "-10.00", "10.001", "10,00"])(
    "rejeita a entrada inválida: %s",
    (amount) => {
      expect(() => Money.from({ amount, currency: "BRL" })).toThrow();
    },
  );

  test("preserva centavos no maior valor permitido", () => {
    const maximum = Money.from({
      amount: "999999999999999999.99",
      currency: "BRL",
    });

    const cent = Money.from({
      amount: "0.01",
      currency: "BRL",
    });

    expect(maximum.subtract(cent).toString()).toBe("999999999999999999.98");
  });

  test("rejeita soma que ultrapassa o limite", () => {
    const maximum = Money.from({
      amount: "999999999999999999.99",
      currency: "BRL",
    });

    const cent = Money.from({
      amount: "0.01",
      currency: "BRL",
    });

    expect(() => maximum.add(cent)).toThrow();
  });

  test("soma 0.10 e 0.20 com precisão", () => {
    const first = Money.from({
      amount: "0.10",
      currency: "BRL",
    });

    const second = Money.from({
      amount: "0.20",
      currency: "BRL",
    });

    const result = first.add(second);

    expect(result.toJSON()).toEqual({
      amount: "0.30",
      currency: "BRL",
    });

    // Somar não deve modificar o valor original.
    expect(first.toJSON().amount).toBe("0.10");
  });

  test("rejeita mais de duas casas decimais", () => {
    expect(() => Money.from({ amount: "25.001", currency: "BRL" })).toThrow();
  });

  test("cria zero e identifica o sinal dos valores", () => {
    const zero = Money.zero("BRL");
    const positive = Money.from({
      amount: "20.00",
      currency: "BRL",
    });
    const negative = positive.negate();

    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);

    expect(positive.isPositive()).toBe(true);
    expect(negative.isNegative()).toBe(true);
    expect(negative.toString()).toBe("-20.00");

    // Negar não altera o objeto original.
    expect(positive.toString()).toBe("20.00");
  });

  test("compara valores monetários equivalentes", () => {
    const first = Money.from({ amount: "10", currency: "BRL" });
    const second = Money.from({ amount: "10.00", currency: "BRL" });

    expect(first.equals(second)).toBe(true);
    expect(first.toString()).toBe("10.00");
  });

  test("soma resultados negativos sem tratá-los como entrada", () => {
    const negative = Money.from({
      amount: "20.00",
      currency: "BRL",
    }).negate();

    const positive = Money.from({
      amount: "5.00",
      currency: "BRL",
    });

    expect(negative.add(positive).toString()).toBe("-15.00");
  });

  test("rejeita soma entre moedas diferentes", () => {
    const brl = Money.from({ amount: "10.00", currency: "BRL" });
    const usd = Money.from({ amount: "10.00", currency: "USD" });

    expect(() => brl.add(usd)).toThrow();
  });

  test("subtrai 80.00 de 100.00", () => {
    const balance = Money.from({
      amount: "100.00",
      currency: "BRL",
    });

    const bet = Money.from({
      amount: "80.00",
      currency: "BRL",
    });

    expect(balance.subtract(bet).toJSON().amount).toBe("20.00");

    // O saldo original continua intacto.
    expect(balance.toJSON().amount).toBe("100.00");
  });

  test("identifica quando o saldo é menor que a aposta", () => {
    const balance = Money.from({
      amount: "20.00",
      currency: "BRL",
    });

    const bet = Money.from({
      amount: "80.00",
      currency: "BRL",
    });

    expect(balance.isLessThan(bet)).toBe(true);
    expect(bet.isLessThan(balance)).toBe(false);
  });

  test("permite resultado negativo, mas rejeita entrada negativa", () => {
    const first = Money.from({
      amount: "20.00",
      currency: "BRL",
    });

    const second = Money.from({
      amount: "80.00",
      currency: "BRL",
    });

    expect(first.subtract(second).toJSON().amount).toBe("-60.00");

    expect(() => Money.from({ amount: "-60.00", currency: "BRL" })).toThrow();
  });
});
