import { tool } from '@langchain/core/tools';
import { z } from 'zod';

export const WEB_SEARCH_DESCRIPTION =
  'Search the web for current information. When using ChatGPT OAuth, web search is handled automatically by the built-in Responses API — results are integrated directly into the response.';

export const chatgptWebSearchProxy = tool(
  async (input) => {
    return `Web search for "${input.query}" is handled automatically by the ChatGPT Responses API. The search results have been integrated into the response above.`;
  },
  {
    name: 'web_search',
    description: WEB_SEARCH_DESCRIPTION,
    schema: z.object({
      query: z.string().describe('The search query'),
    }),
  },
);
