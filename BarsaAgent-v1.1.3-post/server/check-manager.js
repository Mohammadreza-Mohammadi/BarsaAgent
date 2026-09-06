import { loadConfig } from './src/config.js';
import { inspectManagers } from './src/protocol-contract.js';

const config = loadConfig();
const results = await inspectManagers(config);
for (const item of results) {
  if (item.ok) {
    console.log(`OK   ${item.repoId} · manager ${item.managerVersion || 'unknown'} · contract v${item.contractVersion}`);
  } else {
    console.error(`FAIL ${item.repoId}`);
    for (const error of item.errors) console.error(`     ${error}`);
  }
}
if (results.some(x => !x.ok)) process.exitCode = 1;
