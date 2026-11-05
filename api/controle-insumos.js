// Controle de Insumos: uma função só para todas as ações do servidor.
// O plano Hobby da Vercel aceita no máximo 12 funções em /api; por isso
// as ações ficam em api/_controle-insumos/ (pasta com "_" não vira função)
// e esta rota escolhe qual rodar pelo parâmetro "acao".
//   POST /api/controle-insumos?acao=excluir   (Yasmin exclui uma locação)
//   POST /api/controle-insumos?acao=concluir  (motorista conclui; total calculado aqui)
//   GET  /api/controle-insumos?acao=limpar    (agendamento diário: fotos e assinaturas após 30 dias)

const excluir = require('./_controle-insumos/excluir.js');
const concluir = require('./_controle-insumos/concluir.js');
const limpar = require('./_controle-insumos/limpar.js');

module.exports = async (req, res) => {
  const acao = String((req.query && req.query.acao) || (req.body && req.body.acao) || '');
  if (acao === 'excluir') return excluir(req, res);
  if (acao === 'concluir') return concluir(req, res);
  if (acao === 'limpar') return limpar(req, res);
  return res.status(400).json({ error: 'Ação inválida.' });
};
