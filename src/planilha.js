/**
 * Geracao de planilha .xlsx sem dependencia de runtime.
 *
 * Um .xlsx e um ZIP com alguns XML dentro. Montamos o ZIP a mao, com os
 * arquivos "armazenados" (sem compressao): evita depender de biblioteca e o
 * volume aqui e de algumas centenas de linhas, nao vale o custo de comprimir.
 *
 * Tudo vai como texto (t="inlineStr"). E de proposito: telefone, CEP e UF
 * perdem o zero a esquerda se o Excel tratar como numero.
 */

const bytes = (texto) => new TextEncoder().encode(texto);

/* ---------- ZIP ---------- */

const TABELA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(dados) {
  let c = 0xffffffff;
  for (let i = 0; i < dados.length; i++) c = TABELA_CRC[(c ^ dados[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Junta os pedacos numa unica sequencia de bytes. */
function concatenar(pedacos) {
  const total = pedacos.reduce((n, p) => n + p.length, 0);
  const saida = new Uint8Array(total);
  let pos = 0;
  for (const p of pedacos) { saida.set(p, pos); pos += p.length; }
  return saida;
}

/** ZIP com entradas armazenadas. `arquivos` = [{ nome, dados: Uint8Array }]. */
export function zipar(arquivos) {
  const corpo = [];
  const central = [];
  let deslocamento = 0;

  for (const arquivo of arquivos) {
    const nome = bytes(arquivo.nome);
    const dados = arquivo.dados;
    const crc = crc32(dados);

    const cabecalho = new Uint8Array(30 + nome.length);
    const c = new DataView(cabecalho.buffer);
    c.setUint32(0, 0x04034b50, true);
    c.setUint16(4, 20, true);       // versao minima
    c.setUint16(8, 0, true);        // metodo: armazenado
    c.setUint16(12, 0x0021, true);  // data fixa (1980-01-01), o .xlsx nao usa
    c.setUint32(14, crc, true);
    c.setUint32(18, dados.length, true);
    c.setUint32(22, dados.length, true);
    c.setUint16(26, nome.length, true);
    cabecalho.set(nome, 30);

    const entrada = new Uint8Array(46 + nome.length);
    const e = new DataView(entrada.buffer);
    e.setUint32(0, 0x02014b50, true);
    e.setUint16(4, 20, true);
    e.setUint16(6, 20, true);
    e.setUint16(10, 0, true);
    e.setUint16(14, 0x0021, true);
    e.setUint32(16, crc, true);
    e.setUint32(20, dados.length, true);
    e.setUint32(24, dados.length, true);
    e.setUint16(28, nome.length, true);
    e.setUint32(42, deslocamento, true);
    entrada.set(nome, 46);

    corpo.push(cabecalho, dados);
    central.push(entrada);
    deslocamento += cabecalho.length + dados.length;
  }

  const diretorio = concatenar(central);
  const fim = new Uint8Array(22);
  const f = new DataView(fim.buffer);
  f.setUint32(0, 0x06054b50, true);
  f.setUint16(8, arquivos.length, true);
  f.setUint16(10, arquivos.length, true);
  f.setUint32(12, diretorio.length, true);
  f.setUint32(16, deslocamento, true);

  return concatenar([...corpo, diretorio, fim]);
}

/* ---------- XLSX ---------- */

/**
 * Escapa para XML. Tambem descarta caracteres de controle: eles nao existem em
 * XML 1.0 e o Excel recusa o arquivo inteiro se um escapar - e o OCR de cartao
 * as vezes devolve um.
 */
function escaparXml(valor) {
  let saida = '';
  for (const c of String(valor ?? '')) {
    const ponto = c.codePointAt(0);
    if (ponto < 32 && c !== '\t' && c !== '\n') continue;
    if (c === '&') saida += '&amp;';
    else if (c === '<') saida += '&lt;';
    else if (c === '>') saida += '&gt;';
    else saida += c;
  }
  return saida;
}

/** 0 -> A, 25 -> Z, 26 -> AA */
export function letraColuna(indice) {
  let n = indice + 1;
  let letra = '';
  while (n > 0) {
    const resto = (n - 1) % 26;
    letra = String.fromCharCode(65 + resto) + letra;
    n = Math.floor((n - resto) / 26);
  }
  return letra;
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function celula(coluna, linha, valor, estilo) {
  const ref = `${letraColuna(coluna)}${linha}`;
  const texto = String(valor ?? '');
  if (!texto) return `<c r="${ref}"${estilo ? ` s="${estilo}"` : ''}/>`;
  return `<c r="${ref}"${estilo ? ` s="${estilo}"` : ''} t="inlineStr">`
    + `<is><t xml:space="preserve">${escaparXml(texto)}</t></is></c>`;
}

function folha(cabecalhos, linhas, larguras) {
  const ultima = letraColuna(cabecalhos.length - 1);
  const cols = larguras
    .map((l, i) => `<col min="${i + 1}" max="${i + 1}" width="${l}" customWidth="1"/>`)
    .join('');

  const linhaCabecalho = `<row r="1">${
    cabecalhos.map((t, i) => celula(i, 1, t, 1)).join('')
  }</row>`;

  const corpo = linhas.map((valores, n) => `<row r="${n + 2}">${
    valores.map((v, i) => celula(i, n + 2, v, 0)).join('')
  }</row>`).join('');

  return `${XML}
<worksheet xmlns="${NS}">
<dimension ref="A1:${ultima}${linhas.length + 1}"/>
<sheetViews><sheetView workbookViewId="0">
<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>${linhaCabecalho}${corpo}</sheetData>
<autoFilter ref="A1:${ultima}${linhas.length + 1}"/>
</worksheet>`;
}

const ESTILOS = `${XML}
<styleSheet xmlns="${NS}">
<fonts count="2">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF12395F"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/**
 * Monta a planilha.
 *
 * @param {{cabecalhos: string[], linhas: string[][], larguras?: number[], aba?: string}} conteudo
 * @returns {Uint8Array} bytes do arquivo .xlsx
 */
export function montarXlsx({ cabecalhos, linhas, larguras, aba = 'Contatos' }) {
  const medidas = larguras && larguras.length === cabecalhos.length
    ? larguras
    : cabecalhos.map(() => 22);

  const arquivos = [
    {
      nome: '[Content_Types].xml',
      dados: bytes(`${XML}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`)
    },
    {
      nome: '_rels/.rels',
      dados: bytes(`${XML}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`)
    },
    {
      nome: 'xl/workbook.xml',
      dados: bytes(`${XML}
<workbook xmlns="${NS}" xmlns:r="${NS_REL}">
<sheets><sheet name="${escaparXml(aba).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`)
    },
    {
      nome: 'xl/_rels/workbook.xml.rels',
      dados: bytes(`${XML}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${NS_REL}/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="${NS_REL}/styles" Target="styles.xml"/>
</Relationships>`)
    },
    { nome: 'xl/styles.xml', dados: bytes(ESTILOS) },
    { nome: 'xl/worksheets/sheet1.xml', dados: bytes(folha(cabecalhos, linhas, medidas)) }
  ];

  return zipar(arquivos);
}
