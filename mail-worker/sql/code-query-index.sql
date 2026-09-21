-- 在上游数据库初始化/升级完成后执行；不改变已有数据。
CREATE INDEX IF NOT EXISTS idx_email_code_recipient_time
ON email(to_email COLLATE NOCASE, create_time DESC, email_id DESC)
WHERE type = 0 AND status = 0 AND is_del = 0 AND code <> '';
CREATE INDEX IF NOT EXISTS idx_email_code_time
ON email(create_time DESC, email_id DESC)
WHERE type = 0 AND status = 0 AND is_del = 0 AND code <> '';
