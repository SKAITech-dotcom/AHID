-- Agent codes are permanent identifiers. Authenticated users may update
-- their profile details, but cannot change an assigned code through the API.
create or replace function public.prevent_agent_code_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.agent_code is distinct from old.agent_code
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Agent code cannot be changed.';
  end if;

  return new;
end;
$$;

drop trigger if exists agents_agent_code_immutable on public.agents;
create trigger agents_agent_code_immutable
before update of agent_code on public.agents
for each row execute function public.prevent_agent_code_change();
