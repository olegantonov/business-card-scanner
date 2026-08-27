# AGENTS.md

Instruções para agentes de código que forem trabalhar neste repositório.
Leia junto com o `README.md`, que explica o produto; aqui estão as regras de
trabalho e as armadilhas que não aparecem lendo o código.

## O que é

Scanner de cartões de visita: a foto vai para o Google Gemini, que lê e classifica
o contato; uma pessoa confere antes de gravar. Roda inteiro na Cloudflare —
Workers (código e assets), D1 (banco) e R2 (fotos). Não há build step, framework
nem dependência de runtime: só o `wrangler` como devDependency.

```
src/index.js     roteador: interface, API interna (/api) e API pública (/v1)
src/auth.js      código único por pessoa, hash SHA-256, papéis (equipe/admin)
src/fila.js      fila, leitura em segundo plano, frente/verso, R2
src/publica.js   API /v1 somente leitura e tokens
src/webhooks.js  disparo assinado em HMAC-SHA256
src/gemini.js    prompt, schema JSON e chamada à API do Google
src/db.js        gravação, busca, duplicados, estatísticas, CSV
public/          interface em HTML/CSS/JS puro + docs.html (servido em /docs)
migrations/      SQL numerado, aplicado manualmente pelo wrangler
```

## Comandos

```bash
npm install
npm test                    # node test/extractor.test.js
npm run dev                 # wrangler dev, em http://localhost:8787
npm run deploy              # publica na Cloudflare

npx wrangler d1 execute <banco> --remote --file=./migrations/000N_*.sql
```

Antes de rodar qualquer coisa: `cp wrangler.toml.example wrangler.toml` e preencha.
**O `wrangler.toml` está no `.gitignore`** — ele carrega o id do banco, o domínio
e o nome da instituição, que são específicos de cada instalação. Nunca o commite
nem o recrie com valores de exemplo por cima de um existente.

## Armadilhas que já custaram tempo

**Publicar mata as leituras em andamento.** Um `deploy` encerra o trabalho em
`ctx.waitUntil()`, então cartões que o Gemini está lendo naquele instante ficam
presos em `lendo`, sem erro registrado — parece travamento e não é. A varredura
devolve para `na_fila` após 2 minutos e o Cron Trigger (1 min) reprocessa, com até
3 tentativas. **Antes de publicar, verifique se há cartões em `na_fila`/`lendo` e
avise quem estiver escaneando.** Se aparecer um cartão travado, cheque se houve
deploy recente antes de investigar como bug.

**Arquivos estáticos não passam pelo Worker.** A camada de assets da Cloudflare
responde `/`, `/style.css`, `/app.js` etc. **antes** de o Worker rodar. Consequências:
o redirect HTTP→HTTPS em `src/index.js` só alcança rotas de API, e forçar HTTPS na
página inicial exige ligar *Always Use HTTPS* na zona. A mesma camada reescreve
`/docs.html` → `/docs` com 307; use sempre a URL sem extensão.

**Rotas de imagem exigem cabeçalho, e `<img src>` não manda cabeçalho.** O
front-end busca por `fetch` com `x-acesso` e converte em blob (`carregarImagem`
em `public/app.js`). Não troque por `<img src="/api/...">`, e lembre de
`URL.revokeObjectURL` ao descartar.

**Webhook lento não pode segurar a resposta.** Chame `disparar()` sempre dentro de
`ctx.waitUntil()`. O mesmo vale para qualquer trabalho que não seja necessário
para responder.

## Regras que não se negociam

- **Nenhum segredo em arquivo.** `GEMINI_API_KEY` e `ACCESS_CODE` vão por
  `wrangler secret put`. Códigos de pessoa, tokens de API e segredos de webhook
  são gravados como hash/valor no banco e exibidos **uma única vez** na criação.
- **A API `/v1` é somente leitura.** Não adicione endpoint de escrita sem decisão
  explícita de quem mantém o sistema: é o que limita o estrago de um token vazado.
- **Fotos não são expostas na API pública** — só os sinalizadores `tem_foto` e
  `tem_verso`.
- **Webhook exige URL `https`.** Dado pessoal não trafega em HTTP.
- **Nada entra no banco sem conferência humana.** O caminho é sempre
  fila → conferência → contato. Não crie atalho da IA direto para `contatos`.
- **Os dados são pessoais de terceiros** (LGPD). Ao mexer em exportação, log ou
  qualquer saída nova, pense antes em quem passa a enxergar o quê. Respostas da
  API pública levam `cache-control: no-store`.

## Convenções de código

- Português no código: identificadores, comentários e nomes de rota.
  **Comentários e identificadores sem acento** (`cartao`, `codigo`, `funcoes`);
  **strings visíveis ao usuário com acento** (`'Imagem inválida.'`).
- ES modules, 2 espaços de indentação, aspas simples, ponto e vírgula.
- Sem framework e sem build: o `public/` é servido como está. Não introduza
  bundler, TypeScript ou dependência de runtime sem necessidade real.
- Comentário explica **por quê**, não o quê. O código já diz o quê.
- SQL sempre com parâmetros (`?`), nunca por interpolação de string.

## Testes

`test/extractor.test.js` cobre só **funções puras** — sem rede e sem banco:
extração do JSON nos dois formatos de resposta do Google, normalização de campos,
chave de busca sem acentos e geração do CSV. Não há framework: um helper `teste()`
de três linhas e `node:assert/strict`.

Ao mexer em `src/gemini.js` ou `src/db.js`, acrescente caso de teste. Para o
restante (fila, auth, webhooks), o caminho é exercitar a API publicada — não monte
mock de D1 nem de R2.

## Fila: máquina de estados

```
na_fila → lendo → aguardando → confirmado
             ↓                      ↑
           erro ──(reprocessar)─────┘
             ↓
        descartado  (apaga as fotos do R2)
```

`processar()` é idempotente: só pega quem está em `na_fila`, usando o `changes` do
UPDATE como trava. Preserve isso ao mexer — sem essa trava, cron e `waitUntil`
leem o mesmo cartão duas vezes e você paga a chamada ao Gemini em dobro.

## Commits

- Mensagem em português, imperativo ou descritivo, explicando **o efeito** da
  mudança e não a lista de arquivos tocados.
- **Não inclua atribuição de IA**: nada de `Co-Authored-By` de assistente,
  `Claude-Session`, `Generated with` ou equivalente. O histórico é dos mantenedores.
- Não commite `wrangler.toml`, `.dev.vars`, `.wrangler/` nem `node_modules/`.
- Migrations são numeradas e **nunca editadas depois de aplicadas**: crie a
  próxima. As colunas novas entram com `ALTER TABLE ... ADD COLUMN`.
