/**
 * API publica de consulta (/v1), para sistemas de terceiros.
 *
 * Somente leitura: um token vazado expoe dados, mas ninguem corrompe a base.
 * Autenticacao por "Authorization: Bearer <token>"; o token e guardado como
 * hash SHA-256 e so aparece uma vez, na criacao.
 */

import { listar, estatisticas } from './db.js';

const LIMITE_MAX = 200;

export function novoToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return 'cgab_' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashToken(token) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token).trim()));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function autenticar(request, env) {
  const cabecalho = request.headers.get('authorization') || '';
  const m = cabecalho.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;

  const registro = await env.DB
    .prepare('SELECT id, nome, escopo, ativo FROM api_tokens WHERE token_hash = ?')
    .bind(await hashToken(m[1]))
    .first();

  if (!registro || !registro.ativo) return null;

  env.DB.prepare('UPDATE api_tokens SET ultimo_uso = ?, chamadas = chamadas + 1 WHERE id = ?')
    .bind(new Date().toISOString(), registro.id)
    .run()
    .catch(() => {});

  return registro;
}

const lista = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
const ouNulo = (v) => (v === '' || v === undefined ? null : v);

/**
 * Formato publico do contato. Deliberadamente diferente da tabela: nao expoe
 * bruto_json, chave de busca nem os caminhos das imagens no armazenamento.
 */
export function contatoPublico(c) {
  return {
    id: c.id,
    nome: ouNulo(c.nome),
    cargo: ouNulo(c.cargo),
    empresa: ouNulo(c.empresa),
    sigla: ouNulo(c.sigla),
    departamento: ouNulo(c.departamento),
    contato: {
      telefone: ouNulo(c.telefone),
      celular: ouNulo(c.celular),
      email: ouNulo(c.email),
      email_secundario: ouNulo(c.email_secundario),
      site: ouNulo(c.site)
    },
    endereco: {
      logradouro: ouNulo(c.endereco),
      cidade: ouNulo(c.cidade),
      uf: ouNulo(c.uf),
      cep: ouNulo(c.cep)
    },
    redes: {
      linkedin: ouNulo(c.linkedin),
      instagram: ouNulo(c.instagram),
      facebook: ouNulo(c.facebook),
      twitter: ouNulo(c.twitter),
      outras: lista(c.outras_redes)
    },
    classificacao: {
      setor: ouNulo(c.setor),
      segmento: ouNulo(c.segmento),
      prioridade: ouNulo(c.prioridade),
      temas: lista(c.temas),
      resumo: ouNulo(c.resumo_ia),
      confianca_leitura: c.confianca ?? null
    },
    origem: {
      evento: ouNulo(c.origem_evento),
      local: ouNulo(c.origem_local),
      data_captura: ouNulo(c.data_captura),
      registrado_por: ouNulo(c.registrado_por)
    },
    status: c.status,
    observacoes: ouNulo(c.observacoes),
    tem_foto: Boolean(c.imagem_key),
    tem_verso: Boolean(c.imagem_verso_key),
    criado_em: c.criado_em,
    atualizado_em: c.atualizado_em
  };
}

const json = (dados, status = 200) => new Response(JSON.stringify(dados, null, 2), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    // consulta de sistema a sistema: nada de cache intermediario com dado pessoal
    'cache-control': 'no-store'
  }
});

const erro = (mensagem, status, codigo) => json({ erro: { codigo, mensagem } }, status);

/** Roteia /v1/*. Devolve null se o caminho nao for da API publica. */
export async function rotearPublica(request, env, url) {
  const caminho = url.pathname;
  if (!caminho.startsWith('/v1/')) return null;

  if (request.method !== 'GET') {
    return erro('Esta API é somente leitura. Use GET.', 405, 'metodo_nao_permitido');
  }

  const token = await autenticar(request, env);
  if (!token) {
    return erro(
      'Token ausente ou inválido. Envie o cabeçalho: Authorization: Bearer <token>',
      401,
      'nao_autenticado'
    );
  }

  const p = url.searchParams;

  if (caminho === '/v1/contatos') {
    const limite = Math.min(Number(p.get('limite')) || 50, LIMITE_MAX);
    const offset = Math.max(Number(p.get('offset')) || 0, 0);
    const r = await listar(env.DB, {
      q: p.get('q') || '',
      setor: p.get('setor') || '',
      segmento: p.get('segmento') || '',
      prioridade: p.get('prioridade') || '',
      status: p.get('status') || '',
      origem_evento: p.get('evento') || '',
      desde: p.get('desde') || '',
      limit: limite,
      offset
    });
    return json({
      total: r.total,
      limite: r.limite,
      offset: r.offset,
      contatos: r.contatos.map(contatoPublico)
    });
  }

  const idMatch = caminho.match(/^\/v1\/contatos\/([\w-]+)$/);
  if (idMatch) {
    const c = await env.DB.prepare('SELECT * FROM contatos WHERE id = ?').bind(idMatch[1]).first();
    return c ? json(contatoPublico(c)) : erro('Contato não encontrado.', 404, 'nao_encontrado');
  }

  if (caminho === '/v1/estatisticas') {
    return json(await estatisticas(env.DB));
  }

  return erro('Rota não encontrada. Consulte a documentação em /docs.', 404, 'rota_invalida');
}
