# Scanner de Cartões de Visita

Sistema web para digitalizar cartões de visita com IA generativa: a foto do cartão é
enviada para a **API do Google Gemini**, que lê os dados, classifica o contato
(setor, segmento, prioridade e temas de interesse) e devolve tudo pronto para revisão.
Depois de conferido, o contato é gravado em um banco **Cloudflare D1**.

Pensado para quem coleta cartões em eventos: abre no navegador do celular, fotografa
um cartão atrás do outro sem esperar a IA, e a conferência acontece depois, com calma.

Roda inteiro na borda da Cloudflare (Workers + D1 + R2). Sem servidor para manter,
e o plano gratuito atende com folga o volume de um gabinete ou de uma assessoria.

---

## O que ele faz

- Foto pela câmera ao vivo (a câmera fica aberta: fotografe um cartão atrás do outro), upload de vários arquivos, arrastar-soltar ou colar (Ctrl+V)
- **Envio instantâneo**: o cartão entra numa fila e volta em ~1,5s. A leitura pela IA acontece em segundo plano, sem prender quem está escaneando
- **Envio em lote**: escolha vários arquivos de uma vez e eles sobem em sequência, com o andamento na tela
- **Frente e verso**: fotografe os dois lados e a IA junta tudo num contato só, sem duplicar
- **Siglas separadas do nome**: "CNPq" e "Conselho Nacional de Desenvolvimento Científico e Tecnológico" viram dois campos, e a busca acha pelos dois
- Leitura por IA: nome, cargo, empresa, sigla, telefones, e-mails, site, endereço e redes sociais
- Classificação automática: setor, segmento, prioridade para o gabinete, temas de interesse e um resumo de uma linha
- **Aba de conferência**: a foto do cartão fica lado a lado com o que a IA leu, para comparar campo por campo antes de salvar
- **Conferência um a um**: salvou, já abre o próximo cartão da fila, sem voltar para a lista
- **Aprovação em lote**: marque os cartões cuja leitura veio limpa e grave todos de uma vez; descartar e mandar reler também funcionam em lote
- Aviso de contato duplicado (mesmo e-mail, mesmo telefone ou mesmo nome+empresa), checado na hora da conferência
- Cada pessoa da equipe entra com o **próprio código** — é ele que identifica quem cadastrou cada contato
- Busca (ignora acentos) e filtros por setor, segmento, prioridade e situação
- Painel com totais por setor, prioridade e segmento
- **Planilha de contatos em `.xlsx`** (abre no Excel com um clique duplo) ou em CSV, respeitando os filtros da tela
- **API de consulta** (somente leitura) e **webhooks** assinados para outros sistemas — documentação em `/docs`
- Campos de origem: evento e local, preenchidos uma vez e reaproveitados no mesmo evento

## Como funciona

```
Celular/navegador  ──foto──►  Worker  ──►  R2 (foto)  +  D1 (fila)
                                 │                          │
                          resposta em ~1,5s          em segundo plano:
                          "próximo cartão"           Gemini lê e classifica
                                                            │
                                              aba de Conferência: foto x dados
                                                            │
                                                    D1 (contato definitivo)
```

O cartão nunca fica esperando a IA. Ele é gravado na hora e a leitura roda depois,
via `ctx.waitUntil()`. Se o Worker for encerrado no meio, o cartão volta para
`na_fila` e um Cron Trigger (a cada 2 minutos) retoma — nada se perde.

A chave da API fica **no servidor** (Cloudflare secret), nunca no navegador.

## Instalação passo a passo

### 1. Pré-requisitos

- Node.js 18+ instalado
- Conta na Cloudflare (o plano gratuito atende bem este uso)
- Chave da API do Google Gemini — crie em <https://aistudio.google.com/apikey>

### 2. Instalar as dependências

```bash
cd cartoes-visita
npm install
```

### 3. Configuração

