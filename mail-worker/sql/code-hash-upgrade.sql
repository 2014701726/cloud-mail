-- 已有部署：额度恢复后、部署新版代码前执行一次。重复执行 ALTER 会报字段已存在。
-- 不修改历史正文，不回填历史哈希；旧邮件自然在 5 分钟后过期。
ALTER TABLE email ADD COLUMN recipient_hash TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_email_code_hash_time
ON email(recipient_hash, create_time DESC, email_id DESC)
WHERE type = 0 AND status IN (0, 7) AND is_del = 0 AND code <> '';
CREATE INDEX IF NOT EXISTS idx_email_code_time_v2
ON email(create_time DESC, email_id DESC)
WHERE type = 0 AND status IN (0, 7) AND is_del = 0 AND code <> '';
