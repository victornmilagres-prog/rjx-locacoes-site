/* =====================================================================
   Controle de Insumos — tela do motorista
   Transportes → Minhas Locações: "Locações abertas" e "Locações fechadas",
   aviso ao abrir a intranet e as 6 etapas do Ultraformer.
   Usa da intranet: sb, currentUsuario, toast, initSignaturePad,
   rjxSubSalvar, selectModule. Usa window.CICalc e window.CIUI.
   Só os nomes ci* vão para o escopo global.
   ===================================================================== */
(function () {
  'use strict';

  const C = window.CICalc;
  const U = window.CIUI;
  const { esc, dataBR, dtBR, quando, abrirModal, fecharModal, confirma } = U;
  const $ = id => document.getElementById(id);
  const TABELA = 'controle_locacoes';
  const BUCKET = 'controle-insumos';
  const CHAVE_DET = 'rjx_ci_det';
  const IA_TIMEOUT_MS = 12000;

  const ST = { sub: 'abertas', det: null, linhas: [], nomes: {}, urls: {}, pend: {}, timers: {} };

  /* ---------------- quem é quem ---------------- */
  const eu = () => (typeof currentUsuario !== 'undefined' && currentUsuario) || {};
  const ehGerencial = () => eu().papel === 'gerencial';
  const souEu = id => id && id === eu().id;
  const nome = id => (souEu(id) ? eu().nome : ST.nomes[id]) || 'outro motorista';
  const faseEntrega = l => l.status === 'inicial' || l.status === 'sig_entrega';
  const dono = l => (faseEntrega(l) ? l.motEntregaId : l.motRetiradaId);
  const abertas = () => ST.linhas.filter(l => l.status !== 'concluido' && (ehGerencial() || souEu(dono(l))));
  const fechadas = () => ST.linhas.filter(l => l.status === 'concluido')
    .sort((a, b) => String(b.finalizadaEm || '').localeCompare(String(a.finalizadaEm || '')));
  const entradaHist = txt => ({ ts: new Date().toISOString(), quem: eu().nome || 'Motorista', txt: txt });
  const cartuchos = l => C.expand(l, C.linearDe(l)).concat(C.expand(l, C.BOOSTER));
  const etapaInfo = l => (C.ETAPAS[l.status] || [6, 'Finalizada']);

  function lembrarDet(id) { ST.det = id; try { id ? localStorage.setItem(CHAVE_DET, id) : localStorage.removeItem(CHAVE_DET); } catch (e) {} }
  function detSalvo() { try { return localStorage.getItem(CHAVE_DET); } catch (e) { return null; } }

  /* ---------------- dados ---------------- */
  async function carregarNomes() {
    try {
      const r = await sb.rpc('ci_nomes_motoristas');
      if (!r.error) (r.data || []).forEach(m => { ST.nomes[m.id] = m.nome; });
    } catch (e) { /* sem nomes, a tela segue com "outro motorista" */ }
  }
  async function carregarLinhas() {
    const r = await sb.from(TABELA).select('*').order('data_locacao', { ascending: true }).order('horario_montagem', { ascending: true });
    if (r.error) throw new Error(r.error.message);
    ST.linhas = (r.data || []).map(C.locDeLinha);
  }
  async function buscar(id) {
    const r = await sb.from(TABELA).select('*').eq('id', id).maybeSingle();
    if (r.error) throw new Error(r.error.message);
    return r.data ? C.locDeLinha(r.data) : null;
  }

  /* Todas as gravações passam por aqui, uma de cada vez, relendo a linha
     antes: assim uma foto não apaga a outra e o histórico só cresce. */
  class Mudou extends Error {}
  let filaGravacao = Promise.resolve();
  function serial(fn) { const p = filaGravacao.then(fn, fn); filaGravacao = p.catch(() => {}); return p; }
  function gravar(id, montar) {
    return serial(async () => {
      for (let tentativa = 0; tentativa < 3; tentativa++) {
        const r = await sb.from(TABELA).select('*').eq('id', id).maybeSingle();
        if (r.error) throw new Error(r.error.message);
        if (!r.data) throw new Mudou('A locação mudou: ela não está mais com você.');
        const atual = C.locDeLinha(r.data);
        if (!ehGerencial() && !souEu(dono(atual))) throw new Mudou('A locação mudou: esta etapa não está mais com você.');
        const m = montar(atual);
        if (!m) return atual;
        const patch = Object.assign({}, m.patch);
        if (m.hist && m.hist.length) patch.historico = m.hist.map(entradaHist).reverse().concat(r.data.historico || []);
        const u = await sb.from(TABELA).update(patch).eq('id', id).select('*');
        if (!u.error && u.data && u.data.length) return C.locDeLinha(u.data[0]);
        if (u.error && /hist[oó]rico/i.test(u.error.message)) continue;
        if (u.error && /locação mudou|não está mais com você/i.test(u.error.message)) throw new Mudou(u.error.message);
        if (u.error) throw new Error(u.error.message);
        throw new Mudou('A locação mudou: ela não está mais com você.');
      }
      throw new Error('Não foi possível salvar. Tente de novo.');
    });
  }
  function avisarErro(err) {
    if (err instanceof Mudou) {
      abrirModal('A locação mudou', '<p style="margin:0;font-size:14px;line-height:1.5">' + esc(err.message) +
        ' A Yasmin pode ter trocado o motorista ou reaberto a etapa. O que você já registrou continua guardado.</p>',
        '<button type="button" class="btn btn-primary" id="ci-mudou-ok">Voltar para a lista</button>');
      $('ci-mudou-ok').onclick = async () => { fecharModal(); lembrarDet(null); await recarregar(); };
      return;
    }
    toast('Erro: ' + (err && err.message ? err.message : err));
  }

  /* ================= entrada: Transportes → Minhas Locações ================= */
  async function ciCarregarTransportes() {
    const content = $('transportes-content');
    if (!content) return;
    content.innerHTML = '<p class="empty-hint">Carregando...</p>';
    try {
      await esperarRascunho();
      await carregarNomes();
      await carregarLinhas();
    } catch (err) {
      content.innerHTML = '<div class="ci-err">Não foi possível carregar Minhas Locações: ' + esc(err.message) + '</div>';
      return;
    }
    if (!ST.det) { const d = detSalvo(); if (d) ST.det = d; }
    enviarPendentes();
    render();
  }
  async function recarregar() { await esperarRascunho(); await carregarLinhas(); render(); }

  function render() {
    const content = $('transportes-content');
    if (!content) return;
    window.scrollTo(0, 0);
    if (ST.det && !ehGerencial()) {
      const l = ST.linhas.find(x => x.id === ST.det);
      if (l && l.status !== 'concluido' && souEu(dono(l))) return telaEtapa(l);
      lembrarDet(null);
    }
    const nA = abertas().length, nF = fechadas().length;
    const aba = (n, rot, qtd) => '<button type="button" class="subtab' + (ST.sub === n ? ' active' : '') + '" data-ci-sub="' + n + '">' + rot +
      (qtd ? '<span class="ci-n">' + qtd + '</span>' : '') + '</button>';
    content.innerHTML = '<div class="ci-tabs">' + aba('abertas', 'Locações abertas', nA) + aba('fechadas', 'Locações fechadas', nF) +
      '</div><div class="ci-wrap" id="ci-m-area"></div>';
    content.querySelectorAll('[data-ci-sub]').forEach(b => b.onclick = () => { ST.sub = b.dataset.ciSub; render(); });
    if (ST.sub === 'fechadas') return telaFechadas();
    return telaAbertas();
  }

  /* ---------------- faixa do contrato ---------------- */
  function contratoBox(l) {
    if (l.contrato === true) return '<div class="ci-ct ok">Contrato assinado</div>';
    return '<div class="ci-ct no">CONTRATO NÃO ASSINADO<small>Pegue a assinatura da doutora no contrato do Estoque Now antes de montar o equipamento.</small></div>';
  }
  function passos(l) {
    const n = etapaInfo(l)[0];
    return '<div class="ci-steps" aria-hidden="true">' + [1, 2, 3, 4, 5, 6].map(i => '<i class="' + (i < n ? 'on' : i === n ? 'atual' : '') + '"></i>').join('') + '</div>';
  }
  /* ---------------- horário da montagem em destaque ---------------- */
  function montagemTxt(l) {
    const d = new Date(String(l.data).slice(0, 10) + 'T00:00:00');
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const dif = Math.round((d - hoje) / 864e5);
    const dia = isNaN(dif) ? dataBR(l.data)
      : dif === 0 ? 'Hoje' : dif === 1 ? 'Amanhã' : dif === -1 ? 'Ontem'
      : d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
    return { dia, hora: l.horario || 'sem horário', proxima: !isNaN(dif) && dif <= 1 };
  }
  function montagemBox(l) {
    const m = montagemTxt(l);
    return '<div class="ci-montagem' + (m.proxima ? ' proxima' : '') + '"><small>Montagem prevista</small><b>' + esc(m.dia) + ' às ' + esc(m.hora) + '</b></div>';
  }
  function entregaFeitaPor(l) {
    return !faseEntrega(l) && l.motEntregaId !== l.motRetiradaId ? 'entrega feita por ' + nome(l.motEntregaId) : '';
  }

  /* ================= Locações abertas ================= */
  function telaAbertas() {
    const area = $('ci-m-area');
    const L = abertas();
    if (!L.length) {
      area.innerHTML = '<div class="card"><p class="empty-hint"><b>Nenhuma locação aberta</b><br>Quando a Yasmin ligar uma locação a você, ela aparece aqui.</p></div>';
      return;
    }
    area.innerHTML = (ehGerencial() ? '<p class="ci-intro">Visão do Gerencial: todas as locações abertas, somente leitura.</p>'
      : '<p class="ci-intro">' + L.length + ' locação(ões) esperando por você.</p>') + L.map(l => {
      const ent = faseEntrega(l), feita = entregaFeitaPor(l);
      return '<div class="card loc-card"><div class="loc-top"><div><div class="loc-eq">' + esc(C.EQUIP[l.equipamento]) + '</div>' +
        '<div class="loc-name">Nº ' + esc(l.numero) + ' · ' + esc(l.doutora) + '</div></div>' +
        '<span class="status-pill ' + (ent ? 'status-wait' : 'status-info') + '"><span class="dot"></span>' + (ent ? 'Entrega' : 'Retirada') + '</span></div>' +
        montagemBox(l) + contratoBox(l) + passos(l) +
        '<div class="ci-etapa">Próxima etapa: ' + esc(U.etapaNome(l)) + (feita ? ' · ' + esc(feita) : '') +
          (ehGerencial() ? ' · com ' + esc(nome(dono(l))) : '') + '</div>' +
        '<div class="ci-acoes" style="margin:12px 0 0">' +
          (l.assinaturas && l.assinaturas.entrega ? '<button type="button" class="btn btn-outline btn-block" data-rel="' + esc(l.id) + '">Abrir relatório de entrega</button>' : '') +
          (ehGerencial() ? '<button type="button" class="btn btn-ghost btn-block" data-excluir="' + esc(l.id) + '">Excluir</button>'
            : '<button type="button" class="btn btn-primary btn-block" data-abrir="' + esc(l.id) + '">Continuar</button>') +
        '</div></div>';
    }).join('');
    ligarExcluir(area);
    area.querySelectorAll('[data-abrir]').forEach(b => b.onclick = async () => {
      lembrarDet(b.dataset.abrir);
      try { await carregarLinhas(); } catch (e) {}
      render();
    });
    area.querySelectorAll('[data-rel]').forEach(b => b.onclick = () => abrirRelatorioEntrega(ST.linhas.find(x => x.id === b.dataset.rel)));
  }

  function abrirRelatorioEntrega(l) {
    if (typeof window.ciAbrirRelatorioEntrega === 'function') return window.ciAbrirRelatorioEntrega(l, ST.nomes);
    toast('O relatório de entrega fica pronto na etapa dos PDFs.');
  }
  function abrirPdfFinal(l) {
    if (typeof window.ciAbrirPdfFinal === 'function') return window.ciAbrirPdfFinal(l, ST.nomes);
    toast('O PDF final fica pronto na etapa dos PDFs.');
  }

  /* ================= Locações fechadas ================= */
  function telaFechadas() {
    const area = $('ci-m-area');
    const L = fechadas();
    if (!L.length) { area.innerHTML = '<div class="card"><p class="empty-hint"><b>Nenhuma locação fechada</b><br>As locações concluídas ficam guardadas aqui.</p></div>'; return; }
    area.innerHTML = '<p class="ci-intro">Fotos e assinaturas ficam guardadas por ' + C.DIAS_RETENCAO + ' dias. Depois disso, o resumo continua aqui.</p>' + L.map(l => {
      const f = l.financeiro || {};
      return '<div class="card loc-card"><div class="loc-top"><div><div class="loc-eq">' + esc(C.EQUIP[l.equipamento]) + '</div>' +
        '<div class="loc-name">Nº ' + esc(l.numero) + ' · ' + esc(l.doutora) + '</div><div class="loc-meta">' + esc(quando(l)) + '</div></div>' +
        (l.dadosApagadosEm ? '<span class="status-pill status-info">Só resumo</span>' : '<span class="status-pill status-ok"><span class="dot"></span>Fechada</span>') + '</div>' +
        '<div style="margin-top:10px">' +
          '<div class="ci-kv"><span>Entrega / retirada</span><span>' + esc(nome(l.motEntregaId)) + ' / ' + esc(nome(l.motRetiradaId)) + '</span></div>' +
          (l.equipamento === 'crio'
            ? '<div class="ci-kv"><span>Mantas utilizadas</span><span>' + (l.semManta ? '—' : esc(f.utilizadas)) + '</span></div>'
            : '<div class="ci-kv"><span>Disparos utilizados</span><span>' + C.fmtNum(f.totalGeral) + '</span></div><div class="ci-kv"><span>Valor do disparo</span><span>' + C.fmtMoney(f.unit) + '</span></div>') +
          '<div class="ci-kv forte"><span>Total</span><span>' + C.fmtMoney(f.total) + '</span></div></div>' +
        '<div class="ci-acoes" style="margin:12px 0 0"><button type="button" class="btn btn-outline btn-block" data-pdf="' + esc(l.id) + '">' + (l.dadosApagadosEm ? 'Abrir resumo em PDF' : 'Abrir PDF') + '</button>' +
          (ehGerencial() ? '<button type="button" class="btn btn-ghost btn-block" data-excluir="' + esc(l.id) + '">Excluir</button>' : '') + '</div></div>';
    }).join('');
    area.querySelectorAll('[data-pdf]').forEach(b => b.onclick = () => abrirPdfFinal(ST.linhas.find(x => x.id === b.dataset.pdf)));
    ligarExcluir(area);
  }

  /* Excluir: só o Gerencial, na visão de Transportes. Apaga a locação,
     as fotos e as assinaturas (mesma rota do botão da Yasmin). */
  function ligarExcluir(area) {
    if (!ehGerencial()) return;
    area.querySelectorAll('[data-excluir]').forEach(b => b.onclick = () => {
      const l = ST.linhas.find(x => x.id === b.dataset.excluir);
      if (!l) return;
      confirma('Excluir a locação nº ' + l.numero + '?',
        'Tudo o que foi registrado nela será apagado, inclusive fotos e assinaturas' + (l.status === 'concluido' ? ', e ela sai de Locações fechadas para os motoristas e para a Yasmin' : '') + '. Não dá para desfazer.',
        'Excluir', async () => {
          try {
            const s = await sb.auth.getSession();
            const token = s.data.session && s.data.session.access_token;
            const resp = await fetch('/api/controle-insumos?acao=excluir', {
              method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
              body: JSON.stringify({ id: l.id })
            });
            const d = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(d.error || 'Falha ao excluir.');
            toast('Locação nº ' + l.numero + ' excluída.');
          } catch (err) { toast('Erro ao excluir: ' + err.message); }
          await recarregar();
        });
    });
  }

  /* ================= aviso ao abrir a intranet ================= */
  async function ciAvisoEntrada() {
    if (eu().papel !== 'transportes') return;
    try { await carregarNomes(); await carregarLinhas(); } catch (e) { return; }
    const L = abertas();
    if (!L.length) return;
    abrirModal('Você tem controle de insumos',
      '<p style="margin:0 0 10px;font-size:13.5px;color:var(--gray)">' + (L.length === 1 ? 'Uma locação está esperando por você:' : L.length + ' locações estão esperando por você:') + '</p>' +
      L.map(l => { const m = montagemTxt(l); return '<div class="ci-aviso-item"><b>Nº ' + esc(l.numero) + ' · ' + esc(l.doutora) + '</b>' +
        '<span class="ci-aviso-hora' + (m.proxima ? ' proxima' : '') + '">Montagem: ' + esc(m.dia) + ' às ' + esc(m.hora) + '</span>' +
        '<span>' + esc(C.EQUIP[l.equipamento]) + ' · ' + (faseEntrega(l) ? 'Entrega' : 'Retirada') + '</span>' +
        (l.contrato === true ? '' : '<span class="ci-aviso-ct">contrato não assinado</span><span class="ci-aviso-ctx">Pegue a assinatura no contrato do Estoque Now.</span>') + '</div>'; }).join(''),
      '<button type="button" class="btn btn-ghost" id="ci-av-depois">Mais tarde</button><button type="button" class="btn btn-primary" id="ci-av-agora">Continuar agora</button>');
    $('ci-av-depois').onclick = fecharModal;
    $('ci-av-agora').onclick = () => {
      fecharModal();
      ST.sub = 'abertas';
      lembrarDet(L.length === 1 ? L[0].id : null);
      try { rjxSubSalvar('transportes', 'locacoes'); } catch (e) {}
      if (typeof selectModule === 'function') selectModule('transportes');
    };
  }

  /* ================= topo de todas as etapas ================= */
  function banner(l) {
    const crio = l.equipamento === 'crio', rows = [];
    if (l.horario) rows.push(['Montagem prevista', quando(l)]);
    if (crio) { rows.push(['Locação', C.fmtMoney(l.valorLocacao)]); rows.push(['Manta', l.semManta ? 'Não enviada' : C.fmtMoney(l.valorManta) + ' / un.']); }
    else {
      rows.push(['Locação', l.gratuidade === 'isenta' ? 'Isenta' : C.fmtMoney(l.valorLocacao)]);
      if (l.gratuidade === 'apartir') rows.push(['Gratuita a partir de', C.fmtNum(l.gratisAPartir) + ' disparos']);
      if (l.valorLavieen) rows.push(['Combo Lavieen', C.fmtMoney(l.valorLavieen)]);
      l.faixas.forEach(f => rows.push([(f.ate == null ? C.fmtNum(f.de) + ' disparos em diante' : C.fmtNum(f.de) + ' a ' + C.fmtNum(f.ate) + ' disparos'), C.fmtMoney(f.valor) + ' cada']));
    }
    if (l.frete) rows.push(['Frete', C.fmtMoney(l.valorFrete)]);
    return '<div class="ci-banner"><b>Condições da locação</b>' + (l.condicoes ? '<div class="ci-banner-obs">' + esc(l.condicoes) + '</div>' : '') +
      rows.map(r => '<div class="ci-kv"><span>' + esc(r[0]) + '</span><span>' + esc(r[1]) + '</span></div>').join('') + '</div>';
  }
  function topoEtapa(l) {
    const info = etapaInfo(l);
    return '<button type="button" class="ci-voltar" id="ci-voltar-lista">← Minhas Locações</button>' +
      '<h2 class="ci-titulo">' + esc(U.etapaNome(l)) + '</h2>' +
      '<p class="ci-sub">Nº ' + esc(l.numero) + ' · ' + esc(l.doutora) + ' · ' + esc(C.EQUIP[l.equipamento]) + ' · Etapa ' + info[0] + ' de 6</p>' +
      montagemBox(l) + contratoBox(l) + passos(l) + banner(l);
  }
  function ligarVoltar() { const v = $('ci-voltar-lista'); if (v) v.onclick = async () => { lembrarDet(null); await recarregar(); }; }

  function telaEtapa(l) {
    const content = $('transportes-content');
    const crio = l.equipamento === 'crio';
    const telas = { inicial: crio ? etEntregaCrio : etDisparo, sig_entrega: etSigEntrega, final: crio ? etRetornoCrio : etDisparo,
      condicoes: etCondicoes, sig_fechamento: etSigFech, revisao: etRevisao };
    (telas[l.status] || (() => { content.innerHTML = topoEtapa(l); }))(l);
    ligarVoltar();
  }

  /* ================= fotos ================= */
  // fila de fotos no aparelho (IndexedDB), para não perder foto com sinal ruim
  const FILA = {
    db: null, mem: {},
    async abrir() {
      if (this.db || !window.indexedDB) return this.db;
      try {
        this.db = await new Promise((res, rej) => {
          const r = indexedDB.open('rjx-ci-fila', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('fotos');
          r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
        });
      } catch (e) { this.db = null; }
      return this.db;
    },
    async put(item) {
      this.mem[item.k] = item;
      const db = await this.abrir(); if (!db) return;
      // no aparelho fica só o dado da foto; estado de tela (url, enviando) não
      const salvo = { k: item.k, locId: item.locId, etapa: item.etapa, key: item.key, ia: item.ia, blob: item.blob, w: item.w, h: item.h,
        ts: item.ts, origem: item.origem, geo: item.geo, path: item.path, usarIA: item.usarIA, subiu: !!item.subiu };
      try { await new Promise((res, rej) => { const t = db.transaction('fotos', 'readwrite'); t.objectStore('fotos').put(salvo, item.k); t.oncomplete = res; t.onerror = () => rej(t.error); }); } catch (e) {}
    },
    async del(k) {
      delete this.mem[k];
      const db = await this.abrir(); if (!db) return;
      try { await new Promise((res, rej) => { const t = db.transaction('fotos', 'readwrite'); t.objectStore('fotos').delete(k); t.oncomplete = res; t.onerror = () => rej(t.error); }); } catch (e) {}
    },
    async todos() {
      const db = await this.abrir();
      if (!db) return Object.values(this.mem);
      try {
        const lista = await new Promise((res, rej) => { const r = db.transaction('fotos').objectStore('fotos').getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); });
        // o que já está na memória é mais novo; do aparelho só entra o que faltava (ex.: depois de recarregar)
        lista.forEach(i => { if (!this.mem[i.k]) { i.estado = 'pendente'; this.mem[i.k] = i; } });
      } catch (e) {}
      return Object.values(this.mem);
    }
  };
  const chaveFila = (locId, etapa, key) => locId + '|' + etapa + '|' + key;
  const grupoFotos = etapa => ({ inicial: ['ultra', 'inicial'], final: ['ultra', 'final'], entrega: ['crio', 'entrega'], retorno: ['crio', 'retorno'] })[etapa];
  function fotosDe(l, etapa) { const g = grupoFotos(etapa); return (l.fotos[g[0]] || {})[g[1]] || {}; }
  function pendentesDe(locId, etapa) { return Object.values(FILA.mem).filter(i => i.locId === locId && i.etapa === etapa); }

  function getGeo() {
    return new Promise(resolve => {
      if (!navigator.geolocation) { resolve(null); return; }
      const t = setTimeout(() => resolve(null), 6000);
      navigator.geolocation.getCurrentPosition(
        pos => { clearTimeout(t); resolve({ lat: pos.coords.latitude.toFixed(5), lon: pos.coords.longitude.toFixed(5) }); },
        () => { clearTimeout(t); resolve(null); },
        { timeout: 5500 }
      );
    });
  }
  function comprimir(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = ev => {
        const img = new Image();
        img.onload = () => {
          let w = img.width, h = img.height; const M = 900;
          if (w > h) { if (w > M) { h = Math.round(h * M / w); w = M; } } else if (h > M) { w = Math.round(w * M / h); h = M; }
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          const dataUrl = c.toDataURL('image/jpeg', 0.6);
          c.toBlob(blob => blob ? res({ blob, dataUrl, w, h }) : rej(new Error('falha ao comprimir')), 'image/jpeg', 0.6);
        };
        img.onerror = rej; img.src = ev.target.result;
      };
      r.onerror = rej; r.readAsDataURL(file);
    });
  }
  function escolherArquivo(galeria) {
    return new Promise(res => {
      const i = document.createElement('input');
      i.type = 'file'; i.accept = 'image/*';
      if (!galeria) i.setAttribute('capture', 'environment');
      i.style.display = 'none'; document.body.appendChild(i);
      i.onchange = () => { res(i.files[0] || null); i.remove(); };
      i.click();
    });
  }
  function blobParaDataUrl(blob) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
  }

  async function lerIA(dataUrl) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), IA_TIMEOUT_MS);
    try {
      const s = await sb.auth.getSession();
      const token = s.data.session && s.data.session.access_token;
      const resp = await fetch('/api/ler-disparo', {
        method: 'POST', signal: ctrl.signal,
        headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
        body: JSON.stringify({ image: dataUrl })
      });
      if (!resp.ok) return { st: 'iaerro' };
      const d = await resp.json().catch(() => ({}));
      if (d.valor == null) return { st: 'naoleu' };
      return { st: 'ok', valor: parseInt(d.valor, 10) };
    } catch (e) {
      return { st: 'offline' };
    } finally { clearTimeout(t); }
  }
  function iaTexto(ia, valorCampo) {
    if (!ia) return null;
    if (ia.st === 'lendo') return ['', 'Lendo a foto...'];
    if (ia.st === 'ok') {
      const v = String(valorCampo || '').trim();
      if (v !== '' && C.parseInt0(v) !== ia.valor) return ['warn', 'IA leu ' + C.fmtNum(ia.valor) + '. Confira o número da tela'];
      return ['ok', 'Lido pela IA: ' + C.fmtNum(ia.valor)];
    }
    if (ia.st === 'naoleu') return ['warn', 'IA não conseguiu ler. Digite o número'];
    if (ia.st === 'offline') return ['bad', 'Sem internet. Digite o número'];
    return ['bad', 'IA indisponível. Digite o número'];
  }

  async function assinarUrls(paths) {
    const faltam = paths.filter(p => p && !ST.urls[p]);
    if (!faltam.length) return;
    try {
      const r = await sb.storage.from(BUCKET).createSignedUrls(faltam, 3600);
      (r.data || []).forEach(x => { if (x.signedUrl) ST.urls[x.path] = x.signedUrl; });
    } catch (e) {}
  }

  // desenha a área da foto de um cartucho (ou item da Crio)
  function pintaFoto(l, etapa, key, ia) {
    const el = $('ci-foto-' + key); if (!el) return;
    const meta = fotosDe(l, etapa)[key];
    const pend = FILA.mem[chaveFila(l.id, etapa, key)];
    const inp = $('ci-inp-' + key);
    const p = pend || meta;
    const met = $('ci-met-' + key);
    if (!p) {
      el.innerHTML = '<div class="ci-foto-bts"><button type="button" class="btn btn-sm btn-outline ci-f-cam">Tirar foto</button><button type="button" class="btn btn-sm btn-ghost ci-f-gal">Escolher da galeria</button></div>';
      if (met) met.classList.remove('div');
    } else {
      const src = pend ? (pend.url || '') : (ST.urls[meta.path] || '');
      let st;
      if (pend && pend.estado === 'enviando') st = ['', 'Enviando foto...'];
      else if (pend) st = ['bad', 'Foto pendente de envio. Tentando de novo...'];
      const iaT = ia ? iaTexto(p.ia, inp ? inp.value : '') : null;
      if (met) met.classList.toggle('div', !!(iaT && iaT[0] === 'warn' && p.ia && p.ia.st === 'ok'));
      el.innerHTML = '<div class="ci-foto-row">' + (src ? '<img src="' + esc(src) + '" alt="Foto registrada">' : '<div class="ci-foto-ph"></div>') +
        '<div class="ci-foto-meta">' +
          (st ? '<span class="ci-fs ' + st[0] + '">' + esc(st[1]) + '</span>' : '<span class="ci-fs ok">Foto anexada</span>') +
          (iaT ? '<span class="ci-fs ' + iaT[0] + '">' + esc(iaT[1]) + '</span>' : '') +
          '<span class="ci-ts">' + esc(dtBR(p.ts)) + ' · ' + (p.origem === 'galeria' ? 'da galeria' : 'câmera') + '</span>' +
          '<span class="ci-ts">' + (p.geo ? esc(p.geo.lat + ', ' + p.geo.lon) : 'localização não disponível') + '</span>' +
        '</div><div class="ci-foto-bts"><button type="button" class="btn btn-sm btn-ghost ci-f-cam">Tirar de novo</button><button type="button" class="btn btn-sm btn-ghost ci-f-gal">Galeria</button></div></div>';
    }
    el.querySelector('.ci-f-cam').onclick = () => captura(l.id, etapa, key, false, ia);
    el.querySelector('.ci-f-gal').onclick = () => captura(l.id, etapa, key, true, ia);
  }
  function repintarFoto(locId, etapa, key, ia) {
    const l = ST.linhas.find(x => x.id === locId);
    if (l && ST.det === locId) pintaFoto(l, etapa, key, ia);
  }

  async function captura(locId, etapa, key, galeria, ia) {
    const file = await escolherArquivo(galeria);
    if (!file) return;
    const el = $('ci-foto-' + key);
    if (el) el.innerHTML = '<span class="ci-fs">Processando foto...</span>';
    let c;
    try { c = await comprimir(file); }
    catch (e) { toast('Não foi possível abrir a foto. Tente de novo.'); repintarFoto(locId, etapa, key, ia); return; }
    // a data vem do próprio arquivo: foto antiga da galeria não ganha a data de hoje
    const item = {
      k: chaveFila(locId, etapa, key), locId, etapa, key, ia: ia ? { st: 'lendo' } : null,
      blob: c.blob, w: c.w, h: c.h, ts: new Date(file.lastModified || Date.now()).toISOString(),
      origem: galeria ? 'galeria' : 'camera', geo: null, estado: 'enviando',
      path: locId + '/' + etapa + '/' + key + '-' + Date.now() + '.jpg', usarIA: !!ia
    };
    item.url = URL.createObjectURL(c.blob);
    enviandoAgora.add(item.k); // a reenvio automático não mexe nesta enquanto ela é processada
    try { await processarCaptura(item, c, locId, etapa, key, ia); }
    finally { enviandoAgora.delete(item.k); }
  }
  async function processarCaptura(item, c, locId, etapa, key, ia) {
    await FILA.put(item);
    repintarFoto(locId, etapa, key, ia);
    const geoP = getGeo();
    // a leitura da IA aparece assim que chega, sem esperar a localização
    const iaP = ia ? lerIA(c.dataUrl).then(r => {
      item.ia = r;
      const inp = $('ci-inp-' + key);
      if (inp && r.st === 'ok' && inp.value.trim() === '' && ST.det === locId) {
        inp.value = r.valor;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      } else repintarFoto(locId, etapa, key, ia);
      FILA.put(item);
    }) : Promise.resolve();
    const upP = subir(item);
    const res = await Promise.all([geoP, iaP, upP]);
    item.geo = res[0];
    await FILA.put(item);
    await concluirItem(item);
  }

  async function subir(item) {
    if (item.subiu) return true;
    try {
      const r = await sb.storage.from(BUCKET).upload(item.path, item.blob, { contentType: 'image/jpeg', upsert: false });
      if (r.error && !/exist/i.test(r.error.message)) throw r.error;
      item.subiu = true;
      return true;
    } catch (e) {
      item.estado = 'pendente';
      return false;
    }
  }
  async function concluirItem(item) {
    if (!item.subiu) { item.estado = 'pendente'; await FILA.put(item); repintarFoto(item.locId, item.etapa, item.key, item.usarIA); agendarReenvio(); return; }
    try {
      const meta = { path: item.path, w: item.w, h: item.h, ts: item.ts, origem: item.origem, geo: item.geo, ia: item.ia && item.ia.st !== 'lendo' ? item.ia : null };
      const g = grupoFotos(item.etapa);
      const nova = await gravar(item.locId, atual => {
        const fotos = JSON.parse(JSON.stringify(atual.fotos));
        fotos[g[0]] = fotos[g[0]] || {}; fotos[g[0]][g[1]] = fotos[g[0]][g[1]] || {};
        fotos[g[0]][g[1]][item.key] = meta;
        return { patch: { fotos } };
      });
      ST.urls[item.path] = item.url;
      await FILA.del(item.k);
      atualizarLinha(nova);
      repintarFoto(item.locId, item.etapa, item.key, item.usarIA);
      atualizarBotoes();
    } catch (err) {
      // a locação saiu deste motorista: descarta a foto da fila e só avisa se ele estiver nela
      if (err instanceof Mudou) { await FILA.del(item.k); if (ST.det === item.locId) avisarErro(err); return; }
      item.estado = 'pendente'; await FILA.put(item);
      repintarFoto(item.locId, item.etapa, item.key, item.usarIA); agendarReenvio();
    }
  }
  let reenvioTimer = null;
  function agendarReenvio() { if (!reenvioTimer) reenvioTimer = setTimeout(() => { reenvioTimer = null; enviarPendentes(); }, 15000); }
  const enviandoAgora = new Set();
  async function enviarPendentes() {
    const itens = await FILA.todos();
    for (const item of itens) {
      if (enviandoAgora.has(item.k)) continue;
      enviandoAgora.add(item.k);
      try {
        if (!item.url && item.blob) item.url = URL.createObjectURL(item.blob);
        if (item.usarIA && (!item.ia || item.ia.st === 'lendo')) item.ia = await lerIA(await blobParaDataUrl(item.blob));
        item.estado = 'enviando'; repintarFoto(item.locId, item.etapa, item.key, item.usarIA);
        await subir(item);
        await concluirItem(item);
      } catch (e) {
        item.estado = 'pendente'; agendarReenvio();
      } finally { enviandoAgora.delete(item.k); }
    }
  }
  window.addEventListener('online', () => enviarPendentes());

  function atualizarLinha(nova) {
    if (!nova) return;
    const i = ST.linhas.findIndex(x => x.id === nova.id);
    if (i >= 0) ST.linhas[i] = nova; else ST.linhas.push(nova);
  }
  let atualizarBotoes = () => {};

  /* ================= etapas 1 e 3: disparo inicial / final ================= */
  function campoCartucho(c, val, ini) {
    return '<div class="ci-cart"><div class="ci-cart-row"><div class="ci-cart-nome">' + esc(c.label) +
      (ini != null ? '<small>Inicial: ' + C.fmtNum(ini) + '</small>' : '') + '</div>' +
      '<div class="ci-meter" id="ci-met-' + c.key + '"><input type="text" inputmode="numeric" pattern="[0-9]*" id="ci-inp-' + c.key + '" aria-label="' + esc(c.label) + '" value="' + esc(val == null ? '' : val) + '" placeholder="0" autocomplete="off"><span>disparos</span></div></div>' +
      '<div class="ci-rowerr" id="ci-re-' + c.key + '" hidden></div><div id="ci-foto-' + c.key + '"></div></div>';
  }

  function etDisparo(l) {
    const content = $('transportes-content');
    const etapa = l.status === 'inicial' ? 'inicial' : 'final';
    const ehFinal = etapa === 'final';
    const lista = cartuchos(l);
    const R = (l.rascunho && l.rascunho[etapa]) || {};
    const ini = l.ultra.inicial || {};
    const confirmados = (l.ultra[etapa]) || {};
    const valor = c => (R[c.key] != null ? R[c.key] : (confirmados[c.key] != null ? confirmados[c.key] : ''));
    const linear = C.expand(l, C.linearDe(l)), booster = C.expand(l, C.BOOSTER);
    const feita = entregaFeitaPor(l);
    content.innerHTML = topoEtapa(l) +
      (ehFinal && feita ? '<div class="ci-okbox">Entrega feita por ' + esc(nome(l.motEntregaId)) + '. Os disparos iniciais já estão aqui.</div>' : '') +
      (ehFinal ? '<button type="button" class="btn btn-outline btn-block" id="ci-btn-rel" style="margin-bottom:14px">Abrir relatório de entrega</button>' : '') +
      '<div class="card form-card"><h3>Cartuchos Linear</h3>' + linear.map(c => campoCartucho(c, valor(c), ehFinal ? (ini[c.key] || 0) : null)).join('') + '</div>' +
      '<div class="card form-card"><h3>Cartuchos Booster</h3>' + booster.map(c => campoCartucho(c, valor(c), ehFinal ? (ini[c.key] || 0) : null)).join('') + '</div>' +
      '<div class="ci-err" id="ci-err-et" role="alert"></div>' +
      '<div class="ci-acoes"><button type="button" class="btn btn-primary btn-block" id="ci-btn-ok">' + (ehFinal ? 'Calcular saldo' : 'Confirmar disparo inicial') + '</button>' +
      '<p class="ci-hint" style="text-align:center">Cada foto e número fica salvo na hora. Se a página fechar, é só voltar.</p></div>';
    if (ehFinal) $('ci-btn-rel').onclick = () => abrirRelatorioEntrega(l);

    assinarUrls(lista.map(c => (fotosDe(l, etapa)[c.key] || {}).path)).then(() => lista.forEach(c => pintaFoto(ST.linhas.find(x => x.id === l.id) || l, etapa, c.key, true)));
    lista.forEach(c => pintaFoto(l, etapa, c.key, true));

    const checar = () => {
      let ruim = false;
      if (ehFinal) lista.forEach(c => {
        const i = $('ci-inp-' + c.key), re = $('ci-re-' + c.key);
        const inv = i.value.trim() !== '' && C.parseInt0(i.value) > (ini[c.key] || 0);
        $('ci-met-' + c.key).classList.toggle('bad', inv);
        re.hidden = !inv; re.textContent = inv ? 'O final não pode ser maior que o inicial (' + C.fmtNum(ini[c.key] || 0) + ').' : '';
        ruim = ruim || inv;
      });
      const pend = pendentesDe(l.id, etapa).length;
      const btn = $('ci-btn-ok');
      if (btn) btn.disabled = ruim || pend > 0;
      if (btn) btn.textContent = pend > 0 ? 'Aguardando envio de ' + pend + ' foto(s)...' : (ehFinal ? 'Calcular saldo' : 'Confirmar disparo inicial');
    };
    atualizarBotoes = checar;

    lista.forEach(c => {
      const i = $('ci-inp-' + c.key);
      i.addEventListener('input', () => {
        const limpo = i.value.replace(/[^\d]/g, '');
        if (limpo !== i.value) i.value = limpo;
        const lAtual = ST.linhas.find(x => x.id === l.id) || l;
        pintaFoto(lAtual, etapa, c.key, true);
        checar();
        salvarRascunho(l.id, etapa, c.key, i.value);
      });
    });
    checar();

    $('ci-btn-ok').onclick = async () => {
      const err = $('ci-err-et'), btn = $('ci-btn-ok');
      err.textContent = '';
      const vals = {}; let falta = 0;
      lista.forEach(c => { const v = $('ci-inp-' + c.key).value.trim(); if (v === '') falta++; vals[c.key] = C.parseInt0(v); });
      if (falta) { err.textContent = 'Falta preencher ' + falta + ' cartucho(s).'; return; }
      if (pendentesDe(l.id, etapa).length) { err.textContent = 'Ainda há foto pendente de envio. Aguarde ou confira a internet.'; return; }
      btn.disabled = true; btn.textContent = 'Salvando...';
      try {
        await esperarRascunho();
        const nova = await gravar(l.id, atual => {
          const fotos = fotosDe(atual, etapa);
          const semFoto = lista.filter(c => !fotos[c.key]).length;
          if (semFoto) throw new Error('Falta a foto do visor de ' + semFoto + ' cartucho(s).');
          if (ehFinal) {
            const maior = lista.find(c => vals[c.key] > ((atual.ultra.inicial || {})[c.key] || 0));
            if (maior) throw new Error('O final de ' + maior.label + ' não pode ser maior que o inicial.');
          }
          const ultra = JSON.parse(JSON.stringify(atual.ultra)); ultra[etapa] = vals;
          return ehFinal
            ? { patch: { ultra, status: 'condicoes' }, hist: ['Disparo final registrado'] }
            : { patch: { ultra, status: 'sig_entrega' }, hist: ['Disparo inicial confirmado'] };
        });
        atualizarLinha(nova); render();
      } catch (e) {
        btn.disabled = false; checar();
        if (e instanceof Mudou) return avisarErro(e);
        err.textContent = e.message;
      }
    };
  }

  // números digitados vão para "rascunho", com um pequeno atraso
  const rascPendente = {};
  let rascTimer = null, rascPromessa = Promise.resolve();
  function salvarRascunho(locId, etapa, key, valor) {
    rascPendente[locId] = rascPendente[locId] || {};
    rascPendente[locId][etapa] = rascPendente[locId][etapa] || {};
    rascPendente[locId][etapa][key] = valor;
    clearTimeout(rascTimer);
    rascTimer = setTimeout(descarregarRascunho, 700);
  }
  function descarregarRascunho() {
    rascTimer = null;
    const lote = JSON.parse(JSON.stringify(rascPendente));
    Object.keys(rascPendente).forEach(k => delete rascPendente[k]);
    rascPromessa = Promise.all(Object.keys(lote).map(locId => gravar(locId, atual => {
      const r = JSON.parse(JSON.stringify(atual.rascunho || {}));
      Object.keys(lote[locId]).forEach(et => { r[et] = Object.assign({}, r[et] || {}, lote[locId][et]); });
      return { patch: { rascunho: r } };
    }).then(atualizarLinha).catch(err => { if (err instanceof Mudou) avisarErro(err); })));
    return rascPromessa;
  }
  async function esperarRascunho() {
    if (rascTimer) { clearTimeout(rascTimer); await descarregarRascunho(); }
    await rascPromessa;
  }
  // celular trocou de app ou a página vai fechar: salva o que foi digitado agora
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && rascTimer) { clearTimeout(rascTimer); descarregarRascunho(); } });
  window.addEventListener('pagehide', () => { if (rascTimer) { clearTimeout(rascTimer); descarregarRascunho(); } });

  /* ================= Criodermis: etapas 1 e 3 ================= */
  // campo de quantidade no mesmo visor do Ultraformer; o id do campo é a chave da foto
  function campoQtd(key, rotulo, val, extra) {
    return '<div class="ci-cart"><div class="ci-cart-row"><div class="ci-cart-nome">' + esc(rotulo) + (extra ? '<small>' + esc(extra) + '</small>' : '') + '</div>' +
      '<div class="ci-meter" id="ci-met-' + key + '"><input type="text" inputmode="numeric" pattern="[0-9]*" id="ci-inp-' + key + '" aria-label="' + esc(rotulo) + '" value="' + esc(val == null ? '' : val) + '" placeholder="0" autocomplete="off"><span>un.</span></div></div>' +
      '<div class="ci-rowerr" id="ci-re-' + key + '" hidden></div><div id="ci-foto-' + key + '"></div></div>';
  }
  const linhaAtual = l => ST.linhas.find(x => x.id === l.id) || l;
  function ligarQtd(l, etapaRasc, keys, depois) {
    keys.forEach(k => {
      const i = $('ci-inp-' + k);
      i.addEventListener('input', () => {
        const limpo = i.value.replace(/[^\d]/g, '');
        if (limpo !== i.value) i.value = limpo;
        salvarRascunho(l.id, etapaRasc, k, i.value);
        depois(k);
      });
    });
  }

  function etEntregaCrio(l) {
    const content = $('transportes-content');
    const R = (l.rascunho && l.rascunho.inicial) || {}, conf = l.crio.entregues || {};
    const val = (k, c) => (R[k] != null ? R[k] : (conf[c] != null ? conf[c] : ''));
    const itens = (l.semManta ? [] : [['mantasE', 'Mantas entregues', 'mantas']]).concat([['cintasE', 'Cintas entregues', 'cintas']]);
    content.innerHTML = topoEtapa(l) +
      '<div class="card form-card"><h3>Itens entregues</h3><p class="cardsub">Quantidade e foto de cada item.</p>' +
        itens.map(i => campoQtd(i[0], i[1], val(i[0], i[2]))).join('') + '</div>' +
      '<div class="ci-err" id="ci-err-et" role="alert"></div>' +
      '<div class="ci-acoes"><button type="button" class="btn btn-primary btn-block" id="ci-btn-ok">Confirmar entrega</button>' +
      '<p class="ci-hint" style="text-align:center">A cinta não tem custo, mas precisa voltar. Se faltar, são ' + C.fmtMoney(C.VALOR_CINTA) + ' por unidade.</p></div>';
    const keys = itens.map(i => i[0]);
    keys.forEach(k => pintaFoto(l, 'entrega', k, false));
    assinarUrls(keys.map(k => (fotosDe(l, 'entrega')[k] || {}).path)).then(() => keys.forEach(k => pintaFoto(linhaAtual(l), 'entrega', k, false)));
    const checar = () => {
      const pend = pendentesDe(l.id, 'entrega').length, btn = $('ci-btn-ok');
      if (!btn) return;
      btn.disabled = pend > 0;
      btn.textContent = pend > 0 ? 'Aguardando envio de ' + pend + ' foto(s)...' : 'Confirmar entrega';
    };
    atualizarBotoes = checar;
    ligarQtd(l, 'inicial', keys, checar);
    checar();
    $('ci-btn-ok').onclick = async () => {
      const err = $('ci-err-et'), btn = $('ci-btn-ok');
      err.textContent = '';
      const m = l.semManta ? 0 : C.parseInt0($('ci-inp-mantasE').value), c = C.parseInt0($('ci-inp-cintasE').value);
      if (!l.semManta && m <= 0) { err.textContent = 'Informe quantas mantas foram entregues.'; return; }
      if (c <= 0) { err.textContent = 'Informe quantas cintas foram entregues.'; return; }
      if (pendentesDe(l.id, 'entrega').length) { err.textContent = 'Ainda há foto pendente de envio. Aguarde ou confira a internet.'; return; }
      btn.disabled = true; btn.textContent = 'Salvando...';
      try {
        await esperarRascunho();
        const nova = await gravar(l.id, atual => {
          const f = fotosDe(atual, 'entrega');
          if (!f.cintasE || (!atual.semManta && !f.mantasE)) throw new Error('Anexe as fotos antes de continuar.');
          const crio = Object.assign({}, atual.crio, { entregues: { mantas: m, cintas: c } });
          return { patch: { crio, status: 'sig_entrega' }, hist: ['Entrega confirmada'] };
        });
        atualizarLinha(nova); render();
      } catch (e) {
        btn.disabled = false; checar();
        if (e instanceof Mudou) return avisarErro(e);
        err.textContent = e.message;
      }
    };
  }

  function etRetornoCrio(l) {
    const content = $('transportes-content');
    const ent = l.crio.entregues || { mantas: 0, cintas: 0 };
    const R = (l.rascunho && l.rascunho.final) || {}, conf = l.crio.retornando || {};
    const val = (k, c) => (R[k] != null ? R[k] : (conf[c] != null ? conf[c] : ''));
    const itens = (l.semManta ? [] : [['mantasR', 'Mantas retornando', 'mantas', 'Entregues: ' + C.fmtNum(ent.mantas)]])
      .concat([['cintasR', 'Cintas retornando', 'cintas', 'Entregues: ' + C.fmtNum(ent.cintas)]]);
    const feita = entregaFeitaPor(l);
    content.innerHTML = topoEtapa(l) +
      (feita ? '<div class="ci-okbox">Entrega feita por ' + esc(nome(l.motEntregaId)) + '.</div>' : '') +
      '<button type="button" class="btn btn-outline btn-block" id="ci-btn-rel" style="margin-bottom:14px">Abrir relatório de entrega</button>' +
      '<div class="card form-card"><h3>Itens retornando</h3><p class="cardsub">Quantidade e foto de cada item.</p>' +
        itens.map(i => campoQtd(i[0], i[1], val(i[0], i[2]), i[3])).join('') + '<div id="ci-cinta"></div></div>' +
      '<div class="ci-err" id="ci-err-et" role="alert"></div>' +
      '<div class="ci-acoes"><button type="button" class="btn btn-primary btn-block" id="ci-btn-ok">Calcular saldo</button></div>';
    $('ci-btn-rel').onclick = () => abrirRelatorioEntrega(l);
    const keys = itens.map(i => i[0]);
    keys.forEach(k => pintaFoto(l, 'retorno', k, false));
    assinarUrls(keys.map(k => (fotosDe(l, 'retorno')[k] || {}).path)).then(() => keys.forEach(k => pintaFoto(linhaAtual(l), 'retorno', k, false)));

    const inC = $('ci-inp-cintasR'), inM = $('ci-inp-mantasR'), pa = $('ci-cinta');
    let assinandoCinta = false, cancelando = false;

    const chk = () => {
      if (assinandoCinta) return;
      const err = $('ci-err-et'), btn = $('ci-btn-ok');
      if (!btn) return;
      err.textContent = '';
      const atual = linhaAtual(l), cob = atual.crio.cobrancaCinta;
      const cr = C.parseInt0(inC.value), falt = Math.max(0, ent.cintas - cr);
      // a quantidade mudou depois da cobrança assinada: a cobrança deixa de valer
      if (cob && inC.value !== '' && cob.qtd !== falt && !cancelando) {
        cancelando = true;
        gravar(l.id, a => {
          if (!a.crio.cobrancaCinta) return null;
          return { patch: { crio: Object.assign({}, a.crio, { cobrancaCinta: null }) }, hist: ['Cobrança de cinta cancelada: quantidade corrigida'] };
        }).then(nova => { atualizarLinha(nova); toast('Cobrança de cinta cancelada: a quantidade mudou.'); })
          .catch(e => { if (e instanceof Mudou) avisarErro(e); })
          .finally(() => { cancelando = false; chk(); });
        return;
      }
      let cintaOk = true;
      if (inC.value === '') { cintaOk = false; pa.innerHTML = ''; }
      else if (cr > ent.cintas) { pa.innerHTML = '<div class="ci-err" style="margin-top:10px">Voltaram mais cintas do que foram entregues. Confira.</div>'; cintaOk = false; }
      else if (falt === 0) pa.innerHTML = '<div class="ci-okbox" style="margin-top:10px">Todas as cintas conferem.</div>';
      else if (cob && cob.qtd === falt) pa.innerHTML = '<div class="ci-okbox" style="margin-top:10px">Cobrança de ' + falt + ' cinta(s) assinada: ' + C.fmtMoney(falt * C.VALOR_CINTA) + '.</div>';
      else {
        cintaOk = false;
        pa.innerHTML = '<div class="ci-err" style="margin-top:10px">Faltam ' + falt + ' cinta(s). Confira com a doutora.</div>' +
          '<div class="ci-foto-bts"><button type="button" class="btn btn-sm btn-ghost" id="ci-c-ajustar">Ajustar quantidade</button>' +
          '<button type="button" class="btn btn-sm btn-outline" id="ci-c-cobrar">Cobrar cinta ausente</button></div>';
        $('ci-c-ajustar').onclick = () => inC.focus();
        $('ci-c-cobrar').onclick = () => assinaCinta(falt);
      }
      let mOk = true;
      if (!l.semManta) {
        const mr = C.parseInt0(inM.value);
        const ruim = inM.value !== '' && mr > ent.mantas;
        $('ci-met-mantasR').classList.toggle('bad', ruim);
        $('ci-re-mantasR').hidden = !ruim; $('ci-re-mantasR').textContent = ruim ? 'Voltaram mais mantas do que foram entregues (' + C.fmtNum(ent.mantas) + ').' : '';
        if (inM.value === '' || ruim) mOk = false;
      }
      $('ci-met-cintasR').classList.toggle('bad', cr > ent.cintas);
      const pend = pendentesDe(l.id, 'retorno').length;
      btn.disabled = !cintaOk || !mOk || pend > 0;
      btn.textContent = pend > 0 ? 'Aguardando envio de ' + pend + ' foto(s)...' : 'Calcular saldo';
    };

    const assinaCinta = q => {
      assinandoCinta = true;
      $('ci-btn-ok').disabled = true;
      pa.innerHTML = '<div class="ci-cinta-box"><h3>Cobrança de cinta ausente</h3>' +
        '<p class="ci-aceite">' + q + ' cinta(s) × ' + C.fmtMoney(C.VALOR_CINTA) + ' = <b>' + C.fmtMoney(q * C.VALOR_CINTA) + '</b>, somado ao total.</p>' +
        '<p class="cardsub" style="margin:0 0 8px">' + esc(l.doutora) + ' · Cinta ausente</p>' +
        '<canvas class="ci-sig" id="ci-sig-cinta"></canvas>' +
        '<div class="ci-foto-bts" style="margin-top:8px"><button type="button" class="btn btn-sm btn-ghost" id="ci-sig-cinta-limpar">Limpar assinatura</button>' +
        '<button type="button" class="btn btn-sm btn-ghost" id="ci-sig-cinta-voltar">Voltar</button></div>' +
        '<div class="ci-err" id="ci-err-cinta" style="margin-top:10px"></div>' +
        '<button type="button" class="btn btn-primary btn-block" id="ci-sig-cinta-ok">Confirmar cobrança</button></div>';
      const pad = initSignaturePad('ci-sig-cinta');
      $('ci-sig-cinta-limpar').onclick = () => pad.clear();
      $('ci-sig-cinta-voltar').onclick = () => { assinandoCinta = false; chk(); };
      $('ci-sig-cinta-ok').onclick = async () => {
        const e2 = $('ci-err-cinta'), b2 = $('ci-sig-cinta-ok');
        if (pad.isEmpty()) { e2.textContent = 'Peça para a doutora assinar.'; return; }
        b2.disabled = true; b2.textContent = 'Enviando assinatura...';
        try {
          const meta = await subirAssinatura(l.id, 'cinta', pad);
          const nova = await gravar(l.id, a => ({
            patch: { crio: Object.assign({}, a.crio, { cobrancaCinta: { qtd: q, valorUnit: C.VALOR_CINTA, total: q * C.VALOR_CINTA, assinatura: meta } }) },
            hist: ['Cinta ausente cobrada: ' + q]
          }));
          atualizarLinha(nova);
          assinandoCinta = false; chk();
        } catch (e) {
          b2.disabled = false; b2.textContent = 'Confirmar cobrança';
          if (e instanceof Mudou) return avisarErro(e);
          e2.textContent = e.message;
        }
      };
    };

    atualizarBotoes = chk;
    ligarQtd(l, 'final', keys, k => { if (k === 'cintasR') assinandoCinta = false; chk(); });
    chk();

    $('ci-btn-ok').onclick = async () => {
      const err = $('ci-err-et'), btn = $('ci-btn-ok');
      const m = l.semManta ? 0 : C.parseInt0(inM.value), c = C.parseInt0(inC.value);
      if (pendentesDe(l.id, 'retorno').length) { err.textContent = 'Ainda há foto pendente de envio. Aguarde ou confira a internet.'; return; }
      btn.disabled = true; btn.textContent = 'Salvando...';
      try {
        await esperarRascunho();
        const nova = await gravar(l.id, atual => {
          const f = fotosDe(atual, 'retorno');
          if (!f.cintasR || (!atual.semManta && !f.mantasR)) throw new Error('Anexe as fotos antes de continuar.');
          const e = atual.crio.entregues || {};
          if (c > e.cintas || (!atual.semManta && m > e.mantas)) throw new Error('Voltaram mais itens do que foram entregues. Confira.');
          const falt = Math.max(0, e.cintas - c), cob = atual.crio.cobrancaCinta;
          if (falt > 0 && !(cob && cob.qtd === falt)) throw new Error('Faltam ' + falt + ' cinta(s): ajuste a quantidade ou colha a assinatura da cobrança.');
          const crio = Object.assign({}, atual.crio, { retornando: { mantas: m, cintas: c } });
          if (falt === 0) crio.cobrancaCinta = null;
          return { patch: { crio, status: 'condicoes' }, hist: ['Retorno registrado'] };
        });
        atualizarLinha(nova); render();
      } catch (e) {
        btn.disabled = false; chk();
        if (e instanceof Mudou) return avisarErro(e);
        err.textContent = e.message;
      }
    };
  }

  /* ================= assinatura: envio do PNG ================= */
  async function subirAssinatura(locId, tipo, pad) {
    const dataUrl = pad.toDataURL();
    const blob = await (await fetch(dataUrl)).blob();
    const path = locId + '/assinaturas/' + tipo + '.png';
    const geo = await getGeo();
    const r = await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/png', upsert: true });
    if (r.error) throw new Error('Não foi possível enviar a assinatura. Confira a internet e tente de novo.');
    ST.urls[path] = dataUrl;
    return { path, ts: new Date().toISOString(), geo };
  }

  /* ================= etapa 2: assinatura da entrega ================= */
  function resumoEntrega(l) {
    if (l.equipamento === 'crio') {
      const e = l.crio.entregues || {};
      return (l.semManta ? '' : '<div class="ci-kv"><span>Mantas entregues</span><span>' + C.fmtNum(e.mantas) + '</span></div>') +
        '<div class="ci-kv"><span>Cintas entregues</span><span>' + C.fmtNum(e.cintas) + '</span></div>';
    }
    return cartuchos(l).map(c => '<div class="ci-kv"><span>' + esc(c.label) + '</span><span>' + C.fmtNum((l.ultra.inicial || {})[c.key]) + '</span></div>').join('');
  }
  function etSigEntrega(l) {
    const content = $('transportes-content');
    content.innerHTML = topoEtapa(l) +
      '<div class="card form-card"><h3>O que a doutora está confirmando</h3><p class="cardsub">' +
        (l.equipamento === 'crio' ? 'Itens entregues.' : 'Disparos iniciais de cada cartucho.') + '</p>' + resumoEntrega(l) + '</div>' +
      '<div class="card form-card"><h3>' + esc(l.doutora) + ' · Entrega</h3>' + (l.cpfCnpj ? '<p class="cardsub">CPF/CNPJ: ' + esc(l.cpfCnpj) + '</p>' : '') +
        '<p class="ci-aceite">Confirmo que recebi o equipamento com os valores acima.</p>' +
        '<canvas class="ci-sig" id="ci-sig-ent"></canvas><button type="button" class="btn btn-sm btn-ghost" id="ci-sig-ent-limpar" style="margin-top:8px">Limpar assinatura</button></div>' +
      '<div class="ci-err" id="ci-err-et" role="alert"></div>' +
      '<div class="ci-acoes"><button type="button" class="btn btn-primary btn-block" id="ci-btn-ok">Assinar e concluir entrega</button>' +
      '<button type="button" class="btn btn-ghost btn-block" id="ci-btn-voltar">Voltar e corrigir</button></div>';
    const pad = initSignaturePad('ci-sig-ent');
    $('ci-sig-ent-limpar').onclick = () => pad.clear();
    $('ci-btn-voltar').onclick = () => mudarEtapa(l, 'inicial');
    $('ci-btn-ok').onclick = async () => {
      const err = $('ci-err-et'), btn = $('ci-btn-ok');
      if (pad.isEmpty()) { err.textContent = 'Peça para a doutora assinar antes de continuar.'; return; }
      btn.disabled = true; btn.textContent = 'Enviando assinatura...';
      try {
        const meta = await subirAssinatura(l.id, 'entrega', pad);
        const nova = await gravar(l.id, atual => {
          if (atual.status !== 'sig_entrega') throw new Mudou('A locação mudou de etapa.');
          const ass = Object.assign({}, atual.assinaturas, { entrega: meta });
          return { patch: { assinaturas: ass, status: 'final' }, hist: ['Entrega assinada pela doutora'] };
        });
        atualizarLinha(nova);
        telaEntregaConcluida(nova);
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Assinar e concluir entrega';
        if (e instanceof Mudou) return avisarErro(e);
        err.textContent = e.message;
      }
    };
  }
  function telaEntregaConcluida(l) {
    lembrarDet(null);
    const content = $('transportes-content');
    window.scrollTo(0, 0);
    content.innerHTML = '<div class="card form-card" style="text-align:center"><h3>Entrega concluída</h3>' +
      '<p class="cardsub" style="margin:6px 0 0">Nº ' + esc(l.numero) + ' · ' + esc(l.doutora) + '</p>' +
      '<p style="font-size:14px;margin:12px 0 0">' + (souEu(l.motRetiradaId) ? 'A retirada ficou pendente com você.' : 'A retirada ficou com ' + esc(nome(l.motRetiradaId)) + '.') + '</p></div>' +
      '<div class="ci-acoes"><button type="button" class="btn btn-primary btn-block" id="ci-btn-rel">Abrir relatório de entrega</button>' +
      '<button type="button" class="btn btn-ghost btn-block" id="ci-btn-lista">Voltar para Minhas Locações</button></div>';
    $('ci-btn-rel').onclick = () => abrirRelatorioEntrega(l);
    $('ci-btn-lista').onclick = () => recarregar();
    abrirRelatorioEntrega(l);
  }

  async function mudarEtapa(l, status) {
    try {
      const nova = await gravar(l.id, () => ({ patch: { status } }));
      atualizarLinha(nova); render();
    } catch (e) { avisarErro(e); }
  }

  /* ================= etapa 4: saldo e total ================= */
  function linhasTotal(l, c) {
    if (l.equipamento === 'crio') {
      const ent = l.crio.entregues || {}, ret = l.crio.retornando || {}, cob = l.crio.cobrancaCinta;
      return (l.semManta ? '<div class="ci-kv"><span>Mantas</span><span>Não enviadas</span></div>'
          : '<div class="ci-kv"><span>Mantas entregues / retornando</span><span>' + C.fmtNum(ent.mantas) + ' / ' + C.fmtNum(ret.mantas) + '</span></div>' +
            '<div class="ci-kv forte" style="border-top:none;margin-top:0;padding-top:3px"><span>Mantas utilizadas</span><span>' + C.fmtNum(c.utilizadas) + '</span></div>' +
            '<div class="ci-kv"><span>' + C.fmtNum(c.utilizadas) + ' × ' + C.fmtMoney(l.valorManta) + '</span><span>' + C.fmtMoney(c.totalManta) + '</span></div>') +
        '<div class="ci-kv"><span>Cintas entregues / retornando</span><span>' + C.fmtNum(ent.cintas) + ' / ' + C.fmtNum(ret.cintas) + '</span></div>' +
        (c.cinta ? '<div class="ci-kv"><span>Cinta ausente (' + C.fmtNum(cob.qtd) + ' × ' + C.fmtMoney(C.VALOR_CINTA) + ')</span><span>' + C.fmtMoney(c.cinta) + '</span></div>' : '') +
        '<div class="ci-kv"><span>Locação Criodermis</span><span>' + C.fmtMoney(c.locAplicada) + '</span></div>' +
        (l.frete ? '<div class="ci-kv"><span>Frete</span><span>' + C.fmtMoney(c.frete) + '</span></div>' : '');
    }
    return '<div class="ci-kv forte" style="border-top:none;margin-top:0;padding-top:3px"><span>Total de disparos utilizados</span><span>' + C.fmtNum(c.totalGeral) + '</span></div>' +
      '<div class="ci-kv"><span>Faixa aplicada</span><span>' + (c.faixa ? esc(C.faixaTxt(c.faixa)) : '—') + '</span></div>' +
      '<div class="ci-kv"><span>' + C.fmtNum(c.totalGeral) + ' × ' + C.fmtMoney(c.unit) + '</span><span>' + C.fmtMoney(c.subtotal) + '</span></div>' +
      '<div class="ci-kv"><span>Locação Ultraformer' + (c.gratis ? ' (gratuita: ' + esc(c.motivo) + ')' : '') + '</span><span>' + C.fmtMoney(c.locAplicada) + '</span></div>' +
      (c.lavieen ? '<div class="ci-kv"><span>Locação combo Lavieen</span><span>' + C.fmtMoney(c.lavieen) + '</span></div>' : '') +
      (l.frete ? '<div class="ci-kv"><span>Frete</span><span>' + C.fmtMoney(c.frete) + '</span></div>' : '');
  }
  function totalBox(c) { return '<div class="ci-total"><small>Total a pagar</small><b>' + C.fmtMoney(c.total) + '</b></div>'; }
  function etCondicoes(l) {
    const content = $('transportes-content');
    const crio = l.equipamento === 'crio';
    const c = C.calcular(l), dv = C.divergencias(l);
    content.innerHTML = topoEtapa(l) +
      (crio ? '' : '<div class="card form-card"><h3>Saldo por cartucho</h3><p class="cardsub">Inicial menos final, de cada cartucho.</p>' +
        '<div class="ci-grupo">Linear</div>' + c.linear.map(x => '<div class="ci-kv"><span>' + esc(x.label) + '</span><span>' + C.fmtNum(x.saldo) + '</span></div>').join('') +
        '<div class="ci-grupo">Booster</div>' + c.booster.map(x => '<div class="ci-kv"><span>' + esc(x.label) + '</span><span>' + C.fmtNum(x.saldo) + '</span></div>').join('') + '</div>') +
      '<div class="card form-card"><h3>Fechamento</h3>' + linhasTotal(l, c) + '</div>' + totalBox(c) +
      '<p class="ci-hint" style="text-align:center;margin-bottom:12px">Calculado pelo sistema com as condições lançadas pela Yasmin.</p>' +
      (dv.length ? '<div class="ci-waitbox">' + dv.length + ' número(s) diferente(s) da leitura da foto:<br>' +
        dv.map(d => esc(d.label) + ' (' + (d.et === 'inicial' ? 'inicial' : 'final') + '): registrado ' + C.fmtNum(d.reg) + ', IA leu ' + C.fmtNum(d.ia)).join('<br>') + '</div>' : '') +
      '<div class="ci-acoes"><button type="button" class="btn btn-primary btn-block" id="ci-btn-ok">Confirmar fechamento</button>' +
      '<button type="button" class="btn btn-ghost btn-block" id="ci-btn-voltar">Voltar e corrigir ' + (crio ? 'o retorno' : 'o disparo final') + '</button></div>';
    $('ci-btn-voltar').onclick = () => mudarEtapa(l, 'final');
    $('ci-btn-ok').onclick = () => mudarEtapa(l, 'sig_fechamento');
  }

  /* ================= etapa 5: assinaturas do fechamento ================= */
  function etSigFech(l) {
    const content = $('transportes-content');
    const c = C.calcular(l);
    content.innerHTML = topoEtapa(l) +
      '<div class="card form-card"><h3>O que a doutora está confirmando</h3>' + linhasTotal(l, c) + '</div>' + totalBox(c) +
      '<div class="card form-card"><h3>' + esc(l.doutora) + ' · Retirada</h3>' + (l.cpfCnpj ? '<p class="cardsub">CPF/CNPJ: ' + esc(l.cpfCnpj) + '</p>' : '') +
        '<p class="ci-aceite">Confirmo a retirada do equipamento, os números e o total acima.</p>' +
        '<canvas class="ci-sig" id="ci-sig-dra"></canvas><button type="button" class="btn btn-sm btn-ghost" id="ci-sig-dra-limpar" style="margin-top:8px">Limpar assinatura</button></div>' +
      '<div class="card form-card"><h3>' + esc(eu().nome || 'Motorista') + ' · Motorista da retirada</h3>' +
        '<canvas class="ci-sig" id="ci-sig-mot"></canvas><button type="button" class="btn btn-sm btn-ghost" id="ci-sig-mot-limpar" style="margin-top:8px">Limpar assinatura</button></div>' +
      '<div class="ci-err" id="ci-err-et" role="alert"></div>' +
      '<div class="ci-acoes"><button type="button" class="btn btn-primary btn-block" id="ci-btn-ok">Assinar e revisar fotos</button>' +
      '<button type="button" class="btn btn-ghost btn-block" id="ci-btn-voltar">Voltar e revisar valores</button></div>';
    const p2 = initSignaturePad('ci-sig-dra'), p3 = initSignaturePad('ci-sig-mot');
    $('ci-sig-dra-limpar').onclick = () => p2.clear();
    $('ci-sig-mot-limpar').onclick = () => p3.clear();
    $('ci-btn-voltar').onclick = () => mudarEtapa(l, 'condicoes');
    $('ci-btn-ok').onclick = async () => {
      const err = $('ci-err-et'), btn = $('ci-btn-ok');
      if (p2.isEmpty() || p3.isEmpty()) { err.textContent = 'Faltam assinaturas: doutora e motorista precisam assinar.'; return; }
      btn.disabled = true; btn.textContent = 'Enviando assinaturas...';
      try {
        const m2 = await subirAssinatura(l.id, 'retirada', p2);
        const m3 = await subirAssinatura(l.id, 'logistica', p3);
        const nova = await gravar(l.id, atual => {
          if (atual.status !== 'sig_fechamento') throw new Mudou('A locação mudou de etapa.');
          const ass = Object.assign({}, atual.assinaturas, { retirada: m2, logistica: m3 });
          return { patch: { assinaturas: ass, status: 'revisao' }, hist: ['Retirada assinada pela doutora e pelo motorista'] };
        });
        atualizarLinha(nova); render();
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Assinar e revisar fotos';
        if (e instanceof Mudou) return avisarErro(e);
        err.textContent = e.message;
      }
    };
  }

  /* ================= etapa 6: revisão de fotos ================= */
  function etRevisao(l) {
    const content = $('transportes-content');
    const crio = l.equipamento === 'crio';
    // pares [legenda, foto] na ordem da grade
    let pares;
    if (crio) {
      const fe = fotosDe(l, 'entrega'), fr = fotosDe(l, 'retorno');
      pares = (l.semManta ? [] : [['Mantas, entrega', fe.mantasE], ['Mantas, retorno', fr.mantasR]])
        .concat([['Cintas, entrega', fe.cintasE], ['Cintas, retorno', fr.cintasR]]);
      const cob = l.crio.cobrancaCinta;
      if (cob && cob.assinatura) pares.push(['Assinatura da cinta ausente', cob.assinatura]);
    } else {
      const fi = fotosDe(l, 'inicial'), ff = fotosDe(l, 'final');
      pares = [];
      cartuchos(l).forEach(c => { pares.push([c.label + ', inicial', fi[c.key]]); pares.push([c.label + ', final', ff[c.key]]); });
    }
    const cel = (cap, p) => p
      ? '<div><img src="' + esc(ST.urls[p.path] || '') + '" alt="' + esc(cap) + '" data-path="' + esc(p.path) + '"><div class="ci-cap">' + esc(cap) + ' · ' + esc(dtBR(p.ts)) + '</div></div>'
      : '<div><div class="ci-miss">Sem foto</div><div class="ci-cap">' + esc(cap) + '</div></div>';
    content.innerHTML = topoEtapa(l) +
      '<div class="ci-fotogrid">' + pares.map(p => cel(p[0], p[1])).join('') + '</div>' +
      '<div class="ci-err" id="ci-err-et" role="alert"></div>' +
      '<div class="ci-acoes"><button type="button" class="btn btn-primary btn-block" id="ci-btn-ok">Concluir locação</button>' +
      '<button type="button" class="btn btn-ghost btn-block" id="ci-btn-voltar">Voltar</button>' +
      '<p class="ci-hint" style="text-align:center">A locação vai para Locações fechadas, com o PDF disponível por ' + C.DIAS_RETENCAO + ' dias.</p></div>';
    const paths = pares.map(p => (p[1] || {}).path).filter(Boolean);
    assinarUrls(paths).then(() => content.querySelectorAll('img[data-path]').forEach(img => { const u = ST.urls[img.dataset.path]; if (u) img.src = u; }));
    $('ci-btn-voltar').onclick = () => mudarEtapa(l, 'sig_fechamento');
    $('ci-btn-ok').onclick = async () => {
      const err = $('ci-err-et'), btn = $('ci-btn-ok');
      btn.disabled = true; btn.textContent = 'Concluindo...';
      try {
        const s = await sb.auth.getSession();
        const token = s.data.session && s.data.session.access_token;
        const resp = await fetch('/api/controle-insumos?acao=concluir', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ id: l.id })
        });
        const d = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(d.error || 'Não foi possível concluir.');
        await carregarLinhas();
        const nova = ST.linhas.find(x => x.id === l.id) || Object.assign({}, l, { financeiro: d.financeiro, status: 'concluido' });
        telaConcluida(nova);
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Concluir locação';
        err.textContent = e.message;
      }
    };
  }
  function telaConcluida(l) {
    lembrarDet(null);
    const content = $('transportes-content');
    window.scrollTo(0, 0);
    const f = l.financeiro || {};
    content.innerHTML = '<div class="card form-card" style="text-align:center"><h3>Locação concluída</h3>' +
      '<p class="cardsub" style="margin:6px 0 0">Nº ' + esc(l.numero) + ' · ' + esc(l.doutora) + '</p>' +
      '<p style="font-size:20px;font-weight:700;margin:12px 0 0">' + C.fmtMoney(f.total) + '</p></div>' +
      '<div class="ci-acoes"><button type="button" class="btn btn-primary btn-block" id="ci-btn-pdf">Abrir PDF</button>' +
      '<button type="button" class="btn btn-ghost btn-block" id="ci-btn-lista">Ver Locações fechadas</button></div>';
    $('ci-btn-pdf').onclick = () => abrirPdfFinal(l);
    $('ci-btn-lista').onclick = () => { ST.sub = 'fechadas'; render(); };
    abrirPdfFinal(l);
  }

  /* ---------------- escopo global ---------------- */
  window.ciCarregarTransportes = ciCarregarTransportes;
  window.ciAvisoEntrada = ciAvisoEntrada;
})();
