'use strict';

import { createServer as createHttpsServer } from 'https';
import { createServer as createHttpServer } from 'http';

import { Server as SocketIOServer, Socket, Namespace, ServerOptions } from 'socket.io';
import Koa from 'koa';
import compose from 'koa-compose';

export interface Options {
  /**
   * Namespace id
   * @default null
   */
  namespace: string | null;
  /**
   * Hidden instances do not append to the koa app, but still require attachment
   * @default false
   */
  hidden: boolean;
  /**
   * Options to pass when instantiating socket.io
   * @default {}
   */
  ioOptions: Partial<ServerOptions>;
}

type EnhancedKoa<StateT = Koa.DefaultState, ContextT = Koa.DefaultContext> = Koa<StateT, ContextT> &
  Record<string, IO<StateT, ContextT> | undefined> & {
    server?: ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpServer>;
    _io?: SocketIOServer;
    io?: IO<StateT, ContextT>;
  };

type EventHandler = (...params: Array<unknown>) => Promise<unknown>;

interface EnhancedSocket extends Socket {
  /**
   * Registers the new list of listeners and middleware composition
   * @param listeners map of events and callbacks
   * @param middleware > the composed middleware
   */
  update: (listeners: Map<string, Array<EventHandler>>) => void;
}

/**
 * Main IO class that handles the socket.io connections
 * @class
 */
export class IO<StateT, ContextT> {
  // app._io reference
  _io: null;
  /**
   * List of middlewares, these are composed into an execution chain and
   * evaluated with each event
   */
  middleware: Array<compose.Middleware<ContextT>>;
  /**
   * Composed middleware stack
   */
  composed: compose.ComposedMiddleware<ContextT> | null;
  /**
   * All of the listeners currently added to the IO instance
   * event:callback
   * @type <Map>
   */
  listeners: Map<string, Array<EventHandler>>;
  /**
   * All active connections
   * id:Socket
   * @type <Map>
   */
  connections: Map<string, EnhancedSocket>;
  /**
   * Holds the socketIO connection
   * @type <Socket.IO>
   */
  socket: SocketIOServer | Namespace | null;
  opts: Options;
  adapter?: SocketIOServer['adapter'];

  /**
   * @constructs
   */
  constructor(optionsOrNamespace?: string | Options) {
    if (
      optionsOrNamespace &&
      !(
        typeof optionsOrNamespace !== 'string' ||
        (optionsOrNamespace && typeof optionsOrNamespace !== 'object')
      )
    ) {
      throw new Error('Incorrect argument passed to koaSocket constructor');
    }

    this._io = null;
    this.middleware = [];
    this.composed = null;
    this.listeners = new Map();
    this.connections = new Map();

    const options =
      typeof optionsOrNamespace === 'string'
        ? { namespace: optionsOrNamespace }
        : optionsOrNamespace;

    this.opts = Object.assign(
      {
        namespace: null,
        hidden: false,
        ioOptions: {},
      },
      options,
    );

    this.socket = null;

    this.onConnection = this.onConnection.bind(this);
    this.onDisconnect = this.onDisconnect.bind(this);
  }

  /**
   * Attach to a koa application
   * @param app the koa app to use
   * @param https whether to activate HTTPS (`true`) or not
   */
  attach(
    app: EnhancedKoa<StateT, ContextT>,
    https: boolean,
    opts: Parameters<typeof createHttpsServer>[0] = {},
  ): void {
    if (app.server && app.server.constructor.name != 'Server') {
      throw new Error("app.server already exists but it's not an http server");
    }

    if (!app.server) {
      // Create a server if it doesn't already exists
      const server = https
        ? createHttpsServer(opts, app.callback())
        : createHttpServer(app.callback());

      const listen = (...params: Parameters<typeof app.listen>): ReturnType<typeof app.listen> => {
        const boundListen = server.listen.bind(app.server);
        boundListen(params);

        return server;
      };

      // Patch `app.listen()` to call `app.server.listen()`
      app.server = server;
      app.listen = (listen as unknown) as typeof app.listen;
    }

    if (app._io) {
      // Without a namespace we’ll use the default, but .io already exists meaning
      // the default is taken already
      if (!this.opts.namespace) {
        throw new Error('Socket failed to initialise::Instance may already exist');
      }

      this.attachNamespace(app, this.opts.namespace);
      return;
    }

    if (this.opts.hidden && !this.opts.namespace) {
      throw new Error('Default namespace can not be hidden');
    }

    app._io = new SocketIOServer(app.server, this.opts.ioOptions);

    if (this.opts.namespace) {
      this.attachNamespace(app, this.opts.namespace);
      return;
    }

    // Local aliases / passthrough socket.io functionality
    this.adapter = app._io.adapter.bind(app._io);

    // Attach default namespace
    app.io = this;

    // If there is no namespace then connect using the default
    this.socket = app._io;
    this.socket.on('connection', this.onConnection);
  }

