/**
 * Bud — Ollama Vision Provider
 *
 * Calls a local Ollama VLM (like LLaVA) using Ollama's chat API.
 * Translates the VisionRequest to Ollama format and handles chunked streaming.
 */
import { VisionProvider, VisionRequest, VisionResponse } from './types';

export class OllamaVisionProvider implements VisionProvider {
  private endpoint: string;
  private model: string;

  constructor(endpoint: string, model: string) {
    this.endpoint = endpoint;
    this.model = model;
  }

  setModel(model: string) {
    this.model = model;
  }

  async analyzeScreenWithTranscript(
    request: VisionRequest
  ): Promise<VisionResponse> {
    const { images, transcript, conversationHistory, systemPrompt, onChunk } =
      request;

    // Build messages in Ollama chat format
    const messages: any[] = [
      { role: 'system', content: systemPrompt },
    ];

    for (const entry of conversationHistory) {
      messages.push({ role: 'user', content: entry.userTranscript });
      messages.push({ role: 'assistant', content: entry.assistantResponse });
    }

    // Build the user prompt and attach images
    const imagesBase64: string[] = [];
    let promptText = transcript;

    for (const capture of images) {
      if (!capture.imageBase64) continue;
      imagesBase64.push(capture.imageBase64);
      const label = capture.isCursorScreen
        ? `Screen ${capture.screenIndex + 1} (primary focus, cursor is here)`
        : `Screen ${capture.screenIndex + 1}`;
      promptText += `\n[Image Context: ${label}, dimensions: ${capture.width}x${capture.height}px]`;
    }

    messages.push({
      role: 'user',
      content: promptText,
      images: imagesBase64,
    });

    const body = {
      model: this.model,
      messages,
      stream: true,
    };

    console.log(`🌐 Local Ollama VLM request: ${this.model} at ${this.endpoint}`);

    const response = await fetch(`${this.endpoint}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Ollama API error (${response.status}): ${errorBody}`);
    }

    if (!response.body) {
      throw new Error('Ollama response has no body');
    }

    let accumulatedText = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const chunk = JSON.parse(trimmed);
          const content = chunk.message?.content;
          if (content) {
            accumulatedText += content;
            onChunk?.(accumulatedText);
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }

    return { text: accumulatedText };
  }
}
