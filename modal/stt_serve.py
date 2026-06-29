"""
Bud STT Service — Whisper Large v3 on Modal
Accepts audio file uploads via HTTP POST, returns transcript JSON.
The Electron app sends recorded push-to-talk audio here.
"""
import modal
from fastapi import Request

# --- Config ---
MODEL_DIR = "/model"
MODEL_NAME = "openai/whisper-large-v3"
MODEL_REVISION = "afda370583db9c5359511ed5d989400a6199dfe1"

# --- Container Image ---
image = (
    modal.Image.debian_slim(python_version="3.11")
    .uv_pip_install(
        "torch==2.5.1",
        "transformers==4.47.1",
        "huggingface-hub==0.36.0",
        "librosa==0.10.2",
        "soundfile==0.12.1",
        "accelerate==1.2.1",
        "fastapi[standard]==0.124.4",
    )
    .env({"HF_XET_HIGH_PERFORMANCE": "1", "HF_HUB_CACHE": MODEL_DIR})
)

# --- Volumes ---
model_cache = modal.Volume.from_name("hf-hub-cache", create_if_missing=True)

# --- App ---
app = modal.App("bud-stt-serve", image=image, volumes={MODEL_DIR: model_cache})


@app.function()
def download_model():
    """Pre-download model weights to cache volume."""
    from huggingface_hub import snapshot_download
    from transformers.utils import move_cache

    snapshot_download(
        MODEL_NAME,
        ignore_patterns=["*.pt", "*.bin"],
        revision=MODEL_REVISION,
    )
    move_cache()


@app.cls(
    gpu="a10g",
    scaledown_window=300,  # 5 minutes
    max_containers=5,
)
class WhisperSTT:
    @modal.enter()
    def load_model(self):
        import torch
        from transformers import (
            AutoModelForSpeechSeq2Seq,
            AutoProcessor,
            pipeline,
        )

        self.processor = AutoProcessor.from_pretrained(MODEL_NAME)
        self.model = AutoModelForSpeechSeq2Seq.from_pretrained(
            MODEL_NAME,
            torch_dtype=torch.float16,
            low_cpu_mem_usage=True,
            use_safetensors=True,
        ).to("cuda")

        self.model.generation_config.language = "<|en|>"

        self.pipeline = pipeline(
            "automatic-speech-recognition",
            model=self.model,
            tokenizer=self.processor.tokenizer,
            feature_extractor=self.processor.feature_extractor,
            torch_dtype=torch.float16,
            device="cuda",
        )

    @modal.fastapi_endpoint(docs=True, method="POST")
    async def transcribe(self, request: Request = None):
        """Accept audio file upload and return transcript."""
        import io
        import tempfile

        import librosa
        import soundfile as sf
        from fastapi import Request
        from fastapi.responses import JSONResponse

        # Read raw audio bytes from request body
        body = await request.body()

        # Load audio from bytes
        audio_data, sr = sf.read(io.BytesIO(body))

        # Resample to 16kHz if needed (Whisper expects 16kHz)
        if sr != 16000:
            audio_data = librosa.resample(audio_data, orig_sr=sr, target_sr=16000)
            sr = 16000

        # Run transcription
        result = self.pipeline(
            {"raw": audio_data, "sampling_rate": sr},
            return_timestamps=False,
        )

        return JSONResponse(
            content={
                "text": result["text"],
                "model": MODEL_NAME,
            }
        )

    @modal.method()
    def transcribe_audio(self, audio_bytes: bytes) -> dict:
        """Transcribe audio bytes directly (for Modal-to-Modal calls)."""
        import io

        import librosa
        import soundfile as sf

        audio_data, sr = sf.read(io.BytesIO(audio_bytes))
        if sr != 16000:
            audio_data = librosa.resample(audio_data, orig_sr=sr, target_sr=16000)
            sr = 16000

        result = self.pipeline(
            {"raw": audio_data, "sampling_rate": sr},
            return_timestamps=False,
        )
        return {"text": result["text"], "model": MODEL_NAME}


# --- Local test ---
@app.local_entrypoint()
def test():
    print("Downloading model weights...")
    download_model.remote()
    print("[OK] Model downloaded")

    # Generate a simple test tone and transcribe it
    print("STT service ready. Deploy with: modal deploy stt_serve.py")
