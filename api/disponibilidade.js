// /api/disponibilidade.js
// Vercel Serverless Function — proxies availability queries to the EstoqueNOW API,
// keeping the client_id/client_secret safely on the server. Never exposed to the browser.

const ALLOWED_ITEMS = {
  criolipolise: { id: '2515213', cod: '000044', label: 'Criolipólise · Criodermis 2.0' },
  endolaser:    { id: '1351370', cod: '000001', label: 'Endolaser · Pioon' },
  lavieen:      { id: '2207555', cod: '000016', label: 'Lavieen' },
  ultraformer:  { id: '2200560', cod: '000015', label: 'Ultraformer MPT' },
};

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken(force) {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt && !force) {
    return cachedToken;
  }
  const resp = await fetch('https://api.estoquenow.com.br/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.ESTOQUENOW_CLIENT_ID,
      client_secret: process.env.ESTOQUENOW_CLIENT_SECRET,
    }),
  });
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    console.error('EstoqueNOW token error', resp.status, bodyText);
    throw new Error('Falha na autenticação com o EstoqueNOW');
  }
  const data = await resp.json();
  cachedToken = data.token;
  const expiresAt = data.expires ? Date.parse(data.expires.replace(' ', 'T') + 'Z') : NaN;
  cachedTokenExpiresAt = !isNaN(expiresAt) ? expiresAt - 60000 : now + 25 * 60 * 1000;
  return cachedToken;
}

function isValidMonth(str) {
  return /^\d{4}-\d{2}$/.test(str);
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function pad(n) {
  return String(n).padStart(2, '0');
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const { equipamento, month } = req.query || {};

  const item = ALLOWED_ITEMS[equipamento];

  try {
    const token = await getAccessToken(req.query && req.query.force === '1');

    if (req.query && req.query.debug === '2') {
      const rentalId = req.query.rid;
      if (rentalId) {
        const url = `https://api.estoquenow.com.br/v1/rental/${encodeURIComponent(rentalId)}`;
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        const raw = await resp.json();
        return res.status(200).json({ debug: 2, mode: 'rental-detail', status: resp.status, raw });
      }
      const rawQs = req.query.qs || '';
      const url = `https://api.estoquenow.com.br/v1/rental?${rawQs}`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const raw = await resp.json();
      return res.status(200).json({ debug: 2, mode: 'rental-list', url, status: resp.status, raw });
    }

    if (!item) {
      return res.status(400).json({ error: 'Equipamento inválido.' });
    }
    if (!month || !isValidMonth(month)) {
      return res.status(400).json({ error: 'Informe o mês no formato AAAA-MM.' });
    }

    return res.status(200).json({ label: item.label, month, days: [] });
  } catch (err) {
    console.error('disponibilidade handler error:', err && err.message, err && err.stack);
    return res.status(500).json({
      error: 'Não foi possível consultar a disponibilidade agora. Tente novamente em instantes ou fale com a gente pelo WhatsApp.',
    });
  }
};
