// Limpeza automática do Controle de Insumos (roda sozinha uma vez por dia).
// Regra decidida pelo Victor: o PDF fica arquivado no contrato e com o
// cliente, então o sistema não guarda o material pesado para sempre.
//  1) Locação concluída há mais de 30 dias: apaga SOMENTE fotos e
//     assinaturas (inclusive a da cinta ausente). Todo o resto fica:
//     cliente, equipamento, motoristas, números, financeiro e histórico.
//  2) Arquivo órfão (nenhuma locação aponta para ele, ex.: foto trocada ou
//     locação excluída) some depois de 24 horas.
// Nada disso é feito pela tela. Usa a service_role key no servidor.
// Segue o padrão de api/limpar-selfies.js.

const BUCKET = 'controle-insumos';
const DIAS_RETENCAO = 30;
const ORFAO_HORAS = 24;

const FOTOS_VAZIAS = () => ({ ultra: { inicial: {}, final: {} }, crio: { entrega: {}, retorno: {} } });

// todos os caminhos de arquivo que uma locação referencia
function caminhosDa(l) {
  const out = [];
  const f = l.fotos || {};
  [['ultra', 'inicial'], ['ultra', 'final'], ['crio', 'entrega'], ['crio', 'retorno']].forEach(([a, b]) => {
    Object.values((f[a] || {})[b] || {}).forEach(p => { if (p && p.path) out.push(p.path); });
  });
  Object.values(l.assinaturas || {}).forEach(s => { if (s && s.path) out.push(s.path); });
  const cob = (l.crio || {}).cobrancaCinta;
  if (cob && cob.assinatura && cob.assinatura.path) out.push(cob.assinatura.path);
  return out;
}

module.exports = async (req, res) => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const CRON_SECRET = process.env.CRON_SECRET;
  const hdr = { Authorization: 'Bearer ' + SERVICE_KEY, apikey: SERVICE_KEY, 'Content-Type': 'application/json' };

  // só o agendamento da Vercel (ou quem tiver o CRON_SECRET) dispara
  const auth = req.headers.authorization || '';
  if (CRON_SECRET) {
    if (auth !== 'Bearer ' + CRON_SECRET) return res.status(401).json({ error: 'Nao autorizado.' });
  } else if (!/^vercel-cron\//i.test(String(req.headers['user-agent'] || ''))) {
    return res.status(401).json({ error: 'Nao autorizado.' });
  }

  const listar = async (prefixo) => {
    const itens = [];
    for (let offset = 0; ; offset += 1000) {
      const r = await fetch(SUPABASE_URL + '/storage/v1/object/list/' + BUCKET, {
        method: 'POST', headers: hdr, body: JSON.stringify({ prefix: prefixo, limit: 1000, offset })
      });
      if (!r.ok) throw new Error('Falha ao listar arquivos (' + r.status + ').');
      const lote = await r.json();
      if (!Array.isArray(lote) || !lote.length) break;
      itens.push(...lote);
      if (lote.length < 1000) break;
    }
    return itens;
  };
  // percorre o bucket inteiro: {locacao}/{etapa}/{arquivo}
  const todosArquivos = async () => {
    const out = [];
    const nivel = async (prefixo, prof) => {
      for (const it of await listar(prefixo)) {
        const nome = (prefixo ? prefixo : '') + it.name;
        if (it.id) out.push({ name: nome, created_at: it.created_at });
        else if (prof < 3) await nivel(nome + '/', prof + 1);
      }
    };
    await nivel('', 0);
    return out;
  };
  const removerArquivos = async (paths) => {
    for (let i = 0; i < paths.length; i += 500) {
      const r = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET, {
        method: 'DELETE', headers: hdr, body: JSON.stringify({ prefixes: paths.slice(i, i + 500) })
      });
      if (!r.ok) return false;
    }
    return true;
  };

  try {
    const resultado = { locacoes_limpas: 0, arquivos_apagados: 0, orfaos_apagados: 0 };
    const agora = new Date().toISOString();

    // 1) concluídas há mais de 30 dias, ainda com fotos e assinaturas
    const limite = new Date(Date.now() - DIAS_RETENCAO * 86400000).toISOString();
    const r1 = await fetch(SUPABASE_URL + '/rest/v1/controle_locacoes?select=id,fotos,assinaturas,crio,historico' +
      '&status=eq.concluido&dados_apagados_em=is.null&finalizada_em=lt.' + encodeURIComponent(limite), { headers: hdr });
    const vencidas = await r1.json();
    if (!Array.isArray(vencidas)) throw new Error('Falha ao ler locações vencidas.');
    let arquivos = null;
    for (const l of vencidas) {
      // apaga o que a locação referencia e tudo o que estiver na pasta dela
      if (!arquivos) arquivos = await todosArquivos();
      const daPasta = arquivos.filter(a => a.name.indexOf(l.id + '/') === 0).map(a => a.name);
      const paths = [...new Set(caminhosDa(l).concat(daPasta))];
      if (paths.length && !(await removerArquivos(paths))) continue; // tenta de novo amanhã
      const crio = Object.assign({}, l.crio || {});
      if (crio.cobrancaCinta) crio.cobrancaCinta = Object.assign({}, crio.cobrancaCinta, { assinatura: null });
      const historico = [{ ts: agora, quem: 'Sistema', txt: 'Fotos e assinaturas apagadas após ' + DIAS_RETENCAO + ' dias' }].concat(l.historico || []);
      const up = await fetch(SUPABASE_URL + '/rest/v1/controle_locacoes?id=eq.' + l.id + '&dados_apagados_em=is.null', {
        method: 'PATCH', headers: hdr,
        body: JSON.stringify({ fotos: FOTOS_VAZIAS(), assinaturas: {}, crio, dados_apagados_em: agora, historico })
      });
      if (up.ok) { resultado.locacoes_limpas++; resultado.arquivos_apagados += paths.length; }
    }

    // 2) órfãos com mais de 24 horas
    const rRef = await fetch(SUPABASE_URL + '/rest/v1/controle_locacoes?select=id,fotos,assinaturas,crio', { headers: hdr });
    const linhas = await rRef.json();
    if (!Array.isArray(linhas)) throw new Error('Falha ao ler locações.');
    const referenciados = new Set();
    linhas.forEach(l => caminhosDa(l).forEach(p => referenciados.add(p)));
    const corte = Date.now() - ORFAO_HORAS * 3600000;
    const orfaos = (await todosArquivos()).filter(a =>
      !referenciados.has(a.name) && a.created_at && new Date(a.created_at).getTime() < corte).map(a => a.name);
    if (orfaos.length && await removerArquivos(orfaos)) resultado.orfaos_apagados = orfaos.length;

    return res.status(200).json(resultado);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Erro interno.' });
  }
};

module.exports.caminhosDa = caminhosDa;
