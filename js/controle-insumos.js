/* =====================================================================
   Controle de Insumos — intranet RJX
   Comercial → Controle de Insumos (Yasmin): Nova locação, Condições de
   valor, Em andamento e Finalizadas.
   Usa da intranet: sb, currentUsuario, escapeHtml, toast, getMotoristas.
   Cálculo e catálogo: js/controle-insumos-calc.js (window.CICalc).
   Tudo fica dentro deste bloco; só os nomes ci* vão para o escopo global.
   ===================================================================== */
(function () {
  'use strict';

  const C = window.CICalc;
  const $ = id => document.getElementById(id);
  const esc = s => escapeHtml(s == null ? '' : String(s));
  const TABELA = 'controle_locacoes';
  const CHAVE_RASCUNHO = 'rjx_ci_rascunho';

  const ST = { aba: 'nova', editId: null, draft: null, linhas: [], motoristas: [] };

  /* ---------------- utilidades ---------------- */
  const dataBR = iso => { if (!iso) return ''; const p = String(iso).slice(0, 10).split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : iso; };
  const dtBR = iso => { if (!iso) return '—'; const d = new Date(iso); return d.toLocaleDateString('pt-BR') + ' · ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); };
  const quando = l => dataBR(l.data) + (l.horario ? ' às ' + l.horario : '');
  const valorTxt = n => n ? C.fmtMoney(n).replace('R$', '').trim() : '';
  const nomeMot = id => { const m = ST.motoristas.find(x => x.id === id); return m ? m.nome : 'motorista inativo'; };
  // currentUsuario é "let" no script principal: existe no escopo global, mas não em window.
  const quem = () => (typeof currentUsuario !== 'undefined' && currentUsuario && currentUsuario.nome) || 'Comercial';
  const entradaHist = txt => ({ ts: new Date().toISOString(), quem: quem(), txt: txt });
  const faseEntrega = l => l.status === 'inicial' || l.status === 'sig_entrega';
  const etapaNome = l => {
    if (l.equipamento === 'crio' && C.ETAPAS_CRIO[l.status]) return C.ETAPAS_CRIO[l.status];
    return (C.ETAPAS[l.status] || [0, 'Finalizada'])[1];
  };

  function lerRascunhoSalvo() {
    try { const s = localStorage.getItem(CHAVE_RASCUNHO); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }
  function gravarRascunho() {
    if (ST.editId) return; // edição não usa o rascunho de "Nova locação"
    try { localStorage.setItem(CHAVE_RASCUNHO, JSON.stringify(ST.draft)); } catch (e) {}
  }
  function limparRascunho() { try { localStorage.removeItem(CHAVE_RASCUNHO); } catch (e) {} }

  const novoRasc = () => ({
    doutora: '', cpfCnpj: '', numero: '', data: new Date().toISOString().slice(0, 10), horario: '',
    equipamento: 'mpt1', extras: [], contrato: null, motEntregaId: '', motRetiradaId: '', condicoes: '',
    valorLocacao: '', valorLavieen: '', valorManta: '', semManta: false, duplicados: [], frete: false,
    valorFrete: '', faixas: [], gratuidade: 'nao', gratisAPartir: null
  });

  function fecharModal() { const o = $('ci-modal-overlay'); if (o) o.remove(); }
  function abrirModal(titulo, corpo, rodape) {
    fecharModal();
    const o = document.createElement('div');
    o.id = 'ci-modal-overlay';
    o.className = 'rjx-modal-overlay';
    o.innerHTML = '<div class="rjx-modal" role="dialog" aria-modal="true"><div class="rjx-modal-head"><h3>' + esc(titulo) +
      '</h3><button type="button" class="rjx-modal-close" id="ci-modal-x" aria-label="Fechar">✕</button></div>' +
      '<div class="rjx-modal-body">' + corpo + '</div>' +
      '<div class="rjx-modal-foot"><div></div><div class="right-group">' + rodape + '</div></div></div>';
    document.body.appendChild(o);
    $('ci-modal-x').onclick = fecharModal;
    return o;
  }
  function confirma(titulo, texto, sim, fn) {
    abrirModal(titulo, '<p style="margin:0;font-size:14px;line-height:1.5;">' + esc(texto) + '</p>',
      '<button type="button" class="btn btn-ghost" id="ci-cf-nao">Voltar</button><button type="button" class="btn btn-primary" id="ci-cf-sim">' + esc(sim) + '</button>');
    $('ci-cf-nao').onclick = fecharModal;
    $('ci-cf-sim').onclick = async function () { this.disabled = true; await fn(); fecharModal(); };
  }

  /* ---------------- dados ---------------- */
  async function carregarLinhas() {
    const r = await sb.from(TABELA).select('*').order('data_locacao', { ascending: true }).order('horario_montagem', { ascending: true });
    if (r.error) throw new Error(r.error.message);
    ST.linhas = (r.data || []).map(C.locDeLinha);
  }
  const abertas = () => ST.linhas.filter(l => l.status !== 'concluido');
  const finalizadas = () => ST.linhas.filter(l => l.status === 'concluido')
    .sort((a, b) => String(b.finalizadaEm || '').localeCompare(String(a.finalizadaEm || '')));

  /* Atualiza uma locação relendo antes do banco, para não apagar o que o
     motorista gravou no meio tempo. "montar" recebe a locação atual e
     devolve { patch, hist: [textos] }. Tenta duas vezes se o histórico
     mudou entre a leitura e a gravação. */
  async function atualizar(id, montar) {
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      const r = await sb.from(TABELA).select('*').eq('id', id).maybeSingle();
      if (r.error) throw new Error(r.error.message);
      if (!r.data) throw new Error('Esta locação não existe mais. Atualize a tela.');
      const atual = C.locDeLinha(r.data);
      const m = montar(atual);
      if (!m) return null;
      const patch = Object.assign({}, m.patch);
      if (m.hist && m.hist.length) patch.historico = m.hist.map(entradaHist).reverse().concat(r.data.historico || []);
      const u = await sb.from(TABELA).update(patch).eq('id', id).select('id');
      if (!u.error && u.data && u.data.length) return true;
      if (u.error && /hist[oó]rico/i.test(u.error.message) && tentativa === 0) continue;
      if (u.error) throw new Error(u.error.message);
      throw new Error('Não foi possível salvar. Atualize a tela e tente de novo.');
    }
  }

  /* ================= entrada: Comercial → Controle de Insumos ================= */
  async function ciCarregarComercial() {
    const content = $('comercial-content');
    if (!content) return;
    content.style.maxWidth = '';
    content.innerHTML = '<p class="empty-hint">Carregando...</p>';
    try {
      const ms = await getMotoristas();
      ST.motoristas = ms || [];
      await carregarLinhas();
    } catch (err) {
      content.innerHTML = '<div class="ci-err">Não foi possível carregar o Controle de Insumos: ' + esc(err.message) + '</div>';
      return;
    }
    render();
  }

  function render() {
    const content = $('comercial-content');
    if (!content) return;
    const nA = abertas().length, nF = finalizadas().length;
    const aba = (n, rot, qtd) => '<button type="button" class="subtab' + (ST.aba === n ? ' active' : '') + '" data-ci-aba="' + n + '">' + rot +
      (qtd ? '<span class="ci-n">' + qtd + '</span>' : '') + '</button>';
    content.innerHTML = '<div class="ci-tabs">' +
      aba('nova', ST.editId ? 'Editar locação' : 'Nova locação', 0) +
      aba('andamento', 'Em andamento', nA) + aba('finalizadas', 'Finalizadas', nF) +
      '</div><div class="ci-wrap" id="ci-area"></div>';
    content.querySelectorAll('[data-ci-aba]').forEach(b => b.onclick = () => {
      if (ST.aba === b.dataset.ciAba) return;
      if (ST.editId && b.dataset.ciAba !== 'nova') { ST.editId = null; ST.draft = null; }
      ST.aba = b.dataset.ciAba; render();
    });
    if (ST.aba === 'nova') return telaForm();
    if (ST.aba === 'andamento') return telaAndamento();
    return telaFinalizadas();
  }

  /* ================= Nova locação / edição ================= */
  function draftDeLoc(ed) {
    return {
      doutora: ed.doutora, cpfCnpj: ed.cpfCnpj, numero: ed.numero, data: ed.data, horario: ed.horario || '',
      equipamento: ed.equipamento, extras: (ed.extras || []).slice(), contrato: ed.contrato,
      motEntregaId: ed.motEntregaId, motRetiradaId: ed.motRetiradaId, condicoes: ed.condicoes || '',
      valorLocacao: valorTxt(ed.valorLocacao), valorLavieen: valorTxt(ed.valorLavieen), valorManta: valorTxt(ed.valorManta),
      semManta: ed.semManta, duplicados: (ed.duplicados || []).slice(), frete: ed.frete, valorFrete: valorTxt(ed.valorFrete),
      faixas: JSON.parse(JSON.stringify(ed.faixas || [])), gratuidade: ed.gratuidade, gratisAPartir: ed.gratisAPartir
    };
  }

  function telaForm() {
    const area = $('ci-area');
    const ed = ST.editId ? ST.linhas.find(l => l.id === ST.editId) : null;
    if (ST.editId && !ed) { ST.editId = null; ST.draft = null; }
    if (ed && !ST.draft) ST.draft = draftDeLoc(ed);
    if (!ST.draft) ST.draft = Object.assign(novoRasc(), lerRascunhoSalvo() || {});
    const D = ST.draft;
    const entregaFeita = ed && !faseEntrega(ed);
    const iniciou = ed && ed.status !== 'inicial';
    const opts = v => '<option value="">Selecione</option>' + ST.motoristas.map(m =>
      '<option value="' + esc(m.id) + '"' + (m.id === v ? ' selected' : '') + '>' + esc(m.nome) + '</option>').join('') +
      (v && !ST.motoristas.some(m => m.id === v) ? '<option value="' + esc(v) + '" selected>Motorista inativo</option>' : '');
    const pill = (grupo, v, rot, sel, dis) => '<button type="button" class="ci-pill' + (sel ? ' sel' : '') + '" data-g="' + grupo + '" data-v="' + v + '"' + (dis ? ' disabled' : '') + '>' + rot + '</button>';
    const todosCart = C.LINEAR.concat(C.EXTRAS, C.BOOSTER);

    area.innerHTML =
      '<p class="ci-intro">' + (ed ? 'Editando a locação nº ' + esc(ed.numero) + '. As mudanças valem na hora e ficam no histórico. O que o motorista já registrou continua guardado.'
        : 'Os motoristas escolhidos recebem a locação em Transportes → Minhas Locações, sem link.') + '</p>' +
      '<div class="card form-card"><h3>Dados da locação</h3><p class="cardsub">Quem recebe e quando.</p>' +
        '<div class="field"><label for="ci-f-doutora">Nome da doutora</label><input type="text" id="ci-f-doutora" value="' + esc(D.doutora) + '" placeholder="Dra. Fulana de Tal" autocomplete="off"></div>' +
        '<div class="grid2">' +
          '<div class="field"><label for="ci-f-doc">CNPJ ou CPF</label><input type="text" id="ci-f-doc" inputmode="numeric" value="' + esc(D.cpfCnpj) + '" placeholder="000.000.000-00"></div>' +
          '<div class="field"><label for="ci-f-numero">Número da locação</label><input type="text" id="ci-f-numero" value="' + esc(D.numero) + '" placeholder="Ex.: 1042"' + (iniciou ? ' disabled' : '') + '></div>' +
        '</div>' +
        '<div class="grid2">' +
          '<div class="field"><label for="ci-f-data">Data da locação</label><input type="date" id="ci-f-data" value="' + esc(D.data) + '"></div>' +
          '<div class="field"><label for="ci-f-hora">Horário previsto da montagem</label><input type="time" id="ci-f-hora" value="' + esc(D.horario) + '"></div>' +
        '</div>' +
        '<div class="field"><label>Equipamento</label><div class="ci-pills" id="ci-f-equip">' +
          Object.keys(C.EQUIP).map(k => pill('equip', k, esc(C.EQUIP[k]), D.equipamento === k, iniciou)).join('') +
        '</div>' + (iniciou ? '<p class="ci-hint">Número, equipamento, extras e duplicados ficam travados depois do disparo inicial.</p>' : '') + '</div>' +
        '<div class="grid2">' +
          '<div class="field"><label for="ci-f-ment">Motorista da entrega</label><select id="ci-f-ment"' + (entregaFeita ? ' disabled' : '') + '>' + opts(D.motEntregaId) + '</select>' +
            (entregaFeita ? '<p class="ci-hint">Entrega já feita por ' + esc(nomeMot(ed.motEntregaId)) + '.</p>' : '') + '</div>' +
          '<div class="field"><label for="ci-f-mret">Motorista da retirada</label><select id="ci-f-mret">' + opts(D.motRetiradaId) + '</select></div>' +
        '</div>' +
        '<div class="field"><label>Contrato de locação assinado?</label><div class="ci-pills" id="ci-f-con">' +
          pill('con', '1', 'Assinado', D.contrato === true) + pill('con', '0', 'Não assinado', D.contrato === false) +
        '</div><p class="ci-hint">O motorista vê esse aviso em destaque no card da locação.</p></div>' +
        '<div class="field" style="margin-bottom:0"><label for="ci-f-cond">Condições da locação (observações ao motorista)</label><textarea id="ci-f-cond" rows="3" placeholder="O que o motorista precisa saber...">' + esc(D.condicoes) + '</textarea></div>' +
      '</div>' +
      '<div class="card form-card"><h3>Valores</h3><p class="cardsub">O motorista não digita valor nenhum: o sistema calcula com o que você lançar aqui.</p>' +
        '<div class="field"><label for="ci-f-vloc" id="ci-lbl-vloc">Valor da locação</label><input type="text" id="ci-f-vloc" inputmode="decimal" value="' + esc(D.valorLocacao) + '" placeholder="R$ 0,00"><p class="ci-echo" id="ci-echo-vloc"></p></div>' +
        '<div id="ci-bloco-ultra">' +
          '<button type="button" class="btn btn-outline btn-block" id="ci-btn-cond">Condições de valor</button>' +
          '<div id="ci-resumo-cond"></div>' +
          '<div class="field"><label for="ci-f-vlav">Valor locação combo Lavieen</label><input type="text" id="ci-f-vlav" inputmode="decimal" value="' + esc(D.valorLavieen) + '" placeholder="Deixe em branco se não for combo"><p class="ci-echo" id="ci-echo-vlav"></p></div>' +
          '<div class="field"><label>Cartuchos extras</label><p class="ci-hint" style="margin:0 0 8px">Marque só se forem nesta locação. Os demais cartuchos vão sempre.</p><div class="ci-pills" id="ci-f-ext">' +
            C.EXTRAS.map(c => pill('ext', c.key, c.label, D.extras.includes(c.key), iniciou)).join('') + '</div></div>' +
          '<div class="field"><label>Cartuchos duplicados</label><p class="ci-hint" style="margin:0 0 8px">Marque os que vão em dobro. O motorista preenche dois desse cartucho.</p><div class="ci-pills" id="ci-f-dup">' +
            todosCart.map(c => pill('dup', c.key, c.label, D.duplicados.includes(c.key), iniciou)).join('') + '</div></div>' +
        '</div>' +
        '<div id="ci-bloco-crio">' +
          '<div class="field"><label for="ci-f-vman">Valor da manta negociado</label><input type="text" id="ci-f-vman" inputmode="decimal" value="' + esc(D.valorManta) + '" placeholder="R$ 0,00"><p class="ci-echo" id="ci-echo-vman"></p></div>' +
          '<label class="ci-check"><input type="checkbox" id="ci-f-semman"' + (D.semManta ? ' checked' : '') + '> Não enviar mantas nesta locação (só cinta)</label>' +
        '</div>' +
        '<label class="ci-check"><input type="checkbox" id="ci-f-frete"' + (D.frete ? ' checked' : '') + '> Tem frete</label>' +
        '<div class="field" id="ci-bloco-fre" style="margin-bottom:0"><label for="ci-f-vfre">Valor do frete</label><input type="text" id="ci-f-vfre" inputmode="decimal" value="' + esc(D.valorFrete) + '" placeholder="R$ 0,00"><p class="ci-echo" id="ci-echo-vfre"></p></div>' +
      '</div>' +
      '<div class="ci-err" id="ci-err-form" role="alert"></div>' +
      '<div class="ci-acoes">' +
        '<button type="button" class="btn btn-primary btn-block" id="ci-btn-salvar">' + (ed ? 'Salvar alterações' : 'Lançar para o motorista') + '</button>' +
        (ed ? '<button type="button" class="btn btn-ghost btn-block" id="ci-btn-cancel">Descartar edição</button>' : '<button type="button" class="btn btn-ghost btn-block" id="ci-btn-limpar">Limpar formulário</button>') +
        (ed && ed.status === 'final' ? '<button type="button" class="btn btn-outline btn-block" id="ci-btn-reabrir">Reabrir a entrega para correção</button>' : '') +
      '</div>';

    const up = () => {
      const crio = D.equipamento === 'crio';
      $('ci-bloco-ultra').hidden = crio; $('ci-bloco-crio').hidden = !crio; $('ci-bloco-fre').hidden = !D.frete;
      $('ci-lbl-vloc').textContent = crio ? 'Valor da locação (sempre cobrado)' : 'Valor locação Ultraformer';
      $('ci-f-vman').disabled = D.semManta;
      $('ci-f-dup').querySelectorAll('.ci-pill').forEach(b => {
        const extra = C.EXTRAS.some(c => c.key === b.dataset.v);
        b.hidden = extra && !D.extras.includes(b.dataset.v);
      });
      [['vloc', 'valorLocacao'], ['vlav', 'valorLavieen'], ['vman', 'valorManta'], ['vfre', 'valorFrete']].forEach(a => {
        const v = D[a[1]];
        $('ci-echo-' + a[0]).textContent = v ? 'Será registrado como ' + C.fmtMoney(C.parseMoney(v)) : '';
      });
      const r = $('ci-resumo-cond');
      if (!D.faixas.length) r.innerHTML = '<p class="ci-hint" style="margin:8px 0 16px">Nenhuma condição de valor cadastrada ainda.</p>';
      else r.innerHTML = '<div class="ci-resumo">' + D.faixas.map(f => '<div class="ci-kv"><span>' + (f.ate == null ? C.fmtNum(f.de) + ' disparos em diante' : C.fmtNum(f.de) + ' a ' + C.fmtNum(f.ate) + ' disparos') + '</span><span>' + C.fmtMoney(f.valor) + ' cada</span></div>').join('') +
        (D.gratuidade === 'isenta' ? '<div class="ci-kv"><span>Locação</span><span>Isenta</span></div>'
          : D.gratuidade === 'apartir' ? '<div class="ci-kv"><span>Locação gratuita a partir de</span><span>' + C.fmtNum(D.gratisAPartir) + ' disparos</span></div>'
          : '<div class="ci-kv"><span>Locação</span><span>Sempre cobrada</span></div>') + '</div>';
      gravarRascunho();
    };
    const bind = (id, k, fn) => {
      const el = $(id);
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', ev => {
        let v = ev.target.value;
        if (fn) { v = fn(v); ev.target.value = v; }
        D[k] = v; up();
      });
    };
    bind('ci-f-doutora', 'doutora'); bind('ci-f-doc', 'cpfCnpj', C.maskDoc); bind('ci-f-numero', 'numero');
    bind('ci-f-data', 'data'); bind('ci-f-hora', 'horario'); bind('ci-f-ment', 'motEntregaId'); bind('ci-f-mret', 'motRetiradaId');
    bind('ci-f-cond', 'condicoes'); bind('ci-f-vloc', 'valorLocacao'); bind('ci-f-vlav', 'valorLavieen');
    bind('ci-f-vman', 'valorManta'); bind('ci-f-vfre', 'valorFrete');

    $('ci-f-equip').onclick = ev => {
      const b = ev.target.closest('.ci-pill'); if (!b || b.disabled) return;
      D.equipamento = b.dataset.v;
      $('ci-f-equip').querySelectorAll('.ci-pill').forEach(p => p.classList.toggle('sel', p === b)); up();
    };
    $('ci-f-ext').onclick = ev => {
      const b = ev.target.closest('.ci-pill'); if (!b || b.disabled) return;
      b.classList.toggle('sel');
      D.extras = [...$('ci-f-ext').querySelectorAll('.ci-pill.sel')].map(p => p.dataset.v);
      D.duplicados = D.duplicados.filter(k => !C.EXTRAS.some(c => c.key === k) || D.extras.includes(k));
      $('ci-f-dup').querySelectorAll('.ci-pill').forEach(p => p.classList.toggle('sel', D.duplicados.includes(p.dataset.v))); up();
    };
    $('ci-f-dup').onclick = ev => {
      const b = ev.target.closest('.ci-pill'); if (!b || b.disabled) return;
      b.classList.toggle('sel');
      D.duplicados = [...$('ci-f-dup').querySelectorAll('.ci-pill.sel')].map(p => p.dataset.v); up();
    };
    $('ci-f-con').onclick = ev => {
      const b = ev.target.closest('.ci-pill'); if (!b) return;
      D.contrato = b.dataset.v === '1';
      $('ci-f-con').querySelectorAll('.ci-pill').forEach(p => p.classList.toggle('sel', p === b)); up();
    };
    $('ci-f-semman').onchange = ev => { D.semManta = ev.target.checked; if (D.semManta) { D.valorManta = ''; $('ci-f-vman').value = ''; } up(); };
    $('ci-f-frete').onchange = ev => { D.frete = ev.target.checked; up(); };
    $('ci-btn-cond').onclick = () => telaCondicoes(D, up);
    $('ci-btn-salvar').onclick = () => salvarForm(ed, D);
    if (ed) $('ci-btn-cancel').onclick = () => { ST.editId = null; ST.draft = null; ST.aba = 'andamento'; render(); };
    else $('ci-btn-limpar').onclick = () => confirma('Limpar o formulário?', 'Tudo o que foi digitado nesta nova locação será apagado.', 'Limpar', () => {
      ST.draft = null; limparRascunho(); render();
    });
    if ($('ci-btn-reabrir')) $('ci-btn-reabrir').onclick = () => confirma('Reabrir a entrega?',
      'A assinatura da entrega será descartada e ' + nomeMot(ed.motEntregaId) + ' poderá corrigir os valores. Fotos e números ficam guardados.', 'Reabrir', async () => {
        try {
          await atualizar(ed.id, atual => {
            if (atual.status !== 'final') throw new Error('A locação já saiu da etapa de disparo final. Atualize a tela.');
            const ass = Object.assign({}, atual.assinaturas); delete ass.entrega;
            return { patch: { status: 'inicial', assinaturas: ass }, hist: ['Entrega reaberta para correção'] };
          });
          toast('Entrega reaberta. ' + nomeMot(ed.motEntregaId) + ' pode corrigir.');
          ST.editId = null; ST.draft = null; ST.aba = 'andamento';
          await carregarLinhas(); render();
        } catch (err) { toast('Erro: ' + err.message); }
      });
    up();
  }

  /* ---------------- salvar ---------------- */
  async function salvarForm(ed, D) {
    const err = $('ci-err-form'), btn = $('ci-btn-salvar'), crio = D.equipamento === 'crio';
    err.textContent = '';
    const falha = t => { err.textContent = t; err.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
    if (!String(D.doutora).trim() || !String(D.numero).trim() || !D.data) return falha('Preencha nome da doutora, número da locação e data.');
    if (!D.horario) return falha('Preencha o horário previsto da montagem combinado com o cliente.');
    if (!C.docValido(D.cpfCnpj)) return falha('O CPF precisa ter 11 dígitos e o CNPJ, 14.');
    if (D.contrato == null) return falha('Informe se o contrato de locação foi assinado.');
    if (!D.motEntregaId || !D.motRetiradaId) return falha('Escolha o motorista da entrega e o da retirada.');
    const numero = String(D.numero).trim();
    const vLoc = C.parseMoney(D.valorLocacao);
    if (crio) {
      if (!vLoc) return falha('Na Criodermis a locação é sempre cobrada. Preencha o valor.');
      if (!D.semManta && !C.parseMoney(D.valorManta)) return falha('Preencha o valor da manta negociado.');
    } else {
      const m = C.checarFaixas(D.faixas); if (m) return falha('Condições de valor: ' + m);
      if (!vLoc && D.gratuidade !== 'isenta') return falha('Preencha o valor da locação ou marque como isenta nas condições de valor.');
    }
    if (D.frete && !C.parseMoney(D.valorFrete)) return falha('Preencha o valor do frete ou desligue a opção.');

    btn.disabled = true; btn.textContent = 'Salvando...';
    try {
      let q = sb.from(TABELA).select('id,numero').eq('numero', numero).eq('equipamento', D.equipamento);
      if (ed) q = q.neq('id', ed.id);
      const dup = await q;
      if (dup.error) throw new Error(dup.error.message);
      if (dup.data && dup.data.length) { btn.disabled = false; btn.textContent = ed ? 'Salvar alterações' : 'Lançar para o motorista'; return falha('Já existe a locação nº ' + numero + ' neste equipamento.'); }

      const dados = {
        doutora: String(D.doutora).trim(), cpf_cnpj: D.cpfCnpj || null, numero: numero, data_locacao: D.data,
        horario_montagem: D.horario, equipamento: D.equipamento, contrato_assinado: D.contrato,
        motorista_entrega_id: D.motEntregaId, motorista_retirada_id: D.motRetiradaId, condicoes: String(D.condicoes || '').trim() || null,
        valor_locacao: vLoc, valor_lavieen: crio ? 0 : C.parseMoney(D.valorLavieen),
        valor_manta: crio && !D.semManta ? C.parseMoney(D.valorManta) : 0, sem_manta: crio && !!D.semManta,
        tem_frete: !!D.frete, valor_frete: D.frete ? C.parseMoney(D.valorFrete) : 0,
        cartuchos_extras: crio ? [] : D.extras.slice(), cartuchos_duplicados: crio ? [] : D.duplicados.slice(),
        faixas: crio ? [] : D.faixas.map(f => ({ de: f.de, ate: f.ate, valor: f.valor })),
        gratuidade: crio ? 'nao' : D.gratuidade, gratis_a_partir: crio || D.gratuidade !== 'apartir' ? null : D.gratisAPartir
      };

      if (ed) {
        await atualizar(ed.id, atual => {
          const p = Object.assign({}, dados);
          // o que já está travado continua como está no banco
          if (atual.status !== 'inicial') {
            p.numero = atual.numero; p.equipamento = atual.equipamento;
            p.cartuchos_extras = atual.extras; p.cartuchos_duplicados = atual.duplicados;
          }
          if (!faseEntrega(atual)) p.motorista_entrega_id = atual.motEntregaId;
          const h = [];
          if (p.motorista_entrega_id !== atual.motEntregaId) h.push('Troca de motorista (entrega: ' + nomeMot(atual.motEntregaId) + ' → ' + nomeMot(p.motorista_entrega_id) + ')');
          if (p.motorista_retirada_id !== atual.motRetiradaId) h.push('Troca de motorista (retirada: ' + nomeMot(atual.motRetiradaId) + ' → ' + nomeMot(p.motorista_retirada_id) + ')');
          if (p.contrato_assinado !== atual.contrato) h.push('Contrato marcado como ' + (p.contrato_assinado ? 'assinado' : 'não assinado'));
          const valoresMudaram = ['valor_locacao', 'valor_lavieen', 'valor_manta', 'valor_frete'].some(k => Number(p[k]) !== Number(r2(atual, k))) ||
            p.tem_frete !== atual.frete || p.sem_manta !== atual.semManta || p.gratuidade !== atual.gratuidade ||
            (p.gratis_a_partir || null) !== (atual.gratisAPartir || null) || JSON.stringify(p.faixas) !== JSON.stringify(atual.faixas);
          if (valoresMudaram) h.push('Valores ou condições de valor alterados');
          if (!h.length) h.push('Locação editada');
          return { patch: p, hist: h };
        });
        toast('Alterações salvas.');
        ST.editId = null; ST.draft = null; ST.aba = 'andamento';
      } else {
        dados.historico = [entradaHist('Locação lançada')];
        const ins = await sb.from(TABELA).insert(dados).select('id');
        if (ins.error) {
          if (ins.error.code === '23505') throw new Error('Já existe a locação nº ' + numero + ' neste equipamento.');
          throw new Error(ins.error.message);
        }
        toast('Locação lançada para ' + nomeMot(D.motEntregaId) + '.');
        ST.draft = null; limparRascunho(); ST.aba = 'andamento';
      }
      await carregarLinhas();
      render();
      window.scrollTo(0, 0);
    } catch (e) {
      btn.disabled = false; btn.textContent = ed ? 'Salvar alterações' : 'Lançar para o motorista';
      falha(e.message);
    }
  }
  function r2(l, k) {
    return { valor_locacao: l.valorLocacao, valor_lavieen: l.valorLavieen, valor_manta: l.valorManta, valor_frete: l.valorFrete }[k];
  }

  /* ---------------- subtela: condições de valor ---------------- */
  function telaCondicoes(D, depois) {
    const F = JSON.parse(JSON.stringify(D.faixas));
    let gr = D.gratuidade, ap = D.gratisAPartir;
    if (!F.length) F.push({ de: 0, ate: null, valor: 0 });
    const draw = () => {
      const linha = (f, i) => '<div class="ci-faixa">' +
        '<div class="field"><label for="ci-fx-de-' + i + '">De</label><input id="ci-fx-de-' + i + '" type="text" inputmode="numeric" value="' + f.de + '"' + (i > 0 ? ' disabled' : '') + '></div>' +
        '<div class="field"><label for="ci-fx-ate-' + i + '">Até</label><input id="ci-fx-ate-' + i + '" type="text" inputmode="numeric" value="' + (f.ate == null ? '' : f.ate) + '" placeholder="em diante"></div>' +
        '<div class="field"><label for="ci-fx-val-' + i + '">R$ por disparo</label><input id="ci-fx-val-' + i + '" type="text" inputmode="decimal" value="' + (f.valor ? String(f.valor).replace('.', ',') : '') + '" placeholder="0,00"></div>' +
        '<button type="button" class="ci-del" data-del="' + i + '" aria-label="Remover faixa ' + (i + 1) + '"' + (F.length < 2 ? ' disabled' : '') + '>×</button></div>';
      const pg = (v, rot) => '<button type="button" class="ci-pill' + (gr === v ? ' sel' : '') + '" data-v="' + v + '">' + rot + '</button>';
      abrirModal('Condições de valor',
        '<p class="ci-hint" style="margin:0 0 12px">Todos os disparos saem pelo valor da faixa em que o total cair. Não é progressivo.</p>' +
        '<div id="ci-fx">' + F.map(linha).join('') + '</div>' +
        '<button type="button" class="btn btn-ghost btn-sm" id="ci-fx-add">+ Adicionar faixa</button>' +
        '<p class="ci-hint">Deixe o "até" da última faixa em branco para valer dali em diante.</p>' +
        '<div class="field" style="margin-top:16px"><label>Locação do Ultraformer</label><div class="ci-pills" id="ci-gr">' +
          pg('nao', 'Sempre cobrada') + pg('apartir', 'Gratuita a partir de...') + pg('isenta', 'Isenta') + '</div></div>' +
        '<div class="field" id="ci-wrap-ap"><label for="ci-fx-ap">A partir de quantos disparos?</label><input type="text" inputmode="numeric" id="ci-fx-ap" value="' + (ap == null ? '' : ap) + '" placeholder="Ex.: 1000"></div>' +
        '<p class="ci-hint">A gratuidade zera só a locação do Ultraformer. O combo Lavieen e o frete continuam cobrados.</p>' +
        '<div class="ci-sim"><div class="field"><label for="ci-fx-sim">Simular com quantos disparos?</label><input type="text" inputmode="numeric" id="ci-fx-sim" placeholder="Ex.: 1500"></div><div id="ci-fx-res" class="ci-sim-res"></div></div>' +
        '<div class="ci-err" id="ci-fx-err" role="alert" style="margin-top:12px"></div>',
        '<button type="button" class="btn btn-ghost" id="ci-fx-no">Voltar</button><button type="button" class="btn btn-primary" id="ci-fx-ok">Salvar condições</button>');
      const sim = () => {
        const n = $('ci-fx-sim').value, res = $('ci-fx-res');
        if (!n) { res.textContent = ''; return; }
        const t = C.parseInt0(n);
        const p = C.precoUltra({ faixas: F, gratuidade: gr, gratisAPartir: ap, valorLocacao: C.parseMoney(D.valorLocacao), valorLavieen: C.parseMoney(D.valorLavieen), frete: D.frete, valorFrete: C.parseMoney(D.valorFrete) }, t);
        res.textContent = p.faixa
          ? C.fmtNum(t) + ' × ' + C.fmtMoney(p.unit) + ' = ' + C.fmtMoney(p.subtotal) + ' · locação ' + (p.gratis ? 'grátis' : C.fmtMoney(p.locAplicada)) +
            (p.lavieen ? ' · Lavieen ' + C.fmtMoney(p.lavieen) : '') + (p.frete ? ' · frete ' + C.fmtMoney(p.frete) : '') + ' · total ' + C.fmtMoney(p.total)
          : 'Quantidade fora das faixas.';
      };
      const ler = () => {
        F.forEach((f, i) => {
          if (i === 0) f.de = C.parseInt0($('ci-fx-de-0').value);
          const a = $('ci-fx-ate-' + i).value.trim();
          f.ate = a === '' ? null : C.parseInt0(a);
          f.valor = C.parseMoney($('ci-fx-val-' + i).value);
        });
        for (let i = 1; i < F.length; i++) { if (F[i - 1].ate != null) { F[i].de = F[i - 1].ate + 1; $('ci-fx-de-' + i).value = F[i].de; } }
        ap = $('ci-fx-ap').value.trim() === '' ? null : C.parseInt0($('ci-fx-ap').value);
        $('ci-fx-err').textContent = '';
        sim();
      };
      $('ci-modal-overlay').addEventListener('input', ler);
      $('ci-fx').onclick = ev => {
        const b = ev.target.closest('[data-del]'); if (!b || b.disabled) return;
        ler(); F.splice(+b.dataset.del, 1); if (F.length) F[F.length - 1].ate = null; draw();
      };
      $('ci-fx-add').onclick = () => {
        ler(); const u = F[F.length - 1];
        if (u.ate == null) { $('ci-fx-err').textContent = 'Preencha o "até" da última faixa antes de adicionar outra.'; return; }
        F.push({ de: u.ate + 1, ate: null, valor: 0 }); draw();
      };
      $('ci-wrap-ap').hidden = gr !== 'apartir';
      $('ci-gr').onclick = ev => {
        const b = ev.target.closest('.ci-pill'); if (!b) return;
        ler(); gr = b.dataset.v;
        $('ci-gr').querySelectorAll('.ci-pill').forEach(p => p.classList.toggle('sel', p === b));
        $('ci-wrap-ap').hidden = gr !== 'apartir'; sim();
      };
      $('ci-fx-no').onclick = fecharModal;
      $('ci-fx-ok').onclick = () => {
        ler();
        const m = C.checarFaixas(F);
        if (m) { $('ci-fx-err').textContent = m; return; }
        if (gr === 'apartir' && !ap) { $('ci-fx-err').textContent = 'Informe a partir de quantos disparos a locação é gratuita.'; return; }
        D.faixas = F.slice(); D.gratuidade = gr; D.gratisAPartir = gr === 'apartir' ? ap : null;
        fecharModal(); depois();
      };
    };
    draw();
  }

  /* ================= Em andamento ================= */
  function statusPill(l) {
    if (l.status === 'inicial') return '<span class="status-pill status-wait"><span class="dot"></span>Aguardando entrega · ' + esc(nomeMot(l.motEntregaId)) + '</span>';
    if (l.status === 'sig_entrega') return '<span class="status-pill status-wait"><span class="dot"></span>Entrega em assinatura · ' + esc(nomeMot(l.motEntregaId)) + '</span>';
    if (l.status === 'final') return '<span class="status-pill status-info"><span class="dot"></span>Na clínica · retirada com ' + esc(nomeMot(l.motRetiradaId)) + '</span>';
    return '<span class="status-pill status-info"><span class="dot"></span>Em fechamento · ' + esc(nomeMot(l.motRetiradaId)) + '</span>';
  }
  function passos(l) {
    const n = (C.ETAPAS[l.status] || [7])[0];
    return '<div class="ci-steps" aria-hidden="true">' + [1, 2, 3, 4, 5, 6].map(i => '<i class="' + (i < n ? 'on' : i === n ? 'atual' : '') + '"></i>').join('') + '</div>';
  }

  function telaAndamento() {
    const area = $('ci-area');
    const L = abertas();
    if (!L.length) { area.innerHTML = '<div class="card"><p class="empty-hint"><b>Nenhuma locação em andamento</b><br>Lance uma nova locação para ela aparecer aqui.</p></div>'; return; }
    const optsMot = v => ST.motoristas.map(m => '<option value="' + esc(m.id) + '"' + (m.id === v ? ' selected' : '') + '>' + esc(m.nome) + '</option>').join('') +
      (v && !ST.motoristas.some(m => m.id === v) ? '<option value="' + esc(v) + '" selected>Motorista inativo</option>' : '');
    area.innerHTML = '<p class="ci-intro">Você acompanha cada etapa e pode trocar o motorista a qualquer momento.</p>' + L.map(l => {
      const n = (C.ETAPAS[l.status] || [0])[0];
      return '<div class="card loc-card">' +
        '<div class="loc-top"><div><div class="loc-eq">' + esc(C.EQUIP[l.equipamento]) + '</div>' +
          '<div class="loc-name">Nº ' + esc(l.numero) + ' · ' + esc(l.doutora) + '</div>' +
          '<div class="loc-meta">' + esc(quando(l)) + '</div></div>' + statusPill(l) + '</div>' +
        passos(l) + '<div class="ci-etapa">Etapa ' + n + ' de 6: ' + esc(etapaNome(l)) + '</div>' +
        '<div class="ci-card-sec"><span class="ci-mini-label">Contrato de locação</span><div class="ci-pills">' +
          '<button type="button" class="ci-pill' + (l.contrato === true ? ' sel' : '') + '" data-con="1" data-id="' + esc(l.id) + '">Assinado</button>' +
          '<button type="button" class="ci-pill' + (l.contrato === false ? ' sel' : '') + '" data-con="0" data-id="' + esc(l.id) + '">Não assinado</button></div></div>' +
        '<div class="ci-card-sec"><div class="grid2">' +
          '<div class="field"><label for="ci-tr-e-' + esc(l.id) + '">Motorista da entrega</label><select id="ci-tr-e-' + esc(l.id) + '" data-tr="entrega" data-id="' + esc(l.id) + '"' + (faseEntrega(l) ? '' : ' disabled') + '>' + optsMot(l.motEntregaId) + '</select></div>' +
          '<div class="field"><label for="ci-tr-r-' + esc(l.id) + '">Motorista da retirada</label><select id="ci-tr-r-' + esc(l.id) + '" data-tr="retirada" data-id="' + esc(l.id) + '">' + optsMot(l.motRetiradaId) + '</select></div>' +
        '</div></div>' +
        '<details class="ci-hist"><summary>Histórico (' + (l.historico || []).length + ')</summary>' +
          ((l.historico || []).map(h => '<div>' + esc(dtBR(h.ts)) + ' · ' + esc(h.quem) + ': ' + esc(h.txt) + '</div>').join('') || '<div>Sem registros.</div>') + '</details>' +
        '<div class="loc-actions">' +
          '<button type="button" class="btn btn-sm btn-ghost" data-edit="' + esc(l.id) + '">Editar</button>' +
          (!faseEntrega(l) ? '<button type="button" class="btn btn-sm btn-ghost" data-rel="' + esc(l.id) + '">Relatório de entrega</button>' : '') +
          '<button type="button" class="btn btn-sm btn-ghost" data-del="' + esc(l.id) + '">Excluir</button>' +
        '</div></div>';
    }).join('');

    area.querySelectorAll('[data-tr]').forEach(s => s.onchange = async () => {
      const id = s.dataset.id, tipo = s.dataset.tr, novo = s.value;
      s.disabled = true;
      try {
        await atualizar(id, atual => {
          const col = tipo === 'entrega' ? 'motorista_entrega_id' : 'motorista_retirada_id';
          const antes = tipo === 'entrega' ? atual.motEntregaId : atual.motRetiradaId;
          if (antes === novo) return null;
          if (tipo === 'entrega' && !faseEntrega(atual)) throw new Error('A entrega já foi assinada; o motorista da entrega não muda mais.');
          const p = {}; p[col] = novo;
          return { patch: p, hist: ['Troca de motorista (' + tipo + ': ' + nomeMot(antes) + ' → ' + nomeMot(novo) + ')'] };
        });
        toast(nomeMot(novo) + ' agora vê esta ' + tipo + '. Os dados registrados continuam guardados.');
      } catch (err) { toast('Erro: ' + err.message); }
      await carregarLinhas(); render();
    });
    area.querySelectorAll('[data-con]').forEach(b => b.onclick = async () => {
      const v = b.dataset.con === '1';
      try {
        const feito = await atualizar(b.dataset.id, atual => atual.contrato === v ? null
          : { patch: { contrato_assinado: v }, hist: ['Contrato marcado como ' + (v ? 'assinado' : 'não assinado')] });
        if (feito) toast('Contrato marcado como ' + (v ? 'assinado' : 'não assinado') + '.');
      } catch (err) { toast('Erro: ' + err.message); }
      await carregarLinhas(); render();
    });
    area.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { ST.editId = b.dataset.edit; ST.draft = null; ST.aba = 'nova'; render(); window.scrollTo(0, 0); });
    area.querySelectorAll('[data-rel]').forEach(b => b.onclick = () => {
      const l = ST.linhas.find(x => x.id === b.dataset.rel);
      if (typeof window.ciAbrirRelatorioEntrega === 'function') window.ciAbrirRelatorioEntrega(l);
      else toast('O relatório de entrega fica pronto na etapa dos PDFs.');
    });
    area.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
      const l = ST.linhas.find(x => x.id === b.dataset.del);
      confirma('Excluir a locação nº ' + l.numero + '?', 'Tudo o que foi registrado nela será apagado, inclusive fotos e assinaturas. Não dá para desfazer.', 'Excluir', async () => {
        try {
          await excluir(l.id);
          toast('Locação nº ' + l.numero + ' excluída.');
        } catch (err) { toast('Erro ao excluir: ' + err.message); }
        await carregarLinhas(); render();
      });
    });
  }

  async function excluir(id) {
    const s = await sb.auth.getSession();
    const token = s.data.session && s.data.session.access_token;
    if (!token) throw new Error('Sessão expirada. Entre de novo.');
    const resp = await fetch('/api/controle-insumos?acao=excluir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ id: id })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || 'Falha ao excluir.');
    return data;
  }

  /* ================= Finalizadas (a etapa 6 completa: PDF e retenção) ================= */
  function telaFinalizadas() {
    const area = $('ci-area');
    const L = finalizadas();
    if (!L.length) { area.innerHTML = '<div class="card"><p class="empty-hint"><b>Nenhuma locação finalizada</b><br>As locações concluídas ficam guardadas aqui.</p></div>'; return; }
    area.innerHTML = '<p class="ci-intro">Fotos e assinaturas ficam guardadas por ' + C.DIAS_RETENCAO + ' dias. Depois disso, o resumo continua aqui.</p>' + L.map(l => {
      const f = l.financeiro || {};
      return '<div class="card loc-card"><div class="loc-top"><div><div class="loc-eq">' + esc(C.EQUIP[l.equipamento]) + '</div>' +
        '<div class="loc-name">Nº ' + esc(l.numero) + ' · ' + esc(l.doutora) + '</div><div class="loc-meta">' + esc(quando(l)) + '</div></div>' +
        (l.dadosApagadosEm ? '<span class="status-pill status-info">Só resumo</span>' : '<span class="status-pill status-ok"><span class="dot"></span>Finalizada</span>') + '</div>' +
        '<div style="margin-top:10px">' +
          '<div class="ci-kv"><span>Entrega / retirada</span><span>' + esc(nomeMot(l.motEntregaId)) + ' / ' + esc(nomeMot(l.motRetiradaId)) + '</span></div>' +
          (l.equipamento === 'crio'
            ? '<div class="ci-kv"><span>Mantas utilizadas</span><span>' + (l.semManta ? '—' : esc(f.utilizadas)) + '</span></div>'
            : '<div class="ci-kv"><span>Disparos utilizados</span><span>' + C.fmtNum(f.totalGeral) + '</span></div><div class="ci-kv"><span>Valor do disparo</span><span>' + C.fmtMoney(f.unit) + '</span></div>') +
          '<div class="ci-kv forte"><span>Total</span><span>' + C.fmtMoney(f.total) + '</span></div></div>' +
        '<div class="loc-actions"><button type="button" class="btn btn-sm btn-ghost" data-pdf="' + esc(l.id) + '">' + (l.dadosApagadosEm ? 'Abrir resumo em PDF' : 'Abrir PDF') + '</button></div></div>';
    }).join('');
    area.querySelectorAll('[data-pdf]').forEach(b => b.onclick = () => {
      const l = ST.linhas.find(x => x.id === b.dataset.pdf);
      if (typeof window.ciAbrirPdfFinal === 'function') window.ciAbrirPdfFinal(l);
    });
  }

  /* ---------------- escopo global ---------------- */
  window.ciCarregarComercial = ciCarregarComercial;
  // utilitários compartilhados com a tela do motorista (js/controle-insumos-motorista.js)
  window.CIUI = { esc, dataBR, dtBR, quando, abrirModal, fecharModal, confirma, entradaHist, etapaNome, passos };
})();
