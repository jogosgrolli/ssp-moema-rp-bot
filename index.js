require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder,
  TextInputStyle, EmbedBuilder, PermissionsBitField, StringSelectMenuBuilder, ChannelType
} = require('discord.js');
const config = require('./config.json');

const client = new Client({ intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers], partials:[Partials.Channel] });
const dataFile = path.join(__dirname, 'requests.json');
let requests = {};
try { if (fs.existsSync(dataFile)) requests = JSON.parse(fs.readFileSync(dataFile,'utf8')); } catch { requests = {}; }
const save = () => fs.writeFileSync(dataFile, JSON.stringify(requests,null,2));
const safeId = id => id && !String(id).startsWith('ID_');
const isAdmin = m => m.permissions.has(PermissionsBitField.Flags.Administrator) || (config.adminRoleIds||[]).some(id=>m.roles.cache.has(id));
const isCommander = m => isAdmin(m) || (config.promotionManagerRoleIds||[]).some(id=>m.roles.cache.has(id));
const b64 = s => Buffer.from(String(s)).toString('base64url');
const unb64 = s => Buffer.from(s,'base64url').toString();

function typeOrgs(type){ return Object.entries(config.organizations).filter(([,o])=>o.type===type); }
function hierarchy(type){ return config.hierarchies[type]; }
function allRankIds(){ return new Set(Object.values(config.hierarchies).flatMap(h=>Object.values(h.ranks))); }
function currentRank(member,type){
  const ranks=Object.entries(hierarchy(type)?.ranks||{});
  const found=ranks.find(([,id])=>member.roles.cache.has(id));
  return found ? {name:found[0],id:found[1],index:ranks.findIndex(x=>x[1]===found[1])} : null;
}
async function sendLog(text){
  if(!safeId(config.logChannelId)) return;
  const ch=await client.channels.fetch(config.logChannelId).catch(()=>null);
  if(ch?.isTextBased()) await ch.send(text).catch(()=>{});
}
function baseEmbed(title,desc){ return new EmbedBuilder().setTitle(title).setDescription(desc).setFooter({text:'SSP • Moema RP • V2.3.5'}).setTimestamp(); }

// V2.3.2: evita buscas completas repetidas de membros (Opcode 8 / rate limit).
const memberCacheState = new Map();
async function warmMemberCache(guild){
  const now=Date.now();
  const state=memberCacheState.get(guild.id)||{};
  if(state.promise) return state.promise;
  if(state.lastFetch && now-state.lastFetch < 60000) return guild.members.cache;
  const promise=guild.members.fetch().then(()=>{
    memberCacheState.set(guild.id,{lastFetch:Date.now(),promise:null});
    return guild.members.cache;
  }).catch(err=>{
    // Em rate limit ou falha temporária, usa o cache já recebido pelo Gateway.
    memberCacheState.set(guild.id,{lastFetch:Date.now(),promise:null});
    const wait=err?.data?.retry_after || err?.retry_after;
    console.warn(`Aviso: não foi possível atualizar todos os membros${wait?` (rate limit: ${wait}s)`:''}. Usando cache local.`);
    return guild.members.cache;
  });
  memberCacheState.set(guild.id,{lastFetch:state.lastFetch||0,promise});
  return promise;
}
function memberOrg(member,type){ return typeOrgs(type).filter(([,o])=>member.roles.cache.has(o.roleId)).map(([n])=>n).join(', ') || 'Sem corporação'; }
async function effectiveText(guild,type){
  await warmMemberCache(guild);
  const h=hierarchy(type); const ranks=Object.entries(h.ranks).slice().reverse();
  const lines=[]; let total=0;
  for(const [rank,roleId] of ranks){
    const ms=guild.members.cache.filter(m=>!m.user.bot && m.roles.cache.has(roleId) && typeOrgs(type).some(([,o])=>m.roles.cache.has(o.roleId))).sort((a,b)=>a.displayName.localeCompare(b.displayName,'pt-BR'));
    if(!ms.size) continue; total+=ms.size;
    lines.push(`**${rank.toUpperCase()}**`);
    for(const m of ms.values()) lines.push(`• ${m.displayName} — ${memberOrg(m,type)}`);
    lines.push('');
  }
  return {text:lines.join('\n').slice(0,3900)||'Nenhum membro encontrado.',total};
}
async function effectivePanel(guild,type){ const h=hierarchy(type); const x=await effectiveText(guild,type); const e=baseEmbed(`${h.emoji} ${h.label} • EFETIVO`,`${x.text}\n\n👥 **Efetivo listado:** ${x.total}`); e.setColor(type==='military'?0x0B5ED7:0x6F42C1); return {embeds:[e],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('effective_home').setLabel('Voltar').setEmoji('↩️').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId(`effective_refresh:${type}`).setLabel('Atualizar').setEmoji('🔄').setStyle(ButtonStyle.Primary))]}; }
async function refreshEffectivePanels(guild){ /* painéis interativos são atualizados sob demanda pelo botão Atualizar */ }


function registrationPanel(){
  const embed=baseEmbed('📋 CENTRAL DE REGISTRO • SSP MOEMA RP',`Selecione o seu tipo de registro clicando em um dos botões abaixo.\n\n👮 **Polícia Militar** — Registro para corporações da estrutura Militar.\n🕵️ **Polícia Civil** — Registro para corporações da estrutura Civil.\n\n📋 Depois escolha sua corporação e informe **Nome, ID/Passaporte e Telefone**.\n✅ A solicitação será enviada ao Alto Comando para aprovação.`);
  const bannerPath=path.join(__dirname,'assets','banner-registro.png');
  embed.setColor(0x1565C0).setFooter({text:'SSP • Moema RP • CENTRAL DE REGISTRO'});
  if(fs.existsSync(bannerPath)) embed.setImage('attachment://banner-registro.png');
  return {embeds:[embed],components:[new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('request_type:military').setLabel('POLÍCIA MILITAR').setEmoji('👮').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('request_type:civil').setLabel('POLÍCIA CIVIL').setEmoji('🕵️').setStyle(ButtonStyle.Danger)
  )],...(fs.existsSync(bannerPath)?{files:[{attachment:bannerPath,name:'banner-registro.png'}]}:{})};
}

function supportPanel(){
  const embed=baseEmbed('🎫 CENTRAL DE ATENDIMENTO • SSP MOEMA RP',`Escolha uma das opções abaixo conforme sua necessidade:\n\n🛠️ **Suporte** — Para tirar dúvidas, reportar problemas ou obter informações.\n📅 **Ausências** — Para avisar sobre ausências e afastamentos.\n🚪 **Solicitação de Demissão** — Para solicitar seu desligamento da corporação.\n\n🔒 Cada solicitação abre um **ticket privado** para atendimento.`);
  const bannerPath=path.join(__dirname,'assets','banner-tickets.png');
  embed.setColor(0x1565C0).setFooter({text:'SSP • Moema RP • CENTRAL DE ATENDIMENTO'});
  if(fs.existsSync(bannerPath)) embed.setImage('attachment://banner-tickets.png');
  const row=new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_open:support').setLabel('SUPORTE').setEmoji('🛠️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ticket_open:absence').setLabel('AUSÊNCIAS').setEmoji('📅').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticket_open:dismissal').setLabel('SOLICITAÇÃO DE DEMISSÃO').setEmoji('🚪').setStyle(ButtonStyle.Danger)
  );
  return {embeds:[embed],components:[row],...(fs.existsSync(bannerPath)?{files:[{attachment:bannerPath,name:'banner-tickets.png'}]}:{})};
}

async function ensurePanelInChannel(channelId, panelFactory, footerText, label){
  if(!safeId(channelId)) return;
  const ch=await client.channels.fetch(channelId).catch(()=>null);
  if(!ch?.isTextBased()) return console.error(`Canal do ${label} inválido/inacessível: ${channelId}`);
  const recent=await ch.messages.fetch({limit:50}).catch(()=>null);
  const exists=recent?.some(m=>m.author.id===client.user.id && m.embeds?.some(e=>e.footer?.text===footerText));
  if(!exists) await ch.send(panelFactory()).catch(e=>console.error(`Falha ao publicar ${label}:`,e.message));
}
async function ensureFixedPanels(){
  await ensurePanelInChannel(config.registrationChannelId, registrationPanel, 'SSP • Moema RP • CENTRAL DE REGISTRO', 'Central de Registro');
  await ensurePanelInChannel(config.supportPanelChannelId, supportPanel, 'SSP • Moema RP • CENTRAL DE ATENDIMENTO', 'Central de Atendimento');
  await ensurePanelInChannel(config.commandPanelChannelId, actionPanel, 'SSP • Moema RP • V2.3.5', 'Painel de Comando');
}

