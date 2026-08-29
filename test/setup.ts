import { mkdirSync } from 'node:fs';
import path from 'node:path';

const workerId = process.env.VITEST_WORKER_ID ?? String(process.pid);
const workerElephaHome = path.join(process.cwd(), '.test-scratch', `elepha-home-${workerId}`);

mkdirSync(workerElephaHome, { recursive: true });
process.env.ELEPHA_HOME = workerElephaHome;
