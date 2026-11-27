export {};

/**
 * 下线提醒邮件的发送方配置（QQ 邮箱 SMTP）。
 * 可通过环境变量覆盖，默认使用本项目实例的固定发件邮箱。
 */
const EMAIL_SMTP = {
    host: process.env.BOT_SMTP_HOST || 'smtp.qq.com',
    port: Number.parseInt(process.env.BOT_SMTP_PORT || '465', 10),
    secure: String(process.env.BOT_SMTP_SECURE || 'true') !== 'false',
    user: process.env.BOT_SMTP_USER || '',
    pass: process.env.BOT_SMTP_PASS || '',
    fromName: process.env.BOT_SMTP_FROM_NAME || 'QQ农场 Bot',
};

module.exports = { EMAIL_SMTP };
