import {
  ApplicationCommandInteractionData,
  ApplicationCommandOption,
  ApplicationCommandOptionType,
  ConnInfo,
  Interaction,
  InteractionResponseType,
  InteractionType,
  PartialApplicationCommand,
  sign,
  Snowflake,
} from "./deps.ts";

const DISCORD_BASE_URL = "https://discord.com/api/v10";

const NAME_REGEX = /^[-_\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;

interface Message {
  id?: Snowflake;
  content: string;
  embeds: never[];
  components: Component[];
  attachments: never[];
}

interface Component {
  type: number;
  custom_id?: string;
  label?: string;
  style?: number;
  emoji?: {
    id?: Snowflake;
    name?: string;
    animated?: boolean;
  };
  url?: string;
  disabled?: boolean;
  components?: Component[];
}

export type Handler = (
  request: Request,
  connInfo: ConnInfo,
  params: Record<string, string>,
) => Response | Promise<Response>;

interface Options {
  applicationId?: Snowflake;
  publicKey?: Snowflake;
  authToken?: string;
  tokenPrefix?: string;
  guildId?: Snowflake;
  endpoint?: string;
  rateLimit?: number;
  characterLimit?: number;
  serveOnly?: boolean;
}

export function router(routes: Record<string, Handler>, options: Options = {}) {
  const {
    applicationId = Deno.env.get("DISCORD_APPLICATION_ID") || "",
    publicKey = Deno.env.get("DISCORD_PUBLIC_KEY") || "",
    authToken = Deno.env.get("DISCORD_BOT_TOKEN") || "",
    tokenPrefix,
    guildId = Deno.env.get("DISCORD_GUILD_ID"),
    endpoint = "/",
    rateLimit = 1000,
    characterLimit = 2000,
    serveOnly = false,
  } = options;

  const commands = [];
  const handlers: Record<string, Handler> = {};

  for (const [route, handler] of Object.entries(routes)) {
    // Ensures the handler's name is the route.
    Object.defineProperty(handler, "name", { value: route });

    const url = new URL(route, "https://example.com");
    // Creates application command from the route.
    const command = commandFromUri(url, handler);
    if (command) {
      commands.push(command);
      // Stores the route handler as a property of this instance by command name.
      handlers[command.name] = handler;
    }
  }

  if (!serveOnly) {
    // Registers the application commands.
    const endpoint = guildId
      ? `applications/${applicationId}/guilds/${guildId}/commands`
      : `applications/${applicationId}/commands`;
    const headers = {
      "Authorization": `${(tokenPrefix || "Bot")} ${authToken}`,
      "Content-Type": "application/json",
    };

    fetch(`${DISCORD_BASE_URL}/${endpoint}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(commands),
    }).then((response) => {
      if (!response.ok) {
        console.error(`Failed to register commands: ${response.statusText}`);
      } else {
        console.log("Registered commands");
      }
    });
  }

  /**
   * Edits a response to an interaction.
   * @param token Interaction token
   * @param message The message to edit. If no ID is provided, the original response is edited.
   */
  function edit(token: string, message: Message) {
    const {
      id = "@original",
      ...data
    } = message;

    return fetch(
      `${DISCORD_BASE_URL}/webhooks/${applicationId}/${token}/messages/${id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      },
    );
  }

  return async function handleInteraction(
    request: Request,
    connInfo: ConnInfo,
  ): Promise<Response> {
    //#region Request Validation
    let status = 401;
    if (request.method !== "POST") {
      Response.json({ error: "Invalid Request" }, { status });
    }

    const { pathname } = new URL(request.url);
    if (pathname !== endpoint) {
      return Response.json({ error: "Invalid Request" }, { status });
    }

    const signature = request.headers.get("X-Signature-Ed25519")!;
    const timestamp = request.headers.get("X-Signature-Timestamp")!;
    const body = await request.text();

    const valid = sign.detached.verify(
      new TextEncoder().encode(timestamp + body),
      hexToUint8Array(signature),
      hexToUint8Array(publicKey),
    );

    if (!valid) {
      return Response.json({ error: "Invalid Request" }, { status });
    }
    //#endregion Request Validation

    status = 200;

    const interaction: Interaction = JSON.parse(body!);
    const {
      // id,
      type,
      data,
      // guild_id,
      // channel_id,
      member,
      // user,
      token,
      // version,
      // message,
      // locale,
      // guild_locale,
    } = interaction;

    // Discord performs Ping interactions to test our application.
    if (type === InteractionType.PING) {
      return Response.json({
        type: InteractionResponseType.PONG,
      });
    }

    if (type === InteractionType.APPLICATION_COMMAND) {
      const {
        name,
        options = [],
      } = data as ApplicationCommandInteractionData;

      const message: Message = {
        content: "",
        embeds: [],
        components: [],
        attachments: [],
      };

      // @ts-ignore Instance has this property by command's name.
      const handler = handlers[name];
      const route = handler.name; // User-defined route, i.e. `/hello/:name?age=`

      const params: Record<string, string> = {};
      const url = new URL(route, request.url);
      const searchParams = url.searchParams;

      let optionCount = options.length;

      /** Starts with optional options first, since we can check against `searchParams`. */
      while (optionCount--) {
        // @ts-ignore We know `option` has `value`
        const { name, value } = options[optionCount];
        /** Overrides the searchParam value with provided option value. */
        if (searchParams.has(name)) {
          searchParams.set(name, value);
          /** Removes this option from provided option list. */
          options!.splice(optionCount, 1);
        }
      }

      /** At this point, `options` contains only required params. */
      // @ts-ignore We know `option` has `value`
      options!.forEach(({ name, value }) => {
        params[name] = value; /** Collects here to pass to handler. */
        url.pathname = url.pathname.replace(`:${name}`, value);
      });

      // Sends initial response to Discord.
      // It will be updated from the body stream.
      message.content = "\r";

      const abortController = new AbortController();

      const newRequest = new Request(url.href, {
        headers: {
          "Authorization": "Basic " + btoa(`${member.user.id}:`),
        },
        signal: abortController.signal,
      });
      const { headers, body } = await handler(newRequest, connInfo, params);

      // Displays linked resources as buttons.
      const components = headers.get("Link")?.split(",").map((linkValue) => {
        // <uri-reference>; param1=value1; param2="value2"
        const [target, ...params] = linkValue.split(";");
        const [_, uri] = target.match(/<([^>]*)>/) || [];
        const href = decodeURIComponent(uri!);
        const component: Component = {
          type: 2, // Button
          style: 1,
        };
        if (href.startsWith("/")) {
          component.custom_id = href.substring(1);
        } else {
          component.url = href;
          component.style = 5; // Link
        }

        params.forEach((param) => {
          param = param.trim();
          let [key, value = ""] = param.split("=");
          value = value.trim().replace(/^"(.*)"$/, "$1");
          if (key === "title") {
            component.label = value;
          }

          if (key === "disabled") {
            component.disabled = true;
          }
        });

        return component;
      }) || [];

      message.components.length = 0;
      if (components.length) {
        message.components.push({
          type: 1, // Action Row, required for buttons.
          components,
        });
      }

      body!
        // Accumulates all chunks and enqueue them per second to avoid
        // rate limiting from Discord.
        .pipeThrough(new RateLimitStream(rateLimit))
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(
          new TransformStream({
            async transform(chunk: string, _controller) {
              if (!chunk) return;

              chunk = message.content + chunk;
              // Wraps and trims the message to 2000 characters from the end.
              message.content = wrapText(chunk).slice(-1 * characterLimit);
              const { status, statusText } = await edit(token, message);

              if (status === 404) {
                // 404: Unknown interaction
                // This means the user has deleted the interaction.
                // Signals the handler to abort, but it's up to them to do so.
                abortController.abort(statusText);
              }
            },
          }),
        )
        .pipeThrough(new TextEncoderStream())
        // Discards
        .pipeTo(new WritableStream());

      return Response.json({
        // Type 5 responds with an ACK retaining the user's input at the top.
        type: InteractionResponseType.ACK_WITH_SOURCE,
        data: message,
      });
    }

    // We will return a bad request error as a valid Discord request
    // shouldn't reach here.
    return Response.json({ error: "bad request" }, { status: 400 });
  };
}

/**
 * Creates a partial application command from route URL.
 */
function commandFromUri(
  uri: string | URL,
  handler: Handler,
): PartialApplicationCommand | null {
  /** @TODO: Uses decorators for description and option type? */
  const { pathname, searchParams } = new URL(
    uri.toString(),
    "https://example.com",
  );
  /** @FIXME: Command name is not always the only one. */
  const [_, name, ...params] = pathname.split("/");

  if (!NAME_REGEX.test(name)) {
    console.error(`Invalid command name: ${name}`);
    return null;
  }

  // Required options must be listed before optional options.
  const options: ApplicationCommandOption[] = [];

  // Params are required options.
  params.forEach((param) => {
    const name = param.substring(1);
    options.push({
      type: ApplicationCommandOptionType.STRING,
      name,
      description: name, /** @FIXME: Actual description */
      required: true,
      choices: undefined,
      // channel_types: undefined,
      options: undefined,
      // min_value: undefined,
      // max_value: undefined,
      // autocomplete: undefined,
    });
  });

  // Search params are optional options.
  searchParams.forEach((_defaultValue, name) => {
    options.push({
      type: ApplicationCommandOptionType.STRING,
      name,
      description: name, /** @FIXME: Actual description */
      required: false,
      choices: undefined,
      // channel_types: undefined,
      options: undefined,
      // min_value: undefined,
      // max_value: undefined,
      // autocomplete: undefined,
    });
  });

  const command: PartialApplicationCommand = {
    name,
    description: handler.displayName || name,
    options,
  };

  return command;
}

/** Converts a hexadecimal string to Uint8Array. */
function hexToUint8Array(hex: string) {
  return new Uint8Array(hex.match(/.{1,2}/g)!.map((val) => parseInt(val, 16)));
}

/**
 * A TransformStream that accumulates chunks and enqueues them at a rate.
 */
class RateLimitStream extends TransformStream {
  constructor(rateLimit: number = 500) {
    let buffer = new Uint8Array(0);
    let timeout: number | null = null;

    super({
      transform(chunk, controller) {
        const newBuffer = new Uint8Array(buffer.length + chunk.length);
        newBuffer.set(buffer, 0);
        newBuffer.set(chunk, buffer.length);
        buffer = newBuffer;

        if (!timeout) {
          timeout = setTimeout(() => {
            controller.enqueue(new Uint8Array(buffer));
            buffer = new Uint8Array(0);
            timeout = null;
          }, rateLimit);
        }
      },
      flush(controller) {
        if (buffer.length > 0) {
          controller.enqueue(new Uint8Array(buffer));
          buffer = new Uint8Array(0);
        }
      },
    });
  }
}

/**
 * Wraps text containing line feed and carriage return.
 */
function wrapText(text: string) {
  let result = "";
  let currentLine = "";

  // Loop through each character in the input string
  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    // If we encounter a "\b", remove the last character from the current line
    if (char === "\b") {
      currentLine = currentLine.slice(0, -1);
    } // If we encounter a "\r\n", add the current line to the result and start a new line
    else if (char === "\r" && text[i + 1] === "\n") {
      result += currentLine + "\r\n";
      currentLine = "";
      i++; // skip over the "\n" character
    } // If we encounter a "\r", clears the current line
    else if (char === "\r") {
      currentLine = "";
    } // If we encounter a form feed "\f", clears the result
    else if (char === "\f") {
      result = "";
      currentLine = "";
    } // For any other character, add it to the current line
    else {
      currentLine += char;
    }
  }

  return result + currentLine;
}
