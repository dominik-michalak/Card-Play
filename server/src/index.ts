import { createApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();

createApp().listen(config.port, () => {
  console.log(`server listening on port ${config.port}`);
});
