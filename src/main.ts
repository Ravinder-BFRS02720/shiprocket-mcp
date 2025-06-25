(async () => {
  require("@/transports/stdio.js");
  process.env.MCP_TRANSPORT = "STDIO";
})();
