# ADR-004: Idempotência do checkout

## Context

Retry, duplo clique e perda da resposta após commit podem repetir a requisição.

## Decision

Exigir `Idempotency-Key`, guardar hash SHA-256 de itens ordenados e impor unicidade no PostgreSQL. Uma advisory lock transacional por chave serializa tentativas simultâneas; mesma chave e payload retorna o pedido existente, payload diferente retorna `409`.

## Alternatives

- Deduplicação em memória: falha com múltiplas instâncias e reinício.
- Redis como único registro: não participa da transação de estoque/pedido.

## Consequences

As chaves são retidas no banco durante a vida do pedido nesta demonstração. Produção exigiria política de retenção e isolamento por cliente após autenticação.
