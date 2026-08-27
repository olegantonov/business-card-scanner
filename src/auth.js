/**
 * Identificacao da equipe.
 *
 * Cada pessoa tem um codigo unico que serve ao mesmo tempo de senha e de
 * cracha: quem le o cartao nao digita mais o proprio nome, o codigo ja diz
 * quem e. O codigo nunca e gravado em texto claro - so o hash SHA-256.
 */

/** Cabecalhos HTTP so aceitam ASCII: a interface envia com encodeURIComponent. */
export function cabecalho(request, nome) {
  const bruto = request.headers.get(nome) || '';
  try { return decodeURIComponent(bruto); } catch { return bruto; }
}

export async function hashCodigo(codigo) {
  const bytes = new TextEncoder().encode(String(codigo).trim());
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Devolve { id, nome, papel } de quem fez a requisicao, ou null.
 *
 * O ACCESS_CODE do wrangler secret continua valendo como codigo mestre de
 * administracao - e por ele que se cadastra a equipe na primeira vez, e ele
 * evita ficar trancado para fora se a tabela de usuarios esvaziar.
 */
export async function identificar(request, env) {
  const codigo = cabecalho(request, 'x-acesso').trim();
  if (!codigo) return null;

  if (env.ACCESS_CODE && codigo === env.ACCESS_CODE) {
    return { id: 'mestre', nome: 'Administração', papel: 'admin' };
  }

  const hash = await hashCodigo(codigo);
  const u = await env.DB
    .prepare('SELECT id, nome, papel, ativo FROM usuarios WHERE codigo_hash = ?')
    .bind(hash)
    .first();

  if (!u || !u.ativo) return null;

  // registro do ultimo acesso, sem segurar a resposta
  env.DB.prepare('UPDATE usuarios SET ultimo_acesso = ? WHERE id = ?')
    .bind(new Date().toISOString(), u.id)
    .run()
    .catch(() => {});

  return { id: u.id, nome: u.nome, papel: u.papel };
}

export async function criarUsuario(db, { nome, codigo, papel }) {
  const registro = {
    id: crypto.randomUUID(),
    nome: String(nome || '').trim().slice(0, 80),
    codigo_hash: await hashCodigo(codigo),
    papel: papel === 'admin' ? 'admin' : 'equipe',
    criado_em: new Date().toISOString()
  };
  await db.prepare(
    'INSERT INTO usuarios (id, nome, codigo_hash, papel, ativo, criado_em) VALUES (?, ?, ?, ?, 1, ?)'
  ).bind(registro.id, registro.nome, registro.codigo_hash, registro.papel, registro.criado_em).run();
  return { id: registro.id, nome: registro.nome, papel: registro.papel };
}

export async function listarUsuarios(db) {
  const { results } = await db.prepare(
    'SELECT id, nome, papel, ativo, criado_em, ultimo_acesso FROM usuarios ORDER BY nome'
  ).all();
  return results || [];
}

/** Gera um codigo legivel, sem caracteres que se confundem (0/O, 1/l/I). */
export function sugerirCodigo() {
  const alfabeto = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const letras = [...bytes].map((b) => alfabeto[b % alfabeto.length]);
  return `${letras.slice(0, 5).join('')}-${letras.slice(5).join('')}`;
}
