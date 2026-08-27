/**
 * Camada de IA generativa: envia a imagem do cartao de visita para a API do
 * Google Gemini e devolve os dados ja estruturados e classificados.
 *
 * Suporta os dois formatos de API do Google:
 *  - "generate"     -> POST /v1beta/models/{modelo}:generateContent   (classico)
 *  - "interactions" -> POST /v1beta/interactions                      (novo, modelos Gemini 3+)
 * O modo "auto" escolhe pelo nome do modelo e faz fallback para o outro
 * formato caso o primeiro seja recusado.
 */

const BASE_PADRAO = 'https://generativelanguage.googleapis.com/v1beta';

export const SETORES = ['publico', 'privado', 'terceiro_setor', 'academico', 'midia', 'outro'];

export const SEGMENTOS = [
  'agronegocio', 'saude', 'educacao', 'infraestrutura', 'transporte', 'energia',
  'meio_ambiente', 'seguranca_publica', 'tecnologia', 'telecomunicacoes',
  'industria', 'comercio', 'servicos', 'financeiro', 'juridico', 'construcao',
  'turismo', 'cultura', 'esporte', 'assistencia_social', 'ciencia_pesquisa',
  'comunicacao_imprensa', 'politica_governo', 'religioso', 'outro'
];

export const PRIORIDADES = ['alta', 'media', 'baixa'];

const CAMPOS_TEXTO = [
  'nome', 'cargo', 'empresa', 'sigla', 'departamento', 'telefone', 'celular', 'email',
  'email_secundario', 'site', 'endereco', 'cidade', 'uf', 'cep', 'linkedin',
  'instagram', 'facebook', 'twitter', 'setor', 'segmento', 'prioridade',
  'resumo_ia', 'justificativa_prioridade'
];

const PROMPT = `Voce e um assistente do gabinete parlamentar responsavel por cadastrar os cartoes de visita recebidos pelo senador e pela equipe.

Analise a(s) imagem(ns) do cartao de visita e extraia TODOS os dados visiveis, depois classifique o contato.

Frente e verso:
- Voce pode receber DUAS imagens: a primeira e a FRENTE e a segunda e o VERSO do MESMO cartao.
- Trate as duas como um unico contato: some as informacoes, nao devolva dois registros.
- O que se repetir nos dois lados nao deve ser duplicado.
- Se um lado estiver em outro idioma, prefira o portugues nos campos e aproveite do outro lado so o que for exclusivo dele.
- Se o verso tiver apenas logotipo, arte ou nada legivel, ignore-o sem reclamar.

Siglas de instituicoes:
- Muita instituicao brasileira e conhecida pela sigla (CNPq, ANPD, Sebrae, Embrapa, UnB, TJDFT, Fiocruz, IBGE, MEC).
- Preencha "empresa" com o nome POR EXTENSO e "sigla" com a sigla, sempre que der para separar.
- Se o cartao trouxer os dois (ex.: "CNPq - Conselho Nacional de Desenvolvimento Cientifico e Tecnologico"), separe: sigla="CNPq", empresa="Conselho Nacional de Desenvolvimento Cientifico e Tecnologico".
- Se trouxer so a sigla e voce souber com seguranca o nome oficial, complete "empresa". Se nao tiver certeza, repita a sigla em "empresa" e diga em "observacoes_leitura" que nao foi possivel expandir.
- Se trouxer so o nome por extenso e houver sigla consagrada, preencha as duas.
- Nao invente sigla para empresa privada que nao usa uma.

Regras de extracao:
- Transcreva exatamente o que esta impresso, sem inventar nada. Campo ausente = string vazia "".
- Telefones no formato "+55 (61) 99999-9999" quando o DDI/DDD estiver claro; caso contrario mantenha como impresso.
- Separe telefone fixo (telefone) de celular/WhatsApp (celular). Se houver apenas um numero e nao der para saber, use telefone.
- E-mails sempre em minusculas. Site sem "http://" se nao estiver impresso assim.
- Redes sociais: guarde o usuario ou a URL como esta no cartao (ex: "@joao.silva" ou "linkedin.com/in/joaosilva").
- "outras_redes" recebe qualquer outra rede/contato (WhatsApp Business, Telegram, YouTube, X, etc.).
- Se o cartao estiver ilegivel ou nao for um cartao de visita, devolva "e_cartao_valido": false e explique em "observacoes_leitura".

Regras de classificacao:
- setor: publico (orgao/empresa estatal, prefeitura, governo, autarquia), privado (empresa), terceiro_setor (ONG, associacao, sindicato, fundacao, cooperativa, instituto sem fins lucrativos, sistema S), academico (universidade, instituto de pesquisa), midia (imprensa, radio, TV), outro.
- segmento: area de atuacao principal, usando a lista permitida.
- prioridade para o gabinete: alta (autoridade, cargo de direcao, presidente/diretor/secretario/prefeito, imprensa relevante ou pauta estrategica), media (gerencia, coordenacao, representacao institucional), baixa (contato operacional ou sem relacao aparente com pautas publicas).
- temas: 1 a 4 pautas legislativas provaveis de interesse desse contato (ex: "credito rural", "saneamento", "seguranca publica").
- resumo_ia: uma frase curta (max. 200 caracteres) dizendo quem e a pessoa e por que interessa ao gabinete.
- confianca: 0 a 1, o quanto voce confia na leitura do cartao.

Responda SOMENTE com o JSON no formato pedido, em portugues do Brasil.`;

