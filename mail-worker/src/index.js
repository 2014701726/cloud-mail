import { codeResponse } from './service/code-service';
import codePage from './template/code-page';
import app from './hono/webs';
import { email } from './email/email';
import userService from './service/user-service';
import verifyRecordService from './service/verify-record-service';
import emailService from './service/email-service';
import kvObjService from './service/kv-obj-service';
import oauthService from './service/oauth-service';
import analysisService from './service/analysis-service';
export default {
	 async fetch(req, env, ctx) {

		const url = new URL(req.url)

        // 独立免登录验证码页面；其余后台接口仍走原来的权限校验。
        if (url.pathname === '/codes' || url.pathname === '/codes/' || url.pathname === '/api/codes') {
            if (req.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
            if (String(env.public_codes) !== 'true') return new Response('Not found', { status: 404 });
            if (url.pathname === '/api/codes') return codeResponse(url, env);
            return new Response(codePage, { headers: {
                'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
                'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"
            } });
        }

		if (url.pathname.startsWith('/api/')) {
			url.pathname = url.pathname.replace('/api', '')
			req = new Request(url.toString(), req)
			return app.fetch(req, env, ctx);
		}

		 if (['/static/','/attachments/'].some(p => url.pathname.startsWith(p))) {
			 return await kvObjService.toObjResp( { env }, url.pathname.substring(1));
		 }

		return env.assets.fetch(req);
	},
	email: email,
	async scheduled(c, env, ctx) {
		if (c.cron === '*/30 * * * *') {
			await analysisService.refreshEchartsCache({ env })
			return;
		}

		await verifyRecordService.clearRecord({ env })
		await userService.resetDaySendCount({ env })
		await emailService.completeReceiveAll({ env })
		await emailService.autoClean({ env })
		await analysisService.refreshEchartsCache({ env })
		await oauthService.clearNoBindOathUser({ env })
	},
};
