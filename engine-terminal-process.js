const { EventEmitter } = require("node:events");

const instances = new WeakSet();
const stopGroup = child => {
  if (Number.isInteger(child.pid) && child.pid > 0) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* the process group may already have exited */ }
  }
};

// A persistent display, not a persistent command interpreter. Each approved
// command gets a fresh shell, argv and PTY. Operator keys only reach the active
// child: no idle input is retained for the next command.
class EngineTerminalProcess extends EventEmitter {
  constructor({ pty, cwd, env = {}, cols = 120, rows = 32, platform = process.platform }) {
    super();
    if (platform === "win32") throw new Error("Engine command terminals are not supported on Windows yet. Use run_shell.");
    if (!pty || typeof pty.spawn !== "function") throw new Error("This build has no command terminal support.");
    this.pty = pty; this.cwd = cwd; this.env = { ...env }; this.cols = cols; this.rows = rows;
    this.active = null; this.closed = false;
    instances.add(this);
  }
  onData(fn) { this.on("data", fn); return { dispose: () => this.off("data", fn) }; }
  onExit(fn) { this.on("exit", fn); return { dispose: () => this.off("exit", fn) }; }
  runCommand(command, { onData, onExit }) {
    if (this.closed) throw new Error("The terminal session ended.");
    if (this.active) throw new Error("This terminal is still running the last command.");
    // Privileged mode suppresses BASH_ENV, imported functions and shell option
    // environment hooks. No login or interactive startup files are evaluated.
    const child = this.pty.spawn("/bin/bash", ["--noprofile", "--norc", "-p", "-c", command], {
      cwd: this.cwd, env: { ...this.env }, cols: this.cols, rows: this.rows, name: "xterm-256color",
    });
    const run = this.active = { child, subscriptions: [] };
    run.subscriptions.push(child.onData(data => {
      if (this.active !== run || this.closed) return;
      onData(data); this.emit("data", data);
    }));
    run.subscriptions.push(child.onExit(result => {
      if (this.active !== run) return;
      this.active = null;
      stopGroup(child);
      for (const subscription of run.subscriptions) subscription?.dispose?.();
      onExit(result);
    }));
  }
  write(data) {
    if (this.closed) throw new Error("The terminal session ended.");
    if (typeof data !== "string") throw new Error("Invalid terminal input.");
    if (!this.active) throw new Error("No command is running. Open an operator terminal to type shell commands.");
    this.active.child.write(data);
  }
  resize(cols, rows) { this.cols = cols; this.rows = rows; this.active?.child.resize(cols, rows); }
  pause() { this.active?.child.pause?.(); }
  resume() { this.active?.child.resume?.(); }
  kill() {
    if (this.closed) return;
    this.closed = true;
    const run = this.active; this.active = null;
    if (run) {
      for (const subscription of run.subscriptions) subscription?.dispose?.();
      // forkpty creates a process group. End foreground descendants as well
      // as the shell so Stop cannot leave a build running behind the panel.
      stopGroup(run.child);
      try { run.child.kill("SIGKILL"); } catch { /* the child may already have exited */ }
    }
    this.emit("exit", { exitCode: 0 });
  }
}

module.exports = { EngineTerminalProcess, isEngineTerminalProcess: value => instances.has(value) };
