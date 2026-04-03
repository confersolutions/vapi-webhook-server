const { Router } = require('express');
const { sql } = require('../db');
const { processEndOfCallReport } = require('../processors/end-of-call');

const router = Router();

const VAPI_SECRET = process.env.VAPI_WEBHOOK_SECRET;

// POST /webhook/vapi
router.post('/vapi', async (req, res) => {
  const start = Date.now();

  // 1. Verify secret header
  if (VAPI_SECRET && VAPI_SECRET !== 'changeme') {
    const headerSecret = req.headers['x-vapi-secret'];
    if (headerSecret !== VAPI_SECRET) {
      console.warn('[WEBHOOK] Invalid x-vapi-secret');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const payload = req.body;
  const message = payload?.message;
  const eventType = message?.type || payload?.type || 'unknown';
  const callId = message?.call?.id || payload?.call?.id || payload?.callId || null;

  console.log(`[WEBHOOK] event=${eventType} call=${callId}`);

  // 2. IMMEDIATELY insert raw payload (safety net) — idempotent
  try {
    await sql`
      INSERT INTO webhook_events_raw (event_type, call_id, raw_payload, processed)
      VALUES (${eventType}, ${callId}, ${sql.json(payload)}, false)
      ON CONFLICT (call_id, event_type) DO NOTHING
    `;
  } catch (err) {
    // Log but still return 200 — don't lose the event silently
    console.error('[WEBHOOK] Raw insert failed:', err.message);
  }

  // 3. Return 200 immediately (VAPI 5-second timeout)
  res.status(200).json({ ok: true, received: eventType });

  // 4. Async processing (after response sent)
  const elapsed = Date.now() - start;
  console.log(`[WEBHOOK] Responded in ${elapsed}ms, starting async processing`);

  try {
    if (eventType === 'end-of-call-report') {
      await processEndOfCallReport(payload);
      // Mark raw event as processed
      await sql`
        UPDATE webhook_events_raw
        SET processed = true, processed_at = NOW()
        WHERE call_id = ${callId} AND event_type = ${eventType}
      `;
    }
  } catch (err) {
    console.error(`[WEBHOOK] Async processing failed for ${eventType}:`, err.message);
  }
});

module.exports = { webhookRouter: router };