```bash
cp wrangler.toml.example wrangler.toml
```

Abra o `wrangler.toml` e preencha `database_id` (passo seguinte), o domínio em
`[[routes]]` (ou comente o bloco) e `ORGAO`/`NOME_GABINETE`. Esse arquivo **não vai
para o Git**: ele identifica a sua instalação.

### 4. Banco de dados

Crie o banco e o bucket na sua conta e anote o `database_id` no `wrangler.toml`:

```bash
npx wrangler d1 create cartoes-visita         # anote o novo id no wrangler.toml
npx wrangler d1 execute cartoes-visita --remote --file=./migrations/0001_init.sql
npx wrangler d1 execute cartoes-visita --remote --file=./migrations/0002_fila_usuarios.sql
npx wrangler d1 execute cartoes-visita --remote --file=./migrations/0003_verso_sigla_api.sql
```

As fotos dos cartões ficam num bucket R2 chamado `cartoes-imagens` (já criado).
Para recriar: `npx wrangler r2 bucket create cartoes-imagens`.

### 5. Rodar na sua máquina (teste local)

Crie o arquivo `.dev.vars` (copie de `.dev.vars.example`):

```
GEMINI_API_KEY="sua-chave-aqui"
```

E rode:

```bash
npx wrangler d1 execute cartoes-visita --local --file=./migrations/0001_init.sql
npm run dev
```

Abra <http://localhost:8787>. Em modo local o banco é uma cópia na sua máquina —
nada vai para a nuvem.

### 6. Publicar

```bash
npx wrangler login
npx wrangler secret put GEMINI_API_KEY     # cola a chave do Google
npx wrangler secret put ACCESS_CODE        # senha que a equipe vai digitar ao entrar
npm run deploy
```

O endereço aparece no fim do deploy. Se você configurou um domínio próprio no bloco
`[[routes]]`, o wrangler cria o registro DNS sozinho e desliga o endereço `workers.dev`.

Envie o link para a equipe e peça que adicionem à tela inicial do celular.

> A câmera ao vivo depende de HTTPS — o navegador bloqueia `getUserMedia` em HTTP puro.
> Como arquivos estáticos são servidos pela camada de assets da Cloudflare antes do
> Worker rodar, o redirect embutido em `src/index.js` não alcança a página inicial:
> ligue **Always Use HTTPS** em SSL/TLS → Edge Certificates no painel da zona.

> **Importante:** enquanto `ACCESS_CODE` não estiver configurado, qualquer pessoa com o
> link consegue usar o sistema. Configure antes de compartilhar.

---

## Configuração

No `wrangler.toml`, seção `[vars]`:

| Variável | Para que serve | Padrão |
|---|---|---|
| `GEMINI_MODEL` | Modelo do Gemini usado na leitura | `gemini-3.5-flash-lite` |
| `GEMINI_API_MODE` | `auto`, `generate` (endpoint clássico) ou `interactions` (novo) | `generate` |
| `ORGAO` | Instituição na faixa do topo. Vazio = sem faixa | `` |
| `NOME_GABINETE` | Nome exibido abaixo da instituição | `Gabinete` |

Segredos (via `wrangler secret put`, nunca no arquivo):

| Segredo | Para que serve |
|---|---|
| `GEMINI_API_KEY` | Chave da API do Google — obrigatória |
| `ACCESS_CODE` | Código de acesso da equipe — opcional, mas recomendado |

**Sobre o modelo:** o `gemini-2.5-flash` foi descontinuado para novas contas em
agosto/2026 (a API responde 404 mandando migrar). O padrão é `gemini-3.5-flash-lite`
pelo endpoint clássico `generateContent`, por isso `GEMINI_API_MODE` está fixo em
`generate`: o endpoint `interactions` não tem formato de requisição documentado
publicamente, e deixar em `auto` só gastaria uma chamada perdida antes do fallback.

A escolha do modelo foi medida com o cartão de `exemplo/`, 4 amostras cada:

