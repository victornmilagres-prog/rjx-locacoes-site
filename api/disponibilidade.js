// /api/disponibilidade.js — DEBUG BUILD, testing internal calendar endpoint

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
    throw new Error('Falha na autenticação com o EstoqueNOW');
  }
  const data = await resp.json();
  cachedToken = data.token;
  const expiresAt = data.expires ? Date.parse(data.expires.replace(' ', 'T') + 'Z') : NaN;
  cachedTokenExpiresAt = !isNaN(expiresAt) ? expiresAt - 60000 : now + 25 * 60 * 1000;
  return cachedToken;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const token = await getAccessToken(req.query && req.query.force === '1');

    const encId = req.query.encid;
    const sDate = req.query.sdate || '2026-06-30';
    const eDate = req.query.edate || '2026-07-31';
    const url = `https://web.estoquenow.com.br/inventory/ajax_data_calendar_item/${encodeURIComponent(encId)}?start_date=${sDate}&end_date=${eDate}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const contentType = resp.headers.get('content-type') || '';
    let raw;
    if (contentType.includes('json')) {
      raw = await resp.json();
    } else {
      raw = (await resp.text()).slice(0, 800);
    }
    return res.status(200).json({ url, status: resp.status, contentType, raw });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
};
