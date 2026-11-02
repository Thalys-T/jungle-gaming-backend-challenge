import { Money } from "./money";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    private readonly _createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt.getTime()),
      new Date(state.updatedAt.getTime()),
    );
  }

  static open(props: OpenWalletProps): Wallet {
    if (!props.id.trim() || !props.playerId.trim()) {
      throw new Error("Carteira e jogador precisam de identificadores.");
    }

    if (props.initialBalance.isNegative()) {
      throw new Error("O saldo inicial não pode ser negativo.");
    }

    const now = new Date();

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      new Date(now.getTime()),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt.getTime());
  }

  debit(
    money: Money,
    entryId: string,
    transactionId: string,
  ): WalletLedgerEntry | null {
    return this.move(money, LedgerDirection.Debit, entryId, transactionId);
  }

  credit(
    money: Money,
    entryId: string,
    transactionId: string,
  ): WalletLedgerEntry | null {
    return this.move(money, LedgerDirection.Credit, entryId, transactionId);
  }

  private move(
    money: Money,
    direction: LedgerDirection,
    entryId: string,
    transactionId: string,
  ): WalletLedgerEntry | null {
    if (money.currency !== this.currency) {
      throw new Error("A moeda da operação difere da carteira.");
    }

    if (money.isNegative()) {
      throw new Error("O valor da movimentação não pode ser negativo.");
    }

    // Sem mudança de saldo, não incrementamos a versão.
    if (money.isZero()) {
      return null;
    }

    if (
      direction === LedgerDirection.Debit &&
      this._balance.isLessThan(money)
    ) {
      throw new Error("Saldo insuficiente.");
    }

    const before = this._balance;

    const after =
      direction === LedgerDirection.Debit
        ? before.subtract(money)
        : before.add(money);

    // Criamos o registro antes de modificar a carteira.
    const entry = WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
    });

    this._balance = after;
    this._version += 1;
    this._updatedAt = new Date();

    return entry;
  }
}
