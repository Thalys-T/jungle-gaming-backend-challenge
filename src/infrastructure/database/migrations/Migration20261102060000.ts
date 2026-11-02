import { Migration } from "@mikro-orm/migrations";
export class Migration20261102060000 extends Migration {
  override async up(): Promise<void> {
    this
      .addSql(`alter table wallets add constraint wallets_currency_format check(currency ~ '^[A-Z]{3}$');
 create table wager_transactions (
 id uuid primary key, provider_id text not null, external_transaction_id text not null, idempotency_key text not null unique,
 payload_hash text not null, wallet_id uuid not null references wallets(id), player_id uuid not null,
 round_id text not null, game_id text not null, kind text not null check(kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
 amount numeric(20,2) not null check(amount>=0), currency varchar(3) not null,
 reference_external_transaction_id text, reference_transaction_id uuid references wager_transactions(id),
 status text not null check(status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
 failure_code text, response jsonb, created_at timestamptz not null default now(), processed_at timestamptz,
 attempts integer not null default 0, next_attempt_at timestamptz not null default now(),
 unique(provider_id,external_transaction_id),
 check(kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null),
 check(status not in ('REJECTED','FAILED') or failure_code is not null));
 create unique index one_reversal_per_kind on wager_transactions(reference_transaction_id,kind) where kind in ('REFUND','ROLLBACK') and status='PROCESSED';
 create index reference_due on wager_transactions(next_attempt_at) where status='PENDING_REFERENCE';
 create table wallet_ledger_entries (
 id uuid primary key, wallet_id uuid not null references wallets(id), transaction_id uuid not null references wager_transactions(id),
 direction text not null check(direction in ('DEBIT','CREDIT')), amount numeric(20,2) not null check(amount>0), currency varchar(3) not null,
 balance_before numeric(20,2) not null check(balance_before>=0), balance_after numeric(20,2) not null check(balance_after>=0),
 wallet_version integer not null check(wallet_version>=1), created_at timestamptz not null default now(),
 unique(wallet_id,transaction_id),unique(wallet_id,wallet_version),
 check(balance_after=balance_before+case when direction='CREDIT' then amount else -amount end));
 create index ledger_cursor on wallet_ledger_entries(wallet_id,wallet_version);
 create table inbox_messages (consumer_name text not null,message_id text not null,payload_hash text not null,received_at timestamptz not null default now(),processed_at timestamptz, primary key(consumer_name,message_id));
 create table outbox_messages (id uuid primary key,aggregate_id uuid not null,event_type text not null,payload jsonb not null,occurred_at timestamptz not null default now(),attempts integer not null default 0,next_attempt_at timestamptz not null default now(),published_at timestamptz);
 create index outbox_due on outbox_messages(next_attempt_at) where published_at is null;
 create function ledger_immutable() returns trigger language plpgsql as $$ begin raise exception 'LEDGER_IMMUTABLE'; end $$;
 create trigger immutable_ledger before update or delete on wallet_ledger_entries for each row execute function ledger_immutable();
 create trigger immutable_ledger_truncate before truncate on wallet_ledger_entries for each statement execute function ledger_immutable();
 create function terminal_transaction() returns trigger language plpgsql as $$ begin
 if old.status in ('PROCESSED','REJECTED','FAILED') then raise exception 'TERMINAL_TRANSACTION_IMMUTABLE'; end if; return new; end $$;
 create trigger terminal_guard before update or delete on wager_transactions for each row execute function terminal_transaction();
 create function wallet_consistent() returns trigger language plpgsql as $$ declare wid uuid; b numeric; total numeric; begin
 if TG_TABLE_NAME='wallets' then wid:=NEW.id; else wid:=NEW.wallet_id; end if;
 select balance into b from wallets where id=wid;
 select coalesce(sum(case when direction='CREDIT' then amount else -amount end),0) into total from wallet_ledger_entries where wallet_id=wid;
 if b<>total then raise exception 'WALLET_LEDGER_DIVERGENCE'; end if;
 if exists(select 1 from wallet_ledger_entries l join wallets w on w.id=l.wallet_id join wager_transactions t on t.id=l.transaction_id where l.wallet_id=wid and (l.currency<>w.currency or t.wallet_id<>wid or t.currency<>l.currency or t.amount<>l.amount or t.status<>'PROCESSED' or t.kind='LOSS')) then raise exception 'INVALID_LEDGER_TRANSACTION'; end if;
 return null; end $$;
 create constraint trigger wallet_consistency after insert or update on wallets deferrable initially deferred for each row execute function wallet_consistent();
 create constraint trigger ledger_consistency after insert on wallet_ledger_entries deferrable initially deferred for each row execute function wallet_consistent();`);
  }
  override async down(): Promise<void> {
    this.addSql(
      `drop trigger if exists wallet_consistency on wallets;drop table if exists outbox_messages,inbox_messages,wallet_ledger_entries,wager_transactions cascade;drop function if exists wallet_consistent(),terminal_transaction(),ledger_immutable();alter table wallets drop constraint if exists wallets_currency_format;`,
    );
  }
}
