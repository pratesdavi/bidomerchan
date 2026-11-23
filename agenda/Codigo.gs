/**
 * Catupiry · Agenda Semanal (Supervisores e Líderes)
 * Web app (Google Apps Script) para montar a agenda da semana e gerar
 * o arquivo de importação de roteiros do Smart.
 *
 * Abas usadas na planilha:
 *  - Base        : base de lojas colada como vem (aba DASHBOARD, colunas B a I: ATENDIMENTO, SUPERVISOR MERCHANDISING,
 *                  LÍDER, PROMOTOR, CodigoCliente, Bandeira, LOJA, Longradouro, Bairro, LOJA PERFEITA ( ATUAL ))
 *                  A carteira de cada pessoa sai daqui: o supervisor vê as lojas em que é supervisor,
 *                  o líder vê as lojas em que é líder.
 *  - Abrangência : lojas EXTRAS que alguém pode visitar além da própria equipe (ex.: supervisor que também
 *                  apoia lojas de terceiros). Só vale para quem tiver linha aqui — as demais pessoas não mudam.
 *  - Acessos     : quem pode entrar (Email, Nome igual ao da Base, Perfil, CodigoUsuario do Smart, Senha, Ativo)
 *  - Agenda      : agenda atual de cada usuário, gravada pela página (não editar à mão)
 *  - Histórico   : cópia de cada semana fechada (menu > Arquivar semana)
 *  - Roteiros    : gerada pelo menu, igual ao template de importação do Smart
 *  - Conferência : gerada pelo menu, cruza os nomes da Base com a aba Acessos
 */

const CFG = {
  ABA_BASE: 'Base',
  ABA_ACESSOS: 'Acessos',
  ABA_AGENDA: 'Agenda',
  ABA_HIST: 'Histórico',
  ABA_SMART: 'Roteiros',
  ABA_CONF: 'Conferência',
  ABA_ABR: 'Abrangência',
  MAX_TENTATIVAS: 5,   // tentativas de login erradas antes de bloquear
  BLOQUEIO_SEG: 600,   // 10 minutos
  FUSO: 'America/Sao_Paulo',
  DIA_ABERTURA: 4,     // 4 = quinta: envios a partir de quinta contam para a semana seguinte
  SUPERVISOR_VE_TODAS: true,   // supervisor enxerga todas as lojas da Base (a carteira dele continua sendo o padrão na tela)
  ABA_MANUAL: 'Base Manual',   // lojas que não vêm do banco (HOME OFFICE, ESCRITÓRIO...): somadas à Base a cada atualização
  ABA_SQL: 'Consulta Banco',   // a consulta SQL fica na célula A2 desta aba
  ABA_LOG: 'Log Banco',
  ABA_HIER: 'Hierarquia',      // Promotor → Supervisor/Líder (o banco não tem essa ligação); criada a partir da Base atual
  ABA_AFAST: 'Afastamentos',      // afastamentos lançados pela página (separado da agenda, para lançar no Smart à mão)
  ABA_TIPOS: 'Tipos Afastamento', // lista de tipos + se é elegível ao abono (pode vir do banco)
  AFAST_DIAS_ATRAS: 30,           // até quantos dias para trás pode lançar
  AFAST_DIAS_FRENTE: 60           // até quantos dias para frente
};

/** Nomes aceitos para cada coluna da Base (sem acento, maiúsculo; a leitura ignora acentos, espaços e "?"). */
const COLS = {
  codigo:      ['CODIGOCLIENTE', 'CODIGO CLIENTE', 'COD CLIENTE', 'CODIGO DO CLIENTE', 'CODIGO LOJA', 'COD LOJA', 'CODIGO'],
  atendimento: ['ATENDIMENTO'],
  promotor:    ['PROMOTOR', 'ROTA', 'ROTA PROMOTOR'],
  lider:       ['LIDER'],
  supervisor:  ['SUPERVISOR MERCHANDISING', 'SUPERVISOR'],
  bandeira:    ['BANDEIRA', 'REDE'],
  loja:        ['LOJA', 'NOME LOJA'],
  logradouro:  ['LOGRADOURO', 'LONGRADOURO', 'ENDERECO'],
  numero:      ['NUMERO'],
  bairro:      ['BAIRRO'],
  cidade:      ['CIDADE', 'MUNICIPIO'],
  uf:          ['UF', 'ESTADO'],
  lp:          ['LOJA PERFEITA', 'LOJA PERFEITA ATUAL', 'LP'],
  regional:    ['REGIONAL', 'GERENTE REGIONAL', 'GER REGIONAL']
};
/** Colunas da Base que não aparecem na página. Qualquer outra coluna nova aparece como informação extra da loja. */
const IGNORAR = ['ENVIAR', 'SUGESTAO INSIRA X', 'SUGESTAO', 'SINALIZADOR', 'IND'];

const DIAS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

const CAB_ACESSOS = ['Email', 'Nome', 'Perfil', 'CodigoUsuario', 'Senha', 'Ativo'];
const CAB_ABR     = ['Nome', 'IncluirPor', 'Valor', 'Atendimento', 'Ativo'];
const TIPOS_ABR   = ['SUPERVISOR', 'PROMOTOR', 'LOJA', 'BANDEIRA'];
const CAB_AGENDA  = ['DataHora', 'CodigoUsuario', 'Nome', 'CodigoCliente', 'Loja'].concat(DIAS);
const CAB_HIST    = ['Semana'].concat(CAB_AGENDA);
// Cabeçalho exato do template-importacao-roteiros do Smart
const CAB_SMART   = ['Código Cliente', 'Código do Usuário', 'Semana'].concat(DIAS);
const SEM_COD     = 'SEM-COD|';
const CAB_AFAST   = ['Registro', 'Data', 'CodigoUsuario', 'Nome', 'Perfil', 'Tipo', 'Periodo', 'ElegivelAbono', 'Observacao', 'Status'];
const CAB_TIPOS   = ['Tipo', 'ElegivelAbono', 'MeioPeriodo', 'Ativo'];
const PERIODOS    = ['Dia inteiro', 'Manhã', 'Tarde'];
// Status na aba Afastamentos: o líder lança como PENDENTE; quem sobe no Smart troca para LANÇADO.
// Se o líder apagar um afastamento já LANÇADO, a linha fica como CANCELADO (para desfazer no Smart).
const ST_PEND = 'PENDENTE', ST_LANC = 'LANÇADO', ST_CANC = 'CANCELADO';

/* ============================ Página ============================ */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Catupiry · Agenda Semanal')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL); // permite abrir dentro da moldura (Netlify)
}

/* ============================ API (página hospedada no GitHub Pages) ============================
 * A página do GitHub envia POST com o corpo {"fn": "nomeDaFuncao", "args": [email, senha, ...]}.
 * Só as funções desta lista podem ser chamadas. Todas conferem e-mail e código no servidor.
 * Implantação: Implantar > Gerenciar implantações > editar > Executar como "Eu" e Acesso "Qualquer pessoa".
 */
const API_PUBLICA = ['carregarDados', 'carregarEquipe', 'salvarAgenda', 'salvarDia', 'salvarAfastamento', 'removerAfastamento'];

function doPost(e) {
  let saida;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const fn = String(req.fn || '');
    if (API_PUBLICA.indexOf(fn) < 0) throw new Error('Função não permitida: ' + fn);
    const args = Array.isArray(req.args) ? req.args : [];
    saida = { ok: true, r: globalThis[fn].apply(null, args) };
  } catch (err) {
    saida = { ok: false, erro: String(err && err.message ? err.message : err) };
  }
  return ContentService.createTextOutput(JSON.stringify(saida)).setMimeType(ContentService.MimeType.JSON);
}

/* ============================ Menu ============================ */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Agenda Smart')
    .addItem('1. Criar estrutura (abas e exemplo)', 'criarEstrutura')
    .addItem('2. Gerar arquivo de Roteiros (Smart)', 'gerarRoteiros')
    .addItem('3. Arquivar semana no Histórico', 'arquivarSemana')
    .addSeparator()
    .addItem('Ver quem ainda não enviou nesta semana', 'pendentes')
    .addItem('Conferir nomes da Base x Acessos', 'conferirNomes')
    .addItem('Organizar colunas da aba Base', 'organizarBase')
    .addItem('Afastamentos: criar abas', 'criarAbasAfastamento')
    .addSeparator()
    .addItem('Banco: testar conexão', 'testarBanco')
    .addItem('Banco: atualizar a Base agora', 'atualizarBaseDoBanco')
    .addItem('Banco: agendar atualização diária', 'agendarAtualizacaoBanco')
    .addToUi();
}

/* ============================ Chamadas da página ============================ */

/** Login + devolve só a carteira (pela hierarquia da Base) e a agenda do usuário autenticado. */
function carregarDados(email, senha) {
  const u = autenticar_(email, senha);
  const base = lerBase_();
  const lojas = carteiraDo_(u.nome, base, u.perfil);
  if (!lojas.length) {
    throw new Error('Nenhuma loja encontrada para "' + u.nome + '" na Base. ' +
      'O nome na aba Acessos precisa ser igual ao da coluna de Supervisor ou Líder.');
  }

  const linhas = lerTabela_(CFG.ABA_AGENDA).filter(r => norm_(r.CodigoUsuario) === norm_(u.usuario));
  const agenda = {};
  let ultima = null;
  linhas.forEach(r => {
    const dias = [];
    DIAS.forEach((d, i) => { if (marcado_(r[d])) dias.push(i); });
    if (dias.length) agenda[String(r.CodigoCliente).trim()] = dias;
    if (r.DataHora instanceof Date && (!ultima || r.DataHora > ultima)) ultima = r.DataHora;
  });

  return {
    nome: u.nome,
    usuario: u.usuario,
    perfil: u.perfil,
    lojas: lojas,
    agenda: agenda,
    dias: DIAS,
    semanaInicio: proximaSegunda_(),
    ultimaAtualizacao: ultima ? Utilities.formatDate(ultima, CFG.FUSO, 'dd/MM/yyyy HH:mm') : '',
    equipe: equipeDo_(u, base),
    tiposAfast: tiposAfastamento_(),
    periodos: PERIODOS,
    afastamentos: afastamentosDe_([u.usuario])[norm_(u.usuario)] || [],
    afastLimites: { atras: CFG.AFAST_DIAS_ATRAS, frente: CFG.AFAST_DIAS_FRENTE }
  };
}

