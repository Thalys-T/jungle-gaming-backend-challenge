import { Migration } from "@mikro-orm/migrations";

export class Migration20261102070000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
create function wallet_version_guard() returns trigger language plpgsql as $$ begin
  if TG_OP='INSERT' then
    if NEW.version<>1 then raise exception 'INVALID_INITIAL_WALLET_VERSION'; end if;
  elsif NEW.version<>OLD.version+(case when NEW.balance<>OLD.balance then 1 else 0 end) then
    raise exception 'INVALID_WALLET_VERSION_TRANSITION';
  end if;
  return NEW;
end $$;
create trigger wallet_version_guard before insert or update on wallets for each row execute function wallet_version_guard();

create function validate_wallet_financial(wid uuid) returns void language plpgsql as $$
declare w wallets%rowtype; expected_version integer;
begin
  select * into w from wallets where id=wid for update;
  if not found then return; end if;
  if exists (
    select 1 from wager_transactions t
    left join wallet_ledger_entries l on l.transaction_id=t.id and l.wallet_id=t.wallet_id
    where t.wallet_id=wid and
      ((t.status='PROCESSED' and t.kind<>'LOSS' and t.amount>0) <> (l.id is not null))
  ) then raise exception 'TRANSACTION_LEDGER_REQUIRED'; end if;

  if exists (
    select 1 from wallet_ledger_entries l
    join wager_transactions t on t.id=l.transaction_id
    left join wager_transactions r on r.id=t.reference_transaction_id
    where l.wallet_id=wid and (
      t.wallet_id<>wid or t.player_id<>w.player_id or t.currency<>w.currency
      or l.currency<>w.currency or t.amount<>l.amount or t.status<>'PROCESSED'
      or l.direction is distinct from case
        when t.kind='BET' then 'DEBIT'
        when t.kind in ('OPENING','WIN','REFUND') then 'CREDIT'
        when t.kind='ROLLBACK' and r.kind='BET' then 'CREDIT'
        when t.kind='ROLLBACK' and r.kind in ('WIN','REFUND') then 'DEBIT'
        else null end
    )
  ) then raise exception 'INVALID_LEDGER_DIRECTION_OR_IDENTITY'; end if;

  if exists (
    select 1 from wager_transactions t
    left join wager_transactions r on r.id=t.reference_transaction_id
    where t.wallet_id=wid and t.status='PROCESSED' and
      (t.kind in ('REFUND','ROLLBACK') or t.reference_external_transaction_id is not null)
      and (r.id is null or r.status<>'PROCESSED' or r.id=t.id
        or r.provider_id<>t.provider_id or r.player_id<>t.player_id
        or r.wallet_id<>t.wallet_id or r.currency<>t.currency or r.round_id<>t.round_id
        or r.external_transaction_id is distinct from t.reference_external_transaction_id
        or (t.kind in ('REFUND','WIN') and r.kind<>'BET')
        or (t.kind='ROLLBACK' and r.kind not in ('BET','WIN','REFUND'))
        or (t.kind in ('REFUND','ROLLBACK') and r.amount<>t.amount))
  ) then raise exception 'INVALID_PROCESSED_REFERENCE'; end if;

  select greatest(1,coalesce(max(wallet_version),1)) into expected_version
    from wallet_ledger_entries where wallet_id=wid;
  if w.version<>expected_version then raise exception 'WALLET_LEDGER_VERSION_DIVERGENCE'; end if;
  if exists (
    select 1 from (
      select l.*,t.kind,
        lag(l.balance_after,1,0::numeric) over(order by l.wallet_version) as previous_balance,
        lag(l.wallet_version) over(order by l.wallet_version) as previous_version
      from wallet_ledger_entries l join wager_transactions t on t.id=l.transaction_id
      where l.wallet_id=wid
    ) chain where balance_before<>previous_balance
      or wallet_version<>coalesce(previous_version+1,case when kind='OPENING' then 1 else 2 end)
      or (kind='OPENING' and (previous_version is not null or wallet_version<>1))
  ) then raise exception 'INVALID_LEDGER_CHAIN'; end if;
end $$;
create function financial_consistency_guard() returns trigger language plpgsql as $$ begin
  if TG_TABLE_NAME='wallets' then perform validate_wallet_financial(NEW.id);
  else
    perform validate_wallet_financial(NEW.wallet_id);
    if TG_OP='UPDATE' and OLD.wallet_id<>NEW.wallet_id then
      perform validate_wallet_financial(OLD.wallet_id);
    end if;
  end if;
  return null;
end $$;
create constraint trigger financial_wallet_guard after insert or update on wallets deferrable initially deferred for each row execute function financial_consistency_guard();
create constraint trigger financial_transaction_guard after insert or update on wager_transactions deferrable initially deferred for each row execute function financial_consistency_guard();
create constraint trigger financial_ledger_guard after insert on wallet_ledger_entries deferrable initially deferred for each row execute function financial_consistency_guard();
do $$ declare w record; begin
  for w in select id from wallets loop perform validate_wallet_financial(w.id); end loop;
end $$;
`);
  }

  override async down(): Promise<void> {
    this.addSql(`
drop trigger if exists financial_wallet_guard on wallets;
drop trigger if exists financial_transaction_guard on wager_transactions;
drop trigger if exists financial_ledger_guard on wallet_ledger_entries;
drop trigger if exists wallet_version_guard on wallets;
drop function if exists financial_consistency_guard(),validate_wallet_financial(uuid),wallet_version_guard();
`);
  }
}
