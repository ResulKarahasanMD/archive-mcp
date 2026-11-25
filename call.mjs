import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const c = new Client({ name: "cli", version: "1" });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(dirname(fileURLToPath(import.meta.url)), "index.js")], stderr: "inherit" }));
for (const [name, args] of JSON.parse(process.argv[2])) {
  const t0 = Date.now();
  const r = await c.callTool({ name, arguments: args });
  console.log(`### ${name} ${JSON.stringify(args)} (${Date.now()-t0} ms)${r.isError ? " [ERROR]" : ""}\n${r.content[0].text}\n`);
}
await c.close();