/** Atualiza só o quadro do time (botão ↻ da página). */
function carregarEquipe(email, senha) {
  const u = autenticar_(email, senha);
  return equipeDo_(u, lerBase_());
}

/**
 * Time do supervisor: líderes que aparecem na Base nas lojas em que ele é o supervisor.
 * Para cada líder: se já enviou a agenda (desde a última quinta), quando, e as lojas/dias escolhidos.
 * Devolve null para quem não tem líderes abaixo (ex.: o próprio líder).
 */
function equipeDo_(u, base) {
  const k = chave_(u.nome);
  const lideres = new Map();
  base.forEach(l => {
    if (chave_(l.supervisor) !== k) return;
    const lk = chave_(l.lider);
    if (!lk || lk === k) return;
    if (!lideres.has(lk)) lideres.set(lk, { nome: String(l.lider).trim(), lojas: 0, lp: 0 });
    const x = lideres.get(lk); x.lojas++; if (l.lp) x.lp++;
  });
  if (!lideres.size) return null;

  const acessos = new Map();
  lerTabela_(CFG.ABA_ACESSOS).forEach(a => { const ak = chave_(a.Nome); if (ak && !acessos.has(ak)) acessos.set(ak, a); });
  const agenda = lerTabela_(CFG.ABA_AGENDA);
  const porChave = new Map(base.map(l => [l.chave, l]));
  const ini = inicioJanela_();
  const f = d => Utilities.formatDate(d, CFG.FUSO, 'dd/MM/yyyy HH:mm');

  const usuarios = [...lideres.keys()].map(lk => acessos.get(lk)).filter(Boolean).map(a => String(a.CodigoUsuario || '').trim());
  const afast = afastamentosDe_(usuarios);
  const lista = [...lideres.entries()].map(([lk, L]) => {
    const a = acessos.get(lk);
    const usu = a ? String(a.CodigoUsuario || '').trim() : '';
    const linhas = usu ? agenda.filter(r => norm_(r.CodigoUsuario) === norm_(usu)) : [];
    let ultima = null;
    const porDia = DIAS.map(() => 0);
    const lojas = [];
    linhas.forEach(r => {
      if (r.DataHora instanceof Date && (!ultima || r.DataHora > ultima)) ultima = r.DataHora;
      const dias = [];
      DIAS.forEach((d, i) => { if (marcado_(r[d])) { dias.push(i); porDia[i]++; } });
      if (!dias.length) return;
      const ch = String(r.CodigoCliente).trim(), b = porChave.get(ch);
      lojas.push({ chave: ch, loja: b ? b.loja : String(r.Loja || ch), promotor: b ? b.promotor : '', bairro: b ? b.bairro : '',
                   lp: b ? b.lp : false, atendimento: b ? b.atendimento : '', agencia: b ? b.agencia : '', dias: dias });
    });
    return {
      nome: L.nome, temAcesso: !!a, ativo: a ? ativo_(a) : false, usuario: usu,
      enviou: !!(ultima && ultima >= ini), ultima: ultima ? f(ultima) : '',
      lojasCarteira: L.lojas, lpCarteira: L.lp,
      lojasAgenda: lojas.length, visitas: porDia.reduce((s, n) => s + n, 0), lpAgenda: lojas.filter(x => x.lp).length,
      porDia: porDia, lojas: lojas, afastamentos: usu ? (afast[norm_(usu)] || []) : []
    };
  }).sort((a, b) => (a.enviou - b.enviou) || a.nome.localeCompare(b.nome, 'pt-BR'));

  return {
    desde: Utilities.formatDate(ini, CFG.FUSO, 'dd/MM'),
    atualizado: f(new Date()),
    enviaram: lista.filter(x => x.enviou).length,
    total: lista.length,
    lideres: lista
  };
}

/** Início da janela de envio: a última quinta-feira (hoje, se hoje for quinta), 00:00 em São Paulo. */
function inicioJanela_() {
  const agora = new Date();
  const dow = Number(Utilities.formatDate(agora, CFG.FUSO, 'u')) % 7; // 0 = domingo ... 6 = sábado
  const volta = (dow - CFG.DIA_ABERTURA + 7) % 7;
  const p = Utilities.formatDate(new Date(agora.getTime() - volta * 86400000), CFG.FUSO, 'yyyy-MM-dd').split('-').map(Number);
  const iso = p[0] + '-' + String(p[1]).padStart(2, '0') + '-' + String(p[2]).padStart(2, '0') + 'T00:00:00';
  const off = Utilities.formatDate(agora, CFG.FUSO, 'XXX'); // ex.: -03:00
  return new Date(iso + (off === 'Z' ? 'Z' : off));
}

/**
 * Grava a agenda do usuário (substitui a anterior dele).
 * agenda = { "CHAVE_DA_LOJA": [0, 3], ... }  (0 = Segunda ... 5 = Sábado)
 */
function salvarAgenda(email, senha, agenda) {
  const u = autenticar_(email, senha);
  const mapa = new Map(carteiraDo_(u.nome, null, u.perfil).map(l => [l.chave, l]));
  agenda = agenda || {};

  const novas = [];
  const agora = new Date();
  Object.keys(agenda).forEach(k => {
    const c = String(k).trim();
    if (!mapa.has(c)) throw new Error('Uma das lojas marcadas não está mais na sua carteira. Recarregue a página.');
    const dias = (agenda[k] || []).map(Number).filter(i => i >= 0 && i < DIAS.length);
    if (!dias.length) return;
    const l = mapa.get(c);
    novas.push([agora, u.usuario, u.nome, l.chave, l.loja]
      .concat(DIAS.map((d, i) => dias.indexOf(i) >= 0 ? 'X' : '')));
  });
  if (!novas.length) throw new Error('Marque pelo menos uma visita antes de salvar.');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const aba = aba_(CFG.ABA_AGENDA);
    const n = CAB_AGENDA.length;
    const ult = aba.getLastRow();
    const atuais = ult > 1 ? aba.getRange(2, 1, ult - 1, n).getValues() : [];
    const iUsu = CAB_AGENDA.indexOf('CodigoUsuario');
    const manter = atuais.filter(l => l.some(c => c !== '') && norm_(l[iUsu]) !== norm_(u.usuario));
    const todas = manter.concat(novas);

    if (ult > 1) aba.getRange(2, 1, ult - 1, n).clearContent();
    aba.getRange(2, 4, todas.length, 1).setNumberFormat('@'); // código do cliente como texto
    aba.getRange(2, 1, todas.length, n).setValues(todas);
  } finally {
    lock.releaseLock();
  }

  const visitas = novas.reduce((s, l) => s + l.slice(5).filter(x => x === 'X').length, 0);
  return {
    lojas: novas.length,
    visitas: visitas,
    quando: Utilities.formatDate(agora, CFG.FUSO, 'dd/MM/yyyy HH:mm')
  };
}

/**
 * Salva só um dia da agenda (0 = Segunda ... 5 = Sábado), sem mexer nos outros dias já enviados.
 * chaves = lojas que ficam marcadas nesse dia (pode ser vazio: o dia fica sem visitas).
 * Devolve a agenda inteira gravada, para a página saber o que ainda falta salvar.
 */
function salvarDia(email, senha, dia, chaves) {
  const u = autenticar_(email, senha);
  dia = Number(dia);
  if (!(dia >= 0 && dia < DIAS.length)) throw new Error('Dia inválido.');
  const mapa = new Map(carteiraDo_(u.nome, null, u.perfil).map(l => [l.chave, l]));
  const marcar = new Set((chaves || []).map(c => String(c).trim()));
  marcar.forEach(c => { if (!mapa.has(c)) throw new Error('Uma das lojas marcadas não está mais na sua carteira. Recarregue a página.'); });

  const agora = new Date();
  const n = CAB_AGENDA.length, iUsu = CAB_AGENDA.indexOf('CodigoUsuario'), iCod = CAB_AGENDA.indexOf('CodigoCliente');
  const col = CAB_AGENDA.indexOf(DIAS[dia]);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let minhas;
  try {
    const aba = aba_(CFG.ABA_AGENDA);
    const ult = aba.getLastRow();
    const atuais = ult > 1 ? aba.getRange(2, 1, ult - 1, n).getValues() : [];
    const outras = atuais.filter(l => l.some(c => c !== '') && norm_(l[iUsu]) !== norm_(u.usuario));
    minhas = atuais.filter(l => l.some(c => c !== '') && norm_(l[iUsu]) === norm_(u.usuario));
    const vistas = new Set();
    minhas.forEach(l => {
      const c = String(l[iCod]).trim();
      vistas.add(c);
      l[col] = marcar.has(c) ? 'X' : '';
      l[0] = agora;
    });
    marcar.forEach(c => {
      if (vistas.has(c)) return;
      const lj = mapa.get(c);
      minhas.push([agora, u.usuario, u.nome, lj.chave, lj.loja].concat(DIAS.map((d, i) => i === dia ? 'X' : '')));
    });
    minhas = minhas.filter(l => DIAS.some((d, i) => marcado_(l[5 + i])));
    const todas = outras.concat(minhas);
    if (ult > 1) aba.getRange(2, 1, ult - 1, n).clearContent();
    if (todas.length) {
      aba.getRange(2, 4, todas.length, 1).setNumberFormat('@');
      aba.getRange(2, 1, todas.length, n).setValues(todas);
    }
  } finally {
    lock.releaseLock();
  }
  const agenda = {};
  minhas.forEach(l => {
    const ds = []; DIAS.forEach((d, i) => { if (marcado_(l[5 + i])) ds.push(i); });
    if (ds.length) agenda[String(l[iCod]).trim()] = ds;
  });
  return {
    dia: dia, visitasDia: marcar.size, agenda: agenda,
    quando: Utilities.formatDate(agora, CFG.FUSO, 'dd/MM/yyyy HH:mm')
  };
}

