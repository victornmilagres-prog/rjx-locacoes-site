/* =====================================================================
   Controle de Insumos — PDFs
   Relatório de entrega e PDF final, no layout do protótipo aprovado
   (cabecalho, gradeFotos, pdfEntrega, pdfFinal), e o visualizador em
   tela cheia: as páginas são desenhadas com pdf.js em canvas, porque o
   Android não exibe PDF embutido em página.
   Fotos e assinaturas vêm do bucket privado por link temporário e são
   convertidas em dataURL antes de irem para o jsPDF.
   Expõe: window.ciAbrirRelatorioEntrega(l), window.ciAbrirPdfFinal(l)
   ===================================================================== */
(function () {
  'use strict';

  const C = window.CICalc;
  const U = window.CIUI;
  const { esc, dtBR, quando } = U;
  const $ = id => document.getElementById(id);
  const BUCKET = 'controle-insumos';
  const LOGO_SRC = 'assets/logo-black.png';
  const LOGO_W = 900, LOGO_H = 501;

  let logoCache = null;
  const nomesCache = {};

  /* ---------------- dados de apoio ---------------- */
  function paraDataUrl(blob) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
  }
  async function logo() {
    if (logoCache) return logoCache;
    try {
      // o logo ocupa 34 mm no papel: reduz para 360 px antes de ir ao PDF
      const r = await fetch(LOGO_SRC); const url = await paraDataUrl(await r.blob());
      logoCache = await new Promise(res => { const im = new Image(); im.onload = () => { const c = document.createElement("canvas"); c.width = 360; c.height = Math.round(360 * LOGO_H / LOGO_W); c.getContext("2d").drawImage(im, 0, 0, c.width, c.height); res(c.toDataURL("image/png")); }; im.onerror = () => res(url); im.src = url; });
    } catch (e) { logoCache = null; }
    return logoCache;
  }
  async function nomes() {
    if (Object.keys(nomesCache).length) return nomesCache;
    try {
      const r = await sb.rpc('ci_nomes_motoristas');
      (r.data || []).forEach(m => { nomesCache[m.id] = m.nome; });
    } catch (e) {}
    try {
      if (!Object.keys(nomesCache).length && typeof getMotoristas === 'function') (await getMotoristas() || []).forEach(m => { nomesCache[m.id] = m.nome; });
    } catch (e) {}
    try { if (typeof currentUsuario !== 'undefined' && currentUsuario) nomesCache[currentUsuario.id] = nomesCache[currentUsuario.id] || currentUsuario.nome; } catch (e) {}
    return nomesCache;
  }
  const nomeMot = (id, N) => N[id] || 'motorista';

  // baixa do bucket privado todas as imagens que o PDF usa: { path: dataURL }
  async function imagens(paths) {
    const lista = [...new Set(paths.filter(Boolean))];
    const out = {};
    if (!lista.length) return out;
    const r = await sb.storage.from(BUCKET).createSignedUrls(lista, 600);
    const urls = (r.data || []).filter(x => x.signedUrl);
    await Promise.all(urls.map(async x => {
      try { const resp = await fetch(x.signedUrl); if (resp.ok) out[x.path] = await paraDataUrl(await resp.blob()); } catch (e) {}
    }));
    return out;
  }
  // junta a foto (meta do banco) com a imagem baixada
  const comImg = (p, IMG) => (p && IMG[p.path] ? Object.assign({}, p, { img: IMG[p.path] }) : null);
  const fmtGeo = g => (g ? g.lat + ', ' + g.lon : '');

  /* ---------------- partes do layout (portadas do protótipo) ---------------- */
  function cabecalho(doc, l, titulo, N, LOGO) {
    const mx = 16; let y = 10; const lw = 34, lh = lw * (LOGO_H / LOGO_W);
    if (LOGO) { try { doc.addImage(LOGO, 'PNG', mx, y, lw, lh, undefined, 'FAST'); } catch (x) {} }
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(90, 85, 78); doc.text('CNPJ 51.797.671/0001-66 · AFE 8.34727-6', mx, y + lh + 5);
    doc.setFontSize(9); doc.setTextColor(23, 19, 15); doc.text(titulo, 194, y + 6, { align: 'right' }); doc.text(quando(l), 194, y + 11, { align: 'right' });
    doc.setFontSize(8); doc.setTextColor(90, 85, 78); if (l.horario) doc.text('Montagem agendada', 194, y + 15, { align: 'right' });
    y += Math.max(lh + 9, 16); doc.setDrawColor(122, 18, 32); doc.setLineWidth(1); doc.line(mx, y, 194, y); y += 8;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(doc.splitTextToSize(l.doutora, 178)[0], mx, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(90, 85, 78);
    doc.text(C.EQUIP[l.equipamento] + ' · Entrega: ' + nomeMot(l.motEntregaId, N) + ' · Retirada: ' + nomeMot(l.motRetiradaId, N), mx, y + 5); y += 10;
    if (l.cpfCnpj) { doc.setFontSize(8.5); doc.text('CPF/CNPJ: ' + l.cpfCnpj, mx, y); y += 5; }
    const d = C.EQUIP_DET[l.equipamento]; doc.setFontSize(8); doc.setTextColor(140, 131, 119);
    doc.text('Nº de série: ' + d.serie + '  ·  Registro Anvisa: ' + d.anvisa, mx, y); y += 7;
    return y;
  }
  function secao(doc, t, y) { doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(122, 18, 32); doc.text(t, 16, y); return y + 6; }
  function gradeFotos(doc, items, y, lim) {
    const h = 30, gap = 6, mx = 16, cell = (178 - gap * 3) / 4;
    items.forEach((it, i) => {
      const col = i % 4; if (col === 0 && y + h + 12 > lim) { doc.addPage(); y = 14; }
      const x = mx + col * (cell + gap), p = it.photo;
      // a foto mantém a proporção; foto em pé não fica achatada
      const iw = p.w || 4, ih = p.h || 3, e = Math.min(cell / iw, h / ih), dw = iw * e, dh = ih * e;
      try { doc.addImage(p.img, 'JPEG', x + (cell - dw) / 2, y + (h - dh) / 2, dw, dh); } catch (z) {}
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6); doc.setTextColor(90, 85, 78);
      const ls = doc.splitTextToSize(it.label, cell).slice(0, 2); doc.text(ls, x, y + h + 3); const o = (ls.length - 1) * 2.4;
      doc.text(dtBR(p.ts) + (p.origem === 'galeria' ? ' · galeria' : ''), x, y + h + 6 + o); doc.text(fmtGeo(p.geo), x, y + h + 9 + o);
      if (col === 3 || i === items.length - 1) y = y + h + 14;
    });
    return y;
  }
  const cartuchos = l => C.expand(l, C.linearDe(l)).concat(C.expand(l, C.BOOSTER));

  /* ---------------- relatório de entrega ---------------- */
  async function montarEntrega(l) {
    const crio = l.equipamento === 'crio';
    const fe = crio ? (l.fotos.crio.entrega || {}) : (l.fotos.ultra.inicial || {});
    const ass = l.assinaturas || {};
    const [N, LOGO, IMG] = await Promise.all([nomes(), logo(),
      imagens(Object.values(fe).map(p => p && p.path).concat([ass.entrega && ass.entrega.path]))]);
    const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' }), lim = 285;
    let y = cabecalho(doc, l, 'Relatório de entrega · Locação nº ' + l.numero, N, LOGO);
    const itens = [];
    if (crio) {
      const c = l.crio.entregues || {};
      y = secao(doc, 'ITENS ENTREGUES', y); doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(54, 47, 41);
      if (!l.semManta) { doc.text('Mantas: ' + C.fmtNum(c.mantas), 16, y); y += 5.5; }
      doc.text('Cintas: ' + C.fmtNum(c.cintas), 16, y); y += 8;
      const m = comImg(fe.mantasE, IMG), ci = comImg(fe.cintasE, IMG);
      if (m) itens.push({ label: 'Mantas, entrega', photo: m });
      if (ci) itens.push({ label: 'Cintas, entrega', photo: ci });
    } else {
      y = secao(doc, 'DISPARO INICIAL', y); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(54, 47, 41);
      cartuchos(l).forEach(c => {
        if (y > lim) { doc.addPage(); y = 14; }
        doc.text(c.label + ': ' + C.fmtNum((l.ultra.inicial || {})[c.key]), 16, y); y += 5;
        const p = comImg(fe[c.key], IMG); if (p) itens.push({ label: c.label + ', inicial', photo: p });
      });
      y += 4;
    }
    if (itens.length) { if (y + 20 > lim) { doc.addPage(); y = 14; } y = secao(doc, 'FOTOS DA ENTREGA', y); y = gradeFotos(doc, itens, y, lim); }
    const s = ass.entrega;
    if (s) {
      if (y + 40 > lim) { doc.addPage(); y = 14; }
      y = secao(doc, 'ASSINATURA DA ENTREGA', y);
      if (IMG[s.path]) { try { doc.addImage(IMG[s.path], 'PNG', 16, y, 55, 20, undefined, 'FAST'); } catch (z) {} }
      doc.setDrawColor(23, 19, 15); doc.setLineWidth(.3); doc.line(16, y + 22, 71, y + 22);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(23, 19, 15); doc.text(doc.splitTextToSize(l.doutora, 60)[0], 16, y + 26);
      doc.setFont('helvetica', 'normal'); doc.setTextColor(90, 85, 78); doc.text(dtBR(s.ts), 16, y + 30);
      if (l.cpfCnpj) doc.text('CPF/CNPJ: ' + l.cpfCnpj, 16, y + 34);
    }
    return { doc, nome: 'RJX_Relatorio_Entrega_' + l.numero + '_' + l.equipamento + '.pdf', titulo: 'Relatório de entrega · Nº ' + l.numero };
  }

  /* ---------------- PDF final ---------------- */
  async function montarFinal(l) {
    const crio = l.equipamento === 'crio';
    const f = l.financeiro || C.retratoFinanceiro(l);
    const apagado = !!l.dadosApagadosEm;
    const ass = l.assinaturas || {}, cob = (l.crio || {}).cobrancaCinta;
    const paths = [];
    if (!apagado) {
      if (crio) ['entrega', 'retorno'].forEach(et => Object.values(l.fotos.crio[et] || {}).forEach(p => p && paths.push(p.path)));
      else ['inicial', 'final'].forEach(et => Object.values(l.fotos.ultra[et] || {}).forEach(p => p && paths.push(p.path)));
      ['entrega', 'retirada', 'logistica'].forEach(k => ass[k] && paths.push(ass[k].path));
      if (cob && cob.assinatura) paths.push(cob.assinatura.path);
    }
    const [N, LOGO, IMG] = await Promise.all([nomes(), logo(), imagens(paths)]);
    const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' }), lim = 285, mx = 16;
    let y = cabecalho(doc, l, 'Locação nº ' + l.numero, N, LOGO);
    const quebra = h => { if (y + h > lim) { doc.addPage(); y = 14; } };
    if (l.condicoes) {
      const ls = doc.splitTextToSize('Condições: ' + l.condicoes, 172);
      doc.setFontSize(8.5); doc.setTextColor(54, 47, 41); doc.setFont('helvetica', 'normal');
      ls.forEach(t => { quebra(5); doc.text(t, mx + 3, y); y += 4.5; }); y += 3;
    }
    const cab = (cols, ws) => {
      quebra(12); doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(140, 131, 119);
      let x = mx; cols.forEach((c, i) => { doc.text(c.toUpperCase(), x, y); x += ws[i]; }); y += 2;
      doc.setDrawColor(23, 19, 15); doc.setLineWidth(.3); doc.line(mx, y, mx + ws.reduce((a, b) => a + b, 0), y); y += 4.5;
    };
    const lin = (vs, ws) => { quebra(6); doc.setFont('courier', 'normal'); doc.setFontSize(8.5); doc.setTextColor(23, 19, 15); let x = mx; vs.forEach((v, i) => { doc.text(String(v), x, y); x += ws[i]; }); y += 5.2; };
    const R = [];
    if (crio) {
      const a = f.entregues || l.crio.entregues || {}, b = f.retornando || l.crio.retornando || {}, ws = [70, 40, 40, 28];
      quebra(14); y = secao(doc, 'CRIODERMIS 2.0', y); cab(['Item', 'Entregue', 'Retornou', 'Utilizado'], ws);
      if (!l.semManta) lin(['Mantas', C.fmtNum(a.mantas), C.fmtNum(b.mantas), C.fmtNum(f.utilizadas)], ws);
      lin(['Cintas (sem custo)', C.fmtNum(a.cintas), C.fmtNum(b.cintas), '—'], ws); y += 4;
      if (!l.semManta) R.push(['Mantas utilizadas', C.fmtNum(f.utilizadas)], ['Valor por manta', C.fmtMoney(l.valorManta)], ['Total manta', C.fmtMoney(f.totalManta)]);
      R.push(['Locação', C.fmtMoney(f.locAplicada)], ['Frete', l.frete ? C.fmtMoney(f.frete) : '—']);
      if (f.cinta) R.push(['Cinta ausente (' + C.fmtNum(f.cintaQtd || (cob && cob.qtd)) + ' × ' + C.fmtMoney(C.VALOR_CINTA) + ')', C.fmtMoney(f.cinta)]);
    } else {
      const ws = [62, 35, 35, 35], ini = l.ultra.inicial || {}, fin = l.ultra.final || {};
      const s = c => [c.label, C.fmtNum(ini[c.key]), C.fmtNum(fin[c.key]), C.fmtNum(c.saldo)];
      y = secao(doc, 'CARTUCHOS LINEAR', y); cab(['Cartucho', 'Inicial', 'Final', 'Saldo'], ws); (f.linear || []).forEach(c => lin(s(c), ws)); y += 3;
      quebra(16); y = secao(doc, 'CARTUCHOS BOOSTER', y); cab(['Cartucho', 'Inicial', 'Final', 'Saldo'], ws); (f.booster || []).forEach(c => lin(s(c), ws)); y += 4;
      R.push(['Total de disparos utilizados', C.fmtNum(f.totalGeral)], ['Faixa aplicada', f.faixa ? C.faixaTxt(f.faixa) : '—'],
        ['Valor do disparo', C.fmtMoney(f.unit)], ['Disparos × valor', C.fmtMoney(f.subtotal)],
        ['Locação Ultraformer', f.gratis ? 'Gratuita (' + f.motivo + ')' : C.fmtMoney(f.locAplicada)]);
      if (f.lavieen) R.push(['Locação combo Lavieen', C.fmtMoney(f.lavieen)]);
      R.push(['Frete', l.frete ? C.fmtMoney(f.frete) : '—']);
    }
    R.forEach(([a, b]) => {
      quebra(6); doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(54, 47, 41); doc.text(a, mx, y);
      doc.setFont('courier', 'bold'); doc.text(String(b), 194, y, { align: 'right' }); y += 5.5;
    });
    // o total nunca cai para fora da página
    y += 3; quebra(20);
    doc.setFillColor(122, 18, 32); doc.rect(mx, y, 178, 14, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(250, 247, 242); doc.text('TOTAL GERAL', mx + 5, y + 9);
    doc.setFontSize(15); doc.text(C.fmtMoney(f.total), 189, y + 9.5, { align: 'right' }); y += 20;
    const dv = f.divergencias || C.divergencias(l);
    if (dv && dv.length) {
      dv.forEach(d => {
        quebra(5); doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(138, 90, 18);
        doc.text('Atenção: ' + d.label + ' (' + d.et + ') registrado ' + C.fmtNum(d.reg) + ', leitura da foto ' + C.fmtNum(d.ia), mx, y); y += 4;
      });
      y += 3;
    }
    if (apagado) {
      quebra(8); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(90, 85, 78);
      doc.text('Resumo gerado após a retenção. Fotos e assinaturas foram apagadas em ' + dtBR(l.dadosApagadosEm) + '.', mx, y);
    } else {
      const it = [];
      if (crio) {
        const a = l.fotos.crio.entrega || {}, b = l.fotos.crio.retorno || {};
        [['Mantas, entrega', a.mantasE], ['Cintas, entrega', a.cintasE], ['Mantas, retorno', b.mantasR], ['Cintas, retorno', b.cintasR]]
          .forEach(p => { const q = comImg(p[1], IMG); if (q) it.push({ label: p[0], photo: q }); });
      } else {
        cartuchos(l).forEach(c => {
          const a = comImg((l.fotos.ultra.inicial || {})[c.key], IMG), b = comImg((l.fotos.ultra.final || {})[c.key], IMG);
          if (a) it.push({ label: c.label + ', inicial', photo: a }); if (b) it.push({ label: c.label + ', final', photo: b });
        });
      }
      if (it.length) { quebra(20); y = secao(doc, 'FOTOS DAS TELAS E ITENS', y); y = gradeFotos(doc, it, y, lim) + 2; }
      const cpf = l.cpfCnpj ? 'CPF/CNPJ: ' + l.cpfCnpj : '';
      const sg = [
        { n: l.doutora, sub: 'Entrega · motorista ' + nomeMot(l.motEntregaId, N), cpf, s: ass.entrega },
        { n: l.doutora, sub: 'Retirada', cpf, s: ass.retirada },
        { n: nomeMot(l.motRetiradaId, N), sub: 'Motorista da retirada', cpf: '', s: ass.logistica }
      ];
      if (crio && cob && cob.assinatura) sg.push({ n: l.doutora, sub: 'Cinta ausente', cpf, s: cob.assinatura });
      quebra(46);
      const gap = 7, w = Math.min(55, (178 - (sg.length - 1) * gap) / sg.length); let sx = mx;
      sg.forEach(a => {
        if (a.s && IMG[a.s.path]) { try { doc.addImage(IMG[a.s.path], 'PNG', sx, y, w, 20, undefined, 'FAST'); } catch (z) {} }
        doc.setDrawColor(23, 19, 15); doc.setLineWidth(.3); doc.line(sx, y + 22, sx + w, y + 22); let t = y + 26;
        doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(23, 19, 15); doc.text(doc.splitTextToSize(a.n, w)[0], sx, t); t += 4;
        doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(90, 85, 78); doc.text(doc.splitTextToSize(a.sub, w)[0], sx, t); t += 3.5;
        if (a.cpf) { doc.text(a.cpf, sx, t); t += 3.5; }
        if (a.s) doc.text(dtBR(a.s.ts), sx, t);
        sx += w + gap;
      });
    }
    return { doc, nome: 'RJX_Locacao_' + l.numero + '_' + l.equipamento + '.pdf', titulo: 'Locação nº ' + l.numero };
  }

  /* ---------------- visualizador em tela cheia ---------------- */
  function fecharViewer() { const v = $('ci-pdfview'); if (v) v.remove(); document.body.style.overflow = ''; }
  function abrirViewer(titulo) {
    fecharViewer();
    const v = document.createElement('div');
    v.id = 'ci-pdfview'; v.className = 'ci-pdfview';
    v.setAttribute('role', 'dialog'); v.setAttribute('aria-modal', 'true'); v.setAttribute('aria-label', titulo);
    v.innerHTML = '<div class="ci-pdfbar"><b>' + esc(titulo) + '</b><button type="button" class="btn btn-primary btn-sm" id="ci-pv-dl" disabled>Baixar PDF</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" id="ci-pv-x">Fechar</button></div><div class="ci-pdfpages" id="ci-pv-p"><p>Gerando o PDF...</p></div>';
    document.body.appendChild(v);
    document.body.style.overflow = 'hidden';
    $('ci-pv-x').onclick = fecharViewer;
    return v;
  }
  async function mostrar(montar, l) {
    if (!window.jspdf) { toast('Biblioteca de PDF ainda carregando. Tente de novo.'); return; }
    abrirViewer('Gerando PDF · Nº ' + l.numero);
    let pacote;
    try { pacote = await montar(l); }
    catch (e) { const b = $('ci-pv-p'); if (b) b.innerHTML = '<p>Não foi possível gerar o PDF: ' + esc(e.message || e) + '</p>'; return; }
    const v = $('ci-pdfview'); if (!v) return;
    v.querySelector('.ci-pdfbar b').textContent = pacote.titulo;
    const dl = $('ci-pv-dl'); dl.disabled = false; dl.onclick = () => pacote.doc.save(pacote.nome);
    const box = $('ci-pv-p');
    try {
      if (!window.pdfjsLib) throw new Error('pdf.js');
      if (typeof ccInicializarPdfJs === 'function') await ccInicializarPdfJs();
      const dados = pacote.doc.output('arraybuffer');
      const pdf = await window.pdfjsLib.getDocument({ data: dados, isEvalSupported: false }).promise;
      if (!$('ci-pv-p')) return;
      box.innerHTML = '';
      const larg = Math.min(box.clientWidth - 20, 820), dpr = Math.min(window.devicePixelRatio || 1, 2);
      for (let i = 1; i <= pdf.numPages; i++) {
        const pg = await pdf.getPage(i), base = pg.getViewport({ scale: 1 }), vp = pg.getViewport({ scale: Math.max(0.5, larg / base.width) * dpr });
        const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
        c.style.width = (vp.width / dpr) + 'px';
        c.setAttribute('aria-label', 'Página ' + i + ' de ' + pdf.numPages);
        if (!$('ci-pv-p')) return;
        box.appendChild(c);
        await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      }
    } catch (x) {
      if ($('ci-pv-p')) box.innerHTML = '<p>Não foi possível mostrar o PDF nesta tela. Use o botão Baixar PDF.</p>';
    }
  }

  window.ciAbrirRelatorioEntrega = l => mostrar(montarEntrega, l);
  window.ciAbrirPdfFinal = l => mostrar(montarFinal, l);
  // usados pelos testes locais
  window.__ciPdf = { montarEntrega, montarFinal };
})();
