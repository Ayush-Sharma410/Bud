"""
Bud Orchestrator LLM Service — DeepSeek-R1-Distill-Llama-70B via SGLang on Modal.
Uses GPU memory snapshots for fast cold starts (~30s instead of 20+ min).

Snapshot flow:
  1. snap=True:  load weights → start SGLang → warmup → offload to CPU → snapshot
  2. snap=False: restore weights to GPU → ready to serve
"""
import asyncio
import json
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
TENSOR_PARALLEL_SIZE = 4
MAX_CONTEXT_LEN = 32768
MAX_RUNNING_REQUESTS = 8
REGION = "us-east"
PORT = 8000
MINUTES = 60
SNAPSHOT_GPU_MEMORY_THRESHOLD = 10.0  # GiB — wait until GPU mem drops below this before snapshotting

# --- Caching Volumes ---
HF_CACHE_VOL = modal.Volume.from_name("huggingface-cache", create_if_missing=True)
HF_CACHE_PATH = "/mnt/hf-cache"

# --- Container Image ---
# Uses the mattnappo/sglang fork which adds --enable-memory-saver and
# --enable-weights-cpu-backup for Modal GPU snapshots. Built on v0.5.0rc2.
sglang_image = (
    modal.Image.from_registry("lmsysorg/sglang:v0.5.0rc2-cu126")
    .entrypoint([])
    .pip_install(
        "huggingface_hub[hf_transfer]",
        "requests",
        extra_options="--no-build-isolation",
    )
    .run_commands("git clone https://github.com/mattnappo/sglang.git /sglang")
    .run_commands("pip uninstall -y sglang")
    .run_commands("cd /sglang && pip install -e python[all]")
    .env(
        {
            "HF_HUB_CACHE": HF_CACHE_PATH,
            "HF_XET_HIGH_PERFORMANCE": "1",
            "HF_HUB_ENABLE_HF_TRANSFER": "1",
            "PYTHONUNBUFFERED": "1",
            "TORCHINDUCTOR_COMPILE_THREADS": "1",
            "TMS_INIT_ENABLE_CPU_BACKUP": "1",
        }
    )
)

app = modal.App(name="bud-orchestrator-llm-serve")

with sglang_image.imports():
    import requests


def get_gpu_memory_usage():
    """Returns max GPU memory usage across all GPUs in GiB, or None on error."""
    try:
        result = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            encoding="utf-8",
        )
        # nvidia-smi returns one line per GPU — take the max
        usages = [float(line.strip()) / 1024 for line in result.strip().split("\n") if line.strip()]
        return max(usages) if usages else None
    except (subprocess.CalledProcessError, ValueError):
        return None


def wait_ready(process: subprocess.Popen, timeout: int = 60 * MINUTES):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if (rc := process.poll()) is not None:
            raise subprocess.CalledProcessError(rc, cmd=process.args)
        try:
            resp = requests.get(f"http://127.0.0.1:{PORT}/health")
            if resp.status_code == 200:
                print("[BUD-STARTUP] SGLang server is healthy and ready!", flush=True)
                return
        except requests.exceptions.RequestException:
            pass
        time.sleep(5)
    raise TimeoutError(f"SGLang server not ready within {timeout} seconds")


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
        print(f"[BUD-STARTUP] Weight pre-download failed (will let SGLang retry): {e}", flush=True)


def warmup():
    payload = {
        "model": MODEL_NAME,
        "messages": [{"role": "user", "content": "Hello"}],
        "max_tokens": 16,
    }
    for i in range(3):
        try:
            print(f"Warmup query {i+1}/3...")
            requests.post(
                f"http://127.0.0.1:{PORT}/v1/chat/completions",
                json=payload,
                timeout=120,
            ).raise_for_status()
        except Exception as e:
            print(f"Warmup error (ignoring): {e}")


