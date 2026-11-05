-- =====================================================================
-- Apaga a tabela antiga public.controles_insumos (decisão do Victor,
-- 05/11/2026: o módulo antigo não é usado e a única linha era teste).
--
-- Proteções: só apaga se a tabela tiver no máximo 1 linha e se nenhuma
-- outra tabela ou view depender dela. Sem CASCADE. Se qualquer
-- conferência falhar, nada é apagado.
-- Não mexe na tabela nova controle_locacoes (sem "s" no meio).
-- =====================================================================

do $$
declare
  v_linhas int;
  v_dep    int;
begin
  if to_regclass('public.controles_insumos') is null then
    raise exception 'A tabela controles_insumos já não existe. Nada foi feito.';
  end if;

  select count(*) into v_linhas from public.controles_insumos;
  if v_linhas > 1 then
    raise exception 'A tabela tem % linhas (esperado no máximo 1). Nada foi apagado.', v_linhas;
  end if;

  -- views de outras tabelas que leem esta tabela
  select count(*) into v_dep
    from pg_depend d
    join pg_rewrite r on r.oid = d.objid
   where d.classid = 'pg_rewrite'::regclass
     and d.refobjid = 'public.controles_insumos'::regclass
     and r.ev_class <> 'public.controles_insumos'::regclass;
  if v_dep > 0 then
    raise exception 'Existe view que usa controles_insumos. Nada foi apagado.';
  end if;

  -- chaves estrangeiras de outras tabelas apontando para esta
  select count(*) into v_dep
    from pg_constraint
   where confrelid = 'public.controles_insumos'::regclass
     and conrelid <> 'public.controles_insumos'::regclass;
  if v_dep > 0 then
    raise exception 'Outra tabela aponta para controles_insumos. Nada foi apagado.';
  end if;

  drop table public.controles_insumos;
end
$$;

select
  case when to_regclass('public.controles_insumos') is null
       then 'controles_insumos apagada' else 'AINDA EXISTE' end as tabela_antiga,
  case when to_regclass('public.controle_locacoes') is not null
       then 'controle_locacoes intacta' else 'ATENÇÃO: tabela nova sumiu' end as tabela_nova;