  /**
   * Attaches the namespace to the server
   * @param app the koa app to use
   * @param id namespace identifier
   */
  attachNamespace(app: EnhancedKoa<StateT, ContextT>, id: string): void {
    if (!app._io) {
      throw new Error('Namespaces can only be attached once a socketIO instance has been attached');
    }

    this.socket = app._io.of(id);
    this.socket.on('connection', this.onConnection);

    if (this.opts.hidden) {
      return;
    }

    if (app[id]) {
      throw new Error('Namespace ' + id + ' already attached to koa instance');
    }

    app[id] = this;
  }

  /**
   * Pushes a middleware on to the stack
   * @param fn the middleware function to execute
   */
  use(fn: compose.Middleware<ContextT>): ThisType<ContextT> {
    this.middleware.push(fn);
    this.composed = compose(this.middleware);

    this.updateConnections();

    return this;
  }

  /**
   * Adds a new listener to the stack
   * @param event the event id
   * @param handler the callback to execute
   * @return this
   */
  on(event: string, handler: EventHandler): ThisType<ContextT> {
    if (['connect', 'connection'].includes(event)) {
      if (!this.socket) {
        throw new Error(
          'Event handlers can only be added once a socketIO instance has been attached',
        );
      }

      this.socket.on(event, handler);
      return this;
    }

    const listeners = this.listeners.get(event);

    // If this is a new event then just set it
    if (!listeners) {
      this.listeners.set(event, [handler]);
      this.updateConnections();
      return this;
    }

    listeners.push(handler);
    this.listeners.set(event, listeners);
    this.updateConnections();

    return this;
  }

  /**
   * Removes a listener from the event
   * @param event if omitted will remove all listeners
   * @param handler if omitted will remove all from the event
   */
  off(event: string, handler?: EventHandler): ThisType<ContextT> {
    if (!event) {
      this.listeners = new Map();
      this.updateConnections();
      return this;
    }

    if (!handler) {
      this.listeners.delete(event);
      this.updateConnections();
      return this;
    }

    const listeners = this.listeners.get(event);

    if (!listeners) {
      return this;
    }

    let i = listeners.length - 1;
    while (i) {
      if (listeners[i] === handler) {
        break;
      }
      i--;
    }
    listeners.splice(i, 1);

    this.updateConnections();
    return this;
  }

  /**
   * Broadcasts an event to all connections
   * @param event
   * @param data
   */
  broadcast<Data>(event: string, data: Data): void {
    this.connections.forEach((socket: Socket) => socket.emit(event, data));
  }

  /**
   * Perform an action on a room
   * @param room
   * @return socket
   */
  to(room: string): SocketIOServer | Namespace {
    if (!this.socket) {
      throw new Error(
        'Room actions can only be performed once a socketIO instance has been attached',
      );
    }

    return this.socket.to(room);
  }

  /**
   * Triggered for each new connection
   * Creates a new Socket instance and adds that to the stack and sets up the
   * disconnect event
   * @param sock <Socket.io Socket>
   * @private
   */
  private onConnection(sock: Socket): void {
    /**
     * Adds a specific event and callback to this socket
     * @param event
     * @param data
     */
    const _on = (event: string, handler: EventHandler) =>
      sock.on(event, (data, cb) => {
        const packet = {
          event: event,
          data: data,
          socket: sock,
          acknowledge: cb,
        };

        if (!this.composed) {
          handler(packet, data);
          return;
        }

        this.composed((packet as unknown) as ContextT, () => handler(packet, data));
      });

    const enhancedSocket = sock as EnhancedSocket;

    enhancedSocket.update = (listeners: Map<string, Array<EventHandler>>) => {
      sock.removeAllListeners();

      listeners.forEach((handlers, event) => {
        if (event === 'connection') {
          return;
        }

        handlers.forEach((handler) => _on(event, handler));
      });
    };

    // Append listeners and composed middleware function
    enhancedSocket.update(this.listeners);

    this.connections.set(sock.id, enhancedSocket);
    sock.on('disconnect', () => this.onDisconnect(sock));

    // Trigger the connection event if attached to the socket listener map
    const handlers = this.listeners.get('connection');
    if (handlers) {
      handlers.forEach((handler) =>
        handler(
          {
            event: 'connection',
            data: sock,
            socket: sock,
          },
          sock.id,
        ),
      );
    }
  }

  /**
   * Fired when the socket disconnects, simply reflects stack in the connections
   * stack
   * @param sock
   * @private
   */
  private onDisconnect(sock: Socket): void {
    this.connections.delete(sock.id);
  }

  /**
   * Updates all existing connections with current listeners and middleware
   * @private
   */
  private updateConnections(): void {
    this.connections.forEach((connection) => connection.update(this.listeners));
  }
}