const CAMPOS_JSON = {
  e_cartao_valido: { type: 'boolean' },
  nome: { type: 'string' },
  cargo: { type: 'string' },
  empresa: { type: 'string' },
  sigla: { type: 'string' },
  departamento: { type: 'string' },
  telefone: { type: 'string' },
  celular: { type: 'string' },
  email: { type: 'string' },
  email_secundario: { type: 'string' },
  site: { type: 'string' },
  endereco: { type: 'string' },
  cidade: { type: 'string' },
  uf: { type: 'string' },
  cep: { type: 'string' },
  linkedin: { type: 'string' },
  instagram: { type: 'string' },
  facebook: { type: 'string' },
  twitter: { type: 'string' },
  outras_redes: { type: 'array', items: { type: 'string' } },
  setor: { type: 'string', enum: SETORES },
  segmento: { type: 'string', enum: SEGMENTOS },
  prioridade: { type: 'string', enum: PRIORIDADES },
  justificativa_prioridade: { type: 'string' },
  temas: { type: 'array', items: { type: 'string' } },
  resumo_ia: { type: 'string' },
  confianca: { type: 'number' },
  observacoes_leitura: { type: 'string' }
};

const SCHEMA = {
  type: 'object',
  properties: CAMPOS_JSON,
  required: ['e_cartao_valido', 'nome', 'setor', 'segmento', 'prioridade', 'confianca']
};

function escolherModo(modelo, modoConfigurado) {
  if (modoConfigurado === 'generate' || modoConfigurado === 'interactions') return modoConfigurado;
  return /^gemini-([3-9]|\d{2})/.test(modelo) ? 'interactions' : 'generate';
}

function corpoGenerateContent(modelo, imagens, base) {
  return {
    url: `${base}/models/${encodeURIComponent(modelo)}:generateContent`,
    body: {
      contents: [{
        role: 'user',
        parts: [
          { text: PROMPT },
          // a ordem importa: primeira imagem = frente, segunda = verso
          ...imagens.map((im) => ({ inline_data: { mime_type: im.mime, data: im.base64 } }))
        ]
      }],
      generationConfig: {
        temperature: 0.1,
        response_mime_type: 'application/json',
        response_schema: SCHEMA
      }
    }
  };
}

function corpoInteractions(modelo, imagens, base) {
  return {
    url: `${base}/interactions`,
    body: {
      model: modelo,
      input: [
        ...imagens.map((im) => ({ type: 'image', mime_type: im.mime, data: im.base64 })),
        { type: 'text', text: PROMPT }
      ],
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: SCHEMA
      },
      store: false
    }
  };
}

/**
 * Procura, em qualquer formato de resposta da API, o primeiro texto que seja
 * um JSON valido. Assim o codigo continua funcionando se o Google mudar o
 * envelope da resposta.
 */
