// /api/cadastro-cliente.js
// Vercel Serverless Function — cadastra um novo cliente no EstoqueNOW a partir do
// formulário "Seja Cliente" do site, e envia um e-mail automático para o setor
// comercial. Mantém client_id/client_secret e chaves de e-mail seguras no servidor.

let cachedToken = null;
let cachedTokenExpiresAt = 0;

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

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt) {
    return cachedToken;
  }
  const resp = await fetchWithRetry('https://api.estoquenow.com.br/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.ESTOQUENOW_CLIENT_ID,
      client_secret: process.env.ESTOQUENOW_CLIENT_SECRET,
    }),
  });
  if (!resp.ok) {
    throw new Error('Falha na autenticação com o EstoqueNOW');
  }
  const data = await resp.json();
  cachedToken = data.token;
  const expiresAt = data.expires ? Date.parse(data.expires.replace(' ', 'T') + 'Z') : NaN;
  cachedTokenExpiresAt = !isNaN(expiresAt) ? expiresAt - 60000 : now + 25 * 60 * 1000;
  return cachedToken;
}

function onlyDigits(str) {
  return String(str || '').replace(/\D/g, '');
}

function isValidEmail(str) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(str || ''));
}

// Envio de e-mail via Resend (https://resend.com). Requer a env var RESEND_API_KEY.
// Se não estiver configurada, o cadastro no EstoqueNOW ainda é concluído normalmente
// — apenas o e-mail automático é pulado (fail-safe, nunca quebra o cadastro do cliente).
async function sendCommercialEmail(payload) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.COMMERCIAL_EMAIL || 'comercial@rjxlocacoes.com.br';
  if (!apiKey) {
    console.warn('RESEND_API_KEY não configurada — pulando envio de e-mail.');
    return { sent: false, reason: 'missing_api_key' };
  }

  const html = `
    <h2>Novo cadastro pelo site — Seja Cliente</h2>
    <p><b>Clínica:</b> ${payload.clinica || '-'}</p>
    <p><b>Responsável:</b> ${payload.responsavel || '-'}</p>
    <p><b>CNPJ:</b> ${payload.cnpj || '-'}</p>
    <p><b>WhatsApp:</b> ${payload.whatsapp || '-'}</p>
    <p><b>E-mail:</b> ${payload.email || '-'}</p>
    <p><b>Equipamento de interesse:</b> ${payload.interesse || '-'}</p>
    <p><b>Mensagem:</b> ${payload.mensagem || '-'}</p>
    <hr>
    <p style="color:#7a4a15; background:#fbf3ec; padding:10px 14px; border-radius:6px;">
      Lembrete: como só atendemos profissionais da área da saúde, solicitar carteira do
      conselho ativa e alvará sanitário válido antes de finalizar o cadastro.
    </p>
  `;

  try {
    const resp = await fetchWithRetry('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'Rjx Locações <site@rjxlocacoes.com.br>',
        to: [to],
        subject: `Novo cadastro: ${payload.clinica || payload.responsavel || 'Cliente'}`,
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
  const clinica = String(body.clinica || '').trim();
  const responsavel = String(body.responsavel || '').trim();
  const cnpj = onlyDigits(body.cnpj);
  const whatsapp = String(body.whatsapp || '').trim();
  const email = String(body.email || '').trim();
  const interesse = String(body.interesse || '').trim();
  const mensagem = String(body.mensagem || '').trim();

  if (!clinica && !responsavel) {
    return res.status(400).json({ error: 'Informe o nome da clínica ou do responsável.' });
  }
  if (!whatsapp) {
    return res.status(400).json({ error: 'Informe um WhatsApp para contato.' });
  }
  if (email && !isValidEmail(email)) {
    return res.status(400).json({ error: 'E-mail inválido.' });
  }

  const observacoesParts = [];
  if (interesse) observacoesParts.push(`Equipamento de interesse: ${interesse}`);
  if (mensagem) observacoesParts.push(`Mensagem: ${mensagem}`);
  observacoesParts.push('Cadastro realizado via formulário do site (Seja Cliente).');

  const clientPayload = {
    name: clinica || responsavel,
    type: cnpj.length > 11 ? 'pj' : 'pf',
    phone: whatsapp,
    observations: observacoesParts.join(' | '),
  };
  if (cnpj) clientPayload.cpf_cnpj = cnpj;
  if (email) clientPayload.email = email;
  if (clinica && responsavel) {
    clientPayload.social_name = clinica;
    clientPayload.user_contact = responsavel;
  }

  let estoqueNowResult = { created: false };
  try {
    const token = await getAccessToken();
    const resp = await fetchWithRetry('https://api.estoquenow.com.br/v1/client', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(clientPayload),
    });
    const data = await resp.json().catch(() => ({}));

    if (resp.ok) {
      estoqueNowResult = { created: true, id: data && data.object && data.object.id };
    } else {
      console.warn('EstoqueNOW recusou o cadastro:', resp.status, data && data.message);
      estoqueNowResult = { created: false, status: resp.status, message: data && data.message, debug: data };
    }
  } catch (err) {
    console.error('cadastro-cliente handler error (EstoqueNOW):', err && err.message);
    estoqueNowResult = { created: false, error: true };
  }

  const emailResult = await sendCommercialEmail({ clinica, responsavel, cnpj: body.cnpj, whatsapp, email, interesse, mensagem });

  return res.status(200).json({
    success: true,
    estoqueNow: estoqueNowResult,
    email: emailResult,
  });
};
