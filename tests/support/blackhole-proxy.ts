import net from "node:net";

/** One client connection through the proxy and its upstream. */
interface Leg {
  readonly client: net.Socket;
  readonly upstream: net.Socket | undefined;
  silent: boolean;
}

/**
 * A TCP proxy that can go silent (agbossjs/agboss#789): `cut()` makes every connection open now
 * drop its bytes in both directions — no FIN, no RST, the proxy keeps both sockets open and
 * acknowledged, as a NAT or a load balancer that lost its state does. A new connection is
 * forwarded as usual, or (`swallowNew`) accepted and swallowed. `socket.destroy()` on the client
 * side is no substitute: that sends a FIN or an RST.
 */
export class BlackholeProxy {
  readonly #legs = new Set<Leg>();
  #swallowing = false;

  private constructor(
    private readonly server: net.Server,
    private readonly target: { readonly host: string; readonly port: number },
  ) {}

  /** Listens on a free port of 127.0.0.1, forwarding to `target`. */
  static async start(target: {
    readonly host: string;
    readonly port: number;
  }): Promise<BlackholeProxy> {
    const server = net.createServer();
    const proxy = new BlackholeProxy(server, target);
    server.on("connection", (client) => {
      proxy.#accept(client);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return proxy;
  }

  get port(): number {
    const address = this.server.address();
    if (address === null || typeof address === "string")
      throw new Error("the proxy is not listening");
    return address.port;
  }

  /** Every connection open now goes silent, for good. */
  cut(): void {
    for (const leg of this.#legs) leg.silent = true;
  }

  /** Connections made from now on are accepted and swallowed (`true`), or forwarded (`false`). */
  swallowNew(on: boolean): void {
    this.#swallowing = on;
  }

  /** How many connections are open (for a test that checks nothing leaked). */
  get open(): number {
    return this.#legs.size;
  }

  async close(): Promise<void> {
    for (const leg of this.#legs) {
      leg.client.destroy();
      leg.upstream?.destroy();
    }
    await new Promise<void>((resolve) =>
      this.server.close(() => {
        resolve();
      }),
    );
  }

  #accept(client: net.Socket): void {
    const upstream = this.#swallowing ? undefined : net.connect(this.target);
    const leg: Leg = { client, upstream, silent: this.#swallowing };
    this.#legs.add(leg);
    const drop = (): void => {
      this.#legs.delete(leg);
      client.destroy();
      upstream?.destroy();
    };
    client.on("data", (bytes) => {
      if (!leg.silent) upstream?.write(bytes);
    });
    upstream?.on("data", (bytes) => {
      if (!leg.silent) client.write(bytes);
    });
    // a close or an error is passed on only while the leg is alive: a silent leg ends with its own side
    client.on("close", drop);
    client.on("error", () => undefined);
    upstream?.on("close", () => {
      if (!leg.silent) drop();
    });
    upstream?.on("error", () => undefined);
  }
}
