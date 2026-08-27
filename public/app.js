/* Scanner de cartoes de visita - interface */

const $ = (id) => document.getElementById(id);
const estado = {
  config: null,
  usuario: null,
  editando: null,     // id do contato em edicao
  conferindo: null,   // id do cartao pendente em conferencia
  dados: null,
  enviados: [],       // cartoes mandados nesta sessao
  fila: { itens: [], contagem: {} }
};

const ROTULOS = {
  publico: 'Setor público', privado: 'Privado', terceiro_setor: 'Terceiro setor',
  academico: 'Acadêmico', midia: 'Mídia', outro: 'Outro',
  alta: 'Alta', media: 'Média', baixa: 'Baixa',
  agronegocio: 'Agronegócio', saude: 'Saúde', educacao: 'Educação',
  infraestrutura: 'Infraestrutura', transporte: 'Transporte', energia: 'Energia',
  meio_ambiente: 'Meio ambiente', seguranca_publica: 'Segurança pública',
  tecnologia: 'Tecnologia', telecomunicacoes: 'Telecomunicações',
  industria: 'Indústria', comercio: 'Comércio', servicos: 'Serviços',
  financeiro: 'Financeiro', juridico: 'Jurídico', construcao: 'Construção',
  turismo: 'Turismo', cultura: 'Cultura', esporte: 'Esporte',
  assistencia_social: 'Assistência social', ciencia_pesquisa: 'Ciência e pesquisa',
  comunicacao_imprensa: 'Comunicação e imprensa', politica_governo: 'Política e governo',
  religioso: 'Religioso', novo: 'Novo', revisado: 'Revisado',
  encaminhado: 'Encaminhado', arquivado: 'Arquivado',
  na_fila: 'Na fila', lendo: 'Lendo…', aguardando: 'Pronto para conferir', erro: 'Falhou'
};
const rotular = (v) => ROTULOS[v] || String(v || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

const guardar = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const ler = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };

const escapar = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- API ---------- */
function cabecalhos(extra = {}) {
  return {
    'content-type': 'application/json',
    // encodeURIComponent: cabecalhos HTTP nao aceitam acentos
    'x-acesso': encodeURIComponent(ler('acesso')),
    ...extra
  };
}

async function api(caminho, opcoes = {}) {
  const resp = await fetch(caminho, { ...opcoes, headers: cabecalhos(opcoes.headers) });
  if (resp.status === 401) {
    guardar('acesso', '');
    estado.usuario = null;
    abrirAcesso('Código inválido ou desativado. Entre de novo.');
    throw new Error('Código de acesso inválido.');
  }
  const tipo = resp.headers.get('content-type') || '';
  const dados = tipo.includes('json') ? await resp.json() : await resp.text();
  if (!resp.ok) throw new Error(dados?.erro || 'Falha na requisição.');
  return dados;
}

function mensagem(texto, tipo = 'ok') {
  $('mensagem').innerHTML = texto ? `<div class="aviso ${tipo}">${texto}</div>` : '';
}

/** As rotas de imagem exigem o cabecalho de acesso, e <img src> nao manda
 *  cabecalho: buscamos por fetch e viramos blob. */
async function carregarImagem(url, alvo) {
  if (alvo.dataset.blob) { URL.revokeObjectURL(alvo.dataset.blob); delete alvo.dataset.blob; }
  alvo.removeAttribute('src');
  try {
    const resp = await fetch(url, { headers: cabecalhos() });
    if (!resp.ok) return;
    const blob = URL.createObjectURL(await resp.blob());
    alvo.dataset.blob = blob;
    alvo.src = blob;
  } catch { /* sem foto, segue */ }
}

/* ---------- Entrada ---------- */
function abrirAcesso(aviso = '') {
  $('erroAcesso').innerHTML = aviso ? `<div class="aviso erro">${escapar(aviso)}</div>` : '';
  $('inpCodigo').value = '';
  if (!$('dlgAcesso').open) $('dlgAcesso').showModal();
}

$('dlgAcesso').addEventListener('close', async () => {
  const codigo = $('inpCodigo').value.trim();
  if (!codigo) { setTimeout(() => abrirAcesso('Digite o seu código para entrar.'), 0); return; }
  guardar('acesso', codigo);
  await entrar();
});

async function entrar() {
  try {
    const r = await api('/api/entrar', { method: 'POST', body: '{}' });
    estado.usuario = r;
    $('quemSou').textContent = r.nome;
    $('abaEquipe').hidden = r.papel !== 'admin';
    $('abaIntegracoes').hidden = r.papel !== 'admin';
    mensagem('');
    atualizarFila();
  } catch { /* o api() ja reabriu o dialogo */ }
}

$('trocarUsuario').addEventListener('click', (e) => {
  e.preventDefault();
  guardar('acesso', '');
  estado.usuario = null;
  $('quemSou').textContent = '—';
  $('abaEquipe').hidden = true;
  $('abaIntegracoes').hidden = true;
  abrirAcesso();
});