export function extrairJson(resposta) {
  const encontrados = [];

  const visitar = (no) => {
    if (no == null) return;
    if (typeof no === 'string') {
      encontrados.push(no);
      return;
    }
    if (Array.isArray(no)) {
      no.forEach(visitar);
      return;
    }
    if (typeof no === 'object') {
      for (const [chave, valor] of Object.entries(no)) {
        if (typeof valor === 'string' && !/^(text|output_text|content|json|data)$/i.test(chave)) continue;
        visitar(valor);
      }
    }
  };

  visitar(resposta);

  for (const texto of encontrados) {
    const limpo = texto.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    if (!limpo.startsWith('{')) continue;
    try {
      const obj = JSON.parse(limpo);
      if (obj && typeof obj === 'object') return obj;
    } catch { /* tenta o proximo */ }
  }
  return null;
}

async function chamar(url, body, apiKey) {
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    return { ok: false, status: 0, json: null, texto: `falha de rede: ${e?.message || e}` };
  }
  const texto = await resp.text();
  let json = null;
  try { json = JSON.parse(texto); } catch { /* resposta nao-JSON */ }
  return { ok: resp.ok, status: resp.status, json, texto };
}

/** Normaliza o que veio da IA para o formato que o banco espera. */
export function normalizar(dados) {
  const saida = {};
  for (const campo of CAMPOS_TEXTO) {
    const valor = dados[campo];
    saida[campo] = typeof valor === 'string' ? valor.trim() : '';
  }
  saida.email = saida.email.toLowerCase();
  saida.email_secundario = saida.email_secundario.toLowerCase();
  saida.uf = saida.uf.toUpperCase().slice(0, 2);

  if (!SETORES.includes(saida.setor)) saida.setor = 'outro';
  if (!SEGMENTOS.includes(saida.segmento)) saida.segmento = 'outro';
  if (!PRIORIDADES.includes(saida.prioridade)) saida.prioridade = 'media';

  const lista = (v) => Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
  saida.temas = lista(dados.temas).slice(0, 6);
  saida.outras_redes = lista(dados.outras_redes).slice(0, 6);

  const c = Number(dados.confianca);
  saida.confianca = Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : null;
  saida.e_cartao_valido = dados.e_cartao_valido !== false;
  saida.observacoes_leitura = typeof dados.observacoes_leitura === 'string' ? dados.observacoes_leitura.trim() : '';
  return saida;
}

/**
 * Le um cartao de visita.
 * @param {{apiKey:string, modelo:string, modo:string}} config
 * @param {{base64:string, mime:string}|Array} imagens frente, ou [frente, verso]
 */
export async function lerCartao(config, imagens) {
  const lados = Array.isArray(imagens) ? imagens.filter(Boolean) : [imagens];
  if (!lados.length) return { ok: false, erro: 'Nenhuma imagem para ler.' };
  const modelo = config.modelo || 'gemini-3.6-flash';
  const base = (config.baseUrl || BASE_PADRAO).replace(/\/$/, '');
  const modo = escolherModo(modelo, config.modo);
  const montar = { generate: corpoGenerateContent, interactions: corpoInteractions };
  const ordem = modo === 'interactions' ? ['interactions', 'generate'] : ['generate', 'interactions'];

  const erros = [];
  for (const tentativa of ordem) {
    const { url, body } = montar[tentativa](modelo, lados, base);
    const r = await chamar(url, body, config.apiKey);

    if (!r.ok) {
      const msg = r.json?.error?.message || r.texto?.slice(0, 300) || `HTTP ${r.status}`;
      erros.push(`[${tentativa}] ${r.status}: ${msg}`);
      // 401/403 = chave invalida: nao adianta tentar o outro formato
      if (r.status === 401 || r.status === 403) break;
      continue;
    }

    const dados = extrairJson(r.json);
    if (!dados) {
      erros.push(`[${tentativa}] resposta sem JSON reconhecivel`);
      continue;
    }
    return { ok: true, dados: normalizar(dados), modelo, endpoint: tentativa, lados: lados.length };
  }

  return { ok: false, erro: erros.join(' | ') || 'Falha desconhecida ao chamar a API do Gemini' };
}
