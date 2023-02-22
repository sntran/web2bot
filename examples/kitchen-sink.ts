import { router } from "../mod.ts";

Deno.serve(router({
  // Example Hello World with both required and optional options.
  "/hello/:name?age=": (req, _connInfo, params) => {
    const url = new URL(req.url);
    return new Response(
      `Hello ${url.searchParams.get("age")} year-old ${params.name}`,
    );
  },
  "/draw/:n(\\d+)": (_req, _connInfo, params) => {
    return new Response(`You drew ${params.n} cards`);
  },
}, {
  endpoint: "/api/interactions",
}) as Deno.ServeHandler);