function ticketModal(kind){
  const labels={support:'Suporte',absence:'Ausência',dismissal:'Solicitação de Demissão'};
  const modal=new ModalBuilder().setCustomId(`ticket_modal:${kind}`).setTitle(labels[kind]||'Atendimento');
  if(kind==='support'){
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('subject').setLabel('Assunto').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('details').setLabel('Descreva sua dúvida ou problema').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true))
    );
  }else if(kind==='absence'){
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('start').setLabel('Data de início').setPlaceholder('DD/MM/AAAA').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('return').setLabel('Data prevista de retorno').setPlaceholder('DD/MM/AAAA').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('details').setLabel('Motivo da ausência').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true))
    );
  }else{
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('details').setLabel('Motivo da solicitação de demissão').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true)));
  }
  return modal;
}

async function createTicket(i,kind){
  const names={support:'suporte',absence:'ausencia',dismissal:'demissao'};
  const titles={support:'🛠️ SUPORTE',absence:'📅 AUSÊNCIA',dismissal:'🚪 SOLICITAÇÃO DE DEMISSÃO'};
  const existing=i.guild.channels.cache.find(c=>c.topic?.includes(`ticket-owner:${i.user.id}`) && c.topic?.includes(`ticket-kind:${kind}`));
  if(existing) return i.reply({content:`⚠️ Você já possui um ticket deste tipo aberto: ${existing}`,ephemeral:true});
  const overwrites=[
    {id:i.guild.id,deny:[PermissionsBitField.Flags.ViewChannel]},
    {id:i.user.id,allow:[PermissionsBitField.Flags.ViewChannel,PermissionsBitField.Flags.SendMessages,PermissionsBitField.Flags.ReadMessageHistory,PermissionsBitField.Flags.AttachFiles]},
    {id:client.user.id,allow:[PermissionsBitField.Flags.ViewChannel,PermissionsBitField.Flags.SendMessages,PermissionsBitField.Flags.ReadMessageHistory,PermissionsBitField.Flags.ManageChannels]}
  ];
  for(const rid of [...new Set([...(config.adminRoleIds||[]),...(config.promotionManagerRoleIds||[])])]) if(safeId(rid)) overwrites.push({id:rid,allow:[PermissionsBitField.Flags.ViewChannel,PermissionsBitField.Flags.SendMessages,PermissionsBitField.Flags.ReadMessageHistory]});
  const parent=safeId(config.ticketCategoryId)?config.ticketCategoryId:(i.channel?.parentId||undefined);
  const clean=i.user.username.toLowerCase().replace(/[^a-z0-9-]/g,'').slice(0,20)||i.user.id.slice(-6);
  const ch=await i.guild.channels.create({name:`${names[kind]}-${clean}`,type:ChannelType.GuildText,parent,topic:`ticket-owner:${i.user.id} | ticket-kind:${kind}`,permissionOverwrites:overwrites});
  let desc=`**Solicitante:** ${i.user}\n**Tipo:** ${titles[kind]}\n`;
  if(kind==='support') desc+=`**Assunto:** ${i.fields.getTextInputValue('subject')}\n\n**Descrição:**\n${i.fields.getTextInputValue('details')}`;
  if(kind==='absence') desc+=`**Início:** ${i.fields.getTextInputValue('start')}\n**Retorno:** ${i.fields.getTextInputValue('return')}\n\n**Motivo:**\n${i.fields.getTextInputValue('details')}`;
  if(kind==='dismissal') desc+=`\n**Motivo:**\n${i.fields.getTextInputValue('details')}\n\n⚠️ A demissão **não é automática**. Aguarde análise do Alto Comando.`;
  const buttons=[new ButtonBuilder().setCustomId('ticket_claim').setLabel('ASSUMIR').setEmoji('👤').setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId('ticket_close').setLabel('FECHAR TICKET').setEmoji('🔒').setStyle(ButtonStyle.Secondary)];
  if(kind==='dismissal') buttons.unshift(new ButtonBuilder().setCustomId(`ticket_dismiss_approve:${i.user.id}`).setLabel('APROVAR DEMISSÃO').setEmoji('✅').setStyle(ButtonStyle.Danger));
  await ch.send({content:`${i.user}`,embeds:[baseEmbed(titles[kind],desc)],components:[new ActionRowBuilder().addComponents(...buttons)]});
  await sendLog(`🎫 TICKET ABERTO | ${titles[kind]} | ${i.user} | ${ch}`);
  return i.reply({content:`✅ Seu ticket foi criado: ${ch}`,ephemeral:true});
}

