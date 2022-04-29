# hack-n-slash

Hack your way with any number of slash commands.

## Usage

```ts
import { Router } from "https://raw.githubusercontent.com/sntran/hack-n-slash/main/mod.ts";

new Router({
  // Regular homepage to show info about your commands.
  "/": (_req) => new Response("Hello Interactions!"),
  // Example Hello World with both required and optional options.
  "/hello/:name?age=": (req, _connInfo, params) => {
    const url = new URL(req.url);
    return new Response(`Hello ${ url.searchParams.get("age") } year-old ${ params.name }`);
  },
});
```
