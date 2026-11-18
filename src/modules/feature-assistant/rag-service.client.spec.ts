import { ErrorCode } from 'src/common/types/error-code';
import { CHAT_CONNECT_TIMEOUT_MS, RagServiceClient } from './rag-service.client';

const user = { userId: 'u1', branchId: 'b1' } as never;
const config = { getOrThrow: () => 'http://rag.local', get: () => undefined } as never;

describe('RagServiceClient.openChat — thời gian chờ (L3)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.useRealTimers();
  });

  it('RAG không trả header trong thời hạn → 1610, không treo', async () => {
    jest.useFakeTimers();
    // fetch chỉ kết thúc khi bị abort.
    global.fetch = jest.fn(
      (_url: unknown, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason as Error));
        }),
    ) as never;
    const client = new RagServiceClient(config);
    const pending = client.openChat({ question: 'x' } as never, user, new AbortController().signal);
    const assertion = expect(pending).rejects.toMatchObject({ errorCode: ErrorCode.ASSISTANT_UNAVAILABLE });
    await jest.advanceTimersByTimeAsync(CHAT_CONNECT_TIMEOUT_MS + 1);
    await assertion;
  });

  it('đã nhận header thì hạn chờ kết nối không cắt stream đang chảy', async () => {
    jest.useFakeTimers();
    let signal: AbortSignal | undefined;
    global.fetch = jest.fn((_url: unknown, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return Promise.resolve(new Response('event: done\ndata: {}\n\n'));
    }) as never;
    const client = new RagServiceClient(config);
    await client.openChat({ question: 'x' } as never, user, new AbortController().signal);
    await jest.advanceTimersByTimeAsync(CHAT_CONNECT_TIMEOUT_MS * 3);
    expect(signal?.aborted).toBe(false);
  });

  it('người dùng bấm Dừng vẫn huỷ được', async () => {
    let signal: AbortSignal | undefined;
    global.fetch = jest.fn((_url: unknown, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return Promise.resolve(new Response('x'));
    }) as never;
    const stop = new AbortController();
    await new RagServiceClient(config).openChat({ question: 'x' } as never, user, stop.signal);
    stop.abort();
    expect(signal?.aborted).toBe(true);
  });
});
