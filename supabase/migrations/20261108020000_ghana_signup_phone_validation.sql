-- Enforce a valid Ghanaian phone number for new agent registrations.
-- Existing legacy rows are not rewritten; their phone value is only checked
-- when the phone itself is inserted or changed.

create or replace function public.normalize_ghana_phone(p_phone text)
returns text
language plpgsql
immutable
as $$
declare
  v_digits text := regexp_replace(coalesce(p_phone, ''), '\\D', '', 'g');
begin
  if length(v_digits) = 12 and left(v_digits, 3) = '233' then
    v_digits := '0' || substr(v_digits, 4);
  end if;

  if v_digits ~ '^0[0-9]{9}$' then
    return v_digits;
  end if;
  return null;
end;
$$;

revoke all on function public.normalize_ghana_phone(text) from public, anon, authenticated;

create or replace function public.validate_agent_phone()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text;
begin
  -- Do not block unrelated updates to old legacy rows that contain a bad
  -- historical value; enforce the rule whenever a phone is supplied/changed.
  if tg_op = 'UPDATE' and new.phone is not distinct from old.phone then
    return new;
  end if;

  if nullif(trim(coalesce(new.phone, '')), '') is null then
    return new;
  end if;

  v_phone := public.normalize_ghana_phone(new.phone);
  if v_phone is null then
    raise exception 'Enter a valid 10-digit Ghanaian phone number (for example, 0241234567).'
      using errcode = '22023';
  end if;

  new.phone := v_phone;
  if new.phone_number is not null or tg_op = 'INSERT' then
    new.phone_number := v_phone;
  end if;
  return new;
end;
$$;

revoke all on function public.validate_agent_phone() from public, anon, authenticated;

drop trigger if exists agents_validate_phone on public.agents;
create trigger agents_validate_phone
before insert or update of phone on public.agents
for each row execute function public.validate_agent_phone();

-- The public registration page marks new accounts as agents. This protects
-- the requirement even if somebody bypasses the browser and calls Auth API
-- directly. Admin-created accounts do not need an agent phone number.
create or replace function public.validate_agent_signup_phone()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := lower(coalesce(new.raw_user_meta_data->>'role', ''));
  v_phone text := public.normalize_ghana_phone(new.raw_user_meta_data->>'phone');
begin
  if v_role = 'agent' then
    if v_phone is null then
      raise exception 'A valid 10-digit Ghanaian phone number is required to create an agent account.'
        using errcode = '22023';
    end if;

    new.raw_user_meta_data := jsonb_set(
      coalesce(new.raw_user_meta_data, '{}'::jsonb),
      '{phone}',
      to_jsonb(v_phone),
      true
    );
  elsif new.raw_user_meta_data ? 'phone' and new.raw_user_meta_data->>'phone' is not null then
    if v_phone is null then
      raise exception 'Enter a valid Ghanaian phone number.' using errcode = '22023';
    end if;
    new.raw_user_meta_data := jsonb_set(
      coalesce(new.raw_user_meta_data, '{}'::jsonb),
      '{phone}',
      to_jsonb(v_phone),
      true
    );
  end if;
  return new;
end;
$$;

revoke all on function public.validate_agent_signup_phone() from public, anon, authenticated;

drop trigger if exists auth_validate_agent_signup_phone on auth.users;
create trigger auth_validate_agent_signup_phone
before insert on auth.users
for each row execute function public.validate_agent_signup_phone();