/* ============================ Afastamentos ============================ */

/** Cria as abas Afastamentos e Tipos Afastamento (se não existirem). */
function criarAbasAfastamento() {
  garanteAbasAfast_();
  try { SpreadsheetApp.getActive().toast('Abas de afastamento prontas. Ajuste os tipos na aba "' + CFG.ABA_TIPOS + '".', 'Agenda Smart', 6); } catch (e) {}
}

function garanteAbasAfast_() {
  const ss = SpreadsheetApp.getActive();
  if (!ss.getSheetByName(CFG.ABA_TIPOS)) {
    prepara_(CFG.ABA_TIPOS, CAB_TIPOS, [
      ['Day off (folga com desconto em banco de horas, aprovado pelo gestor)', 'NÃO', 'NÃO', 'SIM'],
      ['Reunião de liderança', 'SIM', 'SIM', 'SIM']
    ]);
  }
  if (!ss.getSheetByName(CFG.ABA_AFAST)) {
    prepara_(CFG.ABA_AFAST, CAB_AFAST, []);
    const a = aba_(CFG.ABA_AFAST);
    a.getRange(2, 2, a.getMaxRows() - 1, 1).setNumberFormat('dd/MM/yyyy');
    a.getRange(2, 10, a.getMaxRows() - 1, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList([ST_PEND, ST_LANC, ST_CANC], true).build());
  }
}

/** Tipos ativos: [{tipo, elegivel, meio}] */
function tiposAfastamento_() {
  garanteAbasAfast_();
  return lerTabela_(CFG.ABA_TIPOS).filter(ativo_).map(t => ({
    tipo: String(t.Tipo || '').trim(),
    elegivel: simNao_(t.ElegivelAbono),
    meio: simNao_(t.MeioPeriodo) === 'SIM'
  })).filter(t => t.tipo);
}

function simNao_(v) {
  const s = normCab_(v);
  if (s === 'SIM' || s === 'S' || s === 'TRUE' || s === 'VERDADEIRO' || s === '1') return 'SIM';
  if (s === 'NAO' || s === 'N' || s === 'FALSE' || s === 'FALSO' || s === '0') return 'NÃO';
  return s ? String(v).trim() : '';
}

function dataIso_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, CFG.FUSO, 'yyyy-MM-dd');
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  return '';
}

/** Afastamentos (não cancelados) dos usuários, de 35 dias atrás em diante: { usuario: [{data, tipo, periodo, elegivel, obs, status}] } */
function afastamentosDe_(usuarios) {
  garanteAbasAfast_();
  const quer = new Set((usuarios || []).map(norm_).filter(Boolean));
  const out = {};
  if (!quer.size) return out;
  const corte = Utilities.formatDate(new Date(Date.now() - (CFG.AFAST_DIAS_ATRAS + 5) * 86400000), CFG.FUSO, 'yyyy-MM-dd');
  lerTabela_(CFG.ABA_AFAST).forEach(r => {
    const k = norm_(r.CodigoUsuario);
    if (!quer.has(k)) return;
    const st = normCab_(r.Status);
    if (st === 'CANCELADO') return;
    const d = dataIso_(r.Data);
    if (!d || d < corte) return;
    (out[k] = out[k] || []).push({
      data: d, tipo: String(r.Tipo || ''), periodo: String(r.Periodo || 'Dia inteiro'),
      elegivel: simNao_(r.ElegivelAbono), obs: String(r.Observacao || ''), status: String(r.Status || ST_PEND)
    });
  });
  Object.keys(out).forEach(k => out[k].sort((a, b) => a.data.localeCompare(b.data)));
  return out;
}

/**
 * Lança (ou troca) um afastamento do próprio usuário. data = 'yyyy-MM-dd'.
 * "Dia inteiro" substitui manhã/tarde da mesma data; manhã ou tarde substitui o dia inteiro.
 */
function salvarAfastamento(email, senha, data, tipo, periodo, obs) {
  const u = autenticar_(email, senha);
  data = dataIso_(data);
  if (!data) throw new Error('Data inválida.');
  const hoje = Utilities.formatDate(new Date(), CFG.FUSO, 'yyyy-MM-dd');
  const dif = Math.round((new Date(data + 'T12:00:00Z') - new Date(hoje + 'T12:00:00Z')) / 86400000);
  if (dif < -CFG.AFAST_DIAS_ATRAS) throw new Error('Só dá para lançar afastamentos dos últimos ' + CFG.AFAST_DIAS_ATRAS + ' dias.');
  if (dif > CFG.AFAST_DIAS_FRENTE) throw new Error('Só dá para lançar afastamentos até ' + CFG.AFAST_DIAS_FRENTE + ' dias à frente.');
  const t = tiposAfastamento_().find(x => normCab_(x.tipo) === normCab_(tipo));
  if (!t) throw new Error('Tipo de afastamento não encontrado. Recarregue a página.');
  periodo = PERIODOS.find(p => normCab_(p) === normCab_(periodo)) || 'Dia inteiro';
  if (periodo !== 'Dia inteiro' && !t.meio) periodo = 'Dia inteiro';
  obs = String(obs || '').trim().slice(0, 300);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    cancelaAfast_(u.usuario, data, periodo);
    const a = aba_(CFG.ABA_AFAST);
    const lin = a.getLastRow() + 1;
    a.getRange(lin, 1, 1, CAB_AFAST.length).setValues([[
      new Date(), new Date(data + 'T12:00:00'), u.usuario, u.nome, u.perfil, t.tipo, periodo, t.elegivel, obs, ST_PEND
    ]]);
    a.getRange(lin, 2).setNumberFormat('dd/MM/yyyy');
  } finally {
    lock.releaseLock();
  }
  return afastamentosDe_([u.usuario])[norm_(u.usuario)] || [];
}

/** Remove os afastamentos do usuário naquela data (periodo vazio = todos da data). */
function removerAfastamento(email, senha, data, periodo) {
  const u = autenticar_(email, senha);
  data = dataIso_(data);
  if (!data) throw new Error('Data inválida.');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { cancelaAfast_(u.usuario, data, String(periodo || ''), true); }
  finally { lock.releaseLock(); }
  return afastamentosDe_([u.usuario])[norm_(u.usuario)] || [];
}

/**
 * Tira da aba os afastamentos do usuário na data que conflitam com "periodo"
 * (Dia inteiro conflita com tudo; Manhã/Tarde conflitam com o mesmo período e com Dia inteiro; '' = todos;
 * exato = só o mesmo período).
 * Pendentes são apagados; já lançados no Smart viram CANCELADO para alguém desfazer lá.
 */
function cancelaAfast_(usuario, data, periodo, exato) {
  const a = aba_(CFG.ABA_AFAST);
  const ult = a.getLastRow();
  if (ult < 2) return;
  const v = a.getRange(2, 1, ult - 1, CAB_AFAST.length).getValues();
  const iD = 1, iU = 2, iP = 6, iS = 9;
  const apagar = [];
  v.forEach((l, i) => {
    if (norm_(l[iU]) !== norm_(usuario) || dataIso_(l[iD]) !== data) return;
    const st = normCab_(l[iS]);
    if (st === 'CANCELADO') return;
    const p = String(l[iP] || 'Dia inteiro');
    const conflita = !periodo || normCab_(p) === normCab_(periodo) ||
      (!exato && (periodo === 'Dia inteiro' || p === 'Dia inteiro'));
    if (!conflita) return;
    if (st === 'LANCADO') a.getRange(i + 2, iS + 1).setValue(ST_CANC);
    else apagar.push(i + 2);
  });
  apagar.sort((x, y) => y - x).forEach(r => a.deleteRow(r));
}

/* ============================ Rotinas do menu ============================ */

/**
 * Monta a aba Roteiros no layout do Smart e cria um arquivo separado só com ela,
 * com link direto para baixar em .xlsx. Lojas sem Código Cliente ficam de fora e são avisadas.
 */
