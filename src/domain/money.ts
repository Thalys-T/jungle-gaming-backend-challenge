import Decimal from "decimal.js";

const MoneyDecimal = Decimal.clone({ precision: 40 });

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    const maximum = new MoneyDecimal("999999999999999999.99");

    if (!value.isFinite() || value.abs().greaterThan(maximum)) {
      throw new Error("Valor monetário acima do limite.");
    }
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (
      typeof props.amount !== "string" ||
      !/^\d+(\.\d{1,2})?$/.test(props.amount)
    ) {
      throw new Error("Valor monetário inválido.");
    }

    const integerPart = props.amount.split(".")[0]!;

    if (integerPart.length > 18) {
      throw new Error("Valor monetário acima do limite.");
    }

    if (
      typeof props.currency !== "string" ||
      !/^[A-Z]{3}$/.test(props.currency)
    ) {
      throw new Error("Formato de moeda inválido.");
    }

    return new Money(new MoneyDecimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: "0.00", currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.equals(other.value);
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error("Não é possível operar moedas diferentes.");
    }
  }
}
