-- =====================================================================
-- Controle de Insumos v2 - CHECAGEM (somente leitura, nao altera nada)
-- Rode no SQL Editor do Supabase (projeto rjx-intranet) e me mande o
-- resultado completo (pode exportar como CSV ou copiar a grade).
-- =====================================================================

with
contagem as (
  select 'A. controles_insumos' as secao,
         'total de linhas' as item,
         count(*)::text as detalhe
  from public.controles_insumos
  union all
  select 'A. controles_insumos', 'status = ' || coalesce(status, '(nulo)'), count(*)::text
  from public.controles_insumos group by status
  union all
  select 'A. controles_insumos', 'periodo (criado_em)',
         coalesce(min(criado_em)::text, '-') || '  ate  ' || coalesce(max(criado_em)::text, '-')
  from public.controles_insumos
),
policies as (
  select 'B. policies ' || schemaname || '.' || tablename as secao,
         policyname || '  [' || cmd || ']  roles=' || array_to_string(roles, ',') as item,
         'USING: ' || coalesce(qual, '-') || '   |   CHECK: ' || coalesce(with_check, '-') as detalhe
  from pg_policies
  where tablename like 'comercial_frete%'
     or tablename in ('usuarios', 'premiacao_locacoes')
     or (schemaname = 'storage' and tablename = 'objects')
),
rls as (
  select 'C. RLS ligado?' as secao, c.relname as item,
         case when c.relrowsecurity then 'sim' else 'NAO' end as detalhe
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and (c.relname like 'comercial_frete%' or c.relname in ('usuarios', 'controles_insumos', 'controle_locacoes'))
    and c.relkind = 'r'
),
colunas_usuarios as (
  select 'D. colunas de usuarios' as secao, column_name as item,
         data_type || case when is_nullable = 'NO' then ' not null' else '' end as detalhe
  from information_schema.columns
  where table_schema = 'public' and table_name = 'usuarios'
),
papeis as (
  select 'E. papeis em uso' as secao, coalesce(papel, '(nulo)') as item,
         count(*)::text || ' usuario(s), ' || count(*) filter (where ativo)::text || ' ativo(s)' as detalhe
  from public.usuarios group by papel
),
funcoes as (
  select 'F. funcoes em public' as secao,
         p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as item,
         case when p.prosecdef then 'SECURITY DEFINER' else 'invoker' end
           || '  ->  ' || left(regexp_replace(pg_get_functiondef(p.oid), '\s+', ' ', 'g'), 600) as detalhe
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f'
),
gatilhos as (
  select 'G. triggers' as secao, event_object_table || ' / ' || trigger_name as item,
         action_timing || ' ' || event_manipulation || ' -> ' || action_statement as detalhe
  from information_schema.triggers
  where event_object_schema = 'public'
),
buckets as (
  select 'H. buckets' as secao, id as item,
         'publico=' || public::text || ' limite=' || coalesce(file_size_limit::text, '-')
           || ' tipos=' || coalesce(array_to_string(allowed_mime_types, ','), '-') as detalhe
  from storage.buckets
),
ja_existe as (
  select 'I. ja existe controle_locacoes?' as secao, 'tabela' as item,
         case when to_regclass('public.controle_locacoes') is null then 'nao' else 'SIM' end as detalhe
  union all
  select 'I. ja existe bucket controle-insumos?', 'bucket',
         case when exists (select 1 from storage.buckets where id = 'controle-insumos') then 'SIM' else 'nao' end
)
select * from contagem
union all select * from policies
union all select * from rls
union all select * from colunas_usuarios
union all select * from papeis
union all select * from funcoes
union all select * from gatilhos
union all select * from buckets
union all select * from ja_existe
order by 1, 2;
