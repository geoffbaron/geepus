const { WebSocketServer } = require('ws');
const { EventEmitter } = require('events');

class ExtensionBridge extends EventEmitter {
    constructor(port = 8082, host = '127.0.0.1') {
        super();
        this.port = port;
        this.host = host;
        this.wss = null;
        this.activeConnection = null;
        this.messageId = 1;
        this.pendingRequests = new Map();
    }

    start() {
        if (this.wss) return;
        this.wss = new WebSocketServer({ port: this.port, host: this.host });
        console.log(`[Extension Bridge] Listening on ws://${this.host}:${this.port}`);

        this.wss.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.error(`[Extension Bridge] Port ${this.port} already in use. Bridge will not start. Kill stale Geepus process and retry.`);
            } else {
                console.error(`[Extension Bridge] Server error:`, err);
            }
            this.wss = null;
        });

        this.wss.on('connection', (ws) => {
            console.log('[Extension Bridge] Chrome Extension connected.');
            this.activeConnection = ws;
            this.emit('connected');

            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.id && this.pendingRequests.has(msg.id)) {
                        const { resolve, reject } = this.pendingRequests.get(msg.id);
                        this.pendingRequests.delete(msg.id);
                        if (msg.ok) {
                            resolve(msg.output);
                        } else {
                            reject(new Error(msg.error || 'Extension action failed without error details'));
                        }
                    }
                } catch (e) {
                    console.error('[Extension Bridge] Error parsing message:', e);
                }
            });

            ws.on('close', () => {
                console.log('[Extension Bridge] Chrome Extension disconnected.');
                if (this.activeConnection === ws) {
                    this.activeConnection = null;
                }
                this.emit('disconnected');

                // Reject all pending requests
                for (const [id, { reject }] of this.pendingRequests.entries()) {
                    reject(new Error('Extension disconnected before request finished'));
                    this.pendingRequests.delete(id);
                }
            });

            ws.on('error', (err) => {
                console.error('[Extension Bridge] Connection error:', err);
            });
        });
    }

    stop() {
        if (!this.wss) return;
        this.wss.close();
        this.wss = null;
        this.activeConnection = null;
    }

    isConnected() {
        return this.activeConnection !== null;
    }

    async sendAction(action, payload = {}, timeoutMs = 15000) {
        if (!this.isConnected()) {
            throw new Error('Chrome Extension is not connected. Make sure the extension is installed and enabled.');
        }

        const id = this.messageId++;
        const message = JSON.stringify({ id, action, ...payload });

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Action ${action} timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            this.pendingRequests.set(id, {
                resolve: (val) => { clearTimeout(timeout); resolve(val); },
                reject: (err) => { clearTimeout(timeout); reject(err); }
            });

            this.activeConnection.send(message, (err) => {
                if (err) {
                    clearTimeout(timeout);
                    this.pendingRequests.delete(id);
                    reject(err);
                }
            });
        });
    }
}

// Singleton export
const bridge = new ExtensionBridge();
module.exports = { extensionBridge: bridge };
