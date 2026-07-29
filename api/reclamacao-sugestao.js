// /api/reclamacao-sugestao.js
// Vercel Serverless Function — recebe o formulário "Reclamação e Sugestão" do site
// e envia um e-mail automático para o setor comercial via Resend. Diferente do
// cadastro-cliente, aqui não há nenhuma integração com o EstoqueNOW — é só o
// envio do e-mail com os dados da mensagem.

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchWithRetry(url, options, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, options);
      if (resp.status >= 500 && attempt < retries) {
        await sleep(300 * (attempt + 1));
        continue;
      }
      return resp;
    } catch (err) {
      if (attempt < retries) {
        await sleep(300 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

function isValidEmail(str) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(str || ''));
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Envio de e-mail via Resend (https://resend.com). Requer a env var RESEND_API_KEY.
async function sendCommercialEmail(payload) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.COMMERCIAL_EMAIL || 'rjxlocacoes@gmail.com';
  if (!apiKey) {
    console.warn('RESEND_API_KEY não configurada — não foi possível enviar o e-mail.');
    return { sent: false, reason: 'missing_api_key' };
  }

  const html = `
    <h2>Nova mensagem pelo site — Reclamação/Sugestão</h2>
    <p><b>Tipo:</b> ${escapeHtml(payload.tipo)}</p>
    <p><b>Nome:</b> ${escapeHtml(payload.nome)}</p>
    <p><b>CPF/CNPJ:</b> ${escapeHtml(payload.cpfcnpj)}</p>
    <p><b>Clínica:</b> ${escapeHtml(payload.clinica)}</p>
    <p><b>Telefone/WhatsApp:</b> ${escapeHtml(payload.telefone)}</p>
    <p><b>E-mail:</b> ${escapeHtml(payload.email)}</p>
    <p><b>Mensagem:</b></p>
    <p>${escapeHtml(payload.mensagem).replace(/\n/g, '<br>')}</p>
  `;

  try {
    const resp = await fetchWithRetry('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'Rjx Locações <onboarding@resend.dev>',
        to: [to],
        reply_to: isValidEmail(payload.email) ? payload.email : undefined,
        subject: `${payload.tipo || 'Mensagem'} via site — ${payload.nome || 'Cliente'}`,
        html,
      }),
    });
    return { sent: resp.ok };
  } catch (err) {
    console.error('Falha ao enviar e-mail via Resend:', err && err.message);
    return { sent: false, reason: 'send_error' };
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  const body = req.body || {};
  const nome = String(body.nome || '').trim();
  const cpfcnpj = String(body.cpfcnpj || '').trim();
  const clinica = String(body.clinica || '').trim();
  const telefone = String(body.telefone || '').trim();
  const email = String(body.email || '').trim();
  const tipo = String(body.tipo || '').trim();
  const mensagem = String(body.mensagem || '').trim();

  if (!nome) {
    return res.status(400).json({ error: 'Informe seu nome.' });
  }
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'Informe um e-mail válido.' });
  }
  if (!tipo) {
    return res.status(400).json({ error: 'Selecione o tipo de mensagem.' });
  }
  if (!mensagem) {
    return res.status(400).json({ error: 'Descreva sua mensagem.' });
  }

  const emailResult = await sendCommercialEmail({ nome, cpfcnpj, clinica, telefone, email, tipo, mensagem });

  if (!emailResult.sent) {
    return res.status(502).json({ error: 'Não foi possível enviar sua mensagem agora. Tente novamente em instantes ou fale conosco no WhatsApp.' });
  }

  return res.status(200).json({ success: true, email: emailResult });
};
