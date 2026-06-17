(async () => {
  const transport = (process.env.MCP_TRANSPORT ?? "STDIO").toUpperCase();

  if (transport === "HTTP") {
    require("@/transports/http.js");
  } else {
    process.env.MCP_TRANSPORT = "STDIO";
    require("@/transports/stdio.js");
  }
})();
