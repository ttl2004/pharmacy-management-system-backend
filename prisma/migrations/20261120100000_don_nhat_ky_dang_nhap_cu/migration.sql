-- Migration don_nhat_ky_dang_nhap_cu: cho phép dọn sự kiện ĐĂNG NHẬP cũ (> 180 ngày) khỏi security_events.
-- Lý do: LOGIN_OK/LOGIN_FAILED/LOGIN_FAILED_BURST sinh ra rất nhiều và hết giá trị điều tra sau ~6 tháng,
-- nếu giữ mãi bảng phình vô hạn. Các sự kiện khác (đổi mật khẩu, nghi vấn tấn công, thu hồi phiên...) giữ vĩnh viễn.
-- Chỉ nới trigger của security_events; audit_logs và audit_block_mutation() giữ nguyên.

-- Hàm riêng cho DELETE/UPDATE trên security_events:
--  * DELETE: cho phép khi dòng là sự kiện đăng nhập VÀ cũ hơn 180 ngày (so theo đồng hồ DB, cùng đồng hồ với job dọn);
--  * mọi trường hợp còn lại (UPDATE, DELETE dòng khác): như audit_block_mutation — chỉ qua được khi
--    transaction bật app.audit_maintenance = 'on' (dùng cho test-support), ngược lại báo append-only.
CREATE OR REPLACE FUNCTION security_events_block_mutation_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND OLD."type" IN ('AUTH.LOGIN_OK', 'AUTH.LOGIN_FAILED', 'AUTH.LOGIN_FAILED_BURST')
     AND OLD."createdAt" < now() - interval '180 days' THEN
    RETURN OLD;
  END IF;
  IF current_setting('app.audit_maintenance', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'audit log is append-only' USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(OLD, NEW);
END;
$$;

DROP TRIGGER "security_events_block_mutation" ON "security_events";
CREATE TRIGGER "security_events_block_mutation"
  BEFORE UPDATE OR DELETE ON "security_events"
  FOR EACH ROW EXECUTE FUNCTION security_events_block_mutation_fn();
