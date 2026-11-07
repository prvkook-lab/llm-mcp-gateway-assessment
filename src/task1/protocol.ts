import { z } from 'zod';

export const VERSION = '2025-11-25';
export const requestSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number().int()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type RpcRequest = z.infer<typeof requestSchema>;
export type RpcResponse = { jsonrpc: '2.0'; id: string | number | null } &
  ({ result: unknown } | { error: { code: number; message: string } });
export function rpcError(id: string | number | null, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
const tools = [
  { name: 'add', description: 'Add two finite numbers.', inputSchema: {
    type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'], additionalProperties: false,
  } },
  { name: 'echo', description: 'Echo bounded text.', inputSchema: {
    type: 'object', properties: { text: { type: 'string', maxLength: 4096 } }, required: ['text'], additionalProperties: false,
  } },
];
const meta = { _meta: z.record(z.string(), z.unknown()).optional() };
const emptyParams = z.strictObject(meta);
const listSchema = z.strictObject({ ...meta, cursor: z.string().optional() });
const initializeSchema = z.strictObject({
  ...meta,
  protocolVersion: z.string(), capabilities: z.record(z.string(), z.unknown()),
  clientInfo: z.strictObject({ name: z.string().min(1), version: z.string().min(1),
    title: z.string().optional(), description: z.string().optional(), websiteUrl: z.url().optional(),
    icons: z.array(z.strictObject({ src: z.string(), mimeType: z.string().optional(), sizes: z.array(z.string()).optional(), theme: z.enum(['light', 'dark']).optional() })).optional(),
  }),
});
const callSchema = z.strictObject({ ...meta, name: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) });
const argsSchemas = {
  add: z.strictObject({ a: z.number().finite(), b: z.number().finite() }),
  echo: z.strictObject({ text: z.string().max(4096) }),
};
/** Shared boundary validation: the proxy never relies on upstream argument validation. */
export function validMethodParams(req: RpcRequest): boolean {
  if (req.method === 'initialize') return initializeSchema.safeParse(req.params).success;
  if (req.method === 'tools/list') return listSchema.safeParse(req.params ?? {}).success && req.params?.cursor === undefined;
  if (req.method === 'tools/call') {
    const call = callSchema.safeParse(req.params);
    if (!call.success) return false;
    if (call.data.name === 'add') return argsSchemas.add.safeParse(call.data.arguments).success;
    if (call.data.name === 'echo') return argsSchemas.echo.safeParse(call.data.arguments).success;
    return false;
  }
  return emptyParams.safeParse(req.params ?? {}).success;
}

/** One instance per transport session; no global lifecycle state. */
export class McpSession {
  private state: 'new' | 'initializing' | 'ready' = 'new';
  private readonly ids = new Set<string | number>();
  handle(input: unknown): RpcResponse | undefined {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) return rpcError(null, -32600, 'Invalid Request');
    const req = parsed.data;
    const reply = (result: unknown): RpcResponse | undefined => req.id === undefined ? undefined : { jsonrpc: '2.0', id: req.id, result };
    const fail = (code: number, message: string): RpcResponse | undefined => req.id === undefined ? undefined : rpcError(req.id, code, message);
    if (req.id !== undefined) {
      if (this.ids.has(req.id)) return fail(-32600, 'Request ID reused');
      if (this.ids.size >= 10_000) return fail(-32000, 'Session request capacity reached');
      this.ids.add(req.id);
    }
    if (req.method === 'notifications/initialized') {
      if (req.id !== undefined) return fail(-32600, 'Expected notification');
      if (this.state === 'initializing' && emptyParams.safeParse(req.params ?? {}).success) this.state = 'ready';
      return undefined;
    }
    // Unknown notifications must never produce responses or execute tools.
    if (req.id === undefined) return undefined;
    if (req.method === 'initialize') {
      if (this.state !== 'new') return fail(-32600, 'Already initialized');
      const params = initializeSchema.safeParse(req.params);
      if (!params.success) return fail(-32602, 'Invalid initialization parameters');
      this.state = 'initializing';
      return reply({ protocolVersion: VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'assessment-mcp', version: '1.0.0' } });
    }
    if (req.method === 'ping') {
      if (!emptyParams.safeParse(req.params ?? {}).success) return fail(-32602, 'Invalid parameters');
      return reply({});
    }
    if (this.state !== 'ready') return fail(-32002, 'Server not initialized');
    if (req.method === 'tools/list') {
      if (!validMethodParams(req)) return fail(-32602, 'Invalid parameters');
      return reply({ tools });
    }
    if (req.method === 'tools/call') {
      const call = callSchema.safeParse(req.params);
      if (!call.success) return fail(-32602, 'Invalid tool call');
      const { name, arguments: args } = call.data;
      if (name === 'add') {
        const values = argsSchemas.add.safeParse(args);
        if (!values.success) return fail(-32602, 'Invalid add arguments');
        const sum = values.data.a + values.data.b;
        if (!Number.isFinite(sum)) return reply({ isError: true, content: [{ type: 'text', text: 'Numeric overflow' }] });
        return reply({ content: [{ type: 'text', text: String(sum) }] });
      }
      if (name === 'echo') {
        const values = argsSchemas.echo.safeParse(args);
        if (!values.success) return fail(-32602, 'Invalid echo arguments');
        return reply({ content: [{ type: 'text', text: values.data.text }] });
      }
      return fail(-32602, 'Unknown tool');
    }
    return fail(-32601, 'Method not found');
  }
}
