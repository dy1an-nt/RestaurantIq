import { supabase } from '../db';

interface ForecastCacheRow {
  id: string;
  restaurant_id: string;
  payload: Record<string, unknown>;
  input_tokens: number;
  output_tokens: number;
  trailing_days: number;
  projection_days: number;
  generated_at: string;
}

export async function getFreshForecast(
  restaurantId: string,
  ttlMs: number,
): Promise<ForecastCacheRow | null> {
  const { data, error } = await supabase
    .from('forecast_cache')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error('Failed to read forecast cache');
  if (!data) return null;

  const age = Date.now() - new Date(data.generated_at).getTime();
  if (age > ttlMs) return null;

  return data as ForecastCacheRow;
}

export async function saveForecast(
  restaurantId: string,
  payload: Record<string, unknown>,
  tokens: { input: number; output: number },
  trailingDays: number,
  projectionDays: number,
): Promise<void> {
  const { error } = await supabase.from('forecast_cache').insert({
    restaurant_id: restaurantId,
    payload,
    input_tokens: tokens.input,
    output_tokens: tokens.output,
    trailing_days: trailingDays,
    projection_days: projectionDays,
  });

  if (error) throw new Error('Failed to save forecast cache');
}
