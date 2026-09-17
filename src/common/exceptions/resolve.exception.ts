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
import { FastifyReply } from 'fastify';

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
    const request = ctx.getRequest();

    let message: string;
    let errorCode: ErrorCode;

    if (exception instanceof ErrorException) {
      message = exception.message;
      errorCode = exception.errorCode;
    } else if (exception instanceof HttpException) {
      message = 'An error occurred';
      errorCode = this.getErrorCodeFromHttpException(exception);
    } else {
      message = 'Internal server error';
      errorCode = ErrorCode.INTERNAL_SERVER_ERROR;
    }

    response
      .status(200)
      .header('content-type', 'application/json')
      .send({
        timestamp: new Date().toISOString(),
        path: request.url,
        message: message,
        errorCode: errorCode,
        stack: exception instanceof Error ? exception.stack : undefined,
      });
  }
}
