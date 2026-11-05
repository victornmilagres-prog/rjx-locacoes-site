-- =====================================================================
-- Controle de Insumos v2 - TESTE DE PERMISSOES
-- Simula a Yasmin e dois motoristas falando direto com o banco, como se
-- fosse pelo navegador. Cria a locacao TESTE-PERMISSAO, testa 21
-- situacoes e apaga a locacao no final.
--
-- O que ele usa:
--   * controle_locacoes: cria e apaga so a locacao TESTE-PERMISSAO.
--   * usuarios: so LEITURA, para escolher 1 comercial e 2 motoristas.
--   * storage.objects: so LEITURA, para conferir que nao ha arquivo.
--   * ci_teste e funcoes pg_temp: temporarias, somem ao fechar a sessao.
-- Nenhum arquivo e enviado ao bucket.
-- =====================================================================

create temp table if not exists ci_teste (
  n int, situacao text, esperado text, resultado text, ok boolean
);
truncate ci_teste;

-- Roda um comando como um usuario logado e registra o resultado.
create or replace function pg_temp.tenta(p_n int, p_sit text, p_quem uuid, p_sql text, p_esp text)
returns void
language plpgsql as $f$
declare v_n int; r text;
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_quem, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    execute p_sql;
    get diagnostics v_n = row_count;
    r := case when v_n > 0 then 'executou (' || v_n || ' linha)' else 'bloqueado (0 linhas)' end;
  exception when others then
    r := 'bloqueado: ' || sqlerrm;
  end;
  reset role;
  insert into ci_teste values (p_n, p_sit, p_esp, r,
    case p_esp when 'permitir' then r like 'executou%' else r like 'bloqueado%' end);
end
$f$;

do $$
declare
  v_com uuid; v_m1 uuid; v_m2 uuid; v_id uuid; v_n int;
  q text := 'update public.controle_locacoes set %s where id = %L';
