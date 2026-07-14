// /api/disponibilidade.js
// Vercel Serverless Function — computes REAL day-by-day availability by reading
// actual rental orders from EstoqueNOW (the documented "availability" endpoints
// ignore date filters — this works around that by computing overlaps ourselves).

const ALLOWED_ITEMS = {
  criolipolise: { id: '2515213', label: 'Criolipólise · Criodermis 2.0' },
  endolaser:    { id: '1351370', label: 'Endolaser · Pioon' },
  lavieen:      { id: '2207555', label: 'Lavieen' },
  ultraformer:  { id: '2200560', label: 'Ultraformer MPT' },
};

const ACTIVE_STATUSES = '2,3,6,4,7';

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

function isValidMonth(str) {
  return /^\d{4}-\d{2}$/.test(str);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function toDDMMYYYY(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

async function fetchItemTotalQty(token, id) {
  const url = `https://api.estoquenow.com.br/v1/inventory/availability/item/${encodeURIComponent(id)}`;
  const resp = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return 1;
  const data = await resp.json();
  const n = Number(data && data.qtd);
  return isNaN(n) || n <= 0 ? 1 : n;
}

async function fetchOrdersInRange(token, startIso, endIso) {
  const params = [
    `start_date=${encodeURIComponent(toDDMMYYYY(startIso))}`,
    `end_date=${encodeURIComponent(toDDMMYYYY(endIso))}`,
    `period_type=delivery_date`,
    `status=${ACTIVE_STATUSES}`,
    `per_page=100`,
  ].join('&');
  const url = `https://api.estoquenow.com.br/v1/rental?${params}`;
  const resp = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data && data.data) || [];
}

async function fetchOrderDetail(token, id) {
  const url = `https://api.estoquenow.com.br/v1/rental/${encodeURIComponent(id)}`;
  const resp = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return null;
  return resp.json();
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
  const totalDaysInMonth = daysInMonth(year, mon);
  const monthStartIso = `${year}-${pad(mon)}-01`;
  const monthEndIso = `${year}-${pad(mon)}-${pad(totalDaysInMonth)}`;

  try {
    const token = await getAccessToken();

    const [totalQty, orders] = await Promise.all([
      fetchItemTotalQty(token, item.id),
      fetchOrdersInRange(token, monthStartIso, monthEndIso),
    ]);

    const BATCH_SIZE = 5;
    const details = [];
    for (let i = 0; i < orders.length; i += BATCH_SIZE) {
      const batch = orders.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map((o) => fetchOrderDetail(token, o.id)));
      details.push(...results);
      if (i + BATCH_SIZE < orders.length) await sleep(120);
    }

    const bookings = [];
    details.forEach((d) => {
      if (!d || !Array.isArray(d.logistics)) return;
      d.logistics.forEach((log) => {
        if (!Array.isArray(log.items)) return;
        log.items.forEach((it) => {
          if (String(it.item_id) !== String(item.id)) return;
          const start = log.delivery_date;
          const end = log.return_date || log.delivery_date;
          const qty = Number(it.qty) || 1;
          if (start) bookings.push({ start, end, qty });
        });
      });
    });

    const days = [];
    for (let d = 1; d <= totalDaysInMonth; d++) {
      const dateStr = `${year}-${pad(mon)}-${pad(d)}`;
      const bookedQty = bookings
        .filter((b) => dateStr >= b.start && dateStr <= b.end)
        .reduce((sum, b) => sum + b.qty, 0);
      const quantity = Math.max(totalQty - bookedQty, 0);
      days.push({ date: dateStr, quantity });
    }

    return res.status(200).json({ label: item.label, month, days });
  } catch (err) {
    console.error('disponibilidade handler error:', err && err.message, err && err.stack);
    return res.status(500).json({
      error: 'Não foi possível consultar a disponibilidade agora. Tente novamente em instantes ou fale com a gente pelo WhatsApp.',
    });
  }
};
