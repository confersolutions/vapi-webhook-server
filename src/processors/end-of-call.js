const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { sql } = require('../db');

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || '/opt/vapi-recordings';

/**
 * Process end-of-call-report events from VAPI.
 * Captures ALL available data: transcript, structured turns, analysis,
 * cost breakdown, recordings, timestamps, and DNC opt-outs.
 */
async function processEndOfCallReport(payload) {
  const message = payload?.message || payload;
  const call = message?.call || {};
  const artifact = message?.artifact || {};
  const analysis = message?.analysis || {};
  const callId = call.id || message?.callId;

  if (!callId) {
    console.warn('[PROCESSOR] No callId in end-of-call-report, skipping');
    return;
  }

  // ─── Extract ALL fields from VAPI payload ─────────────────────────────

  // Core call data
  const durationSec = message?.durationSeconds ?? call?.duration ?? null;
  const costUsd = message?.cost ?? call?.cost ?? null;
  const endedReason = message?.endedReason ?? call?.endedReason ?? null;
  const startedAt = call?.startedAt ?? message?.startedAt ?? null;
  const endedAt = call?.endedAt ?? message?.endedAt ?? null;
  const phoneCallProvider = call?.phoneCallProvider ?? message?.phoneCallProvider ?? null;
  const phoneCallTransport = call?.phoneCallTransport ?? message?.phoneCallTransport ?? null;

  // Analysis
  const summary = analysis?.summary ?? message?.summary ?? null;
  const sentiment = analysis?.sentiment ?? null;
  const successEvaluation = analysis?.successEvaluation ?? null;

  // Recordings
  const recordingUrl = artifact?.recordingUrl ?? message?.recordingUrl ?? call?.recordingUrl ?? null;
  const stereoRecordingUrl = artifact?.stereoRecordingUrl ?? message?.stereoRecordingUrl ?? call?.stereoRecordingUrl ?? null;

  // Transcript — flat text
  const rawTranscript = artifact?.transcript ?? message?.transcript ?? null;
  let fullTranscript = null;
  if (typeof rawTranscript === 'string') {
    fullTranscript = rawTranscript;
  } else if (Array.isArray(rawTranscript)) {
    fullTranscript = rawTranscript.map((t) => `${t.role}: ${t.text}`).join('\n');
  }

  // Structured messages (per-turn with timestamps)
  const messages = artifact?.messages ?? message?.messages ?? [];
  const structuredTurns = messages.map((m) => ({
    role: m.role,
    content: m.content || m.message || '',
    time: m.time || m.secondsFromStart || null,
  }));

  // Word counts from structured turns
  const userTurns = structuredTurns.filter((t) => t.role === 'user');
  const botTurns = structuredTurns.filter((t) => ['bot', 'assistant'].includes(t.role));
  const userWordCount = userTurns.reduce((sum, t) => sum + (t.content || '').split(/\s+/).filter(Boolean).length, 0);
  const botWordCount = botTurns.reduce((sum, t) => sum + (t.content || '').split(/\s+/).filter(Boolean).length, 0);
  const avgBotResponseLength = botTurns.length > 0
    ? Math.round(botWordCount / botTurns.length)
    : 0;

  // Cost breakdown
  const costs = message?.costs ?? [];

  console.log(`[PROCESSOR] Processing call=${callId} duration=${durationSec}s cost=$${costUsd} reason=${endedReason} turns=${structuredTurns.length} recordings=${recordingUrl ? 'yes' : 'no'}`);

  // ─── Update call_attempts with ALL fields ─────────────────────────────

  const updated = await sql`
    UPDATE call_attempts
    SET
      status = 'completed',
      duration_sec = COALESCE(${durationSec}, duration_sec),
      cost_usd = COALESCE(${costUsd}, cost_usd),
      ended_reason = COALESCE(${endedReason}, ended_reason),
      vapi_started_at = COALESCE(${startedAt}, vapi_started_at),
      vapi_ended_at = COALESCE(${endedAt}, vapi_ended_at),
      recording_url = COALESCE(${recordingUrl}, recording_url),
      stereo_recording_url = COALESCE(${stereoRecordingUrl}, stereo_recording_url),
      vapi_summary = COALESCE(${summary}, vapi_summary),
      success_evaluation = COALESCE(${successEvaluation}, success_evaluation),
      phone_call_provider = COALESCE(${phoneCallProvider}, phone_call_provider),
      phone_call_transport = COALESCE(${phoneCallTransport}, phone_call_transport),
      updated_at = NOW()
    WHERE vapi_call_id = ${callId}
    RETURNING id, contact_id, campaign_id
  `;

  if (updated.length === 0) {
    // Call attempt doesn't exist yet — create it (handles calls submitted outside our campaign scripts)
    console.warn(`[PROCESSOR] No call_attempt found for vapi_call_id=${callId} — creating stub record`);
    const inserted = await sql`
      INSERT INTO call_attempts (
        campaign_id, contact_id, vapi_call_id, attempt_number, call_type, status,
        ended_reason, duration_sec, cost_usd, vapi_started_at, vapi_ended_at,
        recording_url, stereo_recording_url, vapi_summary, success_evaluation,
        phone_call_provider, phone_call_transport, phone_number_used, assistant_id_used
      ) VALUES (
        (SELECT id FROM campaigns LIMIT 1),
        (SELECT id FROM contacts LIMIT 1),
        ${callId}, 1, 'outbound', 'completed',
        ${endedReason}, ${durationSec}, ${costUsd}, ${startedAt}, ${endedAt},
        ${recordingUrl}, ${stereoRecordingUrl}, ${summary}, ${successEvaluation},
        ${phoneCallProvider}, ${phoneCallTransport},
        ${call?.phoneNumberId || 'unknown'}, ${call?.assistantId || 'unknown'}
      )
      ON CONFLICT (vapi_call_id) DO NOTHING
      RETURNING id, contact_id, campaign_id
    `;
    if (inserted.length === 0) {
      console.error(`[PROCESSOR] Failed to create stub record for ${callId}`);
      return;
    }
    updated.push(inserted[0]);
  }

  const callAttempt = updated[0];

  // ─── Insert/update transcript with structured data ────────────────────

  if (fullTranscript || structuredTurns.length > 0) {
    await sql`
      INSERT INTO transcripts (
        call_attempt_id, vapi_call_id, full_transcript, summary, sentiment,
        structured_turns, turn_count, user_word_count, bot_word_count, avg_bot_response_length
      ) VALUES (
        ${callAttempt.id}, ${callId}, ${fullTranscript}, ${summary}, ${sentiment},
        ${JSON.stringify(structuredTurns)}::jsonb, ${structuredTurns.length},
        ${userWordCount}, ${botWordCount}, ${avgBotResponseLength}
      )
      ON CONFLICT (call_attempt_id) DO UPDATE SET
        full_transcript = COALESCE(EXCLUDED.full_transcript, transcripts.full_transcript),
        summary = COALESCE(EXCLUDED.summary, transcripts.summary),
        sentiment = COALESCE(EXCLUDED.sentiment, transcripts.sentiment),
        structured_turns = COALESCE(EXCLUDED.structured_turns, transcripts.structured_turns),
        turn_count = COALESCE(EXCLUDED.turn_count, transcripts.turn_count),
        user_word_count = COALESCE(EXCLUDED.user_word_count, transcripts.user_word_count),
        bot_word_count = COALESCE(EXCLUDED.bot_word_count, transcripts.bot_word_count),
        avg_bot_response_length = COALESCE(EXCLUDED.avg_bot_response_length, transcripts.avg_bot_response_length),
        updated_at = NOW()
    `;
    console.log(`[PROCESSOR] Transcript stored: ${structuredTurns.length} turns, user=${userWordCount} words, bot=${botWordCount} words`);
  }

  // ─── Insert cost breakdown ────────────────────────────────────────────

  if (costs.length > 0) {
    for (const cost of costs) {
      const component = cost.type || cost.component || 'unknown';
      const amount = cost.cost ?? cost.amount ?? 0;
      await sql`
        INSERT INTO cost_breakdown (call_attempt_id, vapi_call_id, component, cost_usd)
        VALUES (${callAttempt.id}, ${callId}, ${component}, ${amount})
        ON CONFLICT (vapi_call_id, component) DO UPDATE SET
          cost_usd = EXCLUDED.cost_usd
      `;
    }
    console.log(`[PROCESSOR] Cost breakdown stored: ${costs.length} components`);
  }

  // ─── Download and store recordings ────────────────────────────────────

  if (recordingUrl) {
    downloadRecording(callId, callAttempt.id, recordingUrl, 'mono').catch((err) =>
      console.error(`[RECORDER] Mono download failed: ${err.message}`)
    );
  }
  if (stereoRecordingUrl) {
    downloadRecording(callId, callAttempt.id, stereoRecordingUrl, 'stereo').catch((err) =>
      console.error(`[RECORDER] Stereo download failed: ${err.message}`)
    );
  }

  // ─── Check for DNC opt-outs ───────────────────────────────────────────

  await checkAndFlagDNC(callId, endedReason, fullTranscript, callAttempt);

  console.log(`[PROCESSOR] ✅ call_attempt ${callAttempt.id} fully processed`);
}

