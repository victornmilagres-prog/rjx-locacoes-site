// /api/disponibilidade.js
// Vercel Serverless Function — proxies availability queries to the EstoqueNOW API,
// keeping the client_id/client_secret safely on the server. Never exposed to the browser.
//
// Returns day-by-day availability for a given month, so the frontend can render an
// actual calendar (like the "ver calendário" view inside EstoqueNOW itself).

const ALLOWED_ITEMS = {
  criolipolise: { cod: '000044', label: 'Criolipólise · Criodermis 2.0' },
  endolaser:    { cod: '000001', label: 'Endolaser · Pioon' },
  lavieen:      { cod: '000016', label: 'Lavieen' },
  ultraformer:  { cod: '000015', label: 'Ultraformer MPT' },
};

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt) {
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
    throw new Error('Falha na autenticação com o EstoqueNOW: ' + resp.status + ' ' + bodyText);
  }
  const data = await resp.json();
  cachedToken = data.access_token;
  cachedTokenExpiresAt = now + Math.max((data.expires_in || 1500) - 60, 60) * 1000;
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

function extractQuantity(raw) {
  const candidates = ['quantity', 'qty', 'quantidade', 'available_quantity', 'estoque', 'stock'];
  for (const key of candidates) {
    if (raw && typeof raw[key] === 'number') return raw[key];
  }
  return null;
}

async function fetchDay(token, cod, dateStr) {
  const url = `https://api.estoquenow.com.br/v1/inventory/availability?cod=${encodeURIComponent(cod)}&start_date=${dateStr}&end_date=${dateStr}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return { date: dateStr, quantity: null, _status: resp.status };
  const data = await resp.json();
  return { date: dateStr, quantity: extractQuantity(data), _raw: data };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const { equipamento, month } = req.query || {};

  const item = ALLOWED_ITEMS[equipamento];
  if (!item) {
    return res.status(400).json({ error: 'Equipamento inválido.' });
  }
  if (!month || !isValidMonth(month)) {
    return res.status(400).json({ error: 'Informe o mês no formato AAAA-MM.' });
  }

  const [year, mon] = month.split('-').map(Number);
  const totalDays = daysInMonth(year, mon);
  const dates = [];
  for (let d = 1; d <= totalDays; d++) {
    dates.push(`${year}-${pad(mon)}-${pad(d)}`);
  }

  try {
    const token = await getAccessToken();

    if (req.query && req.query.debug === '1') {
      const single = await fetchDay(token, item.cod, dates[0]);
      return res.status(200).json({ debug: true, sample: single });
    }

    const BATCH_SIZE = 8;
    const days = [];
    for (let i = 0; i < dates.length; i += BATCH_SIZE) {
      const batch = dates.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map((d) => fetchDay(token, item.cod, d)));
      days.push(...results);
    }

    return res.status(200).json({ label: item.label, month, days });
  } catch (err) {
    console.error('disponibilidade handler error:', err && err.message, err && err.stack);
    return res.status(500).json({
      error: 'Não foi possível consultar a disponibilidade agora. Tente novamente em instantes ou fale com a gente pelo WhatsApp.',
    });
  }
};
