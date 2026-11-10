const { EventEmitter } = require('events');

/**
 * Timer state machine for work/break cycles.
 *
 * States: IDLE → WORKING → BREAK → (IDLE or WORKING)
 *
 * Events emitted:
 *   tick(remainingSeconds, state)  — every second while running
 *   triggered()                    — work countdown reached zero
 *   breakEnd()                     — break period ended naturally
 *   stateChange(state)             — whenever state changes
 */

const State = {
  IDLE: 'IDLE',
  WORKING: 'WORKING',
  BREAK: 'BREAK',
};

class TimerManager extends EventEmitter {
  constructor() {
    super();
    this._state = State.IDLE;
    this._remainingMs = 0;
    this._intervalId = null;
    this._lastTickTime = null;
    this._paused = false;
    this._cycles = 0;

    // Configurable from outside
    this.workMinutes = 25;
    this.breakMinutes = 5;
    this.loop = true;
  }

  /* ───── public getters ───── */

  get state() {
    return this._state;
  }

  get paused() {
    return this._paused;
  }

  get remainingSeconds() {
    return Math.ceil(this._remainingMs / 1000);
  }

  /* ───── public API ───── */

  /**
   * Start a work countdown.
   * @param {number} [workMinutes] override for this cycle
   */
  start(workMinutes) {
    if (workMinutes !== undefined) this.workMinutes = workMinutes;
    this._setState(State.WORKING);
    this._remainingMs = this.workMinutes * 60 * 1000;
    this._paused = false;
    this._startInterval();
    this.emit('tick', this.remainingSeconds, this.state);
  }

  pause() {
    if (this._state === State.IDLE) return;
    this._paused = true;
    this._stopInterval();
    this.emit('tick', this.remainingSeconds, this.state);
  }

  resume() {
    if (this._state === State.IDLE || !this._paused) return;
    this._paused = false;
    this._startInterval();
    this.emit('tick', this.remainingSeconds, this.state);
  }

  stop() {
    this._stopInterval();
    this._remainingMs = 0;
    this._paused = false;
    this._setState(State.IDLE);
    this.emit('tick', 0, this.state);
  }

  /**
   * Start the break countdown (called when screensaver is shown).
   */
  startBreak() {
    this._setState(State.BREAK);
    this._remainingMs = this.breakMinutes * 60 * 1000;
    this._paused = false;
    this._startInterval();
    this.emit('tick', this.remainingSeconds, this.state);
  }

  /**
   * End the break. `resumeWork` starts a fresh work countdown (loop mode);
   * `countCycle` exists for callers that track completed work cycles.
   * Only the WORKING branch of `_onCountdownEnd` counts a cycle, so the
   * normal hide path never increments it.
   * @param {{ resumeWork?: boolean, countCycle?: boolean }} [options]
   * @returns {boolean} true when a work countdown was started
   */
  endBreak({ resumeWork = this.loop, countCycle = false } = {}) {
    if (this._state !== State.BREAK) return false;
    this._stopInterval();
    if (countCycle) this._cycles++;
    this._remainingMs = 0;
    this._paused = false;
    if (resumeWork) {
      this.start();
    } else {
      this._setState(State.IDLE);
      this.emit('tick', 0, this.state);
    }
    return !!resumeWork;
  }

  /**
   * Snapshot for IPC — lets renderer know current state at any time.
   */
  getSnapshot() {
    return {
      state: this._state,
      remainingSeconds: this.remainingSeconds,
      paused: this._paused,
      cycles: this._cycles,
      workMinutes: this.workMinutes,
      breakMinutes: this.breakMinutes,
      loop: this.loop,
    };
  }

  /* ───── internals ───── */

  _setState(next) {
    if (this._state === next) return;
    this._state = next;
    this.emit('stateChange', next);
  }

  _startInterval() {
    this._stopInterval(); // safety
    this._lastTickTime = Date.now();
    this._intervalId = setInterval(() => this._tick(), 1000);
  }

  _stopInterval() {
    if (this._intervalId !== null) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    this._lastTickTime = null;
  }

  /**
   * Drift-corrected tick: uses wall-clock delta instead of trusting
   * setInterval's 1 000 ms accuracy.
   */
  _tick() {
    const now = Date.now();
    const elapsed = now - (this._lastTickTime ?? now);
    this._lastTickTime = now;

    this._remainingMs = Math.max(0, this._remainingMs - elapsed);

    // Emit tick for UI updates
    this.emit('tick', this.remainingSeconds, this._state);

    if (this._remainingMs <= 0) {
      this._stopInterval();
      this._onCountdownEnd();
    }
  }

  _onCountdownEnd() {
    if (this._state === State.WORKING) {
      // A completed work session is the only thing that counts as a cycle.
      this._cycles++;
      // Work session finished → trigger screensaver
      this.emit('triggered');
      // The main process will call startBreak() after showing the screensaver
    } else if (this._state === State.BREAK) {
      // Break ended naturally. main's hide path calls endBreak() once,
      // which decides whether to start the next work countdown.
      this.emit('breakEnd');
    }
  }
}

module.exports = { TimerManager, State };