function gerarRoteiros() {
  const ui = SpreadsheetApp.getUi();
  const ativos = new Set(lerTabela_(CFG.ABA_ACESSOS).filter(ativo_).map(a => norm_(a.CodigoUsuario)));
  const semCodigo = [];
  const linhas = [];

  lerTabela_(CFG.ABA_AGENDA)
    .filter(r => ativos.has(norm_(r.CodigoUsuario)))
    .forEach(r => {
      const dias = DIAS.map(d => marcado_(r[d]) ? 'X' : '');
      if (!dias.some(x => x === 'X')) return;
      const cod = String(r.CodigoCliente).trim();
      if (!cod || cod.indexOf(SEM_COD) === 0) { semCodigo.push(r.Loja + ' (' + r.Nome + ')'); return; }
      linhas.push([cod, String(r.CodigoUsuario).trim(), ''].concat(dias));
    });

  if (!linhas.length) {
    ui.alert(semCodigo.length
      ? 'Nenhuma linha gerada: as lojas agendadas estão sem Código Cliente na Base.\n\nInclua a coluna "CÓDIGO CLIENTE" na aba Base.'
      : 'A aba Agenda está vazia. Nenhum roteiro para gerar.');
    return;
  }

  // 1) Aba Roteiros dentro do arquivo mãe (para conferência)
  escreveRoteiros_(aba_(CFG.ABA_SMART, true), linhas);

  // 2) Arquivo separado, só com a aba Roteiros, pronto para importar
  const nome = 'Roteiros Smart - ' + Utilities.formatDate(new Date(), CFG.FUSO, 'dd-MM-yyyy HH\'h\'mm');
  const novo = SpreadsheetApp.create(nome);
  escreveRoteiros_(novo.getSheets()[0].setName(CFG.ABA_SMART), linhas);
  SpreadsheetApp.flush();

  const url = 'https://docs.google.com/spreadsheets/d/' + novo.getId() + '/export?format=xlsx';
  const usuarios = new Set(linhas.map(l => l[1])).size;
  const aviso = semCodigo.length
    ? '<p style="color:#b01e2e;font-size:12px"><b>' + semCodigo.length + ' loja(s) ficaram de fora por não ter Código Cliente:</b><br>' +
      semCodigo.slice(0, 8).map(esc_).join('<br>') + (semCodigo.length > 8 ? '<br>...' : '') + '</p>'
    : '';
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">' +
    '<p><b>' + linhas.length + '</b> linhas de roteiro de <b>' + usuarios + '</b> usuário(s).</p>' +
    '<p><a href="' + url + '" target="_blank" style="display:inline-block;background:#9a0019;color:#fff;' +
    'padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:bold">Baixar .xlsx para o Smart</a></p>' +
    aviso +
    '<p style="color:#666;font-size:12px">O arquivo "' + esc_(nome) + '" também ficou salvo no seu Google Drive.</p></div>'
  ).setWidth(420).setHeight(semCodigo.length ? 340 : 200);
  ui.showModalDialog(html, 'Roteiros gerados');
}

