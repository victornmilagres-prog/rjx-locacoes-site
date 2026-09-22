// /api/sync-disparos-estoquenow.js
// Vercel Serverless Function — sincroniza "disparos comprados" de cada cartucho
// cadastrado na intranet com a "Quantidade em Estoque" do item correspondente no
// Estoque Now (identificado pelo campo codigo_estoquenow = cod do item lá).
// Chamada manualmente pelo botao "Atualizar disparos" na intranet, e automaticamente
// todo fim de dia via Vercel Cron (ver vercel.json). Mantem client_id/client_secret e
// a service role key do Supabase seguros no servidor.

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

async function getEstoqueNowToken() {
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
    throw new Error('Falha na autenticação com o Estoque Now');
  }
  const data = await resp.json();
  cachedToken = data.token;
  const expiresAt = data.expires ? Date.parse(data.expires.replace(' ', 'T') + 'Z') : NaN;
  cachedTokenExpiresAt = !isNaN(expiresAt) ? expiresAt - 60000 : now + 25 * 60 * 1000;
  return cachedToken;
}

async function buscarItemPorCodigo(token, codigo) {
  const url = `https://api.estoquenow.com.br/v1/inventory?search=${encodeURIComponent(codigo)}&per_page=20`;
  const resp = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return null;
  const data = await resp.json();
  const lista = (data && data.data) || [];
  const exato = lista.find((it) => String(it.cod) === String(codigo));
  return exato || null;
}

async function getCallerPapel(SUPABASE_URL, SERVICE_KEY, token) {
  if (!token) return null;
  const userResp = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { Authorization: 'Bearer ' + token, apikey: SERVICE_KEY },
  });
  if (!userResp.ok) return null;
  const user = await userResp.json();
  const rowResp = await fetch(
    SUPABASE_URL + '/rest/v1/usuarios?id=eq.' + user.id + '&select=papel,ativo',
    { headers: { Authorization: 'Bearer ' + SERVICE_KEY, apikey: SERVICE_KEY } }
  );
  if (!rowResp.ok) return null;
  const rows = await rowResp.json();
  if (!Array.isArray(rows) || !rows.length || !rows[0].ativo) return null;
  return rows[0].papel;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Autoriza: chamada agendada pela Vercel Cron (Authorization: Bearer CRON_SECRET)
  // OU um usuario logado com papel operacional/gerencial (botao manual na intranet).
  const authHeader = req.headers.authorization || '';
  const isCron = process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;
  let autorizado = isCron;
  if (!autorizado) {
    const token = authHeader.replace('Bearer ', '');
    const papel = await getCallerPapel(SUPABASE_URL, SERVICE_KEY, token);
    autorizado = papel === 'operacional' || papel === 'gerencial';
  }
  if (!autorizado) {
    return res.status(401).json({ error: 'Não autorizado.' });
  }

  try {
    const listResp = await fetch(
      SUPABASE_URL + '/rest/v1/cartuchos?codigo_estoquenow=not.is.null&descartado=eq.false&select=id,codigo_estoquenow',
      { headers: { Authorization: 'Bearer ' + SERVICE_KEY, apikey: SERVICE_KEY } }
    );
    if (!listResp.ok) throw new Error('Falha ao ler cartuchos no Supabase');
    const cartuchos = await listResp.json();

    if (!cartuchos.length) {
      return res.status(200).json({ atualizados: 0, mensagem: 'Nenhum cartucho com código do Estoque Now cadastrado.' });
    }

    const token = await getEstoqueNowToken();

    // Cache por codigo, ja que varias unidades fisicas podem compartilhar o mesmo codigo.
    const cacheItens = {};
    let atualizados = 0;
    const erros = [];

    for (const c of cartuchos) {
      const codigo = c.codigo_estoquenow;
      if (!(codigo in cacheItens)) {
        try {
          cacheItens[codigo] = await buscarItemPorCodigo(token, codigo);
        } catch (e) {
          cacheItens[codigo] = null;
        }
        await sleep(150);
      }
      const item = cacheItens[codigo];
      if (!item || item.qtd == null) {
        erros.push(codigo);
        continue;
      }
      const updResp = await fetch(
        SUPABASE_URL + '/rest/v1/cartuchos?id=eq.' + c.id,
        {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer ' + SERVICE_KEY,
            apikey: SERVICE_KEY,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({
            disparos_total: Math.round(Number(item.qtd)),
            disparos_atualizado_em: new Date().toISOString(),
          }),
        }
      );
      if (updResp.ok) atualizados++;
      else erros.push(codigo);
    }

    return res.status(200).json({ atualizados, total: cartuchos.length, codigosSemMatch: erros });
  } catch (err) {
    console.error('sync-disparos-estoquenow error:', err && err.message, err && err.stack);
    return res.status(500).json({ error: 'Não foi possível sincronizar com o Estoque Now agora.' });
  }
};