/* ---------- Abas ---------- */
document.querySelectorAll('nav button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('ativo', x === b));
    ['escanear', 'conferencia', 'contatos', 'painel', 'equipe', 'integracoes']
      .forEach((a) => { $(`aba-${a}`).hidden = a !== b.dataset.aba; });
    if (b.dataset.aba === 'conferencia') atualizarFila();
    if (b.dataset.aba === 'contatos') carregarLista();
    if (b.dataset.aba === 'painel') carregarPainel();
    if (b.dataset.aba === 'equipe') carregarEquipe();
    if (b.dataset.aba === 'integracoes') carregarIntegracoes();
  });
});
const abaAtiva = () => document.querySelector('nav button.ativo')?.dataset.aba;
const irPara = (aba) => document.querySelector(`nav button[data-aba="${aba}"]`).click();

/* ---------- Captura ---------- */
const dropzone = $('dropzone');
dropzone.addEventListener('click', () => $('arquivo').click());
$('arquivo').addEventListener('change', (e) => {
  [...e.target.files].forEach(prepararArquivo);
  e.target.value = '';
});

['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => {
  e.preventDefault(); dropzone.classList.add('sobre');
}));
['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => {
  e.preventDefault(); dropzone.classList.remove('sobre');
}));
dropzone.addEventListener('drop', (e) => [...(e.dataTransfer.files || [])].forEach(prepararArquivo));
document.addEventListener('paste', (e) => {
  [...(e.clipboardData?.items || [])]
    .filter((i) => i.type.startsWith('image/'))
    .forEach((i) => prepararArquivo(i.getAsFile()));
});

/** Reduz a imagem antes de enviar (economiza banda e tokens). */
function redimensionar(arquivo, maxLado = 1600) {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => {
      const img = new Image();
      img.onload = () => {
        const escala = Math.min(1, maxLado / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * escala);
        canvas.height = Math.round(img.height * escala);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => resolve(leitor.result); // formatos exoticos: envia como veio
      img.src = leitor.result;
    };
    leitor.onerror = reject;
    leitor.readAsDataURL(arquivo);
  });
}

async function prepararArquivo(arquivo) {
  if (!arquivo) return;
  try {
    await enviarParaFila(await redimensionar(arquivo));
  } catch {
    mensagem('Não consegui ler esse arquivo de imagem.', 'erro');
  }
}

/**
 * Manda o cartao para a fila e volta na hora. A leitura pela IA acontece no
 * servidor, em segundo plano - quem esta escaneando nao espera nada.
 */
async function enviarParaFila(dataUrl, versoDataUrl = null) {
  const local = {
    idLocal: crypto.randomUUID(),
    miniatura: dataUrl,
    status: 'enviando',
    id: null
  };
  estado.enviados.unshift(local);
  estado.enviados = estado.enviados.slice(0, 20); // so as ultimas, para nao inchar a memoria
  desenharEnviados();

  try {
    const r = await api('/api/fila', {
      method: 'POST',
      body: JSON.stringify({
        imagem: dataUrl,
        verso: versoDataUrl || undefined,
        origem_evento: $('origem_evento').value.trim(),
        origem_local: $('origem_local').value.trim()
      })
    });
    local.id = r.id;
    local.status = 'na_fila';
  } catch (e) {
    local.status = 'falhou';
    local.erro = e.message;
  }
  desenharEnviados();
  atualizarFila();
}

function desenharEnviados() {
  $('areaEnviados').hidden = !estado.enviados.length;
  $('enviados').innerHTML = estado.enviados.map((e) => {
    const item = estado.fila.itens.find((i) => i.id === e.id);
    const status = e.status === 'falhou' ? 'falhou' : (item?.status || e.status);
    const nome = item?.dados?.nome;
    return `
      <div class="enviado" data-id="${escapar(e.id || '')}">
        <img src="${e.miniatura}" alt="">
        <div>
          <b>${escapar(nome || 'Cartão enviado')}</b>
          <span class="etiqueta st-${escapar(status)}">${status === 'falhou' ? 'Falhou no envio' : rotular(status)}</span>
          ${e.erro ? `<span class="dica">${escapar(e.erro)}</span>` : ''}
        </div>
      </div>`;
  }).join('');
  $('enviados').querySelectorAll('.enviado').forEach((el) => {
    el.addEventListener('click', () => { if (el.dataset.id) abrirFichaPendente(el.dataset.id); });
  });
}

/* ---------- Camera ao vivo ---------- */
let fluxoCamera = null;
let ladoCamera = 'environment';
let fotosNaSessao = 0;

function pararFluxo() {
  if (!fluxoCamera) return;
  fluxoCamera.getTracks().forEach((t) => t.stop());
  fluxoCamera = null;
}

