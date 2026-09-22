#!/usr/bin/env bash
# Sets this Mac up to be coded on from a phone, over the tailnet.
#
# The problem this solves is not a flaky SSH client. It is that an SSH session
# lives *inside* its TCP connection, and a phone destroys TCP connections as a
# matter of routine: the OS suspends a backgrounded app, Wi-Fi hands off to
# cellular and the source IP changes, the lid closes and the far end sleeps.
# Every one of those ends the shell and everything running in it.
#
# So the shell is moved out of the connection (tmux) and the connection is made
# survivable (mosh, which is UDP and re-binds when the client's address moves).
# Drop the connection after this and nothing is lost — the reattach is the whole
# recovery, and with mosh it is automatic.
#
# Reads the machine's state and reports it; changes only what it is asked to.
# Anything needing sudo is printed as a command for you to run, not run for you.
#
#   bash scripts/setup-mobile-dev.sh            # check, install, report
#   bash scripts/setup-mobile-dev.sh --no-install   # report only
set -uo pipefail

INSTALL=1
[ "${1:-}" = "--no-install" ] && INSTALL=0

SESSION=phone            # the tmux session the phone attaches to
ok=0; warn=0; fail=0
say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
good() { printf '  \033[32m✓\033[0m %s\n' "$*"; ok=$((ok+1)); }
note() { printf '  \033[33m!\033[0m %s\n' "$*"; warn=$((warn+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; fail=$((fail+1)); }
fix()  { printf '      \033[36m%s\033[0m\n' "$*"; }

[ "$(uname -s)" = "Darwin" ] || { echo "This script is for the Mac side. Run it on the Mac." >&2; exit 1; }

# ---------------------------------------------------------------- 1. tailnet
# companion.js:45 reads the tailnet address off the interface list rather than
# shelling out to `tailscale`; same trick here, for the same reason — it works
# regardless of where the CLI ended up or whether it is on PATH.
say "Tailnet"
TSADDR=$(ifconfig 2>/dev/null | awk '/inet 100\./ {print $2}' \
  | awk -F. '$2 >= 64 && $2 <= 127 {print; exit}')
if [ -n "$TSADDR" ]; then
  good "Tailscale address $TSADDR"
else
  bad "No 100.64.0.0/10 address — Tailscale is not up or not signed in"
  fix "open -a Tailscale     # then sign in, and re-run this script"
fi

TSBIN=""
for c in /usr/local/bin/tailscale /opt/homebrew/bin/tailscale \
         /Applications/Tailscale.app/Contents/MacOS/Tailscale; do
  [ -x "$c" ] && { TSBIN="$c"; break; }
done
HOSTFQDN=""
if [ -n "$TSBIN" ]; then
  HOSTFQDN=$("$TSBIN" status --json 2>/dev/null \
    | /usr/bin/python3 -c 'import sys,json; print(json.load(sys.stdin).get("Self",{}).get("DNSName","").rstrip("."))' 2>/dev/null)
  [ -n "$HOSTFQDN" ] && good "MagicDNS name $HOSTFQDN" \
                     || note "CLI found but no MagicDNS name — is MagicDNS enabled for the tailnet?"
else
  note "No tailscale CLI at any known path (App Store install puts it elsewhere)"
  fix "MagicDNS name is nicer to type than the raw address, but not required here"
fi
HOST="${HOSTFQDN:-$TSADDR}"

# ------------------------------------------------------------------ 2. sshd
# mosh does not carry its own authentication. It logs in over SSH once, gets a
# one-time key and a UDP port back, and everything after that is mosh's own
# protocol. So Remote Login has to be on even though you will rarely use it
# directly. Checked by dialing the port, because `systemsetup -getremotelogin`
# wants sudo and, on recent macOS, Full Disk Access as well.
say "Remote Login"
if (exec 3<>/dev/tcp/127.0.0.1/22) 2>/dev/null; then
  good "sshd is listening on 22"
else
  bad "sshd is not listening — mosh cannot bootstrap without it"
  fix "System Settings ▸ General ▸ Sharing ▸ Remote Login  (or: sudo systemsetup -setremotelogin on)"
fi

# ------------------------------------------------------- 3. mosh, tmux, brew
say "Tools"
BREW=""
for c in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$c" ] && { BREW="$c"; break; }; done

need_install=()
for tool in mosh tmux; do
  if command -v "$tool" >/dev/null 2>&1; then
    good "$tool $("$tool" --version 2>&1 | head -1 | awk '{print $NF}')"
  else
    bad "$tool is not installed"
    need_install+=("$tool")
  fi
done

if [ ${#need_install[@]} -gt 0 ]; then
  if [ "$INSTALL" = 0 ]; then
    fix "brew install ${need_install[*]}"
  elif [ -n "$BREW" ]; then
    echo "  installing ${need_install[*]}…"
    "$BREW" install "${need_install[@]}" && good "installed ${need_install[*]}"
  else
    fix "Install Homebrew first: https://brew.sh — then: brew install ${need_install[*]}"
  fi
fi

# --------------------------------------------------------------- 4. firewall
# mosh-server binds a UDP port in 60000-61000. If macOS's application firewall
# is on and has not been told about the binary, it silently drops that traffic
# and the session hangs at "mosh: Connecting..." forever — which reads exactly
# like a network problem and is not one.
say "Firewall"
FW=/usr/libexec/ApplicationFirewall/socketfilterfw
if [ -x "$FW" ] && "$FW" --getglobalstate 2>/dev/null | grep -q "enabled"; then
  MOSHBIN=$(command -v mosh-server 2>/dev/null || true)
  if [ -z "$MOSHBIN" ]; then
    note "Firewall is on; check again once mosh is installed"
  elif "$FW" --getappblocked "$MOSHBIN" 2>/dev/null | grep -qi "permitted\|allowed"; then
    good "mosh-server is allowed through the firewall"
  else
    note "Firewall is on and mosh-server is not explicitly allowed"
    fix "sudo $FW --add $MOSHBIN"
    fix "sudo $FW --unblockapp $MOSHBIN"
  fi
else
  good "Application firewall is off — nothing to allow"
fi

# ------------------------------------------------------------------ 5. sleep
# The most common cause of a session that dies overnight and cannot be
# reattached in the morning. tmux survives a dropped connection; it does not
# survive the machine suspending underneath it.
say "Sleep"
SLEEPVAL=$(pmset -g custom 2>/dev/null | awk '/^AC Power/,0' | awk '/[^a-z]sleep/ {print $2; exit}')
if [ "${SLEEPVAL:-1}" = "0" ]; then
  good "Does not sleep on AC power"
else
  note "Sleeps after ${SLEEPVAL:-?} min on AC — a phone session will not survive that"
  fix "sudo pmset -c sleep 0          # stay awake while plugged in"
  fix "caffeinate -dimsu -w \$\$        # or, ad hoc, for one working session"
fi
if pmset -g 2>/dev/null | grep -q "lidwake"; then
  note "Closing the lid still sleeps this Mac unless an external display is attached"
  fix "For all-day access, leave it open and on power, or: sudo pmset -c disablesleep 1"
fi

# ------------------------------------------------------------- 6. tmux config
# Mobile-specific defaults. Mouse mode matters more than it sounds: without it
# there is no way to scroll on a touchscreen, since there is no scrollbar and no
# wheel. The long scrollback is because a phone screen shows ~20 lines and you
# will be scrolling back constantly.
say "tmux config"
TCONF="$HOME/.tmux.conf"
MARK="# --- crowe: phone defaults ---"
if [ -f "$TCONF" ] && grep -qF "$MARK" "$TCONF"; then
  good "phone defaults already in ~/.tmux.conf"
else
  cat >> "$TCONF" <<EOF

$MARK
set -g mouse on                 # scroll and pane-select by touch
set -g history-limit 50000      # a phone screen is ~20 lines; you will scroll
set -g status-interval 5
set -g escape-time 10           # mosh predicts locally; a long delay feels broken
setw -g aggressive-resize on    # phone and desktop attach at different sizes
set -g status-right '#[fg=colour245]#S #[fg=colour109]#(hostname -s)'
# --- end crowe ---
EOF
  good "appended phone defaults to ~/.tmux.conf"
fi

# ------------------------------------------------------------ 7. the session
say "Session"
if command -v tmux >/dev/null 2>&1; then
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    good "tmux session '$SESSION' is already running"
  else
    tmux new-session -d -s "$SESSION" -c "$HOME" 2>/dev/null \
      && good "started tmux session '$SESSION'" \
      || note "could not start the session (is a tmux server already running as another user?)"
  fi
else
  note "install tmux, then re-run to create the session"
fi

# ---------------------------------------------------------------- 8. what now
say "Connect from the phone"
USERNAME=$(id -un)
if [ -n "$HOST" ]; then
  cat <<EOF
  Host      $HOST
  User      $USERNAME
  Command   mosh $USERNAME@$HOST -- tmux new-session -A -s $SESSION

  'new-session -A' attaches if '$SESSION' exists and creates it if it does not,
  so the one command is both the first connection and every reconnection after.

  In Termius: edit the host, set Username and Address above, turn on Mosh, and
  put the tmux line in the host's startup/"Command" field. If your build has no
  Mosh toggle, plain SSH plus the same tmux command still recovers every drop —
  you just reconnect by hand instead of it happening for you.
EOF
else
  echo "  Bring Tailscale up first, then re-run — the connection details need its address."
fi

say "Summary"
printf '  %d ok, %d to look at, %d blocking\n\n' "$ok" "$warn" "$fail"
[ "$fail" -eq 0 ] || exit 1
