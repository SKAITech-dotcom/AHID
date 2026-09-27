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

type AgentPricingLike = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        eq: (col: string, val: string) => {
          maybeSingle: () => Promise<{ data: { price: number } | null }>;
        };
      };
    };
  };
};

/**
 * The admin Store > Pricing tab writes to agent_pricing under keys like
 * price_mtn_1gb, but the data order functions used to read a hardcoded catalog
 * instead, so editing a price there changed nothing. This looks up the agent's
 * own price for a bundle and falls back to the catalog.
 *
 * Only whole-GB bundles have a pricing key; the small MB bundles keep the
 * catalog price.
 */
export async function resolveAgentBundlePrice(
  supabase: AgentPricingLike,
  agentId: string,
  networkType: string,
  volumeInMB: number,
  fallback: number,
): Promise<number> {
  const gb = volumeInMB / 1024;
  if (!Number.isInteger(gb) || gb <= 0) return fallback;

  const key = `price_${String(networkType).toLowerCase()}_${gb}gb`;
  try {
    const { data } = await supabase
      .from('agent_pricing')
      .select('price')
      .eq('agent_id', agentId)
      .eq('pricing_key', key)
      .maybeSingle();
    const price = Number(data?.price);
    if (Number.isFinite(price) && price > 0) {
      return Math.round(price * 100) / 100;
    }
  } catch (err) {
    console.warn(`Could not read agent price for ${key}:`, err);
  }
  return fallback;
}
