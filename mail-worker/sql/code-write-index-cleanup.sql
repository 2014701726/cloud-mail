-- 可选：已完成 code-hash-upgrade.sql 且运行 MD5 索引查询版后执行。
-- 只删除本项目旧版验证码查询留下的索引，不删除邮件、字段和当前查询索引。
DROP INDEX IF EXISTS idx_email_code_recipient_time;
DROP INDEX IF EXISTS idx_email_code_time;
DROP INDEX IF EXISTS idx_email_code_recipient_time_v2;
