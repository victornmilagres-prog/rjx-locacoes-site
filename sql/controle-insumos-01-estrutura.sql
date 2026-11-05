-- =====================================================================
-- Controle de Insumos v2 - ESTRUTURA (etapa 1)
-- Tabela controle_locacoes, permissoes, RLS, triggers, bucket privado
-- e policies de arquivo.
--
-- * Nao apaga nem renomeia nada. A tabela antiga controles_insumos
--   continua intocada (rename so na etapa 9, com autorizacao).
-- * Pode ser rodado mais de uma vez sem erro.
-- * Tudo dentro de uma transacao: se algo falhar, nada fica pela metade.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Funcoes auxiliares
-- ---------------------------------------------------------------------

-- Papeis: usa as funcoes que o projeto ja tem (SECURITY DEFINER, checam ativo):
--   public.is_comercial_ou_gerencial()  e  public.is_transportes()

-- Fase da etapa: 'entrega', 'retirada' ou 'fim'.
create or replace function public.ci_fase(p_status text)
returns text
language sql immutable
as $$
  select case
    when p_status in ('inicial', 'sig_entrega') then 'entrega'
    when p_status in ('final', 'condicoes', 'sig_fechamento', 'revisao') then 'retirada'
    else 'fim'
  end
$$;

-- Fase a que pertence um arquivo, pelo caminho:
--   {locacao}/inicial|entrega/...      -> entrega
--   {locacao}/final|retorno/...        -> retirada
--   {locacao}/assinaturas/entrega.png  -> entrega
--   {locacao}/assinaturas/outros.png   -> retirada (doutora, motorista, cinta)
create or replace function public.ci_fase_do_arquivo(p_name text)
returns text
language sql immutable
as $$
  select case
    when split_part(p_name, '/', 2) in ('inicial', 'entrega') then 'entrega'
    when split_part(p_name, '/', 2) in ('final', 'retorno') then 'retirada'
    when split_part(p_name, '/', 2) = 'assinaturas'
      then case when split_part(p_name, '/', 3) like 'entrega.%' then 'entrega' else 'retirada' end
    else null
  end
$$;

-- ---------------------------------------------------------------------
-- 2. Tabela
-- ---------------------------------------------------------------------
create table if not exists public.controle_locacoes (
  id uuid primary key default gen_random_uuid(),

  -- dados comerciais (so comercial/gerencial alteram)
  numero text not null,
  doutora text not null,
  cpf_cnpj text,
  data_locacao date not null,
  horario_montagem time not null,
  equipamento text not null check (equipamento in ('mpt1', 'mpt2', 'crio')),
  contrato_assinado boolean not null,
  motorista_entrega_id uuid not null references public.usuarios(id),
  motorista_retirada_id uuid not null references public.usuarios(id),
  condicoes text,
  valor_locacao numeric(12,2) not null default 0,
  valor_lavieen numeric(12,2) not null default 0,
  valor_manta numeric(12,2) not null default 0,
  sem_manta boolean not null default false,
  tem_frete boolean not null default false,
  valor_frete numeric(12,2) not null default 0,
  cartuchos_extras text[] not null default '{}',
  cartuchos_duplicados text[] not null default '{}',
  faixas jsonb not null default '[]',              -- [{de, ate|null, valor}]
  gratuidade text not null default 'nao'
    check (gratuidade in ('nao', 'apartir', 'isenta')),
  gratis_a_partir integer,

  -- andamento (motorista altera na etapa dele)
  status text not null default 'inicial'
    check (status in ('inicial', 'sig_entrega', 'final', 'condicoes',
                      'sig_fechamento', 'revisao', 'concluido')),
  ultra jsonb not null default '{"inicial":{},"final":{}}',
  crio jsonb not null default '{}',                -- {entregues, retornando, cobrancaCinta}
  rascunho jsonb not null default '{}',            -- valores digitados, salvos a cada alteracao
  fotos jsonb not null default '{"ultra":{"inicial":{},"final":{}},"crio":{"entrega":{},"retorno":{}}}',
  assinaturas jsonb not null default '{}',         -- {entrega, retirada, logistica}
  financeiro jsonb,                                -- retrato do calculo, gravado pelo servidor ao concluir
  historico jsonb not null default '[]',           -- [{ts, quem, txt}]

  criado_por uuid references public.usuarios(id),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  finalizada_em timestamptz,
  dados_apagados_em timestamptz,

  constraint controle_locacoes_numero_equip_uk unique (numero, equipamento),
  constraint controle_locacoes_gratis_ck
    check (gratuidade <> 'apartir' or gratis_a_partir is not null),
  constraint controle_locacoes_faixas_ck check (jsonb_typeof(faixas) = 'array'),
  constraint controle_locacoes_historico_ck check (jsonb_typeof(historico) = 'array')
);

