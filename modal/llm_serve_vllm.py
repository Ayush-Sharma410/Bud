"""
Bud Orchestrator LLM Service — DeepSeek-R1-Distill-Llama-70B via vLLM on Modal.
Alternative to SGLang for large MoE models.
"""
import asyncio
import os
import subprocess
import sys
import threading
import time
import traceback
import modal
import modal.experimental

# --- Model Config ---
MODEL_NAME = "deepseek-ai/DeepSeek-R1-Distill-Llama-70B"

# --- Infrastructure Config ---
GPU = "H100:4"  # 4× H100: 70B BF16 = ~35GB/GPU, leaving ~45GB/GPU for KV cache
REGION = "us-east"
MIN_CONTAINERS = 1
TARGET_INPUTS = 8
PORT = 8000
MINUTES = 60

# --- Caching Volumes ---
HF_CACHE_VOL = modal.Volume.from_name("huggingface-cache", create_if_missing=True)
HF_CACHE_PATH = "/mnt/hf-cache"

# --- Container Image ---
vllm_image = (
    modal.Image.from_registry(
        "vllm/vllm-openai:latest",
        setup_dockerfile_commands=[
            "RUN ln -s $(which python3) /usr/local/bin/python",
        ],
    )
    .entrypoint([])
    .run_commands(
        "python3 -m pip install --force-reinstall --no-cache-dir 'typing_extensions>=4.13.0' 'pydantic>=2.9.0' 'pydantic-core>=2.27.0' 'transformers>=4.51.0' requests",
    )
    .env(
        {
            "HF_HOME": HF_CACHE_PATH,
            "HF_HUB_CACHE": HF_CACHE_PATH,
            "HF_XET_HIGH_PERFORMANCE": "1",
            "PYTHONUNBUFFERED": "1",
        }
    )
)

app = modal.App(name="bud-orchestrator-vllm-serve")

with vllm_image.imports():
    import requests


def wait_ready(process: subprocess.Popen, timeout: int = 60 * MINUTES):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if (rc := process.poll()) is not None:
            raise subprocess.CalledProcessError(rc, cmd=process.args)
        try:
            resp = requests.get(f"http://127.0.0.1:{PORT}/health")
            if resp.status_code == 200:
                print("[BUD-STARTUP] vLLM orchestrator server is healthy and ready!", flush=True)
                return
        except requests.exceptions.RequestException:
            pass
        time.sleep(5)
    raise TimeoutError(f"vLLM orchestrator server not ready within {timeout} seconds")


def download_weights(local_files_only: bool = False):
    """Pre-download model weights single-process to avoid TP-process file-lock contention."""
    try:
        from huggingface_hub import snapshot_download

        print(f"[BUD-STARTUP] Pre-downloading weights for {MODEL_NAME}...", flush=True)
        snapshot_download(
            MODEL_NAME,
            cache_dir=HF_CACHE_PATH,
            local_files_only=local_files_only,
        )
        print(f"[BUD-STARTUP] Weights pre-downloaded to {HF_CACHE_PATH}", flush=True)
    except Exception as e:
        print(f"[BUD-STARTUP] ⚠️ Weight pre-download failed: {e}", flush=True)


def warmup():
    payload = {
        "model": MODEL_NAME,
        "messages": [{"role": "user", "content": "Hello"}],
        "max_tokens": 16,
    }
    for i in range(3):
        try:
            print(f"[BUD-STARTUP] Warmup query {i+1}/3...", flush=True)
            requests.post(
                f"http://127.0.0.1:{PORT}/v1/chat/completions",
                json=payload,
                timeout=120,
            ).raise_for_status()
        except Exception as e:
            print(f"[BUD-STARTUP] Warmup error (ignoring): {e}", flush=True)


@app.function(
    image=vllm_image,
    gpu="H100:1",
    volumes={HF_CACHE_PATH: HF_CACHE_VOL},
    region=REGION,
    timeout=90 * MINUTES,
    secrets=[modal.Secret.from_name("HF_TOKEN")],
)
def download_weights_to_volume():
    """One-shot weight download into the shared Modal volume."""
    download_weights(local_files_only=False)


