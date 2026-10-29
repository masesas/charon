import axios from 'axios';
// Operator fix: some egress proxies break axios' default proxy handling
// ("Host in options.headers must match the request authority"), while
// direct/fetch requests succeed. Disable axios proxying so signal, Jupiter,
// and LLM requests go direct. Remove this line if you run behind a proxy
// that must be used for outbound HTTPS.
axios.defaults.proxy = false;

import { startCharon } from './src/app.js';

startCharon().catch((error) => {
  console.error(error);
  process.exit(1);
});
