-- Do not accept arbitrary letters around an otherwise valid phone number.
-- Spaces, parentheses, dots and dashes remain allowed for normal formatting.

create or replace function public.normalize_ghana_phone(p_phone text)
returns text
language plpgsql
immutable
as $$
declare
  v_raw text := btrim(coalesce(p_phone, ''));
  v_digits text;
begin
  if v_raw = '' or v_raw ~ '[^0-9+().[:space:]-]' then
    return null;
  end if;

  v_digits := regexp_replace(v_raw, '\\D', '', 'g');
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
