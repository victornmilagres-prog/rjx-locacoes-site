// /api/disponibilidade.js — DEBUG BUILD (rental detail test)

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
    const token = await getAccessToken();
    const rid = req.query.rid || '5673444';
    const url = `https://api.estoquenow.com.br/v1/rental/${encodeURIComponent(rid)}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const raw = await resp.json();
    return res.status(200).json({ url, status: resp.status, raw });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
};
