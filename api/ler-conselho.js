// api/ler-conselho.js
// Le o print da consulta feita no site oficial de um conselho profissional (CRM, CRO, CREFITO,
// CRF, CRBM, etc.) e extrai a situacao do profissional e suas habilitacoes/especialidades via IA.
// Requer a env var ANTHROPIC_API_KEY na Vercel (a mesma ja usada em /api/ler-serasa.js).

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metodo nao permitido.' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  async function getCallerPapel(token) {
    if (!token) return null;
    const userResp = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + token, apikey: SERVICE_KEY },
    });
    if (!userResp.ok) return null;
    const user = await userResp.json();
    const rowResp = await fetch(
      SUPABASE_URL + '/rest/v1/usuarios?id=eq.' + user.id + '&select=papel,ativo',
      { headers: { Authorization: 'Bearer ' + SERVICE_KEY, apikey: SERVICE_KEY } }
    );
    if (!rowResp.ok) return null;
    const rows = await rowResp.json();
    if (!Array.isArray(rows) || !rows.length || !rows[0].ativo) return null;
    return rows[0].papel;
  }

  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    const papel = await getCallerPapel(token);
    if (!papel || (papel !== 'financeiro' && papel !== 'gerencial')) {
      return res.status(403).json({ error: 'Usuario nao autorizado a usar a leitura automatica.' });
    }

    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY nao configurada.' });
    }

    const body = req.body || {};
    const pdfBase64 = body.pdfBase64;
    const mimeType = body.mimeType || 'application/pdf';
    if (!pdfBase64 || typeof pdfBase64 !== 'string') {
      return res.status(400).json({ error: 'Envie o arquivo em pdfBase64.' });
    }

    const isImage = mimeType.startsWith('image/');
    const contentBlock = isImage
      ? { type: 'image', source: { type: 'base64', media_type: mimeType, data: pdfBase64 } }
      : { type: 'document', source: { type: 'base64', media_type: mimeType, data: pdfBase64 } };

    const instrucoes =
      'Voce recebeu um print de tela (ou PDF) de uma consulta feita no site oficial de um conselho ' +
      'profissional brasileiro (como CFM/CRM, CRO, CREFITO, CRF, CRBM ou similar), mostrando o registro ' +
      'de um profissional. Leia a imagem/documento inteiro e identifique a situacao do registro e todas ' +
      'as habilitacoes, especialidades, titulos ou RQEs listados para esse profissional.\n\n' +
      'Responda SOMENTE com um objeto JSON valido, sem nenhum texto antes ou depois, sem bloco de markdown, ' +
      'exatamente no formato abaixo (use null, "" ou [] quando a informacao nao existir; nao invente valores):\n\n' +
      '{\n' +
      '  "nomeProfissional": "nome do profissional, como aparece na tela, ou null se nao aparecer",\n' +
      '  "numeroInscricao": "numero de inscricao/registro no conselho, como aparece na tela, ou null",\n' +
      '  "habilitacoes": ["lista com cada habilitacao/especialidade/titulo/RQE listado, uma string por item; array vazio se nao houver nenhuma listada"],\n' +
      '  "situacaoTexto": "texto literal da situacao do registro impresso na tela (ex: Ativo, Regular, Cancelado, Suspenso), ou vazio se nao houver texto de situacao explicito",\n' +
      '  "situacaoAtiva": true ou false - seu melhor julgamento sobre se o registro esta ativo/regular considerando apenas o que esta escrito na tela\n' +
      '}';

    const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1200,
        messages: [
          {
            role: 'user',
            content: [contentBlock, { type: 'text', text: instrucoes }],
          },
        ],
      }),
    });

    if (!anthropicResp.ok) {
      const errText = await anthropicResp.text();
      return res.status(502).json({ error: 'Erro ao consultar a IA.', debug: errText.slice(0, 500) });
    }

    const anthropicData = await anthropicResp.json();
    const textBlock = (anthropicData.content || []).find((b) => b.type === 'text');
    const raw = textBlock ? textBlock.text.trim() : '';

    let extraido;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      extraido = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch (parseErr) {
      return res.status(502).json({ error: 'Nao foi possivel interpretar a resposta da IA.', debug: raw.slice(0, 500) });
    }

    return res.status(200).json({ dados: extraido });
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno ao ler o print do conselho.', debug: String((err && err.message) || err) });
  }
};
