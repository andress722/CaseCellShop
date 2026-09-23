# Registro de prompts relevantes

## Prompt 001

### Objetivo

Implementar a especificação técnica de forma incremental.

### Prompt

"leia AGENTS_CASECELLSHOP e comece a implementação"; depois, "implemente sem paus".

### Saída aproveitada

Monólito modular, banco como autoridade transacional, cache Redis, outbox, worker BullMQ e verificação por testes.

### Revisão humana

- Aceito: instruções explícitas do arquivo do projeto e do usuário.
- Rejeitado: nenhuma decisão adicional foi apresentada como aprovação humana.
- Alterado: a porta Redis do host foi ajustada para `6380` por conflito local.

## Prompt 002

### Objetivo

Cobrir riscos de concorrência e reprocessamento definidos na especificação.

### Prompt

Trechos do documento hoje em `AGENTS.md` sobre overselling, idempotência, outbox, accept-then-timeout e cache stampede.

### Saída aproveitada

Testes de 20 compradores/10 unidades, retry com mesma chave, rollback de múltiplos itens, publicação repetida da outbox e faturamento idempotente após timeout.

### Revisão humana

- Aceito: critérios de aceite do documento fornecido.
- Rejeitado: nenhum teste foi removido ou marcado como flaky.
- Alterado: a API lê disponibilidade diretamente do inventário local mesmo em cache hit para reduzir risco de estoque exibido incorretamente.
