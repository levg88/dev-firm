/**
 * HTTP server entry point: builds the Express app and listens on a host/port.
 *
 * @module server
 */
import http from 'node:http';

import { createApp } from './api/app';
import { Settings } from './config';
import { applyStoredSettings } from './runtime';

/** StartServerOptions interface. */
export interface StartServerOptions {
  settings?: Settings;
  host?: string;
  port?: number;
}

/** Start the HTTP server. */
export function startServer(options: StartServerOptions = {}): http.Server {
  const settings = options.settings ?? applyStoredSettings(Settings.load());
  const app = createApp(settings);
  const host = options.host || settings.host;
  const port = options.port || settings.port;
  const server = app.listen(port, host, () => {
    console.log(`Dev Firm on http://${host}:${port}`);
  });
  return server;
}

if (require.main === module) {
  startServer();
}
