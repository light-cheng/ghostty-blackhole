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
  }

  pause() {
    if (this._state === State.IDLE) return;
    this._paused = true;
    this._stopInterval();
  }

  resume() {
    if (this._state === State.IDLE || !this._paused) return;
    this._paused = false;
    this._startInterval();
  }

  stop() {
    this._stopInterval();
    this._remainingMs = 0;
    this._paused = false;
    this._cycles = 0;
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
  }

  /**
   * End the break early (user dismissed screensaver).
   * Returns true if a new work cycle should begin (loop mode).
   */
  endBreak() {
    this._stopInterval();
    this._cycles++;
    const shouldLoop = this.loop;
    if (shouldLoop) {
      this.start();
    } else {
      this._remainingMs = 0;
      this._setState(State.IDLE);
    }
    return shouldLoop;
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
      // Work session finished → trigger screensaver
      this.emit('triggered');
      // The main process will call startBreak() after showing the screensaver
    } else if (this._state === State.BREAK) {
      // Break ended naturally
      this.emit('breakEnd');
      if (this.loop) {
        this.start();
      } else {
        this._setState(State.IDLE);
      }
    }
  }
}

module.exports = { TimerManager, State };
