#!/usr/bin/env node
import { runJarvisAgentMcp } from "../dist/src/agent-mcp-server.js";

process.on("SIGTERM", () => process.stdin.destroy());
process.on("SIGINT", () => process.stdin.destroy());
await runJarvisAgentMcp();
