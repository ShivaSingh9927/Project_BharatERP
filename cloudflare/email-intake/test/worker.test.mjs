import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.js';

const raw = new TextEncoder().encode('From: vendor@example.com\r\nSubject: Invoice\r\n\r\nHello');

test('archives MIME with envelope metadata before forwarding', async () => {
  const events = [];
  const message = {
    from: 'vendor@example.com', to: 'inbox+abc@nueralogic.com',
    raw: new Response(raw).body,
    async forward(destination, headers) {
      events.push(['forward', destination, headers.get('X-BharatERP-Archive')]);
    },
    setReject(reason) { events.push(['reject', reason]); },
  };
  const env = {
    FORWARD_TO_EMAIL: 'owner@example.net',
    EMAIL_ARCHIVE: { async put(key, bytes, options) {
      events.push(['put', key, bytes, options]);
    } },
  };
  await worker.email(message, env);
  assert.equal(events[0][0], 'put');
  assert.match(events[0][1], /^incoming\/[a-f0-9]{64}\.eml$/);
  assert.deepEqual(events[0][2], raw);
  assert.equal(events[0][3].customMetadata.to, message.to);
  assert.deepEqual(events[1], ['forward', 'owner@example.net', 'stored']);
});

test('does not archive or forward an unrelated address', async () => {
  const actions = [];
  await worker.email({
    to: 'sales@nueralogic.com',
    setReject(reason) { actions.push(reason); },
  }, { FORWARD_TO_EMAIL: 'owner@example.net', EMAIL_ARCHIVE: {} });
  assert.deepEqual(actions, ['Recipient is not the BharatERP intake address']);
});

test('forwards a recovery copy when R2 is unavailable', async () => {
  let archiveStatus;
  const message = {
    from: 'vendor@example.com', to: 'inbox@nueralogic.com',
    raw: new Response(raw).body,
    async forward(_destination, headers) {
      archiveStatus = headers.get('X-BharatERP-Archive');
    },
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    await worker.email(message, {
      FORWARD_TO_EMAIL: 'owner@example.net',
      EMAIL_ARCHIVE: { async put() { throw new Error('R2 unavailable'); } },
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(archiveStatus, 'failed');
});
