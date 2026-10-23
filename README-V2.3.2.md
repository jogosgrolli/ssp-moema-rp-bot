# SSP Moema RP Bot V2.3.2

Correções da V2.3.2:

- Painel de efetivo usa cache de membros com atualização protegida por cooldown de 60 segundos.
- Evita buscas completas repetidas que causavam Opcode 8 / rate limit ao clicar em Polícia Militar ou Polícia Civil.
- Se o Discord limitar temporariamente a atualização, o painel continua usando o cache local.
- Banners de Registro e Tickets são opcionais: se estiverem ausentes, os painéis são publicados sem imagem em vez de falhar.
- Mantidos os canais fixos: Registro 1557400535332552847, Suporte 1562986223256076429 e Comando 1562636216208465940.
- Mantidos promoção, transferência, desligamento, tickets, histórico e cadastro funcional.

## Iniciar

1. Coloque seu `.env` na pasta do bot.
2. Execute `npm install`.
3. Execute `npm start`.

Nunca publique seu token do Discord no GitHub.
