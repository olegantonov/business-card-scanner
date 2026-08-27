-- Fila de leitura em segundo plano + login por codigo unico por pessoa.
-- Aplicar:  npx wrangler d1 execute gabinete-cartoes --remote --file=./migrations/0002_fila_usuarios.sql

-- Cada cartao fotografado entra aqui na hora, com status "na_fila".
-- A leitura pela IA acontece depois, sem prender a pessoa que esta escaneando.
CREATE TABLE IF NOT EXISTS pendentes (
  id TEXT PRIMARY KEY,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  -- na_fila | lendo | aguardando | erro | confirmado | descartado
  status TEXT NOT NULL DEFAULT 'na_fila',
  erro TEXT,
  imagem_key TEXT,
  mime TEXT,
  origem_evento TEXT,
  origem_local TEXT,
  registrado_por TEXT,
  dados_json TEXT,
  meta_json TEXT,
  tentativas INTEGER NOT NULL DEFAULT 0,
  contato_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_pendentes_status ON pendentes (status, criado_em);

-- Uma linha por pessoa da equipe. O codigo e guardado como hash SHA-256:
-- nem quem abre o banco consegue ler o codigo de alguem.
CREATE TABLE IF NOT EXISTS usuarios (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  codigo_hash TEXT NOT NULL UNIQUE,
  papel TEXT NOT NULL DEFAULT 'equipe',   -- equipe | admin
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL,
  ultimo_acesso TEXT
);

CREATE INDEX IF NOT EXISTS idx_usuarios_hash ON usuarios (codigo_hash);
