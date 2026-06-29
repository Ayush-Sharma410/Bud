/**
 * Bud — Agent Manager
 *
 * Manages the shared ActionQueue and ActionExecutor used by computerUseTool.
 * Provides abort/status API for active computer-use actions.
 *
 * There is exactly one AgentManager instance, created in main.ts.
 */

import { VisionProvider, TTSProvider } from './providers/types';
import { ActionExecutor } from './actionExecutor';
import { ActionQueue } from './actionQueue';
import { AudioPlaybackManager } from './providers/ModalTTSProvider';

// --- Types ---

export interface AgentManagerOptions {
  visionProvider: VisionProvider;
  ttsProvider: TTSProvider;
  audioPlayback: AudioPlaybackManager;
  actionExecutor?: ActionExecutor;
  actionQueue?: ActionQueue;
}

// --- Agent Manager ---

export class AgentManager {
  private visionProvider: VisionProvider;
  private ttsProvider: TTSProvider;
  private audioPlayback: AudioPlaybackManager;
  public actionExecutor: ActionExecutor;
  public actionQueue: ActionQueue;

  /** Callback for narration — wired to TTS playback in main.ts */
  private onNarrate: ((text: string) => void | Promise<void>) | null = null;

  constructor(options: AgentManagerOptions) {
    this.visionProvider = options.visionProvider;
    this.ttsProvider = options.ttsProvider;
    this.audioPlayback = options.audioPlayback;
    this.actionExecutor = options.actionExecutor || new ActionExecutor();
    this.actionQueue = options.actionQueue || new ActionQueue();
  }

  /**
   * Set the narration callback. Called by main.ts to wire TTS playback.
   */
  setOnNarrate(callback: (text: string) => void | Promise<void>) {
    this.onNarrate = callback;
  }

  /**
   * Abort all pending actions in the queue.
   * Called by Escape key or "stop" voice command.
   */
  abortAll() {
    this.actionQueue.clear();
    console.log('🛑 Action queue cleared');
  }

  /**
   * Check if the action queue has pending work.
   */
  hasActiveTasks(): boolean {
    return false; // No autonomous agent tasks — computerUseTool actions are synchronous per-call
  }

  /**
   * Get info about currently active tasks (stub — no autonomous tasks).
   */
  getActiveTasks(): Array<{ taskId: string; status: string }> {
    return [];
  }

  /**
   * Update providers when the user switches between Modal and Local.
   */
  setProviders(providers: {
    visionProvider: VisionProvider;
    ttsProvider: TTSProvider;
  }) {
    this.visionProvider = providers.visionProvider;
    this.ttsProvider = providers.ttsProvider;
  }

  // --- Internal ---

  async handleNarration(text: string) {
    console.log(`🗣️ Agent narration: "${text}"`);
    if (this.onNarrate) {
      await this.onNarrate(text);
    }
  }
}
