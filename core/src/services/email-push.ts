export {};
/**
 * 下线提醒邮件推送（QQ 邮箱 SMTP / nodemailer）。
 */

const dns = require('node:dns');
const { promisify } = require('node:util');

const { EMAIL_SMTP } = require('../config/email');

const lookupAsync = promisify(dns.lookup);
const TRANSPORT_TTL_MS = 10 * 60 * 1000;

const MAX_RECIPIENTS = 20;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

let transporter: any = null;
let transporterExpireAt = 0;
let transporterKey = '';

/** SMTP 由 admin 在面板里配置（全局），这里读取时回退到环境变量/内置默认值。 */
function loadSmtpConfig(): any {
    try {
        const store = require('../models/store');
        if (store && typeof store.getSmtp === 'function') {
            const cfg = store.getSmtp();
            if (cfg && cfg.host && cfg.user) return cfg;
        }
    } catch {
        // 忽略，回退到静态配置
    }
    return EMAIL_SMTP;
}

function smtpKey(cfg: any): string {
    return `${cfg.host}|${cfg.port}|${cfg.secure}|${cfg.user}|${cfg.pass}|${cfg.fromName}`;
}

/**
 * 用系统 DNS（getaddrinfo）解析 SMTP 主机。
 * Termux/Android 上 nodemailer 内建的 c-ares 查询常被运营商或热点网络阻断，
 * 系统解析却正常，因此这里先解析出 IPv4，再用 IP 建连并通过 SNI 校验证书。
 */
async function resolveConnectAddress(host: string): Promise<{ host: string; servername?: string }> {
    try {
        const addresses: any[] = await lookupAsync(host, { all: true } as any);
        const ipv4 = addresses.find(item => item && item.family === 4);
        const chosen = ipv4 || addresses.find(item => item && item.family === 6);
        if (chosen && chosen.address) {
            return { host: String(chosen.address), servername: host };
        }
    } catch {
        // 解析失败时回退为域名，交给 nodemailer 自己处理
    }
    return { host };
}

async function getTransporter(): Promise<any> {
    const cfg = loadSmtpConfig();
    const key = smtpKey(cfg);
    if (transporter && Date.now() < transporterExpireAt && key === transporterKey) return transporter;
    // 延迟加载，避免未安装 nodemailer 时影响其他功能启动
    const nodemailer = require('nodemailer');
    const resolved = await resolveConnectAddress(cfg.host);
    transporter = nodemailer.createTransport({
        host: resolved.host,
        port: cfg.port,
        secure: cfg.secure,
        ...(resolved.servername ? { tls: { servername: resolved.servername } } : {}),
        auth: { user: cfg.user, pass: cfg.pass },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 25000,
        pool: true,
        maxConnections: 1,
        maxMessages: 20,
    });
    transporterExpireAt = Date.now() + TRANSPORT_TTL_MS;
    transporterKey = key;
    return transporter;
}

/**
 * 解析收件人：支持英文逗号、中文逗号、分号、空白分隔，去重并过滤非法地址。
 */
function normalizeRecipients(input: unknown): string[] {
    const parts = String(input || '')
        .split(/[,，;；\s]+/)
        .map(item => item.trim())
        .filter(Boolean);
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of parts) {
        if (!EMAIL_PATTERN.test(item)) continue;
        const key = item.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(item);
        if (result.length >= MAX_RECIPIENTS) break;
    }
    return result;
}

async function sendEmailMessage(payload: { to?: string; subject?: string; text?: string } = {}): Promise<{ ok: boolean; accepted: string[]; messageId: string }> {
    const recipients = normalizeRecipients(payload.to);
    if (!recipients.length) throw new Error('接收邮箱为空或格式无效');
    const subject = String(payload.subject || '').trim();
    const text = String(payload.text || '').trim();
    if (!subject) throw new Error('邮件标题不能为空');
    if (!text) throw new Error('邮件内容不能为空');

    const cfg = loadSmtpConfig();
    const mailer = await getTransporter();
    const info = await mailer.sendMail({
        from: `"${cfg.fromName}" <${cfg.user}>`,
        to: recipients.join(','),
        subject,
        text,
    });
    return {
        ok: true,
        accepted: Array.isArray(info?.accepted) ? info.accepted : recipients,
        messageId: String(info?.messageId || ''),
    };
}

async function verifyEmailTransport(): Promise<boolean> {
    const mailer = await getTransporter();
    await mailer.verify();
    return true;
}

function invalidateTransporter(): void {
    transporter = null;
    transporterExpireAt = 0;
    transporterKey = '';
}

module.exports = { sendEmailMessage, normalizeRecipients, verifyEmailTransport, loadSmtpConfig, invalidateTransporter };
