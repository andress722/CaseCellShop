# ADR-003: Consistência do inventário

## Context

Check-then-update permite duas compras observarem a mesma unidade disponível. Vários itens precisam ser reservados de modo indivisível.

## Decision

Ordenar itens por `productId` e executar `UPDATE inventory SET available = available - qty, reserved = reserved + qty WHERE available >= qty` na transação do pedido. Falha de qualquer item causa rollback. Finalização reduz `reserved`; falha definitiva devolve a unidade para `available`.

## Alternatives

- Lock pessimista: seguro, mas aumenta contenção e tempo de transação.
- Lock distribuído: adiciona dependência externa à garantia de estoque.
- Check-then-update: incorreto sob concorrência.

## Consequences

PostgreSQL é a autoridade vendável; o teste de 20 compradores para 10 unidades verifica o resultado. Uma integração real precisaria sincronizar alterações de estoque do ERP com essa projeção local.