create index if not exists controle_locacoes_mot_entrega_idx  on public.controle_locacoes (motorista_entrega_id);
create index if not exists controle_locacoes_mot_retirada_idx on public.controle_locacoes (motorista_retirada_id);
create index if not exists controle_locacoes_status_idx       on public.controle_locacoes (status);
create index if not exists controle_locacoes_finalizada_idx   on public.controle_locacoes (finalizada_em)
  where finalizada_em is not null and dados_apagados_em is null;

-- ---------------------------------------------------------------------
-- 2b. Funcoes que dependem da tabela
-- ---------------------------------------------------------------------

-- O id informado e de um motorista ativo (papel transportes)?
create or replace function public.ci_eh_motorista(p_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.usuarios u
                 where u.id = p_id and u.papel = 'transportes' and u.ativo is true)
$$;

-- O motorista logado pode VER os arquivos desta locacao?
create or replace function public.ci_pode_ler_arquivo(p_name text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.controle_locacoes l
    where l.id::text = split_part(p_name, '/', 1)
      and public.is_transportes()
      and auth.uid() in (l.motorista_entrega_id, l.motorista_retirada_id)
  )
$$;

-- O motorista logado pode GRAVAR este arquivo agora?
-- So o responsavel pela etapa atual, e so arquivos da fase atual.
create or replace function public.ci_pode_gravar_arquivo(p_name text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.controle_locacoes l
    where l.id::text = split_part(p_name, '/', 1)
      and public.is_transportes()
      and l.dados_apagados_em is null
      and public.ci_fase(l.status) = public.ci_fase_do_arquivo(p_name)
      and auth.uid() = case public.ci_fase(l.status)
                         when 'entrega' then l.motorista_entrega_id
                         when 'retirada' then l.motorista_retirada_id
                       end
  )
$$;

-- Neste projeto RLS nao basta: sem GRANT da "permission denied".
grant select, insert, update, delete on public.controle_locacoes to authenticated;
grant select, insert, update, delete on public.controle_locacoes to service_role;

grant execute on function public.ci_fase(text)                 to authenticated, service_role;
grant execute on function public.ci_fase_do_arquivo(text)      to authenticated, service_role;
grant execute on function public.ci_pode_ler_arquivo(text)     to authenticated, service_role;
grant execute on function public.ci_pode_gravar_arquivo(text)  to authenticated, service_role;
grant execute on function public.ci_eh_motorista(uuid)          to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. RLS
-- ---------------------------------------------------------------------
alter table public.controle_locacoes enable row level security;

drop policy if exists ci_select on public.controle_locacoes;
create policy ci_select on public.controle_locacoes
  for select to authenticated
  using (
    public.is_comercial_ou_gerencial()
    or (public.is_transportes()
        and auth.uid() in (motorista_entrega_id, motorista_retirada_id))
  );

drop policy if exists ci_insert on public.controle_locacoes;
create policy ci_insert on public.controle_locacoes
  for insert to authenticated
  with check (public.is_comercial_ou_gerencial());

-- Motorista: so nas locacoes dele. Qual etapa e quais campos ele pode
-- mexer e controlado pelo trigger ci_antes_update.
drop policy if exists ci_update on public.controle_locacoes;
create policy ci_update on public.controle_locacoes
  for update to authenticated
  using (
    public.is_comercial_ou_gerencial()
    or (public.is_transportes()
        and auth.uid() in (motorista_entrega_id, motorista_retirada_id))
  )
  with check (
    public.is_comercial_ou_gerencial()
    or (public.is_transportes()
        and auth.uid() in (motorista_entrega_id, motorista_retirada_id))
  );

-- Na tela, a exclusao passa por /api (que tambem apaga os arquivos).
-- A policy fica para manter a regra da especificacao.
drop policy if exists ci_delete on public.controle_locacoes;
create policy ci_delete on public.controle_locacoes
  for delete to authenticated
  using (public.is_comercial_ou_gerencial());

-- ---------------------------------------------------------------------
-- 4. Triggers
--    Funcoes SECURITY INVOKER de proposito: assim current_user e o papel
--    real da chamada (authenticated ou service_role).
--    service_role (rotinas da api) e o SQL Editor passam direto.
-- ---------------------------------------------------------------------

create or replace function public.ci_antes_insert()
returns trigger
language plpgsql
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if not public.ci_eh_motorista(new.motorista_entrega_id)
     or not public.ci_eh_motorista(new.motorista_retirada_id) then
    raise exception 'Escolha motoristas ativos de Transportes para a entrega e a retirada.'
      using errcode = '23514';
  end if;
  -- locacao nova sempre comeca do zero
  new.criado_por        := auth.uid();
  new.criado_em         := now();
  new.atualizado_em     := now();
  new.status            := 'inicial';
  new.ultra             := '{"inicial":{},"final":{}}';
  new.crio              := '{}';
  new.rascunho          := '{}';
  new.fotos             := '{"ultra":{"inicial":{},"final":{}},"crio":{"entrega":{},"retorno":{}}}';
  new.assinaturas       := '{}';
  new.financeiro        := null;
  new.finalizada_em     := null;
  new.dados_apagados_em := null;
  return new;
