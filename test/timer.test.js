'use strict';

// Unit tests for the work/break state machine.
// Run with: npm test  (Node.js built-in test runner, no extra dependency)

const test = require('node:test');
const assert = require('node:assert/strict');

const { TimerManager, State } = require('../timer.js');

/**
 * Fresh timer with mocked wall clock and intervals.
 * Keeping work/break at one minute makes every countdown one exact tick train.
 */
function createTimer(t, overrides = {}) {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const timer = new TimerManager();
  timer.workMinutes = 1;
  timer.breakMinutes = 1;
  timer.loop = true;
  Object.assign(timer, overrides);
  t.after(() => {
    timer.stop();
    t.mock.timers.reset();
  });
  return timer;
}

function collectTicks(timer) {
  const ticks = [];
  timer.on('tick', (remainingSeconds, state) => {
    ticks.push({ remainingSeconds, state });
  });
  return ticks;
}

test('start enters WORKING with the full duration and emits an immediate tick', (t) => {
  const timer = createTimer(t);
  const ticks = collectTicks(timer);

  timer.start();

  assert.equal(timer.state, State.WORKING);
  assert.equal(timer.paused, false);
  assert.equal(timer.remainingSeconds, 60);
  assert.deepEqual(ticks, [{ remainingSeconds: 60, state: State.WORKING }]);
  assert.equal(timer.getSnapshot().cycles, 0);
});

test('tick decrements remaining time from the wall clock, not the interval count', (t) => {
  const timer = createTimer(t);
  const ticks = collectTicks(timer);

  timer.start();
  t.mock.timers.tick(1000);
  assert.equal(timer.remainingSeconds, 59);

  // A 2s step may run the 1s interval twice; either way the wall-clock delta
  // must leave exactly 57s on the clock.
  t.mock.timers.tick(2000);
  assert.equal(timer.remainingSeconds, 57);
  assert.deepEqual(ticks.at(-1), { remainingSeconds: 57, state: State.WORKING });
});

test('completed WORK emits triggered and increments cycles exactly once', (t) => {
  const timer = createTimer(t);
  let triggered = 0;
  timer.on('triggered', () => {
    triggered++;
  });

  timer.start();
  t.mock.timers.tick(60000);

  assert.equal(timer.remainingSeconds, 0);
  assert.equal(triggered, 1);
  assert.equal(timer.getSnapshot().cycles, 1);

  // The interval must be cleared: more elapsed time cannot re-fire the cycle.
  t.mock.timers.tick(60000);
  assert.equal(triggered, 1);
  assert.equal(timer.getSnapshot().cycles, 1);
});

test('natural break end calls endBreak once and starts WORKING exactly once (loop mode)', (t) => {
  const timer = createTimer(t, { loop: true });
  const ticks = collectTicks(timer);

  let breakEnds = 0;
  let startCalls = 0;
  const originalStart = timer.start.bind(timer);
  timer.start = (...args) => {
    startCalls++;
    return originalStart(...args);
  };
  timer.on('breakEnd', () => {
    breakEnds++;
    // Mirrors main.js: the hide path calls endBreak() once; endBreak decides
    // whether to start the next work countdown.
    timer.endBreak();
  });

  timer.startBreak();
  t.mock.timers.tick(60000);

  assert.equal(breakEnds, 1);
  assert.equal(startCalls, 1);
  assert.equal(timer.state, State.WORKING);
  assert.equal(timer.remainingSeconds, 60);

  const workTicks = ticks.filter(
    (tick) => tick.state === State.WORKING && tick.remainingSeconds === 60
  );
  assert.equal(workTicks.length, 1);
  assert.equal(timer.getSnapshot().cycles, 0);
});

test('natural break end in loop=false goes IDLE without starting work', (t) => {
  const timer = createTimer(t, { loop: false });
  let startCalls = 0;
  const originalStart = timer.start.bind(timer);
  timer.start = (...args) => {
    startCalls++;
    return originalStart(...args);
  };
  timer.on('breakEnd', () => timer.endBreak());

  timer.startBreak();
  t.mock.timers.tick(60000);

  assert.equal(startCalls, 0);
  assert.equal(timer.state, State.IDLE);
  assert.equal(timer.remainingSeconds, 0);
});

test('endBreak({ resumeWork: false }) goes IDLE without starting work', (t) => {
  const timer = createTimer(t);
  timer.startBreak();

  assert.equal(timer.endBreak({ resumeWork: false }), false);
  assert.equal(timer.state, State.IDLE);
  assert.equal(timer.remainingSeconds, 0);
  assert.equal(timer.getSnapshot().cycles, 0);

  // Calling it outside a break is a no-op, even when it asks to resume work.
  assert.equal(timer.endBreak({ resumeWork: true }), false);
  assert.equal(timer.state, State.IDLE);
  assert.equal(timer.remainingSeconds, 0);
});

test('stop returns to IDLE without resetting completed cycles', (t) => {
  const timer = createTimer(t);
  timer.start();
  t.mock.timers.tick(60000);
  assert.equal(timer.getSnapshot().cycles, 1);

  timer.stop();

  assert.equal(timer.state, State.IDLE);
  assert.equal(timer.remainingSeconds, 0);
  assert.equal(timer.paused, false);
  assert.equal(timer.getSnapshot().cycles, 1);
});

test('start, pause and resume emit immediate ticks and pause freezes the countdown', (t) => {
  const timer = createTimer(t);
  const ticks = collectTicks(timer);

  timer.start();
  assert.equal(ticks.length, 1);
  assert.deepEqual(ticks.at(-1), { remainingSeconds: 60, state: State.WORKING });

  t.mock.timers.tick(1000);
  assert.equal(timer.remainingSeconds, 59);

  timer.pause();
  assert.equal(timer.paused, true);
  assert.deepEqual(ticks.at(-1), { remainingSeconds: 59, state: State.WORKING });

  const ticksAtPause = ticks.length;
  t.mock.timers.tick(5000);
  assert.equal(ticks.length, ticksAtPause, 'paused timer must not tick');
  assert.equal(timer.remainingSeconds, 59);

  timer.resume();
  assert.equal(timer.paused, false);
  assert.deepEqual(ticks.at(-1), { remainingSeconds: 59, state: State.WORKING });

  t.mock.timers.tick(1000);
  assert.equal(timer.remainingSeconds, 58);
});

test('startBreak enters BREAK with the full break and emits an immediate tick', (t) => {
  const timer = createTimer(t);
  const ticks = collectTicks(timer);

  timer.startBreak();

  assert.equal(timer.state, State.BREAK);
  assert.equal(timer.paused, false);
  assert.equal(timer.remainingSeconds, 60);
  assert.deepEqual(ticks, [{ remainingSeconds: 60, state: State.BREAK }]);
});
