import {
  createIdGenerator,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  type UIMessage,
  convertToModelMessages,
  stepCountIs,
  generateText,
  smoothStream,
} from 'ai';
import { openai } from '@ai-sdk/openai';
import { groq } from '@ai-sdk/groq';
import { NextRequest } from 'next/server';
import { buildSystemPrompt } from '@/lib/prompts';
import { models, DEFAULT_MODEL_NAME, OPENAI_REASONING_MODEL_IDS } from '@/lib/ai/models';
import { webSearch, exaGetContents } from '@/lib/client-side-tools/webSearch';
import { lautonomyDBTool } from '@/lib/client-side-tools/lautonomyDBTool';
import { createSendEmailTool } from '@/lib/client-side-tools/send-email';
// import { treatyKnowledgeGraphTool } from '@/lib/client-side-tools/treatyKnowledgeGraphTool';
import { createVisualizationTool } from '@/lib/client-side-tools/visualizationTool';
import { docBuilderTool } from '@/lib/client-side-tools/docBuilderTool';
import { databaseOperationsTool } from '@/lib/client-side-tools/databaseOperationsTool';
// import { legalAnalysisTool } from '@/lib/client-side-tools/legalAnalysisTool';
import { documentEditingTool } from '@/lib/client-side-tools/documentEditingTool';
import { datasetBuilderTool } from '@/lib/client-side-tools/datasetBuilder';
import { ragSearch } from '@/lib/client-side-tools/ragSearch';
import { prisma } from '@/lib/prisma';
const db = prisma as any;
import { getServerAuthSession } from '@/lib/auth';
import { logUsageEvent } from '@/lib/usage';

export const maxDuration = 500;

