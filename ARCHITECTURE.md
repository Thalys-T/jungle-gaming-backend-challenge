# Decisões e limites

## Fluxo e limites de responsabilidade

`src/http/api.ts` adapta HTTP; `Queue.consume` adapta SQS. Ambos chamam `Processor.submit`, que normaliza o contrato, valida identidade, arbitra idempotência e coordena uma única transação MikroORM/PostgreSQL. `Money`, `Wallet`, `WalletLedgerEntry` e `WagerTransaction` encapsulam dinheiro, movimentação e estados. O schema protege as invariantes mesmo contra SQL fora da aplicação.

MikroORM foi mantido pela Unit of Work e `EntityManager.transactional`. Wallet usa EntitySchema e mapper. Para as demais tabelas o adaptador usa SQL parametrizado pelo EntityManager da **mesma transação**; não há ORM adicional nem conexão de escrita fora da transação. SQL explicita locks, índices parciais e triggers. Trade-off: o schema não é inteiramente inferível das entidades; migrations financeiras são explícitas, sem schema-sync automático.

## Dinheiro

Decimal.js com precisão 40; entradas e saídas monetárias são strings. PostgreSQL usa `numeric(20,2)`; máximo de 18 algarismos inteiros e duas casas. Entradas numéricas, negativas, expoentes e excesso de escala são rejeitadas antes da persistência. `Money.from` aceita até duas casas, normaliza para duas. Moeda é validada como código de três letras maiúsculas, não consultada numa tabela ISO. Não há conversão cambial. Zero não muda saldo, versão ou ledger. LOSS nunca muda saldo, mesmo com amount positivo.

## Concorrência e idempotência

Transações adquirem advisory locks **por identidade** (chave de idempotência, provider/external e inbox), em ordem determinística, e depois `SELECT ... FOR UPDATE` na linha da wallet. Nenhum lock global de aplicação. Carteiras distintas podem processar simultaneamente. UNIQUE no banco arbitra duplicatas e reversões. O lock da wallet serializa movimentos, leitura da referência e verificação de reversões. Retry limitado para deadlock/serialization/lock conflict: até 3 novas tentativas, com backoff.

A chave do header é obrigatória e globalmente única; provider/external também é único. Reutilizar provider/external com outra chave é conflito, mesmo com payload igual. O hash SHA-256 usa JSON recursivo de chaves ordenadas (objetos), preserva arrays e é calculado sobre campos de negócio explicitamente selecionados, com Money normalizado. Não inclui header, correlation ou metadados de transporte. O resultado terminal persistido inclui saldo observado no processamento; o replay só altera `idempotentReplay`.

Pendentes preservam a resposta da última transição: após processamento pelo worker, a consulta/replay retorna o resultado terminal. Enquanto a referência segue ausente, não há efeito financeiro. Backoff 2s, 4s ... até 60s; máximo 10 tentativas ou TTL de 1h. Workers verificam novamente a agenda depois de obter os locks, evitando consumir tentativas em paralelo.

## Consistência financeira e auditabilidade

O commit contém transação, alteração da wallet, ledger, inbox (se SQS) e eventos na outbox. Abertura positiva cria OPENING/CREDIT com versão 1. Cada mudança posterior incrementa a versão e produz um lançamento; zero não produz lançamento.

Constraints: wallet única por player/moeda, saldo não negativo, amount positivo no ledger, aritmética antes/depois, FKs, lançamento único por transação/wallet e versão única por wallet. Triggers impedem UPDATE, DELETE e TRUNCATE do ledger e alterações de transações terminais. Constraint triggers diferidos verificam que saldo materializado = soma assinada do ledger e que os lançamentos pertencem a transações processadas da mesma carteira, moeda e valor. Não há correção silenciosa na reconciliação.

A terceira migration exige correspondência nos dois sentidos entre transações financeiras positivas processadas e ledger, valida a direção por tipo e as referências processadas. A sequência do ledger deve começar em saldo zero, encadear saldos e versões sem lacunas e terminar na versão materializada. Um trigger imediato exige versão inicial 1 e incremento unitário somente quando o saldo muda. Os validadores diferidos observam o estado final da transação SQL e adquirem lock por wallet; as migrations anteriores permanecem intactas. A migration valida também os dados já existentes e falha se encontrar inconsistência, sem corrigi-la silenciosamente.

A checagem diferida soma o ledger da wallet: privilegia correção verificável neste desafio e tem custo crescente. Em produção, consideraria checkpoints auditados, particionamento e verificação incremental do encadeamento, mantendo auditoria completa. O usuário de produção deve ter DML mínimo e não ser dono/superuser; dono do schema sempre consegue remover triggers. Credenciais do Compose são apenas locais.

