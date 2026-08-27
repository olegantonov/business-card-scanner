/**
 * Webhooks: avisam sistemas de terceiros quando um contato muda.
 *
 * Cada assinatura tem um segredo proprio. O corpo vai assinado em
 * HMAC-SHA256 no cabecalho "x-assinatura", para o outro lado ter certeza de
 * que a chamada partiu daqui e nao foi adulterada no caminho.
 */

export const EVENTOS = ['contato.criado', 'contato.atualizado', 'contato.excluido'];

/** Depois disso o webhook e desativado sozinho, para nao ficar batendo em porta morta. */
const MAX_FALHAS = 10;
const TIMEOUT_MS = 10_000;

export async function assinar(segredo, corpo) {
  const chave = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(segredo),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const assinatura = await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(corpo));
  return [...new Uint8Array(assinatura)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function novoSegredo() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return 'whsec_' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function entregar(env, hook, evento, dados) {
  const corpo = JSON.stringify({
    evento,
    enviado_em: new Date().toISOString(),
    dados
  });

  const entregaId = crypto.randomUUID();
  let status = null;
  let erro = null;

  try {
    const resp = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'cartoes-gabinete-webhook/1',
        'x-evento': evento,
        'x-entrega-id': entregaId,
        'x-assinatura': `sha256=${await assinar(hook.segredo, corpo)}`
      },
      body: corpo,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    status = resp.status;
    if (!resp.ok) erro = `HTTP ${resp.status}`;
  } catch (e) {
    erro = String(e?.message || e).slice(0, 300);
  }

  const ok = status >= 200 && status < 300;
  const falhas = ok ? 0 : hook.falhas_seguidas + 1;

  await env.DB.prepare(
    `UPDATE webhooks SET ultima_entrega = ?, ultimo_status = ?, falhas_seguidas = ?,
       ativo = ? WHERE id = ?`
  ).bind(
    new Date().toISOString(),
    status,
    falhas,
    falhas >= MAX_FALHAS ? 0 : 1,
    hook.id
  ).run();

  await env.DB.prepare(
    `INSERT INTO webhook_entregas (webhook_id, evento, contato_id, status, erro, criado_em)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(hook.id, evento, dados?.id || null, status, erro, new Date().toISOString()).run();

  return ok;
}

/**
 * Dispara um evento para todos os assinantes.
 * Chamar sempre dentro de ctx.waitUntil(): webhook lento nao pode segurar a
 * resposta de quem esta usando o sistema.
 */
export async function disparar(env, evento, dados) {
  if (!EVENTOS.includes(evento)) return 0;

  const { results } = await env.DB.prepare(
    `SELECT * FROM webhooks WHERE ativo = 1 AND (',' || eventos || ',') LIKE ?`
  ).bind(`%,${evento},%`).all();

  const hooks = results || [];
  await Promise.all(hooks.map((h) => entregar(env, h, evento, dados).catch(() => false)));
  return hooks.length;
}

/** Envia um evento de teste, para o desenvolvedor conferir a integracao. */
export async function testar(env, id) {
  const hook = await env.DB.prepare('SELECT * FROM webhooks WHERE id = ?').bind(id).first();
  if (!hook) return { ok: false, erro: 'Webhook não encontrado.' };
  const ok = await entregar(env, hook, 'contato.criado', {
    id: '00000000-0000-0000-0000-000000000000',
    nome: 'Contato de Teste',
    empresa: 'Exemplo',
    sigla: '',
    teste: true
  });
  return { ok, erro: ok ? null : 'A URL não respondeu com 2xx. Veja o histórico de entregas.' };
}

/** Limpa o log de entregas, deixando as ultimas 200 de cada webhook. */
export async function podarEntregas(env) {
  await env.DB.prepare(
    `DELETE FROM webhook_entregas WHERE id NOT IN (
       SELECT id FROM webhook_entregas ORDER BY criado_em DESC LIMIT 200
     )`
  ).run();
}