export async function POST(req: NextRequest) {
  try {
    const body: any = await req.json();
    const sessionAuth = await getServerAuthSession();
    const userId = sessionAuth?.user?.id as string | undefined;

    // Server-side quota check: block requests when credits are exhausted
    if (userId) {
      const userRow = await db.user.findUnique({ where: { id: userId }, select: { creditBalanceCents: true, billingMode: true } });
      if (userRow && userRow.billingMode === 'free_tier' && (userRow.creditBalanceCents ?? 0) <= 0) {
        return new Response(
          JSON.stringify({ error: 'Credits exhausted. Please upgrade your plan to continue.' }),
          { status: 402, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    const providedChatId: string | undefined = body.chatId; // id may be undefined for new chats
    const singleMessage: UIMessage | undefined = body.message; // preferred minimal payload
    const providedMessages: UIMessage[] | undefined = body.messages; // optional fallback
    const selectedModelId: string | undefined = body.model; // new: model selection
    const selectedTools: string[] | undefined = Array.isArray(body.selectedTools) ? body.selectedTools : undefined;
    // Reasoning effort: from body, or default 'medium' for reasoning models (set after we know selectedModel)
    let reasoningEffortRaw = body.reasoningEffort === 'medium' ? 'medium' : 'none';

    // Accept provided chatId if valid UUID; do not touch DB before streaming
    const isValidUuid = (v?: string) => !!v && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(v || '');
    let chatSessionId = isValidUuid(providedChatId) ? providedChatId : undefined;

    // Resolve organisationId (prefer explicit param/body, then existing chat; do not fall back to session/user)
    const { searchParams } = new URL(req.url);
    const orgParam = searchParams.get('organisationId') || undefined;
    let resolvedOrganisationId: string | null = null;

    if (isValidUuid(orgParam as string | undefined)) {
      resolvedOrganisationId = orgParam!;
    } else if (isValidUuid(body?.organisationId as string | undefined)) {
      resolvedOrganisationId = body.organisationId as string;
    } else if (chatSessionId) {
      try {
        const cs = await db.chatSession.findUnique({ where: { id: chatSessionId }, select: { organisationId: true } });
        if (isValidUuid(cs?.organisationId as string | undefined)) resolvedOrganisationId = cs!.organisationId!;
      } catch { }
    }

    // Validate resolved org id against DB to avoid FK violations
    let safeOrganisationId: string | null = null;
    try {
      if (resolvedOrganisationId && isValidUuid(resolvedOrganisationId)) {
        const org = await db.organisation.findUnique({ where: { id: resolvedOrganisationId }, select: { id: true } });
        if (org?.id) safeOrganisationId = org.id;
      }
    } catch { }

    console.log('[streamchat] userId:', userId || null, 'orgParam:', orgParam || null, 'body.org:', body?.organisationId || null, 'chatId:', chatSessionId || null, 'resolvedSafeOrg:', safeOrganisationId || null);

    // Ensure the session user has an organisationId when resolvable (do not overwrite existing)
    try {
      if (userId && safeOrganisationId) {
        const u2 = await db.user.findUnique({ where: { id: userId }, select: { organisationId: true } });
        if (!u2?.organisationId) await db.user.update({ where: { id: userId }, data: { organisationId: safeOrganisationId } });
      }
    } catch { }

    // If a chat session was provided, ensure it exists and carries org/user linkage (do not overwrite non-null org)
    try {
      if (chatSessionId && (safeOrganisationId || userId)) {
        const cs0 = await db.chatSession.findUnique({ where: { id: chatSessionId }, select: { organisationId: true, userId: true } });
        if (cs0) {
          // Session exists, update it if needed
          const updates0: any = {};
          if (!cs0.organisationId && safeOrganisationId) updates0.organisationId = safeOrganisationId;
          if (!cs0.userId && userId) updates0.userId = userId;
          if (Object.keys(updates0).length > 0) {
            await db.chatSession.update({ where: { id: chatSessionId }, data: updates0 });
          }
        } else {
          // Session doesn't exist, create it with the provided chatId
          await db.chatSession.create({
            data: {
              id: chatSessionId,
              userId: userId || null,
              organisationId: safeOrganisationId,
            },
          });
        }
      }
    } catch (error) {
      console.error('Failed to ensure chat session exists:', error);
    }

    // Load previous messages if only last message is sent
    let hydratedMessages: UIMessage[] = [];
    if (singleMessage) {
      if (chatSessionId) {
        try {
          const previous = await db.chatMessage.findMany({
            where: { chatId: chatSessionId },
            orderBy: { createdAt: 'asc' },
          });
          const uiPrev = previous.map((m: any) => ({ id: m.messageId, role: m.role as any, parts: m.parts as any }));
          hydratedMessages = [...uiPrev, singleMessage];
        } catch {
          hydratedMessages = [singleMessage];
        }
      } else {
        hydratedMessages = [singleMessage];
      }
    } else if (Array.isArray(providedMessages)) {
      hydratedMessages = providedMessages;
    } else {
      hydratedMessages = [];
    }

    // Limit conversation history
    const maxMessages = 20;
    const truncatedMessages = hydratedMessages.slice(-maxMessages);

    // Model
    const modelId = selectedModelId || DEFAULT_MODEL_NAME;
    const selectedModel = models.find(m => m.id === modelId) || models.find(m => m.id === DEFAULT_MODEL_NAME);
    if (!selectedModel) throw new Error(`Model not found: ${modelId}`);

    let modelInstance;
    switch (selectedModel.provider) {
      case 'openai': modelInstance = openai(selectedModel.apiIdentifier); break;
      case 'groq': modelInstance = groq(selectedModel.apiIdentifier); break;
      default: modelInstance = openai(selectedModel.apiIdentifier);
    }

    // Get user's email for email tool context
    const userEmail = sessionAuth?.user?.email || null;

    // Linked sources from AttachSourcesDropdown or @ mentions — used for RAG and context
    const linkedAgentId = typeof body.linkedAgentId === 'string' ? body.linkedAgentId.trim() || undefined : undefined;
    const linkedAgentName = typeof body.linkedAgentName === 'string' ? body.linkedAgentName.trim() : undefined;
    const linkedDatasetId = typeof body.linkedDatasetId === 'string' ? body.linkedDatasetId.trim() || undefined : undefined;
    const linkedDatasetName = typeof body.linkedDatasetName === 'string' ? body.linkedDatasetName.trim() : undefined;
    const linkedRoomId = typeof body.linkedRoomId === 'string' ? body.linkedRoomId.trim() || undefined : undefined;
    const linkedRoomName = typeof body.linkedRoomName === 'string' ? body.linkedRoomName.trim() : undefined;
    const linkedContractId = typeof body.linkedContractId === 'string' ? body.linkedContractId.trim() || undefined : undefined;
    const linkedContractName = typeof body.linkedContractName === 'string' ? body.linkedContractName.trim() : undefined;
    const linkedProjectId = typeof body.linkedProjectId === 'string' ? body.linkedProjectId.trim() || undefined : undefined;
    const linkedProjectName = typeof body.linkedProjectName === 'string' ? body.linkedProjectName.trim() : undefined;
    const linkedDocumentIds = Array.isArray(body.linkedDocumentIds)
      ? (body.linkedDocumentIds as string[]).filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];

    const hasAnyAttachedEntity = !!(linkedAgentId || linkedDatasetId || linkedRoomId || linkedContractId || linkedProjectId || linkedDocumentIds.length > 0);
    let linkedSourcesBlock = '';
    if (hasAnyAttachedEntity) {
      const parts: string[] = [];
      if (linkedAgentId) {
        parts.push(`**Agent**: ${linkedAgentName || linkedAgentId} (id: \`${linkedAgentId}\`). For questions over this agent's knowledge, use \`ragSearch\` with \`agentId: "${linkedAgentId}"\` and the user's \`query\`.`);
      }
      if (linkedDatasetId) {
        parts.push(`**Dataset**: ${linkedDatasetName || linkedDatasetId} (id: \`${linkedDatasetId}\`). For questions over this dataset's files, use \`ragSearch\` with \`dataset_id: "${linkedDatasetId}"\` and the user's \`query\`.`);
      }
      if (linkedRoomId) {
        parts.push(`**Room**: ${linkedRoomName || linkedRoomId} (id: \`${linkedRoomId}\`). The user has attached this room as context.`);
      }
      if (linkedContractId) {
        parts.push(`**Contract**: ${linkedContractName || linkedContractId} (id: \`${linkedContractId}\`). The user has attached this contract as context.`);
      }
      if (linkedProjectId) {
        parts.push(`**Project**: ${linkedProjectName || linkedProjectId} (id: \`${linkedProjectId}\`). The user has attached this project as context.`);
      }
      if (linkedDocumentIds.length > 0) {
        parts.push(`**Referenced document(s)** (for deep analysis of a single file): use \`ragSearch\` with \`documentId: "<fileId>"\` for each. Document IDs: ${linkedDocumentIds.map((id) => `\`${id}\``).join(', ')}. When the user asks for thorough analysis of a file, fetch all chunks with \`documentId\` then analyze.`);
      }
      linkedSourcesBlock = `\n\n## Attached entities (from attach menu or @ mentions)\n${parts.join('\n\n')}\n`;
    }

    // Create dynamic system prompt: attached entities FIRST so the agent keeps special attention, then base prompt and user email
    const dynamicSystemPrompt = buildSystemPrompt({
      attachedEntitiesBlock: linkedSourcesBlock || undefined,
      userEmail: userEmail ?? undefined,
    });

    // RAG tool: when user has linked agent/dataset/documents/etc., inject those IDs into ragSearch so the model doesn't have to pass them
    const hasLinkedContext = !!(linkedAgentId || linkedDatasetId || linkedRoomId || linkedContractId || linkedProjectId || linkedDocumentIds.length > 0);
    const ragSearchWithContext = hasLinkedContext
      ? {
        ...ragSearch,
        execute: async (args: { query?: string; documentId?: string; dataset_id?: string; agentId?: string; roomId?: string; contractId?: string; projectId?: string; topK?: number }, options?: unknown) => {
          const merged = {
            ...args,
            agentId: args.agentId ?? linkedAgentId,
            dataset_id: args.dataset_id ?? linkedDatasetId,
            roomId: args.roomId ?? linkedRoomId,
            contractId: args.contractId ?? linkedContractId,
            projectId: args.projectId ?? linkedProjectId,
            // When user attached a single document and didn't pass documentId, use it for "get all chunks" or scope semantic search
            documentId: args.documentId ?? (linkedDocumentIds.length === 1 ? linkedDocumentIds[0] : undefined),
          };
          return typeof ragSearch.execute === 'function'
            ? (ragSearch.execute as (input: typeof merged, options?: unknown) => Promise<unknown>)(merged, options)
            : Promise.resolve({ text: '', chunks: [], error: 'RAG not available' });
        },
      }
      : ragSearch;

    // Map UI tool keys to API tool names; when selectedTools is provided, only include those
    // Forward request cookies to send-email so fileId attachments can be resolved (session required)
    const sendEmailToolWithAuth = createSendEmailTool(req.headers.get('cookie'));
    const allTools: Record<string, any> = {
      lautonomyDBTool,
      webSearch,
      exaGetContents,
      sendEmailTool: sendEmailToolWithAuth,
      createVisualizationTool: createVisualizationTool,
      docBuilderTool: await docBuilderTool,
      databaseOperationsTool,
      documentEditingTool,
      datasetBuilderTool: await datasetBuilderTool,
      ragSearch: ragSearchWithContext,
    };
    const uiKeyToApiTools: Record<string, string[]> = {
      visualization: ['createVisualizationTool'],
      sendEmail: ['sendEmailTool'],
      webSearch: ['webSearch', 'exaGetContents'],
      contractEditor: ['docBuilderTool', 'documentEditingTool'],
    };
    let toolsToUse: Record<string, any> = allTools;
    if (selectedTools && selectedTools.length > 0) {
      const allowedApiNames = new Set<string>();
      selectedTools.forEach((key) => {
        const apiNames = uiKeyToApiTools[key];
        if (apiNames) apiNames.forEach((name) => allowedApiNames.add(name));
      });
      // When user has linked agent/dataset/documents, always include ragSearch so "search the dataset attached" works
      if (hasLinkedContext) allowedApiNames.add('ragSearch');

      // Always allow core operations that the system prompt asserts are available
      allowedApiNames.add('databaseOperationsTool');
      allowedApiNames.add('sendEmailTool');
      allowedApiNames.add('lautonomyDBTool');

      toolsToUse = Object.fromEntries(
        Object.entries(allTools).filter(([name]) => allowedApiNames.has(name))
      );
    }

    // Only pass reasoningEffort for OpenAI models that support it (avoids SDK warning on non-reasoning models).
    // Use client value as-is: DeeThink on -> 'medium', off -> 'none'.
    const openaiReasoningModels = new Set(OPENAI_REASONING_MODEL_IDS);
    const supportsReasoning = selectedModel.provider === 'openai' && (openaiReasoningModels as Set<string>).has(selectedModel.apiIdentifier);
    const reasoningEffort = reasoningEffortRaw;

    console.log('[streamchat] reasoning debug:', {
      bodyReasoningEffort: body.reasoningEffort,
      selectedModelApiIdentifier: selectedModel.apiIdentifier,
      supportsReasoning,
      reasoningEffortUsed: reasoningEffort,
    });

    const result = streamText({
      model: modelInstance as any,
      system: dynamicSystemPrompt,
      messages: convertToModelMessages(truncatedMessages),
      tools: toolsToUse,
      providerOptions: {
        ...(supportsReasoning ? {
          openai: {
            reasoningEffort,
            ...(reasoningEffort === 'medium' ? { reasoningSummary: 'detailed' as const } : {}),
          },
        } : {}),
      },
      toolChoice: 'auto',
      stopWhen: stepCountIs(20),
      experimental_transform: smoothStream({
        delayInMs: 20, // optional: defaults to 10ms
        chunking: 'word', // optional: defaults to 'word'
      })
    });

    // Consume the stream to ensure it runs to completion & triggers onFinish
    // even when the client response is aborted (e.g. tab close / network drop).
    result.consumeStream(); // no await

    // Usage is logged ONLY inside onFinish to avoid double-counting.

    // Return stream while also persisting full message list onFinish
    return result.toUIMessageStreamResponse({
      sendReasoning: true,
      originalMessages: hydratedMessages,
      generateMessageId: createIdGenerator({ prefix: 'msg', size: 16 }),
      async onFinish({ messages: finalMessages }) {
        console.log('[streamchat] onFinish called, message count:', finalMessages?.length ?? 0);
        try {
          let finalChatId = chatSessionId;

          // If no chat session exists, create one
          if (!finalChatId) {
            try {
              const created = await db.chatSession.create({
                data: {
                  userId: userId || null,
                  organisationId: safeOrganisationId,
                },
              });
              finalChatId = created.id;
              console.log('✅ Created new chat session:', finalChatId);
            } catch (error) {
              console.error('❌ Failed to create chat session:', error);
              // Log usage but don't save messages if session creation fails
              try {
                const usage = await result.usage.catch(() => null);
                if (usage) {
                  await logUsageEvent({
                    organisationId: safeOrganisationId ?? null,
                    userId: userId ?? null,
                    spaceId: null,
                    chatId: null,
                    chatMessageId: null,
                    workflowRunId: null,
                    modelName: selectedModel.apiIdentifier,
                    inputTokens: usage.inputTokens ?? 0,
                    outputTokens: usage.outputTokens ?? 0,
                    totalTokens: usage.totalTokens ?? 0,
                    cachedInputTokens: usage.cachedInputTokens ?? 0,
                    reasoningTokens: (usage as any).reasoningTokens ?? 0,
                    metadata: { route: 'streamchat', phase: 'finish-no-session' },
                  });
                }
              } catch { }
              return;
            }
          } else {
            // Verify the chat session exists before trying to save messages
            try {
              const existingSession = await db.chatSession.findUnique({ where: { id: finalChatId } });
              if (!existingSession) {
                console.warn('⚠️ Chat session not found, creating it:', finalChatId);
                await db.chatSession.create({
                  data: {
                    id: finalChatId,
                    userId: userId || null,
                    organisationId: safeOrganisationId,
                  },
                });
              }
            } catch (error) {
              console.error('❌ Failed to verify/create chat session:', error);
              return;
            }
          }

          // Save messages to database (explicit createdAt by index so user is always before assistant when loaded)
          try {
            const baseTime = Date.now();
            const ops = finalMessages.map((m: UIMessage, idx: number) =>
              db.chatMessage.upsert({
                where: { messageId: m.id! },
                update: { role: m.role, parts: m.parts as unknown as object },
                create: {
                  messageId: m.id!,
                  chatId: finalChatId!,
                  role: m.role,
                  parts: m.parts as unknown as object,
                  createdAt: new Date(baseTime + idx),
                },
              })
            );
            await db.$transaction(ops);
            console.log('✅ Saved', finalMessages.length, 'messages to chat session:', finalChatId);
          } catch (error: any) {
            console.error('❌ Failed to save messages:', error);
            // If it's a foreign key constraint error, the chat session might still not exist
            if (error?.code === 'P2003' || error?.message?.includes('Foreign key constraint')) {
              console.error('Foreign key constraint violation - chat session may not exist:', finalChatId);
              // Try to create the session one more time
              try {
                await db.chatSession.create({
                  data: {
                    id: finalChatId!,
                    userId: userId || null,
                    organisationId: safeOrganisationId,
                  },
                });
                // Retry saving messages
                const retryBaseTime = Date.now();
                const ops = finalMessages.map((m: UIMessage, idx: number) =>
                  db.chatMessage.upsert({
                    where: { messageId: m.id! },
                    update: { role: m.role, parts: m.parts as unknown as object },
                    create: {
                      messageId: m.id!,
                      chatId: finalChatId!,
                      role: m.role,
                      parts: m.parts as unknown as object,
                      createdAt: new Date(retryBaseTime + idx),
                    },
                  })
                );
                await db.$transaction(ops);
                console.log('✅ Retried and saved messages after creating session');
              } catch (retryError) {
                console.error('❌ Failed to retry saving messages:', retryError);
              }
            }
            // Don't re-throw - let outer try-catch handle it gracefully
          }

          // Update assistant messages with token counts AND log usage ONCE (not per-message)
          try {
            const usage = await result.usage.catch(() => null);
            if (usage) {
              const aiMessages = finalMessages.filter((m: UIMessage) => m.role === 'assistant');
              // Update token counts on all assistant messages
              for (const aiMessage of aiMessages) {
                await db.chatMessage.update({
                  where: { messageId: aiMessage.id! },
                  data: {
                    inputTokens: usage.inputTokens ?? 0,
                    outputTokens: usage.outputTokens ?? 0,
                    totalTokens: usage.totalTokens ?? 0,
                    modelName: selectedModel.apiIdentifier,
                  },
                }).catch(() => { });
              }
              // Log usage event ONCE for the entire request (not per assistant message)
              const lastAssistant = aiMessages[aiMessages.length - 1];
              let chatMessageId: string | null = null;
              if (lastAssistant) {
                try {
                  const cm = await db.chatMessage.findUnique({ where: { messageId: lastAssistant.id! } });
                  chatMessageId = cm?.id ?? null;
                } catch { }
              }
              const reasoningTokens = (usage as any).reasoningTokens ?? 0;
              const cachedInputTokens = usage.cachedInputTokens ?? 0;
              console.log('[streamchat] Token usage:', {
                model: selectedModel.apiIdentifier,
                input: usage.inputTokens ?? 0,
                output: usage.outputTokens ?? 0,
                reasoning: reasoningTokens,
                cached: cachedInputTokens,
                totalTokens: usage.totalTokens ?? 0,
              });
              await logUsageEvent({
                organisationId: safeOrganisationId ?? null,
                userId: userId ?? null,
                spaceId: null,
                chatId: finalChatId ?? chatSessionId ?? null,
                chatMessageId,
                workflowRunId: null,
                modelName: selectedModel.apiIdentifier,
                inputTokens: usage.inputTokens ?? 0,
                outputTokens: usage.outputTokens ?? 0,
                totalTokens: usage.totalTokens ?? 0,
                cachedInputTokens,
                reasoningTokens,
                metadata: { route: 'streamchat' },
              });
            }
          } catch (usageErr) {
            console.error('[streamchat] Usage update failed (continuing to title):', usageErr);
          }

          // Ensure the persisted chat session has user linkage; only set org if null
          try {
            const cs2 = await db.chatSession.findUnique({ where: { id: finalChatId }, select: { organisationId: true, userId: true } });
            const fixes: any = {};
            if (!cs2?.organisationId && safeOrganisationId) fixes.organisationId = safeOrganisationId;
            if (!cs2?.userId && userId) fixes.userId = userId;
            if (Object.keys(fixes).length > 0) await db.chatSession.update({ where: { id: finalChatId }, data: fixes });
          } catch { }

          // Title update: use a minimal model (gpt-4o-mini) to generate a short title from the first user message + assistant reply (first 20 words). Used in "Your Conversations".
          try {
            console.log('[streamchat] Title: start');

            const currentSession = await db.chatSession.findUnique({ where: { id: finalChatId! }, select: { title: true } });
            if (currentSession?.title) {
              console.log('[streamchat] Title: already exists, skipping generation');
              try {
                await db.chatSession.update({ where: { id: finalChatId!, ...(userId ? { userId } : {}) }, data: { updatedAt: new Date() } });
              } catch {
                await db.chatSession.update({ where: { id: finalChatId! }, data: { updatedAt: new Date() } });
              }
            } else {
              const getMessageText = (msg: UIMessage): string => {
                const m = msg as any;
                if (typeof m.content === 'string' && m.content.trim()) return m.content.trim();
                if (Array.isArray(m.content)) {
                  const fromContent = m.content.map((c: any) => (c?.type === 'text' ? c.text : c?.text ?? '')).filter(Boolean).join(' ');
                  if (fromContent.trim()) return fromContent.trim();
                }
                const fromParts = (m.parts || [])
                  .filter((p: any) => p && (p.type === 'text' || p.type === 'reasoning'))
                  .map((p: any) => p.text || p.content || '')
                  .filter(Boolean)
                  .join(' ');
                return fromParts.trim();
              };
              const firstNWords = (s: string, n: number) =>
                s.split(/\s+/).filter(Boolean).slice(0, n).join(' ');

              const firstUser = finalMessages.find((m: UIMessage) => m.role === 'user');
              const firstAssistant = finalMessages.find((m: UIMessage) => m.role === 'assistant');
              const userText = firstUser ? getMessageText(firstUser) : '';
              const assistantText = firstAssistant ? getMessageText(firstAssistant) : '';
              const assistantSnippet = firstNWords(assistantText, 20);
              const titleContext = [
                userText && `User: ${userText.slice(0, 500)}`,
                assistantSnippet && `Assistant (first 20 words): ${assistantSnippet}`,
              ].filter(Boolean).join('\n');

              if (titleContext) {
                console.log('[streamchat] Title: generating with context length', titleContext.length);
                const { text } = await generateText({
                  model: openai('gpt-4o-mini'),
                  prompt: `Create a very short title for this chat (max 50 chars, no quotes). Used in a "Your Conversations" list. One line, plain text, no markdown or symbols (# * etc).\n\n${titleContext}`,
                });
                const summaryRaw = (text || '').replace(/\n+/g, ' ').replace(/[\u201C\u201D\u2018\u2019]/g, '"');
                const summary = summaryRaw.replace(/^[\'"\s]+|[\'"\s]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
                console.log('[streamchat] Title: generated', summary || '(empty)');
                try {
                  await db.chatSession.update({ where: { id: finalChatId!, ...(userId ? { userId } : {}) }, data: { updatedAt: new Date(), title: summary || undefined } });
                } catch {
                  await db.chatSession.update({ where: { id: finalChatId! }, data: { updatedAt: new Date(), title: summary || undefined } });
                }
              } else {
                console.log('[streamchat] Title: skipped (no user or assistant text). finalMessages roles:', finalMessages.map((m: UIMessage) => m.role));
                try {
                  await db.chatSession.update({ where: { id: finalChatId!, ...(userId ? { userId } : {}) }, data: { updatedAt: new Date() } });
                } catch {
                  await db.chatSession.update({ where: { id: finalChatId! }, data: { updatedAt: new Date() } });
                }
              }
            }
          } catch (titleErr) {
            console.error('[streamchat] Title generation failed:', titleErr);
            try {
              await db.chatSession.update({ where: { id: finalChatId! }, data: { updatedAt: new Date() } });
            } catch { }
          }
        } catch {
          // swallow persistence failures
        }
      },
    });
  } catch (error) {
    console.error('API route error:', error);
    const message = error instanceof Error ? error.message : 'An unknown server error occurred.';
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
}

// Minimal GET to support resumeStream(): returns an empty UI message stream.
// This allows clients to complete resume attempts gracefully when there's
// no active resumable stream persisted server-side.
export async function GET(_req: NextRequest) {
  const stream = createUIMessageStream({
    execute: () => {
      // no-op
    },
  });
  return createUIMessageStreamResponse({ stream });
}