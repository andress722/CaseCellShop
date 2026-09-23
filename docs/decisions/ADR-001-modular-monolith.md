# ADR-001: Monólito modular

## Context

O case exige catálogo, checkout transacional, outbox e processamento assíncrono em uma solução pequena e local. Separar serviços desde o início acrescentaria implantação, comunicação e observabilidade distribuída antes de haver necessidade de escala independente.

## Decision

Usar um único código-base Node.js/TypeScript com módulos de catálogo, checkout, pedidos, integrações e mensageria. API e workers poderão ser processos separados do mesmo código-base. PostgreSQL será a autoridade transacional de pedido e estoque; Redis será cache e transporte.

## Alternatives

- Microserviços independentes: permitem escalabilidade e deploy isolados, mas elevam o custo operacional e tornam a consistência do case mais difícil de demonstrar.
- Um único arquivo/aplicação sem fronteiras: inicia rápido, mas mistura regras de checkout, integração ERP e HTTP.

## Consequences

Transações de inventário, pedido e outbox podem ser locais e explícitas. Os módulos devem manter limites claros para que o worker não concentre regras de negócio. A escala independente de cada módulo fica limitada até que exista justificativa para extração.