function actionPanel(){
  const embed=baseEmbed('🛡️ SSP • MOEMA ROLEPLAY','## GESTÃO DE EFETIVO POLICIAL\nSelecione uma ação abaixo.\n\n🎖️ **Promoção** — altera a patente do policial.\n🔄 **Transferência** — move o policial entre corporações da mesma estrutura.\n🚪 **Desligamento** — remove corporação e patente.\n\n🔐 Acesso restrito ao Alto Comando.\n📋 Todas as alterações são registradas em LOG.');
  const row=new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mgmt_action:promo').setLabel('PROMOÇÃO').setEmoji('🎖️').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('mgmt_action:transfer').setLabel('TRANSFERÊNCIA').setEmoji('🔄').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('mgmt_action:dismiss').setLabel('DESLIGAMENTO').setEmoji('🚪').setStyle(ButtonStyle.Danger)
  );
  return {embeds:[embed],components:[row]};
}
function typePanel(action){
  const name=action==='promo'?'PROMOÇÃO':action==='transfer'?'TRANSFERÊNCIA':'DESLIGAMENTO';
  const embed=baseEmbed(`🛡️ ${name} • TIPO DE FORÇA`,'Escolha primeiro a estrutura funcional do policial.');
  const row=new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mgmt_type:${action}:military`).setLabel('POLÍCIA MILITAR').setEmoji('👮').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`mgmt_type:${action}:civil`).setLabel('POLÍCIA CIVIL').setEmoji('🕵️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('mgmt_home').setLabel('Voltar').setEmoji('↩️').setStyle(ButtonStyle.Secondary)
  );
  return {embeds:[embed],components:[row]};
}
function orgPanel(action,type){
  const h=hierarchy(type); const orgs=typeOrgs(type);
  const menu=new StringSelectMenuBuilder().setCustomId(`mgmt_org:${action}:${type}`).setPlaceholder('Selecione a corporação / unidade').addOptions(orgs.map(([name])=>({label:name,value:name,emoji:type==='military'?'👮':'🕵️'})));
  const back=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`mgmt_action:${action}`).setLabel('Voltar').setEmoji('↩️').setStyle(ButtonStyle.Secondary));
  return {embeds:[baseEmbed(`${h.emoji} ${h.label} • CORPORAÇÃO`,'Selecione a corporação/unidade. Depois o bot exibirá **somente os membros que possuem o cargo dessa corporação**.')],components:[new ActionRowBuilder().addComponents(menu),back]};
}
async function memberPanel(guild,action,type,org,page=0){
  await warmMemberCache(guild);
  const roleId=config.organizations[org]?.roleId;
  const members=guild.members.cache.filter(m=>!m.user.bot && m.roles.cache.has(roleId)).sort((a,b)=>a.displayName.localeCompare(b.displayName,'pt-BR')).map(m=>m);
  if(!members.length) return {embeds:[baseEmbed('📭 Nenhum membro encontrado',`Não há membros com o cargo **${org}** no momento.`)],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`mgmt_type:${action}:${type}`).setLabel('Voltar').setEmoji('↩️').setStyle(ButtonStyle.Secondary))]};
  const maxPage=Math.max(0,Math.ceil(members.length/25)-1); page=Math.max(0,Math.min(page,maxPage));
  const slice=members.slice(page*25,page*25+25);
  const menu=new StringSelectMenuBuilder().setCustomId(`mgmt_member:${action}:${type}:${b64(org)}:${page}`).setPlaceholder(`Escolha um membro de ${org}`).addOptions(slice.map(m=>({label:m.displayName.slice(0,100),description:`@${m.user.username}`.slice(0,100),value:m.id})));
  const nav=[];
  if(page>0) nav.push(new ButtonBuilder().setCustomId(`mgmt_page:${action}:${type}:${b64(org)}:${page-1}`).setLabel('Anterior').setEmoji('⬅️').setStyle(ButtonStyle.Secondary));
  if(page<maxPage) nav.push(new ButtonBuilder().setCustomId(`mgmt_page:${action}:${type}:${b64(org)}:${page+1}`).setLabel('Próxima').setEmoji('➡️').setStyle(ButtonStyle.Secondary));
  nav.push(new ButtonBuilder().setCustomId(`mgmt_type:${action}:${type}`).setLabel('Voltar').setEmoji('↩️').setStyle(ButtonStyle.Secondary));
  const h=hierarchy(type);
  return {embeds:[baseEmbed('👤 SELECIONAR POLICIAL',`**Tipo:** ${h.emoji} ${h.label}\n**Corporação:** ${org}\n**Membros encontrados:** ${members.length}\n**Página:** ${page+1}/${maxPage+1}\n\nA lista abaixo está filtrada pelo cargo **${org}**.`)],components:[new ActionRowBuilder().addComponents(menu),new ActionRowBuilder().addComponents(...nav)]};
}
function rankPanel(member,type,org){
  const h=hierarchy(type); const cur=currentRank(member,type); const ranks=Object.entries(h.ranks);
  const start=cur ? cur.index+1 : 0; const available=ranks.slice(start);
  if(!available.length) return {embeds:[baseEmbed('🏅 Patente máxima',`${member} já está na patente máxima: **${cur?.name||'—'}**.`)],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`mgmt_page:promo:${type}:${b64(org)}:0`).setLabel('Voltar').setEmoji('↩️').setStyle(ButtonStyle.Secondary))]};
  const menu=new StringSelectMenuBuilder().setCustomId(`mgmt_rank:${type}:${b64(org)}:${member.id}`).setPlaceholder('Selecione a nova patente').addOptions(available.map(([name,id])=>({label:name,value:id,description:`Promover para ${name}`})));
  return {embeds:[baseEmbed('🎖️ PROMOÇÃO FUNCIONAL',`**Policial:** ${member}\n**Corporação:** ${org}\n**Hierarquia:** ${h.label}\n**Patente atual:** ${cur?.name||'Sem patente identificada'}\n\nSelecione a nova patente.`)],components:[new ActionRowBuilder().addComponents(menu),new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`mgmt_page:promo:${type}:${b64(org)}:0`).setLabel('Voltar').setEmoji('↩️').setStyle(ButtonStyle.Secondary))]};
}


function effectiveHomePanel(){
  const embed=baseEmbed('🛡️ SSP • MOEMA ROLEPLAY',`## 📋 CENTRAL DE EFETIVO
Consulte o efetivo por hierarquia, corporação ou ficha individual.

👮 **Polícia Militar** — Coronel até Soldado 2ª Classe.
🕵️ **Polícia Civil** — Delegado até Acadepol.
🏛️ **Por Corporação** — lista somente a unidade escolhida.
🔎 **Consultar Membro** — abre a ficha funcional individual.`); embed.setColor(0x212529);
  return {embeds:[embed],components:[
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('effective_type:military').setLabel('EFETIVO MILITAR').setEmoji('👮').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('effective_type:civil').setLabel('EFETIVO CIVIL').setEmoji('🕵️').setStyle(ButtonStyle.Primary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('effective_org_start').setLabel('POR CORPORAÇÃO').setEmoji('🏛️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('effective_member_start').setLabel('CONSULTAR MEMBRO').setEmoji('🔎').setStyle(ButtonStyle.Success)
    )
  ]};
}
function latestApprovedRequest(userId){
  return Object.values(requests).filter(r=>r.userId===userId && r.status==='approved').sort((a,b)=>new Date(b.processedAt||b.createdAt)-new Date(a.processedAt||a.createdAt))[0] || null;
}
async function effectiveOrgTypePanel(){
  return {embeds:[baseEmbed('🏛️ EFETIVO POR CORPORAÇÃO','Selecione primeiro a hierarquia da corporação.')],components:[new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('effective_org_type:military').setLabel('POLÍCIA MILITAR').setEmoji('👮').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('effective_org_type:civil').setLabel('POLÍCIA CIVIL').setEmoji('🕵️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('effective_home').setLabel('Voltar').setEmoji('↩️').setStyle(ButtonStyle.Secondary)
  )]};
}
function effectiveOrgSelectPanel(type){
  const h=hierarchy(type); const orgs=typeOrgs(type);
  const menu=new StringSelectMenuBuilder().setCustomId(`effective_org_select:${type}`).setPlaceholder('Selecione a corporação / unidade').addOptions(orgs.map(([name])=>({label:name,value:name,emoji:h.emoji})));
  return {embeds:[baseEmbed(`${h.emoji} ${h.label} • POR CORPORAÇÃO`,'Escolha a corporação para visualizar somente os integrantes dela, organizados por patente.')],components:[new ActionRowBuilder().addComponents(menu),new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('effective_org_start').setLabel('Voltar').setEmoji('↩️').setStyle(ButtonStyle.Secondary))]};
}
async function effectiveOrgPanel(guild,type,org){
  await warmMemberCache(guild); const h=hierarchy(type); const roleId=config.organizations[org]?.roleId; const lines=[]; let total=0;
  for(const [rank,rankId] of Object.entries(h.ranks).slice().reverse()){
    const ms=guild.members.cache.filter(m=>!m.user.bot && m.roles.cache.has(roleId) && m.roles.cache.has(rankId)).sort((a,b)=>a.displayName.localeCompare(b.displayName,'pt-BR'));
    if(!ms.size) continue; total+=ms.size; lines.push(`**${rank.toUpperCase()}**`); for(const m of ms.values()) lines.push(`• ${m.displayName}`); lines.push('');
  }
  const embed=baseEmbed(`🏛️ ${org} • EFETIVO`,`${lines.join('\n').slice(0,3900)||'Nenhum membro encontrado com patente válida.'}\n\n👥 **Efetivo listado:** ${total}`); embed.setColor(type==='military'?0x0B5ED7:0x6F42C1);
  return {embeds:[embed],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`effective_org_type:${type}`).setLabel('Outra corporação').setEmoji('↩️').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId(`effective_org_refresh:${type}:${b64(org)}`).setLabel('Atualizar').setEmoji('🔄').setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId('effective_home').setLabel('Início').setEmoji('🏠').setStyle(ButtonStyle.Secondary))]};
}
async function effectiveMemberSelectPanel(guild,page=0){
  await warmMemberCache(guild); const orgRoleIds=new Set(Object.values(config.organizations).map(o=>o.roleId));
  const members=guild.members.cache.filter(m=>!m.user.bot && [...orgRoleIds].some(id=>m.roles.cache.has(id))).sort((a,b)=>a.displayName.localeCompare(b.displayName,'pt-BR')).map(m=>m);
  if(!members.length) return {embeds:[baseEmbed('🔎 CONSULTAR MEMBRO','Nenhum membro policial foi encontrado.')],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('effective_home').setLabel('Voltar').setEmoji('↩️').setStyle(ButtonStyle.Secondary))]};
  const maxPage=Math.max(0,Math.ceil(members.length/25)-1); page=Math.max(0,Math.min(page,maxPage)); const slice=members.slice(page*25,page*25+25);
  const menu=new StringSelectMenuBuilder().setCustomId(`effective_member_select:${page}`).setPlaceholder('Selecione o membro').addOptions(slice.map(m=>({label:m.displayName.slice(0,100),description:`@${m.user.username}`.slice(0,100),value:m.id})));
  const nav=[]; if(page>0) nav.push(new ButtonBuilder().setCustomId(`effective_member_page:${page-1}`).setLabel('Anterior').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)); if(page<maxPage) nav.push(new ButtonBuilder().setCustomId(`effective_member_page:${page+1}`).setLabel('Próxima').setEmoji('➡️').setStyle(ButtonStyle.Secondary)); nav.push(new ButtonBuilder().setCustomId('effective_home').setLabel('Início').setEmoji('🏠').setStyle(ButtonStyle.Secondary));
  return {embeds:[baseEmbed('🔎 CONSULTAR MEMBRO',`Selecione um integrante para abrir a **Ficha Funcional**.\n\n👥 Membros encontrados: **${members.length}**\n📄 Página: **${page+1}/${maxPage+1}**`)],components:[new ActionRowBuilder().addComponents(menu),new ActionRowBuilder().addComponents(...nav)]};
}
async function effectiveMemberCard(guild,userId,page=0){
  const member=await guild.members.fetch(userId); const militaryOrgs=memberOrg(member,'military'); const civilOrgs=memberOrg(member,'civil');
  const hasMil=militaryOrgs!=='Sem corporação'; const hasCiv=civilOrgs!=='Sem corporação'; const type=hasCiv&&!hasMil?'civil':hasMil&&!hasCiv?'military':hasCiv?'civil':'military'; const rank=currentRank(member,type); const req=latestApprovedRequest(userId);
  const orgs=[hasMil?militaryOrgs:null,hasCiv?civilOrgs:null].filter(Boolean).join(', ')||'Não identificada';
  const status=(hasMil||hasCiv)?'🟢 ATIVO':'⚪ SEM FUNCIONAL';
  const embed=baseEmbed('👤 FICHA FUNCIONAL',`**Membro:** ${member}\n**Nome no servidor:** ${member.displayName}\n🪪 **ID / Passaporte:** ${req?.passport||'Não cadastrado'}\n📱 **Telefone:** ${req?.phone||'Não cadastrado'}\n\n🛡️ **Hierarquia:** ${hasMil&&hasCiv?'Militar / Civil':hierarchy(type)?.label||'Não identificada'}\n🏛️ **Corporação / Unidade:** ${orgs}\n🎖️ **Patente atual:** ${rank?.name||'Não identificada'}\n📅 **Ingresso registrado:** ${req?.processedAt||req?.createdAt?new Date(req.processedAt||req.createdAt).toLocaleDateString('pt-BR'):'Não cadastrado'}\n📌 **Situação:** ${status}`); embed.setColor(type==='military'?0x0B5ED7:0x6F42C1);
  return {embeds:[embed],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`effective_member_page:${page}`).setLabel('Voltar à lista').setEmoji('↩️').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId(`effective_member_card:${userId}:${page}`).setLabel('Atualizar ficha').setEmoji('🔄').setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId('effective_home').setLabel('Início').setEmoji('🏠').setStyle(ButtonStyle.Secondary))]};
}

client.once('ready', async()=>{
  console.log(`Online como ${client.user.tag}`);
  const commands=[
    new SlashCommandBuilder().setName('painel-funcional').setDescription('Publica o painel de solicitação funcional').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
    new SlashCommandBuilder().setName('painel-comando').setDescription('Publica o painel de promoção e desligamento').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
    new SlashCommandBuilder().setName('painel-efetivo').setDescription('Publica o painel de consulta do efetivo').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
    new SlashCommandBuilder().setName('painel-suporte').setDescription('Publica a Central de Atendimento').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
  ].map(c=>c.toJSON());
  const rest=new REST({version:'10'}).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id,config.guildId),{body:commands});
  console.log('Comandos V2.3.5 registrados.');
  await ensureFixedPanels();
});

client.on('interactionCreate', async i=>{
 try{
  if(i.isChatInputCommand() && i.commandName==='painel-comando'){
    if(!isAdmin(i.member)) return i.reply({content:'❌ Sem permissão.',ephemeral:true});
    const ch=await client.channels.fetch(config.commandPanelChannelId).catch(()=>null);
    if(!ch?.isTextBased()) return i.reply({content:'❌ Canal do Painel de Comando inválido ou inacessível.',ephemeral:true});
    await ch.send(actionPanel());
    await i.reply({content:`✅ Painel de Comando publicado em ${ch}.`,ephemeral:true}); return;
  }
  if(i.isChatInputCommand() && i.commandName==='painel-funcional'){
    if(!isAdmin(i.member)) return i.reply({content:'❌ Sem permissão.',ephemeral:true});
    const ch=await client.channels.fetch(config.registrationChannelId).catch(()=>null);
    if(!ch?.isTextBased()) return i.reply({content:'❌ Canal da Central de Registro inválido ou inacessível.',ephemeral:true});
    await ch.send(registrationPanel());
    await i.reply({content:`✅ Central de Registro publicada em ${ch}.`,ephemeral:true}); return;
  }
  if(i.isChatInputCommand() && i.commandName==='painel-suporte'){
    if(!isAdmin(i.member)) return i.reply({content:'❌ Sem permissão.',ephemeral:true});
    const ch=await client.channels.fetch(config.supportPanelChannelId).catch(()=>null);
    if(!ch?.isTextBased()) return i.reply({content:'❌ Canal da Central de Atendimento inválido ou inacessível.',ephemeral:true});
    await ch.send(supportPanel());
    await i.reply({content:`✅ Central de Atendimento publicada em ${ch}.`,ephemeral:true}); return;
  }
  if(i.isButton() && i.customId.startsWith('ticket_open:')){
    const kind=i.customId.split(':')[1];
    if(!['support','absence','dismissal'].includes(kind)) return;
    await i.showModal(ticketModal(kind)); return;
  }
  if(i.isModalSubmit() && i.customId.startsWith('ticket_modal:')){
    const kind=i.customId.split(':')[1]; await createTicket(i,kind); return;
  }
  if(i.isButton() && i.customId==='ticket_claim'){
    if(!isCommander(i.member)) return i.reply({content:'❌ Apenas o Alto Comando pode assumir atendimentos.',ephemeral:true});
    await i.reply({content:`👤 Atendimento assumido por ${i.user}.`}); await sendLog(`👤 TICKET ASSUMIDO | ${i.channel} | ${i.user}`); return;
  }
  if(i.isButton() && i.customId==='ticket_close'){
    const owner=i.channel.topic?.match(/ticket-owner:(\d+)/)?.[1];
    if(i.user.id!==owner && !isCommander(i.member)) return i.reply({content:'❌ Você não pode fechar este ticket.',ephemeral:true});
    await i.reply('🔒 Ticket será fechado em 5 segundos.'); await sendLog(`🔒 TICKET FECHADO | ${i.channel.name} | ${i.user}`); setTimeout(()=>i.channel.delete().catch(()=>{}),5000); return;
  }
  if(i.isButton() && i.customId.startsWith('ticket_dismiss_approve:')){
    if(!isCommander(i.member)) return i.reply({content:'❌ Acesso restrito ao Alto Comando.',ephemeral:true});
    const userId=i.customId.split(':')[1]; const member=await i.guild.members.fetch(userId).catch(()=>null);
    if(!member) return i.reply({content:'❌ Membro não encontrado.',ephemeral:true});
    const orgs=Object.entries(config.organizations).filter(([,o])=>member.roles.cache.has(o.roleId));
    if(!orgs.length) return i.reply({content:'⚠️ O membro não possui cargo de corporação.',ephemeral:true});
    for(const [org,o] of orgs){ await member.roles.remove(o.roleId).catch(()=>{}); const h=hierarchy(o.type); if(h) for(const rid of Object.values(h.ranks)) if(member.roles.cache.has(rid)) await member.roles.remove(rid).catch(()=>{}); }
    await member.send('🚪 Sua solicitação de demissão foi aprovada. Seus cargos funcionais foram removidos.').catch(()=>{});
    await sendLog(`🚪 DEMISSÃO VIA TICKET APROVADA | ${member} | Corporações: ${orgs.map(([n])=>n).join(', ')} | Responsável: ${i.user}`);
    await i.reply({content:`✅ Demissão de ${member} aprovada. Cargos funcionais removidos.`}); return;
  }
  if(i.isChatInputCommand() && i.commandName==='painel-efetivo'){
    if(!isAdmin(i.member)) return i.reply({content:'❌ Sem permissão.',ephemeral:true});
    await i.reply(effectiveHomePanel()); return;
  }
  if(i.isButton() && i.customId==='effective_home'){
    await i.deferUpdate(); await i.editReply(effectiveHomePanel()); return;
  }
  if(i.isButton() && (i.customId.startsWith('effective_type:')||i.customId.startsWith('effective_refresh:'))){ const type=i.customId.split(':')[1]; await i.deferUpdate(); await i.editReply(await effectivePanel(i.guild,type)); return; }
  if(i.isButton() && i.customId==='effective_org_start'){ await i.deferUpdate(); await i.editReply(await effectiveOrgTypePanel()); return; }
  if(i.isButton() && i.customId.startsWith('effective_org_type:')){ const type=i.customId.split(':')[1]; await i.deferUpdate(); await i.editReply(effectiveOrgSelectPanel(type)); return; }
  if(i.isStringSelectMenu() && i.customId.startsWith('effective_org_select:')){ const type=i.customId.split(':')[1]; const org=i.values[0]; await i.deferUpdate(); await i.editReply(await effectiveOrgPanel(i.guild,type,org)); return; }
  if(i.isButton() && i.customId.startsWith('effective_org_refresh:')){ const [,type,org64]=i.customId.split(':'); await i.deferUpdate(); await i.editReply(await effectiveOrgPanel(i.guild,type,unb64(org64))); return; }
  if(i.isButton() && i.customId==='effective_member_start'){ await i.deferUpdate(); await i.editReply(await effectiveMemberSelectPanel(i.guild,0)); return; }
  if(i.isButton() && i.customId.startsWith('effective_member_page:')){ const page=Number(i.customId.split(':')[1]||0); await i.deferUpdate(); await i.editReply(await effectiveMemberSelectPanel(i.guild,page)); return; }
  if(i.isStringSelectMenu() && i.customId.startsWith('effective_member_select:')){ const page=Number(i.customId.split(':')[1]||0); await i.deferUpdate(); await i.editReply(await effectiveMemberCard(i.guild,i.values[0],page)); return; }
  if(i.isButton() && i.customId.startsWith('effective_member_card:')){ const [,userId,page]=i.customId.split(':'); await i.deferUpdate(); await i.editReply(await effectiveMemberCard(i.guild,userId,Number(page||0))); return; }
  if(i.isButton() && i.customId==='mgmt_home'){ if(!isCommander(i.member)) return i.reply({content:'❌ Sem permissão.',ephemeral:true}); await i.update(actionPanel()); return; }
  if(i.isButton() && i.customId.startsWith('mgmt_action:')){ if(!isCommander(i.member)) return i.reply({content:'❌ Acesso restrito ao Alto Comando.',ephemeral:true}); await i.update(typePanel(i.customId.split(':')[1])); return; }
  if(i.isButton() && i.customId.startsWith('mgmt_type:')){ if(!isCommander(i.member)) return i.reply({content:'❌ Acesso restrito ao Alto Comando.',ephemeral:true}); const [,action,type]=i.customId.split(':'); await i.update(orgPanel(action,type)); return; }
  if(i.isStringSelectMenu() && i.customId.startsWith('mgmt_org:')){ if(!isCommander(i.member)) return i.reply({content:'❌ Sem permissão.',ephemeral:true}); const [,action,type]=i.customId.split(':'); const org=i.values[0]; await i.update(await memberPanel(i.guild,action,type,org,0)); return; }
  if(i.isButton() && i.customId.startsWith('mgmt_page:')){ if(!isCommander(i.member)) return i.reply({content:'❌ Sem permissão.',ephemeral:true}); const [,action,type,org64,page]=i.customId.split(':'); await i.update(await memberPanel(i.guild,action,type,unb64(org64),Number(page))); return; }
  if(i.isStringSelectMenu() && i.customId.startsWith('mgmt_member:')){
    if(!isCommander(i.member)) return i.reply({content:'❌ Sem permissão.',ephemeral:true});
    const [,action,type,org64]=i.customId.split(':'); const org=unb64(org64); const member=await i.guild.members.fetch(i.values[0]);
    if(!member.roles.cache.has(config.organizations[org].roleId)) return i.reply({content:`❌ Esse membro não pertence mais a **${org}**.`,ephemeral:true});
    if(action==='promo'){ await i.update(rankPanel(member,type,org)); return; }
    if(action==='transfer'){
      const destinations=typeOrgs(type).filter(([name])=>name!==org);
      if(!destinations.length) return i.update({embeds:[baseEmbed('📭 TRANSFERÊNCIA INDISPONÍVEL',`Não existe outra corporação da estrutura **${type}** disponível para transferência.`)],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`mgmt_page:transfer:${type}:${b64(org)}:0`).setLabel('Voltar').setEmoji('↩️').setStyle(ButtonStyle.Secondary))]});
      const menu=new StringSelectMenuBuilder().setCustomId(`transfer_dest:${type}:${b64(org)}:${member.id}`).setPlaceholder('Selecione a corporação de destino').addOptions(destinations.map(([name])=>({label:name,value:name,description:`Transferir ${org} → ${name}`})));
      const cur=currentRank(member,type);
      const embed=baseEmbed('🔄 TRANSFERÊNCIA FUNCIONAL',`**Policial:** ${member}\n**Origem:** ${org}\n**Estrutura:** ${hierarchy(type)?.label||type}\n**Patente mantida:** ${cur?.name||'Não identificada'}\n\nSelecione a corporação de destino.\n\n⛔ Transferências entre Militar, Civil e Federal são bloqueadas.`);
      await i.update({embeds:[embed],components:[new ActionRowBuilder().addComponents(menu),new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`mgmt_page:transfer:${type}:${b64(org)}:0`).setLabel('Voltar').setEmoji('↩️').setStyle(ButtonStyle.Secondary))]}); return;
    }
    const cur=currentRank(member,type);
    const embed=baseEmbed('🚪 CONFIRMAR DESLIGAMENTO',`**Policial:** ${member}\n**Corporação:** ${org}\n**Hierarquia:** ${hierarchy(type).label}\n**Patente atual:** ${cur?.name||'Não identificada'}\n\nClique abaixo para informar o motivo obrigatório.`);
    const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`dismiss_reason:${type}:${b64(org)}:${member.id}`).setLabel('Informar motivo').setEmoji('📝').setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId(`mgmt_page:dismiss:${type}:${b64(org)}:0`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary));
    await i.update({embeds:[embed],components:[row]}); return;
  }
  if(i.isStringSelectMenu() && i.customId.startsWith('transfer_dest:')){
    if(!isCommander(i.member)) return i.reply({content:'❌ Sem permissão.',ephemeral:true});
    const [,type,org64,userId]=i.customId.split(':'); const origin=unb64(org64); const dest=i.values[0];
    const originCfg=config.organizations[origin], destCfg=config.organizations[dest];
    if(!originCfg||!destCfg) return i.reply({content:'❌ Corporação inválida.',ephemeral:true});
    if(originCfg.type!==destCfg.type || originCfg.type!==type) return i.reply({content:'⛔ Transferência bloqueada: só é permitido Militar → Militar, Civil → Civil e Federal → Federal.',ephemeral:true});
    const member=await i.guild.members.fetch(userId);
    if(!member.roles.cache.has(originCfg.roleId)) return i.reply({content:`❌ ${member} não pertence mais a **${origin}**.`,ephemeral:true});
    const cur=currentRank(member,type);
    const embed=baseEmbed('⚠️ CONFIRMAR TRANSFERÊNCIA',`**Policial:** ${member}\n**Origem:** ${origin}\n**Destino:** ${dest}\n**Estrutura:** ${hierarchy(type)?.label||type}\n**Patente mantida:** ${cur?.name||'Não identificada'}\n\nConfirme para trocar apenas o cargo da corporação.`);
    const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`confirm_transfer:${type}:${b64(origin)}:${b64(dest)}:${member.id}`).setLabel('CONFIRMAR TRANSFERÊNCIA').setEmoji('✅').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId(`mgmt_page:transfer:${type}:${b64(origin)}:0`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary));
    await i.update({embeds:[embed],components:[row]}); return;
  }
  if(i.isButton() && i.customId.startsWith('confirm_transfer:')){
    if(!isCommander(i.member)) return i.reply({content:'❌ Sem permissão.',ephemeral:true});
    const [,type,origin64,dest64,userId]=i.customId.split(':'); const origin=unb64(origin64), dest=unb64(dest64);
    const originCfg=config.organizations[origin], destCfg=config.organizations[dest];
    if(!originCfg||!destCfg || originCfg.type!==destCfg.type || originCfg.type!==type) return i.reply({content:'⛔ Transferência inválida ou entre estruturas diferentes.',ephemeral:true});
    const member=await i.guild.members.fetch(userId);
    if(!member.roles.cache.has(originCfg.roleId)) return i.reply({content:`❌ ${member} não pertence mais a **${origin}**.`,ephemeral:true});
    const cur=currentRank(member,type);
    const id=`tr_${Date.now()}_${member.id}`;
    requests[id]={kind:'transfer',status:'transfer_pending',userId:member.id,type,origin,dest,rank:cur?.name||null,requestedBy:i.user.id,createdAt:new Date().toISOString()}; save();
    const approvalCh=await client.channels.fetch(config.transferApprovalChannelId||config.requestChannelId).catch(()=>null);
    if(!approvalCh?.isTextBased()){ delete requests[id]; save(); return i.reply({content:'❌ Canal de aprovação de transferências inválido ou inacessível.',ephemeral:true}); }
    const colonelId=config.transferApproverRoleIds?.colonel||'1562501623954280489';
    const ltColonelId=config.transferApproverRoleIds?.lieutenantColonel||'1562502687382044682';
    const approvalEmbed=baseEmbed('🔄 SOLICITAÇÃO DE TRANSFERÊNCIA',`**Policial:** ${member}\n**Origem:** ${origin}\n**Destino:** ${dest}\n**Patente atual:** ${cur?.name||'Não identificada'}\n**Solicitado por:** ${i.user}\n\nA transferência só será executada após aprovação do comando da **${dest}**.`).setColor(0xF59E0B);
    const approvalRow=new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`transfer_approve:${id}`).setLabel('APROVAR TRANSFERÊNCIA').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`transfer_reject:${id}`).setLabel('RECUSAR TRANSFERÊNCIA').setEmoji('❌').setStyle(ButtonStyle.Danger)
    );
    await approvalCh.send({content:`📣 <@&${colonelId}> <@&${ltColonelId}> — aprovação necessária para transferência com destino **${dest}**.`,embeds:[approvalEmbed],components:[approvalRow],allowedMentions:{roles:[colonelId,ltColonelId]}});
    await member.send(`📨 Sua transferência **${origin} → ${dest}** foi enviada para aprovação do Coronel/Tenente-Coronel da corporação de destino. Nenhum cargo foi alterado ainda.`).catch(()=>{});
    await i.update({embeds:[baseEmbed('📨 TRANSFERÊNCIA ENVIADA PARA APROVAÇÃO',`${member} ainda permanece em **${origin}**.\n\nDestino solicitado: **${dest}**\nA alteração será feita somente após aprovação do comando da corporação de destino.`)],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('mgmt_home').setLabel('Nova operação').setEmoji('🏠').setStyle(ButtonStyle.Primary))]}); return;
  }
  if(i.isButton() && (i.customId.startsWith('transfer_approve:') || i.customId.startsWith('transfer_reject:'))){
    const approve=i.customId.startsWith('transfer_approve:'); const id=i.customId.split(':')[1]; const req=requests[id];
    if(!req || req.status!=='transfer_pending') return i.reply({content:'❌ Esta solicitação não está mais pendente.',ephemeral:true});
    const destCfg=config.organizations[req.dest]; const originCfg=config.organizations[req.origin];
    if(!destCfg||!originCfg) return i.reply({content:'❌ Configuração da corporação não encontrada.',ephemeral:true});
    const colonelId=config.transferApproverRoleIds?.colonel||'1562501623954280489';
    const ltColonelId=config.transferApproverRoleIds?.lieutenantColonel||'1562502687382044682';
    const hasCommandRank=i.member.roles.cache.has(colonelId)||i.member.roles.cache.has(ltColonelId);
    const belongsToDestination=i.member.roles.cache.has(destCfg.roleId);
    if(!isAdmin(i.member) && !(hasCommandRank && belongsToDestination)) return i.reply({content:`⛔ Somente **Coronel/Tenente-Coronel da ${req.dest}** pode decidir esta transferência.`,ephemeral:true});
    const member=await i.guild.members.fetch(req.userId).catch(()=>null);
    if(!member){ delete requests[id]; save(); return i.reply({content:'❌ Policial não encontrado no servidor.',ephemeral:true}); }
    if(!approve){
      delete requests[id]; save();
      await member.send(`❌ Sua solicitação de transferência **${req.origin} → ${req.dest}** foi recusada pelo comando da corporação de destino.`).catch(()=>{});
      await i.update({embeds:[baseEmbed('❌ TRANSFERÊNCIA RECUSADA',`Solicitação de ${member} para **${req.dest}** recusada por ${i.user}.`).setColor(0xDC2626)],components:[]}); return;
    }
    if(!member.roles.cache.has(originCfg.roleId)){ delete requests[id]; save(); return i.reply({content:`❌ ${member} não pertence mais a **${req.origin}**. A solicitação foi cancelada.`,ephemeral:true}); }
    if(originCfg.type!==destCfg.type || originCfg.type!==req.type) return i.reply({content:'⛔ Transferência bloqueada entre estruturas diferentes.',ephemeral:true});
    const cur=currentRank(member,req.type);
    await member.roles.remove(originCfg.roleId); await member.roles.add(destCfg.roleId);
    const current=latestApprovedRequest(member.id); if(current){ current.org=req.dest; current.position=cur?.name||current.position; current.processedAt=new Date().toISOString(); }
    delete requests[id]; save();
    await member.send(`✅ Sua transferência funcional foi aprovada pelo comando da corporação de destino.\n**Origem:** ${req.origin}\n**Destino:** ${req.dest}\n**Patente mantida:** ${cur?.name||req.rank||'Não identificada'}`).catch(()=>{});
    await sendLog(`🔄 TRANSFERÊNCIA APROVADA | ${member} | ${req.origin} → ${req.dest} | Patente mantida: ${cur?.name||req.rank||'Não identificada'} | Aprovador: ${i.user}`);
    await i.update({embeds:[baseEmbed('✅ TRANSFERÊNCIA APROVADA E APLICADA',`${member} foi transferido.\n\n**${req.origin} → ${req.dest}**\n**Patente mantida:** ${cur?.name||req.rank||'Não identificada'}\n**Aprovado por:** ${i.user}`).setColor(0x16A34A)],components:[]}); return;
  }
  if(i.isStringSelectMenu() && i.customId.startsWith('mgmt_rank:')){
    if(!isCommander(i.member)) return i.reply({content:'❌ Sem permissão.',ephemeral:true});
    const [,type,org64,userId]=i.customId.split(':'); const org=unb64(org64); const member=await i.guild.members.fetch(userId); const newRoleId=i.values[0];
    const rankEntry=Object.entries(hierarchy(type).ranks).find(([,id])=>id===newRoleId); if(!rankEntry) return i.reply({content:'❌ Patente inválida.',ephemeral:true});
    const cur=currentRank(member,type);
    const embed=baseEmbed('✅ CONFIRMAR PROMOÇÃO',`**Policial:** ${member}\n**Corporação:** ${org}\n**Hierarquia:** ${hierarchy(type).label}\n**Patente atual:** ${cur?.name||'Sem patente'}\n**Nova patente:** ${rankEntry[0]}\n\nConfirme para aplicar a alteração.`);
    const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`confirm_promo:${type}:${b64(org)}:${member.id}:${newRoleId}`).setLabel('Confirmar promoção').setEmoji('✅').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId(`mgmt_page:promo:${type}:${b64(org)}:0`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary));
    await i.update({embeds:[embed],components:[row]}); return;
  }
  if(i.isButton() && i.customId.startsWith('confirm_promo:')){
    if(!isCommander(i.member)) return i.reply({content:'❌ Sem permissão.',ephemeral:true});
    const [,type,org64,userId,newRoleId]=i.customId.split(':'); const org=unb64(org64); const member=await i.guild.members.fetch(userId);
    if(!member.roles.cache.has(config.organizations[org].roleId)) return i.reply({content:`❌ ${member} não pertence mais a **${org}**.`,ephemeral:true});
    const ranks=hierarchy(type).ranks; const target=Object.entries(ranks).find(([,id])=>id===newRoleId); if(!target) return i.reply({content:'❌ Patente inválida.',ephemeral:true});
    const old=currentRank(member,type);
    for(const rid of Object.values(ranks)) if(member.roles.cache.has(rid) && rid!==newRoleId) await member.roles.remove(rid);
    if(!member.roles.cache.has(newRoleId)) await member.roles.add(newRoleId);
    const dm=new EmbedBuilder().setTitle('🎉 PARABÉNS PELA PROMOÇÃO!').setDescription(`Você foi promovido no **Moema RP**.\n\n**Corporação:** ${org}\n**De:** ${old?.name||'Sem patente'}\n**Para:** ${target[0]}\n\nContinue honrando sua corporação!`).setImage(config.promotionGifUrl).setTimestamp();
    await member.send({embeds:[dm]}).catch(()=>{});
    await sendLog(`🎖️ PROMOÇÃO | ${member} | ${org} | ${old?.name||'Sem patente'} → ${target[0]} | Responsável: ${i.user}`);
    await i.update({embeds:[baseEmbed('🎖️ PROMOÇÃO CONCLUÍDA',`${member} foi promovido com sucesso.\n\n**${old?.name||'Sem patente'} → ${target[0]}**\n**Corporação:** ${org}`)],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('mgmt_home').setLabel('Nova operação').setEmoji('🏠').setStyle(ButtonStyle.Primary))]}); return;
  }
  if(i.isButton() && i.customId.startsWith('dismiss_reason:')){
    if(!isCommander(i.member)) return i.reply({content:'❌ Sem permissão.',ephemeral:true});
    const [,type,org64,userId]=i.customId.split(':');
    const modal=new ModalBuilder().setCustomId(`dismiss_modal:${type}:${org64}:${userId}`).setTitle('Motivo do desligamento');
    const reason=new TextInputBuilder().setCustomId('reason').setLabel('Motivo obrigatório').setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(reason)); await i.showModal(modal); return;
  }
  if(i.isModalSubmit() && i.customId.startsWith('dismiss_modal:')){
    if(!isCommander(i.member)) return i.reply({content:'❌ Sem permissão.',ephemeral:true});
    const [,type,org64,userId]=i.customId.split(':'); const org=unb64(org64); const member=await i.guild.members.fetch(userId); const reason=i.fields.getTextInputValue('reason').trim();
    if(!member.roles.cache.has(config.organizations[org].roleId)) return i.reply({content:`❌ ${member} não pertence mais a **${org}**.`,ephemeral:true});
    const old=currentRank(member,type);
    await member.roles.remove(config.organizations[org].roleId);
    for(const rid of Object.values(hierarchy(type).ranks)) if(member.roles.cache.has(rid)) await member.roles.remove(rid);
    const dm=new EmbedBuilder().setTitle('😔 DESLIGAMENTO FUNCIONAL').setDescription(`Sua funcional foi encerrada no **Moema RP**.\n\n**Corporação:** ${org}\n**Patente:** ${old?.name||'Não identificada'}\n**Motivo:** ${reason}`).setImage(config.dismissalGifUrl).setTimestamp();
    await member.send({embeds:[dm]}).catch(()=>{});
    await sendLog(`🚪 DESLIGAMENTO | ${member} | ${org} | ${old?.name||'Sem patente'} | Motivo: ${reason} | Responsável: ${i.user}`);
    await i.reply({embeds:[baseEmbed('🚪 DESLIGAMENTO CONCLUÍDO',`${member} foi desligado de **${org}**.\n\n**Patente removida:** ${old?.name||'Não identificada'}\n**Motivo:** ${reason}`)],ephemeral:true}); return;
  }

  // Solicitação funcional V1.9: painel visual -> tipo -> corporação -> dados -> confirmação.
  if(i.isButton() && i.customId==='request_start'){
    const embed=baseEmbed('🚔 SOLICITAÇÃO FUNCIONAL • ETAPA 1/4','## Selecione o tipo de força\n\n👮 **POLÍCIA MILITAR**\n`GCM • ROMU • PMESP • ROCAM • PMESP TOR • BAEP • BAEP-ROCAM • ROTA • CANIL • GRAER`\n\n**Cargo inicial:** Soldado 2ª Classe\n\n━━━━━━━━━━━━━━━━━━━━\n\n🕵️ **POLÍCIA CIVIL**\n`PCESP • DECAP • DEIC • DHPP • G.E.R • GARRA • COE`\n\n**Cargo inicial:** Acadepol');
    embed.setColor(0x1565C0);
    const row=new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('request_type:military').setLabel('POLÍCIA MILITAR').setEmoji('👮').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('request_type:civil').setLabel('POLÍCIA CIVIL').setEmoji('🕵️').setStyle(ButtonStyle.Danger)
    );
    await i.reply({embeds:[embed],components:[row],ephemeral:true}); return;
  }
  if(i.isButton() && i.customId.startsWith('request_type:')){
    const type=i.customId.split(':')[1]; const h=hierarchy(type);
    if(!h) return i.reply({content:'❌ Tipo de força inválido.',ephemeral:true});
    const initial=Object.keys(h.ranks)[0];
    const opts=typeOrgs(type).map(([name])=>({label:name,value:name,description:`${h.label} • Inicial: ${initial}`,emoji:h.emoji}));
    if(!opts.length) return i.update({embeds:[baseEmbed('📭 Nenhuma corporação','Não há corporações configuradas para esta hierarquia.')],components:[]});
    const menu=new StringSelectMenuBuilder().setCustomId(`request_org:${type}`).setPlaceholder(type==='military'?'👮 Selecione a corporação militar':'🕵️ Selecione a unidade da Polícia Civil').addOptions(opts.slice(0,25));
    const back=new ButtonBuilder().setCustomId('request_start_back').setLabel('VOLTAR').setEmoji('↩️').setStyle(ButtonStyle.Secondary);
    const embed=baseEmbed(`${h.emoji} ${h.label.toUpperCase()} • ETAPA 2/4`,`## Selecione a corporação / unidade\n\n**Hierarquia:** ${h.label}\n**Cargo inicial após aprovação:** **${initial}**\n\nEscolha abaixo onde deseja ingressar. Na próxima etapa serão solicitados **Nome, ID/Passaporte e Telefone**.`);
    embed.setColor(type==='military'?0x1565C0:0xB71C1C);
    await i.reply({embeds:[embed],components:[new ActionRowBuilder().addComponents(menu),new ActionRowBuilder().addComponents(back)],ephemeral:true}); return;
  }
  if(i.isButton() && i.customId==='request_start_back'){
    const embed=baseEmbed('🚔 SOLICITAÇÃO FUNCIONAL • ETAPA 1/4','## Selecione o tipo de força\n\n👮 **POLÍCIA MILITAR** — Soldado 2ª Classe\n🕵️ **POLÍCIA CIVIL** — Acadepol');
    embed.setColor(0x1565C0);
    const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('request_type:military').setLabel('POLÍCIA MILITAR').setEmoji('👮').setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId('request_type:civil').setLabel('POLÍCIA CIVIL').setEmoji('🕵️').setStyle(ButtonStyle.Danger));
    await i.update({embeds:[embed],components:[row]}); return;
  }
  if(i.isStringSelectMenu() && i.customId.startsWith('request_org:')){
    const type=i.customId.split(':')[1]; const org=i.values[0]; const orgCfg=config.organizations[org];
    if(!orgCfg || orgCfg.type!==type) return i.reply({content:'❌ Corporação inválida para a hierarquia selecionada.',ephemeral:true});
    const modal=new ModalBuilder().setCustomId(`request_modal:${b64(org)}`).setTitle(`Funcional • ${org} • Etapa 3/4`);
    const name=new TextInputBuilder().setCustomId('name').setLabel('Nome do personagem *').setPlaceholder('Digite o nome completo').setStyle(TextInputStyle.Short).setMinLength(2).setMaxLength(80).setRequired(true);
    const passport=new TextInputBuilder().setCustomId('passport').setLabel('ID / Passaporte *').setPlaceholder('Digite seu ID / Passaporte').setStyle(TextInputStyle.Short).setMinLength(1).setMaxLength(30).setRequired(true);
    const phone=new TextInputBuilder().setCustomId('phone').setLabel('Telefone *').setPlaceholder('Digite o telefone com DDD').setStyle(TextInputStyle.Short).setMinLength(5).setMaxLength(30).setRequired(true);
    modal.addComponents(...[name,passport,phone].map(x=>new ActionRowBuilder().addComponents(x))); await i.showModal(modal); return;
  }
  if(i.isModalSubmit() && i.customId.startsWith('request_modal:')){
    const org=unb64(i.customId.split(':')[1]); const orgCfg=config.organizations[org]; const h=hierarchy(orgCfg?.type); if(!orgCfg||!h) return i.reply({content:'❌ Corporação inválida.',ephemeral:true});
    const name=i.fields.getTextInputValue('name').trim();
    const passport=i.fields.getTextInputValue('passport').trim();
    const phone=i.fields.getTextInputValue('phone').trim();
    if(!name || !passport || !phone) return i.reply({content:'❌ **Nome, ID / Passaporte e Telefone são obrigatórios.**',ephemeral:true});
    const position=Object.keys(h.ranks)[0]; const draftId=`${i.user.id}-${Date.now()}`;
    requests[draftId]={userId:i.user.id,name,passport,phone,org,position,status:'draft',createdAt:new Date().toISOString()}; save();
    const embed=baseEmbed('✅ CONFIRME SUA SOLICITAÇÃO • ETAPA 4/4',`## Revise os dados antes de enviar\n\n${h.emoji} **Tipo:** ${h.label}\n🏛️ **Corporação / Unidade:** ${org}\n👤 **Personagem:** ${name}\n🪪 **ID / Passaporte:** ${passport}\n📱 **Telefone:** ${phone}\n\n━━━━━━━━━━━━━━━━━━━━\n🎓 **Cargo inicial após aprovação:** **${position}**\n\nAo confirmar, a solicitação será enviada para análise da administração.`);
    embed.setColor(0x198754);
    const row=new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`request_confirm:${b64(draftId)}`).setLabel('ENVIAR SOLICITAÇÃO').setEmoji('📨').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`request_cancel:${b64(draftId)}`).setLabel('CANCELAR').setEmoji('✖️').setStyle(ButtonStyle.Secondary)
    );
    await i.reply({embeds:[embed],components:[row],ephemeral:true}); return;
  }
  if(i.isButton() && i.customId.startsWith('request_cancel:')){
    const id=unb64(i.customId.slice(15)); const req=requests[id];
    if(req?.userId===i.user.id && req.status==='draft'){ delete requests[id]; save(); }
    await i.update({embeds:[baseEmbed('❌ SOLICITAÇÃO CANCELADA','Nenhuma solicitação foi enviada. Você pode iniciar novamente pelo painel funcional.')],components:[]}); return;
  }
  if(i.isButton() && i.customId.startsWith('request_confirm:')){
    const id=unb64(i.customId.slice(16)); const req=requests[id];
    if(!req || req.userId!==i.user.id || req.status!=='draft') return i.reply({content:'⚠️ Esta solicitação não está mais disponível.',ephemeral:true});
    if(!req.name?.trim() || !req.passport?.trim() || !req.phone?.trim()) return i.reply({content:'❌ Nome, ID / Passaporte e Telefone são obrigatórios.',ephemeral:true});
    const orgCfg=config.organizations[req.org]; const h=hierarchy(orgCfg?.type); if(!orgCfg||!h) return i.reply({content:'❌ Corporação inválida.',ephemeral:true});
    req.status='pending'; save();
    const adminEmbed=baseEmbed('📥 NOVA SOLICITAÇÃO FUNCIONAL',`${h.emoji} **Tipo:** ${h.label}\n🏛️ **Corporação / Unidade:** ${req.org}\n👤 **Solicitante:** <@${req.userId}>\n📝 **Personagem:** ${req.name}\n🪪 **ID / Passaporte:** ${req.passport}\n📱 **Telefone:** ${req.phone}\n🎓 **Cargo inicial:** **${req.position}**\n\n**Status:** ⏳ Aguardando análise`);
    adminEmbed.setColor(0xF0AD4E);
    const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`req_approve:${b64(id)}`).setLabel('APROVAR').setEmoji('✅').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId(`req_reject:${b64(id)}`).setLabel('RECUSAR').setEmoji('❌').setStyle(ButtonStyle.Danger));
    const ch=await client.channels.fetch(config.requestChannelId).catch(()=>null);
    if(!ch?.isTextBased()){ req.status='draft'; save(); return i.reply({content:'❌ Canal de solicitações inválido ou inacessível.',ephemeral:true}); }
    await ch.send({embeds:[adminEmbed],components:[row]});
    const sent=baseEmbed('✅ SOLICITAÇÃO ENVIADA COM SUCESSO',`Sua solicitação foi registrada e encaminhada para análise.\n\n${h.emoji} **Tipo:** ${h.label}\n🏛️ **Corporação / Unidade:** ${req.org}\n🎓 **Cargo inicial se aprovado:** **${req.position}**\n🪪 **ID:** ${req.passport}\n📱 **Telefone:** ${req.phone}\n\nVocê receberá o resultado pelo Discord quando a solicitação for analisada.`); sent.setColor(0x198754);
    await i.update({embeds:[sent],components:[]}); return;
  }
  if(i.isButton() && i.customId.startsWith('req_approve:')){
    if(!isAdmin(i.member)) return i.reply({content:'❌ Sem permissão.',ephemeral:true}); const id=unb64(i.customId.slice(12)); const req=requests[id]; if(!req||req.status!=='pending') return i.reply({content:'⚠️ Solicitação já processada.',ephemeral:true});
    if(!req.passport?.trim() || !req.phone?.trim()) return i.reply({content:'⛔ **Aprovação bloqueada.** Esta solicitação não possui **ID / Passaporte e Telefone** preenchidos. Peça ao membro para fazer uma nova solicitação.',ephemeral:true});
    const member=await i.guild.members.fetch(req.userId); const orgCfg=config.organizations[req.org]; const h=hierarchy(orgCfg.type); await member.roles.add(orgCfg.roleId); await member.roles.add(h.ranks[req.position]); let nicknameStatus='ok'; const desiredNick=`${req.name} | ${req.passport}`.slice(0,32); try{ await member.setNickname(desiredNick, 'Funcional aprovada SSP Moema RP'); }catch(e){ nicknameStatus='falhou'; console.error('Falha ao alterar apelido:',e.message); } req.status='approved'; req.nickname=desiredNick; req.nicknameStatus=nicknameStatus; req.processedBy=i.user.id; req.processedAt=new Date().toISOString(); for(const [rid,r] of Object.entries(requests)){ if(rid!==id && r.userId===req.userId && ['approved','rejected','transferred'].includes(r.status)) delete requests[rid]; } save();
    await i.update({content:`✅ APROVADO por ${i.user}`,embeds:i.message.embeds,components:[]}); await member.send(`✅ Sua funcional foi aprovada.\n**Corporação:** ${req.org}\n**Patente:** ${req.position}`).catch(()=>{}); await sendLog(`✅ FUNCIONAL APROVADA | ${member} | ${req.org} | ${req.position} | Nome: ${req.name} | ID: ${req.passport} | Apelido: ${req.nicknameStatus==='ok'?'alterado':'NÃO alterado'} | Admin: ${i.user}`); await refreshEffectivePanels(i.guild); return;
  }
  if(i.isButton() && i.customId.startsWith('req_reject:')){
    if(!isAdmin(i.member)) return i.reply({content:'❌ Sem permissão.',ephemeral:true}); const id=unb64(i.customId.slice(11)); const req=requests[id]; if(!req||req.status!=='pending') return i.reply({content:'⚠️ Solicitação já processada.',ephemeral:true}); delete requests[id]; save(); await i.update({content:`❌ RECUSADO por ${i.user}`,embeds:i.message.embeds,components:[]}); await sendLog(`❌ FUNCIONAL RECUSADA | <@${req.userId}> | ${req.org} | Admin: ${i.user}`); return;
  }
 }catch(e){
  console.error('ERRO V2.3.5:',e);
  const msg='❌ Ocorreu um erro. Confira o console, IDs, permissões e a posição do cargo do bot na hierarquia.';
  if(i.isRepliable()){ if(i.replied||i.deferred) await i.followUp({content:msg,ephemeral:true}).catch(()=>{}); else await i.reply({content:msg,ephemeral:true}).catch(()=>{}); }
 }
});

if(!process.env.DISCORD_TOKEN) throw new Error('Defina DISCORD_TOKEN no .env ou nas Variables da hospedagem');
client.login(process.env.DISCORD_TOKEN);
