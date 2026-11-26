# Kappa (phase 1: the brain)

A local agent for your PC: a terminal chatbot on Groq plus a harness that lets the model act through validated, permission-gated tools. No UI, voice, or MCP yet.

## Run

Requires Node >= 22.18. No runtime dependencies (SQLite is `node:sqlite`); Python is needed only for Python scripts.

```
npm install          # dev tools only (typescript, @types/node)
copy .env.example .env   # add GROQ_API_KEY
npm start            # npm start -- --resume to continue the last conversation
npm test             # no network needed
npm run typecheck
```
In the app: `/new`, `/model <name>`, `/exit`. **Ctrl+C cancels the running request** (model call, tool, or script process tree). Config is in `.env.example` (model, folders, limits). Default model `openai/gpt-oss-120b`; change it with `KAPPA_MODEL` or `/model`.

## How a request flows

`src/agent/execute-tool.ts` is the only path from a model tool call to a side effect:

lookup -> JSON parse -> schema validation (unknown args rejected) -> path validation -> `precheck` -> **permission check** -> timed execution -> truncated result back to the model.

Nothing is ever parsed from assistant prose. Every failure becomes a tool result the model can read and recover from. `src/agent/agent.ts` loops (max `KAPPA_MAX_ITERATIONS`, default 15) until the model answers.

## Permissions

Risk is declared by each tool and enforced by the harness; the model cannot see, set, or argue with it.

| Risk | Tools | Behaviour |
|---|---|---|
| low | web_search, web_fetch (hosts seen in search results), list/read/search/metadata, get_system_info, inspect_processes, get_execution_result, create_script, media_control, manage_window list, system_power cancel | runs |
| approval | web_fetch (a host not seen in search results; asked once per host), create/edit/move/copy file, download_file, clipboard (read and write), execute_script, open_application, manage_window actions | prompts `Approve? [y/N]` |
| high | delete_file, terminate_process, system_power shutdown/restart | prompts, marked HIGH RISK |

Only an explicit `true` from the approver passes. No approver, an error, or a non-`true` value means denied. Credentials (`.ssh`, `.env`, `*.pem`, browser login stores, ...) are blocked for every file tool and for scripts, even if the user would approve. Paths must resolve (symlinks included) inside `KAPPA_FS_ROOTS` (default: home + temp). Roots, home and Kappa's data folder can't be deleted or moved. Blocked or protected targets are refused before any prompt.

## Opening apps, clipboard, downloads, media

- `open_application` takes an app name ("spotify", "notepad"), a file/folder path or a URL. On Windows it tries the program directly, then PowerShell `Start-Process`, then the Start menu (classic and Store apps via `Get-StartApps`); the result says which app was actually opened. macOS uses `open -a`; Linux starts the program or uses `xdg-open`. It refuses scripts and installers (`.bat .ps1 .msi ...`), shells with arguments (`cmd /c ...`), credential paths and dangerous link schemes (`file:`, `ms-msdt:` ...): running code goes through `execute_script`, which shows the code first.
- `clipboard` reads or replaces the clipboard text. Both need approval (a read can expose a copied password).
- `download_file` saves an http(s) URL to a new file inside the allowed folders: public internet only (same guard as `web_fetch`), never overwrites, 200 MB cap, no partial files left behind.
- `media_control` is volume/mute and play/pause/next/previous. It uses media keys (Windows), `osascript` (macOS: volume only), `pactl` and `playerctl` (Linux).

## Voice

`/voice on` makes Kappa read her replies aloud in a female voice; `/listen` lets you talk instead of type (press Enter to stop). Needs ffmpeg for the microphone; speech recognition uses Groq (same key) or offline whisper.cpp. Details and settings: `src/voice/README.md`.

## Providers

Set any of `GROQ_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`. At the prompt, `/provider` shows the active one and `/provider mistral` switches (each provider keeps its own model: `KAPPA_GROQ_MODEL`, `KAPPA_GEMINI_MODEL`, `KAPPA_MISTRAL_MODEL`). Mistral's API needs 9-character tool call ids and an assistant message between a tool result and a user message; Kappa converts the history on the way out, so switching between providers mid-conversation is safe. Switching is manual and only happens between requests, never mid-task: Gemini 3 rejects tool-call history that lacks its thought signatures, which a task handed over from another provider would not have. When a request fails with a rate-limit or server error, Kappa suggests the other provider. `GROQ_BASE_URL` can point the groq slot at any OpenAI-compatible server (e.g. OmniRoute). The free tiers of Gemini and Mistral may use your content to train their models; Groq's terms differ, check them.

## Token usage

Every model call re-sends the tool schemas and system prompt (about 7,000 characters, roughly 2,000 tokens; a test fails if it grows past 8,000). A turn that uses a tool is at least two calls. Savings built in: terse schemas, `reasoning_effort` low for gpt-oss (`KAPPA_REASONING`), tool results capped at 12,000 characters (`KAPPA_MAX_RESULT_CHARS`), history capped at 40,000 characters (`KAPPA_CONTEXT_CHARS`), and results from earlier turns clipped to 300 characters when re-sent (the database keeps them in full). Estimates use ~3.5 characters per token; check the real numbers in the Groq console.

## Web access

`web_search` uses Tavily when `TAVILY_API_KEY` is set (free tier; one call returns a short answer plus sources, and is much more reliable), otherwise it scrapes DuckDuckGo's HTML endpoint, which often shows a bot check; `web_fetch` returns a page's readable text. Both reach the public internet only: local/private addresses are refused (checked on the literal address, after DNS, and on every redirect hop). Wikipedia is trusted by default. Fetching any other host that did not appear in search results needs your approval, so a hostile page cannot silently make the model send data to an address of its choosing.

Limits: DuckDuckGo may show a bot check or change its markup (the tool then reports it); pages rendered by JavaScript (many sports-standings sites) come back nearly empty; PDFs are unsupported; DNS rebinding between the check and the request is not prevented.

## Script sandbox: what it is and is not

Scripts run in a private run folder (`~/.kappa/runs/<id>`), with a scrubbed environment (your API key is not inherited), a timeout, output caps, and whole-process-tree kill. The user sees the full code and the exact folders granted before approving.

- **JavaScript**: Node's permission model. OS-enforced file read/write limits and child processes blocked. Network is *not* restricted.
- **Python**: an in-process audit hook blocks writes outside granted folders, reads of protected secrets, subprocesses and sockets. **This is a guardrail, not a security boundary**: a determined script can evade it. Python reads elsewhere are not restricted.
- No memory/CPU cap on Python (Windows has no simple equivalent from Node).

For untrusted code you need a real boundary (container or Windows Sandbox). Until then the approval prompt, which shows the code, is the actual safety control.

## Data

`~/.kappa/kappa.db` (conversations), `logs/kappa.log` (JSON lines: every tool call, approval decision, args and results clipped, API key redacted), `scripts/`, `runs/`.

## Known limits

- Not run against the live Groq API from the dev environment (see tests: client verified against a fake streaming server). First real run may need model/rate-limit tuning; 21 tool schemas cost tokens on small free-tier limits.
- Windows-only tools (`manage_window`, the PowerShell paths in `open_application`, `clipboard` and `media_control`) and the Windows `shutdown`/`tasklist` commands are written but were developed on Linux and not executed on Windows.
- History is trimmed by whole old turns at `KAPPA_CONTEXT_CHARS`; there is no summarisation.
- `delete_file` is permanent (no recycle bin).