import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getOAuthToken } from '../../auth/openai-oauth';

const RESPONSES_API_URL = 'https://chatgpt.com/backend-api/codex/responses';

function extractAccountId(token: string): string | null {
  try {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(atob(payload));
    return decoded['https://api.openai.com/auth']?.account_id || null;
  } catch {
    return null;
  }
}

async function chatgptWebSearch(query: string): Promise<string> {
  const token = await getOAuthToken();
  const accountId = extractAccountId(token);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'OpenAI-Beta': 'responses=experimental',
    originator: 'codex_cli_rs',
  };
  if (accountId) {
    headers['chatgpt-account-id'] = accountId;
  }

  const body = {
    model: 'gpt-5.4',
    instructions: 'Search the web and return a concise summary of the results. Focus on facts, data, and recent information.',
    input: [{ role: 'user', content: query }],
    tools: [{ type: 'web_search' }],
    store: false,
    stream: true,
  };

  const response = await fetch(RESPONSES_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Web search API error ${response.status}: ${text}`);
  }

  // Parse SSE stream for response.completed
  const text = await response.text();
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const jsonStr = line.slice(5).trim();
    if (!jsonStr || jsonStr === '[DONE]') continue;
    try {
      const event = JSON.parse(jsonStr);
      if (event.type === 'response.completed' && event.response) {
        const output = event.response.output || [];
        let result = '';
        for (const item of output) {
          if (item.type === 'message') {
            result += item.content?.map((c: any) => c.text || '').join('') || '';
          }
        }
        return result || 'No search results found.';
      }
    } catch {
      continue;
    }
  }

  return 'No search results found.';
}

export const chatgptWebSearchProxy = new DynamicStructuredTool({
  name: 'web_search',
  description: 'Search the web for current information, news, prices, and real-time data.',
  schema: z.object({
    query: z.string().describe('The search query'),
  }),
  func: async (input) => {
    return chatgptWebSearch(input.query);
  },
});
