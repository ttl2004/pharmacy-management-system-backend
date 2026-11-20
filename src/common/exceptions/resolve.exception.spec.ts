import { ArgumentsHost, BadRequestException, Logger } from '@nestjs/common';
import { ErrorCode } from '../types/error-code';
import { ErrorException } from './error.exception';
import { ResolveExceptionFilter } from './resolve.exception';

function hostFor() {
  const reply = { status: jest.fn(), header: jest.fn(), send: jest.fn() };
  reply.status.mockReturnValue(reply);
  reply.header.mockReturnValue(reply);
  const request = { method: 'POST', url: '/order/abc/pay', id: 'req-1' };
  const host = {
    switchToHttp: () => ({ getResponse: () => reply, getRequest: () => request }),
  } as unknown as ArgumentsHost;
  return { host, reply };
}

describe('ResolveExceptionFilter — ghi log lỗi máy chủ', () => {
  let logError: jest.SpyInstance;

  beforeEach(() => {
    logError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => logError.mockRestore());

  it('lỗi không lường trước → trả 500 chung chung nhưng ghi log kèm stack và requestId', () => {
    const { host, reply } = hostFor();
    const boom = new Error('connection terminated');

    new ResolveExceptionFilter().catch(boom, host);

    expect(reply.status).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Lỗi máy chủ nội bộ', errorCode: ErrorCode.INTERNAL_SERVER_ERROR }),
    );
    expect(logError).toHaveBeenCalledTimes(1);
    const [message, stack] = logError.mock.calls[0] as [string, string];
    expect(message).toContain('POST /order/abc/pay');
    expect(message).toContain('requestId=req-1');
    expect(stack).toContain('connection terminated');
  });

  it('lỗi nghiệp vụ (ErrorException, 400) và lỗi HTTP 4xx → không ghi log lỗi', () => {
    const filter = new ResolveExceptionFilter();
    filter.catch(new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message: 'sai' }), hostFor().host);
    filter.catch(new BadRequestException('sai'), hostFor().host);

    expect(logError).not.toHaveBeenCalled();
  });
});
