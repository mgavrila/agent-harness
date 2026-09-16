import { createServer, type IncomingMessage, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import type { ModelMessage } from './types.js';

export interface FakeGatewayCall {
  model: string;
  messages: ModelMessage[];
  responseFormat: unknown;
  authorization: string | undefined;
}

export interface FakeReply {
  /** The assistant message content. Defaults to `'ok'`. */
  content?: string;
  /** Non-2xx to exercise the error path. Defaults to 200. */
  status?: number;
  /** Body returned with a non-2xx status. */
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

/**
 * An OpenAI-compatible chat-completions endpoint on loopback, so the suite can
 * exercise every branch of `callModel` without an API key or a network. It
 * mimics LiteLLM closely enough to matter: the `usage` block and the
 * `x-litellm-response-cost` header are the two things `callModel` reads.
 */
export async function startFakeGateway(responder: Responder = () => ({})): Promise<FakeGateway> {
  const calls: FakeGatewayCall[] = [];
  let respond = responder;

  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end('{}');
        return;
      }
      const body = JSON.parse(await readBody(req)) as {
        model: string;
        messages: ModelMessage[];
        response_format?: unknown;
      };
      const call: FakeGatewayCall = {
        model: body.model,
        messages: body.messages,
        responseFormat: body.response_format ?? null,
        authorization: req.headers.authorization,
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
      res.writeHead(reply.status ?? 200, headers);
      res.end(
        JSON.stringify({
          id: 'chatcmpl-fake',
          object: 'chat.completion',
          model: reply.modelName ?? body.model,
          choices: [
            { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: reply.content ?? 'ok' } },
          ],
          usage: {
            prompt_tokens: reply.inputTokens ?? 11,
            completion_tokens: reply.outputTokens ?? 7,
            total_tokens: (reply.inputTokens ?? 11) + (reply.outputTokens ?? 7),
          },
        }),
      );
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
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