end
$$;

create or replace function public.ci_antes_update()
returns trigger
language plpgsql
as $$
declare
  v_fase_old  text := public.ci_fase(old.status);
  v_resp      uuid;
begin
  new.atualizado_em := now();

  -- rotinas do servidor (service_role) e SQL Editor passam direto
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  -- Campos que so o servidor grava (concluir e limpeza de 30 dias)
  if new.financeiro is distinct from old.financeiro
     or new.finalizada_em is distinct from old.finalizada_em
     or new.dados_apagados_em is distinct from old.dados_apagados_em
     or new.criado_por is distinct from old.criado_por
     or new.criado_em is distinct from old.criado_em then
    raise exception 'Campo reservado ao sistema.' using errcode = '42501';
  end if;

  -- Ninguem conclui pela tela: concluir passa pelo servidor, que calcula o total
  if new.status = 'concluido' and old.status <> 'concluido' then
    raise exception 'A conclusão da locação é feita pelo sistema.' using errcode = '42501';
  end if;

  -- Historico so cresce
  if jsonb_array_length(new.historico) < jsonb_array_length(old.historico)
     or not (new.historico @> old.historico) then
    raise exception 'O histórico não pode ser alterado, só acrescentado.' using errcode = '42501';
  end if;

  -- ----------------------- comercial / gerencial -----------------------
  if public.is_comercial_ou_gerencial() then
    if old.status <> 'inicial' and (
         new.numero is distinct from old.numero
      or new.equipamento is distinct from old.equipamento
      or new.cartuchos_extras is distinct from old.cartuchos_extras
      or new.cartuchos_duplicados is distinct from old.cartuchos_duplicados) then
      raise exception 'Depois do disparo inicial não dá para mudar número, equipamento, extras ou duplicados.'
        using errcode = '42501';
    end if;
    if v_fase_old <> 'entrega'
       and new.motorista_entrega_id is distinct from old.motorista_entrega_id then
      raise exception 'Depois da assinatura da entrega não dá para trocar o motorista da entrega.'
        using errcode = '42501';
    end if;
    if (new.motorista_entrega_id is distinct from old.motorista_entrega_id
          and not public.ci_eh_motorista(new.motorista_entrega_id))
       or (new.motorista_retirada_id is distinct from old.motorista_retirada_id
          and not public.ci_eh_motorista(new.motorista_retirada_id)) then
      raise exception 'Escolha motoristas ativos de Transportes para a entrega e a retirada.'
        using errcode = '23514';
    end if;
    -- Reabrir a entrega: so de 'final' para 'inicial', descartando a assinatura da entrega
    if new.status is distinct from old.status
       and not (old.status = 'final' and new.status = 'inicial') then
      raise exception 'O escritório só pode mudar a etapa para reabrir a entrega.' using errcode = '42501';
    end if;
    return new;
  end if;

  -- ----------------------------- motorista -----------------------------
  if not public.is_transportes() then
    raise exception 'Sem permissão.' using errcode = '42501';
  end if;

  -- 1) nada dos dados comerciais
  if new.numero                 is distinct from old.numero
  or new.doutora                is distinct from old.doutora
  or new.cpf_cnpj               is distinct from old.cpf_cnpj
  or new.data_locacao           is distinct from old.data_locacao
  or new.horario_montagem       is distinct from old.horario_montagem
  or new.equipamento            is distinct from old.equipamento
  or new.contrato_assinado      is distinct from old.contrato_assinado
  or new.motorista_entrega_id   is distinct from old.motorista_entrega_id
  or new.motorista_retirada_id  is distinct from old.motorista_retirada_id
  or new.condicoes              is distinct from old.condicoes
  or new.valor_locacao          is distinct from old.valor_locacao
  or new.valor_lavieen          is distinct from old.valor_lavieen
  or new.valor_manta            is distinct from old.valor_manta
  or new.sem_manta              is distinct from old.sem_manta
  or new.tem_frete              is distinct from old.tem_frete
  or new.valor_frete            is distinct from old.valor_frete
  or new.cartuchos_extras       is distinct from old.cartuchos_extras
  or new.cartuchos_duplicados   is distinct from old.cartuchos_duplicados
  or new.faixas                 is distinct from old.faixas
  or new.gratuidade             is distinct from old.gratuidade
  or new.gratis_a_partir        is distinct from old.gratis_a_partir then
    raise exception 'O motorista não altera os dados comerciais da locação.' using errcode = '42501';
  end if;

  -- 2) so o responsavel pela etapa atual mexe
  v_resp := case v_fase_old
              when 'entrega'  then old.motorista_entrega_id
              when 'retirada' then old.motorista_retirada_id
            end;
  if v_resp is null or auth.uid() is distinct from v_resp then
    raise exception 'A locação mudou: esta etapa não está mais com você. Atualize a tela.'
      using errcode = '42501';
  end if;

  -- 3) so passos validos (avancar uma etapa ou voltar uma)
  if new.status is distinct from old.status and not (
       (old.status = 'inicial'        and new.status = 'sig_entrega')
    or (old.status = 'sig_entrega'    and new.status in ('inicial', 'final'))
    or (old.status = 'final'          and new.status = 'condicoes')
    or (old.status = 'condicoes'      and new.status in ('final', 'sig_fechamento'))
    or (old.status = 'sig_fechamento' and new.status in ('condicoes', 'revisao'))
    or (old.status = 'revisao'        and new.status = 'sig_fechamento')
  ) then
    raise exception 'Mudança de etapa inválida.' using errcode = '42501';
  end if;

  -- 4) na retirada, o que foi feito na entrega fica congelado
  if v_fase_old = 'retirada' and (
       (new.ultra -> 'inicial')            is distinct from (old.ultra -> 'inicial')
    or (new.crio -> 'entregues')           is distinct from (old.crio -> 'entregues')
    or (new.fotos #> '{ultra,inicial}')    is distinct from (old.fotos #> '{ultra,inicial}')
    or (new.fotos #> '{crio,entrega}')     is distinct from (old.fotos #> '{crio,entrega}')
    or (new.assinaturas -> 'entrega')      is distinct from (old.assinaturas -> 'entrega')) then
    raise exception 'Os dados da entrega não podem ser alterados na retirada.' using errcode = '42501';
  end if;

  -- 5) na entrega, nada da retirada
  if v_fase_old = 'entrega' and (
       (new.ultra -> 'final')              is distinct from (old.ultra -> 'final')
    or (new.crio -> 'retornando')          is distinct from (old.crio -> 'retornando')
    or (new.crio -> 'cobrancaCinta')       is distinct from (old.crio -> 'cobrancaCinta')
    or (new.fotos #> '{ultra,final}')      is distinct from (old.fotos #> '{ultra,final}')
    or (new.fotos #> '{crio,retorno}')     is distinct from (old.fotos #> '{crio,retorno}')
    or (new.assinaturas - 'entrega')       is distinct from (old.assinaturas - 'entrega')) then
    raise exception 'Dados da retirada só podem ser lançados na retirada.' using errcode = '42501';
  end if;

  return new;
end
$$;

drop trigger if exists ci_antes_insert on public.controle_locacoes;
create trigger ci_antes_insert
  before insert on public.controle_locacoes
  for each row execute function public.ci_antes_insert();

drop trigger if exists ci_antes_update on public.controle_locacoes;
create trigger ci_antes_update
  before update on public.controle_locacoes
  for each row execute function public.ci_antes_update();

-- ---------------------------------------------------------------------
-- 5. Bucket privado de arquivos (fotos e assinaturas)
--    Caminho: {locacao_id}/{etapa}/{chave}-{timestamp}.jpg
--             {locacao_id}/assinaturas/{tipo}.png
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('controle-insumos', 'controle-insumos', false, 5242880, array['image/jpeg', 'image/png'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Ler: escritorio tudo; motorista so das locacoes dele.
drop policy if exists ci_arquivos_select on storage.objects;
create policy ci_arquivos_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'controle-insumos'
    and (public.is_comercial_ou_gerencial() or public.ci_pode_ler_arquivo(name))
  );

-- Enviar: so o motorista responsavel, e so arquivos da etapa atual.
drop policy if exists ci_arquivos_insert on storage.objects;
create policy ci_arquivos_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'controle-insumos'
    and public.ci_pode_gravar_arquivo(name)
  );

-- Substituir (upsert da assinatura ao assinar de novo): mesma regra.
drop policy if exists ci_arquivos_update on storage.objects;
create policy ci_arquivos_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'controle-insumos'
    and public.ci_pode_gravar_arquivo(name)
  )
  with check (
    bucket_id = 'controle-insumos'
    and public.ci_pode_gravar_arquivo(name)
  );

-- Apagar: nenhuma policy para authenticated. So a service_role apaga
-- (rotina de 30 dias, orfaos e a exclusao feita pela rota da api).

commit;

-- ---------------------------------------------------------------------
-- Conferencia rapida (rode depois do commit; deve listar 4 + 3 policies
-- e 2 triggers):
-- select tablename, policyname, cmd from pg_policies where policyname like 'ci\_%';
-- select trigger_name from information_schema.triggers where event_object_table = 'controle_locacoes';
-- ---------------------------------------------------------------------
