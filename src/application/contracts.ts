import { createHash } from "node:crypto";
import { Money } from "../domain/money";
import { WagerTransactionKind } from "../domain/wager-transaction";
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
  ) {
    super(code);
  }
}
export interface Command {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}
export function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new AppError("INVALID_UUID", 400);
  return value.toLowerCase();
}
export function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256)
    throw new AppError("INVALID_IDENTIFIER", 400);
  return value;
}
export function money(value: any): Money {
  try {
    if (
      !value ||
      typeof value.amount !== "string" ||
      typeof value.currency !== "string"
    )
      throw Error();
    return Money.from(value);
  } catch {
    throw new AppError("INVALID_MONEY", 400);
  }
}
export function command(value: any): Command {
  if (!value || typeof value !== "object")
    throw new AppError("INVALID_PAYLOAD", 400);
  const kind = value.kind as WagerTransactionKind;
  if (
    !Object.values(WagerTransactionKind).includes(kind) ||
    kind === WagerTransactionKind.Opening
  )
    throw new AppError("INVALID_KIND", 400);
  const result: Command = {
    providerId: text(value.providerId),
    externalTransactionId: text(value.externalTransactionId),
    playerId: uuid(value.playerId),
    walletId: uuid(value.walletId),
    roundId: text(value.roundId),
    gameId: text(value.gameId),
    kind,
    money: money(value.money).toJSON(),
  };
  if (value.referenceExternalTransactionId !== undefined)
    result.referenceExternalTransactionId = text(
      value.referenceExternalTransactionId,
    );
  if (
    ["REFUND", "ROLLBACK"].includes(kind) &&
    !result.referenceExternalTransactionId
  )
    throw new AppError("REFERENCE_REQUIRED", 400);
  return result;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function sqlState(e: any): string | undefined {
  return e?.code ?? e?.cause?.code;
}
