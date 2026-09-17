export type DatabaseDriver = 'mongoose' | 'typeorm';

export interface DatabaseOptions {
  driver: DatabaseDriver;
}
