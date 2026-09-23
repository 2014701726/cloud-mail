import emailUtils from '../utils/email-utils';

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
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
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
    try {
        if (!all) {
            // 仅对五分钟窗口内符合条件的不同地址计算哈希；无需数据库迁移，已有邮件立即兼容。
            // 先匹配全部候选地址再 LIMIT 5，避免其他收件人的邮件挤掉当前收件人。
            const candidates = await env.db.prepare(`SELECT DISTINCT to_email FROM email
                WHERE ${filters.join(' AND ')}`).bind(...args).all();
            const matched = [];
            const hashes = new Map();
            for (const row of candidates.results) {
                const prefix = row.to_email.slice(0, row.to_email.lastIndexOf('@'));
                if (!hashes.has(prefix)) hashes.set(prefix, await recipientDigest(prefix));
                if (hashes.get(prefix) === recipient) matched.push(row.to_email);
            }
            if (!matched.length) return json({ messages: [], server_time: now.toISOString() });
            // JSON 参数避免多域名时超过 D1 的 SQL 绑定参数数量限制。
            filters.push('to_email IN (SELECT value FROM json_each(?))');
            args.push(JSON.stringify(matched));
        }
        const { results } = await env.db.prepare(`SELECT email_id, code, create_time FROM email
            WHERE ${filters.join(' AND ')} ORDER BY create_time DESC, email_id DESC LIMIT 5`).bind(...args).all();
        return json({ server_time: now.toISOString(), messages: results.map(row => {
            const received = new Date(row.create_time.replace(' ', 'T') + 'Z');
            return { id: row.email_id, code: row.code, received_at: received.toISOString(),
                expires_at: new Date(received.getTime() + 300000).toISOString() };
        }) });
    } catch (error) {
        console.error('Code lookup failed', error.name);
        return json({ error: '验证码暂时无法读取，请稍后重试' }, 503);
    }
}
