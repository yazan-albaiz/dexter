import { AIMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { z } from 'zod';
import { getOAuthToken } from '../auth/openai-oauth';
import { resolveProvider } from '../providers';
import type { LlmResult } from './llm';

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
const RESPONSES_API_URL = `${CODEX_BASE_URL}/codex/responses`;

interface CallLlmOptions {
  model?: string;
  systemPrompt?: string;
  outputSchema?: z.ZodType<unknown>;
  tools?: StructuredToolInterface[];
  signal?: AbortSignal;
}

interface ResponsesApiTool {
  type: 'function' | 'web_search';
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

interface ResponsesApiMessage {
  role: 'user' | 'system' | 'assistant';
  content: string;
}

interface ResponsesApiRequest {
  model: string;
  instructions?: string;
  input: ResponsesApiMessage[];
  tools?: ResponsesApiTool[];
  store?: boolean;
  stream?: boolean;
  text?: {
    format?: {
      type: string;
      name: string;
      schema: Record<string, unknown>;
      strict: boolean;
    };
  };
}

/**
 * Convert a Zod v4 schema to JSON Schema.
 * zod-to-json-schema relies on Zod v3 internals (def.typeName) that don't exist in Zod v4.
 */
function zodV4ToJsonSchema(schema: any): Record<string, unknown> {
  const def = schema?._zpiDef ?? schema?._def;
  if (!def) return { type: 'object' };

  const description = def.description ?? schema?.description;
  const base: Record<string, unknown> = {};
  if (description) base.description = description;

  const type = def.type ?? def.typeName;

  switch (type) {
    case 'object': {
      const shape = def.shape ?? {};
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, val] of Object.entries(shape)) {
        properties[key] = zodV4ToJsonSchema(val);
        const valDef = (val as any)?._zpiDef ?? (val as any)?._def;
        const valType = valDef?.type ?? valDef?.typeName;
        if (valType !== 'optional') {
          required.push(key);
        }
      }
      return { ...base, type: 'object', properties, ...(required.length ? { required } : {}) };
    }
    case 'string':
      return { ...base, type: 'string' };
    case 'number':
    case 'float':
      return { ...base, type: 'number' };
    case 'int':
      return { ...base, type: 'integer' };
    case 'boolean':
      return { ...base, type: 'boolean' };
    case 'array': {
      const items = def.element ?? def.items;
      return { ...base, type: 'array', ...(items ? { items: zodV4ToJsonSchema(items) } : {}) };
    }
    case 'enum': {
      const values = def.values ?? def.entries;
      return { ...base, type: 'string', enum: Array.isArray(values) ? values : Object.keys(values ?? {}) };
    }
    case 'optional': {
      const inner = def.innerType ?? def.wrapped;
      return inner ? zodV4ToJsonSchema(inner) : { ...base };
    }
    case 'nullable': {
      const inner = def.innerType ?? def.wrapped;
      const innerSchema = inner ? zodV4ToJsonSchema(inner) : {};
      return { ...innerSchema, nullable: true };
    }
    default:
      return { ...base, type: 'string' };
  }
}

function convertToolsToResponsesFormat(tools: StructuredToolInterface[]): ResponsesApiTool[] {
  const responsesTools: ResponsesApiTool[] = tools.map((tool) => ({
    type: 'function' as const,
    name: tool.name,
    description: tool.description,
    parameters: zodV4ToJsonSchema(tool.schema),
  }));

  // Add built-in web search (free with ChatGPT OAuth, no API key needed)
  responsesTools.push({ type: 'web_search' });

  return responsesTools;
}

function extractAccountId(token: string): string | null {
  try {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(atob(payload));
    return decoded['https://api.openai.com/auth']?.account_id || null;
  } catch {
    return null;
  }
}

function extractModelName(model: string): string {
  const provider = resolveProvider(model);
  if (provider.modelPrefix && model.startsWith(provider.modelPrefix)) {
    return model.slice(provider.modelPrefix.length);
  }
  return model;
}

export async function callLlmResponses(
  prompt: string,
  options: CallLlmOptions = {},
): Promise<LlmResult> {
  const token = await getOAuthToken();
  const model = extractModelName(options.model || 'chatgpt:gpt-4o');

  const accountId = extractAccountId(token);

  const input: ResponsesApiMessage[] = [{ role: 'user', content: prompt }];

  const requestBody: ResponsesApiRequest = {
    model,
    input,
    store: false,
    stream: true,
    instructions: options.systemPrompt || '',
  };

  if (options.tools && options.tools.length > 0) {
    requestBody.tools = convertToolsToResponsesFormat(options.tools);
  }

  if (options.outputSchema) {
    const jsonSchema = zodV4ToJsonSchema(options.outputSchema);
    requestBody.text = {
      format: {
        type: 'json_schema',
        name: 'structured_output',
        schema: jsonSchema,
        strict: true,
      },
    };
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'OpenAI-Beta': 'responses=experimental',
        originator: 'codex_cli_rs',
      };
      if (accountId) {
        headers['chatgpt-account-id'] = accountId;
      }

      const response = await fetch(RESPONSES_API_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: options.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        const error = new Error(`Responses API error ${response.status}: ${text}`);
        // Don't retry auth or client errors
        if (response.status >= 400 && response.status < 500) throw error;
        lastError = error;
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
        continue;
      }

      const responseText = await response.text();
      let data: any = null;
      for (const line of responseText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const jsonStr = trimmed.slice('data:'.length).trim();
        if (!jsonStr) continue;
        try {
          const event = JSON.parse(jsonStr);
          if (event.type === 'response.completed') {
            data = event.response;
            break;
          }
        } catch {
          // skip malformed lines
        }
      }
      if (!data) throw new Error('No response.completed event found in SSE stream');
      return parseResponsesApiOutput(data, options);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      lastError = err as Error;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      }
    }
  }

  throw lastError || new Error('Responses API call failed');
}

function parseResponsesApiOutput(data: any, options: CallLlmOptions): LlmResult {
  const output = data.output || [];
  const usage = data.usage
    ? {
        inputTokens: data.usage.input_tokens || 0,
        outputTokens: data.usage.output_tokens || 0,
        totalTokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
      }
    : undefined;

  // Check for function calls
  const functionCalls = output.filter((item: any) => item.type === 'function_call');

  if (functionCalls.length > 0) {
    const textContent = output
      .filter((item: any) => item.type === 'message')
      .map((item: any) => item.content?.map((c: any) => c.text).join('') || '')
      .join('');

    const toolCalls = functionCalls.map((fc: any) => ({
      name: fc.name,
      args: typeof fc.arguments === 'string' ? JSON.parse(fc.arguments) : fc.arguments,
      id: fc.call_id,
    }));

    return {
      response: new AIMessage({
        content: textContent,
        tool_calls: toolCalls,
      }),
      usage,
    };
  }

  // Extract text response
  let text = '';
  for (const item of output) {
    if (item.type === 'message') {
      text += item.content?.map((c: any) => c.text || '').join('') || '';
    }
  }

  // Handle structured output - parse JSON
  if (options.outputSchema) {
    try {
      return { response: JSON.parse(text), usage };
    } catch {
      return { response: text, usage };
    }
  }

  return { response: text, usage };
}
