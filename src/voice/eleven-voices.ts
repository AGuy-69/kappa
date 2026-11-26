// Lists the voices in your ElevenLabs account (My Voices), so you can pick one:
//   node src/voice/eleven-voices.ts            all of them
//   node src/voice/eleven-voices.ts lauren     only names containing "lauren"
// Then set KAPPA_ELEVEN_VOICE=<name> or, when several share a name, KAPPA_ELEVEN_VOICE_ID=<id>.
import path from 'node:path';

for (const f of ['.env', path.join(import.meta.dirname, '../../.env')]) {
  try { process.loadEnvFile(f); } catch { /* no .env there */ }
}
const key = process.env.ELEVENLABS_API_KEY;
if (!key) { console.error('Set ELEVENLABS_API_KEY in .env first.'); process.exit(1); }
const q = (process.argv[2] ?? '').toLowerCase();
const res = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(20_000) });
if (!res.ok) { console.error(`ElevenLabs answered ${res.status}${res.status === 401 ? ' (check the API key)' : ''}.`); process.exit(1); }
const voices = ((await res.json()) as { voices: { voice_id: string; name: string; labels?: Record<string, string> }[] }).voices.filter((v) => v.name.toLowerCase().includes(q));
if (!voices.length) console.log(q ? `No voice in your account matches "${q}". Add it from the Voice Library to My Voices first.` : 'Your account has no voices.');
for (const v of voices) console.log(`${v.name}\t${v.voice_id}\t${[v.labels?.gender, v.labels?.accent, v.labels?.descriptive].filter(Boolean).join(', ')}`);
