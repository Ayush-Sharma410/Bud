# Open-Source Models on Modal, No Commercial AI APIs

Clicky depends on three commercial APIs: Anthropic (Claude for vision + chat), ElevenLabs (TTS), and AssemblyAI (STT), proxied through a Cloudflare Worker. Bud replaces all three with open-source models running on Modal's serverless GPU infrastructure (H100/H200), with a local Ollama fallback for users who want zero third-party dependencies.

This eliminates vendor lock-in, keeps the entire AI stack open-source, and consolidates all GPU compute into a single platform (Modal) instead of managing three separate API accounts. The developer has $4,000 in Modal credits, which is sufficient for extended development and personal use.

The Cloudflare Worker proxy is dropped entirely — Modal web endpoints serve the same purpose (holding no API keys in the app binary) without an additional infrastructure layer.

## Stack

| Layer | Primary (Modal) | Fallback (Local) |
|-------|-----------------|-------------------|
| STT | Whisper Large v3 Turbo | Windows Speech Recognition |
| Vision + LLM | Gemma 4 27B via vLLM (OpenAI-compatible API) | Ollama with LLaVA |
| TTS | Chatterbox | Piper TTS (CPU) |

## Consequences

- **Cold start latency**: Modal scales to zero. First request after inactivity takes 30s–2min for vLLM to load the model. Mitigated by setting a longer `scaledown_window`.
- **Element pointing accuracy**: Gemma 4 27B may be less precise than Claude Sonnet at outputting pixel coordinates for UI elements. Upgradeable to Qwen2.5-VL 72B without app code changes since vLLM uses the OpenAI-compatible API.
- **Credit burn**: H200 GPU time is ~$4/hr on Modal. Personal use with occasional queries should last months on $4K.
