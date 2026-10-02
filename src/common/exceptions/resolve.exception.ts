import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ConflictException,
  ExceptionFilter,
  ForbiddenException,
  HttpException,
  MethodNotAllowedException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ErrorCode } from '../types/error-code';
import { ErrorException } from './error.exception';
import { FastifyReply, FastifyRequest } from 'fastify';

@Catch()
export class ResolveExceptionFilter implements ExceptionFilter {
  private getErrorCodeFromHttpException(exception: HttpException): ErrorCode {
    if (exception instanceof NotFoundException) {
      return ErrorCode.HTTP_NOT_FOUND;
    }
    if (exception instanceof BadRequestException) {
      return ErrorCode.HTTP_BAD_REQUEST;
    }
    if (exception instanceof UnauthorizedException) {
      return ErrorCode.HTTP_UNAUTHORIZED;
    }
    if (exception instanceof ForbiddenException) {
      return ErrorCode.HTTP_FORBIDDEN;
    }
    if (exception instanceof MethodNotAllowedException) {
      return ErrorCode.HTTP_METHOD_NOT_ALLOWED;
    }
    if (exception instanceof ConflictException) {
      return ErrorCode.HTTP_CONFLICT;
    }
    if (exception instanceof UnprocessableEntityException) {
      return ErrorCode.HTTP_UNPROCESSABLE_ENTITY;
    }

    return ErrorCode.HTTP_INTERNAL_SERVER_ERROR;
  }

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    let message: string;
    let errorCode: ErrorCode;
    let statusCode = 500;
    let code: ErrorCode | undefined;

    if (exception instanceof ErrorException) {
      message = exception.message;
      errorCode = exception.errorCode;
      statusCode = 400;
    } else if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const body = exception.getResponse();
      const details =
        typeof body === 'object' ? (body as { code?: unknown; message?: string | string[] }) : undefined;
      message = Array.isArray(details?.message) ? details.message.join('; ') : (details?.message ?? exception.message);
      errorCode = this.getErrorCodeFromHttpException(exception);
      // Exception tự mang mã lỗi riêng (ví dụ authError) thì mã đó thắng mã suy ra từ loại HTTP.
      if (typeof details?.code === 'number') {
        code = details.code as ErrorCode;
        errorCode = code;
      }
      if (statusCode === 429) {
        errorCode = ErrorCode.HTTP_TOO_MANY_REQUESTS;
        message = 'Đã vượt quá số yêu cầu cho phép. Vui lòng thử lại sau';
      }
    } else {
      message = 'Lỗi máy chủ nội bộ';
      errorCode = ErrorCode.INTERNAL_SERVER_ERROR;
    }

    response.status(statusCode).header('content-type', 'application/json').send({
      timestamp: new Date().toISOString(),
      path: request.url,
      message: message,
      errorCode: errorCode,
      code,
      statusCode,
    });
  }
}
