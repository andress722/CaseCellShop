# ADR-006: Retry, DLQ e reconciliação

## Context

Faturamento remoto pode falhar, demorar ou confirmar sem devolver resposta. Timeout não prova que a operação não ocorreu.

## Decision

BullMQ executa três tentativas com backoff exponencial. `orderId` é referência idempotente no fake ERP. Erro definitivo marca `FAILED`; timeout esgotado marca `RECONCILIATION_REQUIRED`. Ambos entram na DLQ. Reconciliação consulta o ERP e também procura pedidos `PROCESSING` envelhecidos.

## Alternatives

- Retry ilimitado: deixa pedidos presos e sobrecarrega o ERP.
- Marcar timeout como falha imediata: pode liberar estoque de pedido já faturado.
- Tratar a fila como fonte de verdade: perde o status persistido e dificulta recuperação.

## Consequences

DLQ requer inspeção operacional. Na simulação, `lookupInvoice` é determinístico; um ERP real exigiria consulta confiável ou manteria o estado incerto até confirmação humana.
