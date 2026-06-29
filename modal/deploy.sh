#!/bin/bash
# Bud Modal Backend — Deploy all three services
# Run from the repo root: bash modal/deploy.sh
#
# Prerequisites:
#   - modal CLI installed and authenticated (modal setup)
#   - HuggingFace token set as Modal secret: modal secret create hf-token HF_TOKEN=hf_xxx
#
# This deploys:
#   1. VLM  — Gemma 4 27B via vLLM (H200 GPU)
#   2. STT  — Whisper Large v3 (A10G GPU)
#   3. TTS  — Chatterbox Turbo (A10G GPU)

set -e

echo "=== Bud Modal Backend Deploy ==="
echo ""

# Step 1: Download Whisper model weights first (avoids cold-start download)
echo "📦 Pre-caching Whisper model weights..."
modal run modal/stt_serve.py
echo ""

# Step 2: Deploy all three services
echo "🚀 Deploying VLM service (Gemma 4 27B via vLLM)..."
modal deploy modal/vlm_serve.py
echo ""

echo "🚀 Deploying STT service (Whisper Large v3)..."
modal deploy modal/stt_serve.py
echo ""

echo "🚀 Deploying TTS service (Chatterbox Turbo)..."
modal deploy modal/tts_serve.py
echo ""

echo "=== All services deployed! ==="
echo ""
echo "Your endpoint URLs will be shown above. Save them for the Electron app config."
echo "Format: https://lautonomy--bud-{service}-serve-{function}.modal.run"
echo ""
echo "To test each service:"
echo "  modal run modal/vlm_serve.py   # Health check + test chat"
echo "  modal run modal/tts_serve.py   # Generate test audio"
