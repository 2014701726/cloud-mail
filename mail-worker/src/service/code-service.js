import emailUtils from '../utils/email-utils';

export function configuredDomains(env) {
    return arraySetting(env.domain).map(value => String(value).trim().toLowerCase()).filter(Boolean);
}

function arraySetting(value) {
    if (typeof value === 'string') value = JSON.parse(value);
    return Array.isArray(value) ? value : [];
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
    const recipient = values[0] || '';
    if (values.length > 1 || domains.length > 1 || (recipient && !/^[^\s@<>,;]{1,256}$/.test(recipient))) {
        return json({ error: 'recipient 只能填写一个邮箱 @ 前缀；domain 只能填写一个域名' }, 400);
    }
    if (!recipient) return json({ messages: [], server_time: now.toISOString() });
    const allowedDomains = configuredDomains(env);
    const domain = (domains[0] || allowedDomains[0] || '').toLowerCase();
    if (!allowedDomains.includes(domain)) return json({ error: '未配置此收件域名' }, 400);
    const all = Boolean(env.code_all_recipient) && recipient === env.code_all_recipient;
    const stamp = date => date.toISOString().slice(0, 19).replace('T', ' ');
    const filters = ["type = 0", "status = 0", "is_del = 0", "code <> ''", 'create_time >= ?', 'create_time <= ?'];
    const args = [stamp(new Date(now.getTime() - 300000)), stamp(now)];
    if (all) {
        filters.push(`lower(substr(to_email, instr(to_email, '@') + 1)) IN (${allowedDomains.map(() => '?').join(',')})`);
        args.push(...allowedDomains);
    } else {
        filters.push('to_email COLLATE NOCASE = ?');
        args.push(`${recipient.toLowerCase()}@${domain}`);
    }
    const senders = arraySetting(env.code_allowed_senders).map(s => String(s).trim().toLowerCase()).filter(Boolean);
    if (senders.length) {
        filters.push(`lower(send_email) IN (${senders.map(() => '?').join(',')})`);
        args.push(...senders);
    }
    try {
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
