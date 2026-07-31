// api/ler-disparo.js
// Lê o número de disparos ("Remain") na tela do Ultraformer MPT a partir de uma foto.
// Usa Claude Haiku (visão) via API da Anthropic. Requer a env var ANTHROPIC_API_KEY na Vercel.

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
        max_tokens: 50,
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
                  'Esta é uma foto da tela de um aparelho Ultraformer MPT. No canto superior esquerdo da tela ' +
                  'aparece o texto "Remain" e, logo abaixo, um número inteiro (o número de disparos restantes ' +
                  'no cartucho). Ignore todos os outros números da tela (Current, Total used, Length, Pitch, ' +
                  'Repeat, Memory, etc). Responda SOMENTE com o número inteiro que aparece abaixo de "Remain", ' +
                  'sem nenhum texto adicional, sem pontuação. Se não conseguir ler claramente, responda apenas: ERRO',
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
    const digits = raw.replace(/[^\d]/g, '');

    if (!digits || /ERRO/i.test(raw)) {
      res.status(200).json({ valor: null });
      return;
    }

    res.status(200).json({ valor: parseInt(digits, 10) });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
}
