import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { IResponse } from '../types/common.type';
import { map, Observable } from 'rxjs';
import { ErrorCode } from '../types/error-code';

@Injectable()
export class TransformInterceptor<T>
  implements NestInterceptor<T, IResponse<T>>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<IResponse<T>> | Promise<Observable<IResponse<T>>> {
    return next.handle().pipe(
      map((data) => ({
        data: data,
        errorCode: ErrorCode.SUCCESS,
        traceId: '',
      })),
    );
  }
}
