-- Esquema do scanner de cartoes de visita
-- Aplicar:  npx wrangler d1 execute gabinete-cartoes --remote --file=./migrations/0001_init.sql

CREATE TABLE IF NOT EXISTS contatos (
  id TEXT PRIMARY KEY,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  nome TEXT,
  cargo TEXT,
  empresa TEXT,
  departamento TEXT,
  telefone TEXT,
  celular TEXT,
  email TEXT,
  email_secundario TEXT,
  site TEXT,
  endereco TEXT,
  cidade TEXT,
  uf TEXT,
  cep TEXT,
  linkedin TEXT,
  instagram TEXT,
  facebook TEXT,
  twitter TEXT,
  outras_redes TEXT,
  setor TEXT,
  segmento TEXT,
  prioridade TEXT,
  temas TEXT,
  resumo_ia TEXT,
  origem_evento TEXT,
  origem_local TEXT,
  data_captura TEXT,
  observacoes TEXT,
  status TEXT NOT NULL DEFAULT 'novo',
  confianca REAL,
  registrado_por TEXT,
  imagem_key TEXT,
  bruto_json TEXT,
  busca TEXT
);

CREATE INDEX IF NOT EXISTS idx_contatos_criado_em ON contatos (criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_contatos_setor ON contatos (setor);
CREATE INDEX IF NOT EXISTS idx_contatos_prioridade ON contatos (prioridade);
CREATE INDEX IF NOT EXISTS idx_contatos_status ON contatos (status);
CREATE INDEX IF NOT EXISTS idx_contatos_email ON contatos (email);
CREATE INDEX IF NOT EXISTS idx_contatos_busca ON contatos (busca);

CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contato_id TEXT,
  acao TEXT NOT NULL,
  detalhe TEXT,
  usuario TEXT,
  criado_em TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eventos_contato ON eventos (contato_id);
