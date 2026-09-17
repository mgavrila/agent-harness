import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeGatewayMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

export interface FakeGatewayCall {
  model: string;
  messages: FakeGatewayMessage[];
  responseFormat: unknown;
  authorization: string | undefined;
  /** The attribution field a runtime must send on every request. */
  user: string | undefined;
  stream: boolean;
  /** The function names offered on this request. */
  tools: string[];
}

export interface FakeToolCall {
  /** Defaults to `call_<n>`, unique per gateway. */
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface FakeReply {
  /** The assistant message content. Defaults to `'ok'` when no tool call is scripted, else null. */
  content?: string;
  /** Tool calls the model "makes"; the finish reason becomes `tool_calls`. */
  toolCalls?: FakeToolCall[];
  /** Non-2xx to exercise the error path. Defaults to 200. */
  status?: number;
  errorBody?: unknown;
  inputTokens?: number;
  outputTokens?: number;
  /** Value for the `x-litellm-response-cost` header. Omit to send no header. */
  costHeader?: string;
  /** Value for the response's `model` field. Defaults to the requested model. */
  modelName?: string;
}

export type Responder = (call: FakeGatewayCall) => FakeReply | Promise<FakeReply>;

export interface FakeGateway {
  url: string;
  calls: FakeGatewayCall[];
  setResponder(responder: Responder): void;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

interface RequestBody {
  model: string;
  messages: FakeGatewayMessage[];
  response_format?: unknown;
  user?: string;
  stream?: boolean;
  tools?: { function?: { name?: string } }[];
}

function usage(reply: FakeReply) {
  const prompt = reply.inputTokens ?? 11;
  const completion = reply.outputTokens ?? 7;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

function toolCallsOf(reply: FakeReply, nextId: () => string) {
  return (reply.toolCalls ?? []).map((t) => ({
    id: t.id ?? nextId(),
    type: 'function' as const,
    function: { name: t.name, arguments: JSON.stringify(t.arguments) },
  }));
}

/** The two id sequences: one for completions, one for tool calls. Both unique per gateway. */
interface Ids {
  completion: () => string;
  call: () => string;
}

function writeJson(
  res: ServerResponse,
  body: RequestBody,
  reply: FakeReply,
  headers: Record<string, string>,
  ids: Ids,
): void {
  const toolCalls = toolCallsOf(reply, ids.call);
  res.writeHead(reply.status ?? 200, headers);
  res.end(
    JSON.stringify({
      id: ids.completion(),
      object: 'chat.completion',
      model: reply.modelName ?? body.model,
      choices: [
        {
          index: 0,
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
          message: {
            role: 'assistant',
            content: reply.content ?? (toolCalls.length > 0 ? null : 'ok'),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
        },
      ],
      usage: usage(reply),
    }),
  );
}

/**
 * The streaming shape: one chunk per word of content, or a name chunk and an arguments chunk per
 * tool call, then a finish chunk, then a usage chunk with no choices, then `[DONE]`. The id is
 * unique per completion: a messages reducer that replaces a message whose id it has already seen
 * would silently drop the second tool call of a run if the fake reused one id.
 */
function writeStream(
  res: ServerResponse,
  body: RequestBody,
  reply: FakeReply,
  headers: Record<string, string>,
  ids: Ids,
): void {
  const base = {
    id: ids.completion(),
    object: 'chat.completion.chunk',
    created: 1,
    model: reply.modelName ?? body.model,
  };
  const chunks: unknown[] = [];
  const toolCalls = toolCallsOf(reply, ids.call);
  if (toolCalls.length > 0) {
    toolCalls.forEach((t, index) => {
      chunks.push({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: null,
              tool_calls: [{ index, id: t.id, type: 'function', function: { name: t.function.name, arguments: '' } }],
            },
            finish_reason: null,
          },
        ],
      });
      chunks.push({
        ...base,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index, function: { arguments: t.function.arguments } }] },
            finish_reason: null,
          },
        ],
      });
    });
    chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    const words = (reply.content ?? 'ok').split(' ');
    words.forEach((word, i) => {
      chunks.push({
        ...base,
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: i === words.length - 1 ? word : `${word} ` },
            finish_reason: null,
          },
        ],
      });
    });
    chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  chunks.push({ ...base, choices: [], usage: usage(reply) });
  res.writeHead(reply.status ?? 200, { ...headers, 'content-type': 'text/event-stream' });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * An OpenAI-compatible chat-completions endpoint on loopback, so a suite can exercise a model
 * caller without an API key or a network. It mimics LiteLLM closely enough to matter: the `usage`
 * block and the `x-litellm-response-cost` header are what core-tools' `callModel` reads, and the
 * streaming shape, the `user` field and the tool list are what a runtime is tested on.
 */
export async function startFakeGateway(responder: Responder = () => ({})): Promise<FakeGateway> {
  const calls: FakeGatewayCall[] = [];
  let respond = responder;
  let seq = 0;
  const nextId = (): string => {
    seq += 1;
    return `chatcmpl-${seq}`;
  };
  let callSeq = 0;
  const nextCallId = (): string => {
    callSeq += 1;
    return `call_${callSeq}`;
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end('{}');
        return;
      }
      const body = JSON.parse(await readBody(req)) as RequestBody;
      const call: FakeGatewayCall = {
        model: body.model,
        messages: body.messages,
        responseFormat: body.response_format ?? null,
        authorization: req.headers.authorization,
        user: body.user,
        stream: body.stream === true,
        tools: (body.tools ?? []).map((t) => t.function?.name ?? '').filter((n) => n !== ''),
      };
      calls.push(call);

      const reply = await respond(call);
      if (reply.status && reply.status >= 400) {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.errorBody ?? { error: { message: 'boom', type: 'test_error' } }));
        return;
      }
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (reply.costHeader !== undefined) headers['x-litellm-response-cost'] = reply.costHeader;
      const ids: Ids = { completion: nextId, call: nextCallId };
      if (call.stream) writeStream(res, body, reply, headers, ids);
      else writeJson(res, body, reply, headers, ids);
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    setResponder(next) {
      respond = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        // A responder that is still hanging (the cancel tests) holds a connection open; close
        // those first or `server.close` waits forever.
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
