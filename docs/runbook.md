# Runbook local e objetivos operacionais

## SLI/SLO propostos

| Fluxo              | SLI                                                 | Objetivo         |
| ------------------ | --------------------------------------------------- | ---------------- |
| Catálogo           | Respostas válidas em até 500 ms                     | 99,5% em 30 dias |
| Intake de checkout | POST válido que retorna 202 em até 500 ms           | 99,9% em 30 dias |
| Processamento      | Pedido aceito em estado terminal válido em até 60 s | 99%              |

Metas de latência internas: p95 de `/products` em hit <100 ms e miss <500 ms; checkout <300 ms; status <150 ms. Estas são metas, sem medição de carga representativa no case.

## Painel sugerido

Exibir RPS, taxa de erro e p95 por rota com `http_requests_total` e `http_request_duration_seconds`; hit ratio e stale com `catalog_cache_hits_total`, `catalog_cache_misses_total`, `catalog_stale_served_total`; intake de checkout por resultado; `outbox_pending`, `queue_depth`, `dlq_depth`, `orders_processing`; `worker_retries_total`, `erp_errors_total`, `erp_request_duration_seconds` e `reconciliation_total`. Filtrar logs por `requestId`, `correlationId`, `traceId` ou `orderId`, sem usar esses campos como labels de métrica.

## Alertas e resposta

| Alerta                                      | Impacto e confirmação                                                                                                   | Ação imediata                                                   | Recuperação e validação                                                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Erro HTTP >2% por 5 min                     | Clientes falham; verificar `http_requests_total`, logs `http.request.failed` e spans da rota.                           | Verificar `/health/ready`, PostgreSQL e Redis.                  | Restaurar dependência; confirmar 2xx e p95.                                                                                   |
| p95 catálogo >500 ms ou hit ratio baixo     | Vitrine lenta; comparar hit/miss/stale, `catalog_load_duration_seconds` e spans `redis.get`/`erp.catalog.fetch`.        | Verificar Redis, TTL e ERP fake.                                | Recuperar origem/cache; confirmar hit ratio, frescor e latência.                                                              |
| `catalog_stale_served_total` cresce         | Dados de nome/preço podem envelhecer; conferir logs `catalog.cache.stale` e erro da origem.                             | Restaurar ERP catálogo.                                         | Confirmar MISS seguido de HIT e idade dentro do TTL.                                                                          |
| `outbox_pending` cresce continuamente       | Pedidos aguardam fila; consultar outbox, logs `outbox.dispatch.failed` e Redis.                                         | Restaurar Redis/dispatcher; não apagar eventos.                 | Confirmar `published_at`, fila e status dos pedidos.                                                                          |
| `queue_depth` cresce                        | Faturamento atrasa; verificar worker, retry e ERP.                                                                      | Aumentar workers somente se ERP suporta carga; investigar erro. | Confirmar redução da fila e pedidos terminais.                                                                                |
| `dlq_depth` >0 ou `dlq_messages_total` sobe | `dlq_depth` indica pendências atuais; `dlq_messages_total` é histórico de entradas. Correlacionar jobId/orderId e erro. | Executar `npm run reconcile` após verificar o ERP.              | Confirmar status terminal, `dlq_depth` reduzido e registro em `dlq_resolutions`; reenfileirar só com idempotência confirmada. |
| `orders_processing` envelhecido             | Pedido pode ter sido faturado sem confirmação local; localizar trace do worker e consultar fake ERP por `orderId`.      | Executar reconciliação.                                         | Confirmar `COMPLETED` ou `FAILED` e inventário coerente.                                                                      |
| Divergência de estoque                      | Risco de indisponibilidade incorreta; comparar `available + reserved` com projeção e faturas.                           | Suspender ajuste manual até entender pedidos afetados.          | Corrigir via operação transacional auditada; repetir teste de concorrência e consulta de catálogo.                            |

## Procedimento DLQ detalhado

1. Confirmar `dlq_depth`, `queue_depth` e `outbox_pending` em `/metrics`.
2. Filtrar logs pelo `jobId` e `orderId`, identificar motivo e tentativa.
3. Consultar status em `/orders/{orderId}/status` e fatura do fake ERP por `orderId` no banco.
4. Rodar `npm run reconcile`. A rotina consulta pedidos incertos, envelhecidos e a DLQ; após estado terminal, registra a resolução em `dlq_resolutions` e remove o job resolvido.
5. Verificar `COMPLETED` ou `FAILED`, reserva do inventário, `dlq_depth` sem esse job e histórico em `dlq_resolutions`. Em `COMPLETED`, confirmar uma fatura em `erp_invoices`; em `FAILED`, confirmar que não há fatura.
6. Só reenfileirar manualmente após confirmar que o ERP real aceita referência idempotente.

## Falhas simuláveis

Use `ERP_CATALOG_MODE=error` para testar stale/503. Use `ERP_BILLING_MODE=timeout` para retries, DLQ e reconciliação; `error` para falha definitiva; `accept_then_timeout` para faturamento seguido de perda da resposta. Reinicie a API após mudar `.env`. O teste de concorrência é `npm run test:concurrency` e pode ser repetido para detectar flakiness.