begin
  if exists (select 1 from public.controle_locacoes where numero = 'TESTE-PERMISSAO') then
    raise exception 'Ja existe uma locacao TESTE-PERMISSAO. Nada foi feito.';
  end if;

  select id into v_com from public.usuarios
   where papel in ('comercial', 'gerencial') and ativo order by (papel = 'comercial') desc, nome limit 1;
  select id into v_m1 from public.usuarios where papel = 'transportes' and ativo order by nome limit 1;
  select id into v_m2 from public.usuarios where papel = 'transportes' and ativo and id <> v_m1 order by nome limit 1;
  if v_com is null or v_m1 is null or v_m2 is null then
    raise exception 'Preciso de 1 usuario comercial/gerencial e 2 motoristas ativos.';
  end if;

  -- Locacao: entrega com o motorista 1, retirada com o motorista 2.
  perform pg_temp.tenta(1, 'Yasmin lança a locação TESTE-PERMISSAO', v_com, format(
    'insert into public.controle_locacoes (numero, doutora, data_locacao, horario_montagem, equipamento,
       contrato_assinado, motorista_entrega_id, motorista_retirada_id, valor_locacao, faixas, status)
     values (''TESTE-PERMISSAO'', ''Dra. Teste'', current_date, ''09:00'', ''mpt1'', true, %L, %L, 500,
       ''[{"de":0,"ate":null,"valor":2}]'', ''concluido'')', v_m1, v_m2), 'permitir');

  select id into v_id from public.controle_locacoes where numero = 'TESTE-PERMISSAO';
  if v_id is null then return; end if;

  select count(*) into v_n from public.controle_locacoes where id = v_id and status = 'inicial';
  insert into ci_teste values (2, 'Locação nova começa em "inicial", mesmo pedindo outra etapa', 'permitir',
    case when v_n = 1 then 'executou (começou em inicial)' else 'falhou' end, v_n = 1);

  perform pg_temp.tenta(3,  'Motorista muda o valor da locação',                  v_m1,  format(q, 'valor_locacao = 1', v_id), 'bloquear');
  perform pg_temp.tenta(4,  'Motorista marca gratuidade',                         v_m1,  format(q, 'gratuidade = ''isenta''', v_id), 'bloquear');
  perform pg_temp.tenta(5,  'Motorista da entrega grava o disparo inicial',       v_m1,  format(q, 'ultra = jsonb_set(ultra, ''{inicial}'', ''{"linear15":12000}''), rascunho = ''{"linear15":"12000"}''', v_id), 'permitir');
  perform pg_temp.tenta(6,  'Motorista da retirada mexe na etapa da entrega',     v_m2,  format(q, 'rascunho = ''{"x":1}''', v_id), 'bloquear');
  perform pg_temp.tenta(7,  'Motorista pula direto para concluído',               v_m1,  format(q, 'status = ''concluido''', v_id), 'bloquear');
  perform pg_temp.tenta(8,  'Motorista da entrega vai para a assinatura',         v_m1,  format(q, 'status = ''sig_entrega''', v_id), 'permitir');
  perform pg_temp.tenta(9,  'Motorista da entrega assina e passa para a retirada', v_m1, format(q, 'status = ''final'', assinaturas = ''{"entrega":{"path":"teste"}}'', historico = historico || ''[{"txt":"Entrega assinada"}]''', v_id), 'permitir');
  perform pg_temp.tenta(10, 'Yasmin troca o motorista da entrega depois da assinatura', v_com, format(q, 'motorista_entrega_id = ' || quote_literal(v_m2), v_id), 'bloquear');
  perform pg_temp.tenta(11, 'Motorista da retirada altera o disparo inicial',     v_m2,  format(q, 'ultra = jsonb_set(ultra, ''{inicial}'', ''{"linear15":99999}'')', v_id), 'bloquear');
  perform pg_temp.tenta(12, 'Motorista grava o total por conta própria',          v_m2,  format(q, 'financeiro = ''{"total":1}''', v_id), 'bloquear');
  perform pg_temp.tenta(13, 'Motorista apaga o histórico',                        v_m2,  format(q, 'historico = ''[]''', v_id), 'bloquear');
  perform pg_temp.tenta(14, 'Motorista da retirada grava o disparo final e avança', v_m2, format(q, 'ultra = jsonb_set(ultra, ''{final}'', ''{"linear15":11000}''), status = ''condicoes''', v_id), 'permitir');
  perform pg_temp.tenta(15, 'Voltar de Saldo e total para o disparo final',       v_m2,  format(q, 'status = ''final''', v_id), 'permitir');
  perform pg_temp.tenta(16, 'Yasmin troca o motorista da retirada no meio',       v_com, format(q, 'motorista_retirada_id = ' || quote_literal(v_m1), v_id), 'permitir');
  perform pg_temp.tenta(17, 'Motorista trocado tenta salvar depois da troca',     v_m2,  format(q, 'rascunho = ''{"y":1}''', v_id), 'bloquear');
  perform pg_temp.tenta(18, 'Motorista trocado tenta ver a locação',              v_m2,  format('select 1 from public.controle_locacoes where id = %L', v_id), 'bloquear');
  perform pg_temp.tenta(19, 'Novo motorista da retirada pode enviar foto final',  v_m1,  format('select 1 where public.ci_pode_gravar_arquivo(%L)', v_id || '/final/linear15-1.jpg'), 'permitir');
  perform pg_temp.tenta(20, 'Na retirada, substituir foto da entrega',            v_m1,  format('select 1 where public.ci_pode_gravar_arquivo(%L)', v_id || '/inicial/linear15-2.jpg'), 'bloquear');
  perform pg_temp.tenta(21, 'Motorista sem vínculo abre arquivo da locação',      v_m2,  format('select 1 where public.ci_pode_ler_arquivo(%L)', v_id || '/inicial/linear15-1.jpg'), 'bloquear');

  -- Limpeza: apaga a locacao de teste.
  delete from public.controle_locacoes where id = v_id;

  -- Conferencia da limpeza.
  select count(*) into v_n from public.controle_locacoes where numero = 'TESTE-PERMISSAO';
  insert into ci_teste values (90, 'CONFERÊNCIA: locação TESTE-PERMISSAO apagada', 'zero', v_n || ' locação(ões)', v_n = 0);
  select count(*) into v_n from storage.objects where bucket_id = 'controle-insumos' and name like v_id || '/%';
  insert into ci_teste values (91, 'CONFERÊNCIA: arquivos da locação de teste', 'zero', v_n || ' arquivo(s)', v_n = 0);
end
$$;

select n, situacao, esperado, ok, resultado from ci_teste order by n;
