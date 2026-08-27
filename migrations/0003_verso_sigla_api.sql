-- Frente e verso do cartao, sigla da instituicao, API de consulta e webhooks.
-- Aplicar:  npx wrangler d1 execute gabinete-cartoes --remote --file=./migrations/0003_verso_sigla_api.sql

-- Sigla da instituicao, separada do nome por extenso.
-- "CNPq" e "Conselho Nacional de Desenvolvimento Cientifico e Tecnologico"
-- passam a ser dois campos, e ambos entram na busca.
ALTER TABLE contatos ADD COLUMN sigla TEXT;

-- Verso do cartao (quando existe)
ALTER TABLE contatos ADD COLUMN imagem_verso_key TEXT;
ALTER TABLE pendentes ADD COLUMN imagem_verso_key TEXT;

-- Tokens de leitura para sistemas de terceiros. Guardados como hash SHA-256:
-- o token so aparece uma vez, na criacao.
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  escopo TEXT NOT NULL DEFAULT 'leitura',
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL,
  criado_por TEXT,
  ultimo_uso TEXT,
  chamadas INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens (token_hash);

-- Assinaturas de webhook: para onde avisar quando um contato muda.
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  url TEXT NOT NULL,
  segredo TEXT NOT NULL,             -- usado no HMAC-SHA256 da assinatura
  eventos TEXT NOT NULL,             -- lista separada por virgula
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL,
  criado_por TEXT,
  ultima_entrega TEXT,
  ultimo_status INTEGER,
  falhas_seguidas INTEGER NOT NULL DEFAULT 0
);

-- Ultimas entregas, para o admin enxergar por que um webhook nao chegou.
CREATE TABLE IF NOT EXISTS webhook_entregas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id TEXT NOT NULL,
  evento TEXT NOT NULL,
  contato_id TEXT,
  status INTEGER,
  erro TEXT,
  criado_em TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entregas_webhook ON webhook_entregas (webhook_id, criado_em DESC);
