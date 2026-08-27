/**
 * Scanner de Cartoes de Visita
 * Cloudflare Worker: serve a interface, a API interna e a API publica /v1.
 */

import { SETORES, SEGMENTOS, PRIORIDADES } from './gemini.js';
import {
  montarContato, atualizar, listar, listarParaExport, estatisticas, registrarEvento,
  paraCsv, paraXlsx
} from './db.js';
import { identificar, criarUsuario, listarUsuarios, sugerirCodigo } from './auth.js';
import {
  enfileirar, anexarVerso, processar, varrerFila, listarFila, obterPendente,
  confirmar, descartar, reprocessar, servirImagem, emLote
} from './fila.js';
import { rotearPublica, contatoPublico, novoToken, hashToken } from './publica.js';
import { disparar, EVENTOS, novoSegredo, testar, podarEntregas } from './webhooks.js';

const json = (dados, status = 200) => new Response(JSON.stringify(dados), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' }
});

const erro = (mensagem, status = 400) => json({ erro: mensagem }, status);

/** Aceita data URL ("data:image/jpeg;base64,....") ou base64 puro. */
function lerImagem(bruto, mimePadrao = 'image/jpeg') {
  if (typeof bruto !== 'string' || bruto.length < 100) return null;
  const m = bruto.match(/^data:([^;]+);base64,(.*)$/s);
  const mime = m ? m[1] : mimePadrao;
  const base64 = m ? m[2] : bruto;
  if (!/^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(mime)) return null;
  // limite de seguranca: ~8 MB em base64
  if (base64.length > 11_000_000) return null;
  return { mime, base64 };
}

/* ---------- Fila ---------- */

async function rotaEnfileirar(request, env, ctx, usuario) {
  if (!env.GEMINI_API_KEY) {
    return erro('GEMINI_API_KEY nao configurada. Rode: npx wrangler secret put GEMINI_API_KEY', 500);
  }
  if (!env.IMAGENS) {
    return erro('Armazenamento de imagens (R2) nao configurado neste Worker.', 500);
  }
  const corpo = await request.json().catch(() => null);
  const frente = lerImagem(corpo?.imagem, corpo?.mime);
  if (!frente) return erro('Imagem invalida ou muito grande. Envie JPEG/PNG/WEBP de ate 8 MB.');

  // o verso e opcional: cartao de um lado so continua funcionando igual
  const verso = corpo?.verso ? lerImagem(corpo.verso, corpo?.mime) : null;
  if (corpo?.verso && !verso) return erro('A imagem do verso é inválida ou muito grande.');

  const { id } = await enfileirar(env, {
    base64: frente.base64,
    mime: frente.mime,
    verso,
    origem_evento: corpo.origem_evento,
    origem_local: corpo.origem_local,
    usuario: usuario.nome
  });

  // a leitura pela IA segue depois que esta resposta ja foi entregue
  ctx.waitUntil(processar(env, id));

  return json({ ok: true, id, status: 'na_fila', tem_verso: Boolean(verso) }, 202);
}

async function rotaVerso(request, env, ctx, id) {
  const corpo = await request.json().catch(() => null);
  const verso = lerImagem(corpo?.imagem, corpo?.mime);
  if (!verso) return erro('Imagem do verso inválida ou muito grande.');

  const r = await anexarVerso(env, id, verso);
  if (!r.ok) return erro(r.erro, 409);

  ctx.waitUntil(processar(env, id));
  return json({ ok: true, id, status: 'na_fila' }, 202);
}

async function rotaConfirmar(request, env, ctx, id, usuario) {
  const corpo = await request.json().catch(() => null);
  if (!corpo) return erro('Corpo invalido.');
  if (!String(corpo.nome || '').trim() && !String(corpo.empresa || '').trim()) {
    return erro('Informe pelo menos o nome ou a empresa.');
  }
  const r = await confirmar(env, id, corpo, usuario.nome);
  if (!r.ok) return erro(r.erro, 409);

  ctx.waitUntil(disparar(env, 'contato.criado', contatoPublico(r.contato)));
  return json(r, 201);
}

/* ---------- Contatos ---------- */

async function rotaAtualizar(request, env, ctx, id, usuario) {
  const atual = await env.DB.prepare('SELECT * FROM contatos WHERE id = ?').bind(id).first();
  if (!atual) return erro('Contato nao encontrado.', 404);
  const corpo = await request.json().catch(() => null);
  if (!corpo) return erro('Corpo invalido.');
  const contato = montarContato(
    { ...atual, ...corpo, registrado_por: atual.registrado_por || usuario.nome },
    { id, criado_em: atual.criado_em }
  );
  await atualizar(env.DB, contato);
  await registrarEvento(env.DB, id, 'editado', contato.nome, usuario.nome);

  ctx.waitUntil(disparar(env, 'contato.atualizado', contatoPublico(contato)));
  return json({ ok: true, contato });
}

