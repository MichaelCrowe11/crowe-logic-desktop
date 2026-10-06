const { EventEmitter } = require("node:events");
class FakePty extends EventEmitter {
  constructor() { super(); this.inputs = []; }
  onData(fn) { this.on("data", fn); }
  onExit(fn) { this.on("exit", fn); }
  write(value) { this.inputs.push(value); }
  resize(cols, rows) { this.cols = cols; this.rows = rows; }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  kill() { this.emit("exit"); }
}
module.exports = { FakePty };
