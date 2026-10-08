// The same, for a CommonJS TypeScript application.

import cooper = require('@joetjen/cooper');

const config: Record<string, unknown> = cooper.loadFileSync('config/app.casc');
const installed: string = cooper.version;

void [config, installed];