async function rotaExcluir(env, ctx, id, usuario) {
  const atual = await env.DB.prepare('SELECT * FROM contatos WHERE id = ?').bind(id).first();
  if (!atual) return erro('Contato nao encontrado.', 404);

  for (const chave of [atual.imagem_key, atual.imagem_verso_key]) {
    if (chave && env.IMAGENS) await env.IMAGENS.delete(chave).catch(() => {});
  }
  await env.DB.prepare('DELETE FROM contatos WHERE id = ?').bind(id).run();
  await registrarEvento(env.DB, id, 'excluido', atual.nome || '', usuario.nome);

  ctx.waitUntil(disparar(env, 'contato.excluido', { id, nome: atual.nome || null }));
  return json({ ok: true });
}

/**
 * Planilha de contatos: .xlsx (abre direto) ou .csv (mesmo conteudo, para quem
 * vai importar em outro sistema). Respeita os filtros da tela e leva todas as
 * linhas que casarem, nao so a primeira pagina.
 */
async function rotaExportar(env, url, formato) {
  const filtros = Object.fromEntries(url.searchParams);
  const contatos = await listarParaExport(env.DB, filtros);
  const dia = new Date().toISOString().slice(0, 10);
  const nome = `contatos-${dia}.${formato}`;

  const corpo = formato === 'xlsx' ? paraXlsx(contatos, 'Contatos') : paraCsv(contatos);
  const tipo = formato === 'xlsx'
    ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    : 'text/csv; charset=utf-8';

  return new Response(corpo, {
    headers: {
      'content-type': tipo,
      'content-disposition': `attachment; filename="${nome}"`,
      // planilha de dado pessoal nao fica em cache de ninguem
      'cache-control': 'no-store'
    }
  });
}

async function rotaLote(request, env, ctx, usuario) {
  const corpo = await request.json().catch(() => null);
  const acao = String(corpo?.acao || '');
  const ids = Array.isArray(corpo?.ids)
    ? [...new Set(corpo.ids.map(String).filter((i) => /^[\w-]+$/.test(i)))]
    : [];

  if (!['confirmar', 'descartar', 'reprocessar'].includes(acao)) {
    return erro('Ação inválida. Use confirmar, descartar ou reprocessar.');
  }
  if (!ids.length) return erro('Selecione ao menos um cartão.');
  if (ids.length > 50) return erro('Faça em lotes de até 50 cartões.');

  const r = await emLote(env, { acao, ids, usuario: usuario.nome });
  if (!r.ok) return erro(r.erro);

  for (const contato of r.contatos) {
    ctx.waitUntil(disparar(env, 'contato.criado', contatoPublico(contato)));
  }
  // o lote de releitura so devolveu os cartoes para a fila; a IA roda agora
  if (acao === 'reprocessar' && r.feitos.length) ctx.waitUntil(varrerFila(env, r.feitos.length));

  return json({
    ok: true,
    acao,
    total: ids.length,
    feitos: r.feitos.length,
    falhas: r.falhas
  });
}

/* ---------- Equipe, tokens e webhooks (so admin) ---------- */

async function rotaCriarUsuario(request, env) {
  const corpo = await request.json().catch(() => null);
  const nome = String(corpo?.nome || '').trim();
  const codigo = String(corpo?.codigo || '').trim();
  if (!nome) return erro('Informe o nome da pessoa.');
  if (codigo.length < 6) return erro('O codigo precisa ter ao menos 6 caracteres.');
  try {
    return json({ ok: true, usuario: await criarUsuario(env.DB, { nome, codigo, papel: corpo.papel }) }, 201);
  } catch (e) {
    if (String(e?.message || e).includes('UNIQUE')) return erro('Esse codigo ja esta em uso. Gere outro.', 409);
    throw e;
  }
}

async function rotaCriarToken(request, env, usuario) {
  const corpo = await request.json().catch(() => null);
  const nome = String(corpo?.nome || '').trim();
  if (!nome) return erro('Dê um nome ao token (ex.: "Portal institucional").');

  const token = novoToken();
  await env.DB.prepare(
    `INSERT INTO api_tokens (id, nome, token_hash, escopo, ativo, criado_em, criado_por)
     VALUES (?, ?, ?, 'leitura', 1, ?, ?)`
  ).bind(crypto.randomUUID(), nome.slice(0, 80), await hashToken(token), new Date().toISOString(), usuario.nome).run();

  // o token so aparece aqui, uma unica vez
  return json({ ok: true, nome, token }, 201);
}

