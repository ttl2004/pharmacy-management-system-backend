export const APP_CONSTANTS = {
  BCRYPT_SALT: 10,
};

export const AUTH_JWT = 'AUTH_JWT';

/**
 * Tác nhân hệ thống, dùng cho `createdBy`/`updatedBy` khi thao tác không do người dùng nào khởi
 * phát (ví dụ seed danh mục quyền). Hai cột đó là kiểu `uuid` nên không được ghi chuỗi tự do —
 * trước đây code ghi `'system'` và sẽ vi phạm ràng buộc kiểu.
 */
export const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
