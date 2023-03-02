# hack-n-slash

Hack your way with any number of slash commands for Discord.

This library provides a router that maps endpoints to slash commands. All routed
slash commands are registered with Discord automatically, unless specified not
to. The associated handler with the route is called whenever the command is
used.

## Usage

The main export has the following signature:

```ts
router(routeMap: Record<string, Handler>, options: Record<string, unknown>): Handler
```

### Options

```ts
interface Options {
  applicationId?: Snowflake; // Default to `Deno.env.get("DISCORD_APPLICATION_ID")`
  publicKey?: Snowflake; // Default to `Deno.env.get("DISCORD_PUBLIC_KEY")`
  authToken?: string; // Default to `Deno.env.get("DISCORD_BOT_TOKEN")`
  tokenPrefix?: string; // Default to "Bot".
  guildId?: Snowflake; // Default to `Deno.env.get("DISCORD_GUILD_ID")`.
  endpoint?: string; // Endpoint path for Discord to send interaction to
  rateLimit?: number; // Number of milliseconds to spread out message update.
  characterLimit?: number; // Number of characters to trim message to.
  serveOnly?: boolean; // If true, will not register commands.
}
```

### One-off Command

The route handler just needs to return a `Response` with a string body.

```ts
import { router } from "https://raw.githubusercontent.com/sntran/hack-n-slash/main/mod.ts";

Deno.serve(router({
  // Example Hello World with both required and optional options.
  "/hello/:name?age=": (req, _connInfo, params) => {
    const { searchParams } = new URL(req.url);
    return new Response(
      `Hello ${searchParams.get("age")} year-old ${params.name}`,
    );
  },
}));
```

### Long-running Task

For handler that may take time to run, the route handler can return a
[`ReadableStream`](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream)
in `Response` body. Each chunks enqueued in there will be used to update the
response to the interaction.

Some ASCII control characters can be used to cause effects other than the
addition to the text:

- `\b`: deletes the previous character.
- `\r\n`: moves cursor to a new line.
- `\f`: clears the message.
- `\r`: deletes current line.

**Note**: For each interaction, a response can only be updated within 15
minutes. After that, no further update can be made. Make sure the task run
within that timeframe.

```ts
import { router } from "https://raw.githubusercontent.com/sntran/hack-n-slash/main/mod.ts";

Deno.serve(router({
  // Example with stream response
  "/count?from=1&step=1&tick=1000": (request) => {
    const { searchParams } = new URL(request.url);
    let timerId: number | undefined;
    const encoder = new TextEncoder();

    let from = Number(searchParams.get("from"));
    const step = Number(searchParams.get("step"));
    const tick = Number(searchParams.get("tick"));

    const stream = new ReadableStream({
      start(controller) {
        timerId = setInterval(() => {
          controller.enqueue(encoder.encode(`\r${from}`);
          from += step;
        }, tick);
      },
      cancel() {
        if (typeof timerId === "number") {
          clearInterval(timerId);
        }
      },
    });

    return new Response(stream);
  },
}));
```

### Authorization

All interaction requests have `Authorization` header, which contains Basic
Authentication with Base64 encoding of the requesting user's ID. Handlers that
want to restrict usage to certain users can check this header and respond
accordingly.

Example:

```ts
import { router } from "https://raw.githubusercontent.com/sntran/hack-n-slash/main/mod.ts";

Deno.serve(router({
  // Example with stream response
  "/hello": (request) => {
    const authorization = request.headers.get("Authorization");
    const [user] = atob(authorization!.split(" ")[1]).split(":");
    if (user !== "1234567890") {
      return new Response("Unauthorized");
    }

    return new Response("Hello");
  },
}));
```

### AbortSignal

The incoming `Request` has a `.signal` property that would fire "abort" event
when the interaction is deleted from Discord. The handler is free to use it
however they want.

Example:

```ts
import { router } from "https://raw.githubusercontent.com/sntran/hack-n-slash/main/mod.ts";

Deno.serve(router({
  "/count?from=1&step=1&tick=1000": (request) => {
    const { searchParams } = new URL(request.url);
    let timerId: number | undefined;
    let from = Number(searchParams.get("from"));
    const step = Number(searchParams.get("step"));
    const tick = Number(searchParams.get("tick"));

    const body = new ReadableStream({
      start(controller) {
        // Cancels timer when interaction is deleted.
        request.signal.addEventListener("abort", () => {
          clearInterval(timerId);
          controller.close();
        });

        timerId = setInterval(() => {
          controller.enqueue(encoder.encode(`\r${from}`));
          from += step;
        }, tick);
      },
      cancel() {
        if (typeof timerId === "number") {
          clearInterval(timerId);
        }
      },
    });

    return new Response(body);
  },
}));
```
