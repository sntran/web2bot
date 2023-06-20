import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { router } from "../mod.ts";

serve(
  router({
    // Example Hello World with both required and optional options.
    "/hello/:name?age=": (request, _connInfo, { name }) => {
      const url = new URL(request.url);
      return new Response(
        `Hello ${url.searchParams.get("age")} year-old ${name}`,
      );
    },
    "/fetch/:url": async (_request, _connInfo, { url }) => {
      // Discord only allows attachments up to 25MB.
      const response = await fetch(url);
      // TODO: Handle errors
      const headers = new Headers(response.headers);
      if (!headers.has("Content-Disposition")) {
        headers.set("Content-Disposition", `attachment; filename="attachment"`);
      }
      return new Response(response.body, {
        headers,
      });
    },
  }, {
    endpoint: "/api/interactions",
  }),
  {
    port: 9000,
  },
);
