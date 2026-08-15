// Gestao de usuarios da Intranet RJX
// Usa a service_role key no servidor - nunca expor no cliente.
// TEMPORARIO: liberado para qualquer usuario ativo enquanto ajustamos o controle de acesso do papel Gerencial.

module.exports = async (req, res) => {
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function getCallerPapel(token) {
if (!token) return null;
const userResp = await fetch(SUPABASE_URL + '/auth/v1/user', {
headers: { Authorization: 'Bearer ' + token, apikey: SERVICE_KEY }
});
if (!userResp.ok) return null;
const user = await userResp.json();
const rowResp = await fetch(SUPABASE_URL + '/rest/v1/usuarios?id=eq.' + user.id + '&select=papel,ativo', {
headers: { Authorization: 'Bearer ' + SERVICE_KEY, apikey: SERVICE_KEY }
});
const rows = await rowResp.json();
if (!Array.isArray(rows) || !rows.length) return null;
return rows[0].ativo ? rows[0].papel : null;
}

try {
const authHeader = req.headers.authorization || '';
const token = authHeader.replace('Bearer ', '');
const papel = await getCallerPapel(token);
if (!papel) {
return res.status(403).json({ error: 'Usuario nao encontrado ou inativo.' });
}

if (req.method === 'GET') {
const r = await fetch(SUPABASE_URL + '/rest/v1/usuarios?select=id,nome,email,papel,ativo,created_at&order=created_at.desc', {
headers: { Authorization: 'Bearer ' + SERVICE_KEY, apikey: SERVICE_KEY }
});
const data = await r.json();
return res.status(200).json({ usuarios: data });
}

if (req.method === 'POST') {
const body = req.body || {};
const nome = body.nome;
const email = body.email;
const novoPapel = body.papel;
if (!nome || !email || !novoPapel) {
return res.status(400).json({ error: 'Preencha nome, e-mail e papel.' });
}
const redirectTo = 'https://rjxlocacoes.com.br/intranet.html';
const inviteResp = await fetch(SUPABASE_URL + '/auth/v1/invite?redirect_to=' + encodeURIComponent(redirectTo), {
method: 'POST',
headers: {
Authorization: 'Bearer ' + SERVICE_KEY,
apikey: SERVICE_KEY,
'Content-Type': 'application/json'
},
body: JSON.stringify({ email })
});
const inviteData = await inviteResp.json();
if (!inviteResp.ok) {
return res.status(400).json({ error: inviteData.msg || inviteData.error_description || inviteData.message || 'Falha ao convidar usuario.' });
}
const newId = inviteData.id;
const insertResp = await fetch(SUPABASE_URL + '/rest/v1/usuarios', {
method: 'POST',
headers: {
Authorization: 'Bearer ' + SERVICE_KEY,
apikey: SERVICE_KEY,
'Content-Type': 'application/json',
Prefer: 'return=representation'
},
body: JSON.stringify({ id: newId, nome, email, papel: novoPapel, ativo: true })
});
const insertData = await insertResp.json();
if (!insertResp.ok) {
return res.status(400).json({ error: insertData.message || 'Falha ao salvar usuario.' });
}
return res.status(200).json({ usuario: insertData[0] });
}

if (req.method === 'PATCH') {
const body = req.body || {};
const id = body.id;
if (!id) return res.status(400).json({ error: 'ID obrigatorio.' });
const patchBody = {};
if (typeof body.ativo === 'boolean') patchBody.ativo = body.ativo;
if (body.papel) patchBody.papel = body.papel;
const r = await fetch(SUPABASE_URL + '/rest/v1/usuarios?id=eq.' + id, {
method: 'PATCH',
headers: {
Authorization: 'Bearer ' + SERVICE_KEY,
apikey: SERVICE_KEY,
'Content-Type': 'application/json',
Prefer: 'return=representation'
},
body: JSON.stringify(patchBody)
});
const data = await r.json();
if (!r.ok) return res.status(400).json({ error: data.message || 'Falha ao atualizar.' });
return res.status(200).json({ usuario: data[0] });
}

return res.status(405).json({ error: 'Metodo nao permitido.' });
} catch (err) {
return res.status(500).json({ error: err.message || 'Erro interno.' });
}
};
