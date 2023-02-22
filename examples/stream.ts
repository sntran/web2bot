/**
 * Not all slash command responds immediately. They may do a long running task
 * that exceeds the 3-second limit from Discord. In this case, the handler
 * can returns a `Response` with a `ReadableStream` as its body. This stream
 * can keep enqueing text for Discord to update the orginal response message.
 *
 * The stream can enqueue newline (`\r\n`) to create a new line, or `\r` to
 * overwrite the last line.
 *
 * The example below demonstrates how to use a `ReadableStream` to fetch a
 * remote file and send the progress to Discord.
 */

import { format as formatBytes } from "https://deno.land/std@0.177.0/fmt/bytes.ts";

import { router } from "../mod.ts";

const encoder = new TextEncoder();

export const handler = router({
  // Example long running task with progress using `ReadableStream`
  "/fetch?url=": async (req, _connInfo, _params) => {
    const { searchParams } = new URL(req.url);
    const source: string | URL = searchParams.get("url") || "";

    let reply: BodyInit = "";

    try {
      const { ok, status, statusText, headers, body } = await fetch(source);

      const fileSize = Number(headers.get("Content-Length"));

      reply = new ReadableStream({
        start(controller) { // When the stream starts
          if (!ok) {
            controller.enqueue(encoder.encode(`${status} ${statusText}`));
            return;
          }

          controller.enqueue(encoder.encode(`Fetching ${source}`));

          // Hooks into the file stream and sends progress to reply stream.
          body!.pipeThrough(
            new Progress((bytes: number, done: boolean) => {
              let message = "";
              if (done) {
                message = `\r**Status**: Completed`;
              } else {
                message = `\r**Status**: ${formatBytes(bytes)}/${
                  formatBytes(fileSize)
                }`;
              }
              controller.enqueue(encoder.encode(message));
            }),
          )
            // TODO: pipe to an actual target.
            .pipeTo(new WritableStream());
        },
      });
    } catch (_) {
      reply = `Invalid URL`;
    }

    return new Response(reply);
  },
  "/count?from=1&step=1&tick=1000": (request) => {
    const { searchParams } = new URL(request.url);
    let timerId: number | undefined;
    let from = Number(searchParams.get("from"));
    const step = Number(searchParams.get("step"));
    const tick = Number(searchParams.get("tick"));

    const body = new ReadableStream({
      start(controller) {
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
}) as Deno.ServeHandler;

export class Progress extends TransformStream {
  constructor(onProgress?: (bytes: number, done: boolean) => void) {
    let completed = 0;

    super({
      transform: (
        chunk: Uint8Array,
        controller: TransformStreamDefaultController,
      ) => {
        completed += chunk.byteLength;
        onProgress?.(completed, false);
        controller.enqueue(chunk);
      },
      flush: (_controller) => {
        onProgress?.(completed, true);
      },
    });
  }
}

// Learn more at https://deno.land/manual/examples/module_metadata#concepts
if (import.meta.main) {
  Deno.serve(handler);
}
