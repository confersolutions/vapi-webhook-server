const { sql } = require('../db');

/**
 * Process call outcome — updates campaign_contacts, campaign counters,
 * campaign_events, and budget tracking after a call completes.
 * 
 * Runs AFTER processEndOfCallReport() completes.
 * If this function fails, call data is already saved — outcome can be retried
 * by querying call_attempts WHERE outcome_processed = FALSE.
 */
async function processOutcome(callAttemptId, vapiCallId) {
  // 1. Fetch the call attempt with all fields we need
  const [attempt] = await sql`
    SELECT id, campaign_id, campaign_contact_id, contact_id, vapi_call_id,
           status, duration_sec, cost_usd, vapi_summary, ended_reason
    FROM call_attempts WHERE id = ${callAttemptId}
  `;

  if (!attempt) {
    console.warn(`[OUTCOME] No call_attempt found for id=${callAttemptId}`);
    return;
  }

  // 2. If no campaign_contact_id, this is an ad-hoc call — mark processed and skip
  if (!attempt.campaign_contact_id) {
    await sql`UPDATE call_attempts SET outcome_processed = TRUE WHERE id = ${callAttemptId}`;
    console.log(`[OUTCOME] Ad-hoc call ${vapiCallId} — no campaign, skipping`);
    return;
  }

  // 3. Fetch campaign_contacts and parent campaign
  const [cc] = await sql`
    SELECT id, campaign_id, contact_id, attempt_number, max_attempts
    FROM campaign_contacts WHERE id = ${attempt.campaign_contact_id}
  `;

  if (!cc) {
    console.warn(`[OUTCOME] No campaign_contacts row for id=${attempt.campaign_contact_id}`);
    await sql`UPDATE call_attempts SET outcome_processed = TRUE WHERE id = ${callAttemptId}`;
    return;
  }

  const [campaign] = await sql`
    SELECT id, retry_logic, call_budget, status as campaign_status
    FROM campaigns WHERE id = ${cc.campaign_id}
  `;

  const retryLogic = campaign?.retry_logic || { max_attempts: 3, retry_delay_hours: 24 };
  const maxAttempts = retryLogic.max_attempts || 3;
  const retryDelayHours = retryLogic.retry_delay_hours || 24;

  // 4. Classify the outcome
  const outcome = classifyOutcome(attempt);
  const newStatus = mapOutcomeToStatus(outcome);

  console.log(`[OUTCOME] call=${vapiCallId} outcome=${outcome} status=${newStatus} duration=${attempt.duration_sec}s cost=$${attempt.cost_usd}`);

  // 5. Update campaign_contacts
  const newAttempts = (cc.attempt_number || 0) + 1;

  await sql`
    UPDATE campaign_contacts SET
      status = ${newStatus},
      outcome = ${outcome},
      last_vapi_call_id = ${attempt.vapi_call_id},
      last_duration_sec = ${attempt.duration_sec},
      last_cost_usd = ${attempt.cost_usd},
      last_summary = ${attempt.vapi_summary},
      attempt_number = ${newAttempts},
      last_called_at = NOW(),
      updated_at = NOW()
    WHERE id = ${cc.id}
  `;

  // 6. If callback — set next_attempt_after
  if (outcome === 'callback') {
    await sql`
      UPDATE campaign_contacts SET
        status = 'pending',
        next_retry_after = NOW() + ${retryDelayHours + ' hours'}::interval
      WHERE id = ${cc.id}
    `;
    console.log(`[OUTCOME] Callback scheduled: retry after ${retryDelayHours}h`);
  }

  // 7. If DNC — flag the contact (dnc_list insert handled by existing DNC processor)
  if (outcome === 'dnc') {
    await sql`
      UPDATE contacts SET opted_out = TRUE, opted_out_at = NOW()
      WHERE id = ${cc.contact_id}
    `;
    console.log(`[OUTCOME] DNC flagged for contact ${cc.contact_id}`);
  }

  // 8. If exhausted (hit max attempts and still retryable)
  if (newAttempts >= maxAttempts && ['pending', 'voicemail', 'no_answer'].includes(newStatus)) {
    await sql`
      UPDATE campaign_contacts SET status = 'exhausted', updated_at = NOW()
      WHERE id = ${cc.id}
    `;
    console.log(`[OUTCOME] Contact exhausted after ${newAttempts} attempts`);
  }

  // 9. Insert campaign_event
  await sql`
    INSERT INTO campaign_events (campaign_id, contact_id, event_type, event_data)
    VALUES (
      ${cc.campaign_id},
      ${cc.contact_id},
      'call_completed',
      ${sql.json({
        outcome,
        duration_sec: attempt.duration_sec,
        cost_usd: attempt.cost_usd,
        vapi_call_id: attempt.vapi_call_id,
        attempt_number: newAttempts,
      })}
    )
  `;

  // 10. Update campaign aggregate counters
  await sql`
    UPDATE campaigns SET
      total_called = COALESCE(total_called, 0) + 1,
      total_answered = COALESCE(total_answered, 0) + ${outcome === 'interested' || outcome === 'not_interested' || outcome === 'callback' ? 1 : 0},
      total_voicemail = COALESCE(total_voicemail, 0) + ${outcome === 'voicemail' ? 1 : 0},
      total_no_answer = COALESCE(total_no_answer, 0) + ${outcome === 'no_answer' ? 1 : 0},
      total_opted_out = COALESCE(total_opted_out, 0) + ${outcome === 'dnc' ? 1 : 0},
      total_interested = COALESCE(total_interested, 0) + ${outcome === 'interested' ? 1 : 0},
      actual_cost = COALESCE(actual_cost, 0) + COALESCE(${attempt.cost_usd}, 0),
      updated_at = NOW()
    WHERE id = ${cc.campaign_id}
  `;

  // 11. Budget check
  if (campaign?.call_budget) {
    const [{ total }] = await sql`
      SELECT COALESCE(SUM(cost_usd), 0) as total FROM call_attempts WHERE campaign_id = ${cc.campaign_id}
    `;
    const budget = parseFloat(campaign.call_budget);
    const spent = parseFloat(total);

    if (spent >= budget) {
      await sql`UPDATE campaigns SET status = 'paused', updated_at = NOW() WHERE id = ${cc.campaign_id}`;
      await sql`
        INSERT INTO campaign_events (campaign_id, event_type, event_data)
        VALUES (${cc.campaign_id}, 'campaign_paused', ${sql.json({ reason: 'budget_exceeded', spent, budget })})
      `;
      console.log(`[OUTCOME] ⚠️ BUDGET EXCEEDED: $${spent}/$${budget} — campaign PAUSED`);
    } else if (spent >= budget * 0.75) {
      await sql`
        INSERT INTO campaign_events (campaign_id, event_type, event_data)
        VALUES (${cc.campaign_id}, 'budget_warning', ${sql.json({ current_spend: spent, max_budget: budget })})
      `;
      console.log(`[OUTCOME] ⚠️ Budget warning: $${spent}/$${budget} (75%+)`);
    }
  }

  // 12. Mark outcome as processed
  await sql`UPDATE call_attempts SET outcome_processed = TRUE WHERE id = ${callAttemptId}`;

  console.log(`[OUTCOME] ✅ Campaign contact ${cc.id} updated: outcome=${outcome}, attempts=${newAttempts}`);
}

