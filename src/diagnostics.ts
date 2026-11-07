import { subscribe } from "node:diagnostics_channel";

// Install once per isolate, not once per object/factory reopen. The pinned SDK's typed helper
// omits Lifecycle job/alarm events; the documented raw channel includes them.
subscribe("agents:lifecycle", (message) => {
  if (!message || typeof message !== "object") return;
  const event = message as { agent?: unknown; type?: unknown; name?: unknown; timestamp?: unknown };
  if (event.agent !== "ResearchAgent" || typeof event.type !== "string") return;
  if (!["job:backlog_warning", "job:slow_dispatch", "alarm:memory_limit_reset"].includes(event.type)) return;
  const data = {
    event: "perceptor.lifecycle.diagnostic", diagnosticCode: event.type,
    collectionId: typeof event.name === "string" ? event.name : undefined,
    timestamp: typeof event.timestamp === "number" ? event.timestamp : undefined,
  };
  if (event.type === "alarm:memory_limit_reset") console.error(data);
  else console.warn(data);
});
