-- 在上游数据库初始化/升级完成后执行；不改变已有数据。
CREATE INDEX IF NOT EXISTS idx_email_code_recipient_time_v2
ON email(to_email COLLATE NOCASE, create_time DESC, email_id DESC)
WHERE type = 0 AND status IN (0, 7) AND is_del = 0 AND code <> '';
CREATE INDEX IF NOT EXISTS idx_email_code_time_v2
ON email(create_time DESC, email_id DESC)
WHERE type = 0 AND status IN (0, 7) AND is_del = 0 AND code <> '';
