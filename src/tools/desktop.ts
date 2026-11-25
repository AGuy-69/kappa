import { KappaError } from '../util/errors.ts';
import { ps, sh, win } from './system.ts';
import type { Tool, ToolCtx } from './registry.ts';

const MAX_CLIP = 20_000; // Windows passes the text to PowerShell through an environment variable (limit ~32k)
const mac = () => process.platform === 'darwin';
const wayland = () => Boolean(process.env.WAYLAND_DISPLAY);

async function readClipboard(c: ToolCtx): Promise<string> {
  if (win()) return ps(c, '[Console]::OutputEncoding = [Text.Encoding]::UTF8; $t = Get-Clipboard -Raw; if ($null -ne $t) { [Console]::Out.Write($t) }');
  if (mac()) return sh(c, 'pbpaste', []);
  return wayland() ? sh(c, 'wl-paste', ['--no-newline']) : sh(c, 'xclip', ['-selection', 'clipboard', '-o']);
}
async function writeClipboard(c: ToolCtx, text: string): Promise<void> {
  if (win()) await ps(c, 'Set-Clipboard -Value $env:KAPPA_TEXT', { KAPPA_TEXT: text });
  else if (mac()) await sh(c, 'pbcopy', [], undefined, text);
  else if (wayland()) await sh(c, 'wl-copy', [], undefined, text);
  else await sh(c, 'xclip', ['-selection', 'clipboard'], undefined, text);
}

export const clipboard: Tool<{ action: 'read' | 'write'; text?: string }> = {
  name: 'clipboard',
  description: 'Read the clipboard text, or replace it with text.',
  parameters: {
    type: 'object',
    properties: { action: { type: 'string', enum: ['read', 'write'] }, text: { type: 'string' } },
    required: ['action'],
  },
  // Reading can expose something the user copied (a password); writing destroys what they copied. Both are asked about.
  risk: 'approval',
  target: (a) => (a.action === 'read' ? 'read the clipboard' : `replace the clipboard (${a.text?.length ?? 0} characters)`),
  detail: (a) => (a.action === 'write' ? (a.text ?? '').slice(0, 300) + ((a.text?.length ?? 0) > 300 ? '…' : '') : 'The model will see whatever text you last copied.'),
  precheck(a) {
    if (a.action === 'write' && a.text === undefined) throw new KappaError('bad_args', 'text is required to write');
    if (a.action === 'read' && a.text !== undefined) throw new KappaError('bad_args', 'text is only for write');
    if ((a.text?.length ?? 0) > MAX_CLIP) throw new KappaError('too_large', `Clipboard text is limited to ${MAX_CLIP} characters.`);
  },
  async run(a, c) {
    if (a.action === 'write') {
      await writeClipboard(c, a.text!);
      return { ok: true, characters: a.text!.length };
    }
    const text = await readClipboard(c);
    return text.length > MAX_CLIP ? { text: text.slice(0, MAX_CLIP), truncated: true, total_characters: text.length } : { text, empty: text.length === 0 };
  },
};

const WIN_KEYS = { mute: 173, volume_down: 174, volume_up: 175, next: 176, previous: 177, play_pause: 179 } as const;
type MediaAction = keyof typeof WIN_KEYS;

export const mediaControl: Tool<{ action: MediaAction; steps?: number }> = {
  name: 'media_control',
  description: 'Volume (up/down/mute) and playback (play_pause/next/previous) of whatever is playing. steps = volume presses, ~2% each (default 5).',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: Object.keys(WIN_KEYS) },
      steps: { type: 'integer', minimum: 1, maximum: 50 },
    },
    required: ['action'],
  },
  risk: 'low', // reversible and harmless, so it does not nag
  target: (a) => `${a.action}${a.steps ? ` x${a.steps}` : ''}`,
  async run(a, c) {
    const n = a.steps ?? 5;
    const vol = a.action === 'volume_up' || a.action === 'volume_down';
    if (win()) {
      const presses = vol ? n : 1;
      await ps(c, `$w = New-Object -ComObject WScript.Shell; 1..${presses} | ForEach-Object { $w.SendKeys([char]${WIN_KEYS[a.action]}) }`);
    } else if (mac()) {
      const delta = a.action === 'volume_up' ? `+ ${n * 2}` : `- ${n * 2}`;
      if (vol) await sh(c, 'osascript', ['-e', `set volume output volume (((output volume of (get volume settings)) ${delta}) as integer)`]);
      else if (a.action === 'mute') await sh(c, 'osascript', ['-e', 'set volume output muted (not (output muted of (get volume settings)))']);
      else throw new KappaError('unsupported', 'Playback keys are not available on macOS from here; only volume and mute are.');
    } else if (vol) await sh(c, 'pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${a.action === 'volume_up' ? '+' : '-'}${n * 2}%`]);
    else if (a.action === 'mute') await sh(c, 'pactl', ['set-sink-mute', '@DEFAULT_SINK@', 'toggle']);
    else await sh(c, 'playerctl', [a.action === 'play_pause' ? 'play-pause' : a.action]);
    return { ok: true, action: a.action, ...(vol ? { steps: n } : {}) };
  },
};

export const desktopTools = [clipboard, mediaControl];
