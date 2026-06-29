"""
Bud TTS Service — Chatterbox Turbo on Modal
Accepts text via HTTP POST, returns WAV audio bytes.
The Electron app sends VLM response text here to get spoken audio.
"""
import modal

# --- Container Image ---
image = modal.Image.debian_slim(python_version="3.10").uv_pip_install(
    "chatterbox-tts==0.1.6",
    "fastapi[standard]==0.124.4",
    "peft==0.18.0",
)

# --- App ---
app = modal.App("bud-tts-serve", image=image)

# --- Imports within image context ---
with image.imports():
    import io

    import torchaudio as ta
    from chatterbox.tts_turbo import ChatterboxTurboTTS
    from fastapi.responses import StreamingResponse


@app.cls(
    gpu="a10g",
    scaledown_window=300,  # 5 minutes
    secrets=[modal.Secret.from_name("HF_TOKEN")],
)
@modal.concurrent(max_inputs=10)
class ChatterboxTTS:
    @modal.enter()
    def load(self):
        self.model = ChatterboxTurboTTS.from_pretrained(device="cuda")

    @modal.fastapi_endpoint(docs=True, method="POST")
    def synthesize(self, text: str, exaggeration: float = 0.3,cfg_weight:float = 0.7):
        """Convert text to speech. Returns WAV audio stream."""
        audio_bytes = self.generate.local(text, exaggeration,cfg_weight)
        return StreamingResponse(
            io.BytesIO(audio_bytes),
            media_type="audio/wav",
            headers={"Content-Disposition": "attachment; filename=response.wav"},
        )

    @modal.method()
    def generate(self, text: str, exaggeration: float = 0.5, cfg_weight: float = 0.7) -> bytes:
        """Generate speech audio from text. Returns WAV bytes."""
        try:
            wav = self.model.generate(
                text,
                exaggeration=exaggeration,
                cfg_weight=cfg_weight
            )
        except TypeError:
            wav = self.model.generate(
                text,
                exaggeration=exaggeration
            )

        buffer = io.BytesIO()
        ta.save(buffer, wav, self.model.sr, format="wav")
        buffer.seek(0)
        return buffer.read()


# --- Local test ---
@app.local_entrypoint()
def test(
    text: str = "Hello! I'm Bud, your desktop companion. How can I help you today?",
):
    import pathlib

    tts = ChatterboxTTS()
    print(f"Generating speech for: '{text}'")
    audio_bytes = tts.generate.remote(text=text)

    output_path = pathlib.Path("./test_output.wav")
    output_path.write_bytes(audio_bytes)
    print(f"[OK] Audio saved to {output_path} ({len(audio_bytes)} bytes)")
