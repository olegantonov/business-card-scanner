/** Acesso ao banco D1 e regras de gravacao dos contatos. */

import { montarXlsx } from './planilha.js';

export const CAMPOS = [
  'nome', 'cargo', 'empresa', 'sigla', 'departamento', 'telefone', 'celular', 'email',
  'email_secundario', 'site', 'endereco', 'cidade', 'uf', 'cep', 'linkedin',
  'instagram', 'facebook', 'twitter', 'outras_redes', 'setor', 'segmento',
  'prioridade', 'temas', 'resumo_ia', 'origem_evento', 'origem_local',
  'data_captura', 'observacoes', 'status', 'confianca', 'registrado_por',
  'imagem_key', 'imagem_verso_key', 'bruto_json'
];

const texto = (v) => (v === undefined || v === null ? '' : String(v).trim());

const juntar = (v) => (Array.isArray(v) ? v.join(', ') : texto(v));

export function chaveBusca(c) {
  return [c.nome, c.cargo, c.empresa, c.sigla, c.departamento, c.email, c.email_secundario,
    c.telefone, c.celular, c.cidade, c.uf, c.segmento, c.temas, c.resumo_ia,
    c.origem_evento, c.origem_local]
    .map(juntar)
    .join(' ')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Monta o registro completo a partir do corpo enviado pela interface. */
export function montarContato(corpo, { id, criado_em } = {}) {
  const agora = new Date().toISOString();
  const c = {};
  for (const campo of CAMPOS) c[campo] = texto(corpo[campo]);

  c.outras_redes = juntar(corpo.outras_redes);
  c.temas = juntar(corpo.temas);
  c.email = c.email.toLowerCase();
  c.email_secundario = c.email_secundario.toLowerCase();
  c.uf = c.uf.toUpperCase().slice(0, 2);
  c.status = c.status || 'novo';
  c.data_captura = c.data_captura || agora.slice(0, 10);
  c.confianca = corpo.confianca === null || corpo.confianca === undefined || corpo.confianca === ''
    ? null : Number(corpo.confianca);
  c.bruto_json = typeof corpo.bruto_json === 'string'
    ? corpo.bruto_json
    : (corpo.bruto_json ? JSON.stringify(corpo.bruto_json) : '');

  c.id = id || crypto.randomUUID();
  c.criado_em = criado_em || agora;
  c.atualizado_em = agora;
  c.busca = chaveBusca(c);
  return c;
}

export async function inserir(db, c) {
  const colunas = ['id', 'criado_em', 'atualizado_em', ...CAMPOS, 'busca'];
  const marcadores = colunas.map(() => '?').join(', ');
  await db.prepare(`INSERT INTO contatos (${colunas.join(', ')}) VALUES (${marcadores})`)
    .bind(...colunas.map((k) => c[k]))
    .run();
  return c;
}

export async function atualizar(db, c) {
  const colunas = ['atualizado_em', ...CAMPOS, 'busca'];
  const sets = colunas.map((k) => `${k} = ?`).join(', ');
  await db.prepare(`UPDATE contatos SET ${sets} WHERE id = ?`)
    .bind(...colunas.map((k) => c[k]), c.id)
    .run();
  return c;
}

export async function registrarEvento(db, contatoId, acao, detalhe, usuario) {
  await db.prepare('INSERT INTO eventos (contato_id, acao, detalhe, usuario, criado_em) VALUES (?, ?, ?, ?, ?)')
    .bind(contatoId, acao, detalhe || '', usuario || '', new Date().toISOString())
    .run();
}

export function normalizarBusca(termo) {
  return texto(termo).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Lista com filtros, busca textual e paginacao. */
export async function listar(db, filtros = {}) {
  const where = [];
  const params = [];

  if (filtros.q) {
    where.push('busca LIKE ?');
    params.push(`%${normalizarBusca(filtros.q)}%`);
  }
  for (const campo of ['setor', 'segmento', 'prioridade', 'status']) {
    if (filtros[campo]) {
      where.push(`${campo} = ?`);
      params.push(filtros[campo]);
    }
  }
  if (filtros.origem_evento) {
    where.push('origem_evento LIKE ?');
    params.push(`%${filtros.origem_evento}%`);
  }
  if (filtros.desde) {
    where.push('criado_em >= ?');
    params.push(filtros.desde);
  }

  const clausula = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limite = Math.min(Number(filtros.limit) || 50, 500);
  const offset = Math.max(Number(filtros.offset) || 0, 0);

  const total = await db.prepare(`SELECT COUNT(*) AS n FROM contatos ${clausula}`).bind(...params).first();
  const { results } = await db.prepare(
    `SELECT * FROM contatos ${clausula} ORDER BY criado_em DESC LIMIT ? OFFSET ?`
  ).bind(...params, limite, offset).all();

  return { total: total?.n ?? 0, limite, offset, contatos: results || [] };
}

/**
 * Todos os contatos que casam com os filtros, em paginas de 500.
 * A `listar()` limita a 500 por resposta - na exportacao isso cortava a
 * planilha em silencio, que e o pior jeito de perder contato.
 */
export async function listarParaExport(db, filtros = {}, maximo = 5000) {
  const contatos = [];
  let offset = 0;
  while (contatos.length < maximo) {
    const pagina = await listar(db, { ...filtros, limit: 500, offset });
    contatos.push(...pagina.contatos);
    if (pagina.contatos.length < 500 || contatos.length >= pagina.total) break;
    offset += 500;
  }
  return contatos.slice(0, maximo);
}

export async function possiveisDuplicados(db, { email, celular, telefone, nome, empresa, sigla }) {
  const where = [];
  const params = [];
  if (email) { where.push('email = ?'); params.push(email.toLowerCase()); }
  const fone = (celular || telefone || '').replace(/\D/g, '');
  if (fone.length >= 8) {
    where.push("REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(celular,'') || COALESCE(telefone,''), ' ', ''), '-', ''), '(', ''), ')', '') LIKE ?");
    params.push(`%${fone.slice(-8)}%`);
  }
  if (nome && empresa) {
    where.push('(LOWER(nome) = ? AND LOWER(empresa) = ?)');
    params.push(nome.toLowerCase(), empresa.toLowerCase());
  }
  if (nome && sigla) {
    where.push("(LOWER(nome) = ? AND LOWER(COALESCE(sigla,'')) = ?)");
    params.push(nome.toLowerCase(), sigla.toLowerCase());
  }
  if (!where.length) return [];
  const { results } = await db.prepare(
    `SELECT id, nome, empresa, sigla, email, celular, telefone, criado_em FROM contatos WHERE ${where.join(' OR ')} LIMIT 5`
  ).bind(...params).all();
  return results || [];
}

export async function estatisticas(db) {
  const agrupar = async (coluna) => {
    const { results } = await db.prepare(
      `SELECT ${coluna} AS chave, COUNT(*) AS n FROM contatos GROUP BY ${coluna} ORDER BY n DESC`
    ).all();
    return results || [];
  };
  const total = await db.prepare('SELECT COUNT(*) AS n FROM contatos').first();
  const hoje = await db.prepare('SELECT COUNT(*) AS n FROM contatos WHERE substr(criado_em,1,10) = ?')
    .bind(new Date().toISOString().slice(0, 10)).first();
  return {
    total: total?.n ?? 0,
    hoje: hoje?.n ?? 0,
    por_setor: await agrupar('setor'),
    por_prioridade: await agrupar('prioridade'),
    por_segmento: await agrupar('segmento'),
    por_status: await agrupar('status')
  };
}

/**
 * Colunas da planilha de contatos: campo do banco, titulo legivel e largura.
 * Vale para o CSV e para o .xlsx - os dois saem exatamente com o mesmo conteudo.
 */
export const COLUNAS_EXPORT = [
  ['nome', 'Nome', 28],
  ['cargo', 'Cargo', 26],
  ['empresa', 'Empresa / órgão', 34],
  ['sigla', 'Sigla', 12],
  ['departamento', 'Departamento', 24],
  ['setor', 'Setor', 16],
  ['segmento', 'Segmento', 22],
  ['prioridade', 'Prioridade', 12],
  ['telefone', 'Telefone', 20],
  ['celular', 'Celular / WhatsApp', 20],
  ['email', 'E-mail', 30],
  ['email_secundario', 'E-mail secundário', 30],
  ['site', 'Site', 26],
  ['endereco', 'Endereço', 34],
  ['cidade', 'Cidade', 18],
  ['uf', 'UF', 6],
  ['cep', 'CEP', 12],
  ['linkedin', 'LinkedIn', 26],
  ['instagram', 'Instagram', 20],
  ['facebook', 'Facebook', 20],
  ['twitter', 'X / Twitter', 20],
  ['outras_redes', 'Outras redes', 24],
  ['temas', 'Temas de interesse', 34],
  ['resumo_ia', 'Resumo', 48],
  ['origem_evento', 'Evento', 30],
  ['origem_local', 'Local', 24],
  ['data_captura', 'Data do contato', 16],
  ['status', 'Situação', 14],
  ['observacoes', 'Observações do gabinete', 40],
  ['registrado_por', 'Cadastrado por', 20],
  ['criado_em', 'Cadastrado em', 22]
];

/**
 * Rotulos dos campos classificados. No banco eles ficam em minusculas e sem
 * acento (sao chaves), mas quem abre a planilha quer ler "Terceiro setor".
 */
const ROTULOS = {
  publico: 'Setor público', privado: 'Privado', terceiro_setor: 'Terceiro setor',
  academico: 'Acadêmico', midia: 'Mídia', outro: 'Outro',
  alta: 'Alta', media: 'Média', baixa: 'Baixa',
  novo: 'Novo', revisado: 'Revisado', encaminhado: 'Encaminhado', arquivado: 'Arquivado',
  agronegocio: 'Agronegócio', saude: 'Saúde', educacao: 'Educação',
  infraestrutura: 'Infraestrutura', transporte: 'Transporte', energia: 'Energia',
  meio_ambiente: 'Meio ambiente', seguranca_publica: 'Segurança pública',
  tecnologia: 'Tecnologia', telecomunicacoes: 'Telecomunicações',
  industria: 'Indústria', comercio: 'Comércio', servicos: 'Serviços',
  financeiro: 'Financeiro', juridico: 'Jurídico', construcao: 'Construção',
  turismo: 'Turismo', cultura: 'Cultura', esporte: 'Esporte',
  assistencia_social: 'Assistência social', ciencia_pesquisa: 'Ciência e pesquisa',
  comunicacao_imprensa: 'Comunicação e imprensa', politica_governo: 'Política e governo',
  religioso: 'Religioso'
};

const CLASSIFICADOS = ['setor', 'segmento', 'prioridade', 'status'];

/** Data ISO -> "27/08/2026" ou "27/08/2026 14:32", como se le numa planilha. */
function dataLegivel(valor) {
  const m = String(valor ?? '').match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return String(valor ?? '');
  const [, ano, mes, dia, hora, minuto] = m;
  return `${dia}/${mes}/${ano}${hora ? ` ${hora}:${minuto}` : ''}`;
}

/** Uma linha do banco vira uma linha de planilha, ja com os rotulos legiveis. */
export function linhaExport(contato) {
  return COLUNAS_EXPORT.map(([campo]) => {
    const valor = contato[campo];
    if (CLASSIFICADOS.includes(campo)) return ROTULOS[valor] || texto(valor);
    if (campo === 'data_captura' || campo === 'criado_em') return dataLegivel(valor);
    return texto(valor);
  });
}

export function paraCsv(linhas) {
  const escapar = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const cabecalho = COLUNAS_EXPORT.map(([, titulo]) => escapar(titulo)).join(';');
  const corpo = linhas.map((l) => linhaExport(l).map(escapar).join(';')).join('\r\n');
  // BOM para o Excel abrir com acentuacao correta
  return `﻿${cabecalho}\r\n${corpo}`;
}

/** A mesma planilha em .xlsx, para abrir sem passar pelo assistente de importacao. */
export function paraXlsx(linhas, aba = 'Contatos') {
  return montarXlsx({
    cabecalhos: COLUNAS_EXPORT.map(([, titulo]) => titulo),
    larguras: COLUNAS_EXPORT.map(([, , largura]) => largura),
    linhas: linhas.map(linhaExport),
    aba
  });
}
