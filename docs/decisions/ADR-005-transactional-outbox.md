# ADR-005: Transactional outbox

## Context

Banco e Redis não compartilham commit atômico. Uma queda entre gravar o pedido e publicar a mensagem perderia o faturamento.

## Decision

Inserir `outbox_events` na transação de reserva/pedido. O dispatcher lê com `FOR UPDATE SKIP LOCKED`, publica com `jobId` estável e marca `published_at`. O worker é idempotente por `orderId`.

## Alternatives

- Publicar antes do commit: mensagem para pedido inexistente.
- Publicar após commit sem outbox: pedido persistido sem mensagem se o processo cair.

## Consequences

Entrega é pelo menos uma vez. Crash entre publish e mark pode republicar; deduplicação na fila e no ERP fake torna isso seguro. A outbox permanece pendente quando Redis falha.