async function iniciarFluxo() {
  pararFluxo();
  const erro = $('camErro');
  erro.hidden = true;
  try {
    fluxoCamera = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: ladoCamera }, width: { ideal: 1920 } },
      audio: false
    });
    $('camVideo').srcObject = fluxoCamera;
  } catch (e) {
    erro.hidden = false;
    erro.className = 'aviso erro';
    erro.textContent = e?.name === 'NotAllowedError'
      ? 'Permissão de câmera negada. Libere o acesso nas configurações do navegador e tente de novo.'
      : (e?.name === 'NotFoundError'
        ? 'Nenhuma câmera encontrada neste aparelho. Use o envio de arquivo.'
        : `Não consegui abrir a câmera: ${e?.message || e}`);
  }
}

$('btnCamera').addEventListener('click', async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    mensagem('Este navegador não permite acesso à câmera. Use o envio de arquivo.', 'erro');
    return;
  }
  fotosNaSessao = 0;
  frenteEmEspera = null;
  $('btnTirarFoto').textContent = 'Tirar foto';
  $('camContador').hidden = true;
  $('dlgCamera').showModal();
  await iniciarFluxo();
});

$('btnVirarCamera').addEventListener('click', async () => {
  ladoCamera = ladoCamera === 'environment' ? 'user' : 'environment';
  await iniciarFluxo();
});

$('btnFecharCamera').addEventListener('click', () => $('dlgCamera').close());

// cobre tambem o fechamento pela tecla Esc
$('dlgCamera').addEventListener('close', () => {
  pararFluxo();
  $('camVideo').srcObject = null;
});

/** Frente guardada esperando o verso, quando o modo frente-e-verso esta ligado. */
let frenteEmEspera = null;

