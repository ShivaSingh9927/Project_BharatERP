/**
 * Cloudflare Email Worker: preserve the original MIME message while the local
 * ERP is off, then forward a human-readable backup to a verified mailbox.
 * The R2 bucket has no public access and this Worker exposes no HTTP handler.
 */

const INBOX = /^inbox(?:\+[^\s@]+)?@nueralogic\.com$/i;

const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export async function archiveEmail(message, bucket) {
  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const recipient = message.to.toLowerCase();
  const prefix = new TextEncoder().encode(`${recipient}\0`);
  const digestInput = new Uint8Array(prefix.length + raw.length);
  digestInput.set(prefix);
  digestInput.set(raw, prefix.length);
  const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', digestInput)));
  const key = `incoming/${digest}.eml`;
  await bucket.put(key, raw, {
    httpMetadata: { contentType: 'message/rfc822' },
    customMetadata: {
      from: message.from,
      to: message.to,
      sha256: hex(new Uint8Array(await crypto.subtle.digest('SHA-256', raw))),
      received: new Date().toISOString(),
    },
  });
  return key;
}

export default {
  async email(message, env) {
    if (!INBOX.test(message.to)) {
      message.setReject('Recipient is not the BharatERP intake address');
      return;
    }
    if (!env.FORWARD_TO_EMAIL || !env.EMAIL_ARCHIVE) {
      throw new Error('Email archive and verified forwarding address are required');
    }
    let archived = false;
    try {
      await archiveEmail(message, env.EMAIL_ARCHIVE);
      archived = true;
    } catch (error) {
      // Never silently lose a document if R2 is temporarily unavailable.
      // The forwarded message is the recovery copy; Cloudflare logs the error.
      console.error('R2 email archive failed', error);
    }
    const headers = new Headers();
    headers.set('X-BharatERP-Archive', archived ? 'stored' : 'failed');
    await message.forward(env.FORWARD_TO_EMAIL, headers);
  },
};
