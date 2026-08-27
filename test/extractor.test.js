/** Testes das funcoes puras (sem rede e sem banco): node test/extractor.test.js */
import assert from 'node:assert/strict';
import { extrairJson, normalizar } from '../src/gemini.js';
import { chaveBusca, paraCsv, paraXlsx, linhaExport, COLUNAS_EXPORT, montarContato, normalizarBusca } from '../src/db.js';
import { letraColuna, crc32 } from '../src/planilha.js';

globalThis.crypto ??= (await import('node:crypto')).webcrypto;

let ok = 0;
const teste = (nome, fn) => { fn(); ok++; console.log(`  ok  ${nome}`); };

/* --- extrairJson lida com os dois formatos de resposta da API --- */
teste('extrai JSON do formato generateContent', () => {
  const resposta = {
    candidates: [{ content: { parts: [{ text: '{"nome":"Ana","setor":"publico"}' }] } }]
  };
  assert.equal(extrairJson(resposta).nome, 'Ana');
});

teste('extrai JSON do formato interactions', () => {
  const resposta = { output: [{ type: 'text', text: '{"nome":"Bruno","setor":"privado"}' }] };
  assert.equal(extrairJson(resposta).nome, 'Bruno');
});

teste('extrai JSON envolvido em cerca de markdown', () => {
  const resposta = { candidates: [{ content: { parts: [{ text: '```json\n{"nome":"Cida"}\n```' }] } }] };
  assert.equal(extrairJson(resposta).nome, 'Cida');
});

teste('devolve null quando nao ha JSON', () => {
  assert.equal(extrairJson({ candidates: [{ content: { parts: [{ text: 'desculpe' }] } }] }), null);
});

/* --- normalizacao --- */
teste('normaliza enums invalidos e e-mails', () => {
  const d = normalizar({
    nome: '  Joao Silva ', email: 'JOAO@EMPRESA.COM.BR', uf: 'df',
    setor: 'governo', segmento: 'inexistente', prioridade: 'urgentissima',
    temas: ['agro', ' credito rural '], confianca: 1.4
  });
  assert.equal(d.nome, 'Joao Silva');
  assert.equal(d.email, 'joao@empresa.com.br');
  assert.equal(d.uf, 'DF');
  assert.equal(d.setor, 'outro');
  assert.equal(d.segmento, 'outro');
  assert.equal(d.prioridade, 'media');
  assert.deepEqual(d.temas, ['agro', 'credito rural']);
  assert.equal(d.confianca, 1);
  assert.equal(d.e_cartao_valido, true);
});

teste('mantem enums validos', () => {
  const d = normalizar({ setor: 'publico', segmento: 'saude', prioridade: 'alta', confianca: 0.9 });
  assert.equal(d.setor, 'publico');
  assert.equal(d.segmento, 'saude');
  assert.equal(d.prioridade, 'alta');
  assert.equal(d.confianca, 0.9);
});

/* --- banco --- */
teste('chave de busca remove acentos e junta arrays', () => {
  const k = chaveBusca({ nome: 'José Antônio', empresa: 'Construção S/A', temas: ['saúde', 'educação'] });
  assert.ok(k.includes('jose antonio'));
  assert.ok(k.includes('construcao'));
  assert.ok(k.includes('saude, educacao'));
});

teste('busca normalizada casa com a chave gravada', () => {
  const k = chaveBusca({ nome: 'José Antônio' });
  assert.ok(k.includes(normalizarBusca('José')));
});

teste('montarContato gera id, datas e serializa arrays', () => {
  const c = montarContato({ nome: 'Ana', temas: ['agro'], outras_redes: ['@ana'], setor: 'publico' });
  assert.match(c.id, /^[0-9a-f-]{36}$/);
  assert.equal(c.temas, 'agro');
  assert.equal(c.outras_redes, '@ana');
  assert.equal(c.status, 'novo');
  assert.equal(c.data_captura.length, 10);
  assert.ok(c.criado_em && c.atualizado_em);
});

teste('CSV escapa aspas e usa BOM', () => {
  const csv = paraCsv([{ nome: 'Ana "A"', empresa: 'X;Y' }]);
  assert.ok(csv.startsWith('﻿'));
  assert.ok(csv.includes('"Ana ""A"""'));
  assert.ok(csv.includes('"X;Y"'));
});

teste('CSV sai com titulos legiveis, nao com nome de coluna do banco', () => {
  const [cabecalho] = paraCsv([]).split('\r\n');
  assert.ok(cabecalho.includes('"Empresa / órgão"'));
  assert.ok(cabecalho.includes('"Celular / WhatsApp"'));
  assert.ok(!cabecalho.includes('resumo_ia'));
});

/* --- exportacao --- */
teste('linha de exportacao traduz classificacao e formata datas', () => {
  const linha = linhaExport({
    nome: 'Ana', setor: 'terceiro_setor', segmento: 'ciencia_pesquisa',
    prioridade: 'alta', status: 'novo',
    data_captura: '2026-08-27', criado_em: '2026-08-27T14:32:10.000Z'
  });
  const valor = (campo) => linha[COLUNAS_EXPORT.findIndex(([c]) => c === campo)];
  assert.equal(valor('setor'), 'Terceiro setor');
  assert.equal(valor('segmento'), 'Ciência e pesquisa');
  assert.equal(valor('prioridade'), 'Alta');
  assert.equal(valor('data_captura'), '27/08/2026');
  assert.equal(valor('criado_em'), '27/08/2026 14:32');
});

teste('linha de exportacao nao quebra com campo faltando', () => {
  const linha = linhaExport({ nome: 'Ana' });
  assert.equal(linha.length, COLUNAS_EXPORT.length);
  assert.ok(linha.every((v) => typeof v === 'string'));
});

/* --- planilha .xlsx --- */
teste('crc32 bate com o valor conhecido de "123456789"', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

teste('letraColuna cobre a virada de A para AA', () => {
  assert.equal(letraColuna(0), 'A');
  assert.equal(letraColuna(25), 'Z');
  assert.equal(letraColuna(26), 'AA');
  assert.equal(letraColuna(51), 'AZ');
  assert.equal(letraColuna(52), 'BA');
});

teste('xlsx e um ZIP com as pecas que o Excel exige', () => {
  const bytes = paraXlsx([{ nome: 'Ana & Cia <SP>', empresa: 'Órgão' }]);
  assert.ok(bytes instanceof Uint8Array);
  // assinatura "PK\x03\x04" do primeiro arquivo local
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const texto = new TextDecoder().decode(bytes);
  for (const parte of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/styles.xml']) {
    assert.ok(texto.includes(parte), `falta ${parte}`);
  }
  // o conteudo vai em texto puro (entradas armazenadas), da para conferir aqui
  assert.ok(texto.includes('Ana &amp; Cia &lt;SP&gt;'));
  assert.ok(texto.includes('Empresa / órgão'));
});

teste('xlsx descarta caractere de controle que o OCR devolve', () => {
  const bytes = paraXlsx([{ nome: `Ana${String.fromCharCode(7)}` }]);
  const texto = new TextDecoder().decode(bytes);
  assert.ok(texto.includes('<t xml:space="preserve">Ana</t>'));
});

console.log(`\n${ok} testes passaram.`);
