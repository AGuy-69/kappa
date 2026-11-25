export interface ModelInfo {
  id: string;
  tools?: boolean; // only known when the provider says so (Mistral does)
}

/** Asks the active provider which models this key can use (GET {baseUrl}/models, supported by Groq, Gemini and Mistral). */
export async function listModels(cfg: { baseUrl: string; apiKey: string }, doFetch: typeof fetch = fetch): Promise<ModelInfo[]> {
  const res = await doFetch(`${cfg.baseUrl.replace(/\/+$/, '')}/models`, {
    headers: { authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j: any = await res.json();
  return ((j.data ?? j.models ?? []) as any[])
    .map((m) => ({
      id: String(m.id ?? m.name ?? '').replace(/^models\//, ''), // Gemini prefixes ids with "models/"
      ...(typeof m.capabilities?.function_calling === 'boolean' ? { tools: m.capabilities.function_calling as boolean } : {}),
    }))
    .filter((m) => m.id)
    .sort((a, b) => a.id.localeCompare(b.id));
}