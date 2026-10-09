// Limpeza automatica das selfies guardadas (bucket selfies-pendentes).
// Roda sozinha todo dia (cron no vercel.json). Ninguem apaga foto na mao.
// Regras:
//  1) Selfie ja decidida (validada ou reprovada) perde a foto 3 dias depois da decisao (prazo de contestacao).
//  2) Arquivo orfao (sem nenhuma selfie apontando pra ele, ex.: foto antiga trocada no reenvio) some depois de 1 dia.
// Usa a service_role key no servidor - nunca expor no cliente.

module.exports = async (req, res) => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const CRON_SECRET = process.env.CRON_SECRET;
  const BUCKET = 'selfies-pendentes';
  const PRAZO_DIAS = 3;
  const ORFAO_HORAS = 24;

  if (CRON_SECRET && (req.headers.authorization || '') !== 'Bearer ' + CRON_SECRET) {
    return res.status(401).json({ error: 'Nao autorizado.' });
  }

  const hdr = { Authorization: 'Bearer ' + SERVICE_KEY, apikey: SERVICE_KEY, 'Content-Type': 'application/json' };
  const pathDe = function (url) {
    const p = String(url || '').split('/' + BUCKET + '/')[1];
    return p ? decodeURIComponent(p.split('?')[0]) : null;
  };
  const removerArquivos = async function (paths) {
    if (!paths.length) return true;
    const r = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET, {
      method: 'DELETE', headers: hdr, body: JSON.stringify({ prefixes: paths })
    });
    return r.ok;
  };

  try {
    const resultado = { decididas_apagadas: 0, orfaos_apagados: 0 };

    // 1) selfies decididas ha mais de PRAZO_DIAS dias
    const limite = new Date(Date.now() - PRAZO_DIAS * 86400000).toISOString();
    const r1 = await fetch(SUPABASE_URL + '/rest/v1/premiacao_selfies_dia?select=motorista_id,data_ref,foto_url&foto_url=not.is.null&validada_em=lt.' + encodeURIComponent(limite), { headers: hdr });
    const vencidas = await r1.json();
    if (Array.isArray(vencidas) && vencidas.length) {
      const paths = vencidas.map(function (v) { return pathDe(v.foto_url); }).filter(Boolean);
      const ok = await removerArquivos(paths);
      if (ok) {
        for (const v of vencidas) {
          await fetch(SUPABASE_URL + '/rest/v1/premiacao_selfies_dia?motorista_id=eq.' + v.motorista_id + '&data_ref=eq.' + v.data_ref, {
            method: 'PATCH', headers: hdr, body: JSON.stringify({ foto_url: null })
          });
        }
        resultado.decididas_apagadas = paths.length;
      }
    }

    // 2) arquivos orfaos (nenhuma selfie aponta pra eles)
    const rRef = await fetch(SUPABASE_URL + '/rest/v1/premiacao_selfies_dia?select=foto_url&foto_url=not.is.null', { headers: hdr });
    const refs = await rRef.json();
    const referenciados = {};
    (Array.isArray(refs) ? refs : []).forEach(function (x) { const p = pathDe(x.foto_url); if (p) referenciados[p] = true; });
    const rList = await fetch(SUPABASE_URL + '/storage/v1/object/list/' + BUCKET, {
      method: 'POST', headers: hdr, body: JSON.stringify({ prefix: '', limit: 1000, offset: 0 })
    });
    const objetos = await rList.json();
    const corte = Date.now() - ORFAO_HORAS * 3600000;
    const orfaos = (Array.isArray(objetos) ? objetos : []).filter(function (o) {
      return o && o.name && !referenciados[o.name] && o.created_at && new Date(o.created_at).getTime() < corte;
    }).map(function (o) { return o.name; });
    if (orfaos.length && await removerArquivos(orfaos)) resultado.orfaos_apagados = orfaos.length;

    return res.status(200).json(resultado);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Erro interno.' });
  }
};
