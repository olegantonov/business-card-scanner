/**
 * Fila de leitura em segundo plano.
 *
 * O cartao fotografado e gravado na hora (imagem no R2, linha em "pendentes")
 * e a resposta volta imediatamente - a pessoa ja pode fotografar o proximo.
 * A chamada ao Gemini roda depois, via ctx.waitUntil(), e o resultado fica
 * esperando na aba de conferencia.
 *
 * Se o Worker for encerrado antes de terminar a leitura, o cartao fica em
 * "na_fila" e o Cron Trigger (a cada 2 min) retoma. Nada se perde.
 */

import { lerCartao } from './gemini.js';
import { montarContato, inserir, registrarEvento, possiveisDuplicados } from './db.js';

const MAX_TENTATIVAS = 3;
/**
 * Depois disso, um cartao "lendo" e considerado abandonado e volta para a fila.
 * Uma leitura normal leva ~15s, entao 2 minutos ja e margem de sobra - e o que
 * mais derruba leitura em andamento e um deploy, que encerra o waitUntil.
 */
const MINUTOS_TRAVADO = 2;

export function base64ParaBytes(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function bytesParaBase64(bytes) {
  // em pedacos: String.fromCharCode(...) estoura a pilha com arrays grandes
  let bin = '';
  const passo = 0x8000;
  for (let i = 0; i < bytes.length; i += passo) {
    bin += String.fromCharCode(...bytes.subarray(i, i + passo));
  }
  return btoa(bin);
}

const agora = () => new Date().toISOString();

/** Grava a imagem e cria a linha na fila. Nao chama a IA. */
export async function enfileirar(env, { base64, mime, verso, origem_evento, origem_local, usuario }) {
  const id = crypto.randomUUID();
  const chave = `cartoes/${id}`;

  await env.IMAGENS.put(chave, base64ParaBytes(base64), {
    httpMetadata: { contentType: mime }
  });

  let chaveVerso = null;
  if (verso?.base64) {
    chaveVerso = `cartoes/${id}-verso`;
    await env.IMAGENS.put(chaveVerso, base64ParaBytes(verso.base64), {
      httpMetadata: { contentType: verso.mime || mime }
    });
  }

  const t = agora();
  await env.DB.prepare(
    `INSERT INTO pendentes
       (id, criado_em, atualizado_em, status, imagem_key, imagem_verso_key, mime,
        origem_evento, origem_local, registrado_por, tentativas)
     VALUES (?, ?, ?, 'na_fila', ?, ?, ?, ?, ?, ?, 0)`
  ).bind(id, t, t, chave, chaveVerso, mime, origem_evento || '', origem_local || '', usuario || '').run();

  return { id, imagem_key: chave, imagem_verso_key: chaveVerso };
}

/**
 * Anexa o verso a um cartao que ja esta na fila e manda ler de novo, agora
 * com os dois lados. Cobre quem fotografou a frente e so depois virou o cartao.
 */
export async function anexarVerso(env, id, { base64, mime }) {
  const p = await env.DB.prepare('SELECT * FROM pendentes WHERE id = ?').bind(id).first();
  if (!p) return { ok: false, erro: 'Cartão não encontrado na fila.' };
  if (p.status === 'confirmado') return { ok: false, erro: 'Este cartão já foi conferido.' };

  const chaveVerso = `cartoes/${id}-verso`;
  await env.IMAGENS.put(chaveVerso, base64ParaBytes(base64), {
    httpMetadata: { contentType: mime || p.mime || 'image/jpeg' }
  });

  // volta para a fila com tentativas zeradas: e uma leitura nova, com mais informacao
  await env.DB.prepare(
    `UPDATE pendentes SET imagem_verso_key = ?, status = 'na_fila', tentativas = 0,
       erro = NULL, atualizado_em = ? WHERE id = ?`
  ).bind(chaveVerso, agora(), id).run();

  return { ok: true, id };
}

/**
 * Le um cartao da fila pela IA e guarda o resultado.
 * Seguro para rodar duas vezes: so pega quem ainda esta em "na_fila".
 */
export async function processar(env, id) {
  const marcou = await env.DB.prepare(
    `UPDATE pendentes SET status = 'lendo', atualizado_em = ?, tentativas = tentativas + 1
     WHERE id = ? AND status = 'na_fila'`
  ).bind(agora(), id).run();

  // outra invocacao ja pegou este cartao
  if (!marcou.meta?.changes) return { ok: false, motivo: 'ja_em_andamento' };

  const p = await env.DB.prepare('SELECT * FROM pendentes WHERE id = ?').bind(id).first();
  if (!p) return { ok: false, motivo: 'sumiu' };

  try {
    const lados = [];
    for (const chave of [p.imagem_key, p.imagem_verso_key]) {
      if (!chave) continue;
      const obj = await env.IMAGENS.get(chave);
      if (!obj) continue;
      lados.push({
        base64: bytesParaBase64(new Uint8Array(await obj.arrayBuffer())),
        mime: obj.httpMetadata?.contentType || p.mime || 'image/jpeg'
      });
    }
    if (!lados.length) throw new Error('imagem nao encontrada no armazenamento');

    const inicio = Date.now();
    const r = await lerCartao(
      {
        apiKey: env.GEMINI_API_KEY,
        modelo: env.GEMINI_MODEL,
        modo: env.GEMINI_API_MODE,
        baseUrl: env.GEMINI_BASE_URL
      },
      lados
    );

    if (!r.ok) throw new Error(r.erro);

    await env.DB.prepare(
      `UPDATE pendentes SET status = 'aguardando', dados_json = ?, meta_json = ?, erro = NULL, atualizado_em = ?
       WHERE id = ?`
    ).bind(
      JSON.stringify(r.dados),
      JSON.stringify({ modelo: r.modelo, endpoint: r.endpoint, ms: Date.now() - inicio, lados: r.lados }),
      agora(),
      id
    ).run();

    return { ok: true };
  } catch (e) {
    const mensagem = String(e?.message || e).slice(0, 500);
    // ainda tem tentativa sobrando? volta para a fila; senao, marca erro
    const proximo = (p.tentativas + 1) < MAX_TENTATIVAS ? 'na_fila' : 'erro';
    await env.DB.prepare(
      'UPDATE pendentes SET status = ?, erro = ?, atualizado_em = ? WHERE id = ?'
    ).bind(proximo, mensagem, agora(), id).run();
    return { ok: false, motivo: mensagem };
  }
}

/**
 * Retoma o que ficou para tras. Chamado pelo Cron Trigger e tambem ao abrir a
 * aba de conferencia, para nao depender so do cron.
 */
export async function varrerFila(env, limite = 5) {
  const corte = new Date(Date.now() - MINUTOS_TRAVADO * 60_000).toISOString();

  // cartoes que entraram em "lendo" e nunca saiu de la
  await env.DB.prepare(
    `UPDATE pendentes SET status = 'na_fila', atualizado_em = ?
     WHERE status = 'lendo' AND atualizado_em < ?`
  ).bind(agora(), corte).run();

  const { results } = await env.DB.prepare(
    `SELECT id FROM pendentes WHERE status = 'na_fila' AND tentativas < ?
     ORDER BY criado_em LIMIT ?`
  ).bind(MAX_TENTATIVAS, limite).all();

  const ids = (results || []).map((r) => r.id);
  for (const id of ids) await processar(env, id);
  return ids.length;
}

/** Devolve o cartao pendente ja com os dados da IA desempacotados. */
function desempacotar(p) {
  let dados = null;
  let meta = null;
  try { dados = p.dados_json ? JSON.parse(p.dados_json) : null; } catch { /* ignora */ }
  try { meta = p.meta_json ? JSON.parse(p.meta_json) : null; } catch { /* ignora */ }
  return {
    id: p.id,
    status: p.status,
    erro: p.erro,
    criado_em: p.criado_em,
    origem_evento: p.origem_evento,
    origem_local: p.origem_local,
    registrado_por: p.registrado_por,
    tentativas: p.tentativas,
    tem_verso: Boolean(p.imagem_verso_key),
    dados,
    meta
  };
}

export async function listarFila(env, { status } = {}) {
  const abertos = ['na_fila', 'lendo', 'aguardando', 'erro'];
  const filtro = status && abertos.includes(status) ? [status] : abertos;
  const marcadores = filtro.map(() => '?').join(', ');

  const { results } = await env.DB.prepare(
    `SELECT * FROM pendentes WHERE status IN (${marcadores}) ORDER BY criado_em`
  ).bind(...filtro).all();

  const itens = (results || []).map(desempacotar);
  const contagem = { na_fila: 0, lendo: 0, aguardando: 0, erro: 0 };
  for (const i of itens) if (contagem[i.status] !== undefined) contagem[i.status]++;

  return { itens, contagem, total: itens.length };
}

export async function obterPendente(env, id) {
  const p = await env.DB.prepare('SELECT * FROM pendentes WHERE id = ?').bind(id).first();
  if (!p) return null;
  const item = desempacotar(p);
  // duplicados sao checados na hora da conferencia, nao na leitura:
  // outro cartao do mesmo evento pode ter entrado nesse meio tempo
  item.duplicados = item.dados ? await possiveisDuplicados(env.DB, item.dados) : [];
  return item;
}

/** Aprova o cartao conferido: vira contato definitivo e sai da fila. */
export async function confirmar(env, id, corpo, usuario) {
  const p = await env.DB.prepare('SELECT * FROM pendentes WHERE id = ?').bind(id).first();
  if (!p) return { ok: false, erro: 'Cartão não encontrado na fila.' };
  if (p.status === 'confirmado') return { ok: false, erro: 'Este cartão já foi conferido.' };

  const contato = montarContato({
    ...corpo,
    origem_evento: corpo.origem_evento || p.origem_evento,
    origem_local: corpo.origem_local || p.origem_local,
    imagem_key: p.imagem_key,       // as fotos continuam anexadas ao contato
    imagem_verso_key: p.imagem_verso_key,
    registrado_por: p.registrado_por || usuario,
    bruto_json: p.dados_json || ''
  });

  await inserir(env.DB, contato);
  await registrarEvento(env.DB, contato.id, 'criado', contato.nome, usuario);
  await env.DB.prepare(
    `UPDATE pendentes SET status = 'confirmado', contato_id = ?, atualizado_em = ? WHERE id = ?`
  ).bind(contato.id, agora(), id).run();

  return { ok: true, contato };
}

/** Descarta o cartao e apaga a foto - nada de dado pessoal sobrando a toa. */
export async function descartar(env, id, usuario) {
  const p = await env.DB.prepare('SELECT * FROM pendentes WHERE id = ?').bind(id).first();
  if (!p) return { ok: false, erro: 'Cartão não encontrado na fila.' };

  for (const chave of [p.imagem_key, p.imagem_verso_key]) {
    if (chave) await env.IMAGENS.delete(chave).catch(() => {});
  }
  await env.DB.prepare(
    `UPDATE pendentes SET status = 'descartado', imagem_key = NULL, imagem_verso_key = NULL,
       atualizado_em = ? WHERE id = ?`
  ).bind(agora(), id).run();
  await registrarEvento(env.DB, id, 'descartado', '', usuario);

  return { ok: true };
}

/** Manda ler de novo um cartao que deu erro. */
export async function reprocessar(env, id) {
  await env.DB.prepare(
    `UPDATE pendentes SET status = 'na_fila', tentativas = 0, erro = NULL, atualizado_em = ? WHERE id = ?`
  ).bind(agora(), id).run();
  return processar(env, id);
}

/** Serve a foto do cartao a partir do R2. */
export async function servirImagem(env, chave) {
  if (!chave) return new Response('Sem imagem.', { status: 404 });
  const obj = await env.IMAGENS.get(chave);
  if (!obj) return new Response('Imagem não encontrada.', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType || 'image/jpeg',
      // privado: e dado pessoal, nao pode ficar em cache compartilhado
      'cache-control': 'private, max-age=3600'
    }
  });
}
