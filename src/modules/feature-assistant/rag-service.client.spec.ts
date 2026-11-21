import { Logger } from '@nestjs/common';
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

describe('RagServiceClient — lỗi không lộ URL nội bộ (D6)', () => {
  const realFetch = global.fetch;
  const GENERIC = 'Trợ lý đang bận, vui lòng thử lại sau';
  let logged: jest.SpyInstance;
  const firstLog = () => String((logged.mock.calls as unknown[][])[0][0]);
  beforeEach(() => {
    logged = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  const expectGeneric = async (call: Promise<unknown>) => {
    const error = await call.then(
      () => null,
      (e: unknown) => e as { errorCode: number; message: string },
    );
    expect(error).toMatchObject({ errorCode: ErrorCode.ASSISTANT_UNAVAILABLE, message: GENERIC });
    expect(JSON.stringify(error)).not.toContain('rag.local');
    expect(error?.message).not.toContain('RAG_INTERNAL_KEY');
  };

  it('kết nối bị từ chối: thông báo chung, log có URL và lỗi gốc', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('connect ECONNREFUSED 10.0.0.5:8000')) as never;
    await expectGeneric(new RagServiceClient(config).getInfo());
    expect(firstLog()).toContain('http://rag.local/info');
    expect(firstLog()).toContain('ECONNREFUSED');
  });

  it.each([401, 500, 503])('HTTP %i: thông báo chung, log có URL và status', async (status) => {
    global.fetch = jest.fn().mockResolvedValue(new Response('boom', { status })) as never;
    await expectGeneric(new RagServiceClient(config).sendFeedback({} as never, user));
    expect(firstLog()).toContain('http://rag.local/feedback');
    expect(firstLog()).toContain(String(status));
  });

  it('openChat: HTTP lỗi và body rỗng đều trả thông báo chung', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('x', { status: 502 })) as never;
    await expectGeneric(new RagServiceClient(config).openChat({} as never, user, new AbortController().signal));
    global.fetch = jest.fn().mockResolvedValue(new Response(null, { status: 200 })) as never;
    await expectGeneric(new RagServiceClient(config).openChat({} as never, user, new AbortController().signal));
    expect(logged).toHaveBeenCalledTimes(2);
  });

  it('quá hạn chờ kết nối: thông báo chung', async () => {
    global.fetch = jest.fn().mockRejectedValue(new DOMException('t', 'TimeoutError')) as never;
    const signal = AbortSignal.abort(new DOMException('t', 'TimeoutError'));
    await expectGeneric(new RagServiceClient(config).openChat({} as never, user, signal));
  });
});
