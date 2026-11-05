/**
 * 自建部署收信入口。
 *
 * Cloudflare 上由 Email Routing 把原始邮件交给 Worker 的 email() 处理器；
 * 自建时由 Postfix（或其它 MTA）把邮件原始内容 POST 到 /_internal/receive，
 * 这里构造一个与 Cloudflare EmailMessage 等价的对象，复用原有 email() 逻辑。
 *
 * 必须在环境变量中设置 INGEST_SECRET，否则该路由不生效（返回 404）。
 */
import { email } from '../email/email';

class RejectSignal extends Error {
	constructor(reason) {
		super(reason || 'Rejected');
		this.reason = reason || 'Rejected';
	}
}

function streamOf(buffer) {
	// Cloudflare 的 message.raw 是 ReadableStream，email() 内部用 getReader() 读取。
	return new Blob([buffer], { type: 'message/rfc822' }).stream();
}

export async function handleIngest(req, env, ctx) {
	if (!env.INGEST_SECRET) {
		return new Response('Not found', { status: 404 });
	}

	if (req.method !== 'POST') {
		return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
	}

	if (req.headers.get('x-ingest-secret') !== env.INGEST_SECRET) {
		return new Response('Unauthorized', { status: 401 });
	}

	const to = (req.headers.get('x-envelope-to') || '').trim().toLowerCase();
	const from = (req.headers.get('x-envelope-from') || '').trim();

	if (!to) {
		return new Response('Missing X-Envelope-To', { status: 400 });
	}

	const raw = await req.arrayBuffer();

	if (!raw || raw.byteLength === 0) {
		return new Response('Empty message', { status: 400 });
	}

	// message.forward() 在 Cloudflare 上由 Email Routing 真实投递；
	// 自建时收集目标地址，随后由 selfhost/ingest.mjs 通过本机 SMTP 转发。
	const forwards = [];

	const message = {
		to,
		from,
		headers: req.headers,
		raw: streamOf(raw),
		setReject(reason) {
			throw new RejectSignal(reason);
		},
		forward(address) {
			if (address) forwards.push(String(address));
		}
	};

	try {
		await email(message, env, ctx);
	} catch (e) {
		if (e instanceof RejectSignal) {
			// 与 Cloudflare 行为一致：拒收不写库，返回 250 让 MTA 丢弃，避免无限重试。
			return Response.json({ ok: false, rejected: e.reason, to }, { status: 200 });
		}
		console.error('邮件接收异常: ', e);
		return Response.json({ ok: false, error: String(e?.message || e), to }, { status: 500 });
	}

	return Response.json({ ok: true, to, forward: forwards }, { status: 200 });
}