function capturarQuadro() {
  const v = $('camVideo');
  if (!v.videoWidth) return null; // ainda sem quadro
  const maxLado = 1600; // mesmo limite do upload, para economizar banda e tokens
  const escala = Math.min(1, maxLado / Math.max(v.videoWidth, v.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(v.videoWidth * escala);
  canvas.height = Math.round(v.videoHeight * escala);
  canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

function avisoCamera(texto, tipo = 'ok') {
  const c = $('camContador');
  c.hidden = !texto;
  c.className = `aviso ${tipo}`;
  c.textContent = texto;
}

$('chkVerso').addEventListener('change', () => {
  frenteEmEspera = null;
  $('btnTirarFoto').textContent = 'Tirar foto';
  avisoCamera($('chkVerso').checked ? 'Modo frente e verso: a primeira foto é a frente.' : '');
});

$('btnTirarFoto').addEventListener('click', () => {
  const foto = capturarQuadro();
  if (!foto) return;

  // modo frente-e-verso: segura a frente e espera o segundo disparo
  if ($('chkVerso').checked && !frenteEmEspera) {
    frenteEmEspera = foto;
    $('btnTirarFoto').textContent = 'Tirar foto do verso';
    avisoCamera('Frente capturada. Vire o cartão e fotografe o verso.', 'atencao');
    return;
  }

  const frente = frenteEmEspera || foto;
  const verso = frenteEmEspera ? foto : null;
  frenteEmEspera = null;
  $('btnTirarFoto').textContent = 'Tirar foto';

  // a camera continua aberta: da para fotografar um cartao atras do outro
  fotosNaSessao++;
  avisoCamera(`${fotosNaSessao} cartão(ões) enviado(s)${verso ? ' (com verso)' : ''}. Pode fotografar o próximo.`);

  enviarParaFila(frente, verso);
});

['origem_evento', 'origem_local'].forEach((id) => {
  $(id).value = ler(id);
  $(id).addEventListener('input', () => guardar(id, $(id).value));
});

/* ---------- Fila / conferencia ---------- */
async function atualizarFila() {
  if (!estado.usuario) return;
  try {
    estado.fila = await api('/api/fila');
  } catch { return; }

  const aConferir = estado.fila.contagem.aguardando || 0;
  const badge = $('badgeFila');
  badge.hidden = !aConferir;
  badge.textContent = aConferir;

  if (abaAtiva() === 'conferencia') desenharFila();
  if (estado.enviados.length) desenharEnviados();
}

function desenharFila() {
  const c = estado.fila.contagem;
  $('resumoFila').textContent =
    `${c.aguardando || 0} para conferir · ${(c.na_fila || 0) + (c.lendo || 0)} em leitura · ${c.erro || 0} com erro`;

  const alvo = $('listaFila');
  if (!estado.fila.itens.length) {
    alvo.innerHTML = '<div class="vazio">Nada pendente. Os cartões escaneados aparecem aqui.</div>';
    return;
  }

  alvo.innerHTML = estado.fila.itens.map((i) => {
    const d = i.dados || {};
    const pronto = i.status === 'aguardando';
    return `
      <div class="pendente ${pronto ? 'pronto' : ''}" data-id="${escapar(i.id)}">
        <img data-foto="${escapar(i.id)}" alt="">
        <div class="pendente-info">
          <b>${escapar(d.nome || (pronto ? '(sem nome no cartão)' : 'Aguardando leitura'))}</b>
          <span>${escapar([d.cargo, d.sigla ? `${d.sigla} — ${d.empresa}` : d.empresa].filter(Boolean).join(' · '))}</span>
          <div class="etiquetas">
            <span class="etiqueta st-${escapar(i.status)}">${rotular(i.status)}</span>
            ${d.prioridade ? `<span class="etiqueta ${escapar(d.prioridade)}">Prioridade ${rotular(d.prioridade)}</span>` : ''}
            ${i.tem_verso ? '<span class="etiqueta">Frente e verso</span>' : ''}
            ${i.origem_evento ? `<span class="etiqueta">${escapar(i.origem_evento)}</span>` : ''}
            ${i.registrado_por ? `<span class="etiqueta">${escapar(i.registrado_por)}</span>` : ''}
          </div>
          ${i.erro ? `<span class="dica erro-texto">${escapar(i.erro)}</span>` : ''}
        </div>
      </div>`;
  }).join('');

  alvo.querySelectorAll('.pendente').forEach((el) => {
    el.addEventListener('click', () => abrirFichaPendente(el.dataset.id));
  });
  alvo.querySelectorAll('img[data-foto]').forEach((img) => {
    carregarImagem(`/api/fila/${img.dataset.foto}/imagem`, img);
  });
}

$('btnAtualizarFila').addEventListener('click', atualizarFila);

/* ---------- Ficha (foto ao lado dos dados) ---------- */
let giro = 0;
let baseImagem = '';   // /api/fila/<id> ou /api/contatos/<id>

/** Prepara o alternador Frente/Verso e carrega o lado pedido. */
function mostrarLado(lado) {
  document.querySelectorAll('#seletorLados .lado')
    .forEach((b) => b.classList.toggle('ativo', b.dataset.lado === lado));
  giro = 0;
  aplicarGiro();
  carregarImagem(`${baseImagem}/imagem${lado === 'verso' ? '/verso' : ''}`, $('fichaImagem'));
}

function configurarLados(base, temVerso) {
  baseImagem = base;
  $('seletorLados').hidden = !temVerso;
  mostrarLado('frente');
}

document.querySelectorAll('#seletorLados .lado').forEach((b) => {
  b.addEventListener('click', () => mostrarLado(b.dataset.lado));
});

/* Adicionar o verso depois: cobre quem fotografou a frente e so entao virou o cartao. */
$('btnAddVerso').addEventListener('click', () => $('arquivoVerso').click());

$('arquivoVerso').addEventListener('change', async (e) => {
  const arquivo = e.target.files[0];
  e.target.value = '';
  if (!arquivo || !estado.conferindo) return;
  try {
    const dataUrl = await redimensionar(arquivo);
    await api(`/api/fila/${estado.conferindo}/verso`, {
      method: 'POST',
      body: JSON.stringify({ imagem: dataUrl })
    });
    $('dlgFicha').close();
    mensagem('Verso anexado. A IA está relendo o cartão com os dois lados.', 'ok');
    setTimeout(atualizarFila, 2500);
  } catch (err) {
    mensagem(err.message, 'erro');
  }
});

function aplicarGiro() {
  $('fichaImagem').style.transform = `rotate(${giro}deg)`;
  $('fichaImagem').classList.toggle('deitada', giro % 180 !== 0);
}

$('btnGirarFoto').addEventListener('click', () => { giro = (giro + 90) % 360; aplicarGiro(); });

$('btnAbrirFoto').addEventListener('click', () => {
  const src = $('fichaImagem').getAttribute('src');
  if (src) window.open(src, '_blank');
});

$('btnFecharFicha').addEventListener('click', () => $('dlgFicha').close());

function abrirFicha() {
  giro = 0;
  aplicarGiro();
  if (!$('dlgFicha').open) $('dlgFicha').showModal();
  $('dlgFicha').scrollTop = 0;
}

async function abrirFichaPendente(id) {
  try {
    const item = await api(`/api/fila/${id}`);
    estado.conferindo = id;
    estado.editando = null;

    if (item.status !== 'aguardando' && item.status !== 'erro') {
      mensagem('Esse cartão ainda está sendo lido pela IA. Tente de novo em instantes.', 'atencao');
      return;
    }

    preencherFormulario({
      ...(item.dados || {}),
      origem_evento: item.origem_evento,
      origem_local: item.origem_local
    });

    let aviso = '';
    if (item.status === 'erro') {
      aviso += `<div class="aviso erro">A IA não conseguiu ler este cartão: ${escapar(item.erro || '')}
        <button type="button" class="secundario" id="btnReprocessar">Tentar de novo</button></div>`;
    }
    if (item.dados?.e_cartao_valido === false) {
      aviso += `<div class="aviso atencao">A IA não reconheceu isto como um cartão de visita. ${escapar(item.dados.observacoes_leitura || '')}</div>`;
    }
    if (item.dados?.confianca !== null && item.dados?.confianca < 0.7) {
      aviso += '<div class="aviso atencao">Confiança baixa na leitura — confira campo por campo.</div>';
    }
    if (item.duplicados?.length) {
      const nomes = item.duplicados.map((d) => `${d.nome || '(sem nome)'} — ${d.empresa || ''}`).join('; ');
      aviso += `<div class="aviso atencao">Possível contato já cadastrado: ${escapar(nomes)}</div>`;
    }
    $('avisoIA').innerHTML = aviso;

    if ($('btnReprocessar')) {
      $('btnReprocessar').addEventListener('click', async () => {
        await api(`/api/fila/${id}/reprocessar`, { method: 'POST', body: '{}' });
        $('dlgFicha').close();
        mensagem('Mandei ler de novo. Acompanhe na conferência.', 'ok');
        setTimeout(atualizarFila, 2000);
      });
    }

    $('fichaMeta').textContent = item.meta
      ? `Lido em ${(item.meta.ms / 1000).toFixed(1)}s por ${item.meta.modelo}`
        + (item.meta.lados > 1 ? ' · frente e verso' : '')
      : '';
    $('btnSalvar').textContent = 'Confirmar e salvar';
    $('btnDescartar').hidden = false;
    $('btnExcluir').hidden = true;

    $('btnAddVerso').hidden = item.tem_verso;
    abrirFicha();
    configurarLados(`/api/fila/${id}`, item.tem_verso);
  } catch (e) {
    mensagem(e.message, 'erro');
  }
}

async function abrirFichaContato(id) {
  try {
    const c = await api(`/api/contatos/${id}`);
    estado.editando = id;
    estado.conferindo = null;
    preencherFormulario(c);
    estado.dados = c;
    $('avisoIA').innerHTML = '<div class="aviso ok">Editando um contato já cadastrado.</div>';
    $('fichaMeta').textContent = c.registrado_por ? `Cadastrado por ${c.registrado_por}` : '';
    $('btnSalvar').textContent = 'Salvar alterações';
    $('btnDescartar').hidden = true;
    $('btnExcluir').hidden = false;

    $('btnAddVerso').hidden = true;
    abrirFicha();
    if (c.imagem_key) configurarLados(`/api/contatos/${id}`, Boolean(c.imagem_verso_key));
    else { $('seletorLados').hidden = true; $('fichaImagem').removeAttribute('src'); }
  } catch (e) {
    mensagem(e.message, 'erro');
  }
}

/* ---------- Formulario ---------- */
function opcoes(select, valores, rotuloVazio) {
  select.innerHTML = (rotuloVazio ? `<option value="">${rotuloVazio}</option>` : '')
    + valores.map((v) => `<option value="${v}">${rotular(v)}</option>`).join('');
}

function preencherFormulario(d = {}) {
  const campos = ['nome', 'cargo', 'empresa', 'sigla', 'departamento', 'telefone', 'celular',
    'email', 'email_secundario', 'site', 'endereco', 'cidade', 'uf', 'cep',
    'linkedin', 'instagram', 'facebook', 'twitter', 'outras_redes', 'setor',
    'segmento', 'prioridade', 'resumo_ia', 'temas', 'observacoes', 'status'];
  campos.forEach((c) => {
    const el = $(c);
    if (!el) return;
    const v = d[c];
    el.value = Array.isArray(v) ? v.join(', ') : (v ?? '');
  });
  $('status').value = d.status || 'novo';
  $('f_origem_evento').value = d.origem_evento || $('origem_evento').value;
  $('f_origem_local').value = d.origem_local || $('origem_local').value;
  $('data_captura').value = (d.data_captura || new Date().toISOString().slice(0, 10)).slice(0, 10);
  estado.dados = d;
}

function lerFormulario() {
  const corpo = {};
  new FormData($('formulario')).forEach((v, k) => { corpo[k] = v; });
  if (estado.dados) corpo.confianca = estado.dados.confianca ?? null;
  return corpo;
}

$('formulario').addEventListener('submit', async (e) => {
  e.preventDefault();
  const corpo = lerFormulario();
  if (!corpo.nome?.trim() && !corpo.empresa?.trim()) {
    mensagem('Informe pelo menos o nome ou a empresa.', 'erro');
    return;
  }
  $('btnSalvar').disabled = true;
  try {
    if (estado.conferindo) {
      await api(`/api/fila/${estado.conferindo}/confirmar`, { method: 'POST', body: JSON.stringify(corpo) });
      mensagem('Contato conferido e salvo.', 'ok');
    } else if (estado.editando) {
      await api(`/api/contatos/${estado.editando}`, { method: 'PUT', body: JSON.stringify(corpo) });
      mensagem('Contato atualizado.', 'ok');
    }
    fecharFicha();
    atualizarFila();
    if (abaAtiva() === 'contatos') carregarLista();
  } catch (err) {
    mensagem(err.message, 'erro');
  } finally {
    $('btnSalvar').disabled = false;
  }
});

$('btnDescartar').addEventListener('click', async () => {
  if (!estado.conferindo || !confirm('Descartar este cartão? A foto será apagada.')) return;
  await api(`/api/fila/${estado.conferindo}`, { method: 'DELETE' });
  mensagem('Cartão descartado.', 'ok');
  fecharFicha();
  atualizarFila();
});

$('btnExcluir').addEventListener('click', async () => {
  if (!estado.editando || !confirm('Excluir este contato definitivamente?')) return;
  await api(`/api/contatos/${estado.editando}`, { method: 'DELETE' });
  mensagem('Contato excluído.', 'ok');
  fecharFicha();
  carregarLista();
});

function fecharFicha() {
  estado.editando = null;
  estado.conferindo = null;
  estado.dados = null;
  $('formulario').reset();
  $('avisoIA').innerHTML = '';
  $('dlgFicha').close();
}

$('dlgFicha').addEventListener('close', () => {
  const img = $('fichaImagem');
  if (img.dataset.blob) { URL.revokeObjectURL(img.dataset.blob); delete img.dataset.blob; }
  img.removeAttribute('src');
});

/* ---------- Lista de contatos ---------- */
let temporizador;
$('busca').addEventListener('input', () => {
  clearTimeout(temporizador);
  temporizador = setTimeout(carregarLista, 350);
});
['f_setor', 'f_segmento', 'f_prioridade', 'f_status'].forEach((id) => $(id).addEventListener('change', carregarLista));
$('btnAtualizar').addEventListener('click', carregarLista);

function filtrosAtuais() {
  const p = new URLSearchParams();
  if ($('busca').value.trim()) p.set('q', $('busca').value.trim());
  if ($('f_setor').value) p.set('setor', $('f_setor').value);
  if ($('f_segmento').value) p.set('segmento', $('f_segmento').value);
  if ($('f_prioridade').value) p.set('prioridade', $('f_prioridade').value);
  if ($('f_status').value) p.set('status', $('f_status').value);
  return p;
}

$('btnCsv').addEventListener('click', async () => {
  try {
    const resp = await fetch(`/api/export.csv?${filtrosAtuais()}`, { headers: cabecalhos() });
    if (!resp.ok) throw new Error('Falha ao exportar.');
    const url = URL.createObjectURL(await resp.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `contatos-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    mensagem(e.message, 'erro');
  }
});

async function carregarLista() {
  const lista = $('lista');
  lista.innerHTML = '<div class="vazio">Carregando…</div>';
  try {
    const r = await api(`/api/contatos?${filtrosAtuais()}`);
    $('resumoLista').textContent = `${r.total} contato(s)`;
    if (!r.contatos.length) {
      lista.innerHTML = '<div class="vazio">Nenhum contato encontrado.</div>';
      return;
    }
    lista.innerHTML = r.contatos.map((c) => `
      <div class="contato ${escapar(c.prioridade)}" data-id="${c.id}">
        <b>${escapar(c.nome) || '(sem nome)'}</b>
        <span>${escapar([c.cargo, c.sigla ? `${c.sigla} — ${c.empresa}` : c.empresa].filter(Boolean).join(' · '))}</span>
        <span>${escapar([c.celular || c.telefone, c.email].filter(Boolean).join(' · '))}</span>
        <div class="etiquetas">
          <span class="etiqueta ${escapar(c.prioridade)}">Prioridade ${rotular(c.prioridade)}</span>
          <span class="etiqueta">${rotular(c.setor)}</span>
          <span class="etiqueta">${rotular(c.segmento)}</span>
          ${c.origem_evento ? `<span class="etiqueta">${escapar(c.origem_evento)}</span>` : ''}
        </div>
      </div>`).join('');
    lista.querySelectorAll('.contato').forEach((el) => {
      el.addEventListener('click', () => abrirFichaContato(el.dataset.id));
    });
  } catch (e) {
    lista.innerHTML = `<div class="aviso erro">${escapar(e.message)}</div>`;
  }
}

/* ---------- Painel ---------- */
function barras(alvo, dados) {
  const max = Math.max(1, ...dados.map((d) => d.n));
  $(alvo).innerHTML = dados.filter((d) => d.chave).map((d) => `
    <div class="barra">
      <i>${rotular(d.chave)}</i>
      <div style="width:${Math.round((d.n / max) * 100)}%"></div>
      <span>${d.n}</span>
    </div>`).join('') || '<div class="vazio">Sem dados ainda.</div>';
}

async function carregarPainel() {
  try {
    const e = await api('/api/estatisticas');
    const alta = (e.por_prioridade.find((p) => p.chave === 'alta') || {}).n || 0;
    $('numeros').innerHTML = `
      <div class="numero"><b>${e.total}</b><span>Contatos</span></div>
      <div class="numero"><b>${e.hoje}</b><span>Hoje</span></div>
      <div class="numero"><b>${alta}</b><span>Prioridade alta</span></div>
      <div class="numero"><b>${estado.fila.contagem.aguardando || 0}</b><span>A conferir</span></div>`;
    barras('grafSetor', e.por_setor);
    barras('grafPrioridade', e.por_prioridade);
    barras('grafSegmento', e.por_segmento.slice(0, 10));
  } catch (err) {
    $('numeros').innerHTML = `<div class="aviso erro">${escapar(err.message)}</div>`;
  }
}

/* ---------- Equipe ---------- */
async function carregarEquipe() {
  try {
    const r = await api('/api/usuarios');
    if (!$('novoCodigo').value) $('novoCodigo').value = r.sugestao;
    $('listaEquipe').innerHTML = r.usuarios.map((u) => `
      <div class="contato" data-id="${u.id}">
        <b>${escapar(u.nome)}</b>
        <span>${u.papel === 'admin' ? 'Administração' : 'Equipe'}${u.ativo ? '' : ' · desativado'}</span>
        <span class="dica">${u.ultimo_acesso ? `Último acesso: ${new Date(u.ultimo_acesso).toLocaleString('pt-BR')}` : 'Nunca entrou'}</span>
        ${u.ativo ? `<div class="botoes"><button class="perigo" data-desativar="${u.id}">Desativar</button></div>` : ''}
      </div>`).join('') || '<div class="vazio">Ninguém cadastrado ainda.</div>';

    $('listaEquipe').querySelectorAll('[data-desativar]').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!confirm('Desativar o acesso desta pessoa?')) return;
        await api(`/api/usuarios/${b.dataset.desativar}`, { method: 'DELETE' });
        carregarEquipe();
      });
    });
  } catch (e) {
    $('listaEquipe').innerHTML = `<div class="aviso erro">${escapar(e.message)}</div>`;
  }
}

$('btnOutroCodigo').addEventListener('click', async () => {
  const r = await api('/api/usuarios');
  $('novoCodigo').value = r.sugestao;
});

$('btnCriarUsuario').addEventListener('click', async () => {
  const nome = $('novoNome').value.trim();
  const codigo = $('novoCodigo').value.trim();
  try {
    await api('/api/usuarios', {
      method: 'POST',
      body: JSON.stringify({ nome, codigo, papel: $('novoPapel').value })
    });
    $('avisoEquipe').innerHTML = `<div class="aviso ok">
      <b>${escapar(nome)}</b> cadastrado(a). Entregue este código: <code class="codigo">${escapar(codigo)}</code><br>
      Anote agora — ele não aparece de novo.</div>`;
    $('novoNome').value = '';
    $('novoCodigo').value = '';
    carregarEquipe();
  } catch (e) {
    $('avisoEquipe').innerHTML = `<div class="aviso erro">${escapar(e.message)}</div>`;
  }
});

/* ---------- API e webhooks (so admin) ---------- */
const ROTULO_EVENTO = {
  'contato.criado': 'Contato criado',
  'contato.atualizado': 'Contato atualizado',
  'contato.excluido': 'Contato excluído'
};

async function carregarIntegracoes() {
  await Promise.all([carregarTokens(), carregarWebhooks()]);
}

async function carregarTokens() {
  try {
    const r = await api('/api/tokens');
    $('listaTokens').innerHTML = r.tokens.map((t) => `
      <div class="contato">
        <b>${escapar(t.nome)}</b>
        <span>${t.ativo ? 'Ativo' : 'Revogado'} · somente leitura · ${t.chamadas} chamada(s)</span>
        <span class="dica">${t.ultimo_uso ? `Último uso: ${new Date(t.ultimo_uso).toLocaleString('pt-BR')}` : 'Nunca usado'}</span>
        ${t.ativo ? `<div class="botoes"><button class="perigo" data-revogar="${t.id}">Revogar</button></div>` : ''}
      </div>`).join('') || '<div class="vazio">Nenhum token gerado.</div>';

    $('listaTokens').querySelectorAll('[data-revogar]').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!confirm('Revogar este token? O sistema que o usa para de consultar na hora.')) return;
        await api(`/api/tokens/${b.dataset.revogar}`, { method: 'DELETE' });
        carregarTokens();
      });
    });
  } catch (e) {
    $('listaTokens').innerHTML = `<div class="aviso erro">${escapar(e.message)}</div>`;
  }
}

$('btnCriarToken').addEventListener('click', async () => {
  const nome = $('novoTokenNome').value.trim();
  try {
    const r = await api('/api/tokens', { method: 'POST', body: JSON.stringify({ nome }) });
    $('avisoToken').innerHTML = `<div class="aviso ok">
      Token de <b>${escapar(r.nome)}</b> gerado. Entregue ao desenvolvedor:
      <code class="codigo">${escapar(r.token)}</code><br>
      Anote agora — ele não aparece de novo.</div>`;
    $('novoTokenNome').value = '';
    carregarTokens();
  } catch (e) {
    $('avisoToken').innerHTML = `<div class="aviso erro">${escapar(e.message)}</div>`;
  }
});

async function carregarWebhooks() {
  try {
    const r = await api('/api/webhooks');

    if (!$('eventosHook').dataset.pronto) {
      $('eventosHook').innerHTML = r.eventos.map((ev) => `
        <label class="alternador">
          <input type="checkbox" value="${ev}" checked>
          <span>${ROTULO_EVENTO[ev] || ev} <code>${ev}</code></span>
        </label>`).join('');
      $('eventosHook').dataset.pronto = '1';
    }

    $('listaHooks').innerHTML = r.webhooks.map((h) => `
      <div class="contato ${h.ativo ? '' : 'alta'}">
        <b>${escapar(h.nome)}</b>
        <span>${escapar(h.url)}</span>
        <span class="dica">${escapar(h.eventos)}</span>
        <span class="dica">${h.ativo ? 'Ativo' : 'Desativado após falhas seguidas'}${
          h.ultima_entrega ? ` · última entrega ${new Date(h.ultima_entrega).toLocaleString('pt-BR')} (HTTP ${h.ultimo_status ?? '—'})` : ' · nunca disparado'
        }</span>
        <div class="botoes">
          <button class="secundario" data-testar="${h.id}">Enviar teste</button>
          <button class="perigo" data-apagar="${h.id}">Remover</button>
        </div>
      </div>`).join('') || '<div class="vazio">Nenhum webhook cadastrado.</div>';

    $('listaHooks').querySelectorAll('[data-testar]').forEach((b) => {
      b.addEventListener('click', async () => {
        b.disabled = true;
        const r2 = await api(`/api/webhooks/${b.dataset.testar}/testar`, { method: 'POST', body: '{}' });
        $('avisoHook').innerHTML = r2.ok
          ? '<div class="aviso ok">Teste entregue: a URL respondeu 2xx.</div>'
          : `<div class="aviso erro">${escapar(r2.erro)}</div>`;
        b.disabled = false;
        carregarWebhooks();
      });
    });
    $('listaHooks').querySelectorAll('[data-apagar]').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!confirm('Remover este webhook?')) return;
        await api(`/api/webhooks/${b.dataset.apagar}`, { method: 'DELETE' });
        carregarWebhooks();
      });
    });

    $('listaEntregas').innerHTML = r.entregas.map((e) => `
      <div class="entrega">
        <span class="etiqueta ${e.status >= 200 && e.status < 300 ? 'baixa' : 'alta'}">${e.status ?? 'sem resposta'}</span>
        <span>${escapar(e.evento)}</span>
        <span class="dica">${new Date(e.criado_em).toLocaleString('pt-BR')}${e.erro ? ` · ${escapar(e.erro)}` : ''}</span>
      </div>`).join('') || '<div class="vazio">Nenhuma entrega ainda.</div>';
  } catch (e) {
    $('listaHooks').innerHTML = `<div class="aviso erro">${escapar(e.message)}</div>`;
  }
}

$('btnCriarHook').addEventListener('click', async () => {
  const eventos = [...$('eventosHook').querySelectorAll('input:checked')].map((i) => i.value);
  try {
    const r = await api('/api/webhooks', {
      method: 'POST',
      body: JSON.stringify({
        nome: $('novoHookNome').value.trim(),
        url: $('novoHookUrl').value.trim(),
        eventos
      })
    });
    $('avisoHook').innerHTML = `<div class="aviso ok">
      Webhook <b>${escapar(r.nome)}</b> criado. Segredo para validar a assinatura:
      <code class="codigo">${escapar(r.segredo)}</code><br>
      Anote agora — ele não aparece de novo.</div>`;
    $('novoHookNome').value = '';
    $('novoHookUrl').value = '';
    carregarWebhooks();
  } catch (e) {
    $('avisoHook').innerHTML = `<div class="aviso erro">${escapar(e.message)}</div>`;
  }
});

/* ---------- Atualizacao periodica da fila ---------- */
setInterval(() => {
  if (document.visibilityState !== 'visible' || !estado.usuario) return;
  const emLeitura = (estado.fila.contagem.na_fila || 0) + (estado.fila.contagem.lendo || 0);
  // so insiste enquanto ha cartao sendo lido, ou quando a aba esta aberta
  if (emLeitura || abaAtiva() === 'conferencia') atualizarFila();
}, 5000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') atualizarFila();
});

/* ---------- Inicio ---------- */
(async function iniciar() {
  try {
    estado.config = await fetch('/api/config').then((r) => r.json());
    // a faixa institucional so aparece quando o orgao esta configurado:
    // fora dele, o sistema e generico e nao carrega brasao de ninguem
    if (estado.config.orgao) {
      $('orgao').textContent = estado.config.orgao;
      $('subtitulo').textContent = estado.config.gabinete;
      $('institucional').hidden = false;
      document.querySelector('.brasao')?.setAttribute('alt', estado.config.orgao);
    }
    document.title = `Scanner de Cartões — ${estado.config.gabinete}`;
    opcoes($('setor'), estado.config.setores);
    opcoes($('segmento'), estado.config.segmentos);
    opcoes($('prioridade'), estado.config.prioridades);
    opcoes($('f_setor'), estado.config.setores, 'Todos');
    opcoes($('f_segmento'), estado.config.segmentos, 'Todos');
    opcoes($('f_prioridade'), estado.config.prioridades, 'Todas');
  } catch (e) {
    mensagem(`Não consegui carregar a configuração: ${e.message}`, 'erro');
  }

  if (ler('acesso')) await entrar();
  else abrirAcesso();
})();
