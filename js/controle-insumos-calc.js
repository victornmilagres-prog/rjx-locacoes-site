/* =====================================================================
   Controle de Insumos — catálogo e cálculo
   Arquivo único usado pela tela (window.CICalc) e pelo servidor
   (require('../js/controle-insumos-calc.js')), para o total ser sempre
   o mesmo nos dois lados.
   As funções de preço foram portadas do protótipo aprovado sem mudar a
   lógica: acharFaixa, checarFaixas, precoUltra, saldos, calcular,
   divergencias, parseMoney.
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CICalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- catálogo ---------- */
  const LINEAR = [
    { key: 'linear15', label: 'Linear 1,5mm' },
    { key: 'linear2', label: 'Linear 2,0mm' },
    { key: 'linear3', label: 'Linear 3,0mm' },
    { key: 'linear45', label: 'Linear 4,5mm' },
    { key: 'linear6', label: 'Linear 6,0mm' }
  ];
  const EXTRAS = [
    { key: 'linear9', label: 'Linear 9,0mm' },
    { key: 'linear13', label: 'Linear 13,0mm' }
  ];
  // Atenção: a chave booster2 tem o rótulo "Booster 3,0mm" (histórico, manter).
  const BOOSTER = [
    { key: 'booster15', label: 'Booster 1,5mm' },
    { key: 'booster2', label: 'Booster 3,0mm' },
    { key: 'booster45', label: 'Booster 4,5mm' }
  ];
  const EQUIP = { mpt1: 'Ultraformer MPT 1', mpt2: 'Ultraformer MPT 2', crio: 'Criodermis 2.0' };
  const EQUIP_DET = {
    mpt1: { serie: 'CSU246203', anvisa: '80380269016' },
    mpt2: { serie: 'CSU26B025', anvisa: '80380269016' },
    crio: { serie: '00105CRN0659680323', anvisa: '81243810003' }
  };
  const VALOR_CINTA = 18;
  const DIAS_RETENCAO = 30;
  const ETAPAS = {
    inicial: [1, 'Disparo inicial'],
    sig_entrega: [2, 'Assinatura da entrega'],
    final: [3, 'Disparo final'],
    condicoes: [4, 'Saldo e total'],
    sig_fechamento: [5, 'Assinaturas do fechamento'],
    revisao: [6, 'Revisão de fotos']
  };
  const ETAPAS_CRIO = { inicial: 'Entrega da Crio', final: 'Retorno da Crio' };

  /* ---------- formatação ---------- */
  const fmtMoney = n => (n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtNum = n => (n || 0).toLocaleString('pt-BR');
  const centavos = n => Math.round((Number(n) || 0) * 100) / 100;

  function parseInt0(s) {
    const n = parseInt(String(s == null ? '' : s).replace(/[^\d]/g, ''), 10);
    return isNaN(n) ? 0 : n;
  }
  /* "1.500" é mil e quinhentos. Ponto seguido de 3 dígitos é milhar; vírgula é sempre decimal. */
  function parseMoney(v) {
    if (typeof v === 'number') return v;
    if (!v) return 0;
    let s = String(v).replace(/[^\d,.]/g, '');
    if (!s) return 0;
    if (s.indexOf(',') > -1) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }
  function docValido(s) {
    const d = String(s || '').replace(/\D/g, '');
    return !d || d.length === 11 || d.length === 14;
  }
  function maskDoc(s) {
    const d = String(s).replace(/\D/g, '').slice(0, 14);
    if (d.length <= 11) return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3}\.\d{3})(\d)/, '$1.$2').replace(/^(\d{3}\.\d{3}\.\d{3})(\d)/, '$1-$2');
    return d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2}\.\d{3})(\d)/, '$1.$2').replace(/^(\d{2}\.\d{3}\.\d{3})(\d)/, '$1/$2').replace(/(\/\d{4})(\d)/, '$1-$2');
  }

  /* ---------- regra de preço: todos os disparos saem pelo valor da faixa em que o total caiu ---------- */
  function acharFaixa(faixas, total) {
    const fs = (faixas || []).slice().sort((a, b) => a.de - b.de);
    for (const f of fs) { if (total >= f.de && (f.ate == null || total <= f.ate)) return f; }
    return total === 0 && fs.length ? fs[0] : null;
  }
  function faixaTxt(f) { return f.ate == null ? (fmtNum(f.de) + ' em diante') : (fmtNum(f.de) + ' a ' + fmtNum(f.ate)); }
  function checarFaixas(faixas) {
    if (!faixas.length) return 'Adicione pelo menos uma faixa.';
    for (let i = 0; i < faixas.length; i++) {
      const f = faixas[i], ult = i === faixas.length - 1;
      if (!f.valor) return 'Preencha o valor da faixa ' + (i + 1) + '.';
      if (!ult && f.ate == null) return 'Só a última faixa pode ficar sem o "até".';
      if (ult && f.ate != null) return 'Deixe o "até" da última faixa em branco, para cobrir qualquer quantidade.';
      if (f.ate != null && f.ate < f.de) return 'Na faixa ' + (i + 1) + ', o "até" é menor que o "de".';
      if (i > 0 && f.de !== faixas[i - 1].ate + 1) return 'A faixa ' + (i + 1) + ' precisa começar em ' + fmtNum(faixas[i - 1].ate + 1) + '.';
    }
    return '';
  }
  function precoUltra(loc, totalGeral) {
    const faixa = acharFaixa(loc.faixas, totalGeral);
    const unit = faixa ? faixa.valor : 0, subtotal = totalGeral * unit;
    let gratis = false, motivo = '';
    if (loc.gratuidade === 'isenta') { gratis = true; motivo = 'isenta nas condições'; }
    else if (loc.gratuidade === 'apartir' && totalGeral >= (loc.gratisAPartir || 0)) { gratis = true; motivo = 'atingiu ' + fmtNum(loc.gratisAPartir) + ' disparos'; }
    const locAplicada = gratis ? 0 : (loc.valorLocacao || 0);
    const lavieen = loc.valorLavieen || 0, frete = loc.frete ? (loc.valorFrete || 0) : 0;
    return { faixa, unit, subtotal, gratis, motivo, locAplicada, lavieen, frete, total: subtotal + locAplicada + lavieen + frete };
  }
  const linearDe = l => [...LINEAR, ...EXTRAS.filter(c => (l.extras || []).includes(c.key))];
  function expand(loc, list) {
    const out = [];
    list.forEach(c => {
      if ((loc.duplicados || []).includes(c.key)) {
        out.push({ key: c.key + '__1', label: c.label + ' — Cartucho 1' });
        out.push({ key: c.key + '__2', label: c.label + ' — Cartucho 2' });
      } else out.push(c);
    });
    return out;
  }
  function saldos(loc) {
    const ini = loc.ultra.inicial || {}, fin = loc.ultra.final || {};
    const f = c => ({ ...c, saldo: Math.max(0, (ini[c.key] || 0) - (fin[c.key] || 0)) });
    const linear = expand(loc, linearDe(loc)).map(f), booster = expand(loc, BOOSTER).map(f);
    const totalLinear = linear.reduce((s, c) => s + c.saldo, 0), totalBooster = booster.reduce((s, c) => s + c.saldo, 0);
    return { linear, booster, totalLinear, totalBooster, totalGeral: totalLinear + totalBooster };
  }
  function calcular(loc) {
    if (loc.equipamento === 'crio') {
      const ent = loc.crio.entregues || { mantas: 0, cintas: 0 }, ret = loc.crio.retornando || { mantas: 0, cintas: 0 };
      const utilizadas = loc.semManta ? 0 : Math.max(0, ent.mantas - ret.mantas);
      const totalManta = utilizadas * (loc.valorManta || 0), cinta = loc.crio.cobrancaCinta ? loc.crio.cobrancaCinta.total : 0;
      const frete = loc.frete ? (loc.valorFrete || 0) : 0;
      return { utilizadas, totalManta, cinta, frete, locAplicada: loc.valorLocacao || 0, total: totalManta + (loc.valorLocacao || 0) + frete + cinta };
    }
    const s = saldos(loc);
    return { ...s, ...precoUltra(loc, s.totalGeral) };
  }
  function divergencias(loc) {
    if (loc.equipamento === 'crio') return [];
    const out = [], run = (lista, fotos, vals, et) => lista.forEach(c => {
      const p = fotos[c.key];
      if (p && p.ia && p.ia.valor != null && vals[c.key] != null && p.ia.valor !== vals[c.key]) out.push({ et, label: c.label, ia: p.ia.valor, reg: vals[c.key] });
    });
    const l = [...expand(loc, linearDe(loc)), ...expand(loc, BOOSTER)];
    run(l, loc.fotos.ultra.inicial || {}, loc.ultra.inicial || {}, 'inicial');
    run(l, loc.fotos.ultra.final || {}, loc.ultra.final || {}, 'final');
    return out;
  }

  /* ---------- banco <-> formato do cálculo ---------- */
  const num = v => (v == null || v === '' ? 0 : Number(v));
  const FOTOS_VAZIAS = () => ({ ultra: { inicial: {}, final: {} }, crio: { entrega: {}, retorno: {} } });
  function locDeLinha(r) {
    const fotos = r.fotos || FOTOS_VAZIAS();
    fotos.ultra = fotos.ultra || { inicial: {}, final: {} };
    fotos.crio = fotos.crio || { entrega: {}, retorno: {} };
    return {
      id: r.id,
      numero: r.numero,
      doutora: r.doutora,
      cpfCnpj: r.cpf_cnpj || '',
      data: r.data_locacao,
      horario: r.horario_montagem ? String(r.horario_montagem).slice(0, 5) : '',
      equipamento: r.equipamento,
      contrato: r.contrato_assinado,
      motEntregaId: r.motorista_entrega_id,
      motRetiradaId: r.motorista_retirada_id,
      condicoes: r.condicoes || '',
      valorLocacao: num(r.valor_locacao),
      valorLavieen: num(r.valor_lavieen),
      valorManta: num(r.valor_manta),
      semManta: !!r.sem_manta,
      frete: !!r.tem_frete,
      valorFrete: num(r.valor_frete),
      extras: r.cartuchos_extras || [],
      duplicados: r.cartuchos_duplicados || [],
      faixas: (r.faixas || []).map(f => ({ de: num(f.de), ate: f.ate == null ? null : num(f.ate), valor: num(f.valor) })),
      gratuidade: r.gratuidade || 'nao',
      gratisAPartir: r.gratis_a_partir == null ? null : num(r.gratis_a_partir),
      status: r.status,
      ultra: r.ultra || { inicial: {}, final: {} },
      crio: r.crio || {},
      rascunho: r.rascunho || {},
      fotos,
      assinaturas: r.assinaturas || {},
      financeiro: r.financeiro || null,
      historico: r.historico || [],
      criadoEm: r.criado_em,
      atualizadoEm: r.atualizado_em,
      finalizadaEm: r.finalizada_em,
      dadosApagadosEm: r.dados_apagados_em
    };
  }

  /* Retrato do cálculo gravado em "financeiro" ao concluir (valores em centavos exatos). */
  function retratoFinanceiro(loc) {
    const c = calcular(loc);
    if (loc.equipamento === 'crio') {
      const cob = loc.crio.cobrancaCinta;
      return {
        equipamento: 'crio', semManta: !!loc.semManta,
        entregues: loc.crio.entregues || null, retornando: loc.crio.retornando || null,
        utilizadas: c.utilizadas, valorManta: centavos(loc.valorManta),
        totalManta: centavos(c.totalManta), cintaQtd: cob ? cob.qtd : 0, cinta: centavos(c.cinta), frete: centavos(c.frete),
        locAplicada: centavos(c.locAplicada), total: centavos(c.total)
      };
    }
    return {
      equipamento: loc.equipamento,
      linear: c.linear.map(x => ({ key: x.key, label: x.label, saldo: x.saldo })),
      booster: c.booster.map(x => ({ key: x.key, label: x.label, saldo: x.saldo })),
      totalLinear: c.totalLinear, totalBooster: c.totalBooster, totalGeral: c.totalGeral,
      faixa: c.faixa, unit: c.unit, subtotal: centavos(c.subtotal),
      gratis: c.gratis, motivo: c.motivo, locAplicada: centavos(c.locAplicada),
      lavieen: centavos(c.lavieen), frete: centavos(c.frete), total: centavos(c.total),
      divergencias: divergencias(loc)
    };
  }

  return {
    LINEAR, EXTRAS, BOOSTER, EQUIP, EQUIP_DET, VALOR_CINTA, DIAS_RETENCAO, ETAPAS, ETAPAS_CRIO,
    fmtMoney, fmtNum, centavos, parseInt0, parseMoney, docValido, maskDoc,
    acharFaixa, faixaTxt, checarFaixas, precoUltra, linearDe, expand, saldos, calcular, divergencias,
    locDeLinha, retratoFinanceiro, FOTOS_VAZIAS
  };
});
