# Respostas conceituais — Parte 1.A

## 1. Diagnóstico, trade-offs e arquitetura alvo

**Vitrine:** a causa raiz é o acoplamento síncrono de uma leitura de alto volume ao ERP central. Cliente vê lentidão; negócio perde conversão; operação sobrecarrega o ERP. Manter consulta direta é simples, mas não escala. Cache-aside local reduz chamadas e latência, com custo de expiração e invalidação. Um catálogo replicado por eventos daria mais controle, mas exigiria integração que o case proíbe. Em 30 dias, introduziria cache com medição de frescor e fallback; em 90 dias, negociaria feed de mudanças/preços com o ERP e validação de divergência.

**Estoque:** a causa raiz é leitura seguida de escrita não atômica sob concorrência e ausência de uma autoridade clara para reserva. O cliente pode pagar por item indisponível; há cancelamento, custo de suporte e conciliação manual. Lock pessimista e atualização condicional no banco são seguros; a atualização condicional com `reserved` tem menor superfície operacional. Lock distribuído adiciona modo de falha e não substitui uma transação. A loja mantém banco próprio para quantidade vendável, sincronizado por processo controlado com o ERP real.

**Checkout:** a causa raiz é esperar o faturamento do ERP na requisição HTTP sem registro durável do pedido e da intenção de processamento. Timeouts geram retries e duplicidade. O cliente recebe `202` após transação local; dispatcher publica outbox; worker fatura por referência idempotente; DLQ e reconciliação resolvem resultados incertos. Publicar antes de persistir cria mensagem fantasma; persistir e publicar sem outbox pode perder mensagem. A evolução de 30 a 90 dias inclui painéis, alertas, capacidade de fila e contrato de consulta de fatura no ERP.

| Vitrine                 | Custo                                          | Complexidade                          | Latência                          | Consistência                                                     | Esforço operacional                        |
| ----------------------- | ---------------------------------------------- | ------------------------------------- | --------------------------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| ERP síncrono            | Baixo custo inicial; ERP absorve cada leitura  | Baixa no código                       | Alta e dependente do ERP          | Dados atuais quando a origem responde                            | Baixo no início; alto sob carga/incidentes |
| Cache-aside (escolhido) | Redis e memória; menos carga no ERP            | Moderada: TTL, invalidação e fallback | Baixa em hit; miss depende do ERP | Eventual para nome/preço; estoque vendável consultado localmente | Monitorar hit, stale e divergência         |
| Projeção por eventos    | Feed, armazenamento e processamento adicionais | Alta: contrato, replay e ordenação    | Baixa na leitura                  | Eventual, dependente da entrega dos eventos                      | Alto: lag, replay e reconciliação          |

| Estoque                                               | Custo                                                | Complexidade                                   | Latência                      | Consistência                                                                 | Esforço operacional                           |
| ----------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------- |
| Check-then-update                                     | Baixo inicialmente; overselling gera custo posterior | Baixa, mas incorreta sob concorrência          | Baixa sem contenção           | Insegura: leituras concorrentes podem vender a mesma unidade                 | Alto para corrigir divergências               |
| Atualização condicional atômica + reserva (escolhida) | Transação e escrita no PostgreSQL                    | Moderada: checar `rowCount` e liquidar reserva | Baixa, com contenção na linha | Forte para estoque local na transação                                        | Baixo a moderado; observar reservas pendentes |
| Lock pessimista no banco                              | Espera e ocupação de conexões                        | Moderada: ordem de locks e timeout             | Cresce sob contenção          | Forte quando toda escrita usa o mesmo bloqueio                               | Moderado: deadlocks e transações longas       |
| Lock distribuído + reserva                            | Infraestrutura e coordenação extras                  | Alta: expiração, fencing e falhas parciais     | Acrescenta ida à rede/espera  | Lock sozinho não garante consistência; reserva transacional ainda necessária | Alto: monitorar locks órfãos e conciliar      |

| Checkout/mensageria                | Custo                                | Complexidade                        | Latência                                 | Consistência                                           | Esforço operacional                     |
| ---------------------------------- | ------------------------------------ | ----------------------------------- | ---------------------------------------- | ------------------------------------------------------ | --------------------------------------- |
| Publicar antes de persistir        | Baixo inicialmente                   | Baixa                               | Fila rápida, mas commit posterior        | Mensagem fantasma se o banco falhar                    | Alto para identificar órfãos            |
| Persistir e publicar separadamente | Baixo inicialmente                   | Baixa a moderada                    | Duas operações sequenciais               | Janela de perda entre commit e publicação              | Alto para detectar pedidos sem mensagem |
| Transactional outbox (escolhida)   | Tabela, dispatcher e escritas extras | Moderada: publicação e deduplicação | Resposta HTTP rápida; entrega assíncrona | Pedido e intenção atômicos; entrega pelo menos uma vez | Monitorar backlog, retries e redelivery |