/** Copia a agenda atual para o Histórico, com a data da segunda-feira da semana. Não apaga a Agenda. */
function arquivarSemana() {
  const ui = SpreadsheetApp.getUi();
  const linhas = lerTabela_(CFG.ABA_AGENDA);
  if (!linhas.length) { ui.alert('A aba Agenda está vazia.'); return; }

  const semana = Utilities.formatDate(segundaDaSemana_(), CFG.FUSO, 'dd/MM/yyyy');
  const ok = ui.alert('Arquivar semana', 'Copiar ' + linhas.length + ' linhas para o Histórico como semana de ' +
    semana + '?', ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;

  const hist = aba_(CFG.ABA_HIST, true);
  if (hist.getLastRow() === 0) prepara_(CFG.ABA_HIST, CAB_HIST, []);
  const valores = linhas.map(r => [semana].concat(CAB_AGENDA.map(h => r[h] === undefined ? '' : r[h])));
  const ini = hist.getLastRow() + 1;
  hist.getRange(ini, 5, valores.length, 1).setNumberFormat('@');
  hist.getRange(ini, 1, valores.length, CAB_HIST.length).setValues(valores);
  SpreadsheetApp.getActive().toast(valores.length + ' linhas arquivadas.', 'Agenda Smart', 5);
}

/** Lista usuários ativos que ainda não salvaram a agenda desde segunda-feira. */
function pendentes() {
  const seg = segundaDaSemana_();
  const enviaram = new Set(lerTabela_(CFG.ABA_AGENDA)
    .filter(r => r.DataHora instanceof Date && r.DataHora >= seg)
    .map(r => norm_(r.CodigoUsuario)));
  const faltam = lerTabela_(CFG.ABA_ACESSOS)
    .filter(a => ativo_(a) && !enviaram.has(norm_(a.CodigoUsuario)))
    .map(a => '• ' + a.Nome + (a.Perfil ? ' (' + a.Perfil + ')' : ''));
  SpreadsheetApp.getUi().alert(faltam.length
    ? 'Ainda não enviaram nesta semana:\n\n' + faltam.join('\n')
    : 'Todos já enviaram a agenda desta semana.');
}

/**
 * Cria a aba Conferência com todos os supervisores e líderes da Base,
 * quantas lojas cada um tem e se já existe acesso cadastrado com o mesmo nome.
 */
function conferirNomes() {
  const base = lerBase_();
  const acessos = new Map(lerTabela_(CFG.ABA_ACESSOS).map(a => [chave_(a.Nome), a]));
  const cont = new Map();
  base.forEach(l => {
    [['Supervisor', l.supervisor], ['Líder', l.lider]].forEach(([f, n]) => {
      const k = chave_(n);
      if (!k) return;
      const id = f + '|' + k;
      if (!cont.has(id)) cont.set(id, { funcao: f, nome: String(n).trim(), lojas: 0, lp: 0, semCod: 0 });
      const c = cont.get(id);
      c.lojas++; if (l.lp) c.lp++; if (!l.cod) c.semCod++;
    });
  });

  const linhas = [...cont.values()]
    .sort((a, b) => a.funcao.localeCompare(b.funcao) || b.lojas - a.lojas)
    .map(c => {
      const a = acessos.get(chave_(c.nome));
      return [c.funcao, c.nome, c.lojas, c.lp, c.semCod, a ? 'SIM' : 'NÃO', a ? String(a.CodigoUsuario || '') : ''];
    });

  const cab = ['Função', 'Nome na Base', 'Lojas', 'Lojas Perfeitas', 'Lojas sem Código Cliente', 'Tem acesso?', 'CodigoUsuario'];
  const aba = aba_(CFG.ABA_CONF, true);
  aba.clear();
  aba.getRange(1, 1, 1, cab.length).setValues([cab]).setFontWeight('bold')
    .setBackground('#9a0019').setFontColor('#ffffff');
  aba.setFrozenRows(1);
  if (linhas.length) aba.getRange(2, 1, linhas.length, cab.length).setValues(linhas);
  aba.autoResizeColumns(1, cab.length);
  SpreadsheetApp.getActive().setActiveSheet(aba);
  const sem = linhas.filter(l => l[5] === 'NÃO').length;
  SpreadsheetApp.getActive().toast(linhas.length + ' nomes na Base, ' + sem + ' sem acesso cadastrado.', 'Agenda Smart', 6);
}

/** Cria as abas com cabeçalho e dados de exemplo (só preenche abas vazias). */
function criarEstrutura() {
  // Mesmo formato da aba DASHBOARD, com CodigoCliente e Bandeira antes da LOJA
  const cabBase = ['ATENDIMENTO', 'SUPERVISOR MERCHANDISING', 'LÍDER', 'PROMOTOR', 'CodigoCliente', 'Bandeira',
                   'LOJA', 'Longradouro', 'Bairro', 'LOJA PERFEITA ( ATUAL )'];
  const S = 'SUPERVISOR TESTE', L = 'LIDER TESTE', LP = 'Loja Perfeita', NLP = 'Não é Loja Perfeita';
  prepara_(CFG.ABA_BASE, cabBase, [
    ['DIRETO', S, L, 'PROMOTOR A', 'PDV-001', 'CARREFOUR', 'CARREFOUR - TAMBORE', 'AV. MARCOS PENTEADO, 1000, BARUERI - SP', 'TAMBORÉ', LP],
    ['DIRETO', S, L, 'PROMOTOR A', 'PDV-002', 'GPA', 'PÃO DE AÇÚCAR - ALPHAVILLE', 'AL. RIO NEGRO, 500, BARUERI - SP', 'ALPHAVILLE', NLP],
    ['DIRETO', S, '-', 'PROMOTOR B', 'PDV-003', 'ASSAI', 'ASSAI - OSASCO', 'AV. DOS AUTONOMISTAS, 1400, OSASCO - SP', 'CENTRO', LP],
    ['SPOT PROMO', S, '-', 'PROMOTOR C', 'PDV-004', 'ATACADAO', 'ATACADAO - COTIA', 'ROD. RAPOSO TAVARES, KM 23, COTIA - SP', 'GRANJA VIANA', LP],
    ['SPOT PROMO', S, '-', 'PROMOTOR C', 'PDV-005', 'SONDA', 'SONDA - SANTANA', 'AV. CRUZEIRO DO SUL, 2000, SÃO PAULO - SP', 'SANTANA', NLP],
    ['DINAMICA', S, '-', 'PROMOTOR D', 'PDV-006', 'TENDA', 'TENDA - GUARULHOS', 'AV. TIRADENTES, 800, GUARULHOS - SP', 'CENTRO', NLP]
  ], 5);
  prepara_(CFG.ABA_ACESSOS, CAB_ACESSOS, [
    ['supervisor.teste@catupiry.com.br', S, 'Supervisor', 'supervisor.sp', '1234', 'SIM'],
    ['lider.teste@catupiry.com.br', L, 'Líder', 'lider.sp', '4321', 'SIM']
  ]);
  prepara_(CFG.ABA_AGENDA, CAB_AGENDA, []);
  prepara_(CFG.ABA_ABR, CAB_ABR, [
    [S, 'SUPERVISOR', '( Ger. Regional ) Amilton P.', 'TERCEIROS', 'SIM']
  ]);
  validacoesAbrangencia_();
  SpreadsheetApp.getActive().toast('Estrutura pronta. Cole sua base na aba Base.', 'Agenda Smart', 6);
}

/** Ordem padrão das colunas da aba Base. */
const ORDEM_BASE = [
  ['atendimento', 'ATENDIMENTO'],
  ['supervisor',  'SUPERVISOR MERCHANDISING'],
  ['lider',       'LÍDER'],
  ['promotor',    'PROMOTOR'],
  ['codigo',      'CodigoCliente'],
  ['bandeira',    'Bandeira'],
  ['loja',        'LOJA'],
  ['logradouro',  'Longradouro'],
  ['bairro',      'Bairro'],
  ['lp',          'LOJA PERFEITA ( ATUAL )']
];

/**
 * Reescreve a aba Base na ordem padrão (ORDEM_BASE). Colunas que faltam são criadas vazias;
 * outras colunas que existirem vão para o fim. Linhas em branco acima do cabeçalho são removidas.
 */
function organizarBase() {
  const ui = SpreadsheetApp.getUi();
  const aba = aba_(CFG.ABA_BASE);
  const v = aba.getDataRange().getValues();
  let ini = -1;
  for (let i = 0; i < Math.min(10, v.length); i++) {
    const c = v[i].map(normCab_);
    if (c.indexOf('LOJA') >= 0 && c.indexOf('PROMOTOR') >= 0) { ini = i; break; }
  }
  if (ini < 0) { ui.alert('Não encontrei o cabeçalho na aba Base (precisa ter LOJA e PROMOTOR).'); return; }

  const cabOrig = v[ini].map(h => String(h).trim());
  const cab = cabOrig.map(normCab_);
  const achar = k => { for (const n of COLS[k]) { const i = cab.indexOf(n); if (i >= 0) return i; } return -1; };
  const pos = ORDEM_BASE.map(([k]) => achar(k));
  const usados = new Set(pos.filter(i => i >= 0));
  const resto = cab.map((h, i) => i).filter(i => cab[i] && !usados.has(i));

  const novoCab = ORDEM_BASE.map(o => o[1]).concat(resto.map(i => cabOrig[i]));
  const dados = v.slice(ini + 1)
    .filter(l => l.some(c => c !== ''))
    .map(l => pos.map(i => i >= 0 ? l[i] : '').concat(resto.map(i => l[i])));

  const faltando = ORDEM_BASE.filter((o, j) => pos[j] < 0).map(o => o[1]);
  const ok = ui.alert('Organizar aba Base',
    dados.length + ' lojas serão reorganizadas na ordem padrão.' +
    (faltando.length ? '\n\nColunas que não existem e serão criadas vazias: ' + faltando.join(', ') : '') +
    '\n\nContinuar?', ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;

  aba.clear();
  aba.getRange(1, 1, 1, novoCab.length).setValues([novoCab]).setFontWeight('bold')
    .setBackground('#9a0019').setFontColor('#ffffff');
  aba.setFrozenRows(1);
  if (dados.length) {
    aba.getRange(2, 5, dados.length, 1).setNumberFormat('@'); // CodigoCliente como texto
    aba.getRange(2, 1, dados.length, novoCab.length).setValues(dados);
  }
  aba.autoResizeColumns(1, novoCab.length);
  SpreadsheetApp.getActive().setActiveSheet(aba);
  SpreadsheetApp.getActive().toast('Aba Base organizada.', 'Agenda Smart', 5);
}

/* ============================ Base de lojas ============================ */

/** Lê a aba Base aceitando o formato colado (cabeçalho em qualquer uma das 10 primeiras linhas). */
function lerBase_() {
  const v = aba_(CFG.ABA_BASE).getDataRange().getDisplayValues();
  let ini = -1;
  for (let i = 0; i < Math.min(10, v.length); i++) {
    const cab = v[i].map(normCab_);
    if (cab.indexOf('LOJA') >= 0 && cab.indexOf('PROMOTOR') >= 0) { ini = i; break; }
  }
  if (ini < 0) throw new Error('Não encontrei o cabeçalho na aba Base (precisa ter as colunas LOJA e PROMOTOR).');

  const cabOrig = v[ini].map(h => String(h).trim());
  const cab = cabOrig.map(normCab_);
  const idx = {};
  Object.keys(COLS).forEach(k => {
    idx[k] = -1;
    for (const nome of COLS[k]) { const i = cab.indexOf(nome); if (i >= 0) { idx[k] = i; break; } }
  });
  const usados = new Set(Object.values(idx).filter(i => i >= 0));
  const ignorar = new Set(IGNORAR.map(normCab_));
  const extras = cab.map((h, i) => i).filter(i => cab[i] && !usados.has(i) && !ignorar.has(cab[i]));

  const pega = (l, k) => idx[k] >= 0 ? String(l[idx[k]] || '').trim() : '';
  return v.slice(ini + 1).map(l => {
    const loja = pega(l, 'loja');
    if (!loja) return null;
    const cod = pega(l, 'codigo');
    const at = normCab_(pega(l, 'atendimento'));
    let atendimento = 'TERCEIROS';
    if (at === 'DIRETO' || at === 'DIRETOS') atendimento = 'DIRETO';
    else if (at === 'SPOT PROMO') atendimento = 'SPOT PROMO';
    const lpTxt = normCab_(pega(l, 'lp'));
    return {
      chave: cod || (SEM_COD + loja),
      cod: cod,
      loja: loja,
      bandeira: pega(l, 'bandeira'),
      logradouro: pega(l, 'logradouro'),
      numero: pega(l, 'numero'),
      bairro: pega(l, 'bairro'),
      cidade: pega(l, 'cidade'),
      uf: pega(l, 'uf'),
      regional: pega(l, 'regional').replace(/^-$/, ''),
      promotor: limpaNome_(pega(l, 'promotor')),
      lider: pega(l, 'lider'),
      supervisor: pega(l, 'supervisor'),
      atendimento: atendimento,
      agencia: (atendimento === 'TERCEIROS' && at !== 'TERCEIROS' && at !== '') ? pega(l, 'atendimento') : '',
      lp: ['SIM', 'S', 'X', 'LOJA PERFEITA', 'TRUE', 'VERDADEIRO', '1'].indexOf(lpTxt) >= 0,
      extras: extras.map(i => ({ k: cabOrig[i], v: String(l[i] || '').trim() })).filter(e => e.v && e.v !== '-')
    };
  }).filter(Boolean);
}

/**
 * Carteira = lojas da equipe (onde a pessoa é Supervisor ou Líder na Base)
 *          + lojas extras liberadas para ela na aba Abrangência (origem "apoio").
 * Supervisor (com CFG.SUPERVISOR_VE_TODAS) recebe também todas as outras lojas da Base (origem "rede"),
 * para poder visitar loja compartilhada ou de outra carteira quando precisar.
 */
function ehSupervisor_(perfil) { return normCab_(perfil).indexOf('SUPERVISOR') >= 0; }
function carteiraDo_(nome, baseJaLida, perfil) {
  const k = chave_(nome);
  const base = baseJaLida || lerBase_();
  const regras = regrasDe_(k);
  const todas = CFG.SUPERVISOR_VE_TODAS && ehSupervisor_(perfil);
  const prio = { equipe: 0, apoio: 1, rede: 2 };
  const cand = [];
  base.forEach((l, i) => {
    let origem = '';
    if (chave_(l.supervisor) === k || chave_(l.lider) === k) origem = 'equipe';
    else if (regras.length && regras.some(r => casaRegra_(r, l))) origem = 'apoio';
    else if (todas) origem = 'rede';
    if (origem) cand.push({ l: l, origem: origem, i: i });
  });
  // a mesma loja pode aparecer em mais de uma linha (ex.: HOME OFFICE de cada supervisor): vale a da própria carteira
  cand.sort((a, b) => prio[a.origem] - prio[b.origem] || a.i - b.i);
  const vistos = new Set();
  const out = [];
  cand.forEach(c => {
    const l = c.l;
    if (vistos.has(l.chave)) return;
    vistos.add(l.chave);
    const lider = chave_(l.lider) ? String(l.lider).trim() : '';
    const o = Object.assign({}, l, { origem: c.origem, lider: lider });
    if (c.origem === 'equipe' && !todas) delete o.supervisor;
    out.push(o);
  });
  return out;
}

/** Regras ativas da aba Abrangência para a pessoa (vazio se a aba não existir). */
function regrasDe_(k) {
  let linhas = [];
  try { linhas = lerTabela_(CFG.ABA_ABR); } catch (e) { return []; }
  return linhas
    .filter(r => chave_(r.Nome) === k && ativo_(r))
    .map(r => ({
      tipo: normCab_(r.IncluirPor),
      valorTxt: String(r.Valor || '').trim(),
      valor: chave_(r.Valor),
      todos: ['*', 'TODOS', 'TODAS'].indexOf(String(r.Valor || '').trim().toUpperCase()) >= 0,
      atend: normCab_(r.Atendimento)
    }))
    .filter(r => r.todos || r.valor);
}

/** A loja entra pela regra? (tipo + valor, e filtro opcional de atendimento) */
function casaRegra_(r, l) {
  if (r.atend && r.atend !== 'TODOS') {
    const okAt = normCab_(l.atendimento) === r.atend || (l.agencia && normCab_(l.agencia) === r.atend);
    if (!okAt) return false;
  }
  if (r.todos) return true;
  switch (r.tipo) {
    case 'SUPERVISOR':
    case 'LIDER':      return chave_(l.supervisor) === r.valor || chave_(l.lider) === r.valor;
    case 'PROMOTOR':
    case 'ROTA':       return chave_(l.promotor) === r.valor;
    case 'LOJA':
    case 'CODIGO':     return (l.cod && l.cod === r.valorTxt) || chave_(l.loja) === r.valor;
    case 'BANDEIRA':   return chave_(l.bandeira) === r.valor;
    default:           return false;
  }
}

/** Listas suspensas nas colunas IncluirPor, Atendimento e Ativo da aba Abrangência. */
function validacoesAbrangencia_() {
  const a = aba_(CFG.ABA_ABR, true);
  const lista = v => SpreadsheetApp.newDataValidation().requireValueInList(v, true).setAllowInvalid(false).build();
  a.getRange(2, 2, 999, 1).setDataValidation(lista(TIPOS_ABR));
  a.getRange(2, 4, 999, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['TERCEIROS', 'DIRETO', 'SPOT PROMO', 'TODOS'], true).setAllowInvalid(true).build());
  a.getRange(2, 5, 999, 1).setDataValidation(lista(['SIM', 'NÃO']));
}

/* ============================ Auxiliares ============================ */

function escreveRoteiros_(aba, linhas) {
  aba.clear();
  aba.getRange(1, 1, 1, CAB_SMART.length).setValues([CAB_SMART]).setFontWeight('bold');
  aba.getRange(2, 1, linhas.length, 2).setNumberFormat('@'); // mantém zeros à esquerda nos códigos
  aba.getRange(2, 1, linhas.length, CAB_SMART.length).setValues(linhas);
  aba.autoResizeColumns(1, CAB_SMART.length);
}

function autenticar_(email, senha) {
  email = norm_(email);
  senha = String(senha || '').trim();
  if (!email || !senha) throw new Error('Informe e-mail e código.');

  const cache = CacheService.getScriptCache();
  const chave = 'tent_' + Utilities.base64EncodeWebSafe(email).slice(0, 200);
  const tent = Number(cache.get(chave) || 0);
  if (tent >= CFG.MAX_TENTATIVAS) throw new Error('Muitas tentativas. Aguarde 10 minutos.');

  const u = lerTabela_(CFG.ABA_ACESSOS).find(a =>
    norm_(a.Email) === email && String(a.Senha).trim() === senha && ativo_(a));

  if (!u) {
    cache.put(chave, String(tent + 1), CFG.BLOQUEIO_SEG);
    throw new Error('E-mail ou código inválido.');
  }
  cache.remove(chave);
  const usuario = String(u.CodigoUsuario || '').trim();
  if (!usuario) throw new Error('Seu acesso está sem Código do Usuário. Fale com o Merchandising.');
  return { email: email, nome: String(u.Nome || '').trim(), usuario: usuario, perfil: String(u.Perfil || '') };
}

function lerTabela_(nome) {
  const v = aba_(nome).getDataRange().getValues();
  if (v.length < 2) return [];
  const cab = v[0].map(h => String(h).trim());
  return v.slice(1)
    .filter(l => l.some(c => c !== ''))
    .map(l => { const o = {}; cab.forEach((h, i) => o[h] = l[i]); return o; });
}

function aba_(nome, criar) {
  const ss = SpreadsheetApp.getActive();
  let a = ss.getSheetByName(nome);
  if (!a && criar) a = ss.insertSheet(nome);
  if (!a) throw new Error('Aba "' + nome + '" não encontrada. Rode o menu Agenda Smart > Criar estrutura.');
  return a;
}

/** Cria cabeçalho e exemplo numa aba vazia. colTexto = coluna a formatar como texto (códigos). */
function prepara_(nome, cab, exemplo, colTexto) {
  const a = aba_(nome, true);
  if (a.getLastRow() > 0) return;
  a.getRange(1, 1, 1, cab.length).setValues([cab]).setFontWeight('bold')
    .setBackground('#9a0019').setFontColor('#ffffff');
  a.setFrozenRows(1);
  if (exemplo.length) {
    if (colTexto) a.getRange(2, colTexto, exemplo.length, 1).setNumberFormat('@');
    a.getRange(2, 1, exemplo.length, cab.length).setValues(exemplo);
  }
  a.autoResizeColumns(1, cab.length);
}

/** Segunda-feira da próxima semana (yyyy-MM-dd), no fuso de São Paulo. Se hoje é segunda, devolve a da semana que vem. */
function proximaSegunda_() {
  const agora = new Date();
  const dow = Number(Utilities.formatDate(agora, CFG.FUSO, 'u')); // 1 = segunda ... 7 = domingo
  const alvo = new Date(agora.getTime() + (8 - dow) * 86400000);
  return Utilities.formatDate(alvo, CFG.FUSO, 'yyyy-MM-dd');
}

function segundaDaSemana_() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

/** Normaliza cabeçalho/texto: sem acento, maiúsculo, só letras, números e espaço. */
function normCab_(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Chave para comparar nomes de pessoas ("-" e vazio = ninguém). */
function chave_(s) {
  const k = normCab_(s);
  return k === '' ? '' : k;
}

function limpaNome_(s) {
  s = String(s || '').trim();
  return (s === '-' || s === '') ? 'SEM PROMOTOR' : s;
}

function marcado_(v) {
  return String(v || '').trim().toUpperCase() === 'X';
}

function ativo_(a) {
  const s = String(a.Ativo || 'SIM').trim().toUpperCase();
  return s !== 'NAO' && s !== 'NÃO' && s !== 'N';
}

function norm_(s) {
  return String(s || '').trim().toLowerCase();
}

function esc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/* ======================= Atualização automática da Base pelo banco (PostgreSQL) =======================
 * Como funciona: a consulta SQL (aba "Consulta Banco", célula A2) roda direto no banco do Smart e reescreve a aba Base.
 * As linhas da aba "Base Manual" (HOME OFFICE, ESCRITÓRIO, lojas fora do sistema) são somadas no fim a cada atualização.
 *
 * Configuração (uma vez):
 *  1. Apps Script > Configurações do projeto (engrenagem) > Propriedades do script > adicionar:
 *       DB_URL   = jdbc:postgresql://SERVIDOR:5432/NOME_DO_BANCO?ssl=true      (porta explícita; ssl=true se o banco exigir)
 *       DB_USER  = usuário só de leitura
 *       DB_SENHA = senha desse usuário
 *     (credenciais ficam fora do código e fora da planilha)
 *  2. O banco precisa aceitar conexão dos IPs do Google Apps Script (lista oficial no guia "JDBC" do Apps Script),
 *     em porta 1025 ou maior e com TLS 1.2+.
 *  3. Menu Agenda Smart > Banco: testar conexão. Depois: Banco: atualizar a Base agora. Depois: Banco: agendar atualização diária.
 *
 * A consulta precisa devolver as colunas com estes nomes (use AS "..."): ATENDIMENTO, SUPERVISOR MERCHANDISING, LÍDER,
 * PROMOTOR, CÓDIGO CLIENTE, BANDEIRA, LOJA, LOGRADOURO, BAIRRO, CIDADE, UF, LOJA PERFEITA?
 * Colunas a mais aparecem na página como informação extra da loja.
 */
const SQL_MODELO = "-- =====================================================================\n-- Base da Agenda: todas as lojas ativas (dClients) + roteiro atual\n-- (supervisor / líder / promotor do Smart) + regional do gerente comercial.\n-- Uma linha por loja e promotor. Loja sem rota: 1 linha, promotor \"-\",\n-- supervisor = \"( Ger. Regional ) Nome S.\" do gerente comercial.\n-- =====================================================================\nWITH\n\n-- ===== DE-PARA GERENTE -> REGIONAL (único lugar para manter) =====\nmap_regional (codigo_usuario, regional) AS (\n    VALUES\n        ('amilton.prado',      'REG. CENO'),\n        ('elaine.silva',       'REG. SP'),\n        ('leandro.casagrande', 'REG. KAN'),\n        ('mailson.auad',       'REG. LESTE'),\n        ('mauricio.carneiro',  'REG. SUL'),\n        ('natan.marcelino',    'REG. NE')\n),\n\n-- ===== LOJAS EXCLUÍDAS MANUALMENTE =====\nexcluidos (id) AS (\n    VALUES\n        ('019d9328-c9d9-730d-a8df-1861a0243666'),\n        ('019d9328-ca40-7777-a60f-b6ca5612675b'),\n        ('019d9329-c640-72ac-97f7-6fe4f56c8e3f'),\n        ('019d9328-c9cf-7320-b28d-78b7b525685a')\n),\n\n-- ===== GERENTES COMERCIAIS =====\ngerentes AS (\n    SELECT\n        u.id::text                 AS id,\n        upper(trim(u.name))        AS nome,\n        m.regional\n    FROM public.users u\n    JOIN public.roles r       ON r.id = u.role_id AND r.tag = 'commercial_manager'\n    LEFT JOIN map_regional m  ON m.codigo_usuario = lower(trim(u.code))\n    WHERE u.deleted_at IS NULL\n),\n\n-- ===== ROTEIRO ATUAL: loja -> promotor, líder, supervisor =====\nroteiro AS (\n    SELECT DISTINCT\n        rp.client_id::text                                                        AS client_id,\n        COALESCE(sd.\"name\", sl.\"name\")                                            AS supervisor,\n        COALESCE(CASE WHEN pr.tag = 'leadPromoters' THEN p.\"name\" END, ld.\"name\") AS lider,\n        p.\"name\"                                                                  AS promotor\n    FROM public.route_plannings AS rp\n    JOIN public.routes          AS r  ON r.id = rp.route_id\n    JOIN public.users           AS p  ON p.id = r.user_id AND p.deleted_at IS NULL\n    LEFT JOIN public.roles      AS pr ON pr.id = p.role_id\n    LEFT JOIN LATERAL (   -- líder do promotor\n        SELECT hu.id, hu.\"name\" FROM public.relationships rl\n        JOIN public.users hu ON hu.id = rl.higher_id\n        JOIN public.roles hr ON hr.id = hu.role_id\n        WHERE rl.user_id = p.id AND hr.tag = 'leadPromoters'\n        ORDER BY (hu.deleted_at IS NULL) DESC LIMIT 1) ld ON true\n    LEFT JOIN LATERAL (   -- supervisor direto do promotor (ou do próprio líder)\n        SELECT hu.\"name\" FROM public.relationships rl\n        JOIN public.users hu ON hu.id = rl.higher_id\n        JOIN public.roles hr ON hr.id = hu.role_id\n        WHERE rl.user_id = p.id AND hr.tag = 'trade_supervisor'\n        ORDER BY (hu.deleted_at IS NULL) DESC LIMIT 1) sd ON true\n    LEFT JOIN LATERAL (   -- supervisor do líder\n        SELECT hu.\"name\" FROM public.relationships rl\n        JOIN public.users hu ON hu.id = rl.higher_id\n        JOIN public.roles hr ON hr.id = hu.role_id\n        WHERE rl.user_id = ld.id AND hr.tag = 'trade_supervisor'\n        ORDER BY (hu.deleted_at IS NULL) DESC LIMIT 1) sl ON true\n    WHERE rp.\"day\" BETWEEN 1 AND 6\n),\n\n-- ===== TODAS AS LOJAS ATIVAS (dClients) =====\nlojas AS (\n    SELECT\n        c.id::text                                   AS id,\n        COALESCE(NULLIF(trim(c.code), ''), c.id::text) AS codigo_cliente,\n        nullif(upper(trim(c.tag)), '')               AS atendimento,\n        trim(c.trade_name)                           AS loja,\n        nullif(trim(concat_ws(', ', nullif(trim(c.street), ''), nullif(trim(c.address_number), ''))), '') AS logradouro,\n        nullif(upper(trim(c.neighborhood)), '')      AS bairro,\n        nullif(upper(trim(ci.name)), '')             AS cidade,\n        nullif(upper(trim(st.code)), '')             AS uf,\n        nullif(upper(trim(nw.name)), '')             AS rede,\n        nullif(upper(trim(ch.name)), '')             AS canal,\n        nullif(upper(trim(ch.external_code)), '')    AS canal_codigo,\n        c.perfect_store,\n        c.commercial_manager_id::text                AS commercial_manager_id\n    FROM public.clients c\n    LEFT JOIN public.cities   ci ON ci.id = c.city_id\n    LEFT JOIN public.states   st ON st.id = c.state_id\n    LEFT JOIN public.networks nw ON nw.id = c.network_id\n    LEFT JOIN public.channels ch ON ch.id = c.channel_id\n    WHERE c.super_id   IS NOT NULL\n      AND c.deleted_at IS NULL\n      AND NOT EXISTS (SELECT 1 FROM excluidos e WHERE e.id = c.id::text)\n      AND upper(trim(COALESCE(c.tag, ''))) <> 'USOINTERNOBI'   -- Escritório / Home Office ficam na aba Base Manual\n)\n\nSELECT\n    COALESCE(l.atendimento, '-')                                        AS \"ATENDIMENTO\",\n    COALESCE(rt.supervisor,\n             '( Ger. Regional ) ' || initcap(split_part(g.nome, ' ', 1)) || ' '\n               || left(regexp_replace(g.nome, '^.* ', ''), 1) || '.',\n             '-')                                                       AS \"SUPERVISOR MERCHANDISING\",\n    COALESCE(rt.lider, '-')                                             AS \"LÍDER\",\n    COALESCE(rt.promotor, '-')                                          AS \"PROMOTOR\",\n    l.codigo_cliente                                                    AS \"CÓDIGO CLIENTE\",\n    COALESCE(l.rede, '-')                                               AS \"BANDEIRA\",\n    l.loja                                                              AS \"LOJA\",\n    COALESCE(l.logradouro, '-')                                         AS \"LOGRADOURO\",\n    COALESCE(l.bairro, '-')                                             AS \"BAIRRO\",\n    COALESCE(l.cidade, '-')                                             AS \"CIDADE\",\n    COALESCE(l.uf, '-')                                                 AS \"UF\",\n    CASE WHEN l.perfect_store THEN 'SIM' ELSE 'NÃO' END                 AS \"LOJA PERFEITA?\",\n    COALESCE(g.regional, '-')                                           AS \"REGIONAL\",\n    COALESCE(g.nome, '-')                                               AS \"GERENTE REGIONAL\",\n    COALESCE(l.canal, '-')                                              AS \"CANAL\",\n    CASE\n        WHEN array[l.canal_codigo, l.canal] && array['KEY ACCOUNT', 'REGIONAL KEY ACCOUNT', 'KEY ACCOUNT REGIONAL'] THEN 'KEY ACCOUNT'\n        WHEN array[l.canal_codigo, l.canal] && array['CASH REGIONAL', 'CASH NACIONAL'] THEN 'CASH'\n        WHEN l.canal IS NULL AND l.canal_codigo IS NULL THEN 'SEM CANAL'\n        ELSE 'OUTROS'\n    END                                                                 AS \"GRUPO CANAL\"\nFROM lojas l\nLEFT JOIN roteiro  rt ON rt.client_id = l.id\nLEFT JOIN gerentes g  ON g.id = l.commercial_manager_id\nORDER BY 1, 2, 3, 4, 7";

function conexaoBanco_() {
  const p = PropertiesService.getScriptProperties();
  const url = p.getProperty('DB_URL'), user = p.getProperty('DB_USER'), senha = p.getProperty('DB_SENHA');
  if (!url || !user) throw new Error('Configure DB_URL, DB_USER e DB_SENHA em Configurações do projeto > Propriedades do script.');
  if (!/^jdbc:postgresql:\/\/[^/]+:\d+\//.test(url)) throw new Error('DB_URL no formato errado. Use jdbc:postgresql://SERVIDOR:5432/BANCO (com a porta).');
  return Jdbc.getConnection(url, user, senha || '');
}

/** Lê a consulta da aba "Consulta Banco" (cria a aba com um modelo na primeira vez). */
function consultaBase_() {
  const ss = SpreadsheetApp.getActive();
  let a = ss.getSheetByName(CFG.ABA_SQL);
  if (!a) {
    a = ss.insertSheet(CFG.ABA_SQL);
    a.getRange(1, 1).setValue('Consulta SQL que alimenta a aba Base (cole a sua na célula A2, inteira numa célula só)').setFontWeight('bold');
    a.getRange(2, 1).setValue(SQL_MODELO).setWrap(true).setFontFamily('Courier New');
    a.setColumnWidth(1, 900);
  }
  const sql = String(a.getRange(2, 1).getValue() || '').trim();
  if (!sql) throw new Error('Cole a sua consulta SQL na aba "' + CFG.ABA_SQL + '", célula A2.');
  if (!/^\s*(--[^\n]*\n\s*)*(select|with)\b/i.test(sql)) throw new Error('A consulta precisa começar com SELECT ou WITH (só leitura).');
  return sql;
}

/** Menu: testa a conexão e mostra a versão do banco. */
function testarBanco() {
  const ui = SpreadsheetApp.getUi();
  let c;
  try {
    c = conexaoBanco_();
    const rs = c.createStatement().executeQuery('select version()');
    rs.next();
    ui.alert('Conexão OK', 'Conectado: ' + String(rs.getString(1)).slice(0, 80), ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Não conectou', e.message + '\n\nConfira DB_URL/DB_USER/DB_SENHA e se o banco libera os IPs do Google Apps Script.', ui.ButtonSet.OK);
  } finally { if (c) c.close(); }
}

/** Menu e gatilho: roda a consulta e reescreve a aba Base (+ Base Manual). Não apaga nada se a consulta falhar ou vier vazia. */
function atualizarBaseDoBanco() {
  const ini = Date.now();
  let c, linhas = [], cab = [];
  try {
    const sql = consultaBase_();
    c = conexaoBanco_();
    const st = c.createStatement();
    st.setFetchSize(1000);
    const rs = st.executeQuery(sql);
    const md = rs.getMetaData(), n = md.getColumnCount();
    for (let i = 1; i <= n; i++) cab.push(md.getColumnLabel(i));
    while (rs.next()) { const l = []; for (let i = 1; i <= n; i++) { const v = rs.getString(i); l.push(v === null ? '' : v); } linhas.push(l); }
    rs.close(); st.close();
  } catch (e) {
    logBanco_('ERRO', 0, Date.now() - ini, e.message);
    throw e;
  } finally { if (c) c.close(); }

  let cabN = cab.map(normCab_);
  if (cabN.indexOf('LOJA') < 0 || cabN.indexOf('PROMOTOR') < 0) {
    logBanco_('ERRO', linhas.length, Date.now() - ini, 'A consulta precisa ter as colunas LOJA e PROMOTOR.');
    throw new Error('A consulta precisa ter as colunas "LOJA" e "PROMOTOR" (use AS "LOJA").');
  }
  const aba = aba_(CFG.ABA_BASE);
  // o banco não tem supervisor/líder: completa pela aba Hierarquia (e pela Base anterior nos casos que variam por loja)
  let semSup = 0;
  if (cabN.indexOf('SUPERVISOR MERCHANDISING') < 0 && cabN.indexOf('SUPERVISOR') < 0) {
    const r = completaHierarquia_(cab, linhas);
    cab = r.cab; linhas = r.linhas; semSup = r.semSup;
    const pct = linhas.length ? semSup / linhas.length : 0;
    if (pct > 0.3) {
      const msg = semSup + ' de ' + linhas.length + ' linhas ficaram sem supervisor. Preencha a aba "' + CFG.ABA_HIER + '" e rode de novo. Nada foi alterado.';
      logBanco_('BLOQUEADO', linhas.length, Date.now() - ini, msg);
      throw new Error(msg);
    }
  }
  // trava de segurança: não troca a Base por um resultado muito menor que o atual (ex.: filtro errado)
  const atual = Math.max(0, aba.getLastRow() - 1);
  if (!linhas.length || (atual > 100 && linhas.length < atual * 0.5)) {
    const msg = 'Consulta devolveu ' + linhas.length + ' linhas (a Base tem ' + atual + '). Nada foi alterado.';
    logBanco_('BLOQUEADO', linhas.length, Date.now() - ini, msg);
    throw new Error(msg);
  }

  cabN = cab.map(normCab_);
  const manual = linhasManuais_(cab);
  const tudo = [cab].concat(linhas, manual);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    aba.clearContents();
    const iCod = cabN.findIndex(h => COLS.codigo.indexOf(h) >= 0);
    if (iCod >= 0) aba.getRange(1, iCod + 1, tudo.length, 1).setNumberFormat('@');   // código como texto (não vira 1.234,00)
    aba.getRange(1, 1, tudo.length, cab.length).setValues(tudo);
    aba.getRange(1, 1, 1, cab.length).setFontWeight('bold');
    aba.setFrozenRows(1);
  } finally { lock.releaseLock(); }
  logBanco_('OK', linhas.length, Date.now() - ini, manual.length + ' linha(s) da Base Manual somadas' +
    (semSup ? ' · ' + semSup + ' sem supervisor (ver aba ' + CFG.ABA_HIER + ', coluna Pendentes)' : ''));
  try { SpreadsheetApp.getActive().toast(linhas.length + ' lojas do banco + ' + manual.length + ' manuais.', 'Base atualizada', 6); } catch (e) {}
  return linhas.length;
}

/**
 * Linhas da aba "Base Manual" no formato do cabeçalho do banco.
 * Na primeira vez, cria a aba copiando da Base atual as linhas de HOME OFFICE e ESCRITÓRIO.
 */
function linhasManuais_(cab) {
  const ss = SpreadsheetApp.getActive();
  let a = ss.getSheetByName(CFG.ABA_MANUAL);
  if (!a) {
    a = ss.insertSheet(CFG.ABA_MANUAL);
    const v = aba_(CFG.ABA_BASE).getDataRange().getValues();
    const cabAtual = v[0];
    const iLoja = cabAtual.map(normCab_).indexOf('LOJA');
    const fixas = v.slice(1).filter(l => iLoja >= 0 && ['HOME OFFICE', 'ESCRITORIO'].indexOf(normCab_(l[iLoja])) >= 0);
    a.getRange(1, 1, 1, cabAtual.length).setValues([cabAtual]).setFontWeight('bold').setBackground('#9a0019').setFontColor('#ffffff');
    if (fixas.length) a.getRange(2, 1, fixas.length, cabAtual.length).setValues(fixas);
    a.setFrozenRows(1);
  }
  const v = a.getDataRange().getValues();
  if (v.length < 2) return [];
  const cm = v[0].map(normCab_), alvo = cab.map(normCab_);
  // casa as colunas pelo nome (aceita os mesmos apelidos da Base: CODIGOCLIENTE = CODIGO CLIENTE etc.)
  const grupo = h => { for (const k in COLS) if (COLS[k].indexOf(h) >= 0) return k; return h; };
  const pos = alvo.map(h => { const g = grupo(h); return cm.findIndex(x => x === h || grupo(x) === g); });
  return v.slice(1).filter(l => l.some(x => x !== '')).map(l => pos.map(i => i >= 0 ? l[i] : ''));
}

/**
 * Acrescenta SUPERVISOR MERCHANDISING e LÍDER às linhas do banco.
 * Ordem: 1) aba Hierarquia pelo promotor · 2) Base anterior pela mesma loja + promotor · 3) Base anterior só pela loja.
 * Na primeira vez, cria a aba Hierarquia com os promotores da Base atual (os que têm sempre o mesmo supervisor e líder).
 */
function completaHierarquia_(cab, linhas) {
  const cabN = cab.map(normCab_);
  const iProm = cabN.indexOf('PROMOTOR'), iCod = cabN.findIndex(h => COLS.codigo.indexOf(h) >= 0);
  const iAt = cabN.indexOf('ATENDIMENTO');
  let anterior = [];
  try { anterior = lerBase_(); } catch (e) {}
  const porLojaProm = new Map(), porLoja = new Map(), atPorLoja = new Map();
  anterior.forEach(l => {
    if (!l.supervisor) return;
    const v = { sup: l.supervisor, lid: l.lider };
    porLojaProm.set(l.chave + '|' + chave_(l.promotor), v);
    if (!porLoja.has(l.chave)) porLoja.set(l.chave, v);
    if (l.atendimento) atPorLoja.set(l.chave, l.agencia || l.atendimento);
  });
  const hier = hierarquia_(anterior);
  let semSup = 0;
  const pend = new Map();
  const novas = linhas.map(l => {
    const prom = iProm >= 0 ? chave_(l[iProm]) : '', cod = iCod >= 0 ? String(l[iCod]).trim() : '';
    const v = hier.get(prom) || porLojaProm.get(cod + '|' + prom) || porLoja.get(cod) || null;
    if (!v) { semSup++; const p = iProm >= 0 ? String(l[iProm]) : ''; pend.set(p, (pend.get(p) || 0) + 1); }
    if (iAt >= 0 && !String(l[iAt]).trim() && atPorLoja.has(cod)) l[iAt] = atPorLoja.get(cod);   // atendimento vazio no banco: mantém o da Base
    const out = l.slice();
    out.splice(iProm >= 0 ? iProm : 0, 0, v ? v.sup : '', v ? (v.lid || '-') : '');
    return out;
  });
  const cab2 = cab.slice(); cab2.splice(iProm >= 0 ? iProm : 0, 0, 'SUPERVISOR MERCHANDISING', 'LÍDER');
  // lista quem ficou sem supervisor na própria aba Hierarquia, para o BI completar
  const a = aba_(CFG.ABA_HIER);
  a.getRange(1, 6, Math.max(a.getLastRow(), pend.size + 2), 2).clearContent();
  a.getRange(1, 6, 1, 2).setValues([['Pendentes (promotor sem supervisor)', 'Linhas']]).setFontWeight('bold');
  if (pend.size) a.getRange(2, 6, pend.size, 2).setValues([...pend.entries()]);
  return { cab: cab2, linhas: novas, semSup: semSup };
}

/** Lê (ou cria a partir da Base atual) a aba Hierarquia: Promotor | Supervisor | Líder | Observação. */
function hierarquia_(base) {
  const ss = SpreadsheetApp.getActive();
  let a = ss.getSheetByName(CFG.ABA_HIER);
  if (!a) {
    a = ss.insertSheet(CFG.ABA_HIER);
    const m = new Map();
    (base || []).forEach(l => {
      const k = chave_(l.promotor);
      if (!k || k === 'SEM PROMOTOR' || !l.supervisor || /^(HOME OFFICE|ESCRITORIO)$/.test(normCab_(l.loja))) return;
      if (!m.has(k)) m.set(k, { nome: l.promotor, combos: new Map() });
      const c = l.supervisor + '|' + (l.lider || '-');
      m.get(k).combos.set(c, (m.get(k).combos.get(c) || 0) + 1);
    });
    const linhas = [...m.values()].sort((x, y) => x.nome.localeCompare(y.nome, 'pt-BR')).map(x => {
      if (x.combos.size === 1) { const [sp, ld] = [...x.combos.keys()][0].split('|'); return [x.nome, sp, ld, '']; }
      return [x.nome, '', '', 'Varia por loja (' + x.combos.size + ' combinações): mantém o da Base anterior. Preencha só se quiser fixar.'];
    });
    a.getRange(1, 1, 1, 4).setValues([['Promotor', 'Supervisor', 'Líder', 'Observação']]).setFontWeight('bold').setBackground('#9a0019').setFontColor('#ffffff');
    if (linhas.length) a.getRange(2, 1, linhas.length, 4).setValues(linhas);
    a.setFrozenRows(1);
  }
  const v = a.getDataRange().getValues(), mapa = new Map();
  v.slice(1).forEach(r => { const k = chave_(r[0]); if (k && String(r[1] || '').trim()) mapa.set(k, { sup: String(r[1]).trim(), lid: String(r[2] || '').trim() || '-' }); });
  return mapa;
}

function logBanco_(status, n, ms, obs) {
  const a = aba_(CFG.ABA_LOG, true);
  if (a.getLastRow() === 0) a.appendRow(['DataHora', 'Status', 'Linhas', 'Segundos', 'Observação']);
  a.appendRow([new Date(), status, n, Math.round(ms / 100) / 10, obs || '']);
}

/** Menu: cria (ou recria) a atualização automática todos os dias, de madrugada. */
function agendarAtualizacaoBanco() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'atualizarBaseDoBanco').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('atualizarBaseDoBanco').timeBased().everyDays(1).atHour(5).inTimezone(CFG.FUSO).create();
  SpreadsheetApp.getUi().alert('Pronto', 'A Base será atualizada pelo banco todo dia, entre 5h e 6h. O histórico fica na aba "' + CFG.ABA_LOG + '".', SpreadsheetApp.getUi().ButtonSet.OK);
}
