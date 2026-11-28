/** What the rest of Kappa sees. Everything else in src/voice is an implementation detail. */
export interface Speaker {
  /** Which engine is behind it, for logs and /voice status: "sapi", "say", "espeak", "piper", "off". */
  readonly name: string;
  /** True from the moment speech starts until it finishes or is stopped. */
  readonly speaking: boolean;
  /**
   * Speaks `text` aloud. Markdown, code blocks and links are cleaned first (see cleanForSpeech).
   * Resolves when the speech has finished OR been stopped; rejects (KappaError) only if no engine could run.
   * Calling speak() while already speaking cuts the old speech off first.
   * `onChunk`, when the engine knows it (ElevenLabs), is called as each piece of speech starts playing, with its words and how long it lasts,
   * so a display can keep pace with the voice.
   */
  speak(text: string, signal?: AbortSignal, onChunk?: (c: { text: string; seconds: number }) => void): Promise<void>;
  /** Cuts the current speech off immediately. Safe to call at any time. */
  stop(): void;
}

export type TtsProvider = 'auto' | 'system' | 'piper' | 'elevenlabs' | 'off';

export interface TtsOptions {
  /** auto = piper when a model is set, otherwise the operating system's own voice. Default: auto. */
  provider?: TtsProvider;
  /** Preferred voice name, matched loosely: "zira" (Windows), "samantha" (macOS), "en-us+f3" (Linux). Default: the best female voice. */
  voice?: string;
  /** Speed, -10 (slow) to 10 (fast). Default 0. */
  rate?: number;
  /** Longest text that will be spoken, in characters. Default 1500. */
  maxChars?: number;
  /** Path to the piper program. Default "piper" (on PATH). */
  piperPath?: string;
  /** Path to a piper voice, e.g. en_US-amy-medium.onnx. Required for piper. */
  piperModel?: string;
  /** ElevenLabs API key (ELEVENLABS_API_KEY). With auto, setting it selects ElevenLabs. */
  elevenKey?: string;
  /** Voice name looked up in your ElevenLabs account (My Voices). Default "Lauren". */
  elevenVoice?: string;
  /** Exact voice id. Skips the name lookup; use it when several voices share a name. */
  elevenVoiceId?: string;
  /** Default eleven_flash_v2_5 (fast, cheap). eleven_multilingual_v2 sounds richer but costs more. */
  elevenModel?: string;
  /** Test hooks. */
  spawn?: import('./process.ts').Spawn;
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
}

// ---- speech to text ----

export type SttProvider = 'auto' | 'groq' | 'whispercpp' | 'handy' | 'off';

export interface SttOptions {
  /** auto = Groq when a key is set, otherwise whisper.cpp when a model is set. Default: auto. */
  provider?: SttProvider;
  /** Groq API key (the same one Kappa already uses). */
  groqKey?: string;
  /** Default https://api.groq.com/openai/v1 (GROQ_BASE_URL is not reused: proxies often lack the audio endpoint). */
  baseUrl?: string;
  /** Default whisper-large-v3-turbo. */
  model?: string;
  /** Spoken language as a code such as "en". Default: detect. Setting it is faster and more accurate. */
  language?: string;
  /** Path to whisper.cpp's whisper-cli. Default "whisper-cli" (on PATH). */
  whisperPath?: string;
  /** Path to a whisper.cpp model, e.g. ggml-base.en.bin. Required for whispercpp. */
  whisperModel?: string;
  /** Path to Handy (the offline dictation app). Default: found automatically. Only used with KAPPA_STT=handy. */
  handyPath?: string;
  /** Path to ffmpeg, used to record the microphone. Default "ffmpeg" (on PATH). */
  ffmpegPath?: string;
  /** Microphone: a device name (Windows), an index such as "0" (macOS), or a PulseAudio source (Linux). Default: the first/default one. */
  mic?: string;
  /** Longest single recording in seconds. Default 60. */
  maxSeconds?: number;
  /** Test hooks. */
  fetch?: typeof fetch;
  spawn?: import('./process.ts').Spawn;
  platform?: NodeJS.Platform;
}

/** One push-to-talk recording in progress. */
export interface Recording {
  /** Ends the recording, transcribes it and returns the text ("" when nothing was said). Deletes the audio either way. */
  stop(): Promise<string>;
  /** Throws the recording away without transcribing. Safe to call at any time. */
  cancel(): void;
}

export interface Listener {
  /** Which recognizer is behind it, for /voice status: "groq", "whispercpp". */
  readonly name: string;
  /** True when the recognizer types the text into the focused window itself (Handy) instead of handing it back: stop() then returns "". */
  readonly pastes?: boolean;
  /** Starts recording from the microphone. Rejects (KappaError) at once if there is no ffmpeg or no microphone. */
  start(signal?: AbortSignal): Promise<Recording>;
}