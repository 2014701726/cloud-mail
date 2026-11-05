/**
 * Cloudflare Email Worker：把收到的邮件原样转发到自建服务器
 *
 * 部署位置：Cloudflare Dashboard -> Email -> Email Routing -> Email Workers
 * 需要配置的环境变量：
 *   INGEST_URL    = https://jx3saas.cn/mail-ingest
 *   INGEST_SECRET = 服务器 /opt/cloud-mail/selfhost/.env 里的 INGEST_SECRET
 *
 * 行为：
 *   - 服务器返回 2xx           -> 正常收下
 *   - 服务器返回 rejected       -> 让 Cloudflare 按业务规则拒收（退信）
 *   - 网络/5xx                  -> 抛错，Cloudflare 以临时失败返回给发件方，对方会重试
 */
export default {
	async email(message, env, ctx) {
		const raw = await new Response(message.raw).arrayBuffer();

		let response;
		try {
			response = await fetch(env.INGEST_URL, {
				method: 'POST',
				headers: {
					'content-type': 'message/rfc822',
					'x-ingest-secret': env.INGEST_SECRET,
					'x-envelope-to': message.to,
					'x-envelope-from': message.from || ''
				},
				body: raw
			});
		} catch (e) {
			// 临时失败：让发件方稍后重试
			throw new Error(`[mail-ingest] unreachable: ${e && e.message ? e.message : e}`);
		}

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`[mail-ingest] HTTP ${response.status} ${text.slice(0, 300)}`);
		}

		let data = {};
		try {
			data = await response.json();
		} catch {
			// 忽略非 JSON 响应
		}

		if (data && data.rejected) {
			message.setReject(String(data.rejected));
		}
	}
};
