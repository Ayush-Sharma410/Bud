/**
 * Bud — Retry Tool Executor Tests
 *
 * Run with: npx ts-node app/src/main/orchestrator/tests/RetryToolExecutor.test.ts
 */

import { executeWithRetry, isTransientError } from '../RetryToolExecutor';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error('❌ FAIL:', message);
    process.exit(1);
  }
  console.log('✅ PASS:', message);
}

async function runTests() {
  // Test 1: succeeds on first try
  {
    let calls = 0;
    const result = await executeWithRetry(async () => {
      calls++;
      return 'ok';
    });
    assert(result === 'ok', 'returns result on first success');
    assert(calls === 1, 'no retries on success');
  }

  // Test 2: retries transient error then succeeds
  {
    let calls = 0;
    let retries = 0;
    const result = await executeWithRetry(
      async () => {
        calls++;
        if (calls < 3) {
          const err: any = new Error('ETIMEDOUT');
          err.code = 'ETIMEDOUT';
          throw err;
        }
        return 'recovered';
      },
      { maxRetries: 3, baseDelayMs: 10 },
      (attempt) => { retries = attempt; }
    );
    assert(result === 'recovered', 'returns result after transient retries');
    assert(calls === 3, 'retried twice before success');
    assert(retries === 2, 'retry callback fired twice');
  }

  // Test 3: non-transient error does not retry
  {
    let calls = 0;
    try {
      await executeWithRetry(
        async () => {
          calls++;
          const err: any = new Error('Bad request');
          err.status = 400;
          throw err;
        },
        { maxRetries: 3 }
      );
      assert(false, 'should have thrown');
    } catch (e) {
      assert(calls === 1, 'no retry on 4xx error');
    }
  }

  // Test 4: isTransientError detection
  {
    const transient = new Error('socket hang up');
    assert(isTransientError(transient), 'socket hang up is transient');

    const notTransient: any = new Error('not found');
    notTransient.status = 404;
    assert(!isTransientError(notTransient), '404 is not transient');
  }

  console.log('\n🎉 All RetryToolExecutor tests passed');
}

runTests();
