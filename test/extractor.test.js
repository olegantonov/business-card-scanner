/** Testes das funcoes puras (sem rede e sem banco): node test/extractor.test.js */
import assert from 'node:assert/strict';
import { extrairJson, normalizar } from '../src/gemini.js';
import { chaveBusca, paraCsv, montarContato, normalizarBusca } from '../src/db.js';

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

console.log(`\n${ok} testes passaram.`);