async function rotaCriarWebhook(request, env, usuario) {
  const corpo = await request.json().catch(() => null);
  const nome = String(corpo?.nome || '').trim();
  const url = String(corpo?.url || '').trim();
  const eventos = Array.isArray(corpo?.eventos) ? corpo.eventos.filter((e) => EVENTOS.includes(e)) : [];

  if (!nome) return erro('Dê um nome ao webhook.');
  if (!/^https:\/\/.+/i.test(url)) return erro('A URL precisa começar com https:// — dado pessoal não trafega em HTTP.');
  if (!eventos.length) return erro(`Escolha ao menos um evento: ${EVENTOS.join(', ')}`);

  const segredo = novoSegredo();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO webhooks (id, nome, url, segredo, eventos, ativo, criado_em, criado_por)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
  ).bind(id, nome.slice(0, 80), url, segredo, eventos.join(','), new Date().toISOString(), usuario.nome).run();

  // o segredo so aparece aqui, uma unica vez
  return json({ ok: true, id, nome, url, eventos, segredo }, 201);
}

export default {
  /** Cron Trigger: retoma cartoes que ficaram para tras e poda o log. */
  async scheduled(evento, env, ctx) {
    ctx.waitUntil(varrerFila(env, 10));
    ctx.waitUntil(podarEntregas(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Em dominio proprio a Cloudflare tambem atende em HTTP puro. Sem isto, o
    // codigo de acesso (cabecalho x-acesso) trafegaria em texto claro se alguem
    // digitasse o endereco sem "https://".
    if (url.protocol === 'http:') {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }

    // API publica de consulta, autenticada por Bearer token
    if (url.pathname.startsWith('/v1/')) {
      try {
        return await rotearPublica(request, env, url);
      } catch (e) {
        return json({ erro: { codigo: 'erro_interno', mensagem: String(e?.message || e) } }, 500);
      }
    }

    const caminho = url.pathname;

    if (!caminho.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (caminho === '/api/config') {
      return json({
        orgao: env.ORGAO || '',
        gabinete: env.NOME_GABINETE || 'Gabinete',
        modelo: env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
        setores: SETORES,
        segmentos: SEGMENTOS,
        prioridades: PRIORIDADES,
        eventos_webhook: EVENTOS
      });
    }

    try {
      const usuario = await identificar(request, env);
      if (!usuario) return erro('Código de acesso inválido.', 401);

      // a interface chama isto ao entrar, para descobrir de quem e o codigo
      if (caminho === '/api/entrar') {
        return json({ ok: true, nome: usuario.nome, papel: usuario.papel });
      }

      const metodo = request.method;
      const idContato = caminho.match(/^\/api\/contatos\/([\w-]+)$/);
      const imgContato = caminho.match(/^\/api\/contatos\/([\w-]+)\/imagem(\/verso)?$/);
      const idFila = caminho.match(/^\/api\/fila\/([\w-]+)$/);
      const imgFila = caminho.match(/^\/api\/fila\/([\w-]+)\/imagem(\/verso)?$/);
      const acaoFila = caminho.match(/^\/api\/fila\/([\w-]+)\/(confirmar|reprocessar|verso)$/);
      const idUsuario = caminho.match(/^\/api\/usuarios\/([\w-]+)$/);
      const idToken = caminho.match(/^\/api\/tokens\/([\w-]+)$/);
      const idHook = caminho.match(/^\/api\/webhooks\/([\w-]+)$/);
      const testeHook = caminho.match(/^\/api\/webhooks\/([\w-]+)\/testar$/);

      /* fila */
      if (caminho === '/api/fila' && metodo === 'POST') {
        return await rotaEnfileirar(request, env, ctx, usuario);
      }
      if (caminho === '/api/fila/lote' && metodo === 'POST') {
        return await rotaLote(request, env, ctx, usuario);
      }
      if (caminho === '/api/fila' && metodo === 'GET') {
        // aproveita a visita para retomar o que travou, sem depender so do cron
        ctx.waitUntil(varrerFila(env, 3));
        return json(await listarFila(env, Object.fromEntries(url.searchParams)));
      }
      if (imgFila && metodo === 'GET') {
        const p = await env.DB.prepare('SELECT imagem_key, imagem_verso_key FROM pendentes WHERE id = ?')
          .bind(imgFila[1]).first();
        return servirImagem(env, imgFila[2] ? p?.imagem_verso_key : p?.imagem_key);
      }
      if (idFila && metodo === 'GET') {
        const item = await obterPendente(env, idFila[1]);
        return item ? json(item) : erro('Cartão não encontrado.', 404);
      }
      if (acaoFila && metodo === 'POST') {
        const [, id, acao] = acaoFila;
        if (acao === 'confirmar') return await rotaConfirmar(request, env, ctx, id, usuario);
        if (acao === 'verso') return await rotaVerso(request, env, ctx, id);
        await reprocessar(env, id);
        return json({ ok: true });
      }
      if (idFila && metodo === 'DELETE') {
        const r = await descartar(env, idFila[1], usuario.nome);
        return r.ok ? json(r) : erro(r.erro, 404);
      }

      /* contatos */
      if (caminho === '/api/contatos' && metodo === 'GET') {
        return json(await listar(env.DB, Object.fromEntries(url.searchParams)));
      }
      if (caminho === '/api/estatisticas' && metodo === 'GET') {
        return json(await estatisticas(env.DB));
      }
      if (caminho === '/api/export.csv' && metodo === 'GET') return await rotaExportar(env, url, 'csv');
      if (caminho === '/api/export.xlsx' && metodo === 'GET') return await rotaExportar(env, url, 'xlsx');
      if (imgContato && metodo === 'GET') {
        const c = await env.DB.prepare('SELECT imagem_key, imagem_verso_key FROM contatos WHERE id = ?')
          .bind(imgContato[1]).first();
        return servirImagem(env, imgContato[2] ? c?.imagem_verso_key : c?.imagem_key);
      }
      if (idContato && metodo === 'GET') {
        const c = await env.DB.prepare('SELECT * FROM contatos WHERE id = ?').bind(idContato[1]).first();
        return c ? json(c) : erro('Contato nao encontrado.', 404);
      }
      if (idContato && (metodo === 'PUT' || metodo === 'PATCH')) {
        return await rotaAtualizar(request, env, ctx, idContato[1], usuario);
      }
      if (idContato && metodo === 'DELETE') return await rotaExcluir(env, ctx, idContato[1], usuario);

      /* administracao */
      const soAdmin = /^\/api\/(usuarios|tokens|webhooks)/.test(caminho);
      if (soAdmin && usuario.papel !== 'admin') {
        return erro('Só a administração pode acessar esta área.', 403);
      }

      if (caminho === '/api/usuarios' && metodo === 'GET') {
        return json({ usuarios: await listarUsuarios(env.DB), sugestao: sugerirCodigo() });
      }
      if (caminho === '/api/usuarios' && metodo === 'POST') return await rotaCriarUsuario(request, env);
      if (idUsuario && metodo === 'DELETE') {
        await env.DB.prepare('UPDATE usuarios SET ativo = 0 WHERE id = ?').bind(idUsuario[1]).run();
        return json({ ok: true });
      }

      if (caminho === '/api/tokens' && metodo === 'GET') {
        const { results } = await env.DB.prepare(
          `SELECT id, nome, escopo, ativo, criado_em, criado_por, ultimo_uso, chamadas
           FROM api_tokens ORDER BY criado_em DESC`
        ).all();
        return json({ tokens: results || [] });
      }
      if (caminho === '/api/tokens' && metodo === 'POST') return await rotaCriarToken(request, env, usuario);
      if (idToken && metodo === 'DELETE') {
        await env.DB.prepare('UPDATE api_tokens SET ativo = 0 WHERE id = ?').bind(idToken[1]).run();
        return json({ ok: true });
      }

      if (caminho === '/api/webhooks' && metodo === 'GET') {
        const { results } = await env.DB.prepare(
          `SELECT id, nome, url, eventos, ativo, criado_em, criado_por,
                  ultima_entrega, ultimo_status, falhas_seguidas
           FROM webhooks ORDER BY criado_em DESC`
        ).all();
        const { results: entregas } = await env.DB.prepare(
          `SELECT webhook_id, evento, status, erro, criado_em
           FROM webhook_entregas ORDER BY criado_em DESC LIMIT 20`
        ).all();
        return json({ webhooks: results || [], entregas: entregas || [], eventos: EVENTOS });
      }
      if (caminho === '/api/webhooks' && metodo === 'POST') return await rotaCriarWebhook(request, env, usuario);
      if (testeHook && metodo === 'POST') return json(await testar(env, testeHook[1]));
      if (idHook && metodo === 'DELETE') {
        await env.DB.prepare('DELETE FROM webhooks WHERE id = ?').bind(idHook[1]).run();
        return json({ ok: true });
      }

      return erro('Rota nao encontrada.', 404);
    } catch (e) {
      return erro(`Erro interno: ${e?.message || e}`, 500);
    }
  }
};
