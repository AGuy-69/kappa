# Kappa voice

Speech in and speech out. Both halves are standalone modules (`src/voice/tts`, `src/voice/stt`); the CLI is the only code that uses them.

## In Kappa

| Command | What it does |
|---|---|
| `/voice on` / `/voice off` / `/voice` | Kappa reads her final replies aloud (never tool output or approval prompts). While voice is on, pressing Enter on an empty line also starts listening |
| `/listen` (or `/talk`) | Push-to-talk: speak, then press Enter. The text is shown (`heard: ...`) and sent as your message. Ctrl+C cancels |
| any key | Cuts the voice off |

What you say is never treated as a `/command`, and approvals ("Approve? [y/N]") stay on the keyboard, so a misheard word cannot approve anything.

## Speech to text (what you say)

Recording uses **ffmpeg** (`winget install Gyan.FFmpeg`, `brew install ffmpeg`, `sudo apt install ffmpeg`). Audio is written to a private temp folder and deleted right after transcription.

| Variable | Meaning |
|---|---|
| `KAPPA_STT` | `auto` (default), `groq`, `whispercpp`, `off`. auto = Groq when `GROQ_API_KEY` is set, else whisper.cpp when `KAPPA_WHISPER_MODEL` is set |
| `KAPPA_STT_LANGUAGE` | e.g. `en`. Faster and more accurate than detecting |
| `KAPPA_STT_MODEL` | Groq model, default `whisper-large-v3-turbo` |
| `KAPPA_MIC` | Windows: device name (default: first microphone, found with `ffmpeg -list_devices true -f dshow -i dummy`). macOS: index (default `0`). Linux: PulseAudio source (default `default`) |
| `KAPPA_STT_MAX_SECONDS` | Longest recording, default 60 (3 to 300) |
| `KAPPA_FFMPEG_PATH` | ffmpeg program, default `ffmpeg` on PATH |
| `KAPPA_WHISPER_PATH`, `KAPPA_WHISPER_MODEL` | whisper.cpp `whisper-cli` and a model such as `ggml-base.en.bin` (offline, private) |
| `KAPPA_STT_BASE_URL` | Groq-compatible endpoint (`GROQ_BASE_URL` is deliberately not reused: proxies often lack the audio API) |

Privacy: with Groq, your recording is sent to Groq to be transcribed. whisper.cpp keeps everything on your PC.

## Text to speech (her voice)

```ts
import { createSpeaker, ttsOptionsFromEnv } from './voice/index.ts';
const speaker = createSpeaker(ttsOptionsFromEnv());
await speaker.speak(reply);   // cleans markdown/code/links, then speaks; resolves when done or stopped
speaker.stop();
```

Try it without Kappa: `node src/voice/say.ts "Hello, I'm Kappa."`

| Variable | Meaning |
|---|---|
| `KAPPA_TTS` | `auto` (default), `system`, `piper`, `elevenlabs`, `off`. `auto` = ElevenLabs when `ELEVENLABS_API_KEY` is set, else Piper when `KAPPA_PIPER_MODEL` is set, else the OS voice |
| `KAPPA_TTS_VOICE` | Preferred voice name: `zira` (Windows), `samantha` (macOS), `en-us+f3` (Linux). Default: a female voice |
| `KAPPA_TTS_RATE` | -10 (slow) to 10 (fast), default 0 |
| `KAPPA_TTS_MAX_CHARS` | Longest reply that is spoken, default 1500 |
| `KAPPA_PIPER_PATH` | The `piper` program, default `piper` on PATH |
| `KAPPA_PIPER_MODEL` | Path to a Piper voice, e.g. `en_US-amy-medium.onnx` (its `.onnx.json` sits beside it) |

### ElevenLabs (Lauren)

Cloud voices with the most natural sound. Set `ELEVENLABS_API_KEY` in `.env` and Kappa uses ElevenLabs automatically, with the voice named **Lauren** from your account.

| Variable | Meaning |
|---|---|
| `ELEVENLABS_API_KEY` | Your key (elevenlabs.io, Developers, API Keys). Keep it in `.env`, never in chat or code |
| `KAPPA_ELEVEN_VOICE` | Voice name to look up in your account, default `Lauren` |
| `KAPPA_ELEVEN_VOICE_ID` | Exact voice id. Skips the lookup; needed when several voices share a name |
| `KAPPA_ELEVEN_MODEL` | Default `eleven_flash_v2_5` (fast, cheap). `eleven_multilingual_v2` sounds richer but uses more credits |

ElevenLabs has several different voices called Lauren, and the lookup only sees voices in **your** account. So: find the Lauren you like in the Voice Library, add it to My Voices, then run `node src/voice/eleven-voices.ts lauren` to see its id. If more than one matches, Kappa lists them and asks you to set `KAPPA_ELEVEN_VOICE_ID`.

Usage is billed in characters. `KAPPA_TTS_MAX_CHARS` (default 1500) caps one reply. `KAPPA_TTS_RATE` does not apply to ElevenLabs. Library voices can be restricted on the free plan; a 402 or 403 error means that.

Engines: Windows SAPI through PowerShell (Microsoft Zira, nothing to install), macOS `say`, Linux `espeak-ng`, and Piper (best quality, offline; long answers start after the first sentence).

## Not done yet

Hands-free mode (stop recording on silence, wake word) and spoken approvals. Both are deliberate omissions for now.
