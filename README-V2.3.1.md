# SSP Moema RP Bot V2.3.1

Versão com painéis fixos configurados para o servidor Moema RP.

- Central de Registro: `1557400535332552847`
- Central de Atendimento / Suporte: `1562986223256076429`
- Painel de Comando: `1562636216208465940`

Ao iniciar, o bot verifica os três canais e publica o painel quando ele ainda não estiver presente entre as mensagens recentes.

Comandos administrativos:
- `/painel-funcional` publica no canal fixo de registro.
- `/painel-suporte` publica no canal fixo de suporte.
- `/painel-comando` publica no canal fixo de comando.
- `/painel-efetivo` painel de efetivo.
- `/historico-funcional` histórico funcional.

## Instalação
1. Crie um `.env` com `DISCORD_TOKEN=SEU_TOKEN_NOVO`.
2. Execute `npm install`.
3. Execute `npm start`.

Não inclua o `.env` no GitHub.
