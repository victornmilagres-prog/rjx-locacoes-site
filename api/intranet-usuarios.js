// Gestao de usuarios da Intranet RJX
// Usa a service_role key no servidor - nunca expor no cliente.
// TEMPORARIO: liberado para qualquer usuario ativo enquanto ajustamos o controle de acesso do papel Gerencial.
// DEBUG TEMPORARIO: retorna detalhes do erro para diagnostico.

module.exports = async (req, res) => {
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function getCallerPapel(token) {
if (!token) return { papel: null, debug: 'no token' };
const userResp = await fetch(SUPABASE_URL + '/auth/v1/user', {
headers: { Authorization: 'Bearer ' + token, apikey: SERVICE_KEY }
});
if (!userResp.ok) {
const errText = await userResp.text();
return { papel: null, debug: 'userResp not ok: status=' + userResp.status + ' body=' + errText.slice(0,200) + ' keyLen=' + (SERVICE_KEY ? SERVICE_KEY.length : 0) + ' urlSet=' + (!!SUPABASE_URL) };
}
const user = await userResp.json();
const rowResp = await fetch(SUPABASE_URL + '/rest/v1/usuarios?id=eq.' + user.id + '&select=papel,ativo', {
headers: { Authorization: 'Bearer ' + SERVICE_KEY, apikey: SERVICE_KEY }
});
if (!rowResp.ok) {
const errText = await rowResp.text();
return { papel: null, debug: 'rowResp not ok: status=' + rowResp.status + ' body=' + errText.slice(0,200) };
}
const rows = await rowResp.json();
if (!Array.isArray(rows) || !rows.length) {
return { papel: null, debug: 'no rows for user.id=' + user.id };
}
return { papel: rows[0].ativo ? rows[0].papel : null, debug: 'ok ativo=' + rows[0].ativo + ' papel=' + rows[0].papel };
}

try {
const authHeader = req.headers.authorization || '';
const token = authHeader.replace('Bearer ', '');
const result = await getCallerPapel(token);
if (!result.papel) {
return res.status(403).json({ error: 'Usuario nao encontrado ou inativo.', debug: result.debug });
}
const papel = result.papel;

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
let newId = inviteData.id;
let linkManual = null;
if (!inviteResp.ok) {
const msgErro = inviteData.msg || inviteData.error_description || inviteData.message || '';
const ehRateLimit = inviteResp.status === 429 || /rate limit/i.test(msgErro) || /already.*registered|already.*exists/i.test(msgErro);
if (!ehRateLimit) {
return res.status(400).json({ error: msgErro || 'Falha ao convidar usuario.' });
}
const linkResp = await fetch(SUPABASE_URL + '/auth/v1/admin/generate_link', {
method: 'POST',
headers: {
Authorization: 'Bearer ' + SERVICE_KEY,
apikey: SERVICE_KEY,
'Content-Type': 'application/json'
},
body: JSON.stringify({ type: 'invite', email: email, redirect_to: redirectTo })
});
const linkData = await linkResp.json();
if (!linkResp.ok) {
return res.status(400).json({ error: linkData.msg || linkData.error_description || linkData.message || 'Limite de e-mail atingido e nao foi possivel gerar o link manual.' });
}
newId = linkData.id || (linkData.user && linkData.user.id);
linkManual = linkData.action_link || (linkData.properties && linkData.properties.action_link) || null;
}
const insertResp = await fetch(SUPABASE_URL + '/rest/v1/usuarios', {
method: 'POST',
headers: {
Authorization: 'Bearer ' + SERVICE_KEY,
apikey: SERVICE_KEY,
'Content-Type': 'application/json',
Prefer: 'return=representation,resolution=merge-duplicates'
},
body: JSON.stringify({ id: newId, nome, email, papel: novoPapel, ativo: true })
});
const insertData = await insertResp.json();
if (!insertResp.ok) {
return res.status(400).json({ error: insertData.message || 'Falha ao salvar usuario.' });
}
return res.status(200).json({ usuario: insertData[0], linkManual: linkManual });
}

if (req.method === 'PATCH') {
const body = req.body || {};
const id = body.id;
if (!id) return res.status(400).json({ error: 'ID obrigatorio.' });
const patchBody = {};
if (typeof body.ativo === 'boolean') patchBody.ativo = body.ativo;
if (body.papel) patchBody.papel = body.papel;
if (body.nome) patchBody.nome = body.nome;
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

if (req.method === 'DELETE') {
const body = req.body || {};
const id = body.id;
if (!id) return res.status(400).json({ error: 'ID obrigatorio.' });
const delAuth = await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + id, {
method: 'DELETE',
headers: {
Authorization: 'Bearer ' + SERVICE_KEY,
apikey: SERVICE_KEY
}
});
if (!delAuth.ok && delAuth.status !== 404) {
const delAuthData = await delAuth.json().catch(function(){ return {}; });
return res.status(400).json({ error: delAuthData.msg || delAuthData.error_description || delAuthData.message || 'Falha ao excluir usuario do auth.' });
}
const delRow = await fetch(SUPABASE_URL + '/rest/v1/usuarios?id=eq.' + id, {
method: 'DELETE',
headers: {
Authorization: 'Bearer ' + SERVICE_KEY,
apikey: SERVICE_KEY
}
});
if (!delRow.ok) {
return res.status(400).json({ error: 'Falha ao excluir registro do usuario.' });
}
return res.status(200).json({ ok: true });
}
return res.status(405).json({ error: 'Metodo nao permitido.' });
} catch (err) {
return res.status(500).json({ error: err.message || 'Erro interno.' });
}
};