/**
 * Download a recording from VAPI and store locally + update DB.
 */
async function downloadRecording(callId, callAttemptId, url, type) {
  const shortId = callId.substring(0, 12);
  const filename = `${shortId}-${type}.wav`;
  const localPath = path.join(RECORDINGS_DIR, filename);

  // Ensure directory exists
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(localPath);

    proto.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        // Follow redirect
        proto.get(response.headers.location, (redirected) => {
          redirected.pipe(file);
          file.on('finish', () => file.close(() => onComplete()));
        }).on('error', reject);
        return;
      }
      response.pipe(file);
      file.on('finish', () => file.close(() => onComplete()));
    }).on('error', (err) => {
      fs.unlink(localPath, () => {}); // Clean up partial file
      reject(err);
    });

    async function onComplete() {
      try {
        const stats = fs.statSync(localPath);
        await sql`
          INSERT INTO recordings (call_attempt_id, vapi_call_id, recording_type, vapi_url, local_path, file_size_bytes, downloaded_at)
          VALUES (${callAttemptId}, ${callId}, ${type}, ${url}, ${localPath}, ${stats.size}, NOW())
          ON CONFLICT (vapi_call_id, recording_type) DO UPDATE SET
            local_path = EXCLUDED.local_path,
            file_size_bytes = EXCLUDED.file_size_bytes,
            downloaded_at = NOW()
        `;
        // Mark call as having stored recordings
        await sql`
          UPDATE call_attempts SET recording_stored = true WHERE vapi_call_id = ${callId}
        `;
        console.log(`[RECORDER] ✅ ${type} recording saved: ${localPath} (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
        resolve();
      } catch (err) {
        reject(err);
      }
    }
  });
}

/**
 * If endCallPhrases triggered or user explicitly opted out, flag contact in DNC list.
 */
async function checkAndFlagDNC(callId, endedReason, transcript, callAttempt) {
  const dncPhrases = [
    'do not call', 'stop calling', 'remove me', 'take me off',
    'opt out', 'unsubscribe', "don't call", 'never call',
    'not interested', 'remove my number',
  ];

  const hasDNCPhrase = transcript
    ? dncPhrases.some((phrase) => transcript.toLowerCase().includes(phrase))
    : false;

  if (hasDNCPhrase || endedReason === 'end-call-phrase-triggered') {
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
        INSERT INTO dnc_list (phone, source, reason, added_by, project_id)
        VALUES (${phone}, 'call_opt_out', ${reason}, 'webhook-processor', ${campaign_id})
        ON CONFLICT DO NOTHING
      `;

      // Also flag the contact
      await sql`
        UPDATE contacts SET opted_out = true, opted_out_at = NOW() WHERE phone = ${phone}
      `;

      console.log(`[DNC] ⚠️ Flagged ${phone} — reason: ${reason}`);
    }
  }
}

module.exports = { processEndOfCallReport };