As escolhas preservam o monólito modular e a autoridade transacional do PostgreSQL; a projeção por eventos exigiria contrato que não existe neste case.

## 2. Cache, invalidação e desempenho

Redis fica entre API e adaptador de catálogo. A origem continua sendo o ERP; o banco local controla a disponibilidade vendável. Cache-aside grava chave fresh com TTL de 30 s e jitter de ±20% e chave stale de 5 min. Redis `SET NX PX` serializa refresh entre instâncias; concorrentes usam stale ou aguardam fresh. Checkout invalida fresh após commit. Em falha do ERP, stale retorna com `X-Cache: STALE`; sem stale, `503`. Em falha do Redis, a API tenta a origem. A disponibilidade é sobreposta do inventário local em toda resposta. Preço externo pode ficar defasado até o TTL; para eliminá-lo seria necessário evento de mudança ou validação da versão na origem.

Mediria p95 e RPS de hit/miss, hit ratio, carga e erros da origem, taxa de stale, idade do snapshot, divergência de preço e estoque entre projeção e ERP. O ganho não é válido se stale ou divergência crescerem junto com o hit ratio.

## 3. Observabilidade

Logs JSON incluem timestamp, nível, serviço, ambiente, `requestId`, `correlationId`, rota, status, duração e, nos fluxos de pedido, `orderId`, `jobId`, tentativa, evento e código do erro. Não registram corpo completo nem headers sensíveis. Counters medem HTTP, cache, checkout, conclusão/falha, retries, DLQ, reconciliação e ERP. Gauges mostram fila, DLQ, outbox e pedidos em processamento. Histograms medem latência HTTP, catálogo, checkout, ERP e processamento. IDs não são labels de métrica.

Traces unem requisição, Redis, origem, transação, outbox e worker por `traceparent` no evento. Os [SLIs/SLOs, painel, alertas e runbook](runbook.md) explicam como detectar degradação antes de reclamações. O exporter local usa JSON no stdout; Datadog é um destino possível, sem conta exigida.

## 4. Concorrência, estoque e idempotência

Uma checagem `SELECT available` seguida de `UPDATE` permite duas transações lerem a mesma unidade. O `UPDATE ... WHERE available >= qty` faz a condição e a reserva no mesmo comando; `rowCount=1` confirma sucesso. Múltiplos itens são ordenados e transacionados. Lock pessimista também funciona, mas aumenta espera. Lock distribuído não substitui constraints no banco. A reserva explicita unidades comprometidas até o resultado do ERP.

`Idempotency-Key` obrigatória, hash canônico do payload, índice único e trava transacional por chave lidam com retry, duplo clique e perda da resposta. O worker usa `orderId` no ERP fake. O teste crítico executa 20 checkouts simultâneos para estoque 10, exige exatamente 10 aceitações, 10 rejeições e nenhum valor negativo; deve ser repetido.

## 5. Mensageria, contrato e IA

Pedido, itens, reserva, registro de idempotência (na linha de pedido) e evento de outbox são gravados na mesma transação. O dispatcher publica depois do commit e marca o evento. Se cair após publicar, republicação é segura por `jobId` e `orderId`. BullMQ aplica retries limitados com backoff; erro final vai à DLQ e pedido fica `FAILED` ou `RECONCILIATION_REQUIRED`. Reconciliação consulta o ERP fake, inclusive após timeout ambíguo. OpenAPI declara sucessos e erros; testes cobrem cache, concorrência, idempotência, outbox e worker.

Após estado terminal confirmado, a reconciliação registra motivo e resultado em `dlq_resolutions` e remove o job resolvido da DLQ. Assim `dlq_depth` representa pendências atuais, enquanto `dlq_messages_total` mantém o histórico de entradas.

IA foi usada para gerar e revisar incrementos de implementação; [PROMPTS.md](../PROMPTS.md) registra instruções relevantes e o que foi aproveitado. A revisão final inclui typecheck, lint, testes e verificação manual dos modos de falha. Repositório público: [andress722/CaseCellShop](https://github.com/andress722/CaseCellShop).
