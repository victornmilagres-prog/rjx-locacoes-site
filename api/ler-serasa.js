// api/ler-serasa.js
// Le um relatorio de credito da Serasa (PDF anexado no Cadastro de Cliente) e extrai
// os dados estruturados via IA (Claude, com leitura de documento/visao).
// Requer a env var ANTHROPIC_API_KEY na Vercel (a mesma ja usada em /api/ler-disparo.js).

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

    const instrucoes =
      'Voce recebeu um relatorio de credito da Serasa Experian (solucao "Decisao Completa"), de uma ' +
      'pessoa fisica (CPF) ou empresa (CNPJ). Leia o documento inteiro, incluindo graficos e imagens ' +
      '(o numero do Serasa Score aparece IMPRESSO no centro de um grafico tipo velocimetro/gauge em uma ' +
      'das paginas - esse numero NAO existe como texto selecionavel, entao voce precisa ler visualmente ' +
      'o numero desenhado ali; nao deixe de extrai-lo).\n\n' +
      'Responda SOMENTE com um objeto JSON valido, sem nenhum texto antes ou depois, sem bloco de ' +
      'markdown, exatamente no formato abaixo (adapte PF/PJ conforme o documento; use null ou "" quando ' +
      'a informacao nao existir; nao invente valores):\n\n' +
      '{\n' +
      '  "tipo": "PF" ou "PJ",\n' +
      '  "nome": "nome completo ou razao social exatamente como aparece",\n' +
      '  "documento": "CPF ou CNPJ formatado como aparece no documento",\n' +
      '  "situacaoAtiva": true ou false (situacao cadastral regular/ativa = true; irregular/cancelada/suspensa = false),\n' +
      '  "situacaoTexto": "texto literal da situacao cadastral, ex: ATIVA",\n' +
      '  "indicativoRisco": "texto literal, ex: Baixo risco",\n' +
      '  "recomendacaoNegativa": true ou false (recomendacao positiva = false; negativa ou analise manual/sem recomendacao = true),\n' +
      '  "score": numero inteiro de 0 a 1000 lido do grafico, ou null se realmente nao for possivel ler,\n' +
      '  "rendaOuFaturamento": "texto literal da renda estimada (PF) ou faturamento estimado (PJ)",\n' +
      '  "limiteSugerido": "texto literal do limite mensal sugerido",\n' +
      '  "endereco": "endereco completo da pessoa ou empresa, com cidade e UF",\n' +
      '  "fundacao": "data de fundacao da empresa, formato dd/mm/aaaa (PJ) ou vazio (PF)",\n' +
      '  "capitalSocial": "capital social formatado (PJ) ou vazio (PF)",\n' +
      '  "pendenciasPrincipal": [\n' +
      '    { "tipo": "REFIN|PEFIN|CONVEM|Protesto nacional|Cheques devolvidos", "origem": "credor/origem", "data": "dd/mm/aaaa", "valor": "R$ 0,00" }\n' +
      '  ],\n' +
      '  "socio": null ou {\n' +
      '    "nome": "nome do socio",\n' +
      '    "cpf": "CPF do socio formatado",\n' +
      '    "vinculo": "texto literal, ex: Socio(a) / Administrador(a)",\n' +
      '    "participacao": "percentual formatado, ex: 100%",\n' +
      '    "endereco": "endereco do socio",\n' +
      '    "pendencias": [\n' +
      '      { "tipo": "Pefin|Refin|Protesto|Cheque sustado|Cheque sem fundo|Acao judicial|Dividas vencidas|Participacao em falencia", "valor": "R$ 0,00" }\n' +
      '    ]\n' +
      '  }\n' +
      '}\n\n' +
      'Regras importantes:\n' +
      '- "pendenciasPrincipal" e a lista de ocorrencias da PESSOA ou EMPRESA titular do relatorio (nao do ' +
      'socio). Se um tipo mostrar "Nao constam ocorrencias", nao inclua nenhuma linha desse tipo na lista.\n' +
      '- "socio.pendencias" so deve conter os tipos onde o valor NAO for "Nada consta". Se todos forem ' +
      '"Nada consta", retorne pendencias como uma lista vazia.\n' +
      '- Se o documento for de pessoa fisica (CPF), "socio" deve ser null.\n' +
      '- Copie textos (nomes, valores, datas) exatamente como aparecem, sem corrigir ou formatar diferente do original.';

    const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 2000,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', media_type: mimeType, data: pdfBase64 } },
              { type: 'text', text: instrucoes },
            ],
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
    return res.status(500).json({ error: 'Erro interno ao ler o relatorio.', debug: String((err && err.message) || err) });
  }
};
