// Controle de Insumos: uma função só para todas as ações do servidor.
// O plano Hobby da Vercel aceita no máximo 12 funções em /api; por isso
// as ações ficam em api/_controle-insumos/ (pasta com "_" não vira função)
// e esta rota escolhe qual rodar pelo parâmetro "acao".
//   POST /api/controle-insumos?acao=excluir   (Yasmin exclui uma locação)
//   POST /api/controle-insumos?acao=concluir  (motorista conclui; total calculado aqui)

const excluir = require('./_controle-insumos/excluir.js');
const concluir = require('./_controle-insumos/concluir.js');

module.exports = async (req, res) => {
  const acao = String((req.query && req.query.acao) || (req.body && req.body.acao) || '');
  if (acao === 'excluir') return excluir(req, res);
  if (acao === 'concluir') return concluir(req, res);
  return res.status(400).json({ error: 'Ação inválida.' });
};