| Modelo | Tempo | Entrada / saída (1M tokens) | Extração |
|---|---|---|---|
| `gemini-3.6-flash` | 11,1s | $0,75 / $3,75 | referência |
| `gemini-3.1-flash-lite` | 6,9s | $0,25 / $1,50 | idêntica |
| **`gemini-3.5-flash-lite`** | **1,9–2,8s** | **$0,30 / $2,50** | **idêntica** |

Os campos caros de corrigir (nome, cargo, empresa, e-mail, telefone) saíram iguais
nos três. Para trocar de modelo basta editar `GEMINI_MODEL` e publicar de novo.

---

## Estrutura

```
cartoes-gabinete/
├── wrangler.toml               Worker, banco, bucket, domínio, cron e variáveis
├── migrations/
│   ├── 0001_init.sql            contatos + eventos
│   ├── 0002_fila_usuarios.sql   pendentes (fila) + usuarios (acesso)
│   └── 0003_verso_sigla_api.sql sigla, verso, api_tokens, webhooks
├── src/
│   ├── index.js                rotas da API interna
│   ├── auth.js                 código por pessoa, hash SHA-256, papéis
│   ├── fila.js                 fila, leitura em segundo plano, frente/verso, R2
│   ├── publica.js              API /v1 de consulta e tokens de leitura
│   ├── webhooks.js             disparo assinado em HMAC-SHA256
│   ├── gemini.js               prompt, esquema JSON e chamada à API do Google
│   ├── planilha.js             gerador de .xlsx (ZIP + XML, sem dependência)
│   └── db.js                   gravação, busca, duplicados, estatísticas, exportação
├── public/                     interface (HTML, CSS, JS puro — sem framework)
│   ├── brasao.svg              Brasão da República (variante colorida chapada)
│   └── docs.html               documentação da API, servida em /docs
├── test/extractor.test.js      testes das funções puras (npm test)
└── exemplo/cartao-exemplo.png  cartão fictício para testar
```

## Conferência: um a um ou em lote

Nada entra na base de contatos sem alguém aprovar. O que muda é o ritmo:

- **Um a um** — botão *Conferir um a um*. Abre a ficha com a foto ao lado dos
  campos; *Salvar e ir ao próximo* grava e já traz o cartão seguinte, sem passar
  pela lista. Descartar também avança. O contador mostra "cartão 3 de 9".
- **Em lote** — cada cartão da lista tem uma caixa de seleção. *Selecionar os
  prontos* marca de uma vez todos os que a IA leu sem ressalva, e *Aprovar
  selecionados* grava todos com os dados lidos. *Descartar* e *Ler de novo*
  valem para qualquer seleção.

A lista mostra nome, cargo, empresa, telefone e e-mail de cada cartão — é o que
se confere antes de aprovar em lote. Um cartão fica **fora** do lote de aprovação
quando merece um olhar na ficha, e a lista diz por quê:

| Aviso | Quando aparece |
|---|---|
| A IA não reconheceu um cartão | a leitura voltou com `e_cartao_valido: false` |
| Sem nome nem empresa | não sobrou identificação para gravar |
| Confiança baixa na leitura | a IA respondeu `confianca` abaixo de 0,7 |

Dá para marcar esses cartões à mão para descartar ou reler em lote; só a
**aprovação** exige abrir a ficha. O servidor recusa de novo pelo mesmo critério,
então não adianta contornar pela API.

## Planilha de contatos

Na aba Contatos, *Baixar planilha (Excel)* gera um `.xlsx` de verdade — abre com
clique duplo, sem assistente de importação, com a primeira linha congelada e
filtro automático. *Baixar CSV* entrega o mesmo conteúdo com BOM e separador `;`,
para quem vai importar em outro sistema.

Os dois respeitam os filtros da tela: se a busca estiver preenchida, só desce o
que está aparecendo. Limpe a busca e os filtros para levar todos. O limite é de
5.000 linhas por arquivo.

