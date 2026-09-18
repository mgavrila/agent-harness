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

export interface FakeEmbeddingCall {
  model: string;
  input: string[];
  /** The width the caller asked for, when it asked. */
  dimensions: number | undefined;
  user: string | undefined;
  authorization: string | undefined;
}

export interface FakeEmbeddingReply {
  /** The width to answer at. Defaults to the request's `dimensions`, then to 1,024. */
  dimensions?: number;
  /** Exact vectors, one per input, in place of the deterministic ones. */
  vectors?: number[][];
  /** Non-2xx to exercise the error path. Defaults to 200. */
  status?: number;
  errorBody?: unknown;
  promptTokens?: number;
  /** Value for the `x-litellm-response-cost` header. Omit to send no header. */
  costHeader?: string;
  /** Value for the response's `model` field. Defaults to the requested model. */
  modelName?: string;
}

export type EmbeddingResponder = (call: FakeEmbeddingCall) => FakeEmbeddingReply | Promise<FakeEmbeddingReply>;

/** The width the fake answers at when neither the request nor the responder says. */
export const FAKE_EMBED_DIMENSIONS = 1_024;

/**
 * A deterministic unit vector for a string.
 *
 * Each word is hashed (FNV-1a) into one bucket and adds one there; the vector is then normalised.
 * That gives a retrieval test everything it needs from an embedding and nothing a model would
 * give it: the same text always embeds the same, two texts sharing words point the same way, two
 * sharing none are orthogonal, and every vector has length 1 so a cosine distance is comparable.
 * Text with no words at all becomes the first basis vector rather than a zero vector, which
 * pgvector's cosine distance cannot order.
 */
export function fakeEmbedding(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== '');
  for (const token of tokens) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i += 1) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    vector[Math.abs(hash) % dimensions] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }
  return vector.map((x) => x / norm);
}

interface EmbeddingRequestBody {
  model: string;
  input?: string | string[];
  dimensions?: number;
  user?: string;
}

export interface FakeGateway {
  url: string;
  calls: FakeGatewayCall[];
  /** Embedding requests, recorded apart from `calls` so a suite asserting on one ignores the other. */
  embeddings: FakeEmbeddingCall[];
  setResponder(responder: Responder): void;
  setEmbeddingResponder(responder: EmbeddingResponder): void;
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

const JSON_HEADERS = { 'content-type': 'application/json' };

/**
 * A body that is not JSON is a test's mistake, not a crash: answered 400 here, it stays a failed
 * request the caller can assert on rather than an unhandled rejection that takes the whole suite
 * down from inside the request handler.
 */
function writeNotJson(res: ServerResponse): void {
  res.writeHead(400, JSON_HEADERS);
  res.end(JSON.stringify({ error: { message: 'the request body is not JSON', type: 'invalid_request_error' } }));
}

/** The non-2xx a responder asked for, with the body a suite that named none gets. */
function writeError(res: ServerResponse, status: number, errorBody: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(errorBody ?? { error: { message: 'boom', type: 'test_error' } }));
}

/** JSON, plus the cost header when the reply named one and no header at all when it did not. */
function replyHeaders(costHeader: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (costHeader !== undefined) headers['x-litellm-response-cost'] = costHeader;
  return headers;
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
  const embeddings: FakeEmbeddingCall[] = [];
  let respondToEmbedding: EmbeddingResponder = () => ({});
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
      if (req.method !== 'POST') {
        res.writeHead(404).end('{}');
        return;
      }
      if (req.url?.endsWith('/embeddings')) {
        let body: EmbeddingRequestBody;
        try {
          body = JSON.parse(await readBody(req)) as EmbeddingRequestBody;
        } catch {
          writeNotJson(res);
          return;
        }
        // LiteLLM's own schema takes a string or a list; the harness always sends a list, and
        // accepting both here keeps the fake honest about what the real endpoint does.
        const input = typeof body.input === 'string' ? [body.input] : (body.input ?? []);
        const call: FakeEmbeddingCall = {
          model: body.model,
          input,
          dimensions: body.dimensions,
          user: body.user,
          authorization: req.headers.authorization,
        };
        embeddings.push(call);
        const reply = await respondToEmbedding(call);
        if (reply.status && reply.status >= 400) {
          writeError(res, reply.status, reply.errorBody);
          return;
        }
        const dimensions = reply.dimensions ?? body.dimensions ?? FAKE_EMBED_DIMENSIONS;
        const headers = replyHeaders(reply.costHeader);
        const promptTokens = reply.promptTokens ?? input.reduce((n, text) => n + Math.ceil(text.length / 4), 0);
        // `vectors` replaces the whole answer, not one entry of it: a responder that hands over
        // fewer vectors than there were inputs is how a suite exercises a gateway that answered
        // short, which a per-index fallback would quietly fill back in.
        const vectors = reply.vectors ?? input.map((text) => fakeEmbedding(text, dimensions));
        res.writeHead(200, headers);
        res.end(
          JSON.stringify({
            object: 'list',
            model: reply.modelName ?? body.model,
            data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
            usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
          }),
        );
        return;
      }
      if (!req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end('{}');
        return;
      }
      let body: RequestBody;
      try {
        body = JSON.parse(await readBody(req)) as RequestBody;
      } catch {
        writeNotJson(res);
        return;
      }
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
        writeError(res, reply.status, reply.errorBody);
        return;
      }
      const headers = replyHeaders(reply.costHeader);
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
    embeddings,
    setResponder(next) {
      respond = next;
    },
    setEmbeddingResponder(next) {
      respondToEmbedding = next;
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
