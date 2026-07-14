let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken() {
  const resp = await fetch('https://api.estoquenow.com.br/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.ESTOQUENOW_CLIENT_ID,
      client_secret: process.env.ESTOQUENOW_CLIENT_SECRET,
    }),
  });
  const data = await resp.json();
  return data.token;
}

module.exports = async (req, res) => {
  try {
    const token = await getAccessToken();
    const params = 'start_date=01%2F07%2F2026&end_date=31%2F07%2F2026&period_type=delivery_date&status=2,3,6,4,7&per_page=100';
    const url = `https://api.estoquenow.com.br/v1/rental?${params}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await resp.json();
    const orders = (data && data.data) || [];
    let detail = null;
    if (req.query.rid) {
      const dresp = await fetch(`https://api.estoquenow.com.br/v1/rental/${req.query.rid}`, { headers: { Authorization: `Bearer ${token}` } });
      detail = await dresp.json();
    }
    return res.status(200).json({ count: orders.length, ids: orders.map(o=>o.id), sample: orders.slice(0,3), detail });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
};
