# Coding from a phone

The setup: a terminal on the phone, reaching the Mac over the tailnet, with the
shell living in tmux so nothing is lost when the connection dies — and it will
die, constantly.

```bash
bash scripts/setup-mobile-dev.sh      # on the Mac. Idempotent; re-run any time.
```

It checks the tailnet, Remote Login, mosh, tmux, the firewall and sleep
settings, fixes what it can, prints the rest as commands to run, and ends with
the exact line to put in the phone's terminal app.

## Why sessions drop, and why a different SSH client will not help

An SSH session lives *inside* its TCP connection. A phone destroys TCP
connections as a matter of routine:

| What happens | What it does to TCP |
| --- | --- |
| You switch apps, or the screen locks | iOS/Android suspends the app; the socket is torn down |
| Wi-Fi hands off to cellular, or you change towers | Your source IP changes; TCP is bound to the old one |
| The lid closes, or the Mac idles on battery | The far end stops existing |

No client can survive these by being better at SSH, because in every case the
connection is genuinely gone. What is fixable is how much you lose when it goes.

**tmux** moves the shell out of the connection. Your editor, your build, your
`claude` session keep running on the Mac with nothing attached. Reconnecting is
a reattach, not a restart.

**mosh** replaces the transport. It is UDP with client-side prediction and it
re-binds when your address moves, so the roaming and suspend cases stop being
disconnections at all — you unlock the phone and the cursor is where you left
it. It authenticates by logging in over SSH once and handing back a one-time
key, which is why Remote Login still has to be on.

tmux is the part that matters. mosh is what makes it seamless.

## Connecting

The script prints this filled in, but the shape is:

```bash
mosh <you>@<machine>.<tailnet>.ts.net -- tmux new-session -A -s phone
```

`new-session -A` attaches to `phone` if it exists and creates it otherwise, so
one command covers both the first connection and every reconnection after.

In **Termius**: set Username and Address on the host, enable Mosh, and put the
`tmux` line in the host's startup command field. If your build has no Mosh
toggle, plain SSH with the same tmux command still recovers every drop — you
reconnect by hand rather than it happening for you. **Blink Shell** (iOS) has
Mosh built in and better hardware-keyboard handling if you pair one.

Two tmux keys worth knowing on a touchscreen, where there is no scrollbar:

- `Ctrl-b [` — enter scrollback (`q` to leave). Mouse mode is on, so you can
  also just drag.
- `Ctrl-b d` — detach deliberately, leaving everything running.

## Sleep is the one that will still get you

tmux survives a dropped connection. It does not survive the machine suspending
underneath it. A MacBook on battery with the lid shut is off as far as the
tailnet is concerned, and no amount of client configuration changes that. For
all-day access leave it open and on power with `sudo pmset -c sleep 0`; the
script reports the current setting either way.

## What this is not

The mobile app in `mobile/` is a different thing and not a substitute. It runs
the chat and the agent loop against the gateway and executes *one-shot*
commands — `mobile/src/mobile-bridge.js` explicitly refuses `tmux`, `vim`,
`less` and the rest, because a Capacitor webview has no PTY to give them. It is
for asking the agent to do something. This is for driving the machine yourself.
