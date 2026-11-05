import { config } from './config.js';

// Sends via Postmark when POSTMARK_TOKEN is set; otherwise logs the message (local development).
export async function sendMail({ to, subject, text }) {
  if (!config.postmarkToken) {
    console.log(`[mail:dev] to=${to} subject="${subject}"\n${text}`);
    return;
  }
  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: { 'X-Postmark-Server-Token': config.postmarkToken, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ From: config.mailFrom, To: to, Subject: subject, TextBody: text, MessageStream: 'outbound' }),
  });
  if (!res.ok) throw new Error(`Postmark ${res.status}: ${await res.text()}`);
}
