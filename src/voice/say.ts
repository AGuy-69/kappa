// Try the voice without touching Kappa:  node src/voice/say.ts "Hello, I'm Kappa."
// Settings come from the same KAPPA_TTS_* environment variables the module reads.
import { createSpeaker, ttsOptionsFromEnv } from './tts/index.ts';

try {
  const text = process.argv.slice(2).join(' ') || "Hello, I'm Kappa. How can I help?";
  const speaker = createSpeaker(ttsOptionsFromEnv());
  console.log(`voice engine: ${speaker.name}`);
  process.on('SIGINT', () => { speaker.stop(); process.exit(0); });
  await speaker.speak(text);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
