import {serve} from '@hono/node-server';
import {createApp} from './app.js';

const port = Number(process.env.CARTRIDGE_FORGE_PORT ?? 4899);
const host = process.env.CARTRIDGE_FORGE_HOST ?? '127.0.0.1';

serve(
  {
    fetch: createApp().fetch,
    hostname: host,
    port,
  },
  info => {
    console.log(`Cartridge Forge: http://${info.address}:${info.port}`);
  },
);