As colunas saem com título legível ("Empresa / órgão", "Celular / WhatsApp") e a
classificação vem traduzida — `terceiro_setor` chega como "Terceiro setor". Tudo
é gravado como texto, de propósito: telefone e CEP perderiam o zero à esquerda se
o Excel tratasse como número.

O `.xlsx` é montado à mão em `src/planilha.js` (um ZIP com alguns XML dentro),
para não trazer dependência de runtime para o Worker.

> **Lembre-se de que é dado pessoal de terceiros.** A planilha sai do sistema com
> tudo em claro, inclusive telefone e e-mail. Ela vai com `cache-control: no-store`,
> mas o arquivo baixado é responsabilidade de quem baixou.

## Acesso da equipe

Não existe mais um código único compartilhado nem digitar o próprio nome a cada
cartão. Cada pessoa tem um código que serve de senha e de crachá ao mesmo tempo.

1. Entre com o `ACCESS_CODE` (o segredo do `wrangler secret put`) — ele continua
   valendo como **código mestre de administração** e é por ele que se cadastra a
   equipe na primeira vez. Também é a saída de emergência se a tabela de usuários
   ficar vazia.
2. Abra a aba **Equipe**, digite o nome da pessoa, use o código sugerido (ou
   escreva um) e cadastre.
3. Entregue o código a ela. **Ele só aparece uma vez** — no banco fica só o hash
   SHA-256, ninguém consegue lê-lo de volta.

Quem sai do gabinete: aba Equipe → *Desativar*. O histórico dos contatos que a
pessoa cadastrou continua intacto.

## API

Todas as rotas (exceto `/api/config`) exigem o cabeçalho `x-acesso` com o código
da pessoa. O nome de quem registrou sai do próprio código.

| Método | Rota | O que faz |
|---|---|---|
| GET | `/api/config` | Nome do gabinete e listas de classificação (pública) |
| POST | `/api/entrar` | Diz de quem é o código: `{ nome, papel }` |
| POST | `/api/fila` | Recebe `{ imagem, origem_evento, origem_local }`, grava e devolve na hora. Responde 202 |
| GET | `/api/fila` | Cartões pendentes, com contagem por situação |
| GET | `/api/fila/:id` | Um cartão: dados da IA + possíveis duplicados |
| GET | `/api/fila/:id/imagem` | Foto do cartão (do R2) |
| POST | `/api/fila/:id/confirmar` | Aprova o cartão conferido: vira contato definitivo |
| POST | `/api/fila/:id/verso` | Anexa o verso a um cartão já na fila e manda reler |
| GET | `/api/fila/:id/imagem/verso` | Foto do verso |
| POST | `/api/fila/:id/reprocessar` | Manda a IA ler de novo |
| POST | `/api/fila/lote` | Recebe `{ acao, ids }` e aprova, descarta ou remanda para leitura até 50 cartões |
| DELETE | `/api/fila/:id` | Descarta o cartão e apaga a foto |
| GET | `/api/contatos` | Lista com `q`, `setor`, `segmento`, `prioridade`, `status`, `limit`, `offset` |
| GET/PUT/DELETE | `/api/contatos/:id` | Lê, edita ou exclui um contato |
| GET | `/api/contatos/:id/imagem` | Foto do cartão que originou o contato |
| GET | `/api/estatisticas` | Números do painel |
| GET | `/api/export.xlsx` | Planilha do Excel com a lista filtrada (até 5.000 linhas) |
| GET | `/api/export.csv` | O mesmo conteúdo em CSV, com BOM e separador `;` |
| GET/POST | `/api/usuarios` | Lista/cadastra a equipe — **só administração** |
| DELETE | `/api/usuarios/:id` | Desativa o acesso de alguém — **só administração** |
| GET/POST | `/api/tokens` | Tokens da API de consulta — **só administração** |
| GET/POST | `/api/webhooks` | Assinaturas de webhook — **só administração** |

