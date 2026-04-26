import nodemailer from "nodemailer";

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "").toLowerCase() === "true";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASSWORD = process.env.SMTP_PASSWORD || "";
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER || "";

let transporter = null;

export function isMailerConfigured() {
  return Boolean(SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASSWORD && MAIL_FROM);
}

function getTransporter() {
  if (!isMailerConfigured()) {
    throw new Error("SMTP nao configurado.");
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASSWORD,
      },
    });
  }
  return transporter;
}

export async function sendMail({ to, subject, text, html }) {
  const transport = getTransporter();
  await transport.sendMail({
    from: MAIL_FROM,
    to,
    subject,
    text,
    html,
  });
}
