import { start } from '../process.ts';
import type { Running, Spawn } from '../process.ts';
import { cleanForSpeech } from '../speech-text.ts';
import type { Speaker } from '../types.ts';

/** Windows: SAPI through PowerShell. Picks the named voice, else a female one (Microsoft Zira when installed). Text travels in the environment, never in the script. */
const SAPI_PS = String.raw`Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = @($s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })
$pick = $null
if ($env:KAPPA_TTS_VOICE) { $pick = $voices | Where-Object { $_.Name -like ('*' + $env:KAPPA_TTS_VOICE + '*') } | Select-Object -First 1 }
if (-not $pick) { $pick = $voices | Where-Object { $_.Gender -eq 'Female' } | Sort-Object { if ($_.Name -match 'Zira') { 0 } else { 1 } } | Select-Object -First 1 }
if ($pick) { $s.SelectVoice($pick.Name) }
$s.Rate = [int]$env:KAPPA_TTS_RATE
$s.Speak($env:KAPPA_TTS_TEXT)`;

export class SystemSpeaker implements Speaker {
  readonly name: string;
  private o: { platform: NodeJS.Platform; spawn: Spawn; voice?: string; rate: number; maxChars: number };
  private cur?: Running;

  constructor(o: { platform: NodeJS.Platform; spawn: Spawn; voice?: string; rate: number; maxChars: number }) {
    this.o = o;
    this.name = o.platform === 'win32' ? 'sapi' : o.platform === 'darwin' ? 'say' : 'espeak';
  }

  get speaking() { return this.cur !== undefined; }

  private launch(text: string): Running {
    const { platform, spawn, voice, rate } = this.o;
    if (platform === 'win32') {
      const encoded = Buffer.from(SAPI_PS, 'utf16le').toString('base64');
      const env = { ...process.env, KAPPA_TTS_TEXT: text, KAPPA_TTS_VOICE: voice ?? '', KAPPA_TTS_RATE: String(rate) };
      return start(spawn, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { env });
    }
    if (platform === 'darwin') return start(spawn, 'say', ['-v', voice ?? 'Samantha', '-r', String(175 + rate * 10)], { input: text });
    return start(spawn, 'espeak-ng', ['-v', voice ?? 'en-us+f3', '-s', String(165 + rate * 10), '--stdin'], { input: text });
  }

  async speak(text: string, signal?: AbortSignal): Promise<void> {
    this.stop();
    const clean = cleanForSpeech(text, this.o.maxChars);
    if (!clean || signal?.aborted) return;
    const r = this.launch(clean);
    this.cur = r;
    signal?.addEventListener('abort', () => r.kill(), { once: true });
    try { await r.done; } finally { if (this.cur === r) this.cur = undefined; }
  }

  stop(): void { this.cur?.kill(); }
}
