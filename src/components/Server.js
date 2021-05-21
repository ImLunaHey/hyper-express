const uWebSockets = require('uWebSockets.js');
const operators = require('../shared/operators.js');
const Request = require('./http/Request.js');
const Response = require('./http/Response.js');
const WebsocketRoute = require('./ws/WebsocketRoute.js');

class Server {
    #uws_instance = null;
    #listen_socket = null;
    #session_engine = null;
    #middlewares = [];
    #handlers = {
        on_not_found: null,
        on_error: (req, res, error) => {
            res.status(500).send('HyperExpress: Uncaught Exception Occured');
            throw new Error(error);
        },
    };

    constructor(options = {}) {
        // Only accept object as a parameter type for options
        if (typeof options !== 'object')
            throw new Error(
                'HyperExpress: HyperExpress.Server constructor only accepts an object type for the options parameter.'
            );

        // Create underlying uWebsockets App or SSLApp to power HyperExpress
        const { cert_file_name, key_file_name, passphrase } = options;
        if (cert_file_name && key_file_name && passphrase) {
            this.#uws_instance = uWebSockets.SSLApp(options);
        } else {
            this.#uws_instance = uWebSockets.App(options);
        }
    }

    /**
     * This method is used to intiate the HyperExpress server
     *
     * @param {Number} port
     * @param {String} host
     * @returns {Promise} Promise
     */
    listen(port, host = '0.0.0.0') {
        let reference = this;
        return new Promise((resolve, reject) =>
            reference.#uws_instance.listen(host, port, (listen_socket) => {
                if (listen_socket) {
                    reference.#listen_socket = listen_socket;
                    resolve(listen_socket);
                } else {
                    reject('NO_SOCKET');
                }
            })
        );
    }

    /**
     * Closes/Halts current HyperExpress Server instance based on provided listen_socket
     *
     * @param {socket} listen_socket
     * @returns {Boolean} true || false
     */
    close(listen_socket) {
        let socket = listen_socket || this.#listen_socket;
        if (socket == null) return false;

        uWebSockets.us_listen_socket_close(socket);
        this.#listen_socket = null;
        return true;
    }

    /**
     * Sets a global error handler which will catch most uncaught errors
     * across all routes created on this server instance.
     *
     * @param {Function} handler
     */
    set_error_handler(handler) {
        if (typeof handler !== 'function')
            throw new Error('HyperExpress: handler must be a function');
        this.#handlers.on_error = handler;
    }

    /**
     * Sets a global not found handler which will handle
     * all incoming requests that are not handled by any existing routes.
     * Note! You must call this method last as it is a catchall route.
     *
     * @param {Function} handler
     */
    set_not_found_handler(handler) {
        if (typeof handler !== 'function')
            throw new Error('HyperExpress: handler must be a function');

        // Store not_found handler and bind it as a catchall route
        let should_bind = this.#handlers.on_not_found === null;
        this.#handlers.on_not_found = handler;
        if (should_bind)
            this.any('/*', (request, response) =>
                this.#handlers.on_not_found(request, response)
            );
    }

    /**
     * Binds a session engine which enables request.session for all requests.
     *
     * @param {SessionEngine} session_engine
     */
    set_session_engine(session_engine) {
        if (session_engine?.constructor?.name !== 'SessionEngine')
            throw new Error(
                'HyperExpress: session_engine must be a SessionEngine instance'
            );
        this.#session_engine = session_engine;
    }

    /**
     * Adds a global middleware for all incoming requests.
     *
     * @param {Function} handler (request, response, next) => {}
     */
    use(handler) {
        if (typeof handler !== 'function')
            throw new Error('HyperExpress: handler must be a function');
        this.#middlewares.push(handler);
    }

    /**
     * INTERNAL METHOD! This method is an internal method and should NOT be called manually.
     * This method chains a request/response through all middlewares.
     *
     * @param {Request} request - Request Object
     * @param {Response} response - Response Object
     * @param {Function} final - Callback/Chain completion handler
     */
    _chain_middlewares(request, response, final, cursor = 0) {
        let current_middleware = this.#middlewares[cursor];
        if (current_middleware)
            return current_middleware(request, response, () =>
                this._chain_middlewares(request, response, final, cursor + 1)
            );

        return final();
    }

    #routes = {
        ws: {},
        any: {},
        get: {},
        post: {},
        delete: {},
        head: {},
        options: {},
        patch: {},
        put: {},
        trace: {},
    };

    /**
     * INTERNAL METHOD! This method is an internal method and should NOT be called manually.
     * This method is used to create and bind a uWebsockets route with a middleman wrapper
     *
     * @param {String} method Supported: any, get, post, delete, head, options, patch, put, trace
     * @param {String} pattern Example: "/api/v1"
     * @param {Function} handler Example: (request, response) => {}
     */
    _create_route(method, pattern, handler) {
        // Do not allow duplicate routes for performance/stability reasons
        if (this.#routes[method]?.[pattern])
            throw new Error(
                `HyperExpress: Failed to create ${method} @ ${pattern} as duplicate routes are not allowed.`
            );

        // Pre-parse path parameters key and bind a middleman uWebsockets route for wrapping request/response objects
        let reference = this;
        let path_parameters_key = operators.parse_path_params(pattern);
        let route = this.#uws_instance[method](pattern, (response, request) =>
            reference._handle_wrapped_request(
                request,
                response,
                null,
                handler,
                path_parameters_key,
                reference
            )
        );

        return (this.#routes[method][pattern] = route);
    }

    /**
     * INTERNAL METHOD! This method is an internal method and should NOT be called manually.
     * This method is used as a middleman wrapper for request/response objects to bind HyperExpress abstractions.
     *
     * @param {Request} request
     * @param {Response} response
     * @param {UWS_SOCKET} socket
     * @param {Function} handler
     * @param {Array} path_params_key
     * @param {Server} master_context
     */
    async _handle_wrapped_request(
        request,
        response,
        socket,
        handler,
        path_params_key,
        master_context
    ) {
        // Wrap uWS.Request -> Request
        let wrapped_request = new Request(
            request,
            response,
            path_params_key,
            master_context.session_engine
        );

        // Wrap uWS.Response -> Response
        let wrapped_response = new Response(
            wrapped_request,
            response,
            socket,
            this
        );

        // Safely prefetch body if content-length is specified to prevent forbidden access errors from uWS.Request
        if (wrapped_request.headers['content-length'])
            try {
                await wrapped_request.text();
            } catch (error) {
                return master_context.error_handler(
                    wrapped_request,
                    wrapped_response,
                    error
                );
            }

        /**
         * Chain through middlewares and then call handler in
         * a promise/try...catch enclosure to catch as many errors as possible
         */
        master_context._chain_middlewares(
            wrapped_request,
            wrapped_response,
            () =>
                new Promise((resolve, reject) => {
                    try {
                        resolve(handler(wrapped_request, wrapped_response));
                    } catch (error) {
                        reject(error);
                    }
                }).catch((error) =>
                    master_context.error_handler(
                        wrapped_request,
                        wrapped_response,
                        error
                    )
                )
        );
    }

    /* Server Route Alias Methods */
    any(pattern, handler) {
        return this._create_route('any', pattern, handler);
    }

    get(pattern, handler) {
        return this._create_route('get', pattern, handler);
    }

    post(pattern, handler) {
        return this._create_route('post', pattern, handler);
    }

    delete(pattern, handler) {
        return this._create_route('del', pattern, handler);
    }

    head(pattern, handler) {
        return this._create_route('head', pattern, handler);
    }

    options(pattern, handler) {
        return this._create_route('options', pattern, handler);
    }

    patch(pattern, handler) {
        return this._create_route('patch', pattern, handler);
    }

    trace(pattern, handler) {
        return this._create_route('trace', pattern, handler);
    }

    connect(pattern, handler) {
        return this._create_route('connect', pattern, handler);
    }

    ws(pattern, options = {}) {
        // Do not allow duplicate routes for performance/stability reasons
        let method = 'ws';
        if (this.#routes[method]?.[pattern])
            throw new Error(
                `HyperExpress: Failed to create ${method} @ ${pattern} as duplicate routes are not allowed.`
            );

        if (typeof options !== 'object')
            throw new Error(
                'HyperExpress: .ws(pattern, options) -> options must be an Object'
            );

        let route = new WebsocketRoute(pattern, options, this);
        this.#routes[method][pattern] = route;
        return route;
    }

    /* Safe Server Getters */

    /**
     * Returns global error handler for current Server instance.
     *
     * @returns {Function} (request, response, error) => {}
     */
    get error_handler() {
        return this.#handlers.on_error;
    }

    /**
     * Returns session engine instance bound to current Server instance.
     *
     * @returns {SessionEngine} SessionEngine
     */
    get session_engine() {
        return this.#session_engine;
    }

    /**
     * Returns underlying uWebsockets.js Templated App instance.
     *
     * @returns {uWS} uWS (uWebsockets)
     */
    get uws_instance() {
        return this.#uws_instance;
    }

    /**
     * Returns all routes for current Server instance grouped by handled method.
     *
     * @returns {Object} Object
     */
    get routes() {
        return this.#routes;
    }
}

module.exports = Server;