@app.function(
    image=sglang_image,
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
    image=sglang_image,
    cpu=32,
    memory=256 * 1024,  # 256GB RAM — enough for CPU weight backup (~140GB)
    gpu=GPU,
    volumes={HF_CACHE_PATH: HF_CACHE_VOL},
    region=REGION,
    min_containers=0,  # Snapshots make cold starts fast — no need to keep warm
    timeout=60 * MINUTES,
    secrets=[modal.Secret.from_name("HF_TOKEN")],
    enable_memory_snapshot=True,
    experimental_options={"enable_gpu_snapshot": True},
    scaledown_window=10,
)
class SGLangServer:
    @modal.enter(snap=True)
    def _startup(self):
        """Load weights, start SGLang, warm up, then offload to CPU for a small GPU snapshot."""
        print("[BUD-STARTUP] Entering snap startup", flush=True)
        try:
            download_weights()

            cmd = [
                "python3",
                "-m",
                "sglang.launch_server",
                "--model-path",
                MODEL_NAME,
                "--served-model-name",
                MODEL_NAME,
                "--host",
                "0.0.0.0",
                "--port",
                str(PORT),
                "--tp",
                str(TENSOR_PARALLEL_SIZE),
                "--context-length",
                str(MAX_CONTEXT_LEN),
                "--cuda-graph-max-bs",
                "1",
                "--max-running-requests",
                str(MAX_RUNNING_REQUESTS),
                "--enable-memory-saver",
                "--enable-weights-cpu-backup",
                "--log-level",
                "info",
            ]

            print("[BUD-STARTUP] Starting SGLang:", " ".join(cmd), flush=True)
            self.process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )

            def _stream_output():
                for line in self.process.stdout:
                    print("[SGLANG]", line, end="", flush=True)

            threading.Thread(target=_stream_output, daemon=True).start()
            wait_ready(self.process)
            warmup()

            # Offload weights to CPU so the GPU snapshot is small (~few GB, not ~140GB)
            print("[BUD-STARTUP] Offloading weights to CPU for snapshot...", flush=True)
            requests.post(
                f"http://127.0.0.1:{PORT}/release_memory_occupation", json={}
            )

            # Wait for GPU memory to drop below threshold
            t0 = time.monotonic()
            for i in range(30):
                usage = get_gpu_memory_usage()
                if usage is not None:
                    print(f"[BUD-STARTUP] GPU memory: {usage:.2f}GB", flush=True)
                    if usage < SNAPSHOT_GPU_MEMORY_THRESHOLD:
                        print(
                            f"[BUD-STARTUP] GPU memory below threshold "
                            f"({time.monotonic() - t0:.1f}s) — snapshot ready",
                            flush=True,
                        )
                        return
                else:
                    print("[BUD-STARTUP] Could not read GPU memory", flush=True)
                    break
                time.sleep(1)
            print("[BUD-STARTUP] GPU memory still high, snapshotting anyway", flush=True)
        except Exception as e:
            print("[BUD-STARTUP-ERROR]", e, flush=True)
            traceback.print_exc()
            try:
                with open("/mnt/hf-cache/startup_error.log", "a", encoding="utf-8") as f:
                    f.write(f"{time.time()} - {e}\n")
                    traceback.print_exc(file=f)
            except Exception:
                pass
            raise

    @modal.enter(snap=False)
    def _restore(self):
        """Restore weights from CPU to GPU after snapshot restore."""
        print("[BUD-STARTUP] Restoring weights to GPU...", flush=True)
        try:
            requests.post(
                f"http://127.0.0.1:{PORT}/resume_memory_occupation", json={}
            )
            usage = get_gpu_memory_usage()
            if usage is not None:
                print(f"[BUD-STARTUP] GPU memory post-restore: {usage:.2f}GB", flush=True)
            print("[BUD-STARTUP] SGLang ready from snapshot", flush=True)
        except Exception as e:
            print(f"[BUD-STARTUP] Restore failed: {e}", flush=True)
            traceback.print_exc()
            raise

    @modal.exit()
    def stop(self):
        if hasattr(self, "process"):
            self.process.terminate()
            self.process.wait()

    @modal.web_server(port=PORT, startup_timeout=5 * MINUTES)
    def serve(self):
        """Web server endpoint — SGLang is already running from _startup."""
        return


# --- Local entrypoints ---
@app.local_entrypoint()
def download():
    """Run once to populate the Modal volume with model weights."""
    download_weights_to_volume.remote()
    print("Download job submitted. Weights will be cached in the Modal volume.")


@app.local_entrypoint()
def create_snapshot():
    """Deploy and trigger the first snapshot creation."""
    # The first deploy automatically runs _startup (snap=True) and creates the snapshot.
    # Subsequent cold starts restore from the snapshot via _restore (snap=False).
    print("Deploy with: modal deploy modal/llm_serve.py")
    print("The first container will create the GPU snapshot automatically.")


@app.local_entrypoint()
async def test(test_timeout=10 * MINUTES):
    import aiohttp

    test_timeout = int(test_timeout)

    urls = await SGLangServer._experimental_get_flash_urls.aio()
    if not urls:
        raise RuntimeError("No HTTP server URLs returned from Modal")
    url = urls[0]
    print(f"Orchestrator server deployed at: {url}")

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
        "Modal-Session-ID": "test-session-orchestrator",
    }

    print("Probing orchestrator server with test streaming request...")
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
                    print("\n[OK] Orchestrator chat response finished successfully")
                    return
            except Exception as e:
                print(f"Connection issue ({type(e).__name__}: {e}), retrying in 5s...")
                await asyncio.sleep(5)

    raise TimeoutError("Could not get a valid response from orchestrator server within timeout")
