-- =====================================================================
-- Controle de Insumos v2 - nomes dos motoristas para a tela do motorista
-- O motorista só lê o próprio cadastro em usuarios (policy existente),
-- mas precisa mostrar "entrega feita por Lucas" e os nomes no PDF.
-- Esta função devolve só id e nome dos usuários de Transportes, para quem
-- é Comercial, Gerencial ou Transportes. Não altera nenhuma tabela.
-- =====================================================================

create or replace function public.ci_nomes_motoristas()
returns table (id uuid, nome text)
language sql stable security definer
set search_path = public
as $$
  select u.id, u.nome
    from public.usuarios u
   where u.papel = 'transportes'
     and (public.is_comercial_ou_gerencial() or public.is_transportes())
$$;

revoke all on function public.ci_nomes_motoristas() from public, anon;
grant execute on function public.ci_nomes_motoristas() to authenticated, service_role;

select 'ci_nomes_motoristas criada' as resultado;
