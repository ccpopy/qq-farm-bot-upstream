import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

/**
 * 全局 SMTP 配置接口（发件箱），供“邮箱”推送渠道使用。
 * 仅登录后的管理员可访问。
 */
const store = require('../../models/store');
const { createAuthRequired, handleApiError } = require('./middleware');
const { sendEmailMessage, invalidateTransporter } = require('../../services/email-push');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function maskSmtp(cfg: any): any {
    const pass = String(cfg.pass || '');
    return {
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        user: cfg.user,
        fromName: cfg.fromName,
        hasPass: Boolean(pass),
        passMasked: pass ? '*'.repeat(Math.max(0, Math.min(8, pass.length))) : '',
    };
}

function mountSmtpRoutes(app: Application, ctx: AdminContext): void {
    const authRequired = createAuthRequired(ctx);

    app.get('/api/admin/smtp', authRequired, (_req: Request, res: Response) => {
        try {
            res.json({ ok: true, data: maskSmtp(store.getSmtp()) });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/admin/smtp', authRequired, (req: Request, res: Response) => {
        try {
            const body = req.body || {};
            const next: any = { ...store.getSmtp() };
            if (body.host !== undefined) next.host = String(body.host || '').trim();
            if (body.port !== undefined) next.port = Number.parseInt(body.port, 10) || next.port;
            if (body.secure !== undefined) next.secure = body.secure !== false;
            if (body.user !== undefined) next.user = String(body.user || '').trim();
            if (body.fromName !== undefined) next.fromName = String(body.fromName || '').trim() || next.fromName;
            if (body.pass !== undefined && String(body.pass).trim()) next.pass = String(body.pass);
            if (!next.host) return res.status(400).json({ ok: false, error: 'SMTP 服务器不能为空' });
            if (!next.user) return res.status(400).json({ ok: false, error: '发件邮箱不能为空' });
            if (!EMAIL_PATTERN.test(next.user)) return res.status(400).json({ ok: false, error: '发件邮箱格式不正确' });
            const saved = store.setSmtp(next);
            invalidateTransporter();
            res.json({ ok: true, data: maskSmtp(saved), message: 'SMTP 配置已保存' });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/admin/smtp/test', authRequired, async (req: Request, res: Response) => {
        try {
            const body = req.body || {};
            const to = String(body.to || '').trim();
            if (!to || !EMAIL_PATTERN.test(to)) return res.status(400).json({ ok: false, error: '请填写有效的测试收件邮箱' });
            const cfg = store.getSmtp();
            const info = await sendEmailMessage({
                to,
                subject: 'SMTP 配置测试',
                text: `这是一封来自 QQ 农场 Bot 的 SMTP 测试邮件。\n发件邮箱: ${cfg.user}\n服务器: ${cfg.host}:${cfg.port}\n时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
            });
            res.json({ ok: true, data: info, message: '测试邮件已发送' });
        } catch (e: any) {
            res.status(400).json({ ok: false, error: `发送失败: ${e && e.message ? e.message : e}` });
        }
    });
}

module.exports = { mountSmtpRoutes };
