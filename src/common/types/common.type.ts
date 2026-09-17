export interface IResponse<T> {
  traceId: string;
  data: T;
  errorCode: number;
}
