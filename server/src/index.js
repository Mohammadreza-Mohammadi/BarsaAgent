import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { assertManagersCompatible } from './protocol-contract.js';

const config = loadConfig();
const port = Number(config.server?.port || 4310);
const host = '127.0.0.1';

try {
  const managerInfo = await assertManagersCompatible(config);
  config.managerInfo = Object.fromEntries(managerInfo.map(info => [info.repoId, info]));
  createApp(config).listen(port, host, () => {
    console.log(`BarsaAgent: http://${host}:${port}`);
    for (const info of managerInfo) {
      console.log(`Manager ${info.repoId}: ${info.managerVersion || 'unknown'} · Contract v${info.contractVersion}`);
    }
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