@app.cls(
    image=vllm_image,
    gpu=GPU,
    volumes={HF_CACHE_PATH: HF_CACHE_VOL},
    region=REGION,
    min_containers=MIN_CONTAINERS,
    startup_timeout=60 * MINUTES,
    secrets=[modal.Secret.from_name("HF_TOKEN")],
)
@modal.experimental.http_server(
    port=PORT,
    proxy_regions=[REGION],
    exit_grace_period=25,
)
@modal.concurrent(target_inputs=TARGET_INPUTS)
class VLLMServer:
    @modal.enter()
    def startup(self):
        """Pre-download weights, start vLLM server, block until healthy, then warm up."""
        print("[BUD-STARTUP] Entering startup", flush=True)
        try:
            download_weights()

            cmd = [
                "python3",
                "-m",
                "vllm.entrypoints.openai.api_server",
                "--model",
                MODEL_NAME,
                "--served-model-name",
                MODEL_NAME,
                "--host",
                "0.0.0.0",
                "--port",
                str(PORT),
                "--tensor-parallel-size",
                "4",
                "--max-model-len",
                "32768",
                "--max-num-seqs",
                "8",
                "--enable-reasoning",
                "--reasoning-parser",
                "deepseek_r1",
                "--enable-auto-tool-choice",
                "--tool-call-parser",
                "hermes",
            ]

            print("[BUD-STARTUP] Starting vLLM orchestrator with:", " ".join(cmd), flush=True)
            self.process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )

            def _stream_output():
                for line in self.process.stdout:
                    print("[VLLM]", line, end="", flush=True)

            threading.Thread(target=_stream_output, daemon=True).start()
            wait_ready(self.process)
            warmup()
            print("[BUD-STARTUP] vLLM orchestrator is ready", flush=True)
        except Exception as e:
            print("[BUD-STARTUP-ERROR]", e, flush=True)
            traceback.print_exc()
            try:
                with open("/mnt/hf-cache/vllm_startup_error.log", "a", encoding="utf-8") as f:
                    f.write(f"{time.time()} - {e}\n")
                    traceback.print_exc(file=f)
            except Exception:
                pass
            raise

    @modal.exit()
    def stop(self):
        self.process.terminate()
        self.process.wait()


@app.local_entrypoint()
def download():
    """Run once to populate the Modal volume with model weights."""
    download_weights_to_volume.remote()
    print("Download job submitted. Weights will be cached in the Modal volume.")


@app.local_entrypoint()
async def test(test_timeout=30 * MINUTES):
    import aiohttp

    test_timeout = int(test_timeout)

    urls = await VLLMServer._experimental_get_flash_urls.aio()
    if not urls:
        raise RuntimeError("No HTTP server URLs returned from Modal")
    url = urls[0]
    print(f"vLLM orchestrator server deployed at: {url}")

    messages = [
        {"role": "system", "content": "You are Bud, a helpful desktop companion."},
        {"role": "user", "content": "What is 2+2?"},
    ]

    payload = {
        "messages": messages,
        "model": MODEL_NAME,
        "stream": True,
        "max_tokens": 100,
    }

    headers = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "Modal-Session-ID": "test-session-orchestrator-vllm",
    }

    print("Probing vLLM orchestrator server with test streaming request...")
    deadline = time.time() + test_timeout

    async with aiohttp.ClientSession(base_url=url, headers=headers) as session:
        while time.time() < deadline:
            try:
                async with session.post(
                    "/v1/chat/completions", json=payload, timeout=120
                ) as resp:
                    if resp.status == 503:
                        print("Server is starting up (503)... retrying in 5s")
                        await asyncio.sleep(5)
                        continue

                    resp.raise_for_status()
                    async for raw in resp.content:
                        line = raw.decode().strip()
                        if not line or line == "data: [DONE]":
                            continue
                        if line.startswith("data: "):
                            line = line[len("data: ") :]
                        try:
                            chunk = json.loads(line)
                            delta = chunk["choices"][0]["delta"]
                            content = delta.get("content", "")
                            if content:
                                print(content, end="", flush=True)
                        except json.JSONDecodeError:
                            continue
                    print("\n[OK] vLLM orchestrator chat response finished successfully")
                    return
            except Exception as e:
                print(f"Connection issue ({type(e).__name__}: {e}), retrying in 5s...")
                await asyncio.sleep(5)

    raise TimeoutError("Could not get a valid response from vLLM orchestrator server within timeout")
