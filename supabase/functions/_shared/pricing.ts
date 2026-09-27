/**
 * Resolves what an agent is charged for a service.
 *
 * Order of truth: the service_pricing table (so the price can be shown on the
 * page and changed with one SQL UPDATE), falling back to the
 * <SERVICE>_FEE_AMOUNT edge-function secret, then to a hard default.
 *
 * The result is always server-side: callers must never accept a price from the
 * request body.
 */

type SupabaseLike = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        maybeSingle: () => Promise<{ data: { price: number } | null }>;
      };
    };
  };
};

export async function resolveServicePrice(
  service: string,
  options: { supabase?: SupabaseLike; envVar?: string; fallback?: number } = {},
): Promise<number> {
  const { supabase, envVar, fallback = 0 } = options;

  if (supabase) {
    try {
      const { data } = await supabase
        .from('service_pricing')
        .select('price')
        .eq('service', service)
        .maybeSingle();
      const price = Number(data?.price);
      if (Number.isFinite(price) && price >= 0) {
        return Math.round(price * 100) / 100;
      }
    } catch (err) {
      console.warn(`Could not read ${service} price from service_pricing:`, err);
    }
  }

  if (envVar) {
    const fromEnv = Number(Deno.env.get(envVar));
    if (Number.isFinite(fromEnv) && fromEnv >= 0) {
      return Math.round(fromEnv * 100) / 100;
    }
  }

  return fallback;
}
