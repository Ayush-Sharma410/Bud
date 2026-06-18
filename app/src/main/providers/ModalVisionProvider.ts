/**
 * Bud — Modal Vision Provider
 *
 * Calls the Modal-hosted VLM using an OpenAI-compatible endpoint via the
 * Vercel AI SDK. Streams responses back chunk-by-chunk.
 */
import { openai } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText, wrapLanguageModel, extractReasoningMiddleware } from 'ai';
import { VisionProvider, VisionRequest, VisionResponse } from './types';

export class ModalVisionProvider implements VisionProvider {
  private endpoint: string;
  private defaultEndpoint: string;
  private model: string;

  constructor(endpoint: string, model: string) {
    this.model = model;
    this.defaultEndpoint = endpoint;
    this.endpoint = endpoint;
    this.updateEndpointForModel(model);
  }

  setModel(model: string) {
    this.model = model;
    this.updateEndpointForModel(model);
  }

  private isOpenAIModel(model: string): boolean {
    const normalized = model.toLowerCase().trim();
    return (
      normalized.startsWith('gpt-') ||
      normalized.startsWith('gpot-') ||
      normalized.startsWith('gpot ') ||
      normalized === '5.1' ||
      normalized === 'gpt-5.1' ||
      normalized === '5.2' ||
      normalized === 'gpt-5.2' ||
      normalized === 'gpot 5.2'
    );
  }

  private updateEndpointForModel(model: string) {
    if (this.isOpenAIModel(model)) {
      this.endpoint = 'https://api.openai.com';
      console.log(`🔌 Route Vision to OpenAI using model: ${model}`);
    } else {
      this.endpoint = this.defaultEndpoint;
      console.log(`🔌 Route Vision to Modal VLM using model: ${model}`);
    }
  }

  private createLanguageModel(model: string) {
    if (this.isOpenAIModel(model)) {
      return openai(model);
    }

    const baseURL = this.endpoint.endsWith('/v1')
      ? this.endpoint
      : `${this.endpoint}/v1`;

    const modalProvider = createOpenAICompatible({
      name: 'modal',
      baseURL,
      headers: {
        'Modal-Session-ID': `bud-${Math.random().toString(36).substring(2, 15)}`,
      },
    });

    return wrapLanguageModel({
      model: modalProvider(model),
      middleware: [
        extractReasoningMiddleware({
          tagName: 'think',
          separator: '\n\n',
        }),
      ],
    });
  }

  async analyzeScreenWithTranscript(
    request: VisionRequest
  ): Promise<VisionResponse> {
    const { images, transcript, conversationHistory, systemPrompt, onChunk } = request;

    const messages: any[] = [];

    for (const entry of conversationHistory) {
      messages.push({ role: 'user', content: entry.userTranscript });
      messages.push({ role: 'assistant', content: entry.assistantResponse });
    }

    const currentContent: any[] = [];
    for (const capture of images) {
      if (!capture.imageBase64) continue;
      currentContent.push({
        type: 'image',
        image: `data:image/jpeg;base64,${capture.imageBase64}`,
      });
      const label = capture.isCursorScreen
        ? `Screen ${capture.screenIndex + 1} (primary focus, cursor is here)`
        : `Screen ${capture.screenIndex + 1}`;
      const dimensionInfo = `(image dimensions: ${capture.width}x${capture.height} pixels)`;
      currentContent.push({
        type: 'text',
        text: `${label} ${dimensionInfo}`,
      });
    }
    currentContent.push({ type: 'text', text: transcript });

    messages.push({ role: 'user', content: currentContent });

    const payloadMB = (
      JSON.stringify(messages).length / 1_048_576
    ).toFixed(1);
    console.log(
      `🌐 VLM streaming request: ${payloadMB}MB, ${images.filter((i) => i.imageBase64).length} image(s)`
    );

    const result = streamText({
      model: this.createLanguageModel(this.model),
      system: systemPrompt,
      messages,
      maxOutputTokens: 1024,
    });

    let accumulatedText = '';
    for await (const chunk of result.textStream) {
      accumulatedText += chunk;
      onChunk?.(accumulatedText);
    }

    return { text: accumulatedText };
  }
}