### Situações de um cartão na fila

`na_fila` → `lendo` → `aguardando` (pronto para conferir) → `confirmado`
Se a IA falhar 3 vezes, para em `erro` e aparece na conferência com o motivo e um
botão de tentar de novo. `descartado` é quem foi recusado na conferência.

## API pública e webhooks

Outros sistemas consultam os contatos pela API `/v1`, **somente leitura**, autenticada
por `Authorization: Bearer <token>`. Não existe endpoint de escrita: um token vazado
expõe dados, mas ninguém corrompe a base.

A documentação para quem vai integrar está publicada em
**`/docs`** da sua instalação — com exemplos de chamada, modelo de
dados, códigos de erro e validação de assinatura em Node, Python e PHP. Ela é servida
pelo próprio Worker, então nunca fica dessincronizada da versão no ar.

| Método | Rota | O que faz |
|---|---|---|
| GET | `/v1/contatos` | Lista com `q`, `setor`, `segmento`, `prioridade`, `status`, `evento`, `desde`, `limite`, `offset` |
| GET | `/v1/contatos/:id` | Um contato |
| GET | `/v1/estatisticas` | Totais por setor, prioridade, segmento e situação |

Tokens e webhooks são criados na aba **API** do sistema (só administração). Token e
segredo aparecem **uma única vez**; no banco fica só o hash SHA-256.

Os webhooks disparam `contato.criado`, `contato.atualizado` e `contato.excluido` num
`POST` JSON assinado em HMAC-SHA256 no cabeçalho `x-assinatura`. Exigem URL `https`,
esperam 2xx em 10s e são desativados sozinhos após 10 falhas seguidas. O disparo roda
em `ctx.waitUntil()` — webhook lento não segura a resposta de quem está usando o sistema.

## Faixa institucional (opcional)

Se a variável `ORGAO` estiver preenchida, o topo exibe uma faixa com brasão e o nome
da instituição em caixa alta. Vazia, a faixa não aparece e o sistema fica neutro.

O `public/brasao.svg` que acompanha o projeto é o Brasão da República Federativa do
Brasil (símbolo oficial, domínio público pela Lei 5.700/71) — troque pelo da sua
instituição se for outro caso.

Se for usar o brasão da República, respeite as regras do
[Manual de Identidade Visual do Senado Federal](https://www12.senado.leg.br/identidadevisual):
sem rotação, sem alterar a proporção, nome sempre em caixa alta, sobre fundo chapado —
o manual [proíbe aplicar sobre fundo irregular](https://www12.senado.leg.br/identidadevisual/armas-nacionais/usos-proibidos)
e só admite as variantes oficiais, então não derive uma monocromia própria.

## Testes

```bash
npm test
```

Cobre a extração do JSON nos dois formatos de resposta da API do Google, a
normalização dos campos (acentos, e-mails, UF, enums inválidos), a chave de busca sem
acentos e a geração do CSV.

## Custos aproximados

- Cloudflare Workers e D1: plano gratuito cobre com folga o volume de um gabinete
- Gemini Flash: fração de centavo por cartão lido (o app já reduz a imagem para 1600px antes de enviar)

## Observações de segurança e privacidade

- A chave da API nunca chega ao navegador.
- A imagem do cartão é enviada ao Google apenas para leitura e **não é gravada** no
  sistema (o campo `imagem_key` existe no banco caso queira, no futuro, guardar as
  imagens em um bucket R2).
- Os dados são pessoais de terceiros: use o código de acesso, restrinja o link à
  equipe do gabinete e trate o banco conforme a LGPD (finalidade declarada, prazo de
  guarda e possibilidade de exclusão — a rota DELETE já atende esse ponto).
- A tabela `eventos` registra quem criou, editou ou excluiu cada contato.
