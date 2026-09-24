import emailUtils from '../utils/email-utils';

// 单个 Worker 实例短暂熔断，避免配额耗尽时重复访问 D1。
let databaseRetryAt = 0;

export function configuredDomains(env) {
    return arraySetting(env.domain).map(value => String(value).trim().toLowerCase()).filter(Boolean);
}

function arraySetting(value) {
    if (typeof value === 'string') value = JSON.parse(value);
    return Array.isArray(value) ? value : [];
}

// Cloudflare Workers 扩展支持 MD5；普通浏览器 WebCrypto 不支持此算法。
export async function recipientDigest(prefix) {
    const bytes = new TextEncoder().encode(prefix.trim().toLowerCase());
    const digest = await crypto.subtle.digest('MD5', bytes);
    return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

export function extractVerificationCode(email) {
    const body = email.text || emailUtils.htmlToText(email.html || '');
    return body.match(/验证码\s*(?:为|是)?\s*[:：]?\s*([0-9]{4,8})(?![0-9])/)?.[1] || '';
}

export async function codeResponse(url, env) {
    const now = new Date();
    const json = (data, status = 200) => Response.json(data, { status, headers: {
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        ...(status === 503 ? { 'Retry-After': String(Math.max(5, Math.ceil((databaseRetryAt - Date.now()) / 1000))) } : {})
    } });
    const values = url.searchParams.getAll('recipient');
    const domains = url.searchParams.getAll('domain');
    const recipient = (values[0] || '').toLowerCase();
    if (values.length > 1 || domains.length > 1 || (recipient && !/^[a-f0-9]{32}$/.test(recipient))) {
        return json({ error: 'recipient 必须是邮箱前缀的 32 位 MD5 十六进制值；domain 只能填写一个域名' }, 400);
    }
    if (!recipient) return json({ messages: [], server_time: now.toISOString() });
    const allowedDomains = configuredDomains(env);
    const domain = (domains[0] || '').toLowerCase();
    if (!allowedDomains.length || (domain && !allowedDomains.includes(domain))) return json({ error: '未配置此收件域名' }, 400);
    const all = Boolean(env.code_all_recipient?.trim()) && recipient === await recipientDigest(env.code_all_recipient);
    const stamp = date => date.toISOString().slice(0, 19).replace('T', ' ');
    const filters = ["type = 0", "status IN (0, 7)", "is_del = 0", "code <> ''", 'create_time >= ?', 'create_time <= ?'];
    const args = [stamp(new Date(now.getTime() - 300000)), stamp(now)];
    const selectedDomains = all || !domain ? allowedDomains : [domain];
    filters.push(`lower(substr(to_email, instr(to_email, '@') + 1)) IN (${selectedDomains.map(() => '?').join(',')})`);
    args.push(...selectedDomains);
    const senders = arraySetting(env.code_allowed_senders).map(s => String(s).trim().toLowerCase()).filter(Boolean);
    if (senders.length) {
        filters.push(`lower(send_email) IN (${senders.map(() => '?').join(',')})`);
        args.push(...senders);
    }
    if (Date.now() < databaseRetryAt) return json({ error: '数据库暂不可用，请稍后重试' }, 503);
    try {
        if (!all) {
            filters.push('recipient_hash = ?');
            args.push(recipient);
        }
        const { results, meta } = await env.db.prepare(`SELECT email_id, code, create_time FROM email
            INDEXED BY ${all ? 'idx_email_code_time_v2' : 'idx_email_code_hash_time'}
            WHERE ${filters.join(' AND ')} ORDER BY create_time DESC, email_id DESC LIMIT 5`).bind(...args).all();
        if (meta?.rows_read > 100) console.warn('Code query rows_read', meta.rows_read, 'all', all);
        return json({ server_time: now.toISOString(), messages: results.map(row => {
            const received = new Date(row.create_time.replace(' ', 'T') + 'Z');
            return { id: row.email_id, code: row.code, received_at: received.toISOString(),
                expires_at: new Date(received.getTime() + 300000).toISOString() };
        }) });
    } catch (error) {
        const reason = String(error.message || '') + ' ' + String(error.cause?.message || '');
        databaseRetryAt = Date.now() + (/daily|limit|quota|exceeded/i.test(reason) ? 60000 : 5000);
        console.error('Code lookup failed', error.name);
        return json({ error: '验证码暂时无法读取，请稍后重试' }, 503);
    }
}
