import { InboxMessage } from "../domain/inbox-message";
import type { EntityManager } from "@mikro-orm/postgresql";
import { MikroORM } from "@mikro-orm/postgresql";
import { Money } from "../domain/money";
import { Wallet } from "../domain/wallet";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import { WalletMapper } from "../infrastructure/database/mappers/wallet.mapper";
import { WalletEntity } from "../infrastructure/database/entities/wallet.entity";
import {
  AppError,
  command,
  hash,
  money,
  sqlState,
  text,
  uuid,
  type Command,
} from "./contracts";
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
  WalletBalanceChanged,
} from "../domain/events";
import { metrics, log } from "../infrastructure/observability";
export const rows = (
  em: EntityManager,
  sql: string,
  params: any[] = [],
): Promise<any[]> => em.execute(sql, params);
export interface InboxContext {
  messageId: string;
  consumerName: string;
  payloadHash: string;
}
export class Processor {
  constructor(public readonly orm: MikroORM) {}
  private async atomic<T>(fn: (em: EntityManager) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.orm.em.fork().transactional(fn);
      } catch (e) {
        if (
          ["40001", "40P01", "55P03"].includes(sqlState(e) ?? "") &&
          attempt < 3
        ) {
          metrics.inc("lock_conflicts");
          await Bun.sleep(20 * 2 ** attempt);
          continue;
        }
        if (sqlState(e) === "23505") throw new AppError("UNIQUE_CONFLICT", 409);
        throw e;
      }
    }
  }
  async createWallet(body: any) {
    const playerId = uuid(body?.playerId),
      initial = money(body?.initialBalance);
    return this.atomic(async (em) => {
      const wallet = Wallet.open({
        id: crypto.randomUUID(),
        playerId,
        initialBalance: initial,
      });
      const entity = WalletMapper.toEntity(wallet);
      await em.persistAndFlush(entity);
      if (initial.isPositive()) {
        const id = crypto.randomUUID();
        await rows(
          em,
          `insert into wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,processed_at) values (?,'internal',?,?,?, ?,?,'opening','opening','OPENING',?,?,'PENDING',now())`,
          [
            id,
            id,
            "opening:" + id,
            hash({ id }),
            wallet.id,
            playerId,
            initial.toString(),
            initial.currency,
          ],
        );
        await rows(
          em,
          `insert into wallet_ledger_entries(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after,wallet_version) values (?,?,?,'CREDIT',?,?,0,?,1)`,
          [
            crypto.randomUUID(),
            wallet.id,
            id,
            initial.toString(),
            initial.currency,
            initial.toString(),
          ],
        );
        await rows(
          em,
          "update wager_transactions set status='PROCESSED',response=?::jsonb where id=?",
          [
            JSON.stringify({
              transactionId: id,
              status: "PROCESSED",
              balance: initial.toJSON(),
              idempotentReplay: false,
            }),
            id,
          ],
        );
        await this.event(em, "processed", wallet.id, id, {
          transactionId: id,
          status: "PROCESSED",
          kind: "OPENING",
        });
        await this.event(em, "balance", wallet.id, id, {
          walletId: wallet.id,
          transactionId: id,
          direction: "CREDIT",
          money: initial.toJSON(),
          balanceBefore: Money.zero(initial.currency).toJSON(),
          balanceAfter: initial.toJSON(),
          walletVersion: 1,
        });
      }
      return this.walletJSON(wallet);
    });
  }
  walletJSON(w: Wallet) {
    return {
      id: w.id,
      playerId: w.playerId,
      balance: w.balance.toJSON(),
      version: w.version,
    };
  }
  async wallet(id: string) {
    const e = await this.orm.em.fork().findOne(WalletEntity, { id: uuid(id) });
    if (!e) throw new AppError("WALLET_NOT_FOUND", 404);
    return this.walletJSON(WalletMapper.toDomain(e));
  }
  async event(
    em: EntityManager,
    type: "processed" | "rejected" | "pending" | "balance",
    walletId: string,
    causationId: string,
    data: Record<string, unknown>,
  ) {
    const props = {
      eventId: crypto.randomUUID(),
      aggregateId: walletId,
      correlationId: causationId,
      causationId,
      occurredAt: new Date(),
      data,
    };
    const event = {
      processed: WagerTransactionProcessed,
      rejected: WagerTransactionRejected,
      pending: WagerTransactionPendingReference,
      balance: WalletBalanceChanged,
    }[type]
      .create(props)
      .toJSON();
    await rows(
      em,
      `insert into outbox_messages(id,aggregate_id,event_type,payload) values (?,?,?,?::jsonb)`,
      [event.eventId, walletId, event.eventType, JSON.stringify(event)],
    );
  }
  async submit(
    input: unknown,
    key: unknown,
    inbox?: InboxContext,
    retry = false,
  ) {
    if (inbox) InboxMessage.receive(inbox);
    const c = command(input),
      idempotencyKey = text(key),
      payloadHash = hash(c),
      start = performance.now();
    const result = await this.atomic(async (em) => {
      // Locks are scoped to operation identity, never global. Sorted acquisition avoids cross-key deadlocks.
      for (const k of [
        ...new Set([
          "key:" + idempotencyKey,
          "external:" + c.providerId + ":" + c.externalTransactionId,
          ...(inbox
            ? ["inbox:" + inbox.consumerName + ":" + inbox.messageId]
            : []),
        ]),
      ].sort())
        await rows(em, "select pg_advisory_xact_lock(hashtextextended(?,0))", [
          k,
        ]);
      if (inbox) {
        const [old] = await rows(
          em,
          "select * from inbox_messages where consumer_name=? and message_id=?",
          [inbox.consumerName, inbox.messageId],
        );
        if (old && old.payload_hash !== inbox.payloadHash)
          throw new AppError("INBOX_PAYLOAD_CONFLICT", 409);
        if (!old)
          await rows(
            em,
            "insert into inbox_messages(consumer_name,message_id,payload_hash) values (?,?,?)",
            [inbox.consumerName, inbox.messageId, inbox.payloadHash],
          );
      }
      const existing = await rows(
        em,
        "select * from wager_transactions where idempotency_key=? or (provider_id=? and external_transaction_id=?)",
        [idempotencyKey, c.providerId, c.externalTransactionId],
      );
      if (
        existing.some(
          (t) =>
            t.payload_hash !== payloadHash ||
            t.idempotency_key !== idempotencyKey,
        )
      )
        throw new AppError("IDEMPOTENCY_CONFLICT", 409);
      const old = existing[0];
      if (
        retry &&
        old?.status === "PENDING_REFERENCE" &&
        new Date(old.next_attempt_at).getTime() > Date.now()
      )
        return { ...old.response, idempotentReplay: true };
      if (old && !(retry && old.status === "PENDING_REFERENCE")) {
        metrics.inc("duplicates");
        if (inbox)
          await rows(
            em,
            "update inbox_messages set processed_at=now() where consumer_name=? and message_id=?",
            [inbox.consumerName, inbox.messageId],
          );
        return { ...old.response, idempotentReplay: true };
      }
      const [record] = await rows(
        em,
        "select * from wallets where id=? for update",
        [c.walletId],
      );
      if (!record) throw new AppError("WALLET_NOT_FOUND", 404);
      const wallet = Wallet.rehydrate({
        id: record.id,
        playerId: record.player_id,
        currency: record.currency,
        balance: Money.from({
          amount: record.balance,
          currency: record.currency,
        }),
        version: record.version,
        createdAt: new Date(record.created_at),
        updatedAt: new Date(record.updated_at),
      });
      const id = old?.id ?? crypto.randomUUID(),
        m = Money.from(c.money);
      const props = { ...c, id, idempotencyKey, payloadHash, money: m };
      const txn = old
        ? WagerTransaction.rehydrate({
            ...props,
            status: WagerTransactionStatus.Pending,
            createdAt: new Date(old.created_at),
          })
        : WagerTransaction.create(props);
      if (!old)
        await rows(
          em,
          `insert into wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,reference_external_transaction_id,status) values (?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDING')`,
          [
            id,
            c.providerId,
            c.externalTransactionId,
            idempotencyKey,
            payloadHash,
            c.walletId,
            c.playerId,
            c.roundId,
            c.gameId,
            c.kind,
            m.toString(),
            m.currency,
            c.referenceExternalTransactionId ?? null,
          ],
        );
      let failure: string | undefined,
        reference: any,
        direction: "DEBIT" | "CREDIT" | undefined;
      if (c.playerId !== wallet.playerId) failure = "PLAYER_MISMATCH";
      else if (m.currency !== wallet.currency) failure = "CURRENCY_MISMATCH";
      if (!failure && c.referenceExternalTransactionId) {
        [reference] = await rows(
          em,
          "select * from wager_transactions where provider_id=? and external_transaction_id=?",
          [c.providerId, c.referenceExternalTransactionId],
        );
        if (
          !reference ||
          ["PENDING", "PENDING_REFERENCE"].includes(reference.status)
        ) {
          const attempts = (old?.attempts ?? 0) + 1;
          if (
            attempts >= 10 ||
            (old && Date.now() - new Date(old.created_at).getTime() > 3600000)
          )
            failure = "REFERENCE_EXPIRED";
          else {
            txn.markPendingReference();
            await rows(
              em,
              `update wager_transactions set attempts=?,next_attempt_at=now()+(? * interval '1 millisecond') where id=?`,
              [attempts, Math.min(60000, 1000 * 2 ** attempts), id],
            );
          }
        } else if (reference.status !== "PROCESSED")
          failure = "REFERENCE_NOT_PROCESSED";
        else if (
          reference.id === id ||
          reference.wallet_id !== c.walletId ||
          reference.player_id !== c.playerId ||
          reference.currency !== m.currency ||
          reference.round_id !== c.roundId
        )
          failure = "REFERENCE_MISMATCH";
        else if (
          (c.kind === "REFUND" && reference.kind !== "BET") ||
          (c.kind === "ROLLBACK" &&
            !["BET", "WIN", "REFUND"].includes(reference.kind)) ||
          (c.kind === "WIN" && reference.kind !== "BET")
        )
          failure = "REFERENCE_KIND_INVALID";
        else if (
          ["REFUND", "ROLLBACK"].includes(c.kind) &&
          !m.equals(
            Money.from({
              amount: reference.amount,
              currency: reference.currency,
            }),
          )
        )
          failure = "REVERSAL_AMOUNT_MISMATCH";
        else if (["REFUND", "ROLLBACK"].includes(c.kind)) {
          const reversed = await rows(
            em,
            `select id from wager_transactions where reference_transaction_id=? and kind=? and status='PROCESSED'`,
            [reference.id, c.kind],
          );
          if (reversed.length) failure = "ALREADY_REVERSED";
        }
      }
      if (!failure && txn.status !== "PENDING_REFERENCE") {
        const refDomain = reference
          ? WagerTransaction.rehydrate({
              ...props,
              id: reference.id,
              kind: reference.kind,
              money: Money.from({
                amount: reference.amount,
                currency: reference.currency,
              }),
              status: reference.status,
              createdAt: new Date(reference.created_at),
            })
          : undefined;
        direction =
          c.kind === "LOSS" ? undefined : txn.ledgerDirectionFor(refDomain);
        if (direction === "DEBIT" && wallet.balance.isLessThan(m))
          failure =
            c.kind === "BET"
              ? "INSUFFICIENT_FUNDS"
              : "REVERSAL_INSUFFICIENT_FUNDS";
        if (direction === "CREDIT") {
          try {
            wallet.balance.add(m);
          } catch {
            failure = "BALANCE_LIMIT_EXCEEDED";
          }
        }
      }
      if (failure) txn.reject(failure);
      let entry = null;
      if (!failure && txn.status !== "PENDING_REFERENCE") {
        if (direction)
          entry =
            direction === "DEBIT"
              ? wallet.debit(m, crypto.randomUUID(), id)
              : wallet.credit(m, crypto.randomUUID(), id);
        txn.markProcessed(reference?.id, new Date());
        if (entry) {
          await rows(
            em,
            "update wallets set balance=?,version=?,updated_at=? where id=?",
            [
              wallet.balance.toString(),
              wallet.version,
              wallet.updatedAt,
              wallet.id,
            ],
          );
          await rows(
            em,
            `insert into wallet_ledger_entries(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after,wallet_version) values (?,?,?,?,?,?,?,?,?)`,
            [
              entry.id,
              wallet.id,
              id,
              entry.direction,
              m.toString(),
              m.currency,
              entry.balanceBefore.toString(),
              entry.balanceAfter.toString(),
              wallet.version,
            ],
          );
          await this.event(em, "balance", wallet.id, id, {
            walletId: wallet.id,
            transactionId: id,
            direction: entry.direction,
            money: m.toJSON(),
            balanceBefore: entry.balanceBefore.toJSON(),
            balanceAfter: entry.balanceAfter.toJSON(),
            walletVersion: wallet.version,
          });
        }
      }
      const response = {
        transactionId: id,
        status: txn.status,
        balance: wallet.balance.toJSON(),
        ...(txn.failureCode ? { failureCode: txn.failureCode } : {}),
        idempotentReplay: false,
      };
      await rows(
        em,
        "update wager_transactions set status=?,failure_code=?,reference_transaction_id=?,processed_at=?,response=?::jsonb where id=?",
        [
          txn.status,
          txn.failureCode ?? null,
          txn.referenceTransactionId ?? null,
          txn.processedAt ?? null,
          JSON.stringify(response),
          id,
        ],
      );
      if (!old || old.status !== txn.status)
        await this.event(
          em,
          txn.status === "PROCESSED"
            ? "processed"
            : txn.status === "REJECTED"
              ? "rejected"
              : "pending",
          wallet.id,
          id,
          {
            ...response,
            providerId: c.providerId,
            externalTransactionId: c.externalTransactionId,
          },
        );
      if (inbox)
        await rows(
          em,
          "update inbox_messages set processed_at=now() where consumer_name=? and message_id=?",
          [inbox.consumerName, inbox.messageId],
        );
      return response;
    });
    metrics.inc("transactions_" + result.status.toLowerCase());
    metrics.observe(performance.now() - start);
    log("transaction", {
      transactionId: result.transactionId,
      walletId: c.walletId,
      providerId: c.providerId,
      correlationId: result.transactionId,
      messageId: inbox?.messageId,
    });
    return result;
  }
  async retryReferences() {
    const due = await rows(
      this.orm.em.fork(),
      `select * from wager_transactions where status='PENDING_REFERENCE' and next_attempt_at<=now() order by next_attempt_at limit 50`,
    );
    for (const t of due) {
      metrics.inc("retries");
      await this.submit(
        {
          providerId: t.provider_id,
          externalTransactionId: t.external_transaction_id,
          playerId: t.player_id,
          walletId: t.wallet_id,
          roundId: t.round_id,
          gameId: t.game_id,
          kind: t.kind,
          money: { amount: t.amount, currency: t.currency },
          referenceExternalTransactionId: t.reference_external_transaction_id,
        },
        t.idempotency_key,
        undefined,
        true,
      );
    }
  }
  async transaction(id: string) {
    const [t] = await rows(
      this.orm.em.fork(),
      "select response from wager_transactions where id=?",
      [uuid(id)],
    );
    if (!t) throw new AppError("TRANSACTION_NOT_FOUND", 404);
    return t.response;
  }
  async external(provider: string, external: string) {
    const [t] = await rows(
      this.orm.em.fork(),
      "select response from wager_transactions where provider_id=? and external_transaction_id=?",
      [text(provider), text(external)],
    );
    if (!t) throw new AppError("TRANSACTION_NOT_FOUND", 404);
    return t.response;
  }
  async ledger(id: string, cursor?: string, limitRaw?: string) {
    uuid(id);
    const limit = limitRaw === undefined ? 50 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AppError("INVALID_LIMIT", 400);
    let after = 0;
    if (cursor) {
      try {
        const c = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (
          c.walletId !== id ||
          !Number.isSafeInteger(c.version) ||
          c.version < 0
        )
          throw Error();
        after = c.version;
      } catch {
        throw new AppError("INVALID_CURSOR", 400);
      }
    }
    await this.wallet(id);
    const list = await rows(
      this.orm.em.fork(),
      "select * from wallet_ledger_entries where wallet_id=? and wallet_version>? order by wallet_version limit ?",
      [id, after, limit + 1],
    );
    const more = list.length > limit;
    const entries = list.slice(0, limit);
    return {
      entries,
      nextCursor: more
        ? Buffer.from(
            JSON.stringify({
              walletId: id,
              version: entries.at(-1).wallet_version,
            }),
          ).toString("base64url")
        : null,
    };
  }
  async reconcile(id: string) {
    uuid(id);
    return this.atomic(async (em) => {
      const [w] = await rows(
        em,
        "select * from wallets where id=? for update",
        [id],
      );
      if (!w) throw new AppError("WALLET_NOT_FOUND", 404);
      const [r] = await rows(
        em,
        `select coalesce(sum(case when direction='CREDIT' then amount else -amount end),0)::text as total,count(*)::int as count from wallet_ledger_entries where wallet_id=?`,
        [id],
      );
      const stored = Money.from({ amount: w.balance, currency: w.currency });
      const total = r.total.startsWith("-")
        ? Money.from({
            amount: r.total.slice(1),
            currency: w.currency,
          }).negate()
        : Money.from({ amount: r.total, currency: w.currency });
      const consistent = stored.equals(total);
      if (!consistent) {
        metrics.inc("reconciliation_divergence");
        log("reconciliation_divergence", { walletId: id });
      }
      return {
        walletId: id,
        storedBalance: stored.toJSON(),
        calculatedBalance: total.toJSON(),
        difference: stored.subtract(total).toJSON(),
        consistent,
        checkedEntries: r.count,
      };
    });
  }
}
