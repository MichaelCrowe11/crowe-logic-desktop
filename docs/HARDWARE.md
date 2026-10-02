# Hardware in the desktop: devices as plugins, writes behind a question

Status: shipped 2026-09-13 with the Crowe Sense plugin. Companion to PLUGINS.md and
HARNESS-ARCHITECTURE.md.

## Why this exists

On 2026-08-27 Anthropic previewed the Model Hardware Standard (MHS): a driver
standard so an agent can read from and write to a physical instrument the way the
Model Context Protocol lets it call software. The public description is a driver with
`read` and `write` primitives, devices discoverable in one format, operator notes
compiled into a reference file that says what a device measures, what can be
adjusted and which safety limits are enforced, with those limits enforced at the
driver rather than in a prompt, reachable over MCP, a command line and code.

The specification itself is a gated research preview and is not public. Crowe Logic
has one real device, the Crowe Sense grow-room node, and one agent harness that
already knows how to gate a tool. So the desktop does the part that is ours to do:
it treats a device as a plugin whose reads are reads and whose writes are a question
the operator answers every time, and it leaves the wire format to the standard when
the standard opens. Nothing here claims MHS conformance. The device's own descriptor
says the same (`~/crowe-sense/contracts/device-descriptor-v0.md`).

## The shape

```
 Crowe Logic desktop                      the node (Raspberry Pi)
 ┌──────────────────────────┐             ┌─────────────────────────────┐
 │ harness.js               │  MCP stdio  │ crowe-sense/mcp_server.py   │  HTTP   ┌────────────┐
 │  tier gate  ─┐           │────────────▶│  describe_device            │────────▶│ crowe-api  │
 │  physical  ─┤ execTool   │             │  read_latest / read_history │  :8078  │  /v1/*     │
 │  approval  ─┘            │◀────────────│  list_operations            │◀────────│  queue     │
 │  journal                 │             │  request_operation          │  bearer │     ▼      │
 └──────────────────────────┘             └─────────────────────────────┘         │ watchdog   │
                                                                                   │ (owns GPIO)│
                                                                                   └────────────┘
```

Three layers, each enforcing on its own side of the wire:

1. **The node** validates arguments against hard bounds, checks its operator token
   before it reads a body, holds cooldowns, and runs a write only from the one
   process that owns the pins. It records every request and answers `unknown` when
   it cannot say what happened. None of that depends on the desktop behaving.
2. **The MCP server** is one more caller. It refuses a write on the cloud path and
   without a token, so a misconfigured desktop fails early, but it enforces nothing
   the node does not.
3. **The harness** is the person's side. A tool the manifest marks `physical` runs
   only at the Execute tier, only under the room's tier cap, and only after a
   one-shot approval bound to the exact plugin, tool and arguments. The approvals
   setting cannot switch that question off.

## What changed in the harness

`plugins.builtin.json` tool rules gained one optional flag:

```json
{ "match": "request_operation", "tier": "execute", "physical": true }
```

`pluginToolRule()` reads it. In `execTool`, after the tier check that every plugin
tool already passes, a physical tool goes through `gateAction` with
`risk: STRICT, always: true`. `always` is new: it skips the `approvals: off`
shortcut and the risk floor, so the only way past it is a yes from
`ctx.requestApproval`, and a build with no way to ask blocks. The approval hash is
`inputHash("physical:" + toolName, args)`, so a yes to a five-second identify blink
is not a yes to a thirty-second one, and never a yes to a hotspot reset.

`deliveryOf` reports a physical tool as `irreversible`: never served from the
replay cache, never retried by the loop on its own, counted as a mutation for the
verifier. The verifier itself still cannot call any MCP tool.

Rooms need nothing new. A seat's tier cap already binds at the gate, and a physical
tool needs Execute, so a read-only or edit room cannot reach one; the tests cover
that path. The headless runner (`crowe`) has no MCP client, so it has no device
tools at all, and says so.

Tests: `scripts/test-harness.js`, the four cases under "Physical writes through a
plugin".

## What the Crowe Sense plugin offers

| tool | tier | what |
|---|---|---|
| `describe_device` | readonly | the descriptor: measurements, operations, enforced limits, access paths, operator notes |
| `read_latest` | readonly | newest reading per zone and metric |
| `read_history` | readonly | one metric over a window, bucketed |
| `list_operations` | readonly | the registry, cooldowns, the last twenty requests and their outcomes |
| `request_operation` | execute, physical | one operation from the registry; today `indicator.identify` and `uplink.reset` |

Enable it in Settings. It asks for the node's URL on the LAN or tailnet, and
optionally the operator token that lives at `/etc/crowe/operator.token` on the node.
Without the token the read tools work and `request_operation` explains itself.

## What this is not

- Not a claim that the desktop or the node speaks MHS. When the specification is
  published, the binding is an adapter over the same descriptor and the same
  operations; the plan for it lives with the device contract.
- Not a general actuator surface. The registry has two entries because the v1 node
  has two things it can do. A fan or a humidifier arrives as a registry entry with
  its bound, its enforcer and its test, and this document grows by one row.
- Not a cloud write path. The relay stores and serves the descriptor and never
  carries an operation. A desktop on the cloud source can read; to act it has to
  reach the node.
