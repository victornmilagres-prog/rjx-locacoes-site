// Conclusão de uma locação do Controle de Insumos ("Concluir locação" do motorista).
// O total é calculado AQUI, no servidor, com o mesmo arquivo de cálculo da
// tela (js/controle-insumos-calc.js). O motorista não consegue gravar o
// total por conta própria: o trigger do banco bloqueia "financeiro" e a
// etapa "concluido" para quem não é o servidor.
// Usa a service_role key no servidor - nunca expor no cliente.

const CI = require('../js/controle-insumos-calc.js');

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
    const rU = await fetch(SUPABASE_URL + '/rest/v1/usuarios?select=nome,papel,ativo&id=eq.' + encodeURIComponent(user.id), { headers: hdr });
    const eu = (await rU.json())[0];
    if (!eu || !eu.ativo || eu.papel !== 'transportes') return res.status(403).json({ error: 'Só o motorista da retirada conclui a locação.' });

    // 2) a locação
    const id = String((req.body && req.body.id) || '');
    if (!UUID.test(id)) return res.status(400).json({ error: 'Locação inválida.' });
    const rL = await fetch(SUPABASE_URL + '/rest/v1/controle_locacoes?select=*&id=eq.' + id, { headers: hdr });
    const linha = (await rL.json())[0];
    if (!linha) return res.status(404).json({ error: 'Locação não encontrada.' });
    if (linha.motorista_retirada_id !== user.id) return res.status(403).json({ error: 'A locação mudou: a retirada não está mais com você.' });
    if (linha.status !== 'revisao') return res.status(409).json({ error: 'A locação não está na revisão de fotos. Atualize a tela.' });

    // 3) conferências antes de fechar
    const loc = CI.locDeLinha(linha);
    const ass = loc.assinaturas || {};
    if (!ass.entrega || !ass.retirada || !ass.logistica) return res.status(409).json({ error: 'Faltam assinaturas. Volte e colha todas antes de concluir.' });
    if (loc.equipamento !== 'crio') {
      const lista = CI.expand(loc, CI.linearDe(loc)).concat(CI.expand(loc, CI.BOOSTER));
      const ini = loc.ultra.inicial || {}, fin = loc.ultra.final || {};
      const fi = loc.fotos.ultra.inicial || {}, ff = loc.fotos.ultra.final || {};
      for (const c of lista) {
        if (ini[c.key] == null || fin[c.key] == null) return res.status(409).json({ error: 'Falta o número de ' + c.label + '.' });
        if (fin[c.key] > ini[c.key]) return res.status(409).json({ error: 'O final de ' + c.label + ' é maior que o inicial.' });
        if (!fi[c.key] || !ff[c.key]) return res.status(409).json({ error: 'Falta a foto de ' + c.label + '.' });
      }
      const chk = CI.checarFaixas(loc.faixas);
      if (chk) return res.status(409).json({ error: 'Condições de valor inválidas: ' + chk });
    } else {
      // o fluxo da Criodermis entra na etapa 4 da implantação
      return res.status(409).json({ error: 'A conclusão da Criodermis ainda não está disponível.' });
    }

    // 4) grava o retrato do cálculo e fecha
    const financeiro = CI.retratoFinanceiro(loc);
    const agora = new Date().toISOString();
    const historico = [{ ts: agora, quem: eu.nome, txt: 'Locação concluída · total ' + CI.fmtMoney(financeiro.total) }].concat(linha.historico || []);
    const up = await fetch(SUPABASE_URL + '/rest/v1/controle_locacoes?id=eq.' + id + '&status=eq.revisao', {
      method: 'PATCH', headers: Object.assign({ Prefer: 'return=representation' }, hdr),
      body: JSON.stringify({ status: 'concluido', financeiro, finalizada_em: agora, historico })
    });
    const rows = await up.json().catch(() => []);
    if (!up.ok || !Array.isArray(rows) || !rows.length) return res.status(409).json({ error: 'A locação mudou enquanto concluía. Atualize a tela.' });

    return res.status(200).json({ ok: true, financeiro });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Erro interno.' });
  }
};
