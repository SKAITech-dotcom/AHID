-- Use a readable, unique agent-name slug in referral links.
-- Existing agent-code referral links remain supported by the edge function.

alter table public.agents
  add column if not exists referral_slug text;

create or replace function public.generate_unique_agent_referral_slug(
  p_agent_id uuid,
  p_name text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_base text;
  v_slug text;
  v_suffix integer := 0;
  v_id text := substr(replace(p_agent_id::text, '-', ''), 1, 8);
begin
  select full_name into v_name
  from public.agents
  where id = p_agent_id;
  v_name := coalesce(nullif(trim(p_name), ''), v_name);

  v_base := public.slugify_agent_name(v_name);
  v_base := coalesce(v_base, 'agent-' || v_id);
  v_base := substr(v_base, 1, 60);
  v_slug := v_base;

  loop
    exit when not exists (
      select 1
      from public.agents
      where referral_slug = v_slug
        and id <> p_agent_id
    );
    v_suffix := v_suffix + 1;
    v_slug := substr(v_base, 1, 60 - length(v_suffix::text) - 1) || '-' || v_suffix;
  end loop;

  return v_slug;
end;
$$;

-- Backfill current agents before adding the unique index.
do $$
declare
  agent_row record;
begin
  for agent_row in
    select id, full_name
    from public.agents
    where nullif(trim(referral_slug), '') is null
    order by created_at nulls last, id
  loop
    update public.agents
    set referral_slug = public.generate_unique_agent_referral_slug(agent_row.id, agent_row.full_name)
    where id = agent_row.id;
  end loop;
end;
$$;

create unique index if not exists agents_referral_slug_unique_idx
  on public.agents(referral_slug)
  where referral_slug is not null;

create or replace function public.set_agent_referral_slug()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if nullif(trim(new.referral_slug), '') is null then
    new.referral_slug := public.generate_unique_agent_referral_slug(new.id, new.full_name);
  end if;
  return new;
end;
$$;

drop trigger if exists agents_set_referral_slug on public.agents;
create trigger agents_set_referral_slug
before insert or update of full_name, referral_slug on public.agents
for each row execute function public.set_agent_referral_slug();

revoke all on function public.generate_unique_agent_referral_slug(uuid, text) from public, anon, authenticated;
revoke all on function public.set_agent_referral_slug() from public, anon, authenticated;
grant execute on function public.generate_unique_agent_referral_slug(uuid, text) to service_role;
