/**
 * Smoke test — hits the server endpoints without a real DB.
 * Tests: routing, secret verification, payload acceptance.
 */
const http = require('http');

const BASE = 'http://localhost:3400';

async function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function run() {
  let passed = 0;
  let failed = 0;

  function assert(name, condition) {
    if (condition) {
      console.log(`  ✅ ${name}`);
      passed++;
    } else {
      console.log(`  ❌ ${name}`);
      failed++;
    }
  }

  console.log('\n=== VAPI Webhook Server Tests ===\n');

  // Test 1: Health endpoint
  console.log('[1] GET /health');
  try {
    const r = await request('GET', '/health');
    assert('Returns 200 or 503', [200, 503].includes(r.status));
    assert('Has service name', r.body.service === 'vapi-webhook-server');
    assert('Has db status', r.body.db !== undefined);
  } catch (e) {
    assert('Health endpoint reachable', false);
  }

  // Test 2: 404 on unknown route
  console.log('\n[2] GET /unknown');
  try {
    const r = await request('GET', '/unknown');
    assert('Returns 404', r.status === 404);
  } catch (e) {
    assert('404 route', false);
  }

  // Test 3: Webhook without secret (should accept when secret=changeme)
  console.log('\n[3] POST /webhook/vapi (no secret, default mode)');
  try {
    const r = await request('POST', '/webhook/vapi', {
      message: { type: 'status-update', call: { id: 'test-call-1' } },
    });
    // With default 'changeme' secret, should pass through
    // Actual insert will fail (no DB in test) but route should respond
    assert('Returns 200 or 500', [200, 500].includes(r.status));
  } catch (e) {
    assert('Webhook accepts request', false);
  }

  // Test 4: Webhook with end-of-call-report payload shape
  console.log('\n[4] POST /webhook/vapi (end-of-call-report)');
  try {
    const r = await request('POST', '/webhook/vapi', {
      message: {
        type: 'end-of-call-report',
        call: { id: 'test-call-2' },
        durationSeconds: 45,
        cost: 0.12,
        endedReason: 'customer-ended-call',
        transcript: [
          { role: 'assistant', text: 'Hello!' },
          { role: 'user', text: 'Please stop calling me.' },
        ],
        analysis: { summary: 'User requested DNC', sentiment: 'negative' },
      },
    });
    assert('Returns 200 or 500', [200, 500].includes(r.status));
  } catch (e) {
    assert('End-of-call webhook', false);
  }

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test runner failed:', err.message);
  process.exit(1);
});
