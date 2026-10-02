import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { IResponse } from '../types/common.type';
import { map, Observable } from 'rxjs';
import { ErrorCode } from '../types/error-code';
import { serializeTimestamps } from '../utils/date.util';

/**
 * Điểm duy nhất biến đổi response thành công: bọc thành `{ data, errorCode, traceId }`
 * và chuẩn hoá mọi mốc thời gian về ISO 8601. Nhờ vậy service cứ trả entity thô,
 * không phải tự đổi định dạng ngày tháng ở từng chỗ.
 */
@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, IResponse<T>> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<IResponse<T>> | Promise<Observable<IResponse<T>>> {
    return next.handle().pipe(
      map((data) => ({
        data: serializeTimestamps(data),
        errorCode: ErrorCode.SUCCESS,
        traceId: '',
      })),
    );
  }
}
