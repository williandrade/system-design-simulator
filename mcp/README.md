# Local playground MCP

The MCP host starts `mcp/src/index.mjs` over stdio. Electron uses a private Unix socket to relay requests to the paired canvas. The browser uses `ws://127.0.0.1:4301/canvas`. The canvas applies one request at a time and acknowledges each mutation after it appears.

For the packaged or development Electron app, open **MCP → Configure** and register the server shown there. The packaged app uses `willis-overengineer-inator` and the **Development** window uses `willis-overengineer-inator-dev`. Keep the two registrations in the same host to control both windows. [Start Electron development](../README.md#develop-in-the-electron-window)

## Edit a canvas

1. Pair, then call `get_canvas_state` and record the canvas revision. Stop the simulation before editing.
2. Call `list_service_types` to find service IDs, aliases and ports. For example, `alb` and `nlb` both create an `elb` node and set its `lbType`. Call `can_connect` with the same arguments as `connect_nodes` to check a proposed connection between existing nodes.
3. Use `get_node_config_fields` to discover values, options and constraints. Apply a whole configuration patch in `set_node_config` with `{ "nodeId": "…", "fields": { "tasks": 3, "vCPU": "1", "memoryGB": 2 } }` for an ECS Fargate fixture. The existing `{ "nodeId": "…", "key": "requestRate", "value": 50 }` form still works for fixed-rate Users nodes.
4. Use `delete_node` to remove a node and its incident links, `delete_connection` to disconnect one traffic link, and `update_node` to rename or move a node. Existing creation tools return full results by default. Pass `responseFormat: "concise"` to `add_node`, `connect_nodes` or `add_annotation` for IDs and, in the node result, ports.
5. Use `inspect_canvas` to see potential issues before running. The `play` action can return warnings. The existing simulation rules determine whether it can start.

Use `set_canvas_region` to select a region. Read `pricing.status` and, when present, `pricing.effectiveRegion` and `pricing.source` before using a cost estimate. Use frames and visual arrows to represent geography, group membership or peering. Use `connect_nodes` for traffic that should reach the simulation.

### Apply an atomic change

Use `apply_graph` to replace a path, draw a group of related elements, or change multiple settings in one Undo step. Submit the current `expectedRevision`. Use `dryRun: true` to validate before a destructive batch, then submit the same operations without `dryRun` once ready to apply. Reread and reconcile if someone edits the canvas between preview and application.

Each operation has a `type` and `args`. Use tool names for operation types. Provide `ref` on a creation and use `$ref` in subsequent ID fields to connect new elements without another round trip. `ref` starts with a letter and may contain up to 64 letters, digits, underscores and hyphens. The batch deletes links and then nodes or frames, creates frames before their contents, applies patches, adds traffic connections and visual arrows, then edits arrows. In a creation phase, list a parent before its child. Preview IDs start with `preview:`. Read the IDs returned by the final application for later requests.

Example dry-run for a frame with one service inside it. Replace the revision with the one read from your canvas.

```json
{
  "expectedRevision": 4,
  "dryRun": true,
  "operations": [
    {
      "type": "add_frame",
      "args": { "kind": "vpc", "name": "Staging", "x": 60, "y": 60, "width": 620, "height": 440, "ref": "staging" }
    },
    {
      "type": "add_node",
      "args": { "serviceType": "natGateway", "name": "Staging NAT", "x": 110, "y": 130, "parentId": "$staging", "ref": "nat" }
    }
  ]
}
```

`import_canvas` accepts an exported simulator project object and replaces the current canvas. Read the target canvas and preview the import with `dryRun: true` before applying it.

### Limits

- The server works on the paired local canvas. To switch canvases, pair the target and read its state before editing.
- The graph limit is 100 operations per batch. Batch and import requests have a 900 KiB argument limit. The resulting graph must also fit within the normalized canvas payload limit of about 950 KiB. Edit and import summaries also have a 950 KiB limit. Split independent additive diagrams into smaller canvases when required. A replacement that needs to be atomic must fit in one batch.
- A `RESULT_UNKNOWN` means the client lost confirmation after dispatch. Reconnect and read the canvas state before deciding whether to retry.
- Tool hints describe behaviour to MCP clients. Review destructive changes with the operator using the available client workflow. If a requested step requires manual work, explain it before editing.

## Layout

```text
mcp/
├── src/
│   ├── index.mjs               # Entry point: stdio transport, relay startup, shutdown
│   ├── config.mjs              # Environment variables (operator pairing code)
│   ├── server/create-server.mjs  # MCP server: tools/list and tools/call handlers
│   ├── tools/
│   │   ├── canvas-tools.mjs    # Tool registry: description, input/output schema, summary
│   │   ├── graph-operations.mjs # Graph edit and import inputs
│   │   └── schemas.mjs         # Shared Zod primitives
│   ├── relay/
│   │   ├── canvas-relay.mjs    # WebSocket relay: pairing, session, request queue
│   │   └── protocol.mjs        # Browser wire protocol (version 1) frames and validation
│   └── shared/result.mjs       # { ok, data } / { ok, error } result envelope
├── scripts/demo/               # Deterministic SDK demo runner (run, burst, compare, prompt)
└── test/                       # node:test suites for the relay and the MCP server
```

Dependencies point inward: `server` and `relay` use `tools` and `shared`, and only `index.mjs` connects them. To add a tool, add an entry to `src/tools/canvas-tools.mjs` and implement its handler in the Angular canvas. Run the tests with `npm test --prefix mcp`.

## Start the browser playground

Use Node.js and npm. From the repository root, install the locked dependencies if needed.

```sh
npm ci --prefix frontend
npm ci --prefix backend
npm ci --prefix mcp
```

Start these processes in separate terminals. Leave port `4301` free for the MCP host.

```sh
PORT=3001 npm start --prefix backend
```

```sh
npm start --prefix frontend -- --host 127.0.0.1
```

Open [the Architect playground](http://localhost:4200/playground?mode=architect) in a test browser profile. Select **Add new canvas**, then **MCP → Pair** to open the pairing form. Keep the empty canvas visible throughout the run.

When using a client in this browser flow, register `node /absolute/path/to/mcp/src/index.mjs` under the name `willis-overengineer-inator-web`.

## Deterministic SDK demonstration

Run the following command in an interactive terminal. Paste the one-time pairing code into **Pairing code** and select **Pair**. The code goes to the local terminal directly. To collect the JSONL trace, redirect stdout and leave the terminal available for pairing.

```sh
node mcp/scripts/demo/index.mjs run .brain/evidencias/BASE-01/real-time-messaging-app.json
```

The runner creates each node, connection and annotation through separate MCP calls. It starts with **Chat Users → App Domain (DNS)**, shows 50 → 100 → 50 RPS and runs **Play**, **Pause**, **Resume** and **Stop**. The trace records request order, tool, arguments, relative time and the returned target ID. The `equivalent` record compares the MCP state with BASE-01. Use **Export** in the browser for an independent comparison of the UI export.

```sh
node mcp/scripts/demo/index.mjs compare .brain/evidencias/BASE-01/real-time-messaging-app.json /path/to/browser-export.json
```

In another empty canvas, run `node mcp/scripts/demo/index.mjs burst`. The runner submits three independent node creations and a read together. Observe the three changes in order, including the initially offscreen CDN. It then checks that invalid Play, configuration and connection requests preserve the graph. To collect visual evidence, record the browser after pairing. The action status below the toolbar stays visible with the MCP panel closed. It exposes `data-mcp-sequence`, `data-mcp-action`, `data-mcp-target` and `data-mcp-canvas` for correlating each action with the trace. If the session ends during a request, check the canvas state after reconnecting before deciding whether to send the request again.

## LLM demonstration with Claude Code

The baseline browser QA used Claude Code 2.1.331 with existing local authentication. The CLI runs in a disposable directory with the simulator tools needed for BASE-01. Prepare the empty canvas and open **MCP → Pair** before running this block from the repository root in an interactive terminal. Paste the one-time code into the masked **Pairing code** field, select **Pair**, and start recording after the field clears.

```sh
(
  simulator_workdir=$(mktemp -d) || exit 1
  operator_code=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("base64url"))')
  simulator_config=$(node -e '
    const { resolve } = require("node:path");
    process.stdout.write(JSON.stringify({ mcpServers: { simulator: {
      command: process.execPath,
      args: [resolve("mcp/src/index.mjs")],
      env: { SIMULATOR_MCP_OPERATOR_PAIRING_CODE: "${SIMULATOR_MCP_OPERATOR_PAIRING_CODE}" },
    } } }));
  ')
  simulator_tools='mcp__simulator__get_canvas_state,mcp__simulator__get_node_config_fields,mcp__simulator__add_node,mcp__simulator__connect_nodes,mcp__simulator__set_node_config,mcp__simulator__add_annotation,mcp__simulator__set_simulation'
  printf 'One-time playground pairing code: %s\n' "$operator_code" >/dev/tty
  node mcp/scripts/demo/index.mjs prompt .brain/evidencias/BASE-01/real-time-messaging-app.json |
    (
      cd "$simulator_workdir" || exit 1
      SIMULATOR_MCP_OPERATOR_PAIRING_CODE="$operator_code" claude \
        --print --verbose --output-format stream-json --no-session-persistence \
        --restricted --strict-mcp-config --mcp-config "$simulator_config" \
        --tools '' --allowedTools "$simulator_tools"
    )
)
```

The config contains an environment-variable reference. The host expands that reference for the relay, which omits the pairing tool in operator mode. For automated QA, generate the code in the launcher, pass it in the subprocess environment, and fill the browser field from the same in-memory value. Record tool calls and browser markers after pairing. Export the finished canvas from the browser and use `compare` to check it against BASE-01.

### Codex CLI compatibility

Codex CLI 0.172.0 started the relay over stdio with an ephemeral, read-only session. Its default non-interactive approval policy blocked `get_canvas_state` before dispatch with `MCP tool call requires approval, but approval policy is never`. Use the restricted Claude Code command above for the verified LLM path. The deterministic SDK runner works without an LLM host.