Referências são resolvidas por provider/external e validadas em player, wallet, moeda e rodada. WIN com referência exige BET processada; WIN sem referência é aceito. REFUND referencia BET; ROLLBACK referencia BET/WIN/REFUND. Não há reversão parcial. Duas reversões do mesmo tipo são impedidas; tipos diferentes seguem a regra explícita do enunciado e podem reverter a mesma referência uma vez cada. Reversão sem saldo é rejeitada com código próprio.

## Mensageria e recuperação

SQS FIFO ordena por wallet como otimização. Inbox usa `(consumer_name,message_id)` e hash do comando; idempotência financeira continua protegida pela chave e provider/external mesmo com outro messageId. O ack ocorre somente depois do retorno de `transactional`, isto é, depois do commit.

Falhas transitórias não fazem ack e aumentam visibilidade com backoff. Redrive configurado em 5 recebimentos. Contratos inválidos/conflitos permanentes são enviados à DLQ antes de remover a mensagem original. Rejeição financeira persistida é resultado terminal e faz ack. Uma falha SQL permanente não confirmada não deve ser transformada em sucesso: fica sujeita a redrive; não fabricamos transação FAILED sem poder confirmar sua auditoria.

Heartbeat renova visibilidade enquanto uma mensagem está em processamento. SIGTERM interrompe nova aquisição, termina tarefas em andamento e fecha ORM/SDK. Um kill abrupto deixa SQS redeliver; inbox e idempotência absorvem a repetição. O teste de crash usa código de saída 99 depois do commit/antes do ack.

Publishers usam `FOR UPDATE SKIP LOCKED`, publicam **após o commit financeiro** e marcam publicação numa transação separada. O lock da linha fica aberto durante chamada SDK (trade-off de simplicidade). Se morrer depois de enviar/antes de marcar, o evento pode repetir com o mesmo eventId. Consumidores externos devem implementar inbox/eventId; FIFO dedup não substitui isso. Retry de publicação é persistente, ilimitado com intervalo máximo 60s, monitorado por outbox lag; não descartamos evento confirmado.

LocalStack tem volume persistente e filas separadas de comandos, DLQ e eventos. Seus testes dependem da mesma semântica pública SQS, não de mocks. Numa aplicação produtiva, aplicar limites de pool/timeout e alarmes operacionais conforme SLO.

## Falhas públicas

`INVALID_*`, `REFERENCE_REQUIRED`: contrato inválido (400). `IDEMPOTENCY_CONFLICT`, `INBOX_PAYLOAD_CONFLICT`, `UNIQUE_CONFLICT`: conflito (409). `WALLET_NOT_FOUND`/`TRANSACTION_NOT_FOUND`: 404. `INSUFFICIENT_FUNDS`, `REVERSAL_INSUFFICIENT_FUNDS`, `CURRENCY_MISMATCH`, `PLAYER_MISMATCH`, `REFERENCE_MISMATCH`, `REFERENCE_KIND_INVALID`, `REFERENCE_NOT_PROCESSED`, `ALREADY_REVERSED`, `REVERSAL_AMOUNT_MISMATCH`, `BALANCE_LIMIT_EXCEEDED`, `REFERENCE_EXPIRED`: rejeição auditada (422). Referência ausente gera 202. Infraestrutura indisponível gera 503 e não resultado financeiro inventado.

Wallet inexistente é erro de recurso antes de persistir transação financeira, porque a FK exige uma wallet válida. A aplicação usa status PENDING apenas dentro da transação; aceita como pendência durável PENDING_REFERENCE. Estados PROCESSED/REJECTED/FAILED são terminais.

## Observabilidade

Logs JSON sem valores financeiros ou payload completo, com IDs de transação/correlação, wallet, provider e mensagem quando aplicável. Métricas Prometheus por processo: transações por status, duplicatas, retries, DLQ, conflitos de lock, divergências, soma/contagem de latência e lag da outbox consultado no banco. Redrive automático é observado pela contagem de recebimentos do consumidor; métricas em memória reiniciam com o processo (coletor externo deve armazenar séries). Readiness verifica PostgreSQL e as três filas; liveness verifica processo.

## Autenticação

Não implementada, conforme permissão do enunciado. `ProviderIdentityGuard` é o ponto explícito de extensão. Em produção, validaria JWT/OIDC num IdP externo (Keycloak/Zitadel), issuer/audience/assinatura/expiração, e vincularia providerId ao claim do principal. Health permanece público. SQS é canal interno confiável, mas valida identidade e regras de negócio normalmente. Não há tabela de senha nem autenticação artesanal.

## Limites de validação

Veja `VALIDATION.md` com ambiente e comandos de validação. Não foi realizado benchmark de carga. O transporte é at-least-once; consumidores de eventos devem deduplicar por eventId. Autenticação de produção permanece como extensão documentada.
