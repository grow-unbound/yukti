import { Resend } from 'resend';

let resendClient: Resend | null = null;

function getResendClient(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  resendClient ??= new Resend(apiKey);
  return resendClient;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

export async function sendAccountVerificationEmail({
  to,
  otp,
  tenantName,
}: {
  to: string;
  otp: string;
  tenantName: string;
}) {
  const resend = getResendClient();
  if (!resend) {
    throw new Error('Resend is not configured');
  }
  const from = process.env.RESEND_FROM_EMAIL;
  if (!from) {
    throw new Error('RESEND_FROM_EMAIL is not configured');
  }

  const result = await resend.emails.send({
    from,
    to,
    subject: `Verify your ${tenantName} Supplier workspace`,
    text: [
      `Your Yukti verification code is ${otp}.`,
      '',
      'This code expires in 10 minutes.',
      'If you did not request this, you can ignore this email.',
    ].join('\n'),
    html: `
      <div style="font-family: Inter, Arial, sans-serif; color: #221e1a; line-height: 1.5;">
        <p>Your Yukti verification code is:</p>
        <p style="font-size: 28px; font-weight: 700; letter-spacing: 6px; margin: 18px 0;">${otp}</p>
        <p>This code expires in 10 minutes.</p>
        <p style="color: #6f665d; font-size: 13px;">If you did not request this, you can ignore this email.</p>
      </div>
    `,
  });

  if ('error' in result && result.error) {
    throw new Error(result.error.message);
  }
}

export async function sendPasswordRecoveryEmail({
  to,
  resetUrl,
}: {
  to: string;
  resetUrl: string;
}) {
  const resend = getResendClient();
  if (!resend) {
    throw new Error('Resend is not configured');
  }
  const from = process.env.RESEND_FROM_EMAIL;
  if (!from) {
    throw new Error('RESEND_FROM_EMAIL is not configured');
  }

  const result = await resend.emails.send({
    from,
    to,
    subject: 'Reset your Yukti password',
    text: [
      'Use this link to reset your Yukti password:',
      resetUrl,
      '',
      'If you did not request this, you can ignore this email.',
    ].join('\n'),
    html: `
      <div style="font-family: Inter, Arial, sans-serif; color: #221e1a; line-height: 1.5;">
        <p>Use this link to reset your Yukti password:</p>
        <p><a href="${escapeHtmlAttribute(resetUrl)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700;">Reset password</a></p>
        <p style="word-break:break-all;color:#6f665d;font-size:13px;">${escapeHtml(resetUrl)}</p>
        <p style="color:#6f665d;font-size:13px;">If you did not request this, you can ignore this email.</p>
      </div>
    `,
  });

  if ('error' in result && result.error) {
    throw new Error(result.error.message);
  }
}

export async function sendSetupPasswordInviteEmail({
  to,
  inviteUrl,
  tenantName,
  recipientName,
}: {
  to: string;
  inviteUrl: string;
  tenantName: string;
  recipientName?: string | null;
}) {
  const resend = getResendClient();
  if (!resend) {
    throw new Error('Resend is not configured');
  }
  const from = process.env.RESEND_FROM_EMAIL;
  if (!from) {
    throw new Error('RESEND_FROM_EMAIL is not configured');
  }

  const greeting = recipientName?.trim() ? `Hi ${recipientName.trim()},` : 'Hi,';
  const escapedGreeting = escapeHtml(greeting);
  const escapedTenantName = escapeHtml(tenantName);
  const escapedInviteUrl = escapeHtml(inviteUrl);
  const escapedInviteUrlAttribute = escapeHtmlAttribute(inviteUrl);
  const result = await resend.emails.send({
    from,
    to,
    subject: `${tenantName} invited you to Yukti`,
    text: [
      greeting,
      '',
      `${tenantName} invited you to set up your Yukti password.`,
      'Use this secure link to continue:',
      inviteUrl,
      '',
      'If you were not expecting this invite, you can ignore this email.',
    ].join('\n'),
    html: `
      <div style="font-family: Inter, Arial, sans-serif; color: #221e1a; line-height: 1.5;">
        <p>${escapedGreeting}</p>
        <p>${escapedTenantName} invited you to set up your Yukti password.</p>
        <p><a href="${escapedInviteUrlAttribute}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700;">Set up password</a></p>
        <p style="word-break:break-all;color:#6f665d;font-size:13px;">${escapedInviteUrl}</p>
        <p style="color:#6f665d;font-size:13px;">If you were not expecting this invite, you can ignore this email.</p>
      </div>
    `,
  });

  if ('error' in result && result.error) {
    throw new Error(result.error.message);
  }
}
