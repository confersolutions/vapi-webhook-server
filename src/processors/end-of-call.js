const { sql } = require('../db');

/**
 * Process end-of-call-report events from VAPI.
 * Extracts transcript, duration, cost, endedReason.
 * Updates call_attempts + inserts transcript.
 * Handles DNC opt-outs.
 */
async function processEndOfCallReport(payload) {
  const message = payload?.message || payload;
  const call = message?.call || {};
  const callId = call.id || message?.callId;

  if (!callId) {
    console.warn('[PROCESSOR] No callId in end-of-call-report, skipping');
    return;
  }

  // Extract fields from VAPI payload
  const durationSec = message?.durationSeconds ?? call?.duration ?? null;
  const costUsd = message?.cost ?? call?.cost ?? null;
  const endedReason = message?.endedReason ?? call?.endedReason ?? null;
  const transcript = message?.transcript ?? message?.artifact?.transcript ?? null;
  const summary = message?.summary ?? message?.analysis?.summary ?? null;

  // Build full transcript text from structured transcript
  let fullTranscript = null;
  if (typeof transcript === 'string') {
    fullTranscript = transcript;
  } else if (Array.isArray(transcript)) {
    fullTranscript = transcript
      .map((t) => `${t.role}: ${t.text}`)
      .join('\n');
  }

  // Determine sentiment from analysis if available
  const sentiment = message?.analysis?.sentiment ?? null;

  console.log(`[PROCESSOR] Processing call=${callId} duration=${durationSec}s cost=$${costUsd} reason=${endedReason}`);

  // Update call_attempts
  const updated = await sql`
    UPDATE call_attempts
    SET
      status = 'completed',
      duration_sec = COALESCE(${durationSec}, duration_sec),
      cost_usd = COALESCE(${costUsd}, cost_usd),
      ended_reason = COALESCE(${endedReason}, ended_reason),
      updated_at = NOW()
    WHERE vapi_call_id = ${callId}
    RETURNING id, contact_id, campaign_id
  `;

  if (updated.length > 0) {
    const callAttempt = updated[0];

    // Insert transcript — idempotent
    if (fullTranscript) {
      await sql`
        INSERT INTO transcripts (call_attempt_id, full_transcript, summary, sentiment)
        VALUES (${callAttempt.id}, ${fullTranscript}, ${summary}, ${sentiment})
        ON CONFLICT (call_attempt_id) DO UPDATE SET
          full_transcript = EXCLUDED.full_transcript,
          summary = COALESCE(EXCLUDED.summary, transcripts.summary),
          sentiment = COALESCE(EXCLUDED.sentiment, transcripts.sentiment),
          updated_at = NOW()
      `;
    }

    // Check for opt-out / DNC
    await checkAndFlagDNC(callId, endedReason, fullTranscript, callAttempt);

    console.log(`[PROCESSOR] call_attempt ${callAttempt.id} updated successfully`);
  } else {
    console.warn(`[PROCESSOR] No call_attempt found for vapi_call_id=${callId}`);
  }
}

/**
 * If endCallPhrases triggered or user explicitly opted out, flag contact in DNC list.
 */
async function checkAndFlagDNC(callId, endedReason, transcript, callAttempt) {
  const isOptOut =
    endedReason === 'customer-ended-call' ||
    endedReason === 'end-call-phrase-triggered' ||
    endedReason === 'voicemail';

  // Also check transcript for explicit DNC phrases
  const dncPhrases = [
    'do not call',
    'stop calling',
    'remove me',
    'take me off',
    'opt out',
    'unsubscribe',
    'don\'t call',
  ];

  const hasDNCPhrase = transcript
    ? dncPhrases.some((phrase) => transcript.toLowerCase().includes(phrase))
    : false;

  if (hasDNCPhrase || endedReason === 'end-call-phrase-triggered') {
    // Look up contact phone number
    const contacts = await sql`
      SELECT c.phone, ca.campaign_id
      FROM call_attempts ca
      JOIN contacts c ON c.id = ca.contact_id
      WHERE ca.vapi_call_id = ${callId}
      LIMIT 1
    `;

    if (contacts.length > 0) {
      const { phone, campaign_id } = contacts[0];
      const reason = hasDNCPhrase ? 'verbal_opt_out' : 'end_call_phrase';

      await sql`
        INSERT INTO dnc_list (phone, source, reason, project_id)
        VALUES (${phone}, ${'vapi_webhook'}, ${reason}, ${campaign_id})
        ON CONFLICT (phone) DO NOTHING
      `;

      console.log(`[DNC] Flagged ${phone} — reason: ${reason}`);
    }
  }
}

module.exports = { processEndOfCallReport };
