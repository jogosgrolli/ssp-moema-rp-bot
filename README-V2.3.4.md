# SSP Moema RP Bot V2.3.4

## Transferência com aprovação do destino

- A solicitação não altera cargos imediatamente.
- A aprovação é enviada ao canal configurado em `transferApprovalChannelId`.
- O bot menciona Coronel e Tenente-Coronel.
- Para aprovar/recusar, o usuário deve possuir a patente Coronel ou Tenente-Coronel **e** o cargo da corporação de destino. Administradores continuam com permissão de contingência.
- Após aprovação, o cargo da corporação de origem é removido e o cargo da corporação de destino é adicionado. A patente é mantida.
- Após aprovação ou recusa, a solicitação pendente é apagada; não é mantido histórico de transferências.
