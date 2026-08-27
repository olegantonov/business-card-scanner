/** Acesso ao banco D1 e regras de gravacao dos contatos. */

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

export function paraCsv(linhas) {
  const colunas = ['nome', 'cargo', 'empresa', 'sigla', 'departamento', 'setor', 'segmento',
    'prioridade', 'telefone', 'celular', 'email', 'email_secundario', 'site',
    'endereco', 'cidade', 'uf', 'cep', 'linkedin', 'instagram', 'facebook',
    'twitter', 'outras_redes', 'temas', 'resumo_ia', 'origem_evento',
    'origem_local', 'data_captura', 'status', 'observacoes', 'criado_em'];
  const escapar = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const corpo = linhas.map((l) => colunas.map((c) => escapar(l[c])).join(';')).join('\r\n');
  // BOM para o Excel abrir com acentuacao correta
  return `﻿${colunas.join(';')}\r\n${corpo}`;
}