/**
 * Classify call outcome from call attempt data.
 * Conservative: prefers 'callback' over 'interested' when ambiguous.
 */
function classifyOutcome(attempt) {
  const summary = (attempt.vapi_summary || '').toLowerCase();
  const endedReason = (attempt.ended_reason || '').toLowerCase();
  const duration = parseFloat(attempt.duration_sec) || 0;

  // 1. DNC — check ended_reason and summary
  const dncSignals = ['do not call', 'stop calling', 'remove me', "don't call",
    'not interested', 'no thank you', 'no thanks', 'go away', 'hang up'];
  if (endedReason === 'end-call-phrase-triggered' ||
      dncSignals.some(s => summary.includes(s))) {
    return 'dnc';
  }

  // 2. Voicemail
  if (endedReason.includes('voicemail') || endedReason === 'voicemail-reached') {
    return 'voicemail';
  }

  // 3. No answer / too short
  if (duration < 10 || endedReason === 'silence-timed-out' || endedReason === 'no-answer') {
    return 'no_answer';
  }

  // 4. Interested signals
  const interestedSignals = ['schedule', 'meeting', 'follow-up', 'follow up',
    'appointment', 'interested', 'send me', 'tell me more', 'sounds good',
    "let's talk", 'next week', 'demo', 'sign up', 'try it',
    'discovery call', 'calendar invite', 'send the invite'];
  if (interestedSignals.some(s => summary.includes(s))) {
    return 'interested';
  }

  // 5. Explicit rejection
  const rejectionSignals = ['not interested', 'no thank you', 'no thanks',
    'already have', "don't need", 'not looking'];
  if (rejectionSignals.some(s => summary.includes(s))) {
    return 'not_interested';
  }

  // 6. Long call but unclear — worth retrying
  if (duration > 30) {
    return 'callback';
  }

  // 7. Default
  return 'not_interested';
}

/**
 * Map outcome to campaign_contacts status enum.
 */
function mapOutcomeToStatus(outcome) {
  const map = {
    'interested': 'completed',
    'not_interested': 'completed',
    'callback': 'pending',
    'voicemail': 'voicemail',
    'no_answer': 'no_answer',
    'wrong_number': 'failed',
    'dnc': 'do_not_call',
  };
  return map[outcome] || 'completed';
}

module.exports = { processOutcome };
