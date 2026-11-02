import { LedgerDirection } from "./wallet-ledger-entry";
import { Money } from "./money";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  createdAt: Date;
  referenceTransactionId?: string;
  failureCode?: string;
  processedAt?: Date;
}

export class WagerTransaction {
  private _failureCode: string | undefined;
  private _referenceTransactionId: string | undefined;
  private _processedAt: Date | undefined;

  private constructor(
    private readonly props: Readonly<CreateWagerTransactionProps>,
    private _status: WagerTransactionStatus,
    private readonly _createdAt: Date,
  ) {}

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    if (
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    ) {
      return false;
    }

    return (
      this.props.kind !== WagerTransactionKind.Loss &&
      !this.props.money.isZero()
    );
  }

  requiresReference(): boolean {
    return (
      this.props.kind === WagerTransactionKind.Refund ||
      this.props.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.props.payloadHash === payloadHash;
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new Error("Uma transação terminal não pode mudar de estado.");
    }
  }

  markPendingReference(): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.PendingReference;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal();

    if (!Number.isFinite(at.getTime())) {
      throw new Error("Data de processamento inválida.");
    }

    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = new Date(at.getTime());
    this._status = WagerTransactionStatus.Processed;
  }

  reject(code: string): void {
    this.assertNotTerminal();

    if (!code.trim()) {
      throw new Error("Código de falha obrigatório.");
    }

    this._failureCode = code;
    this._status = WagerTransactionStatus.Rejected;
  }

  fail(code: string): void {
    this.assertNotTerminal();

    if (!code.trim()) {
      throw new Error("Código de falha obrigatório.");
    }

    this._failureCode = code;
    this._status = WagerTransactionStatus.Failed;
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const identifiers = [
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
    ];

    if (identifiers.some((value) => !value.trim())) {
      throw new Error("Identificadores da transação são obrigatórios.");
    }

    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new Error("Tipo de transação inválido.");
    }

    if (props.money.isNegative()) {
      throw new Error("O valor da transação não pode ser negativo.");
    }

    const requiresReference =
      props.kind === WagerTransactionKind.Refund ||
      props.kind === WagerTransactionKind.Rollback;

    if (requiresReference && !props.referenceExternalTransactionId?.trim()) {
      throw new Error("Esta operação exige uma transação de referência.");
    }

    return new WagerTransaction(
      Object.freeze({ ...props }),
      WagerTransactionStatus.Pending,
      new Date(),
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    const {
      status,
      createdAt,
      referenceTransactionId,
      failureCode,
      processedAt,
      ...props
    } = state;

    const transaction = new WagerTransaction(
      Object.freeze({ ...props }),
      status,
      new Date(createdAt.getTime()),
    );

    transaction._referenceTransactionId = referenceTransactionId;
    transaction._failureCode = failureCode;
    transaction._processedAt = processedAt
      ? new Date(processedAt.getTime())
      : undefined;

    return transaction;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (
          !reference ||
          ![
            WagerTransactionKind.Bet,
            WagerTransactionKind.Win,
            WagerTransactionKind.Refund,
          ].includes(reference.kind)
        )
          throw new Error("Referência inválida para rollback.");
        return reference.kind === WagerTransactionKind.Bet
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      default:
        throw new Error("Operação sem movimentação financeira.");
    }
  }

  get id(): string {
    return this.props.id;
  }

  get kind(): WagerTransactionKind {
    return this.props.kind;
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get failureCode(): string | undefined {
    return this._failureCode;
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get processedAt(): Date | undefined {
    return this._processedAt
      ? new Date(this._processedAt.getTime())
      : undefined;
  }
}
