// api/validar-selfie.js
// Valida a selfie de uniforme do motorista (Campanha de Premiação — Transportes).
// Usa Claude Haiku (visão) via API da Anthropic. Requer a env var ANTHROPIC_API_KEY na Vercel
// (a mesma já configurada para /api/ler-disparo.js).

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { image } = req.body || {};
    if (!image || typeof image !== 'string') {
      res.status(400).json({ error: 'Imagem ausente' });
      return;
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada' });
      return;
    }

    const match = image.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
    if (!match) {
      res.status(400).json({ error: 'Formato de imagem inválido' });
      return;
    }
    const mediaType = match[1];
    const base64Data = match[2];

    const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: base64Data },
              },
              {
                type: 'text',
                text:
                  'Esta é uma selfie enviada por um motorista da RJX Locações para confirmar que está de uniforme ' +
                  'antes de uma entrega. O uniforme da RJX é uma camisa polo na cor cinza ou preta, com a logo da ' +
                  'empresa bordada no peito: as letras "RJX" em preto com dois pequenos triângulos vermelhos entre ' +
                  'as letras, e "LOCAÇÕES" escrito menor logo abaixo. A logo bordada costuma ser pequena e discreta ' +
                  '(nem sempre totalmente legível na foto).\n\n' +
                  'Avalie a imagem e responda SOMENTE em JSON válido, sem texto antes ou depois, no formato:\n' +
                  '{"pessoa_visivel": true|false, "veste_polo": true|false, "cor_compativel": true|false, ' +
                  '"logo_visivel": true|false|null, "aprovado": true|false, "motivo": "explicação curta em português"}\n\n' +
                  'Regras: "pessoa_visivel" = há claramente uma pessoa na foto (não é foto de tela, objeto, ' +
                  'ambiente vazio, foto antiga em outra foto, etc). "veste_polo" = a pessoa está vestindo uma ' +
                  'camisa polo (gola com botões). "cor_compativel" = a cor da peça é cinza ou preta. ' +
                  '"logo_visivel" = use null se não for possível avaliar (ex: logo fora de quadro ou foto de longe), ' +
                  'true se a logo bordada da RJX está visível e bate com a descrição, false se há uma logo visível ' +
                  'mas claramente diferente. "aprovado" = true somente se pessoa_visivel, veste_polo e ' +
                  'cor_compativel forem todos true, E logo_visivel não for false (ou seja, aprova com logo ' +
                  'confirmada OU não avaliável, mas nunca com logo claramente errada).',
              },
            ],
          },
        ],
      }),
    });

    if (!anthropicResp.ok) {
      res.status(502).json({ error: 'Falha ao consultar IA' });
      return;
    }

    const data = await anthropicResp.json();
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    const raw = textBlock ? textBlock.text.trim() : '';

    let parsed;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch (e) {
      res.status(200).json({
        aprovado: false,
        motivo: 'Não foi possível interpretar a resposta da IA — envie novamente.',
      });
      return;
    }

    res.status(200).json({
      pessoa_visivel: !!parsed.pessoa_visivel,
      veste_polo: !!parsed.veste_polo,
      cor_compativel: !!parsed.cor_compativel,
      logo_visivel: parsed.logo_visivel === null ? null : !!parsed.logo_visivel,
      aprovado: !!parsed.aprovado,
      motivo: typeof parsed.motivo === 'string' ? parsed.motivo : '',
    });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
}
