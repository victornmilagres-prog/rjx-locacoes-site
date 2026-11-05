// Exclusão de uma locação do Controle de Insumos (botão "Excluir" da Yasmin).
// Só comercial ou gerencial ativo. Apaga primeiro os arquivos do bucket
// privado controle-insumos ({locacao_id}/...) e depois a linha.
// Usa a service_role key no servidor - nunca expor no cliente.

const BUCKET = 'controle-insumos';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async (req, res) => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const hdr = { Authorization: 'Bearer ' + SERVICE_KEY, apikey: SERVICE_KEY, 'Content-Type': 'application/json' };

  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  try {
    // 1) quem está chamando
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Faça login de novo.' });
    const u = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { Authorization: 'Bearer ' + token, apikey: SERVICE_KEY } });
    if (!u.ok) return res.status(401).json({ error: 'Sessão inválida. Faça login de novo.' });
    const user = await u.json();
    const rU = await fetch(SUPABASE_URL + '/rest/v1/usuarios?select=papel,ativo&id=eq.' + encodeURIComponent(user.id), { headers: hdr });
    const linhasU = await rU.json();
    const eu = Array.isArray(linhasU) ? linhasU[0] : null;
    if (!eu || !eu.ativo || ['comercial', 'gerencial'].indexOf(eu.papel) < 0) {
      return res.status(403).json({ error: 'Só o Comercial ou o Gerencial pode excluir locações.' });
    }

    // 2) a locação
    const id = String((req.body && req.body.id) || '');
    if (!UUID.test(id)) return res.status(400).json({ error: 'Locação inválida.' });
    const rL = await fetch(SUPABASE_URL + '/rest/v1/controle_locacoes?select=id,numero&id=eq.' + id, { headers: hdr });
    const loc = (await rL.json())[0];
    if (!loc) return res.status(404).json({ error: 'Locação não encontrada.' });

    // 3) arquivos: lista {id}/ e cada pasta dentro dela
    const listar = async (prefixo) => {
      const r = await fetch(SUPABASE_URL + '/storage/v1/object/list/' + BUCKET, {
        method: 'POST', headers: hdr, body: JSON.stringify({ prefix: prefixo, limit: 1000, offset: 0 })
      });
      if (!r.ok) throw new Error('Falha ao listar arquivos (' + r.status + ').');
      const itens = await r.json();
      return Array.isArray(itens) ? itens : [];
    };
    const caminhos = [];
    for (const item of await listar(id + '/')) {
      if (item.id) caminhos.push(id + '/' + item.name);               // arquivo direto
      else for (const f of await listar(id + '/' + item.name + '/')) { // pasta (inicial, final, assinaturas...)
        if (f.id) caminhos.push(id + '/' + item.name + '/' + f.name);
      }
    }
    if (caminhos.length) {
      const d = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET, {
        method: 'DELETE', headers: hdr, body: JSON.stringify({ prefixes: caminhos })
      });
      if (!d.ok) return res.status(502).json({ error: 'Não foi possível apagar os arquivos. Nada foi excluído.' });
    }

    // 4) a linha
    const dl = await fetch(SUPABASE_URL + '/rest/v1/controle_locacoes?id=eq.' + id, {
      method: 'DELETE', headers: Object.assign({ Prefer: 'return=minimal' }, hdr)
    });
    if (!dl.ok) return res.status(502).json({ error: 'Os arquivos foram apagados, mas a locação não. Tente de novo.' });

    return res.status(200).json({ ok: true, numero: loc.numero, arquivos_apagados: caminhos.length });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Erro interno.' });
  }
};
