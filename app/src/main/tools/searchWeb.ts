import { tool, jsonSchema } from 'ai';

export const searchWebTool = tool({
  description: 'Search the web for real-time information using the Exa API. Use for facts, news, weather, prices, docs, or anything beyond training data.',
  inputSchema: jsonSchema<{ query: string }>({
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
    },
    required: ['query']
  }),
  execute: async ({ query }) => {
    console.log(`🛠️ Tool: searchWeb called with query: "${query}"`);
    const apiKey = process.env.EXA_API_KEY || '';
    if (!apiKey) return { success: false, error: 'EXA_API_KEY is not configured in .env' };
    const cleanKey = apiKey.replace(/"/g, '').trim();
    const res = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'x-api-key': cleanKey, 'content-type': 'application/json' },
      body: JSON.stringify({ query, useAutoprompt: true, numResults: 5 })
    });
    const data = (await res.json()) as any;
    return { success: true, results: data.results || [] };
  }
});
