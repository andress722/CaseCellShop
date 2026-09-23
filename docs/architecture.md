# Arquitetura

API e processos de background pertencem ao mesmo código-base. A API usa Fastify; PostgreSQL guarda produtos, inventário, pedidos, faturas simuladas e outbox; Redis guarda cache e filas BullMQ. O fake ERP lê o catálogo da projeção local e registra faturamento idempotente por `orderId`.

```mermaid
sequenceDiagram
  participant C as Cliente
  participant A as API
  participant D as PostgreSQL
  participant Q as BullMQ
  participant W as Worker
  participant E as Fake ERP
  C->>A: POST /checkout + Idempotency-Key
  A->>D: BEGIN, lock por chave, reserva, pedido, outbox, COMMIT
  A-->>C: 202 PENDING
  D->>Q: dispatcher publica order.created
  Q->>W: entrega com retry
  W->>E: invoice(orderId)
  E-->>W: referência idempotente
  W->>D: COMPLETED e baixa da reserva
```

Traces propagam `traceparent` no payload da outbox até o worker. Logs JSON registram IDs, eventos e duração; métricas Prometheus não usam IDs de pedido ou request como labels. A API expõe `/metrics`. Quando o worker roda em processo separado, suas métricas residem naquele processo e precisam de endpoint/exporter próprio para coleta central; esta configuração local roda os componentes juntos por padrão.
