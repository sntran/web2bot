import {
  serve,
  ConnInfo,
} from "https://deno.land/std@0.136.0/http/server.ts";

import { router } from "https://crux.land/router@0.0.11";

// TweetNaCl is a cryptography library that we use to verify requests
// from Discord.
import nacl from "https://cdn.skypack.dev/tweetnacl@v1.0.3?dts";

import {
  DiscordInteractions,
  Snowflake,
  PartialApplicationCommand,
  ApplicationCommand,
  ApplicationCommandOption,
  ApplicationCommandOptionType,
  Interaction,
  InteractionType,
  ApplicationCommandInteractionData,
  InteractionResponseType,
} from "https://deno.land/x/discord_slash_commands@1.0.6/src/index.ts";

const NAME_REGEX = /^[-_\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;

export type Handler = (
  request: Request,
  connInfo: ConnInfo,
  params: Record<string, string>,
) => Response | Promise<Response>;

export class Router extends DiscordInteractions {
  #commands: Record<string, Handler>;

  constructor(options: {
    applicationId?: Snowflake;
    publicKey?: Snowflake;
    authToken?: string;
    tokenPrefix?: string;
    endpoint?: string;
    guildId?: Snowflake;
  } & Record<string, Handler>) {

    const {
      applicationId = Deno.env.get("DISCORD_APPLICATION_ID") || "",
      publicKey = Deno.env.get("DISCORD_PUBLIC_KEY") || "",
      authToken = Deno.env.get("DISCORD_BOT_TOKEN") || "",
      tokenPrefix,
      endpoint = "/api/interactions",
      guildId = Deno.env.get("DISCORD_GUILD_ID"),
      ...userRoutes
    } = options;

    super({
      applicationId,
      publicKey,
      authToken,
      tokenPrefix,
    });

    const routes: Record<string, Handler>  = {
      [endpoint]: this.#handleInteraction.bind(this) as Handler,
    }

    const commands: Record<string, Handler> = {};

    for (const [route, handler] of Object.entries(userRoutes)) {
      const url = new URL(route, "https://example.com");
      // Provides a HTTP route for each commands.
      // Note: searchParams are ignored.
      routes[url.pathname] = handler;
      // Creates application command from the route.
      const command = this.registerApplicationCommand(url, guildId);

      if (command) {
        commands[command.name] = handler;
      }
    };

    // Serves HTTP endpoint for Discord to send payload to.
    serve(router(routes));

    this.#commands = commands;
  }

  async #handleInteraction(request: Request, connInfo: ConnInfo): Promise<Response> {
    const { error, status, body } = await this.#validate(request);
    if (error) {
      return new Response(JSON.stringify({
        error,
      }), {
        status,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
      });
    }

    const {
      // id,
      type = 0,
      data: {
        // id,
        name,
        options,
      } = {
        id: "",
        name: "",
        options: []
      } as ApplicationCommandInteractionData,
      // guild_id,
      // channel_id,
      // member = { user: null },
      // user,
      // token,
      // version,
      // message,
      // locale,
      // guild_locale,
     } = JSON.parse(body!) as Interaction;

    // Discord performs Ping interactions to test our application.
    if (type === InteractionType.PING) {
      return new Response(JSON.stringify({
        type: InteractionResponseType.PONG
      }), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
      });
    }

    if (type === InteractionType.APPLICATION_COMMAND) {
      const reply = {
        // Type 4 responds with the below message retaining the user's
        // input at the top.
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: "",
          embeds: [],
          components: [],
          attachments: [],
        },
      }

      const handler = this.#commands[name];
      const route = handler.name; // User-defined route, i.e. `/hello/:name?age=`

      const params: Record<string, string> = {};
      const url = new URL(route, request.url);
      const searchParams = url.searchParams;

      /** Starts with optional options first, since we can check against `searchParams`. */
      // @ts-ignore We know `option` has `value`
      options!.forEach(({ name, value }, index) => {
        /** Overrides the searchParam value with provided option value. */
        if (searchParams.has(name)) {
          searchParams.set(name, value);
          /** Removes this option from provided option list. */
          options!.splice(index, 1);
        }
      });

      /** At this point, `options` contains only required params. */
      // @ts-ignore We know `option` has `value`
      options!.forEach(({name, value}) => {
        params[name] = value; /** Collects here to pass to handler. */
        url.pathname = url.pathname.replace(`:${ name }`, value);
      });

      const response = await handler(new Request(url.href), connInfo, params);
      reply.data.content = await response.text();

      return new Response(JSON.stringify(reply), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
      });
    }

    // We will return a bad request error as a valid Discord request
    // shouldn't reach here.
    return new Response(JSON.stringify({
      error: "bad request",
    }), {
      status: 400,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  }

  /** Verify whether the request is coming from Discord. */
  async #validate(request: Request): Promise<{ error?: string; status?: number; body?: string }> {
    // validateRequest() ensures that a request is of POST method and
    // has the following headers.
    // const { error } = await validateRequest(request, {
    //   POST: {
    //     headers: ["X-Signature-Ed25519", "X-Signature-Timestamp"],
    //   },
    // });
    // if (error) {
    //   return { error: error.message, status: error.status, };
    // }

    // Verify whether the request is coming from Discord.
    // When the request's signature is not valid, we return a 401 and this is
    // important as Discord sends invalid requests to test our verification.
    const signature = request.headers.get("X-Signature-Ed25519")!;
    const timestamp = request.headers.get("X-Signature-Timestamp")!;
    const body = await request.text();

    const valid = nacl.sign.detached.verify(
      new TextEncoder().encode(timestamp + body),
      hexToUint8Array(signature),
      // @ts-ignore `publicKey` should not be private.
      hexToUint8Array(this.publicKey),
    );

    if (!valid) {
      return { error: "Invalid request", status: 401, };
    }

    return { body };
  }

  registerApplicationCommand(uri: string | URL, guildId?: Snowflake): ApplicationCommand | null {
    /** @TODO: Uses decorators for description and option type? */
    const { pathname, searchParams } = new URL(uri.toString(), "https://example.com");
    /** @FIXME: Command name is not always the only one. */
    const [_, name, ...params] = pathname.split("/");

    if (!NAME_REGEX.test(name)) {
      console.error(`Invalid command name: ${ name }`);
      return null;
    }

    // Required options must be listed before optional options.
    const options: ApplicationCommandOption[] = [];

    // Params are required options.
    params.forEach(param => {
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
      description: name, /** @FIXME: Actual description */
      options,
    }

    this.createApplicationCommand(command, guildId).then(command => {
      // Deletes application command when process exits.
      globalThis.addEventListener("unload", (_event: Event): void => {
        this.deleteApplicationCommand(command.id, guildId);
      });
    });

    return command as ApplicationCommand;
  }
}

/** Converts a hexadecimal string to Uint8Array. */
function hexToUint8Array(hex: string) {
  return new Uint8Array(hex.match(/.{1,2}/g)!.map((val) => parseInt(val, 16)));
}
