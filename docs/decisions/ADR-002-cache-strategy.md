# ADR-002: Cache do catálogo

## Context

Consultar o ERP em cada vitrine não escala e torna a latência dependente da origem. Preço pode tolerar uma janela curta de expiração; estoque vendável exige mais frescor.

## Decision

Usar cache-aside no Redis para catálogo, TTL configurável com jitter de ±20%, cópia stale por cinco minutos e lock `SET NX PX` para um refresh por vez. Se o ERP falhar, servir stale com `X-Cache: STALE`; se não houver stale, `503`. A API lê disponibilidade do inventário local em cada resposta.

## Alternatives

- Sem cache: simples, mas pressiona a origem a cada leitura.
- Refresh-ahead: reduz misses, mas adiciona agendamento e risco de trabalho inútil.
- Mutex no processo: não protege várias réplicas da API.

## Consequences

Nome e preço podem ficar defasados até o TTL; a disponibilidade tem uma leitura de banco mesmo em hit. Falha do Redis degrada para leitura direta da origem. O fake ERP usa PostgreSQL local para permanecer reproduzível.
