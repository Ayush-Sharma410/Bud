"""
Bud VLM Service — Gemma 4 27B via SGLang on Modal (Low Latency)
Serves an OpenAI-compatible vision-language model endpoint.
The Electron app sends screenshots + user transcripts here.
"""
import asyncio
import json
import os
import subprocess
import time
import modal
import modal.experimental

# --- Model Config ---
MODEL_NAME = "google/gemma-4-26B-A4B-it"
MODEL_REVISION = "47b6801b24d15ff9bcd8c96dfaea0be9ed3a0301"

# --- Infrastructure Config ---
GPU = "H200:1"  # Hopper H200 GPU with 141 GB VRAM
REGION = "us-east"
MIN_CONTAINERS = 1  # Keep 1 container warm for low cold-start latency
TARGET_INPUTS = 10
PORT = 8000
MINUTES = 60

# --- Caching Volumes ---
HF_CACHE_VOL = modal.Volume.from_name("huggingface-cache", create_if_missing=True)
HF_CACHE_PATH = "/mnt/hf-cache"

# --- Container Image ---
# Start from SGLang runtime image
sglang_image = (
    modal.Image.from_registry("lmsysorg/sglang:v0.5.13.post1-cu129")
    .entrypoint([])  # silence chatty logs on container start
    .run_commands(
        "python3 -m pip install --force-reinstall --no-cache-dir 'typing_extensions>=4.13.0' 'pydantic>=2.9.0' 'pydantic-core>=2.27.0' requests",
    )
    .env(
        {
            "HF_HUB_CACHE": HF_CACHE_PATH,
            "HF_XET_HIGH_PERFORMANCE": "1",
        }
    )
)

app = modal.App(name="bud-vlm-serve")

with sglang_image.imports():
    import requests

def wait_ready(process: subprocess.Popen, timeout: int = 15 * MINUTES):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if (rc := process.poll()) is not None:
            raise subprocess.CalledProcessError(rc, cmd=process.args)
        try:
            resp = requests.get(f"http://127.0.0.1:{PORT}/health")
            if resp.status_code == 200:
                print("SGLang server is healthy and ready!")
                return
        except requests.exceptions.RequestException:
            pass
        time.sleep(5)
    raise TimeoutError(f"SGLang server not ready within {timeout} seconds")

def warmup():
    payload = {
        "model": MODEL_NAME,
        "messages": [{"role": "user", "content": "Hello, how are you?"}],
        "max_tokens": 16,
    }
    for i in range(3):
        try:
            print(f"Warmup query {i+1}/3...")
            requests.post(
                f"http://127.0.0.1:{PORT}/v1/chat/completions",
                json=payload,
                timeout=15
            ).raise_for_status()
        except Exception as e:
            print(f"Warmup error (ignoring): {e}")

@app.cls(
    image=sglang_image,
    gpu=GPU,
    volumes={HF_CACHE_PATH: HF_CACHE_VOL},
    region=REGION,
    min_containers=MIN_CONTAINERS,
    startup_timeout=20 * MINUTES,
    secrets=[modal.Secret.from_name("HF_TOKEN")],
)
@modal.experimental.http_server(
    port=PORT,
    proxy_regions=[REGION],
    exit_grace_period=15,
)
@modal.concurrent(target_inputs=TARGET_INPUTS)
class SGLangServer:
    @modal.enter()
    def startup(self):
        """Start the SGLang server and block until it is healthy, then warm it up."""
        cmd = [
            "python3",
            "-m",
            "sglang.launch_server",
            "--model-path",
            MODEL_NAME,
            "--revision",
            MODEL_REVISION,
            "--served-model-name",
            MODEL_NAME,
            "--host",
            "0.0.0.0",
            "--port",
            str(PORT),
            "--tp",
            "1",
            "--cuda-graph-max-bs",
            str(TARGET_INPUTS * 2),
            "--enable-metrics",
            "--decode-log-interval",
            "100",
        ]

        print("Starting SGLang with:", " ".join(cmd))
        self.process = subprocess.Popen(cmd)
        wait_ready(self.process)
        warmup()

    @modal.exit()
    def stop(self):
        self.process.terminate()
        self.process.wait()

# --- Local test entrypoint ---
@app.local_entrypoint()
async def test(test_timeout=10 * MINUTES):
    import aiohttp
    
    # Get the flash url (uses experimental http_server low-latency proxy)
    urls = await SGLangServer._experimental_get_flash_urls.aio()
    if not urls:
        raise RuntimeError("No HTTP server URLs returned from Modal")
    url = urls[0]
    print(f"Server deployed at: {url}")

    system_prompt = (
        "You are Bud, a helpful desktop companion. Sprinkle expressive vocal tags naturally in "
        "between your words. Use tags like [clear throat], [sigh], [laugh] sparingly."
    )
    
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": "What can you help me with?"},
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
        "Modal-Session-ID": "test-session-123",  # Test sticky routing header
    }

    print("Probing server with test streaming request...")
    deadline = time.time() + test_timeout
    
    # Simple retry loop to handle startup delay / 503 during cold-starts
    async with aiohttp.ClientSession(base_url=url, headers=headers) as session:
        while time.time() < deadline:
            try:
                async with session.post(
                    "/v1/chat/completions", json=payload, timeout=30
                ) as resp:
                    if resp.status == 503:
                        print("Server is starting up (503 Service Unavailable)... retrying in 5s")
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
                    print("\n[OK] Chat response finished successfully")
                    return
            except (aiohttp.ClientError, asyncio.TimeoutError) as e:
                print(f"Connection issue ({e}), retrying in 5s...")
                await asyncio.sleep(5)

    raise TimeoutError("Could not get a valid response from server within timeout")
